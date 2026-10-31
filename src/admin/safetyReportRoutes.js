// The team's queue of reported messages (PRD §4.11; D18, D43). A reviewer reads the message with the ones around it,
// and either dismisses the report or records that action was taken. Every decision is audited.
const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const { requireCapability } = require("./capabilities");
const { recordAudit } = require("./audit");
const messaging = require("../messaging");
const convo = require("../conversations");

const router = express.Router();
router.use(requireAdmin);
router.use(requireCapability("safety"));

const ALREADY_HANDLED = "Someone else just handled this report. Refresh the list.";
const ACTIONS = ["dismiss", "actioned"];

const reasonLabel = (code) => messaging.REPORT_REASONS.find((r) => r.code === code)?.label ?? code;

router.get("/", async (req, res) => {
  const status = req.query.status === "handled" ? "handled" : "open";
  const rows = await prisma.messageReport.findMany({
    where: status === "open" ? { status: "open" } : { status: { not: "open" } },
    orderBy: status === "open" ? { createdAt: "asc" } : { handledAt: "desc" },
    take: 100,
    include: { message: { select: { body: true, kind: true, senderId: true, conversationId: true } } },
  });
  const live = new Map();
  for (const r of rows) {
    const conv = await prisma.conversation.findUnique({ where: { id: r.message.conversationId } });
    live.set(r.id, conv ? await convo.activeContractBetween(prisma, conv.clientId, conv.talentId) : false);
  }
  res.json({
    reports: rows.map((r) => ({ id: r.id, status: r.status, reason: reasonLabel(r.reasonCode), createdAt: r.createdAt, preview: r.message.kind === "text" ? r.message.body.slice(0, 120) : r.message.kind, liveContract: live.get(r.id) })),
  });
});

router.get("/counts", async (req, res) => {
  res.json({ open: await prisma.messageReport.count({ where: { status: "open" } }) });
});

router.get("/:id", async (req, res) => {
  const r = await prisma.messageReport.findUnique({ where: { id: req.params.id }, include: { message: true } });
  if (!r) return res.status(404).json({ error: "Report not found." });
  const conv = await prisma.conversation.findUnique({ where: { id: r.message.conversationId }, include: { client: { select: { id: true, fullName: true, email: true } }, talent: { select: { id: true, fullName: true, email: true } } } });
  // The reported message and the ones around it, sent ones only: what the other person actually saw.
  const around = await prisma.message.findMany({
    where: { conversationId: r.message.conversationId, state: "sent", createdAt: { lte: new Date(r.message.createdAt.getTime() + 5 * 60_000) } },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  const name = (id) => (conv.client.id === id ? `${conv.client.fullName} (client)` : `${conv.talent.fullName} (talent)`);
  res.json({
    report: { id: r.id, status: r.status, reason: reasonLabel(r.reasonCode), note: r.note, createdAt: r.createdAt, handledNote: r.handledNote, reportedBy: name(r.reporterId), reported: name(r.message.senderId) },
    messages: around.reverse().map((m) => ({ id: m.id, from: name(m.senderId), kind: m.kind, body: m.body, at: m.createdAt, flagged: m.id === r.messageId, edited: Boolean(m.editedAt), originalBody: m.originalBody })),
    liveContract: await convo.activeContractBetween(prisma, conv.clientId, conv.talentId),
    parties: { client: conv.client, talent: conv.talent },
  });
});

router.post("/:id/handle", async (req, res) => {
  const r = await prisma.messageReport.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: "Report not found." });
  if (r.status !== "open") return res.status(409).json({ error: ALREADY_HANDLED });
  const action = req.body?.action;
  if (!ACTIONS.includes(action)) return res.status(400).json({ error: "Choose dismiss or action taken." });
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 600) : "";
  if (action === "actioned" && note.length < 10) return res.status(400).json({ error: "Say what you did, in at least 10 characters." });
  const ok = await prisma.$transaction(async (tx) => {
    const done = await tx.messageReport.updateMany({ where: { id: r.id, status: "open" }, data: { status: action === "dismiss" ? "dismissed" : "actioned", handledById: req.admin.id, handledAt: new Date(), handledNote: note || null } });
    if (done.count !== 1) return false;
    await recordAudit(tx, req.admin, { action: `safetyReport.${action}`, subjectType: "MessageReport", subjectId: r.id, reasonCode: r.reasonCode, note: note || null, details: { messageId: r.messageId } });
    return true;
  });
  if (!ok) return res.status(409).json({ error: ALREADY_HANDLED });
  console.log(`safety-reports: ${action} report=${r.id} by admin=${req.admin.id} readBack.status=${(await prisma.messageReport.findUnique({ where: { id: r.id }, select: { status: true } })).status}`);
  res.json({ ok: true });
});

module.exports = { router };
