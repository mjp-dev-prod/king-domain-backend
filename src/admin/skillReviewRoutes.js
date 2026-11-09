// The two human steps after a talent sends a skill submission (PRD §4.3; decisions D5 to D9, D43):
//   1. Authenticity, by a checker: is this really their work? (/admin/authenticity)
//   2. Review, by two reviewers who hold the skill, blind to each other; a third decides a split. (/admin/skill-reviews)
const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const { requireCapability, canReviewSkill, hasCapability } = require("./capabilities");
const { recordAudit } = require("./audit");
const storage = require("../storage");
const mailer = require("./mailer");
const { skillByKey, SKILLS } = require("../skills");
const { rubricFor, SCALE } = require("../rubrics");
const rules = require("../submissionRules");
const sub = require("../submissions");
const notices = require("../skillNotices");

const ALREADY_HANDLED = "Someone else just handled this one. Refresh the list.";
const NOTE_MIN = 10;

const authenticityRouter = express.Router();
authenticityRouter.use(requireAdmin);
authenticityRouter.use(requireCapability("checker"));

const reviewRouter = express.Router();
reviewRouter.use(requireAdmin);
reviewRouter.use(requireCapability("reviewer"));

/** What a checker confirms before work goes to reviewers. All must be true to pass. */
const AUTH_CHECKLIST = [
  { key: "walkthrough", label: "The walkthrough shows the person explaining this work as theirs." },
  { key: "howMade", label: "What shows how it was made (files, screenshots, recordings or a link) fits the finished work and the walkthrough." },
  { key: "elsewhere", label: "Nothing here is found published by someone else (reverse image or text search)." },
];

const withPerson = { user: { select: { id: true, fullName: true, email: true, country: true, state: true, educationKind: true, educationSchool: true, educationDetail: true } } };

async function filesWithLinks(files) {
  return Promise.all(
    files.map(async (f) => ({
      id: f.id,
      role: f.role,
      pieceId: f.pieceId,
      name: f.name,
      contentType: f.contentType,
      sizeBytes: f.sizeBytes,
      url: f.status === "ready" && storage.privateUploadsConfigured ? await storage.presignPrivateGet(f.objectKey, 900) : null,
    })),
  );
}

async function workOf(s) {
  const files = await filesWithLinks(s.files.filter((f) => f.status === "ready"));
  return {
    pieces: s.pieces.map((p) => ({ id: p.id, title: p.title, brief: p.brief, role: p.role, madeOn: p.madeOn, liveLink: p.liveLink, processLink: p.processLink ?? "", files: files.filter((f) => f.pieceId === p.id) })),
    walkthrough: files.filter((f) => !f.pieceId),
    declaration: { ownWork: s.declaredOwnWork, aiUsed: s.aiUsed, aiNote: s.aiNote },
  };
}

// ── Authenticity ─────────────────────────────────────────

authenticityRouter.get("/", async (req, res) => {
  const rows = await prisma.skillSubmission.findMany({ where: { status: "authenticity" }, orderBy: { submittedAt: "asc" }, take: 100, include: withPerson });
  res.json({
    submissions: rows.map((s) => ({ id: s.id, skillKey: s.skillKey, skillLabel: skillByKey(s.skillKey)?.label ?? s.skillKey, submittedAt: s.submittedAt, repeatOfRejected: s.repeatOfRejected, person: { name: s.user.fullName } })),
  });
});

authenticityRouter.get("/counts", async (req, res) => {
  res.json({ authenticity: await prisma.skillSubmission.count({ where: { status: "authenticity" } }) });
});

authenticityRouter.get("/:id", async (req, res) => {
  const s = await prisma.skillSubmission.findUnique({ where: { id: req.params.id }, include: { ...sub.submissionInclude, ...withPerson } });
  if (!s) return res.status(404).json({ error: "Submission not found." });
  const earlier = await prisma.skillSubmission.findMany({
    where: { userId: s.userId, skillKey: s.skillKey, id: { not: s.id }, submittedAt: { not: null } },
    orderBy: { submittedAt: "desc" },
    select: { id: true, status: true, submittedAt: true, resultReasons: true },
  });
  const restrictions = await prisma.skillRestriction.count({ where: { userId: s.userId, skillKey: s.skillKey, kind: "repeat" } });
  res.json({
    submission: {
      id: s.id,
      skillKey: s.skillKey,
      skillLabel: skillByKey(s.skillKey)?.label ?? s.skillKey,
      status: s.status,
      submittedAt: s.submittedAt,
      repeatOfRejected: s.repeatOfRejected,
      person: { id: s.user.id, name: s.user.fullName, email: s.user.email, region: s.user.country ? [s.user.city, s.user.state, s.user.country].filter(Boolean).join(", ") : null, education: s.user.educationKind ? { kind: s.user.educationKind, school: s.user.educationSchool, detail: s.user.educationDetail } : null },
      ...(await workOf(s)),
    },
    earlier,
    nextPenaltyMonths: rules.restrictionMonths(restrictions),
    checklist: AUTH_CHECKLIST,
  });
});

