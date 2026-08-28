const crypto = require("node:crypto");
const argon2 = require("argon2");
const { prisma } = require("../db");

const INVITE_TTL_HOURS = 72;
const RESET_TTL_HOURS = 1;
const SESSION_TTL_DAYS = 7;
const SESSION_COOKIE = "kd_admin_session";

// ── Token helpers ────────────────────────────────────────

/** 32 random bytes, url-safe. Only the hash of this is ever stored. */
function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Compare two hex digests without leaking timing information.
 * Lengths are equal by construction (both sha256), but guard anyway since
 * timingSafeEqual throws on a length mismatch.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Password hashing ─────────────────────────────────────

function hashPassword(password) {
  return argon2.hash(password, { type: argon2.argon2id });
}

async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed stored hash should read as "wrong password", not a crash.
    return false;
  }
}

// ── Invites ──────────────────────────────────────────────

/**
 * Create (or re-invite) an admin and issue a single-use invite token.
 * Returns the raw token — the only time it exists in plaintext.
 */
async function createInvite({ email, name, role }) {
  const normalised = email.trim().toLowerCase();

  const user = await prisma.adminUser.upsert({
    where: { email: normalised },
    create: { email: normalised, name, role, status: "invited" },
    // Re-inviting someone revoked should let them back in; an already-active
    // admin keeps their password unless they use the link.
    update: { name, role, status: "invited" },
  });

  // Any outstanding invites for this user become unusable.
  await prisma.adminToken.updateMany({
    where: { userId: user.id, kind: "invite", usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = generateToken();
  await prisma.adminToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      kind: "invite",
      expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000),
    },
  });

  return { user, token };
}

/** Look up a valid, unused, unexpired token. Returns null otherwise. */
async function consumeToken(rawToken, kind) {
  if (typeof rawToken !== "string" || !rawToken) return null;

  const hash = hashToken(rawToken);
  const record = await prisma.adminToken.findUnique({
    where: { tokenHash: hash },
    include: { user: true },
  });

  if (!record) return null;
  if (record.kind !== kind) return null;
  if (record.usedAt) return null;
  if (record.expiresAt < new Date()) return null;
  if (record.user.status === "revoked") return null;
  if (!safeEqual(record.tokenHash, hash)) return null;

  return record;
}

// ── Password reset ───────────────────────────────────────

/**
 * Issue a single-use, 1h password reset token for an active admin.
 * Returns null for accounts that shouldn't get one (missing, invited,
 * revoked) — callers must give the same response either way, so an
 * attacker can't use this to enumerate which emails have accounts.
 */
async function createPasswordReset(email) {
  const user = await prisma.adminUser.findUnique({
    where: { email: email.trim().toLowerCase() },
  });

  if (!user || user.status !== "active") return null;

  // Outstanding reset tokens become unusable once a new one is issued.
  await prisma.adminToken.updateMany({
    where: { userId: user.id, kind: "password_reset", usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = generateToken();
  await prisma.adminToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      kind: "password_reset",
      expiresAt: new Date(Date.now() + RESET_TTL_HOURS * 3600 * 1000),
    },
  });

  return { user, token };
}

// ── Sessions ─────────────────────────────────────────────

async function createSession(userId, userAgent) {
  const token = generateToken();
  await prisma.adminSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000),
      userAgent: userAgent?.slice(0, 255),
    },
  });
  return token;
}

async function resolveSession(rawToken) {
  if (typeof rawToken !== "string" || !rawToken) return null;

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt < new Date()) return null;
  if (session.user.status !== "active") return null;

  // Fire-and-forget: last-seen is for display, not correctness.
  prisma.adminSession
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {});

  return session;
}

async function revokeSession(rawToken) {
  if (!rawToken) return;
  await prisma.adminSession
    .updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => {});
}

/**
 * Kill every active session for a user. Used on password change/reset so a
 * credential compromise (old password known, or a reset link) can't be
 * combined with a still-live session elsewhere.
 */
async function revokeAllSessions(userId, exceptSessionId) {
  await prisma.adminSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
}

// ── Cookie ───────────────────────────────────────────────

function sessionCookieOptions() {
  const crossSite = process.env.ADMIN_COOKIE_CROSS_SITE === "true";
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // The admin UI is deployed on a different origin to the API, so the
    // cookie has to survive a cross-site request.
    sameSite: crossSite ? "none" : "lax",
    maxAge: SESSION_TTL_DAYS * 86400 * 1000,
    path: "/",
  };
}

module.exports = {
  SESSION_COOKIE,
  INVITE_TTL_HOURS,
  RESET_TTL_HOURS,
  generateToken,
  hashToken,
  hashPassword,
  verifyPassword,
  createInvite,
  createPasswordReset,
  consumeToken,
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  sessionCookieOptions,
};
