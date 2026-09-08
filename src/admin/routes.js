const express = require("express");
const { prisma } = require("../db");
const { rateLimit } = require("./rateLimit");
const auth = require("./auth");
const mailer = require("./mailer");
const jwtUtil = require("./jwt");

const router = express.Router();

const MIN_PASSWORD_LENGTH = 12;

// ── Middleware ───────────────────────────────────────────

/**
 * Verifies the access token from the Authorization header. Does NOT hit the
 * DB for the common case — the JWT itself carries the user's id/role, and
 * is trusted for its 15-minute lifetime. The one DB check (via sessionId)
 * confirms the underlying refresh session hasn't been revoked/expired since
 * the access token was minted, so a revoke (password change, admin removal)
 * still takes effect within 15 minutes rather than only at next refresh.
 */
async function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not signed in." });
  }

  let claims;
  try {
    claims = jwtUtil.verifyAccessToken(header.slice("Bearer ".length));
  } catch {
    return res.status(401).json({ error: "Not signed in." });
  }

  const session = await auth.resolveSessionById(claims.sessionId);
  if (!session) return res.status(401).json({ error: "Not signed in." });

  req.admin = session.user;
  req.sessionId = session.id;
  next();
}

/** Mints the access/refresh token pair for a freshly-authenticated user. */
async function issueTokens(userId, userAgent) {
  const { refreshToken, sessionId } = await auth.createSession(userId, userAgent);
  const user = await prisma.adminUser.findUnique({ where: { id: userId } });
  const accessToken = jwtUtil.generateAccessToken(user, sessionId);
  return { accessToken, refreshToken, expiresIn: jwtUtil.ACCESS_TOKEN_TTL_SECONDS };
}

function requireOwner(req, res, next) {
  if (req.admin.role !== "owner") {
    return res.status(403).json({ error: "Owner access required." });
  }
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

// ── Session lifecycle ────────────────────────────────────

router.post(
  "/auth/login",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "login" }),
  async (req, res) => {
    const { email, password } = req.body ?? {};

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await prisma.adminUser.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    // Same response whether the account is missing, not yet set up, revoked,
    // or the password is wrong — never confirm which emails exist.
    const invalid = () => res.status(401).json({ error: "Invalid email or password." });

    if (!user || user.status !== "active" || !user.passwordHash) return invalid();
    if (!(await auth.verifyPassword(user.passwordHash, password))) return invalid();

    const tokens = await issueTokens(user.id, req.get("user-agent"));
    await prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return res.json({ user: publicUser(user), ...tokens });
  },
);

/**
 * Exchanges a still-valid refresh token for a new access token. Called
 * automatically by the frontend on a 401, not by the user directly — see
 * king-domain-admin/src/lib/api.ts's response interceptor.
 */
router.post(
  "/auth/refresh",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 30, key: "refresh" }),
  async (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== "string" || !refreshToken) {
      return res.status(400).json({ error: "Refresh token is required." });
    }

    const session = await auth.resolveSession(refreshToken);
    if (!session) return res.status(401).json({ error: "Refresh token is invalid or expired." });

    const accessToken = jwtUtil.generateAccessToken(session.user, session.id);
    return res.json({ accessToken, expiresIn: jwtUtil.ACCESS_TOKEN_TTL_SECONDS });
  },
);

router.post("/auth/logout", async (req, res) => {
  const { refreshToken } = req.body ?? {};
  await auth.revokeSession(refreshToken);
  return res.json({ ok: true });
});

router.get("/auth/me", requireAdmin, (req, res) => {
  return res.json({ user: publicUser(req.admin) });
});

// ── Invite acceptance ────────────────────────────────────

/** Check an invite token without consuming it, so the UI can show the email. */
router.get(
  "/auth/invite",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: "invite-check" }),
  async (req, res) => {
    const record = await auth.consumeToken(req.query.token, "invite");
    if (!record) return res.status(400).json({ error: "This link is invalid or has expired." });
    return res.json({ email: record.user.email, name: record.user.name });
  },
);

router.post(
  "/auth/invite/accept",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "invite-accept" }),
  async (req, res) => {
    const { token, password, name } = req.body ?? {};

    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    const record = await auth.consumeToken(token, "invite");
    if (!record) return res.status(400).json({ error: "This link is invalid or has expired." });

    const passwordHash = await auth.hashPassword(password);

    // Mark the token used and activate the account together, so a failure
    // can't leave a consumed token with no account behind it.
    const [, user] = await prisma.$transaction([
      prisma.adminToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      prisma.adminUser.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          status: "active",
          lastLoginAt: new Date(),
          ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
        },
      }),
    ]);

    const tokens = await issueTokens(user.id, req.get("user-agent"));
    return res.json({ user: publicUser(user), ...tokens });
  },
);

