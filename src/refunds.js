// What Paystack says happened to a refund we started (refund.processed / refund.failed). The refund leg of a settlement
// is recorded as soon as Paystack queues it; this keeps the contract's record true afterwards, and shouts when a refund
// fails: the client is owed that money and the account is credited back, so someone has to look.
const { prisma: realPrisma } = require("./db");

async function record(event, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const d = event.data ?? {};
  const refundId = d.id;
  if (refundId == null) return { ok: false };
  const contract = await prisma.contract.findFirst({ where: { settlement: { path: ["refundId"], equals: refundId } } });
  const status = event.event === "refund.processed" ? "processed" : "failed";
  if (!contract) {
    console.error(`refund: ${event.event} for refund ${refundId} matched no contract (amount=${d.amount} transaction=${d.transaction?.reference ?? d.transaction})`);
    return { ok: false };
  }
  const settlement = { ...(contract.settlement ?? {}), refundStatus: status, refundStatusAt: new Date().toISOString() };
  await prisma.contract.update({ where: { id: contract.id }, data: { settlement } });
  console.log(`refund: ${status} refund=${refundId} contract=${contract.id} readBack.refundStatus=${(await prisma.contract.findUnique({ where: { id: contract.id } })).settlement?.refundStatus}`);
  if (status === "failed") {
    try {
      await require("./alerts").raiseAlert(prisma, { severity: "urgent", queueKey: "dispute", title: "A refund failed", body: `Paystack could not refund ₦${Number(settlement.clientRefund ?? 0).toLocaleString("en-NG")} to a client. The money is back in our balance and is still owed to them. Refund id ${refundId}.`, link: null }, deps);
    } catch (err) {
      console.error(`refund: could not alert the team: ${err.message}`);
    }
  }
  return { ok: true, status };
}

module.exports = { record };
