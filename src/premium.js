// Premium, through Google Play Billing (PRD §4.10; D38, D39). Two features to start: reopening a job past the soft cap
// (clients) and asking a question before applying (talents). Rules that do not bend: premium never buys a better place than
// another person, and a job payment is never a Play purchase (those are services by people and stay with Paystack).
//
// How a purchase becomes a use: the phone buys a one-time product from Google Play, then sends the purchase token here. We ask
// Google whether that token is a real, paid, unused purchase (Google Play Developer API, purchases.products.get), record it as
// one Entitlement, and consume it with Google so the product can be bought again. The phone completes the purchase only after
// we say yes, so a failed check never takes money for nothing. An Entitlement is then used once.
//
// Settings: PLAY_PACKAGE_NAME, PLAY_SERVICE_ACCOUNT_JSON (a Google service account allowed to read purchases),
// PLAY_PRODUCT_REOPEN, PLAY_PRODUCT_QUESTION (the product ids made in the Play Console, where the prices are set).
// PREMIUM_ENFORCED=true makes the two features cost an entitlement; unset, they are free (staging, tests, before launch).
const crypto = require("node:crypto");
const { prisma: realPrisma } = require("./db");

const FEATURES = {
  reopen_job: { env: "PLAY_PRODUCT_REOPEN", label: "Reopen a paused job" },
  pre_apply_question: { env: "PLAY_PRODUCT_QUESTION", label: "Ask a question before applying" },
};

const fail = (status, code, error) => ({ ok: false, status, code, error });

const enforced = () => process.env.PREMIUM_ENFORCED === "true";
const productFor = (feature) => process.env[FEATURES[feature].env] || null;
const featureOf = (productId) => Object.keys(FEATURES).find((f) => productFor(f) === productId) ?? null;

function serviceAccount() {
  const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

/** Whether we can check a purchase with Google at all. */
const billingConfigured = () => Boolean(process.env.PLAY_PACKAGE_NAME && serviceAccount() && productFor("reopen_job") && productFor("pre_apply_question"));

const apiBase = () => process.env.PLAY_API_BASE || "https://androidpublisher.googleapis.com";
const tokenUrl = () => process.env.PLAY_TOKEN_URL || "https://oauth2.googleapis.com/token";

let cached = null;
const b64url = (b) => Buffer.from(b).toString("base64url");

/** An OAuth access token for the service account (a signed JWT exchanged at Google), kept until shortly before it expires. */
async function accessToken(fetchImpl = fetch) {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: tokenUrl(), iat: now, exp: now + 3600 };
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(input), crypto.createPrivateKey(sa.private_key));
  const res = await fetchImpl(tokenUrl(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64url(sig)}` }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google refused the service account (${res.status}).`);
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

const resetTokenCache = () => {
  cached = null;
};

