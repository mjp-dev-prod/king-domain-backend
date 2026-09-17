const express = require("express");
const multer = require("multer");
const crypto = require("node:crypto");
const { prisma } = require("../db");
const { rateLimit } = require("../admin/rateLimit");
const mailer = require("../admin/mailer");
const { uploadProofFile, getProofFileSignedUrl } = require("../storage");
const auth = require("./auth");
const jwtUtil = require("./jwt");

const router = express.Router();

// Matches the proof-items Supabase Storage bucket's own limit — a work
// sample is a screenshot/short file, not a video master, so this is
// deliberately much tighter than the 50MB app-releases bucket.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const MIN_PASSWORD_LENGTH = 8;
const VALID_ROLES = ["talent", "client"];
const VERIFICATION_CODE_TTL_MINUTES = 10;

/** 6-digit numeric code — typed from an email, not a link, so keep it short. */
function generateVerificationCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/** Generates a fresh code, stores its hash, and sends it — shared by
 * signup and the resend endpoint so the two can't drift apart. */
async function issueVerificationCode(user) {
  const code = generateVerificationCode();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      verificationCodeHash: hashCode(code),
      verificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MINUTES * 60 * 1000),
    },
  });
  await mailer.sendVerificationCode({ to: user.email, code });
}

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
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
  };
}

/** Resolves filePath to a short-lived signed URL — never returns the raw path. */
async function serializeProofItem(item) {
  return {
    id: item.id,
    category: item.category,
    title: item.title,
    fileUrl: item.filePath ? await getProofFileSignedUrl(item.filePath) : null,
    status: item.status,
    reviewedAt: item.reviewedAt,
    createdAt: item.createdAt,
  };
}

async function serializeTalentProfile(profile) {
  return {
    id: profile.id,
    headline: profile.headline,
    bio: profile.bio,
    skillCategories: profile.skillCategories,
    proofItems: await Promise.all(profile.proofItems.map(serializeProofItem)),
  };
}

/** Only talent accounts have a TalentProfile — client accounts 404 here. */
async function requireTalentProfile(req, res, next) {
  if (req.user.role !== "talent") {
    return res.status(403).json({ error: "Only talent accounts have a profile." });
  }
  const profile = await prisma.talentProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.status(404).json({ error: "Talent profile not found." });
  req.talentProfile = profile;
  next();
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

    // Fire-and-forget, same as mailer's own fallback: if Brevo isn't
    // configured the code is logged server-side instead of failing signup
    // outright — signing up shouldn't hard-fail because email delivery isn't
    // set up yet in a given environment.
    issueVerificationCode(user).catch((err) =>
      console.error("signup: failed to send verification code:", err),
    );

    const tokens = await issueTokens(user.id, req.get("user-agent"));
    return res.status(201).json({ user: publicUser(user), ...tokens });
  },
);

router.post(
  "/verify-email",
  requireUser,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "user_verify_email" }),
  async (req, res) => {
    const { code } = req.body ?? {};
    if (typeof code !== "string" || !code.trim()) {
      return res.status(400).json({ error: "code is required." });
    }

    if (req.user.emailVerified) {
      return res.json({ user: publicUser(req.user) });
    }

    if (
      !req.user.verificationCodeHash ||
      !req.user.verificationCodeExpiresAt ||
      req.user.verificationCodeExpiresAt < new Date()
    ) {
      return res.status(400).json({ error: "Code expired. Request a new one." });
    }

    if (hashCode(code.trim()) !== req.user.verificationCodeHash) {
      return res.status(400).json({ error: "Incorrect code." });
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { emailVerified: true, verificationCodeHash: null, verificationCodeExpiresAt: null },
    });

    return res.json({ user: publicUser(updated) });
  },
);

router.post(
  "/resend-code",
  requireUser,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, key: "user_resend_code" }),
  async (req, res) => {
    if (req.user.emailVerified) {
      return res.status(400).json({ error: "Email is already verified." });
    }
    await issueVerificationCode(req.user);
    return res.json({ ok: true });
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

// ── Talent profile ───────────────────────────────────────

router.get("/me/profile", requireUser, requireTalentProfile, async (req, res) => {
  const profile = await prisma.talentProfile.findUnique({
    where: { id: req.talentProfile.id },
    include: { proofItems: { orderBy: { createdAt: "desc" } } },
  });
  return res.json({ profile: await serializeTalentProfile(profile) });
});

router.patch("/me/profile", requireUser, requireTalentProfile, async (req, res) => {
  const { headline, bio, skillCategories } = req.body ?? {};

  const data = {};
  if (headline !== undefined) {
    if (typeof headline !== "string") return res.status(400).json({ error: "headline must be a string." });
    data.headline = headline;
  }
  if (bio !== undefined) {
    if (typeof bio !== "string") return res.status(400).json({ error: "bio must be a string." });
    data.bio = bio;
  }
  if (skillCategories !== undefined) {
    if (!Array.isArray(skillCategories) || !skillCategories.every((c) => typeof c === "string")) {
      return res.status(400).json({ error: "skillCategories must be an array of strings." });
    }
    data.skillCategories = skillCategories;
  }

  const updated = await prisma.talentProfile.update({
    where: { id: req.talentProfile.id },
    data,
    include: { proofItems: { orderBy: { createdAt: "desc" } } },
  });
  return res.json({ profile: await serializeTalentProfile(updated) });
});

// ── Proof items — submission (review lives under /admin, see
// admin/proofReviewRoutes.js: this is deliberately a one-way door, a
// talent can submit and read their own items but never verify them) ──

router.post(
  "/me/proof-items",
  requireUser,
  requireTalentProfile,
  upload.single("file"),
  async (req, res) => {
    const { category, title } = req.body ?? {};

    if (typeof category !== "string" || !category.trim()) {
      return res.status(400).json({ error: "category is required." });
    }
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title is required." });
    }

    let filePath = null;
    if (req.file) {
      filePath = await uploadProofFile({
        talentProfileId: req.talentProfile.id,
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        contentType: req.file.mimetype,
      });
    }

    const item = await prisma.proofItem.create({
      data: {
        talentProfileId: req.talentProfile.id,
        category: category.trim(),
        title: title.trim(),
        filePath,
      },
    });

    return res.status(201).json({ proofItem: await serializeProofItem(item) });
  },
);

router.delete("/me/proof-items/:id", requireUser, requireTalentProfile, async (req, res) => {
  const item = await prisma.proofItem.findUnique({ where: { id: req.params.id } });
  if (!item || item.talentProfileId !== req.talentProfile.id) {
    return res.status(404).json({ error: "Proof item not found." });
  }
  // Deliberately no delete once verified — that would let a talent erase a
  // reviewer's decision. Removal is only for items still pending review.
  if (item.status === "verified") {
    return res.status(400).json({ error: "A verified proof item can't be removed." });
  }
  await prisma.proofItem.delete({ where: { id: item.id } });
  return res.json({ ok: true });
});

module.exports = { router, requireUser, requireTalentProfile };
