// Password hashing + refresh-session helpers for talent/client users —
// same pattern as src/admin/auth.js, minus the invite/password-reset flow
// (admin accounts are invite-only; User accounts self-serve signup, so
// none of that applies here).
const crypto = require("node:crypto");
const argon2 = require("argon2");
const { prisma } = require("../db");

const SESSION_TTL_DAYS = 7;

/** 32 random bytes, url-safe. Only the hash of this is ever stored. */
function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
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

// ── Refresh sessions ─────────────────────────────────────

async function createSession(userId, userAgent) {
  const token = generateToken();
  const session = await prisma.userSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000),
      userAgent: userAgent?.slice(0, 255),
    },
  });
  return { refreshToken: token, sessionId: session.id };
}

/** Look up a live refresh token. Returns the session + user, or null. */
async function resolveSession(rawToken) {
  if (typeof rawToken !== "string" || !rawToken) return null;

  const session = await prisma.userSession.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt < new Date()) return null;

  // Fire-and-forget: last-seen is for display, not correctness.
  prisma.userSession
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {});

  return session;
}

/**
 * Look up a refresh session by its id (the access token's `sessionId`
 * claim) rather than the raw token — used by requireUser, which only ever
 * sees the access token, never the refresh token itself.
 */
async function resolveSessionById(sessionId) {
  if (!sessionId) return null;

  const session = await prisma.userSession.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt < new Date()) return null;

  return session;
}

async function revokeSession(rawToken) {
  if (!rawToken) return;
  await prisma.userSession
    .updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => {});
}

module.exports = {
  SESSION_TTL_DAYS,
  generateToken,
  hashToken,
  hashPassword,
  verifyPassword,
  createSession,
  resolveSession,
  resolveSessionById,
  revokeSession,
};
