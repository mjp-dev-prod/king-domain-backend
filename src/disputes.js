// "Something's wrong" (PRD §3.3, §4.9; D33, D34, D35). A staircase, not a court:
//   1. the person says what is wrong and sees the rule that applies;
//   2. either side offers a fixed way out: more time, one more revision, a split, a cancel, or carry on. The other side
//      has 48 hours to answer; silence moves it up;
//   3. either side can escalate at any point, and some things escalate by themselves (a refused change round 3, a
//      missed resubmit clock, an unanswered offer). King Domain then rules within 5 days, free, with written
//      reasons, and the ruling is final.
// While a dispute is open every clock that would pay, escalate or grant on silence waits (Contract.disputeHoldAt).
const { prisma: realPrisma } = require("./db");
const { HOUR, DAY, RULES, recordEvent } = require("./contractCore");
const settlement = require("./settlement");
const { reopenFailedJob } = require("./reopen");

const PROPOSAL_ANSWER_MS = 48 * HOUR;
const RULING_MS = 5 * DAY;
const MAX_PROPOSALS = 6;
/** Manual money above this needs a second person (D44). */
const SECOND_PERSON_ABOVE = 100000;
const FILING_STATUSES = ["funded", "inProgress", "submitted", "changesRequested", "disputed"];

/** What can be wrong. `sides` says who may pick it; the rest is plain words for the app and the case screen. */
const PROBLEMS = [
  { code: "not_delivered", label: "The work wasn't delivered", sides: ["client"], rule: "Three days past the delivery date with nothing delivered and no extension, you can cancel for a full refund of what is held. Before that, ask for the work or agree more time." },
  { code: "not_as_briefed", label: "It isn't what the brief said", sides: ["client"], rule: "The work is judged against the brief: what was asked for, in what format, with how many revisions. Two rounds of changes are included." },
  { code: "quality", label: "The quality isn't what was agreed", sides: ["client"], rule: "Quality is judged against what the brief asked for. If it is a matter of skill, a reviewer who practises it helps the team decide." },
  { code: "other_side_silent", label: "The other person has gone quiet", sides: ["client", "talent"], rule: "Nobody has to answer at once, but clocks run: delivery dates, a 3-day review, and 3 days to resubmit changes." },
  { code: "wants_more", label: "The client wants more than was agreed", sides: ["talent"], rule: "The brief is the agreement. Two rounds of changes are included; more than the brief asked for is a new job." },
  { code: "payment_problem", label: "There's a problem with the payment", sides: ["client", "talent"], rule: "The price is held by King Domain until the work is approved. The 10% fee is never refunded." },
  { code: "changes_not_resolved", label: "Changes weren't resolved after two rounds", sides: [], rule: "After two rounds of changes the team decides." },
  { code: "resubmit_missed", label: "The resubmit time ran out", sides: [], rule: "A talent has 3 days to resubmit after changes are asked for. After that the team decides." },
];

/** The fixed ways out (D33). */
const WAYS = [
  { kind: "more_time", label: "More time", needs: "days" },
  { kind: "extra_revision", label: "One more revision", needs: null },
  { kind: "split", label: "Split what is held", needs: "talentPercent" },
  { kind: "cancel", label: "Cancel and refund what is held", needs: null },
  { kind: "carry_on", label: "Carry on as it is", needs: null },
];

const fail = (status, code, error) => ({ ok: false, status, code, error });
const money = (n) => `₦${Number(n).toLocaleString("en-NG")}`;

async function notify(userId, message) {
  if (!userId) return;
  try {
    await require("./discovery").notify(userId, message);
  } catch {
    // A push is a courtesy; the record is kept either way.
  }
}

/** Who is who on a contract. */
async function sides(prisma, contract) {
  const job = contract.job ?? (await prisma.job.findUnique({ where: { id: contract.jobId } }));
  const application = job.awardedApplicationId ? await prisma.application.findUnique({ where: { id: job.awardedApplicationId } }) : null;
  return { job, clientId: job.clientId, talentId: application?.talentId ?? null };
}