// ── Password reset ───────────────────────────────────────

router.post(
  "/auth/forgot-password",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, key: "forgot-password" }),
  async (req, res) => {
    const { email } = req.body ?? {};

    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    const result = await auth.createPasswordReset(email);

    if (result) {
      const base = process.env.ADMIN_APP_URL || "http://localhost:5180";
      await mailer.sendPasswordReset({
        to: result.user.email,
        resetUrl: `${base}/reset-password?token=${result.token}`,
      });
    }

    // Identical response whether or not an account exists — otherwise this
    // endpoint becomes a way to enumerate valid admin emails.
    return res.json({
      ok: true,
      message: "If that account exists, a reset link has been sent.",
    });
  },
);

/** Check a reset token without consuming it, so the UI can show the email. */
router.get(
  "/auth/reset-password",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: "reset-check" }),
  async (req, res) => {
    const record = await auth.consumeToken(req.query.token, "password_reset");
    if (!record) return res.status(400).json({ error: "This link is invalid or has expired." });
    return res.json({ email: record.user.email });
  },
);

router.post(
  "/auth/reset-password",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "reset-confirm" }),
  async (req, res) => {
    const { token, password } = req.body ?? {};

    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    const record = await auth.consumeToken(token, "password_reset");
    if (!record) return res.status(400).json({ error: "This link is invalid or has expired." });

    const passwordHash = await auth.hashPassword(password);

    await prisma.$transaction([
      prisma.adminToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.adminUser.update({ where: { id: record.userId }, data: { passwordHash } }),
    ]);

    // A reset implies the old password may have been compromised — end
    // every session rather than just this device's.
    await auth.revokeAllSessions(record.userId);

    return res.json({ ok: true });
  },
);

// ── Change password (signed in) ──────────────────────────

router.post("/auth/change-password", requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};

  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return res.status(400).json({ error: "Current and new password are required." });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res
      .status(400)
      .json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const user = await prisma.adminUser.findUnique({ where: { id: req.admin.id } });
  if (!user?.passwordHash || !(await auth.verifyPassword(user.passwordHash, currentPassword))) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const passwordHash = await auth.hashPassword(newPassword);
  await prisma.adminUser.update({ where: { id: user.id }, data: { passwordHash } });

  // Keep the session that just made this request; end any others.
  await auth.revokeAllSessions(user.id, req.sessionId);

  return res.json({ ok: true });
});

// ── Admin management (owner only) ────────────────────────

router.get("/admins", requireAdmin, requireOwner, async (req, res) => {
  const users = await prisma.adminUser.findMany({ orderBy: { createdAt: "asc" } });
  return res.json({ admins: users.map(publicUser) });
});

router.post("/admins/invite", requireAdmin, requireOwner, async (req, res) => {
  const { email, name, role } = req.body ?? {};

  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (role !== undefined && !["owner", "admin"].includes(role)) {
    return res.status(400).json({ error: "Unknown role." });
  }

  const { user, token } = await auth.createInvite({
    email,
    name: typeof name === "string" ? name.trim() || null : null,
    role: role ?? "admin",
  });

  const base = process.env.ADMIN_APP_URL || "http://localhost:5180";
  const inviteUrl = `${base}/accept-invite?token=${token}`;

  const mailResult = await mailer.sendInvite({
    to: user.email,
    inviteUrl,
    expiresInHours: auth.INVITE_TTL_HOURS,
  });

  return res.status(201).json({
    admin: publicUser(user),
    // Still returned even when emailed — useful for copy/paste while the
    // shared testing domain can't deliver to arbitrary addresses.
    inviteUrl,
    expiresInHours: auth.INVITE_TTL_HOURS,
    emailed: mailResult.sent,
  });
});

router.post("/admins/:id/revoke", requireAdmin, requireOwner, async (req, res) => {
  const { id } = req.params;

  if (id === req.admin.id) {
    return res.status(400).json({ error: "You cannot revoke your own access." });
  }

  const user = await prisma.adminUser.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: "Admin not found." });

  await prisma.$transaction([
    prisma.adminUser.update({ where: { id }, data: { status: "revoked" } }),
    // Kill live sessions immediately rather than waiting for expiry.
    prisma.adminSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.adminToken.updateMany({
      where: { userId: id, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);

  return res.json({ ok: true });
});

module.exports = { router, requireAdmin };