/** Moves a submission out of the authenticity step in one guarded write; false when someone else got there first. */
async function leaveAuthenticity(tx, s, admin, data) {
  const done = await tx.skillSubmission.updateMany({ where: { id: s.id, status: "authenticity" }, data: { authenticityById: admin.id, authenticityAt: new Date(), ...data } });
  return done.count === 1;
}

const loadForAuthenticity = async (id) => prisma.skillSubmission.findUnique({ where: { id }, include: { user: { select: { id: true, fullName: true, email: true } } } });
const noteOf = (req) => (typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 600) : "");

authenticityRouter.post("/:id/pass", async (req, res) => {
  const s = await loadForAuthenticity(req.params.id);
  if (!s) return res.status(404).json({ error: "Submission not found." });
  if (s.status !== "authenticity") return res.status(409).json({ error: ALREADY_HANDLED });
  const checklist = req.body?.checklist ?? {};
  const unticked = AUTH_CHECKLIST.filter((c) => checklist[c.key] !== true).map((c) => c.key);
  if (unticked.length) return res.status(400).json({ error: "Confirm every check before passing it on.", code: "checklist_incomplete", missing: unticked });
  const note = noteOf(req);
  const ok = await prisma.$transaction(async (tx) => {
    if (!(await leaveAuthenticity(tx, s, req.admin, { status: "review", authenticityChecklist: checklist, authenticityNote: note || null }))) return false;
    await recordAudit(tx, req.admin, { action: "authenticity.pass", subjectType: "SkillSubmission", subjectId: s.id, note: note || null, details: { userId: s.userId, skillKey: s.skillKey } });
    return true;
  });
  if (!ok) return res.status(409).json({ error: ALREADY_HANDLED });
  console.log(`authenticity: pass submission=${s.id} by admin=${req.admin.id} readBack.status=${(await prisma.skillSubmission.findUnique({ where: { id: s.id }, select: { status: true } })).status}`);
  res.json({ ok: true });
  // After the answer, so a slow email or push can't hold the checker up. Both are swallowed on failure.
  notices.readyForReview({ submission: s });
  notices.tellTalent(s.userId, "checked", s.skillKey);
});

/** Not passed, no penalty: the person is told why and can fix and resend. */
authenticityRouter.post("/:id/stop", async (req, res) => {
  const s = await loadForAuthenticity(req.params.id);
  if (!s) return res.status(404).json({ error: "Submission not found." });
  if (s.status !== "authenticity") return res.status(409).json({ error: ALREADY_HANDLED });
  const note = noteOf(req);
  if (note.length < NOTE_MIN) return res.status(400).json({ error: `Say what's wrong, in at least ${NOTE_MIN} characters.` });
  const ok = await prisma.$transaction(async (tx) => {
    if (!(await leaveAuthenticity(tx, s, req.admin, { status: "notYet", authenticityNote: note, decidedAt: new Date(), resultReasons: { kind: "authenticity", note } }))) return false;
    await recordAudit(tx, req.admin, { action: "authenticity.stop", subjectType: "SkillSubmission", subjectId: s.id, note, details: { userId: s.userId, skillKey: s.skillKey } });
    return true;
  });
  if (!ok) return res.status(409).json({ error: ALREADY_HANDLED });
  const sent = await mailer.sendSkillAuthenticity({ to: s.user.email, name: s.user.fullName, skillLabel: skillByKey(s.skillKey).label, outcome: "stopped", note });
  console.log(`authenticity: stop submission=${s.id} by admin=${req.admin.id} emailSent=${sent.sent}`);
  res.json({ ok: true });
  notices.tellTalent(s.userId, "needs_change", s.skillKey);
});

