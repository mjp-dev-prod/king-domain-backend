// Push notifications: device tokens and the Firebase Cloud Messaging (HTTP v1) sender.
// Design: docs/features/push-notifications.md in the mobile repo.
//
// A push is best-effort. Nothing in here throws into a request, and a failed push never undoes or blocks
// the thing it was about (the email still goes out). With no FCM_SERVICE_ACCOUNT_JSON, nothing is sent.
const { prisma: realPrisma } = require("./db");

// Same shape as contractCore.refuse, kept here so this module has no dependency on the contract code
// (contractCore pulls push in for reminders, and the two must not import each other).
const refuse = (status, code, error) => ({ ok: false, status, code, error });

const TOKEN_PATTERN = /^[A-Za-z0-9_:.\-]{20,4096}$/;
const MAX_DEVICES_PER_PERSON = 10;
const STALE_DAYS = 60;
const CHANNEL_ID = "kd_updates";
const MAX_TRIES = 3; // one try and two retries
const SEND_TIMEOUT_MS = 10_000;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

const last8 = (token) => String(token).slice(-8);
const log = (text) => console.log(`[push] ${text}`);

// ── Device tokens ────────────────────────────────────────

/** Stores (or refreshes) a phone's token for a person. A token seen on another account moves to this one. */
async function registerToken({ userId, token }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return refuse(400, "invalid", "That is not a device token.");
  await prisma.deviceToken.upsert({
    where: { token },
    create: { userId, token },
    update: { userId, lastSeenAt: new Date() },
  });
  // A person with many phones (or many reinstalls) keeps only the freshest few.
  const mine = await prisma.deviceToken.findMany({ where: { userId }, orderBy: { lastSeenAt: "desc" }, select: { id: true } });
  if (mine.length > MAX_DEVICES_PER_PERSON) {
    await prisma.deviceToken.deleteMany({ where: { id: { in: mine.slice(MAX_DEVICES_PER_PERSON).map((t) => t.id) } } });
  }
  return { ok: true };
}

/** Removes this person's own token (logout). Another person's token with the same value is never touched. */
async function unregisterToken({ userId, token }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  if (typeof token === "string" && token) await prisma.deviceToken.deleteMany({ where: { userId, token } });
  return { ok: true };
}

/** Tokens nobody has refreshed in `days` belong to phones that are gone. */
async function pruneStaleTokens({ days = STALE_DAYS } = {}, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const { count } = await prisma.deviceToken.deleteMany({ where: { lastSeenAt: { lt: new Date(Date.now() - days * 86_400_000) } } });
  return { removed: count };
}

// ── The sender ───────────────────────────────────────────

/**
 * What FCM's answer means for the token (firebase.google.com/docs/cloud-messaging/error-codes):
 * dead = remove it; auth = refresh the access token and repeat once; retry = throttled or down; failed = give up.
 */
function classify(status, body) {
  const error = body?.error;
  const code = error?.details?.find((d) => d.errorCode)?.errorCode;
  const message = error?.message ?? "";
  if (status === 404 && (code === "UNREGISTERED" || error?.status === "NOT_FOUND")) return "dead";
  if (status === 400 && /not a valid FCM registration token/i.test(message)) return "dead";
  if (status === 401) return "auth";
  if ([429, 500, 503, 504].includes(status)) return "retry";
  return "failed";
}

function messageBody(token, { title, body, data = {} }) {
  return {
    message: {
      token,
      notification: { title, body },
      // FCM requires every data value to be a string.
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: "HIGH", notification: { channel_id: CHANNEL_ID } },
    },
  };
}

/**
 * A sender bound to one Firebase project. `getAccessToken({ force })` returns an OAuth token for the
 * service account (Google's library in production, a stub in tests); `sleep` is replaceable so tests
 * don't wait.
 */
function createPush({ prisma = realPrisma, projectId, getAccessToken, fcmBase = process.env.FCM_BASE_URL || "https://fcm.googleapis.com", sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function sendToToken(token, message) {
    let tries = 0;
    let refreshed = false;
    let force = false;
    let lastError = "no attempt made";
    while (tries < MAX_TRIES) {
      tries++;
      let res;
      try {
        const accessToken = await getAccessToken({ force });
        res = await fetch(`${fcmBase}/v1/projects/${projectId}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(messageBody(token, message)),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err.message;
        if (tries < MAX_TRIES) await sleep(500 * tries);
        continue;
      }
      force = false;
      if (res.ok) return { outcome: "sent" };
      const body = await res.json().catch(() => null);
      const kind = classify(res.status, body);
      lastError = `${res.status} ${body?.error?.status ?? ""} ${body?.error?.message ?? ""}`.trim();
      if (kind === "dead") return { outcome: "dead", detail: lastError };
      if (kind === "auth" && !refreshed) {
        refreshed = true;
        force = true;
        tries--; // the refresh is not one of the retries
        continue;
      }
      if (kind === "retry" && tries < MAX_TRIES) {
        const wait = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 500 * tries);
        continue;
      }
      return { outcome: "failed", detail: lastError };
    }
    return { outcome: "failed", detail: lastError };
  }

  /** Sends to every phone of one person. Never throws; says what happened. */
  async function notifyUser(userId, message) {
    const result = { sent: 0, removed: 0, failed: 0 };
    try {
      const tokens = (await prisma.deviceToken.findMany({ where: { userId }, select: { token: true } })).map((t) => t.token);
      const notes = [];
      for (const token of tokens) {
        const r = await sendToToken(token, message);
        notes.push(`${last8(token)}:${r.outcome}${r.detail ? `(${r.detail})` : ""}`);
        if (r.outcome === "sent") result.sent++;
        else if (r.outcome === "dead") {
          await prisma.deviceToken.deleteMany({ where: { token } });
          result.removed++;
        } else result.failed++;
      }
      if (tokens.length) log(`user=${userId} type=${message.data?.type ?? "-"} devices=${tokens.length} sent=${result.sent} removed=${result.removed} failed=${result.failed} [${notes.join(", ")}]`);
    } catch (err) {
      result.failed++;
      log(`user=${userId} could not send: ${err.message}`);
    }
    return result;
  }

  return { notifyUser, sendToToken };
}

// ── The real sender, built from the environment ──────────

function readServiceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
    if (!json.project_id || !json.client_email || !json.private_key) throw new Error("missing project_id, client_email or private_key");
    return json;
  } catch (err) {
    log(`FCM_SERVICE_ACCOUNT_JSON is set but unusable (${err.message}); push is OFF`);
    return null;
  }
}

const configured = () => readServiceAccount() !== null;

let cached = { raw: null, sender: null };
function defaultSender() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON ?? "";
  if (cached.raw === raw && cached.sender) return cached.sender;
  const account = readServiceAccount();
  if (!account) return null;
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({ credentials: account, scopes: [FCM_SCOPE] });
  const sender = createPush({
    projectId: account.project_id,
    getAccessToken: async ({ force } = {}) => {
      const client = await auth.getClient();
      if (force) client.credentials = {}; // drop the cached token so the next call asks Google again
      const { token } = await client.getAccessToken();
      return token;
    },
  });
  cached = { raw, sender };
  return sender;
}

/** Sends one push to one person through the configured Firebase project. A no-op when none is configured. */
async function notifyUser(userId, message) {
  const sender = defaultSender();
  if (!sender) return { sent: 0, removed: 0, failed: 0, skipped: "not_configured" };
  return sender.notifyUser(userId, message);
}

module.exports = { registerToken, unregisterToken, pruneStaleTokens, createPush, classify, configured, notifyUser, STALE_DAYS, MAX_DEVICES_PER_PERSON };
