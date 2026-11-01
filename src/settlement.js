// Ending a contract with the money split between the two sides (PRD §4.9; D33 to D36): an agreed split or cancel, a
// ruling, or a cancel-for-refund when nothing came. Money moves exactly once.
//
// What is held is the price less any 20% already paid on the start proof. The talent's share is paid by transfer, the
// client's share goes back through Paystack's refund API. The 10% fee is never refunded (D35) and Paystack keeps its
// own charge on a refund. Like the other payouts: claim first, one reference per attempt, never start a second
// transfer on top of a live one, and record each leg as it lands so a retry resumes instead of repeating.
const { prisma: realPrisma } = require("./db");
const realPaystack = require("./paystack");
const { recordEvent } = require("./contractCore");

const CLAIM_STALE_MS = 10 * 60 * 1000;
const LIVE_TRANSFER_STATUSES = new Set(["success", "pending", "otp", "received"]);
/** Statuses in which the price is still held. */
const HELD_STATUSES = ["funded", "inProgress", "submitted", "changesRequested", "disputed"];

const round2 = (n) => Math.round(n * 100) / 100;
const fail = (status, code, error) => ({ ok: false, status, code, error });

/** The price still held: the budget less the 20% already paid to the talent. */
function heldOf(contract, job) {
  const paid = contract.upfrontPaidAt ? Number(contract.upfrontAmount ?? 0) : 0;
  return round2(Number(job.budget) - paid);
}

/** The talent's share and the client's refund for a percentage of what is held, to the kobo. */
function splitOf(held, talentPercent) {
  const talentAmount = round2((held * talentPercent) / 100);
  return { talentAmount, clientRefund: round2(held - talentAmount) };
}

async function findAttempt(paystack, contractId) {
  for (let n = 1; n <= 10; n++) {
    const reference = `kd_settle_${contractId}_${n}`;
    const existing = await paystack.verifyTransfer(reference);
    if (!existing || LIVE_TRANSFER_STATUSES.has(existing.status)) return { reference, existing };
  }
  throw new Error("Too many failed settlement payout attempts for this contract: check the Paystack dashboard.");
}

/**
 * Settles a contract: pays the talent talentPercent of what is held and refunds the client the rest.
 * kind: split | release | refund | cancelled_overdue. trigger: who or what caused it (for the log).
 */
