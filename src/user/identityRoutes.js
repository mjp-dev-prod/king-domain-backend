// Region, education line, identity and the guardian (PRD §3.1, §4.4; decisions D10 to D15, D47).
// Mounted at /users, plus the public guardian page at /guardian.
const express = require("express");
const crypto = require("node:crypto");
const { prisma } = require("../db");
const { requireUser } = require("./routes");
const { rateLimit } = require("../admin/rateLimit");
const { identityFiles, inspectUpload, IMAGE_ALLOW, VIDEO_ALLOW, MAX_UPLOAD_BYTES } = require("../uploads");
const { uploadIdentityFile } = require("../storage");
const identity = require("../identity");
const mailer = require("../admin/mailer");

const router = express.Router();
const guardianRouter = express.Router();

/** Youngest age we accept. Not decided by Victor (PRD open item): 16 matches university admission. */
const MIN_AGE = Number(process.env.IDENTITY_MIN_AGE || 16);
const EDUCATION_KINDS = ["student", "graduate", "trained", "selfTaught"];
const CLIENT_KINDS = ["individual", "business"];
const DOCUMENTS = ["ninSlip", "passport", "cac"];
const GUARDIAN_LINK_HOURS = 72;

const cleaned = (v, max = 100) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

function publicBase() {
  return (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, "");
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

// ── Region and education line ────────────────────────────

router.patch("/me/region-education", requireUser, async (req, res) => {
  const b = req.body ?? {};
  const country = cleaned(b.country, 60);
  const state = cleaned(b.state, 60);
  const city = cleaned(b.city, 60);
  if (!country) return res.status(400).json({ error: "Choose your country." });
  if (country.toLowerCase() === "nigeria" && !state) return res.status(400).json({ error: "Choose your state." });

  const data = { country, state: state || null, city: city || null };

  if (req.user.role === "client") {
    if (!CLIENT_KINDS.includes(b.clientKind)) return res.status(400).json({ error: "Say whether you hire as an individual or a business." });
    data.clientKind = b.clientKind;
  } else {
    if (!EDUCATION_KINDS.includes(b.educationKind)) return res.status(400).json({ error: "Choose how to describe your training." });
    const school = cleaned(b.educationSchool, 120);
    const detail = cleaned(b.educationDetail, 80);
    if ((b.educationKind === "student" || b.educationKind === "graduate") && (!school || !detail)) {
      return res.status(400).json({ error: b.educationKind === "student" ? "Add your school and the session." : "Add your school and the year you graduated." });
    }
    if (b.educationKind === "trained" && !detail) return res.status(400).json({ error: "Add the course or camp." });
    data.educationKind = b.educationKind;
    data.educationSchool = b.educationKind === "selfTaught" ? null : school || null;
    data.educationDetail = b.educationKind === "selfTaught" ? null : detail || null;
  }

  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  return res.json({ region: regionOf(user), education: educationOf(user), clientKind: user.clientKind });
});

function regionOf(u) {
  return u.country ? { country: u.country, state: u.state, city: u.city } : null;
}
function educationOf(u) {
  return u.educationKind ? { kind: u.educationKind, school: u.educationSchool, detail: u.educationDetail } : null;
}

// ── Identity ─────────────────────────────────────────────

async function identitySummary(user) {
  const [latest, guardian] = await Promise.all([
    prisma.identityCheck.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
    prisma.guardianConsent.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const state = identity.identityState({
    identityVerifiedAt: user.identityVerifiedAt,
    dateOfBirth: user.dateOfBirth,
    guardianConfirmedAt: user.guardianConfirmedAt,
    latestCheckStatus: latest?.status,
  });
  // A minor can be known from what they typed before the checker verifies it, so the guardian step can start early.
  const claimedMinor = !user.identityVerifiedAt && latest?.claimedDateOfBirth ? identity.isMinor(latest.claimedDateOfBirth) : false;
  return {
    ...state,
    minor: state.minor || claimedMinor,
    guardianNeeded: state.status === "verified" ? state.guardianNeeded : claimedMinor && !user.guardianConfirmedAt,
    requiredForPaidActions: process.env.IDENTITY_REQUIRED === "true",
    reason: latest?.status === "notYet" ? { code: latest.reasonCode, label: identity.NOT_YET_REASONS.find((r) => r.code === latest.reasonCode)?.label ?? null, note: latest.note } : null,
    latest: latest ? { id: latest.id, document: latest.document, submittedAt: latest.createdAt } : null,
    guardian: guardian ? { name: guardian.guardianName, email: guardian.guardianEmail, confirmed: Boolean(guardian.confirmedAt) } : null,
  };
}

router.get("/me/identity", requireUser, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  return res.json({ identity: await identitySummary(user) });
});

router.post(
  "/me/identity",
  requireUser,
  rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.IDENTITY_SUBMIT_LIMIT || 8), key: "user_identity_submit", by: (req) => req.user.id }),
  identityFiles(),
  async (req, res) => {
    const b = req.body ?? {};
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.identityVerifiedAt) return res.status(409).json({ error: "You're already verified.", code: "already_verified" });
    const open = await prisma.identityCheck.findFirst({ where: { userId: user.id, status: "pending" } });
    if (open) return res.status(409).json({ error: "Your last submission is still being checked.", code: "already_pending" });

    const document = b.document;
    if (!DOCUMENTS.includes(document)) return res.status(400).json({ error: "Choose the document you're sending." });
    if (document === "cac" && req.user.role !== "client") return res.status(400).json({ error: "A CAC certificate is for businesses that hire." });
    const fullName = cleaned(b.fullName, 120);
    if (identity.normaliseName(fullName).split(" ").filter(Boolean).length < 2) {
      return res.status(400).json({ error: "Enter your full name as it appears on the document." });
    }
    if (document === "ninSlip" && !identity.isNin(b.documentNumber)) return res.status(400).json({ error: "Enter your 11-digit NIN." });
    if (document !== "ninSlip" && cleaned(b.documentNumber, 40).length < 5) return res.status(400).json({ error: "Enter the document number." });

    let dob = null;
    if (document !== "cac") {
      dob = parseDate(b.dateOfBirth);
      if (!dob) return res.status(400).json({ error: "Enter your date of birth." });
      if (identity.ageOn(dob) < MIN_AGE) return res.status(400).json({ error: `You must be at least ${MIN_AGE} to use King Domain.`, code: "too_young" });
    }

    const docFile = req.files?.document?.[0];
    const videoFile = req.files?.video?.[0];
    if (!docFile) return res.status(400).json({ error: "Add a clear photo of the document." });
    if (document !== "cac" && !videoFile) return res.status(400).json({ error: "Add the short live video of your face." });
    if (docFile.size > MAX_UPLOAD_BYTES) return res.status(413).json({ error: "The document photo is too large. The limit is 10 MB.", code: "file_too_large" });

    const checkedDoc = inspectUpload({ buffer: docFile.buffer, originalName: docFile.originalname, allow: IMAGE_ALLOW, unsupportedMessage: "The document must be a photo (JPG, PNG, WebP or HEIC)." });
    if (!checkedDoc.ok) return res.status(checkedDoc.status).json({ error: checkedDoc.error, code: checkedDoc.code });
    let checkedVideo = null;
    if (videoFile) {
      checkedVideo = inspectUpload({ buffer: videoFile.buffer, originalName: videoFile.originalname, allow: VIDEO_ALLOW, unsupportedMessage: "The video must be an MP4, MOV or WebM file." });
      if (!checkedVideo.ok) return res.status(checkedVideo.status).json({ error: checkedVideo.error, code: checkedVideo.code });
    }

    const documentPath = await uploadIdentityFile({ userId: user.id, buffer: docFile.buffer, originalName: checkedDoc.fileName, contentType: checkedDoc.contentType });
    const videoPath = checkedVideo
      ? await uploadIdentityFile({ userId: user.id, buffer: videoFile.buffer, originalName: checkedVideo.fileName, contentType: checkedVideo.contentType })
      : null;

    const check = await prisma.identityCheck.create({
      data: { userId: user.id, document, documentPath, videoPath, claimedName: fullName, claimedDateOfBirth: dob },
    });
    console.log(`identity: submitted check=${check.id} user=${user.id} document=${document} video=${Boolean(videoPath)} claimedMinor=${dob ? identity.isMinor(dob) : false} readBack=${(await prisma.identityCheck.count({ where: { id: check.id, status: "pending" } })) === 1}`);
    return res.status(201).json({ identity: await identitySummary(user) });
  },
);