const roleOf = (s, userId) => (userId === s.clientId ? "client" : userId === s.talentId ? "talent" : null);
const otherOf = (s, userId) => (userId === s.clientId ? s.talentId : s.clientId);

/** After a dispute ends without the money moving, the clocks start again from now so nobody is punished for the pause. */
async function resumeClocks(prisma, contract, at) {
  const data = { disputeHoldAt: null };
  if (contract.status === "submitted") data.reviewDueAt = new Date(at.getTime() + RULES.reviewMs);
  if (contract.status === "changesRequested") data.changeDueAt = new Date(at.getTime() + RULES.changeResubmitMs);
  if (["funded", "inProgress"].includes(contract.status)) {
    const floor = new Date(at.getTime() + DAY);
    if (!contract.deliverByAt || contract.deliverByAt < floor) data.deliverByAt = floor;
    data.overdueFlaggedAt = null;
  }
  await prisma.contract.update({ where: { id: contract.id }, data });
}

// ── Opening ─────────────────────────────────────────────

async function openDispute({ contractId, userId, problem, note }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? (() => new Date());
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true } });
  if (!contract) return fail(404, "not_found", "Contract not found.");
  const s = await sides(prisma, contract);
  const role = roleOf(s, userId);
  if (!role) return fail(404, "not_found", "Contract not found.");
  const p = PROBLEMS.find((x) => x.code === problem && x.sides.includes(role));
  if (!p) return fail(400, "invalid", "Choose what is wrong.");
  if (!FILING_STATUSES.includes(contract.status)) return fail(409, "wrong_status", contract.status === "awaitingPayment" ? "Nothing is wrong yet: the job hasn't been paid for." : "This job has already ended.");
  if (typeof note !== "string" || note.trim().length < 10) return fail(400, "invalid", "Say what happened, in at least 10 characters.");

  const existing = await prisma.dispute.findFirst({ where: { contractId, status: { in: ["open", "escalated"] } } });
  if (existing) return fail(409, "already_open", "There is already a dispute open on this job.");

  const at = now();
  const dispute = await prisma.$transaction(async (trx) => {
    const d = await trx.dispute.create({ data: { contractId, jobId: contract.jobId, filedById: userId, filedByRole: role, problem: p.code, note: note.trim().slice(0, 1000) } });
    await trx.contract.update({ where: { id: contractId }, data: { disputeHoldAt: at } });
    await recordEvent(trx, { jobId: contract.jobId, contractId, type: "disputeOpened", meta: { disputeId: d.id, by: role, problem: p.code } });
    return d;
  });
  console.log(`dispute: opened dispute=${dispute.id} contract=${contractId} by=${role} problem=${p.code} readBack.hold=${(await prisma.contract.findUnique({ where: { id: contractId } })).disputeHoldAt?.toISOString() ?? "NOT SET"}`);
  await notify(otherOf(s, userId), { title: "Something's wrong on a job", body: `${contract.job.title}: ${p.label}. Open the job to respond.`, data: { type: "dispute", jobId: contract.jobId } });
  return { ok: true, dispute };
}

/**
 * The team's case, opened by the system when a contract is parked as disputed (a refused third round of changes, or a
 * missed resubmit clock). It starts already escalated, but the two sides can still agree a way out.
 */
async function openSystemDispute({ contractId, reason }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? (() => new Date());
  const existing = await prisma.dispute.findFirst({ where: { contractId, status: { in: ["open", "escalated"] } } });
  if (existing) return existing.status === "open" ? escalate({ disputeId: existing.id, userId: null, reason: "system" }, deps).then((r) => r.dispute ?? existing) : existing;
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true } });
  if (!contract) return null;
  const at = now();
  const problem = reason === "talent_missed_change_deadline" ? "resubmit_missed" : "changes_not_resolved";
  const dispute = await prisma.dispute.create({
    data: { contractId, jobId: contract.jobId, filedById: null, filedByRole: "system", problem, status: "escalated", escalatedAt: at, escalationReason: "system", rulingDueAt: new Date(at.getTime() + RULING_MS) },
  });
  await prisma.contract.update({ where: { id: contractId }, data: { disputeHoldAt: at } });
  console.log(`dispute: system dispute=${dispute.id} contract=${contractId} problem=${problem} rulingDueAt=${dispute.rulingDueAt.toISOString()}`);
  await alertTeam(dispute, contract, deps);
  return dispute;
}

