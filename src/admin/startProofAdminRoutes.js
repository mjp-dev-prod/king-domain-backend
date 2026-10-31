// The team's queue of start-proof objections (PRD §4.2; D8). A client may object to a start proof only from a
// checklist, and a person checks the proof against the skill's required format. Quality is never grounds: either the
// proof meets the format (the objection is dismissed and the 20% is paid) or it doesn't (it goes back to be redone).
const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const { requireCapability } = require("./capabilities");
const { recordAudit } = require("./audit");
const sp = require("../startProof");

const router = express.Router();
router.use(requireAdmin);
router.use(requireCapability("disputes"));

const ALREADY = "Someone else just ruled on this one. Refresh the list.";

router.get("/", async (req, res) => {
  const handled = req.query.status === "handled";
  const rows = await prisma.contract.findMany({
    where: handled ? { startProofObjection: { not: null }, startProofStatus: { in: ["redo", "accepted", "submitted"] } } : { startProofStatus: "objected" },
    orderBy: { updatedAt: handled ? "desc" : "asc" },
    take: 100,
    include: { job: { select: { id: true, title: true, skillKey: true, budget: true, currency: true } } },
  });
  res.json({
    startProofs: rows.map((c) => ({
      contractId: c.id,
      jobTitle: c.job.title,
      skillKey: c.job.skillKey,
      status: c.startProofStatus,
      round: c.startProofRound,
      objection: c.startProofObjection,
      budget: Number(c.job.budget),
      currency: c.job.currency,
    })),
  });
});

router.get("/counts", async (req, res) => {
  res.json({ open: await prisma.contract.count({ where: { startProofStatus: "objected" } }) });
});

router.get("/:contractId", async (req, res) => {
  const c = await prisma.contract.findUnique({ where: { id: req.params.contractId }, include: { job: { include: { client: { select: { id: true, fullName: true, email: true } } } } } });
  if (!c || !c.startProofStatus) return res.status(404).json({ error: "Start proof not found." });
  const application = c.job.awardedApplicationId ? await prisma.application.findUnique({ where: { id: c.job.awardedApplicationId }, include: { talent: { select: { id: true, fullName: true, email: true } } } }) : null;
  const items = await prisma.startProofItem.findMany({ where: { contractId: c.id, round: c.startProofRound, status: "ready" }, orderBy: { createdAt: "asc" } });
  const check = sp.checkProof(c.job.skillKey, items);
  const fields = await Promise.all(
    sp.specFor(c.job.skillKey).map(async (f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      min: f.min,
      max: f.max,
      items: await Promise.all(items.filter((i) => i.fieldKey === f.key).map(async (i) => ({ id: i.id, text: i.text, name: i.name, contentType: i.contentType, sizeBytes: i.sizeBytes, url: await sp.linkFor(i.objectKey) }))),
    })),
  );
  res.json({
    startProof: { contractId: c.id, status: c.startProofStatus, round: c.startProofRound, submittedAt: c.startProofSubmittedAt, objection: c.startProofObjection, upfrontAmount: sp.upfrontAmountOf(c.job.budget), currency: c.job.currency, jobTitle: c.job.title, jobId: c.job.id },
    fields,
    checklist: { meetsFormat: check.ok, missing: check.missing },
    parties: { client: c.job.client, talent: application?.talent ?? null },
  });
});

router.post("/:contractId/resolve", async (req, res) => {
  const decision = req.body?.decision;
  if (!["uphold", "dismiss"].includes(decision)) return res.status(400).json({ error: "Choose uphold or dismiss." });
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 600) : "";
  if (note.length < 10) return res.status(400).json({ error: "Say what you checked, in at least 10 characters." });
  const before = await prisma.contract.findUnique({ where: { id: req.params.contractId }, select: { startProofStatus: true, startProofObjection: true } });
  if (!before || before.startProofStatus !== "objected") return res.status(409).json({ error: ALREADY });

  const r = await sp.resolveObjection({ contractId: req.params.contractId, decision });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  await recordAudit(prisma, req.admin, {
    action: `startProof.${decision === "uphold" ? "upheld" : "dismissed"}`,
    subjectType: "Contract",
    subjectId: req.params.contractId,
    reasonCode: before.startProofObjection?.reasonCode ?? null,
    note,
    details: { decision },
  });
  const after = await prisma.contract.findUnique({ where: { id: req.params.contractId }, select: { startProofStatus: true, upfrontPaidAt: true } });
  console.log(`start-proofs: ${decision} contract=${req.params.contractId} by admin=${req.admin.id} readBack.status=${after.startProofStatus} upfrontPaid=${Boolean(after.upfrontPaidAt)}`);
  res.json({ ok: true, status: after.startProofStatus });
});

module.exports = { router };
