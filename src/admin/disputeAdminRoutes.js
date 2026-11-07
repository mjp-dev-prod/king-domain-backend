// The team's side of S6 (PRD §4.9, §4.11; D33 to D36, D44): the case screen for escalated disputes, with everything
// assembled in one place, the ruling form, the second-person approval for anything above ₦100,000, and the chargeback
// queue with the receipt Paystack asks for. Every decision is audited.
const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const { requireCapability } = require("./capabilities");
const { recordAudit } = require("./audit");
const disputes = require("../disputes");
const settlement = require("../settlement");
const chargebacks = require("../chargebacks");
const sp = require("../startProof");
const { describe: describeBrief } = require("../briefs");
const storage = require("../storage");
const { skillByKey } = require("../skills");

const disputesRouter = express.Router();
disputesRouter.use(requireAdmin);
disputesRouter.use(requireCapability("disputes"));

const problemLabel = (code) => disputes.PROBLEMS.find((p) => p.code === code)?.label ?? code;
const num = (d) => Number(d);

async function filerHistory(userId) {
  if (!userId) return null;
  const [filed, lost] = await Promise.all([prisma.dispute.count({ where: { filedById: userId } }), prisma.dispute.count({ where: { loserId: userId } })]);
  // D32 and the research: repeat losing filers are flagged for the person ruling.
  const lostAsFiler = await prisma.dispute.count({ where: { filedById: userId, loserId: userId } });
  return { filed, lost, lostAsFiler, flagged: lostAsFiler >= 2 };
}

disputesRouter.get("/", async (req, res) => {
  const status = req.query.status === "handled" ? "handled" : "open";
  const rows = await prisma.dispute.findMany({
    where: status === "open" ? { status: "escalated" } : { status: "resolved", resolution: { path: ["by"], equals: "ruling" } },
    orderBy: status === "open" ? { escalatedAt: "asc" } : { resolvedAt: "desc" },
    take: 100,
    include: { ruling: true },
  });
  const jobs = await prisma.job.findMany({ where: { id: { in: rows.map((r) => r.jobId) } }, select: { id: true, title: true, budget: true, currency: true } });
  const byJob = new Map(jobs.map((j) => [j.id, j]));
  res.json({
    disputes: rows.map((d) => ({
      id: d.id,
      jobTitle: byJob.get(d.jobId)?.title ?? "Job",
      budget: num(byJob.get(d.jobId)?.budget ?? 0),
      currency: byJob.get(d.jobId)?.currency ?? "NGN",
      problem: problemLabel(d.problem),
      filedByRole: d.filedByRole,
      status: d.status,
      escalatedAt: d.escalatedAt,
      rulingDueAt: d.rulingDueAt,
      awaitingApproval: d.ruling?.status === "pending_approval",
      outcome: d.ruling?.status === "final" ? { outcome: d.ruling.outcome, talentPercent: d.ruling.talentPercent } : null,
    })),
  });
});

disputesRouter.get("/counts", async (req, res) => {
  res.json({ open: await prisma.dispute.count({ where: { status: "escalated" } }) });
});