// ── Ways out ────────────────────────────────────────────

function validateParams(kind, params, job) {
  if (kind === "more_time") {
    const days = Number(params?.days);
    const max = job.deliveryDays ?? RULES.deliveryDays.max;
    if (!Number.isInteger(days) || days < 1 || days > max) return { error: `Ask for 1 to ${max} more days.` };
    return { params: { days } };
  }
  if (kind === "split") {
    const pct = Number(params?.talentPercent);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) return { error: "The talent's share must be a whole number from 0 to 100." };
    return { params: { talentPercent: pct } };
  }
  return { params: {} };
}

async function propose({ disputeId, userId, kind, params, note }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? (() => new Date());
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId }, include: { proposals: true, ruling: true } });
  if (!dispute) return fail(404, "not_found", "Dispute not found.");
  const contract = await prisma.contract.findUnique({ where: { id: dispute.contractId }, include: { job: true } });
  const s = await sides(prisma, contract);
  const role = roleOf(s, userId);
  if (!role) return fail(404, "not_found", "Dispute not found.");
  if (!["open", "escalated"].includes(dispute.status)) return fail(409, "closed", "This dispute has ended.");
  if (dispute.ruling) return fail(409, "ruled", "The team is about to rule on this one.");
  if (!WAYS.some((w) => w.kind === kind)) return fail(400, "invalid", "Choose one of the ways out.");
  if (dispute.proposals.some((p) => p.status === "pending")) return fail(409, "pending_exists", "There is already an offer waiting for an answer.");
  if (dispute.proposals.length >= MAX_PROPOSALS) return fail(409, "too_many", "That's enough offers back and forth. Ask the team to decide.");
  if (kind === "extra_revision" && !["submitted", "changesRequested", "disputed"].includes(contract.status)) return fail(400, "not_applicable", "A revision only makes sense once work has been delivered.");
  if (kind === "more_time" && !["funded", "inProgress", "changesRequested", "disputed"].includes(contract.status)) return fail(400, "not_applicable", "More time doesn't apply once the work has been delivered.");
  const checked = validateParams(kind, params, contract.job);
  if (checked.error) return fail(400, "invalid", checked.error);

  const at = now();
  const proposal = await prisma.disputeProposal.create({
    data: { disputeId, proposedById: userId, kind, params: checked.params, note: typeof note === "string" ? note.trim().slice(0, 500) : "", answerDueAt: new Date(at.getTime() + PROPOSAL_ANSWER_MS) },
  });
  await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "disputeProposal", meta: { disputeId, proposalId: proposal.id, kind, by: role } });
  await notify(otherOf(s, userId), { title: "An offer to settle", body: `${contract.job.title}: ${describe(kind, checked.params, contract.job)}. Answer within 48 hours.`, data: { type: "dispute", jobId: contract.jobId } });
  console.log(`dispute: proposal=${proposal.id} dispute=${disputeId} kind=${kind} by=${role} answerDueAt=${proposal.answerDueAt.toISOString()}`);
  return { ok: true, proposal };
}

function describe(kind, params, job) {
  switch (kind) {
    case "more_time":
      return `${params.days} more day${params.days === 1 ? "" : "s"}`;
    case "extra_revision":
      return "one more round of changes";
    case "split":
      return `split what is held: ${params.talentPercent}% to the talent, ${100 - params.talentPercent}% back to the client`;
    case "cancel":
      return "cancel and refund what is held";
    default:
      return "carry on as it is";
  }
}