/** Resent rejected work unchanged: 2 months out of the skill, then 3 (D9). Only for a flagged repeat. */
authenticityRouter.post("/:id/penalize", async (req, res) => {
  const s = await loadForAuthenticity(req.params.id);
  if (!s) return res.status(404).json({ error: "Submission not found." });
  if (s.status !== "authenticity") return res.status(409).json({ error: ALREADY_HANDLED });
  if (!s.repeatOfRejected) return res.status(400).json({ error: "These files weren't flagged as a repeat of rejected work.", code: "not_a_repeat" });
  const note = noteOf(req) || "Sent rejected work again without changing it.";
  const prior = await prisma.skillRestriction.count({ where: { userId: s.userId, skillKey: s.skillKey, kind: "repeat" } });
  const months = rules.restrictionMonths(prior);
  const until = rules.addMonths(new Date(), months);
  const ok = await prisma.$transaction(async (tx) => {
    if (!(await leaveAuthenticity(tx, s, req.admin, { status: "notYet", authenticityNote: note, decidedAt: new Date(), resultReasons: { kind: "authenticity", note, restrictedUntil: until } }))) return false;
    await tx.skillRestriction.create({ data: { userId: s.userId, skillKey: s.skillKey, kind: "repeat", until, reason: note, createdById: req.admin.id } });
    await recordAudit(tx, req.admin, { action: "authenticity.penalize", subjectType: "SkillSubmission", subjectId: s.id, note, details: { userId: s.userId, skillKey: s.skillKey, months, until } });
    return true;
  });
  if (!ok) return res.status(409).json({ error: ALREADY_HANDLED });
  const sent = await mailer.sendSkillAuthenticity({ to: s.user.email, name: s.user.fullName, skillLabel: skillByKey(s.skillKey).label, outcome: "restricted", note, until });
  console.log(`authenticity: penalize submission=${s.id} by admin=${req.admin.id} months=${months} priorRepeats=${prior} until=${until.toISOString()} emailSent=${sent.sent}`);
  res.json({ ok: true, months, until });
  notices.tellTalent(s.userId, "needs_change", s.skillKey);
});

/** Someone else's work, or AI passed off as theirs: banned from the skill (D9). */
authenticityRouter.post("/:id/ban", async (req, res) => {
  const s = await loadForAuthenticity(req.params.id);
  if (!s) return res.status(404).json({ error: "Submission not found." });
  if (s.status !== "authenticity") return res.status(409).json({ error: ALREADY_HANDLED });
  const note = noteOf(req);
  if (note.length < NOTE_MIN) return res.status(400).json({ error: `Say what you found, in at least ${NOTE_MIN} characters.` });
  const ok = await prisma.$transaction(async (tx) => {
    if (!(await leaveAuthenticity(tx, s, req.admin, { status: "removed", authenticityNote: note, decidedAt: new Date(), resultReasons: { kind: "removed", note } }))) return false;
    await tx.skillRestriction.create({ data: { userId: s.userId, skillKey: s.skillKey, kind: "ban", until: null, reason: note, createdById: req.admin.id } });
    await recordAudit(tx, req.admin, { action: "authenticity.ban", subjectType: "SkillSubmission", subjectId: s.id, note, details: { userId: s.userId, skillKey: s.skillKey } });
    return true;
  });
  if (!ok) return res.status(409).json({ error: ALREADY_HANDLED });
  const sent = await mailer.sendSkillAuthenticity({ to: s.user.email, name: s.user.fullName, skillLabel: skillByKey(s.skillKey).label, outcome: "banned", note });
  console.log(`authenticity: ban submission=${s.id} by admin=${req.admin.id} emailSent=${sent.sent}`);
  res.json({ ok: true });
});

// ── Review ───────────────────────────────────────────────

const allowedSkills = (admin) => (admin.role === "owner" ? SKILLS.map((s) => s.key) : (admin.reviewerSkills ?? []));

/** Reviewers see the work, never the person or the other reviewer's scores: they judge it blind. */
reviewRouter.get("/", async (req, res) => {
  const mine = allowedSkills(req.admin);
  const rows = await prisma.skillSubmission.findMany({
    where: { status: "review", skillKey: { in: mine }, reviews: { none: { reviewerId: req.admin.id } } },
    orderBy: { authenticityAt: "asc" },
    take: 100,
    include: { reviews: { select: { id: true } }, pieces: { select: { id: true } } },
  });
  res.json({
    submissions: rows.map((s) => ({ id: s.id, skillKey: s.skillKey, skillLabel: skillByKey(s.skillKey)?.label ?? s.skillKey, waitingSince: s.authenticityAt, reviewsSoFar: s.reviews.length, pieces: s.pieces.length, thirdOpinion: s.reviews.length >= 2 })),
  });
});

reviewRouter.get("/counts", async (req, res) => {
  const open = await prisma.skillSubmission.count({ where: { status: "review", skillKey: { in: allowedSkills(req.admin) }, reviews: { none: { reviewerId: req.admin.id } } } });
  res.json({ open });
});

