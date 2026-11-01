// Reported reviews (PRD §4.11). A review is removed only for abuse, personal data, irrelevance or leverage (§4.8);
// disagreeing with an honest review is not grounds, the reply is for that. Every decision is audited.
const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const { requireCapability } = require("./capabilities");
const { recordAudit } = require("./audit");
const reviews = require("../reviews");
const rep = require("../reputation");
const { skillByKey } = require("../skills");

const router = express.Router();
router.use(requireAdmin);
router.use(requireCapability("safety"));

const reasonLabel = (code) => rep.REMOVAL_REASONS.find((r) => r.code === code)?.label ?? code;

router.get("/", async (req, res) => {
  const handled = req.query.status === "handled";
  const rows = await prisma.reviewReport.findMany({ where: handled ? { status: { not: "open" } } : { status: "open" }, orderBy: handled ? { handledAt: "desc" } : { createdAt: "asc" }, take: 100, include: { review: true } });
  res.json({
    reports: rows.map((r) => ({ id: r.id, status: r.status, reason: reasonLabel(r.reasonCode), createdAt: r.createdAt, direction: r.review.direction, preview: r.review.comment.slice(0, 120) })),
  });
});

router.get("/counts", async (req, res) => res.json({ open: await prisma.reviewReport.count({ where: { status: "open" } }) }));

router.get("/:id", async (req, res) => {
  const r = await prisma.reviewReport.findUnique({ where: { id: req.params.id }, include: { review: true } });
  if (!r) return res.status(404).json({ error: "Report not found." });
  const job = await prisma.job.findUnique({ where: { id: r.review.jobId }, select: { title: true, skillKey: true, category: true, description: true } });
  const [author, subject, reporter, conversation] = await Promise.all([
    prisma.user.findUnique({ where: { id: r.review.authorId }, select: { fullName: true, role: true } }),
    prisma.user.findUnique({ where: { id: r.review.subjectId }, select: { fullName: true, role: true } }),
    prisma.user.findUnique({ where: { id: r.reporterId }, select: { fullName: true, role: true } }),
    prisma.conversation.findFirst({ where: { OR: [{ clientId: r.review.authorId, talentId: r.review.subjectId }, { clientId: r.review.subjectId, talentId: r.review.authorId }] } }),
  ]);
  // The conversation around the job helps tell leverage ("five stars if you do extra work") from an honest review.
  const messages = conversation ? await prisma.message.findMany({ where: { conversationId: conversation.id, state: "sent" }, orderBy: { createdAt: "desc" }, take: 20 }) : [];
  res.json({
    report: { id: r.id, status: r.status, reason: reasonLabel(r.reasonCode), reasonCode: r.reasonCode, note: r.note, handledNote: r.handledNote, createdAt: r.createdAt, reportedBy: reporter ? `${reporter.fullName} (${reporter.role})` : "Unknown" },
    review: { id: r.review.id, direction: r.review.direction, answers: r.review.answers, comment: r.review.comment, reply: r.review.reply, removedAt: r.review.removedAt, removedReason: r.review.removedReason, by: author ? `${author.fullName} (${author.role})` : "Unknown", about: subject ? `${subject.fullName} (${subject.role})` : "Unknown" },
    job: job ? { title: job.title, skill: job.skillKey ? skillByKey(job.skillKey)?.label ?? job.skillKey : job.category, description: job.description } : null,
    conversation: messages.reverse().map((m) => ({ fromAuthor: m.senderId === r.review.authorId, kind: m.kind, body: m.body, at: m.createdAt })),
    reasons: rep.REMOVAL_REASONS,
  });
});

router.post("/:id/handle", async (req, res) => {
  const r = await reviews.handleReport({ reportId: req.params.id, adminId: req.admin.id, decision: req.body?.decision, reasonCode: req.body?.reasonCode, note: req.body?.note });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  await recordAudit(prisma, req.admin, { action: `reviewReport.${req.body.decision === "remove" ? "removed" : "kept"}`, subjectType: "ReviewReport", subjectId: req.params.id, reasonCode: req.body.reasonCode ?? null, note: String(req.body.note).slice(0, 600) });
  res.json({ ok: true });
});

module.exports = { router };