/** Accept or decline. Accepting takes effect at once: clocks move, or the money moves. */
async function answer({ proposalId, userId, decision }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? (() => new Date());
  if (!["accept", "decline"].includes(decision)) return fail(400, "invalid", "Accept or decline.");
  const proposal = await prisma.disputeProposal.findUnique({ where: { id: proposalId }, include: { dispute: true } });
  if (!proposal) return fail(404, "not_found", "Offer not found.");
  const contract = await prisma.contract.findUnique({ where: { id: proposal.dispute.contractId }, include: { job: true } });
  const s = await sides(prisma, contract);
  const role = roleOf(s, userId);
  if (!role) return fail(404, "not_found", "Offer not found.");
  if (proposal.proposedById === userId) return fail(403, "own_offer", "You can't answer your own offer.");
  if (proposal.status !== "pending" || proposal.answerDueAt <= now()) return fail(409, "not_pending", "This offer is no longer open.");

  const at = now();
  const done = await prisma.disputeProposal.updateMany({ where: { id: proposalId, status: "pending" }, data: { status: decision === "accept" ? "accepted" : "declined", answeredAt: at } });
  if (done.count !== 1) return fail(409, "not_pending", "This offer was just answered.");
  await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "disputeAnswer", meta: { disputeId: proposal.disputeId, proposalId, decision, by: role } });

  if (decision === "decline") {
    await notify(proposal.proposedById, { title: "Your offer was declined", body: `${contract.job.title}: you can offer something else, or ask the team to decide.`, data: { type: "dispute", jobId: contract.jobId } });
    return { ok: true, resolved: false };
  }

  const applied = await applyAccepted(prisma, contract, proposal, deps, at);
  if (applied.ok === false) {
    // The money couldn't move: put the offer back so it can be accepted again once it can.
    await prisma.disputeProposal.updateMany({ where: { id: proposalId }, data: { status: "pending", answeredAt: null } });
    return applied;
  }
  await prisma.dispute.update({ where: { id: proposal.disputeId }, data: { status: "resolved", resolvedAt: at, resolution: { by: "agreement", kind: proposal.kind, ...proposal.params, ...(applied.settled ? { talentPercent: applied.talentPercent } : {}) } } });
  await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "disputeResolved", meta: { disputeId: proposal.disputeId, by: "agreement", kind: proposal.kind } });
  await notify(proposal.proposedById, { title: "Your offer was accepted", body: `${contract.job.title}: ${describe(proposal.kind, proposal.params ?? {}, contract.job)}.`, data: { type: "dispute", jobId: contract.jobId } });
  console.log(`dispute: resolved by agreement dispute=${proposal.disputeId} kind=${proposal.kind}`);
  return { ok: true, resolved: true };
}

async function applyAccepted(prisma, contract, proposal, deps, at) {
  const params = proposal.params ?? {};
  switch (proposal.kind) {
    case "more_time": {
      const days = params.days * DAY;
      if (contract.status === "changesRequested" || contract.status === "disputed") {
        await prisma.contract.update({ where: { id: contract.id }, data: { status: "changesRequested", changeDueAt: new Date(at.getTime() + days), disputeHoldAt: null } });
      } else {
        const base = contract.deliverByAt && contract.deliverByAt > at ? contract.deliverByAt : at;
        await prisma.contract.update({ where: { id: contract.id }, data: { deliverByAt: new Date(base.getTime() + days), overdueFlaggedAt: null, disputeHoldAt: null } });
      }
      return { ok: true };
    }
    case "extra_revision": {
      const rounds = Math.max(0, (contract.changeRounds ?? 0) - 1);
      if (contract.status === "submitted") {
        await prisma.contract.update({ where: { id: contract.id }, data: { changeRounds: rounds, reviewDueAt: new Date(at.getTime() + RULES.reviewMs), disputeHoldAt: null } });
      } else {
        await prisma.contract.update({ where: { id: contract.id }, data: { status: "changesRequested", changeRounds: rounds, changeDueAt: new Date(at.getTime() + RULES.changeResubmitMs), disputeHoldAt: null } });
      }
      return { ok: true };
    }
    case "split":
    case "cancel": {
      const pct = proposal.kind === "cancel" ? 0 : params.talentPercent;
      const r = await finishWithMoney({ prisma, contract, talentPercent: pct, kind: proposal.kind === "cancel" ? "cancel_agreed" : "split_agreed", trigger: "agreement", disputeId: proposal.disputeId, deps });
      return r.ok === false ? r : { ok: true, settled: true, talentPercent: pct };
    }
    default:
      await resumeClocks(prisma, contract, at);
      return { ok: true };
  }
}