async function play(path, { method = "GET", fetchImpl = fetch } = {}) {
  const token = await accessToken(fetchImpl);
  const res = await fetchImpl(`${apiBase()}/androidpublisher/v3/applications/${encodeURIComponent(process.env.PLAY_PACKAGE_NAME)}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (res.status === 204 || (res.ok && method === "POST")) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body?.error?.message || `Google Play answered ${res.status}.`);
    e.httpStatus = res.status;
    throw e;
  }
  return body;
}

/** What the phone needs to show the buttons: whether premium is on, what each costs is read from the store itself. */
async function status(userId, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const rows = await prisma.entitlement.groupBy({ by: ["feature"], where: { userId, status: "granted" }, _count: { _all: true } });
  const credits = Object.fromEntries(Object.keys(FEATURES).map((f) => [f, rows.find((r) => r.feature === f)?._count._all ?? 0]));
  return {
    enforced: enforced(),
    billingConfigured: billingConfigured(),
    features: Object.entries(FEATURES).map(([feature, def]) => ({ feature, label: def.label, productId: productFor(feature), credits: credits[feature] })),
    rule: "Premium never buys a better place than anyone else. Nobody on King Domain will ever ask you for money to get or do a job. Premium is optional and is only bought inside the app through Google Play.",
  };
}

/**
 * The phone sends the token of a purchase it made. Verified with Google, recorded once, consumed. Sending the same token
 * again is safe and changes nothing; one person's token can't be spent by another.
 */
async function verifyAndGrant({ userId, productId, purchaseToken }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (typeof purchaseToken !== "string" || purchaseToken.length < 10 || purchaseToken.length > 2000) return fail(400, "invalid", "That purchase can't be read.");
  const feature = featureOf(productId);
  if (!feature) return fail(400, "unknown_product", "That isn't something King Domain sells.");
  if (!billingConfigured()) return fail(503, "billing_unavailable", "Buying isn't available right now. Nothing was charged to you for this. Try again later.");

  const existing = await prisma.entitlement.findUnique({ where: { purchaseToken } });
  if (existing) {
    if (existing.userId !== userId) return fail(409, "token_used", "That purchase was already used by another account.");
    return { ok: true, entitlement: existing, already: true };
  }
  let purchase;
  try {
    purchase = await play(`/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`, { fetchImpl });
  } catch (err) {
    console.error(`premium: Google could not check the purchase user=${userId} product=${productId}: ${err.message}`);
    return fail(err.httpStatus === 404 || err.httpStatus === 400 ? 404 : 502, "not_found", err.httpStatus === 404 || err.httpStatus === 400 ? "Google Play doesn't know that purchase." : "Couldn't check the purchase with Google Play. Try again in a moment; you won't be charged twice.");
  }
  // 0 purchased, 1 cancelled, 2 pending (paying with cash at a shop, say): only a paid purchase counts.
  if (purchase.purchaseState !== 0) return fail(409, "not_paid", purchase.purchaseState === 2 ? "That purchase is still pending. It counts once Google Play confirms the payment." : "That purchase was cancelled.");
  // The phone tags a purchase with the account that made it, so a token can't be moved to another account.
  if (purchase.obfuscatedExternalAccountId && purchase.obfuscatedExternalAccountId !== userId) return fail(409, "token_used", "That purchase belongs to another account.");

  let entitlement;
  try {
    entitlement = await prisma.entitlement.create({ data: { userId, feature, productId, purchaseToken, orderId: purchase.orderId ?? null } });
  } catch (err) {
    if (err.code === "P2002") return verifyAndGrant({ userId, productId, purchaseToken }, deps);
    throw err;
  }
  console.log(`premium: granted entitlement=${entitlement.id} user=${userId} feature=${feature} order=${entitlement.orderId} readBack.status=${(await prisma.entitlement.findUnique({ where: { id: entitlement.id } })).status}`);
  if (purchase.consumptionState !== 1) {
    // Consuming also acknowledges it, and lets the product be bought again. If this fails the grant stands and the phone retries.
    await play(`/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`, { method: "POST", fetchImpl }).catch((err) => console.error(`premium: could not consume ${entitlement.id}: ${err.message}`));
  }
  return { ok: true, entitlement };
}

/**
 * Spends one entitlement on a use. When premium is not enforced the use is free. When it is, the person needs a granted
 * entitlement for the feature; the reply carries the product id so the app can offer the purchase.
 */
async function use({ userId, feature, usedOn }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  if (!enforced()) return { ok: true, free: true };
  for (let i = 0; i < 3; i++) {
    const next = await prisma.entitlement.findFirst({ where: { userId, feature, status: "granted" }, orderBy: { createdAt: "asc" } });
    if (!next) break;
    const claimed = await prisma.entitlement.updateMany({ where: { id: next.id, status: "granted" }, data: { status: "used", usedOn: usedOn ?? null, usedAt: new Date() } });
    if (claimed.count === 1) {
      console.log(`premium: used entitlement=${next.id} user=${userId} feature=${feature} on=${usedOn}`);
      return { ok: true, entitlement: next };
    }
  }
  return { ...fail(402, "premium_required", `${FEATURES[feature].label} is a premium feature.`), productId: productFor(feature), feature };
}

module.exports = { FEATURES, enforced, billingConfigured, productFor, featureOf, status, verifyAndGrant, use, resetTokenCache };
