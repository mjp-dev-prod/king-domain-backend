// Delivery versions and change rounds — stage 2 of "How a job gets paid"
// (docs/features/stage-2-delivery-and-changes.md in the mobile repo). Every
// delivery is an immutable ContractDelivery row; the contract's deliverable*
// fields only mirror the latest one for the apps.
const { RULES, baseDeps, recordEvent, refuse } = require("./contractCore");

const DELIVERABLE_STATUSES = ["inProgress", "changesRequested"];

/**
 * The talent delivers (first time, or after a change request). The status
 * update is the commit point — conditional on the status we read — so two
 * simultaneous deliveries, or a delivery racing the escalation sweep,
 * resolve to exactly one winner.
 */
async function submitDelivery({ contractId, note, url, filePath }, deps) {
  const { prisma, now } = baseDeps(deps);
  const at = now();
  const cleanNote = typeof note === "string" && note.trim() ? note.trim() : null;
  const cleanUrl = typeof url === "string" && url.trim() ? url.trim() : null;
  if (!cleanNote && !cleanUrl && !filePath) {
    return refuse(400, "empty_delivery", "Add a note, a link or a file to deliver.");
  }

  const contract = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!contract) return refuse(404, "not_found", "Contract not found.");
  if (!DELIVERABLE_STATUSES.includes(contract.status)) {
    return refuse(400, "not_deliverable", `Work can't be delivered while the contract is '${contract.status}'.`);
  }
  const resubmission = contract.status === "changesRequested";
  const reviewDueAt = new Date(at.getTime() + RULES.reviewMs);

  const version = await prisma.$transaction(async (trx) => {
    const { count } = await trx.contract.updateMany({
      where: { id: contract.id, status: contract.status },
      data: {
        status: "submitted",
        deliverableNote: cleanNote,
        deliverableUrl: cleanUrl,
        deliverableFilePath: filePath ?? null,
        submittedAt: at,
        reviewDueAt,
        changeDueAt: null,
        autoReleaseAttempts: 0,
        lastAutoReleaseAttemptAt: null,
      },
    });
    if (count === 0) return null;
    const next = (await trx.contractDelivery.count({ where: { contractId: contract.id } })) + 1;
    await trx.contractDelivery.create({
      data: { contractId: contract.id, version: next, note: cleanNote, url: cleanUrl, filePath: filePath ?? null, submittedAt: at },
    });
    // Delivering makes an open extension request moot.
    await trx.contractExtension.updateMany({
      where: { contractId: contract.id, status: "pending" },
      data: { status: "withdrawn", resolvedAt: at },
    });
    if (resubmission) {
      await trx.changeRequest.updateMany({
        where: { contractId: contract.id, round: contract.changeRounds, resubmittedAt: null },
        data: { resubmittedAt: at },
      });
    }
    await recordEvent(trx, {
      jobId: contract.jobId,
      contractId: contract.id,
      type: resubmission ? "resubmitted" : "submitted",
      meta: { version: next, reviewDueAt, hasFile: Boolean(filePath), hasLink: Boolean(cleanUrl) },
    });
    return next;
  });

  console.log(
    `delivery: contract=${contract.id} from=${contract.status} committed=${version !== null} version=${version ?? "-"} reviewDueAt=${reviewDueAt.toISOString()}`,
  );
  if (version === null) return refuse(409, "conflict", "This contract just changed. Refresh and try again.");
  return { ok: true, contract: await prisma.contract.findUnique({ where: { id: contract.id } }), version, resubmission };
}

module.exports = { submitDelivery };