async function settle({ contractId, talentPercent, kind, trigger, disputeId = null, by = null }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const paystack = deps.paystack ?? realPaystack;
  const now = deps.now ?? (() => new Date());

  if (!Number.isInteger(talentPercent) || talentPercent < 0 || talentPercent > 100) return fail(400, "invalid", "The talent's share must be a whole number from 0 to 100.");
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true } });
  if (!contract) return fail(404, "not_found", "Contract not found.");
  if (contract.settledAt) return { ok: true, contract, already: true };
  if (!HELD_STATUSES.includes(contract.status)) return fail(409, "not_held", "There is no money held on this contract to settle.");
  const progress = contract.settlement ?? {};
  if (progress.talentPercent !== undefined && progress.talentPercent !== talentPercent) {
    return fail(409, "settlement_started", "A different settlement already started on this contract. Finish that one.");
  }

  const held = heldOf(contract, contract.job);
  const { talentAmount, clientRefund } = splitOf(held, talentPercent);

  const claimedAt = now();
  const claim = await prisma.contract.updateMany({
    where: { id: contract.id, settledAt: null, status: { in: HELD_STATUSES }, OR: [{ settlementClaimedAt: null }, { settlementClaimedAt: { lte: new Date(claimedAt.getTime() - CLAIM_STALE_MS) } }] },
    data: { settlementClaimedAt: claimedAt },
  });
  console.log(`settle: claim contract=${contract.id} kind=${kind} trigger=${trigger} talentPercent=${talentPercent} held=${held} claimed=${claim.count === 1} previousClaim=${contract.settlementClaimedAt?.toISOString() ?? "none"}`);
  if (claim.count === 0) return fail(409, "settlement_in_progress", "The money is already being moved. Refresh in a moment.");

  const save = async (patch) => {
    Object.assign(progress, patch);
    await prisma.contract.updateMany({ where: { id: contract.id, settlementClaimedAt: claimedAt }, data: { settlement: progress } });
  };
  const unclaim = () => prisma.contract.updateMany({ where: { id: contract.id, settlementClaimedAt: claimedAt }, data: { settlementClaimedAt: null } });

  await save({ kind, trigger, talentPercent, held, talentAmount, clientRefund, disputeId, by, startedAt: progress.startedAt ?? claimedAt.toISOString() });

  // The talent's share.
  if (talentAmount > 0 && !progress.talentPaidAt) {
    const application = contract.job.awardedApplicationId ? await prisma.application.findUnique({ where: { id: contract.job.awardedApplicationId } }) : null;
    const profile = application ? await prisma.talentProfile.findUnique({ where: { userId: application.talentId } }) : null;
    if (!profile?.paystackRecipientCode) {
      await unclaim();
      return fail(400, "no_payout_account", "The talent hasn't set up a payout bank account, so their share can't be sent yet.");
    }
    let attempt;
    let transfer;
    try {
      attempt = await findAttempt(paystack, contract.id);
      transfer = attempt.existing ?? (await paystack.initiateTransfer({ amountNaira: talentAmount, recipientCode: profile.paystackRecipientCode, reference: attempt.reference, reason: `Settlement for "${contract.job.title}"` }));
    } catch (err) {
      await unclaim();
      return fail(502, "transfer_error", err.message || "Could not send the talent's share right now.");
    }
    console.log(`settle: talent leg contract=${contract.id} amount=${talentAmount} reference=${attempt.reference} reused=${Boolean(attempt.existing)} transfer=${transfer.transferCode} status=${transfer.status}`);
    if (transfer.status !== "success" && transfer.status !== "pending") {
      console.error(`settle: PAYOUT NOT SENT: ${attempt.reference} status=${transfer.status} contract=${contract.id}`);
      await unclaim();
      return fail(502, "transfer_failed", "The talent's share couldn't be sent right now. Please try again shortly.");
    }
    await save({ talentTransferCode: transfer.transferCode, talentPaidAt: now().toISOString() });
  }

  // The client's refund.
  if (clientRefund > 0 && !progress.refundId) {
    const reference = contract.paystackReference;
    if (!reference) {
      await unclaim();
      return fail(409, "no_payment", "There is no payment on record to refund.");
    }
    let refund;
    try {
      const wantKobo = Math.round(clientRefund * 100);
      const existing = (await paystack.listRefunds(reference)).find((r) => r.amountKobo === wantKobo && !["failed", "reversed"].includes(r.status));
      refund = existing ?? (await paystack.createRefund({ reference, amountNaira: clientRefund, customerNote: `Refund for "${contract.job.title}"`, merchantNote: `${kind} ${contract.id}` }));
      console.log(`settle: refund leg contract=${contract.id} amount=${clientRefund} reference=${reference} reused=${Boolean(existing)} refund=${refund.id} status=${refund.status}`);
    } catch (err) {
      await unclaim();
      return fail(502, "refund_error", err.message || "Could not start the refund right now.");
    }
    await save({ refundId: refund.id, refundStatus: refund.status, refundedAt: now().toISOString() });
  }

  const at = now();
  await prisma.contract.updateMany({
    where: { id: contract.id, settledAt: null },
    data: { status: "resolved", settledAt: at, disputeHoldAt: null, reviewDueAt: null, changeDueAt: null, settlement: progress, settlementClaimedAt: null },
  });
  const updated = await prisma.contract.findUnique({ where: { id: contract.id } });
  await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "settled", meta: { kind, trigger, talentPercent, talentAmount, clientRefund, disputeId } });
  console.log(`settle: done contract=${contract.id} readBack.status=${updated.status} readBack.settledAt=${updated.settledAt?.toISOString() ?? "NOT SET"} talent=${talentAmount} refund=${clientRefund}`);
  return { ok: true, contract: updated, talentAmount, clientRefund };
}

module.exports = { settle, heldOf, splitOf, HELD_STATUSES, round2 };