disputesRouter.get("/:id", async (req, res) => {
  const d = await prisma.dispute.findUnique({ where: { id: req.params.id }, include: { proposals: { orderBy: { createdAt: "asc" } }, ruling: true } });
  if (!d) return res.status(404).json({ error: "Dispute not found." });
  const contract = await prisma.contract.findUnique({ where: { id: d.contractId }, include: { job: { include: { client: true } }, deliveries: { orderBy: { version: "asc" } }, changeRequests: { orderBy: { round: "asc" } }, extensions: { orderBy: { requestedAt: "asc" } }, drafts: { where: { status: "ready" }, orderBy: { createdAt: "asc" } } } });
  const application = contract.job.awardedApplicationId ? await prisma.application.findUnique({ where: { id: contract.job.awardedApplicationId }, include: { talent: true } }) : null;
  const talent = application?.talent ?? null;
  const client = contract.job.client;
  const held = settlement.heldOf(contract, contract.job);

  const conversation = talent ? await prisma.conversation.findUnique({ where: { clientId_talentId: { clientId: client.id, talentId: talent.id } } }) : null;
  const messages = conversation ? await prisma.message.findMany({ where: { conversationId: conversation.id, state: "sent" }, orderBy: { createdAt: "asc" }, take: 200 }) : [];
  const events = await prisma.contractEvent.findMany({ where: { jobId: contract.jobId }, orderBy: { createdAt: "asc" }, take: 200 });
  const proofItems = await prisma.startProofItem.findMany({ where: { contractId: contract.id, status: "ready" }, orderBy: { createdAt: "asc" } });

  const who = (id) => (id === client.id ? "Client" : id === talent?.id ? "Talent" : "Team");
  const person = async (u) =>
    u
      ? { id: u.id, name: u.fullName, legalName: u.legalName, email: u.email, address: [u.addressLine, u.addressCity, u.addressState].filter(Boolean).join(", ") || null, identityVerified: Boolean(u.identityVerifiedAt), history: await filerHistory(u.id) }
      : null;

  res.json({
    dispute: {
      id: d.id,
      status: d.status,
      problem: d.problem,
      problemLabel: problemLabel(d.problem),
      rule: disputes.PROBLEMS.find((p) => p.code === d.problem)?.rule ?? null,
      note: d.note,
      filedByRole: d.filedByRole,
      openedAt: d.createdAt,
      escalatedAt: d.escalatedAt,
      escalationReason: d.escalationReason,
      rulingDueAt: d.rulingDueAt,
      resolvedAt: d.resolvedAt,
      resolution: d.resolution,
    },
    ruling: d.ruling ? { outcome: d.ruling.outcome, talentPercent: d.ruling.talentPercent, reasons: d.ruling.reasons, talentAmount: num(d.ruling.talentAmount), clientRefund: num(d.ruling.clientRefund), status: d.ruling.status, decidedById: d.ruling.decidedById, approvedById: d.ruling.approvedById } : null,
    money: { held, currency: contract.job.currency, upfrontPaid: contract.upfrontPaidAt ? num(contract.upfrontAmount ?? 0) : 0, price: num(contract.job.budget), fee: num(contract.platformFeeAmount ?? 0), secondPersonAbove: disputes.SECOND_PERSON_ABOVE, needsSecondPerson: disputes.needsSecondPerson(held), settlement: contract.settlement ?? null },
    job: { id: contract.job.id, title: contract.job.title, description: contract.job.description, skill: contract.job.skillKey ? skillByKey(contract.job.skillKey)?.label ?? contract.job.skillKey : null, brief: contract.job.brief ?? null, briefLines: contract.job.skillKey ? describeBrief(contract.job.skillKey, contract.job.jobType, contract.job.brief) : [], deliveryDays: contract.job.deliveryDays, type: contract.job.jobType },
    contract: { id: contract.id, status: contract.status, fundedAt: contract.fundedAt, deliverByAt: contract.deliverByAt, changeRounds: contract.changeRounds, extensionsUsed: contract.extensionsUsed },
    parties: { client: await person(client), talent: await person(talent) },
    proposals: d.proposals.map((p) => ({ id: p.id, by: who(p.proposedById), kind: p.kind, description: disputes.describe(p.kind, p.params ?? {}, contract.job), note: p.note, status: p.status, createdAt: p.createdAt, answerDueAt: p.answerDueAt })),
    startProof: {
      status: contract.startProofStatus,
      objection: contract.startProofObjection,
      items: await Promise.all(proofItems.map(async (i) => ({ field: i.fieldKey, text: i.text, name: i.name, contentType: i.contentType, url: await sp.linkFor(i.objectKey) }))),
    },
    deliveries: await Promise.all(
      contract.deliveries.map(async (v) => ({ version: v.version, note: v.note, url: v.url, fileUrl: v.filePath ? await storage.getDeliverableFileSignedUrl(v.filePath).catch(() => null) : null, at: v.submittedAt })),
    ),
    drafts: await Promise.all(contract.drafts.map(async (dr) => ({ note: dr.note, at: dr.createdAt, files: await Promise.all((dr.files ?? []).map(async (f) => ({ name: f.name, contentType: f.contentType, url: await sp.linkFor(f.objectKey) }))) }))),
    changeRequests: contract.changeRequests.map((c) => ({ round: c.round, reason: c.reason, at: c.requestedAt, resubmittedAt: c.resubmittedAt })),
    extensions: contract.extensions.map((e) => ({ days: e.requestedDays, reason: e.reason, status: e.status, at: e.requestedAt })),
    conversation: messages.map((m) => ({ from: who(m.senderId), kind: m.kind, body: m.body, at: m.createdAt, attachment: m.attachmentName ?? null })),
    timeline: events.map((e) => ({ type: e.type, at: e.createdAt })),
  });
});

disputesRouter.post("/:id/rule", async (req, res) => {
  const r = await disputes.rule({ disputeId: req.params.id, adminId: req.admin.id, outcome: req.body?.outcome, talentPercent: req.body?.talentPercent, reasons: req.body?.reasons });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  await recordAudit(prisma, req.admin, {
    action: r.awaitingApproval ? "dispute.ruled_pending" : "dispute.ruled",
    subjectType: "Dispute",
    subjectId: req.params.id,
    reasonCode: req.body?.outcome,
    note: String(req.body?.reasons ?? "").slice(0, 600),
    details: { talentPercent: r.ruling.talentPercent, talentAmount: num(r.ruling.talentAmount), clientRefund: num(r.ruling.clientRefund) },
  });
  console.log(`disputes: ruled dispute=${req.params.id} by admin=${req.admin.id} awaitingApproval=${Boolean(r.awaitingApproval)} readBack.status=${(await prisma.dispute.findUnique({ where: { id: req.params.id }, select: { status: true } })).status}`);
  res.json({ ok: true, awaitingApproval: Boolean(r.awaitingApproval) });
});

