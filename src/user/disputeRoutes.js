// "Something's wrong" for the two people on a job (PRD §3.3), plus cancel-for-refund and the address a King Domain agent
// can follow up on (D35). Mounted at /jobs, next to the other contract routes.
const express = require("express");
const { prisma } = require("../db");
const { requireUser } = require("./routes");
const { rateLimit } = require("../admin/rateLimit");
const disputes = require("../disputes");
const settlement = require("../settlement");
const { RULES } = require("../contractCore");

const router = express.Router();
const rootRouter = express.Router();
router.use(requireUser);

async function loadContract(req, res, next) {
  const job = await prisma.job.findUnique({ where: { id: req.params.id }, include: { contract: true } });
  if (!job || !job.contract) return res.status(404).json({ error: "Contract not found." });
  const application = job.awardedApplicationId ? await prisma.application.findUnique({ where: { id: job.awardedApplicationId } }) : null;
  req.job = job;
  req.contract = job.contract;
  req.isClient = job.clientId === req.user.id;
  req.isTalent = application?.talentId === req.user.id;
  if (!req.isClient && !req.isTalent) return res.status(404).json({ error: "Contract not found." });
  req.role = req.isClient ? "client" : "talent";
  next();
}

const wayLabel = (kind) => disputes.WAYS.find((w) => w.kind === kind)?.label ?? kind;
const problemOf = (code) => disputes.PROBLEMS.find((p) => p.code === code);

async function view(req) {
  const { job, contract, role } = req;
  const latest =
    (await prisma.dispute.findFirst({ where: { contractId: contract.id, status: { in: ["open", "escalated"] } }, include: { proposals: { orderBy: { createdAt: "asc" } }, ruling: true } })) ??
    (await prisma.dispute.findFirst({ where: { contractId: contract.id }, orderBy: { createdAt: "desc" }, include: { proposals: { orderBy: { createdAt: "asc" } }, ruling: true } }));

  const held = settlement.heldOf(contract, job);
  const overdueCancelAt = contract.deliverByAt ? new Date(contract.deliverByAt.getTime() + RULES.overdueGraceMs) : null;
  const delivered = (await prisma.contractDelivery.count({ where: { contractId: contract.id } })) > 0;
  const pendingExtension = (await prisma.contractExtension.count({ where: { contractId: contract.id, status: "pending" } })) > 0;
  const canCancel = req.isClient && ["funded", "inProgress"].includes(contract.status) && !contract.disputeHoldAt && !delivered && !pendingExtension && overdueCancelAt !== null && new Date() >= overdueCancelAt;

  let dispute = null;
  if (latest) {
    const p = problemOf(latest.problem);
    const ruling = latest.ruling && latest.ruling.status === "final" ? latest.ruling : null;
    dispute = {
      id: latest.id,
      status: latest.status,
      problem: latest.problem,
      problemLabel: p?.label ?? latest.problem,
      rule: p?.rule ?? null,
      note: latest.note,
      filedByRole: latest.filedByRole,
      filedByMe: latest.filedById === req.user.id,
      openedAt: latest.createdAt,
      escalatedAt: latest.escalatedAt,
      escalationReason: latest.escalationReason,
      rulingDueAt: latest.rulingDueAt,
      resolvedAt: latest.resolvedAt,
      resolution: latest.resolution,
      awaitingApproval: Boolean(latest.ruling && latest.ruling.status === "pending_approval"),
      ruling: ruling
        ? { outcome: ruling.outcome, talentPercent: ruling.talentPercent, reasons: ruling.reasons, talentAmount: Number(ruling.talentAmount), clientRefund: Number(ruling.clientRefund), decidedAt: ruling.approvedAt ?? ruling.createdAt }
        : null,
      proposals: latest.proposals.map((x) => ({
        id: x.id,
        kind: x.kind,
        label: wayLabel(x.kind),
        description: disputes.describe(x.kind, x.params ?? {}, job),
        params: x.params,
        note: x.note,
        status: x.status,
        byMe: x.proposedById === req.user.id,
        answerDueAt: x.answerDueAt,
        createdAt: x.createdAt,
      })),
    };
  }

  const open = latest && ["open", "escalated"].includes(latest.status);
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { addressLine: true, addressCity: true } });
  return {
    role,
    dispute,
    problems: disputes.PROBLEMS.filter((p) => p.sides.includes(role)).map((p) => ({ code: p.code, label: p.label, rule: p.rule })),
    ways: disputes.WAYS.filter((w) => !(w.kind === "extra_revision" && !["submitted", "changesRequested", "disputed"].includes(contract.status)) && !(w.kind === "more_time" && !["funded", "inProgress", "changesRequested", "disputed"].includes(contract.status))).map((w) => ({ kind: w.kind, label: w.label, needs: w.needs })),
    canFile: !open && disputes.PROBLEMS.some((p) => p.sides.includes(role)) && ["funded", "inProgress", "submitted", "changesRequested", "disputed"].includes(contract.status),
    held,
    heldNote: contract.upfrontPaidAt ? "The first 20% was already paid to the talent for the start proof and is not part of this." : null,
    canCancelForRefund: canCancel,
    cancelFrom: overdueCancelAt,
    maxMoreDays: job.deliveryDays ?? RULES.deliveryDays.max,
    hasAddress: Boolean(user?.addressLine && user?.addressCity),
  };
}