/** Moves the money, then tells both people and reopens the job if the talent got nothing. */
async function finishWithMoney({ prisma, contract, talentPercent, kind, trigger, disputeId, by, deps }) {
  const r = await settlement.settle({ contractId: contract.id, talentPercent, kind, trigger, disputeId, by }, deps);
  if (r.ok === false) return r;
  const s = await sides(prisma, contract);
  if (!r.already) {
    const title = contract.job?.title ?? "your job";
    await notify(s.talentId, { title: "The job was settled", body: `${title}: ${money(r.talentAmount)} is on its way to you.`, data: { type: "dispute", jobId: contract.jobId } });
    await notify(s.clientId, { title: "The job was settled", body: `${title}: ${money(r.clientRefund)} is being refunded to you. Refunds can take 3 to 10 working days to show.`, data: { type: "dispute", jobId: contract.jobId } });
    if (talentPercent === 0) {
      await reopenFailedJob({ jobId: contract.jobId, failedTalentId: s.talentId, contractId: contract.id }, deps).catch((e) => console.error(`dispute: could not reopen job ${contract.jobId}: ${e.message}`));
    }
  }
  return r;
}

// ── Escalating, ruling ──────────────────────────────────

async function alertTeam(dispute, contract, deps) {
  try {
    const alerts = require("./alerts");
    await alerts.raiseAlert(deps.prisma ?? realPrisma, {
      severity: "urgent",
      queueKey: "dispute",
      title: "A dispute needs a ruling",
      body: `A job is with the team to decide, within 5 days. Held: ${money(settlement.heldOf(contract, contract.job ?? { budget: 0 }))}.`,
      link: `/disputes/${dispute.id}`,
    });
  } catch (err) {
    console.error(`dispute: could not alert the team: ${err.message}`);
  }
}

async function escalate({ disputeId, userId, reason }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? (() => new Date());
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!dispute) return fail(404, "not_found", "Dispute not found.");
  const contract = await prisma.contract.findUnique({ where: { id: dispute.contractId }, include: { job: true } });
  const s = await sides(prisma, contract);
  if (userId && !roleOf(s, userId)) return fail(404, "not_found", "Dispute not found.");
  if (dispute.status === "escalated") return { ok: true, dispute, already: true };
  if (dispute.status !== "open") return fail(409, "closed", "This dispute has ended.");
  const at = now();
  const done = await prisma.dispute.updateMany({ where: { id: disputeId, status: "open" }, data: { status: "escalated", escalatedAt: at, escalatedById: userId ?? null, escalationReason: reason ?? "requested", rulingDueAt: new Date(at.getTime() + RULING_MS) } });
  if (done.count !== 1) return fail(409, "closed", "This dispute just changed. Refresh.");
  // Offers still waiting are closed: the team decides now.
  await prisma.disputeProposal.updateMany({ where: { disputeId, status: "pending" }, data: { status: "expired", answeredAt: at } });
  const updated = await prisma.dispute.findUnique({ where: { id: disputeId } });
  await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "disputeEscalated", meta: { disputeId, reason: reason ?? "requested" } });
  console.log(`dispute: escalated dispute=${disputeId} reason=${reason ?? "requested"} rulingDueAt=${updated.rulingDueAt.toISOString()}`);
  const msg = { title: "Sent to our team", body: `${contract.job.title}: the team will decide within 5 days. It's free and the decision is final.`, data: { type: "dispute", jobId: contract.jobId } };
  await Promise.all([notify(s.clientId, msg), notify(s.talentId, msg)]);
  await alertTeam(updated, contract, deps);
  return { ok: true, dispute: updated };
}

/** Whether a ruling on this much needs a second person. */
const needsSecondPerson = (held) => held > SECOND_PERSON_ABOVE;

/**
 * The team rules. outcome: release (all to the talent), refund (all back to the client) or split. Reasons must cite the
 * brief and the evidence, in the person's own words. Above ₦100,000 the ruling waits for a second person (D44).
 */
