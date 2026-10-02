// Delivery versions and change rounds — stage 2 of "How a job gets paid"
// (docs/features/stage-2-delivery-and-changes.md in the mobile repo). Every
// delivery is an immutable ContractDelivery row; the contract's deliverable*
// fields only mirror the latest one for the apps.
const { RULES, baseDeps, recordEvent, refuse, validReason, parties } = require("./contractCore");

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
  // The client's app opens this link, so only web links get through.
  if (cleanUrl && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(cleanUrl)) {
    return refuse(400, "bad_link", "The link must be a web address starting with https://.");
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

/**
 * The client sends delivered work back. After the last round there is no
 * further round: the same action escalates to an admin. Conditional on no
 * payout being in flight (releaseClaimedAt), so changes can never be
 * requested on work whose payment has already left.
 */
async function requestChanges({ contractId, clientId, reason }, deps) {
  const { prisma, mailer, now } = baseDeps(deps);
  const at = now();
  if (!validReason(reason)) {
    return refuse(400, "bad_reason", `Explain what needs changing in ${RULES.reasonLength.min} to ${RULES.reasonLength.max} characters.`);
  }
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true } });
  if (!contract) return refuse(404, "not_found", "Contract not found.");
  if (contract.status !== "submitted") return refuse(400, "not_submitted", "Changes can only be requested on delivered work.");

  if (contract.changeRounds >= RULES.maxChangeRounds) {
    return escalateContract(prisma, mailer, {
      contract,
      from: "submitted",
      reason: "client_rejected_after_final_round",
      note: reason.trim(),
      by: clientId,
      at,
    });
  }

  const round = contract.changeRounds + 1;
  const resubmitDueAt = new Date(at.getTime() + RULES.changeResubmitMs);
  const committed = await prisma.$transaction(async (trx) => {
    const { count } = await trx.contract.updateMany({
      where: { id: contract.id, status: "submitted", changeRounds: contract.changeRounds, releaseClaimedAt: null },
      data: { status: "changesRequested", changeRounds: round, changeDueAt: resubmitDueAt, reviewDueAt: null },
    });
    if (count === 0) return false;
    await trx.changeRequest.create({
      data: { contractId: contract.id, round, reason: reason.trim(), requestedAt: at, resubmitDueAt },
    });
    await recordEvent(trx, { jobId: contract.jobId, contractId: contract.id, type: "changes_requested", meta: { round, resubmitDueAt } });
    return true;
  });
  console.log(`changes: request contract=${contract.id} round=${round} roundsBefore=${contract.changeRounds} committed=${committed}`);
  if (!committed) {
    return refuse(409, "conflict", "This delivery just changed (it may have been approved or paid). Refresh and try again.");
  }

  const { talent } = await parties(prisma, contract);
  if (talent) {
    mailer
      .sendChangesRequested({
        to: talent.email,
        jobTitle: contract.job.title,
        round,
        maxRounds: RULES.maxChangeRounds,
        reason: reason.trim(),
        resubmitDueAt,
      })
      .catch((err) => console.error("changes: failed to email the talent:", err));
  }
  return { ok: true, escalated: false, contract: await prisma.contract.findUnique({ where: { id: contract.id } }) };
}

/**
 * Parks a contract as `disputed` for an admin (stage 3 resolves it). From
 * `submitted` it is conditional on no payout in flight; from
 * `changesRequested` it is conditional on the resubmit clock having run out,
 * so a resubmission that commits first wins.
 */
async function escalateContract(prisma, mailer, { contract, from, reason, note, by, at }) {
  const guard = from === "submitted" ? { releaseClaimedAt: null } : { changeDueAt: { lte: at } };
  const committed = await prisma.$transaction(async (trx) => {
    const { count } = await trx.contract.updateMany({
      where: { id: contract.id, status: from, ...guard },
      data: { status: "disputed", reviewDueAt: null, changeDueAt: null },
    });
    if (count === 0) return false;
    await recordEvent(trx, {
      jobId: contract.jobId,
      contractId: contract.id,
      type: "escalated",
      meta: { reason, note: note ?? null, by: by ?? null, round: contract.changeRounds },
    });
    return true;
  });
  console.log(`changes: escalate contract=${contract.id} from=${from} reason=${reason} committed=${committed}`);
  if (!committed) return refuse(409, "conflict", "This contract just changed. Refresh and try again.");

  console.error(`DISPUTE NEEDS ADMIN contract=${contract.id} job=${contract.jobId} reason=${reason}`);
  const { job, client, talent } = await parties(prisma, contract);
  const owners = await prisma.adminUser.findMany({ where: { role: "owner", status: "active" } });
  await Promise.allSettled([
    client ? mailer.sendEscalated({ to: client.email, jobTitle: job.title, reason }) : null,
    talent ? mailer.sendEscalated({ to: talent.email, jobTitle: job.title, reason }) : null,
    ...owners.map((a) => mailer.sendEscalationToAdmin({ to: a.email, jobTitle: job.title, contractId: contract.id, reason, note })),
  ]);
  return { ok: true, escalated: true, contract: await prisma.contract.findUnique({ where: { id: contract.id } }) };
}

/** Tick: a talent who didn't resubmit within 3 days goes to an admin. */
async function sweepChanges(deps) {
  const { prisma, mailer, now } = baseDeps(deps);
  const at = now();
  const due = await prisma.contract.findMany({
    where: { status: "changesRequested", changeDueAt: { lte: at } },
    include: { job: true },
  });
  let escalated = 0;
  for (const contract of due) {
    const r = await escalateContract(prisma, mailer, { contract, from: "changesRequested", reason: "talent_missed_change_deadline", at });
    if (r.ok) escalated++;
  }
  return { escalated };
}

module.exports = { submitDelivery, requestChanges, escalateContract, sweepChanges };