reviewRouter.get("/:id", async (req, res) => {
  const s = await prisma.skillSubmission.findUnique({ where: { id: req.params.id }, include: { ...sub.submissionInclude, reviews: true } });
  if (!s) return res.status(404).json({ error: "Submission not found." });
  if (!canReviewSkill(req.admin, s.skillKey)) return res.status(403).json({ error: "You don't review this skill." });
  const rubric = rubricFor(s.skillKey);
  const mine = s.reviews.find((r) => r.reviewerId === req.admin.id);
  res.json({
    submission: { id: s.id, skillKey: s.skillKey, skillLabel: skillByKey(s.skillKey)?.label ?? s.skillKey, status: s.status, ...(await workOf(s)) },
    rubric: { draft: rubric.draft, scale: SCALE, lines: rubric.lines },
    myReview: mine ? { scores: mine.scores, verdict: mine.verdict, comment: mine.comment } : null,
    thirdOpinion: s.reviews.length >= 2,
  });
});

class Conflict extends Error {}

reviewRouter.post("/:id/review", async (req, res) => {
  const s = await prisma.skillSubmission.findUnique({ where: { id: req.params.id }, include: { user: { select: { id: true, fullName: true, email: true } } } });
  if (!s) return res.status(404).json({ error: "Submission not found." });
  if (!canReviewSkill(req.admin, s.skillKey)) return res.status(403).json({ error: "You don't review this skill." });
  if (s.status !== "review") return res.status(409).json({ error: ALREADY_HANDLED });

  const rubric = rubricFor(s.skillKey);
  const checked = rules.validateReview(req.body ?? {}, rubric);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  let decision;
  try {
    decision = await prisma.$transaction(async (tx) => {
      // One reviewer at a time per submission, so two simultaneous reviews can't each decide without the other.
      await tx.$queryRaw`SELECT id FROM skill_submissions WHERE id = ${s.id} FOR UPDATE`;
      const before = await tx.submissionReview.findMany({ where: { submissionId: s.id } });
      if (before.some((r) => r.reviewerId === req.admin.id)) throw new Conflict("You've already reviewed this one.");
      // A third review is only asked for when the first two disagree.
      if (before.length >= 3 || (before.length === 2 && rules.decide(before).state !== "needThird")) throw new Conflict(ALREADY_HANDLED);

      await tx.submissionReview.create({ data: { submissionId: s.id, reviewerId: req.admin.id, scores: checked.scores, verdict: checked.verdict, comment: checked.comment } });
      const all = await tx.submissionReview.findMany({ where: { submissionId: s.id } });
      if (all.length > 3 || (all.length === 3 && before.length < 2)) throw new Conflict(ALREADY_HANDLED); // two people raced for the same slot
      const result = rules.decide(all);
      await recordAudit(tx, req.admin, { action: "skillReview.review", subjectType: "SkillSubmission", subjectId: s.id, details: { skillKey: s.skillKey, verdict: checked.verdict, reviewsNow: all.length } });
      if (result.state !== "decided") return { result, all };

      const decidedAt = new Date();
      const reasons = result.outcome === "notYet" ? { kind: "review", ...rules.reasonsFor(all, rubric) } : null;
      const done = await tx.skillSubmission.updateMany({ where: { id: s.id, status: "review" }, data: { status: result.outcome, decidedAt, resultReasons: reasons } });
      if (done.count !== 1) throw new Conflict(ALREADY_HANDLED);
      if (result.outcome === "verified") await sub.markVerified(tx, s);
      await recordAudit(tx, req.admin, { action: `skillReview.${result.outcome}`, subjectType: "SkillSubmission", subjectId: s.id, details: { userId: s.userId, skillKey: s.skillKey, reviews: all.length } });
      return { result, all, reasons };
    });
  } catch (err) {
    if (err instanceof Conflict) return res.status(409).json({ error: err.message });
    throw err;
  }

  const { result, all, reasons } = decision;
  let emailSent = null;
  const skillLabel = skillByKey(s.skillKey).label;
  if (result.state === "decided") {
    const sent = result.outcome === "verified"
      ? await mailer.sendSkillVerified({ to: s.user.email, name: s.user.fullName, skillLabel })
      : await mailer.sendSkillNotYet({ to: s.user.email, name: s.user.fullName, skillLabel, lines: reasons.lines, comments: reasons.comments });
    emailSent = sent.sent;
  }
  if (result.state === "decided") notices.tellTalent(s.userId, result.outcome === "verified" ? "verified" : "not_yet", s.skillKey);
  console.log(`skill-review: submission=${s.id} by admin=${req.admin.id} verdict=${checked.verdict} reviews=${all.length} state=${result.state}${result.outcome ? ` outcome=${result.outcome}` : ""} emailSent=${emailSent}`);
  res.json({ ok: true, state: result.state, outcome: result.outcome ?? null });
});

module.exports = { authenticityRouter, reviewRouter, AUTH_CHECKLIST };