disputesRouter.post("/:id/approve", async (req, res) => {
  const r = await disputes.approveRuling({ disputeId: req.params.id, adminId: req.admin.id });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  await recordAudit(prisma, req.admin, { action: "dispute.ruling_approved", subjectType: "Dispute", subjectId: req.params.id, reasonCode: r.ruling.outcome });
  res.json({ ok: true });
});

disputesRouter.post("/:id/send-back", async (req, res) => {
  const r = await disputes.sendBackRuling({ disputeId: req.params.id, adminId: req.admin.id });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  await recordAudit(prisma, req.admin, { action: "dispute.ruling_sent_back", subjectType: "Dispute", subjectId: req.params.id, note: String(req.body?.note ?? "").slice(0, 600) || null });
  res.json({ ok: true });
});

/** A final ruling whose money didn't move (a payout or refund error): try again. */
disputesRouter.post("/:id/retry", async (req, res) => {
  const r = await disputes.retryRuling({ disputeId: req.params.id });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  await recordAudit(prisma, req.admin, { action: "dispute.ruling_retried", subjectType: "Dispute", subjectId: req.params.id });
  res.json({ ok: true });
});

// ── Chargebacks ──────────────────────────────────────────

const chargebacksRouter = express.Router();
chargebacksRouter.use(requireAdmin);
chargebacksRouter.use(requireCapability("finance"));

chargebacksRouter.get("/", async (req, res) => {
  const status = req.query.status === "handled" ? "handled" : "open";
  const rows = await prisma.chargeback.findMany({ where: status === "open" ? { status: "open" } : { status: { not: "open" } }, orderBy: status === "open" ? { dueAt: "asc" } : { updatedAt: "desc" }, take: 100 });
  res.json({ chargebacks: rows.map((c) => ({ id: c.id, status: c.status, amount: c.amountKobo / 100, dueAt: c.dueAt, receivedAt: c.receivedAt, hasContract: Boolean(c.contractId), resolution: c.resolution })) });
});

chargebacksRouter.get("/counts", async (req, res) => {
  res.json({ open: await prisma.chargeback.count({ where: { status: "open" } }) });
});

chargebacksRouter.get("/:id", async (req, res) => {
  const ev = await chargebacks.evidenceFor(prisma, req.params.id);
  if (!ev) return res.status(404).json({ error: "Chargeback not found." });
  const cb = ev.chargeback;
  res.json({
    chargeback: { id: cb.id, status: cb.status, amount: cb.amountKobo / 100, dueAt: cb.dueAt, receivedAt: cb.receivedAt, reference: cb.reference, bin: cb.bin, last4: cb.last4, resolution: cb.resolution, responseNote: cb.responseNote, clientRemovedAt: cb.clientRemovedAt },
    receipt: { lines: ev.lines, ready: ev.ready, missing: ev.missing },
    job: ev.contract ? { id: ev.contract.job.id, title: ev.contract.job.title, status: ev.contract.status, paidOut: Boolean(ev.contract.transferredAt) } : null,
    client: ev.client ? { name: ev.client.legalName ?? ev.client.fullName, email: ev.client.email, identityVerified: Boolean(ev.client.identityVerifiedAt) } : null,
    talentPaid: Boolean(ev.contract?.transferredAt || ev.contract?.upfrontPaidAt),
  });
});

chargebacksRouter.post("/:id/respond", async (req, res) => {
  const r = await chargebacks.respond({ chargebackId: req.params.id, adminId: req.admin.id, note: req.body?.note });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  await recordAudit(prisma, req.admin, { action: "chargeback.contested", subjectType: "Chargeback", subjectId: req.params.id, note: String(req.body?.note ?? "").slice(0, 600) || null });
  res.json({ ok: true });
});

chargebacksRouter.post("/:id/accept", async (req, res) => {
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (note.length < 10) return res.status(400).json({ error: "Say why you are not contesting it, in at least 10 characters." });
  const r = await chargebacks.accept({ chargebackId: req.params.id, adminId: req.admin.id, note });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  await recordAudit(prisma, req.admin, { action: "chargeback.accepted", subjectType: "Chargeback", subjectId: req.params.id, note });
  res.json({ ok: true });
});

module.exports = { disputesRouter, chargebacksRouter };
