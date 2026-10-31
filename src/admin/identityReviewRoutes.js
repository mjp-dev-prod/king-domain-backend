// The checker's queue for identity submissions (PRD §4.4, decisions D10, D43, D47).
// A person reads the document and the live video, types what the document shows, and decides.
const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const { requireCapability } = require("./capabilities");
const { recordAudit } = require("./audit");
const { getIdentityFileSignedUrl } = require("../storage");
const identity = require("../identity");
const mailer = require("./mailer");

const router = express.Router();
router.use(requireAdmin);
router.use(requireCapability("checker"));

const ALREADY_HANDLED = "Someone else just checked this submission. Refresh the list.";
const STATUSES = ["pending", "verified", "notYet"];

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

const withUser = { user: { select: { id: true, fullName: true, email: true, role: true, clientKind: true } } };

function serialise(c, urls = {}) {
  return {
    id: c.id,
    document: c.document,
    claimedName: c.claimedName,
    claimedDateOfBirth: c.claimedDateOfBirth ? c.claimedDateOfBirth.toISOString().slice(0, 10) : null,
    status: c.status,
    legalName: c.legalName,
    reasonCode: c.reasonCode,
    note: c.note,
    createdAt: c.createdAt,
    reviewedAt: c.reviewedAt,
    user: c.user,
    documentUrl: urls.documentUrl ?? null,
    videoUrl: urls.videoUrl ?? null,
  };
}

router.get("/", async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : "pending";
  const rows = await prisma.identityCheck.findMany({
    where: { status },
    orderBy: status === "pending" ? { createdAt: "asc" } : { reviewedAt: "desc" },
    take: 100,
    include: withUser,
  });
  res.json({ checks: rows.map((c) => serialise(c)), reasons: identity.NOT_YET_REASONS });
});

router.get("/counts", async (req, res) => {
  const counts = Object.fromEntries(await Promise.all(STATUSES.map(async (s) => [s, await prisma.identityCheck.count({ where: { status: s } })])));
  res.json(counts);
});

router.get("/:id", async (req, res) => {
  const c = await prisma.identityCheck.findUnique({ where: { id: req.params.id }, include: withUser });
  if (!c) return res.status(404).json({ error: "Submission not found." });
  const [documentUrl, videoUrl] = await Promise.all([
    getIdentityFileSignedUrl(c.documentPath),
    c.videoPath ? getIdentityFileSignedUrl(c.videoPath) : null,
  ]);
  // Opening someone's identity documents is itself recorded.
  await recordAudit(prisma, req.admin, { action: "identity.view", subjectType: "IdentityCheck", subjectId: c.id, details: { userId: c.userId } });
  res.json({ check: serialise(c, { documentUrl, videoUrl }), reasons: identity.NOT_YET_REASONS });
});

router.post("/:id/approve", async (req, res) => {
  const c = await prisma.identityCheck.findUnique({ where: { id: req.params.id }, include: withUser });
  if (!c) return res.status(404).json({ error: "Submission not found." });
  if (c.status !== "pending") return res.status(409).json({ error: ALREADY_HANDLED });

  const legalName = typeof req.body?.legalName === "string" ? req.body.legalName.trim() : "";
  if (!legalName) return res.status(400).json({ error: "Type the name exactly as the document shows it." });
  if (!identity.namesMatch(legalName, c.claimedName)) {
    return res.status(400).json({ error: "The name on the document doesn't match what the person entered. Use Not yet with the name reason.", code: "name_mismatch" });
  }
  let dateOfBirth = null;
  if (c.document !== "cac") {
    dateOfBirth = parseDate(req.body?.dateOfBirth);
    if (!dateOfBirth) return res.status(400).json({ error: "Type the date of birth as the document shows it (YYYY-MM-DD)." });
    if (c.claimedDateOfBirth && c.claimedDateOfBirth.toISOString().slice(0, 10) !== dateOfBirth.toISOString().slice(0, 10)) {
      return res.status(400).json({ error: "The date of birth on the document doesn't match what the person entered. Use Not yet.", code: "dob_mismatch" });
    }
  }

  const reviewedAt = new Date();
  const claimed = await prisma.$transaction(async (tx) => {
    const done = await tx.identityCheck.updateMany({
      where: { id: c.id, status: "pending" },
      data: { status: "verified", legalName, dateOfBirth, reviewedById: req.admin.id, reviewedAt },
    });
    if (done.count !== 1) return false;
    await tx.user.update({ where: { id: c.userId }, data: { legalName, dateOfBirth, identityVerifiedAt: reviewedAt } });
    await recordAudit(tx, req.admin, { action: "identity.approve", subjectType: "IdentityCheck", subjectId: c.id, details: { userId: c.userId, document: c.document } });
    return true;
  });
  if (!claimed) return res.status(409).json({ error: ALREADY_HANDLED });

  const back = await prisma.user.findUnique({ where: { id: c.userId }, select: { identityVerifiedAt: true, legalName: true } });
  const sent = await mailer.sendIdentityVerified({ to: c.user.email, name: c.user.fullName });
  console.log(`identity-review: approve check=${c.id} by admin=${req.admin.id} user=${c.userId} readBack.verifiedAt=${back.identityVerifiedAt?.toISOString() ?? "NOT SET"} emailSent=${sent.sent}`);
  res.json({ ok: true });
});

router.post("/:id/not-yet", async (req, res) => {
  const c = await prisma.identityCheck.findUnique({ where: { id: req.params.id }, include: withUser });
  if (!c) return res.status(404).json({ error: "Submission not found." });
  if (c.status !== "pending") return res.status(409).json({ error: ALREADY_HANDLED });

  const reason = identity.NOT_YET_REASONS.find((r) => r.code === req.body?.reasonCode);
  if (!reason) return res.status(400).json({ error: "Choose a reason." });
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";
  if (reason.code === "other" && note.length < 10) return res.status(400).json({ error: "Say what's wrong, in at least 10 characters." });

  const claimed = await prisma.$transaction(async (tx) => {
    const done = await tx.identityCheck.updateMany({
      where: { id: c.id, status: "pending" },
      data: { status: "notYet", reasonCode: reason.code, note: note || null, reviewedById: req.admin.id, reviewedAt: new Date() },
    });
    if (done.count !== 1) return false;
    await recordAudit(tx, req.admin, { action: "identity.notYet", subjectType: "IdentityCheck", subjectId: c.id, reasonCode: reason.code, note: note || null, details: { userId: c.userId } });
    return true;
  });
  if (!claimed) return res.status(409).json({ error: ALREADY_HANDLED });

  const sent = await mailer.sendIdentityNotYet({ to: c.user.email, name: c.user.fullName, reasonLabel: reason.label, note });
  console.log(`identity-review: notYet check=${c.id} by admin=${req.admin.id} reason=${reason.code} emailSent=${sent.sent}`);
  res.json({ ok: true });
});

module.exports = { router };