// ── Guardian (under 18) ──────────────────────────────────

router.post(
  "/me/guardian",
  requireUser,
  rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.GUARDIAN_INVITE_LIMIT || 5), key: "user_guardian_invite", by: (req) => req.user.id }),
  async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const summary = await identitySummary(user);
    if (!summary.minor) return res.status(400).json({ error: "A guardian is only needed if you're under 18.", code: "not_a_minor" });
    if (user.guardianConfirmedAt) return res.status(409).json({ error: "Your guardian has already confirmed.", code: "already_confirmed" });

    const b = req.body ?? {};
    const guardianName = cleaned(b.guardianName, 120);
    const guardianEmail = cleaned(b.guardianEmail, 160).toLowerCase();
    const relationship = cleaned(b.relationship, 40);
    if (identity.normaliseName(guardianName).split(" ").filter(Boolean).length < 2) return res.status(400).json({ error: "Enter your guardian's full name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail)) return res.status(400).json({ error: "Enter your guardian's email address." });
    if (guardianEmail === user.email.toLowerCase()) return res.status(400).json({ error: "Your guardian needs their own email address." });
    if (!relationship) return res.status(400).json({ error: "Say how they're related to you (parent, guardian, other)." });

    const token = crypto.randomBytes(32).toString("base64url");
    await prisma.$transaction([
      prisma.guardianConsent.deleteMany({ where: { userId: user.id, confirmedAt: null } }),
      prisma.guardianConsent.create({
        data: { userId: user.id, guardianName, guardianEmail, relationship, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + GUARDIAN_LINK_HOURS * 3600 * 1000) },
      }),
    ]);
    const link = `${publicBase()}/guardian/confirm?token=${encodeURIComponent(token)}`;
    const sent = await mailer.sendGuardianRequest({ to: guardianEmail, guardianName, youngPersonName: user.fullName, link, hours: GUARDIAN_LINK_HOURS });
    console.log(`identity: guardian invited user=${user.id} to=${guardianEmail} emailSent=${sent.sent} expiresInHours=${GUARDIAN_LINK_HOURS}`);
    return res.status(201).json({ identity: await identitySummary(user) });
  },
);

