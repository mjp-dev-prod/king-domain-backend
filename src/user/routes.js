const express = require("express");
const { prisma } = require("../db");
const { rateLimit } = require("../admin/rateLimit");
const auth = require("./auth");
const jwtUtil = require("./jwt");

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;
const VALID_ROLES = ["talent", "client"];

// ── Middleware ───────────────────────────────────────────

/**
 * Verifies the access token from the Authorization header. Same shape as
 * admin/routes.js's requireAdmin — does not hit the DB for the common case,
 * the one DB check (via sessionId) is what makes revocation take effect
 * within one access-token lifetime instead of only at next refresh.
 */
async function requireUser(req, res, next) {
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

  req.user = session.user;
  req.sessionId = session.id;
  next();
}

/** Mints the access/refresh token pair for a freshly-authenticated user. */
async function issueTokens(userId, userAgent) {
  const { refreshToken, sessionId } = await auth.createSession(userId, userAgent);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const accessToken = jwtUtil.generateAccessToken(user, sessionId);
  return { accessToken, refreshToken, expiresIn: jwtUtil.ACCESS_TOKEN_TTL_SECONDS };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    fullName: user.fullName,
    createdAt: user.createdAt,
  };
}

// ── Routes ───────────────────────────────────────────────

router.post(
  "/signup",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "user_signup" }),
  async (req, res) => {
    const { email, password, role, fullName } = req.body ?? {};

    if (typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email is required." });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: "Role must be 'talent' or 'client'." });
    }
    if (typeof fullName !== "string" || !fullName.trim()) {
      return res.status(400).json({ error: "Full name is required." });
    }

    const normalised = email.trim().toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email: normalised } });
    if (existing) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const passwordHash = await auth.hashPassword(password);
    const user = await prisma.user.create({
      data: { email: normalised, passwordHash, role, fullName: fullName.trim() },
    });

    if (role === "talent") {
      await prisma.talentProfile.create({ data: { userId: user.id } });
    }

    const tokens = await issueTokens(user.id, req.get("user-agent"));
    return res.status(201).json({ user: publicUser(user), ...tokens });
  },
);

router.post(
  "/login",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: "user_login" }),
  async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Same error either way — don't let this endpoint reveal which emails have accounts.
    if (!user || !(await auth.verifyPassword(user.passwordHash, password))) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    const tokens = await issueTokens(user.id, req.get("user-agent"));
    return res.json({ user: publicUser(user), ...tokens });
  },
);

router.post(
  "/auth/refresh",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 30, key: "user_refresh" }),
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

router.get("/me", requireUser, async (req, res) => {
  return res.json({ user: publicUser(req.user) });
});

module.exports = { router, requireUser };
