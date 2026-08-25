const express = require("express");
const { prisma } = require("../db");
const { rateLimit } = require("./rateLimit");
const auth = require("./auth");

const router = express.Router();

const MIN_PASSWORD_LENGTH = 12;

// ── Middleware ───────────────────────────────────────────

async function requireAdmin(req, res, next) {
  const session = await auth.resolveSession(req.cookies?.[auth.SESSION_COOKIE]);
  if (!session) return res.status(401).json({ error: "Not signed in." });
  req.admin = session.user;
  req.sessionId = session.id;
  next();
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

    const token = await auth.createSession(user.id, req.get("user-agent"));
    await prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.cookie(auth.SESSION_COOKIE, token, auth.sessionCookieOptions());
    return res.json({ user: publicUser(user) });
  },
);

router.post("/auth/logout", async (req, res) => {
  await auth.revokeSession(req.cookies?.[auth.SESSION_COOKIE]);
  res.clearCookie(auth.SESSION_COOKIE, { ...auth.sessionCookieOptions(), maxAge: undefined });
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

    const sessionToken = await auth.createSession(user.id, req.get("user-agent"));
    res.cookie(auth.SESSION_COOKIE, sessionToken, auth.sessionCookieOptions());
    return res.json({ user: publicUser(user) });
  },
);

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

  const base = process.env.ADMIN_APP_URL || "http://localhost:5174";
  return res.status(201).json({
    admin: publicUser(user),
    // Delivered manually for now — no email provider wired up yet.
    inviteUrl: `${base}/accept-invite?token=${token}`,
    expiresInHours: auth.INVITE_TTL_HOURS,
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
