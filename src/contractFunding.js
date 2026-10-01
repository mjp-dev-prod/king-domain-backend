// The single place a contract moves awaitingPayment -> funded. Both the
// Paystack webhook and the app's verify-payment call land here, so the
// idempotency and amount checks can't drift apart between the two paths.
const { prisma } = require("./db");
const { fromKobo } = require("./paystack");

// References are minted as kd_<contractId>_<8 hex> in jobsRoutes.js's
// /contract/fund. Each retry of "Pay" mints a new reference and overwrites
// Contract.paystackReference, so a payment completed on an *earlier*
// checkout (a slow bank transfer, say) would never match by reference
// alone. The contract id embedded in the reference still identifies it.
const REFERENCE_PATTERN = /^kd_([0-9a-f-]{36})_[0-9a-f]{8}$/;

function contractIdFromReference(reference) {
  return REFERENCE_PATTERN.exec(reference ?? "")?.[1] ?? null;
}

/**
 * Returns { outcome, contract } where outcome is one of:
 * "funded" | "alreadyFunded" | "amountMismatch" | "notOurs".
 * amountKobo is what Paystack says was actually paid, never what we asked for.
 */
async function confirmFunding({ reference, amountKobo, source }) {
  const contract =
    (await prisma.contract.findUnique({ where: { paystackReference: reference }, include: { job: true } })) ??
    (contractIdFromReference(reference)
      ? await prisma.contract.findUnique({ where: { id: contractIdFromReference(reference) }, include: { job: true } })
      : null);

  if (!contract) {
    // A payment landing after the 24h window cancelled the award (a slow
    // transfer that settled late): the money is in our balance but the
    // contract is gone. Never drop it silently — leave a record and an alarm
    // so it gets refunded by hand until refunds are built.
    const cancelledId = contractIdFromReference(reference);
    const voided = cancelledId
      ? await prisma.contractEvent.findFirst({ where: { contractId: cancelledId, type: "award_voided" } })
      : null;
    if (voided) {
      console.error(
        `contractFunding[${source}]: ORPHAN PAYMENT needs manual refund — reference=${reference} ` +
          `paid=${fromKobo(amountKobo)} contract=${cancelledId} job=${voided.jobId} (award was cancelled unpaid)`,
      );
      await prisma.contractEvent.create({
        data: { jobId: voided.jobId, contractId: cancelledId, type: "late_payment_after_void", meta: { reference, amountKobo, source } },
      });
      return { outcome: "orphanPayment", contract: null };
    }
    console.warn(`contractFunding[${source}]: no contract for reference=${reference}`);
    return { outcome: "notOurs", contract: null };
  }

  const paid = fromKobo(amountKobo);
  const expected = Number(contract.job.budget) + Number(contract.platformFeeAmount);
  console.log(
    `contractFunding[${source}]: contract=${contract.id} status=${contract.status} ` +
      `reference=${reference} storedReference=${contract.paystackReference} paid=${paid} expected=${expected}`,
  );

  if (contract.status !== "awaitingPayment") {
    if (reference !== contract.paystackReference) {
      // A second, separate successful charge for a contract that's already
      // funded — the client has paid twice. Nothing refunds this
      // automatically yet; it must be refunded by hand from the Paystack
      // dashboard.
      console.error(
        `contractFunding[${source}]: DUPLICATE PAYMENT needs manual refund — contract=${contract.id} ` +
          `reference=${reference} (funded via ${contract.paystackReference}) amount=${paid}`,
      );
    }
    return { outcome: "alreadyFunded", contract };
  }

  if (Math.abs(paid - expected) > 0.01) {
    console.error(`contractFunding[${source}]: amount mismatch contract=${contract.id} paid=${paid} expected=${expected}`);
    return { outcome: "amountMismatch", contract };
  }

  const { count } = await prisma.contract.updateMany({
    where: { id: contract.id, status: "awaitingPayment" },
    data: { status: "funded", fundedAt: new Date(), paystackReference: reference, paymentFailed: false },
  });
  const readBack = await prisma.contract.findUnique({ where: { id: contract.id } });
  console.log(`contractFunding[${source}]: updated=${count} readBackStatus=${readBack.status} contract=${contract.id}`);

  return { outcome: count === 1 ? "funded" : "alreadyFunded", contract: readBack };
}

module.exports = { confirmFunding, contractIdFromReference };