// ── The guardian's page: public, served by the backend so the emailed link always lands somewhere real ──

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;background:#0D0A16;color:#F2EFFA;margin:0;padding:24px}main{max-width:520px;margin:0 auto}h1{font-size:24px;line-height:1.2}p{color:#ABA4C3}button{background:#7451F2;color:#fff;border:0;border-radius:16px;padding:14px 22px;font-size:16px;font-weight:700;width:100%}.card{background:#151121;border-radius:20px;padding:20px;margin:18px 0}</style></head><body><main>${body}</main></body></html>`;

async function consentFor(token) {
  if (typeof token !== "string" || !token) return null;
  return prisma.guardianConsent.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
}

guardianRouter.get("/confirm", async (req, res) => {
  const consent = await consentFor(req.query.token);
  res.type("html");
  if (!consent || consent.expiresAt < new Date()) {
    return res.status(410).send(page("Link expired", `<h1>This link has expired</h1><p>Ask the young person who sent it to send a new one from the King Domain app.</p>`));
  }
  if (consent.confirmedAt) return res.send(page("Already confirmed", `<h1>You've already confirmed</h1><p>Thank you. Nothing more to do.</p>`));
  const name = esc(consent.user.fullName);
  return res.send(
    page(
      "Confirm consent",
      `<h1>${esc(consent.guardianName)}, do you consent?</h1>
       <p><strong>${name}</strong> wants to take paid freelance work on King Domain, a marketplace for students and emerging talent in Nigeria.</p>
       <div class="card"><p>If you agree: they may apply for jobs and be paid. <strong>Money is always paid into a bank account in their own name</strong>, never yours. Clients are identity-checked, payments are held until work is approved, and you can withdraw your consent any time by emailing ${esc(process.env.SUPPORT_EMAIL || "the King Domain team")}.</p>
       <p>We keep your name, email and this confirmation with their account, only for this purpose.</p></div>
       <form method="post" action="/guardian/confirm"><input type="hidden" name="token" value="${esc(req.query.token)}"><button type="submit">Yes, I consent</button></form>`,
    ),
  );
});

guardianRouter.post("/confirm", express.urlencoded({ extended: false }), async (req, res) => {
  const consent = await consentFor(req.body?.token);
  res.type("html");
  if (!consent || consent.expiresAt < new Date()) {
    return res.status(410).send(page("Link expired", `<h1>This link has expired</h1><p>Ask the young person to send a new one from the King Domain app.</p>`));
  }
  const confirmedAt = new Date();
  await prisma.$transaction([
    prisma.guardianConsent.updateMany({ where: { id: consent.id, confirmedAt: null }, data: { confirmedAt } }),
    prisma.user.update({ where: { id: consent.userId }, data: { guardianConfirmedAt: consent.confirmedAt ?? confirmedAt } }),
  ]);
  const back = await prisma.user.findUnique({ where: { id: consent.userId }, select: { guardianConfirmedAt: true } });
  console.log(`identity: guardian confirmed user=${consent.userId} guardianConfirmedAt=${back.guardianConfirmedAt?.toISOString() ?? "NOT SET"}`);
  return res.send(page("Thank you", `<h1>Thank you</h1><p>Your consent is recorded. ${esc(consent.user.fullName)} can carry on in the app.</p>`));
});

module.exports = { router, guardianRouter, identitySummary, MIN_AGE };