async function rule({ disputeId, adminId, outcome, talentPercent, reasons }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId }, include: { ruling: true } });
  if (!dispute) return fail(404, "not_found", "Dispute not found.");
  if (dispute.status !== "escalated") return fail(409, "not_escalated", dispute.status === "resolved" ? "Someone else just ruled on this one." : "This one hasn't reached the team: the two sides can still agree a way out.");
  if (dispute.ruling) return fail(409, "already_ruled", "A ruling is already waiting for approval.");
  if (!["release", "refund", "split"].includes(outcome)) return fail(400, "invalid", "Choose release, refund or split.");
  const pct = outcome === "release" ? 100 : outcome === "refund" ? 0 : Number(talentPercent);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100 || (outcome === "split" && (pct === 0 || pct === 100))) return fail(400, "invalid", "A split gives the talent a share between 1 and 99%.");
  const text = typeof reasons === "string" ? reasons.trim() : "";
  if (text.length < 80) return fail(400, "invalid", "Write the reasons so both people can follow them: what the brief asked for, what the evidence shows, why this share. At least 80 characters.");

  const contract = await prisma.contract.findUnique({ where: { id: dispute.contractId }, include: { job: true } });
  const held = settlement.heldOf(contract, contract.job);
  const { talentAmount, clientRefund } = settlement.splitOf(held, pct);
  const second = needsSecondPerson(held);
  const row = await prisma.disputeRuling.create({
    data: { disputeId, decidedById: adminId, outcome, talentPercent: pct, reasons: text, talentAmount, clientRefund, status: second ? "pending_approval" : "final" },
  });
  if (second) {
    console.log(`dispute: ruling waits for a second person dispute=${disputeId} held=${held} by=${adminId}`);
    return { ok: true, ruling: row, awaitingApproval: true };
  }
  return execute({ dispute, ruling: row, contract, deps });
}

/** A different person approves a ruling that moves more than ₦100,000. */
async function approveRuling({ disputeId, adminId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId }, include: { ruling: true } });
  if (!dispute?.ruling) return fail(404, "not_found", "There is no ruling waiting.");
  if (dispute.ruling.status !== "pending_approval") return fail(409, "not_pending", "This ruling was already approved.");
  if (dispute.ruling.decidedById === adminId) return fail(403, "same_person", "A different person has to approve this: it moves more than ₦100,000.");
  const contract = await prisma.contract.findUnique({ where: { id: dispute.contractId }, include: { job: true } });
  const ruling = await prisma.disputeRuling.update({ where: { id: dispute.ruling.id }, data: { status: "final", approvedById: adminId, approvedAt: new Date() } });
  return execute({ dispute, ruling, contract, deps });
}

/** The second person sends it back: the ruling is removed and the case is open for a new one. */
async function sendBackRuling({ disputeId, adminId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId }, include: { ruling: true } });
  if (!dispute?.ruling || dispute.ruling.status !== "pending_approval") return fail(409, "not_pending", "There is no ruling waiting for approval.");
  await prisma.disputeRuling.delete({ where: { id: dispute.ruling.id } });
  console.log(`dispute: ruling sent back dispute=${disputeId} by=${adminId}`);
  return { ok: true };
}

async function execute({ dispute, ruling, contract, deps }) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? (() => new Date());
  const kind = ruling.outcome === "release" ? "release" : ruling.outcome === "refund" ? "refund" : "split";
  const r = await finishWithMoney({ prisma, contract, talentPercent: ruling.talentPercent, kind, trigger: "ruling", disputeId: dispute.id, by: ruling.decidedById, deps });
  if (r.ok === false) {
    // The ruling stands but the money did not move: keep it final so a retry from the case screen resumes it.
    return { ...r, ruling };
  }
  const s = await sides(prisma, contract);
  const loserId = ruling.talentPercent < 50 ? s.talentId : ruling.talentPercent > 50 ? s.clientId : null;
  await prisma.dispute.update({
    where: { id: dispute.id },
    data: { status: "resolved", resolvedAt: now(), loserId, resolution: { by: "ruling", kind: ruling.outcome, talentPercent: ruling.talentPercent } },
  });
  await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "disputeResolved", meta: { disputeId: dispute.id, by: "ruling", outcome: ruling.outcome, talentPercent: ruling.talentPercent } });
  console.log(`dispute: ruled dispute=${dispute.id} outcome=${ruling.outcome} talentPercent=${ruling.talentPercent} loser=${loserId ?? "none"}`);
  return { ok: true, ruling, contract: r.contract };
}