router.get("/:id/contract/dispute", loadContract, async (req, res) => res.json(await view(req)));

const limiter = rateLimit({ windowMs: 3600_000, max: 40, key: "dispute_action", by: (r) => r.user.id });

const reply = (res, r, ok) => (r.ok === false ? res.status(r.status).json({ error: r.error, code: r.code }) : ok(r));

router.post("/:id/contract/dispute", loadContract, limiter, async (req, res) => {
  const r = await disputes.openDispute({ contractId: req.contract.id, userId: req.user.id, problem: req.body?.problem, note: req.body?.note });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  req.contract = await prisma.contract.findUnique({ where: { id: req.contract.id } });
  res.status(201).json(await view(req));
});

router.post("/:id/contract/dispute/proposals", loadContract, limiter, async (req, res) => {
  const d = await prisma.dispute.findFirst({ where: { contractId: req.contract.id, status: { in: ["open", "escalated"] } } });
  if (!d) return res.status(404).json({ error: "There is no dispute open on this job.", code: "no_dispute" });
  const r = await disputes.propose({ disputeId: d.id, userId: req.user.id, kind: req.body?.kind, params: req.body?.params, note: req.body?.note });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  res.status(201).json(await view(req));
});

router.post("/:id/contract/dispute/proposals/:proposalId/answer", loadContract, limiter, async (req, res) => {
  const p = await prisma.disputeProposal.findFirst({ where: { id: req.params.proposalId, dispute: { contractId: req.contract.id } } });
  if (!p) return res.status(404).json({ error: "Offer not found." });
  const r = await disputes.answer({ proposalId: p.id, userId: req.user.id, decision: req.body?.decision });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  req.contract = await prisma.contract.findUnique({ where: { id: req.contract.id } });
  res.json(await view(req));
});

router.post("/:id/contract/dispute/escalate", loadContract, limiter, async (req, res) => {
  const d = await prisma.dispute.findFirst({ where: { contractId: req.contract.id, status: { in: ["open", "escalated"] } } });
  if (!d) return res.status(404).json({ error: "There is no dispute open on this job.", code: "no_dispute" });
  const r = await disputes.escalate({ disputeId: d.id, userId: req.user.id, reason: "requested" });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  res.json(await view(req));
});

/** Three days past the delivery date with nothing delivered: cancel for a refund of what is held. */
router.post("/:id/contract/cancel", loadContract, limiter, async (req, res) => {
  if (!req.isClient) return res.status(403).json({ error: "Only the client can cancel.", code: "not_client" });
  const r = await disputes.cancelForRefund({ contractId: req.contract.id, userId: req.user.id });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  req.contract = await prisma.contract.findUnique({ where: { id: req.contract.id } });
  res.json({ cancelled: true, refund: r.clientRefund, ...(await view(req)) });
});

// ── Where a King Domain agent can reach a person (D35) ───

const PURPOSE =
  "We ask for this so that, if something serious goes wrong on a job and a ruling can't settle it, a King Domain agent can follow it up with you in person. It is kept private, shown only to the team handling a case, and you can change or remove it here at any time.";

rootRouter.get("/users/me/address", requireUser, async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.user.id }, select: { addressLine: true, addressCity: true, addressState: true, addressConfirmedAt: true } });
  res.json({ address: { line: u.addressLine ?? "", city: u.addressCity ?? "", state: u.addressState ?? "", confirmedAt: u.addressConfirmedAt }, purpose: PURPOSE });
});

rootRouter.put("/users/me/address", requireUser, async (req, res) => {
  const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const line = clean(req.body?.line, 200);
  const city = clean(req.body?.city, 80);
  const state = clean(req.body?.state, 80);
  if (line.length < 5) return res.status(400).json({ error: "Write the street and house number.", field: "line" });
  if (city.length < 2) return res.status(400).json({ error: "Write the town or city.", field: "city" });
  if (state.length < 2) return res.status(400).json({ error: "Write the state.", field: "state" });
  await prisma.user.update({ where: { id: req.user.id }, data: { addressLine: line, addressCity: city, addressState: state, addressConfirmedAt: new Date() } });
  console.log(`address: saved user=${req.user.id} readBack.city=${(await prisma.user.findUnique({ where: { id: req.user.id }, select: { addressCity: true } })).addressCity}`);
  res.json({ address: { line, city, state }, purpose: PURPOSE });
});

module.exports = { router, rootRouter };