/** A final ruling whose money didn't move: run it again (the settlement resumes where it stopped). */
async function retryRuling({ disputeId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId }, include: { ruling: true } });
  if (!dispute?.ruling || dispute.ruling.status !== 'final') return fail(409, 'not_final', 'There is no final ruling to retry.');
  if (dispute.status === 'resolved') return fail(409, 'done', 'The money already moved.');
  const contract = await prisma.contract.findUnique({ where: { id: dispute.contractId }, include: { job: true } });
  return execute({ dispute, ruling: dispute.ruling, contract, deps });
}

// ── Cancel for a refund (nothing came) ───────────────────

/**
 * Three days past the delivery date with nothing delivered and no extension waiting, the client may cancel for a full
 * refund of what is held. If the start proof was accepted the 20% is already the talent's and is not refunded (D35).
 */
async function cancelForRefund({ contractId, userId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? (() => new Date());
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true, extensions: true, deliveries: true } });
  if (!contract) return fail(404, "not_found", "Contract not found.");
  if (contract.job.clientId !== userId) return fail(403, "not_client", "Only the client can cancel.");
  if (!["funded", "inProgress"].includes(contract.status)) return fail(409, "wrong_status", "You can cancel only while nothing has been delivered.");
  if (contract.disputeHoldAt) return fail(409, "dispute_open", "There is a dispute open on this job. Settle it there.");
  if (contract.deliveries.length > 0 || contract.submittedAt) return fail(409, "delivered", "Something was delivered, so this isn't a no-show. Use Something's wrong.");
  if (contract.extensions.some((e) => e.status === "pending")) return fail(409, "extension_pending", "There's an extension request waiting for your answer.");
  if (!contract.deliverByAt || now() < new Date(contract.deliverByAt.getTime() + RULES.overdueGraceMs)) return fail(409, "too_early", "You can cancel for a refund 3 days after the delivery date if nothing has been delivered.");
  const s = await sides(prisma, contract);
  const r = await finishWithMoney({ prisma, contract, talentPercent: 0, kind: "cancelled_overdue", trigger: "client_cancel", by: userId, deps });
  return r;
}

// ── Silence moves it up ──────────────────────────────────

/** Tick: an offer nobody answered in 48 hours expires, and the dispute goes to the team. */
async function sweepDisputes(deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const at = (deps.now ?? (() => new Date()))();
  const due = await prisma.disputeProposal.findMany({ where: { status: "pending", answerDueAt: { lte: at } }, select: { id: true, disputeId: true } });
  let escalated = 0;
  for (const p of due) {
    const done = await prisma.disputeProposal.updateMany({ where: { id: p.id, status: "pending" }, data: { status: "expired", answeredAt: at } });
    if (done.count !== 1) continue;
    const r = await escalate({ disputeId: p.disputeId, userId: null, reason: "unanswered" }, deps).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) escalated++;
    else console.error(`dispute: could not escalate dispute=${p.disputeId} after an unanswered offer: ${r.error ?? r.code}`);
  }
  return { disputesEscalated: escalated };
}

module.exports = {
  PROBLEMS,
  WAYS,
  PROPOSAL_ANSWER_MS,
  RULING_MS,
  MAX_PROPOSALS,
  SECOND_PERSON_ABOVE,
  openDispute,
  openSystemDispute,
  propose,
  answer,
  escalate,
  rule,
  approveRuling,
  sendBackRuling,
  cancelForRefund,
  sweepDisputes,
  retryRuling,
  needsSecondPerson,
  describe,
  sides,
  roleOf,
};
