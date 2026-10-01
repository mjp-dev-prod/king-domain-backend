// The delivery date — extensions (stage 2 of "How a job gets paid") and the
// overdue flag. Decided 2026-10-01: a talent may make 2 requests (a declined
// one counts), one open at a time, each up to the job's original duration;
// the client has 48 h to answer and silence grants it (as on Fiverr).
const { DAY, RULES, baseDeps, recordEvent, refuse, validReason, parties } = require("./contractCore");

const OPEN_STATUSES = ["funded", "inProgress"];

async function requestExtension({ contractId, days, reason }, deps) {
  const { prisma, mailer, now } = baseDeps(deps);
  const at = now();
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true } });
  if (!contract) return refuse(404, "not_found", "Contract not found.");
  if (!OPEN_STATUSES.includes(contract.status)) {
    return refuse(400, "not_open", "Extensions can only be requested before the work is delivered.");
  }
  if (!contract.deliverByAt || !contract.job.deliveryDays) {
    return refuse(400, "no_delivery_date", "This job has no delivery date to extend.");
  }
  if (contract.overdueFlaggedAt || at.getTime() >= contract.deliverByAt.getTime() + RULES.overdueGraceMs) {
    return refuse(400, "too_late", "It's more than 3 days past the delivery date, so an extension can no longer be requested.");
  }
  if (!Number.isInteger(days) || days < 1 || days > contract.job.deliveryDays) {
    return refuse(400, "bad_days", `Ask for 1 to ${contract.job.deliveryDays} extra days (up to the job's original duration).`);
  }
  if (!validReason(reason)) {
    return refuse(400, "bad_reason", `Explain the delay in ${RULES.reasonLength.min} to ${RULES.reasonLength.max} characters.`);
  }
  if (contract.extensionsUsed >= RULES.maxExtensionRequests) {
    return refuse(400, "no_requests_left", "You've used both extension requests on this job.");
  }
  if (await prisma.contractExtension.findFirst({ where: { contractId, status: "pending" } })) {
    return refuse(409, "already_pending", "An extension request is already waiting for the client's answer.");
  }

  const answerDueAt = new Date(at.getTime() + RULES.extensionAnswerMs);
  const extension = await prisma.$transaction(async (trx) => {
    // Compare-and-swap on the request count: two simultaneous requests read
    // the same count, and only one of them can move it.
    const { count } = await trx.contract.updateMany({
      where: { id: contract.id, extensionsUsed: contract.extensionsUsed, status: { in: OPEN_STATUSES } },
      data: { extensionsUsed: { increment: 1 } },
    });
    if (count === 0) return null;
    const created = await trx.contractExtension.create({
      data: { contractId: contract.id, requestedDays: days, reason: reason.trim(), requestedAt: at, answerDueAt },
    });
    await recordEvent(trx, {
      jobId: contract.jobId,
      contractId: contract.id,
      type: "extension_requested",
      meta: { extensionId: created.id, days, answerDueAt, deliverByAt: contract.deliverByAt },
    });
    return created;
  });
  console.log(
    `extension: request contract=${contract.id} days=${days} usedBefore=${contract.extensionsUsed} committed=${Boolean(extension)}`,
  );
  if (!extension) return refuse(409, "conflict", "This contract just changed. Refresh and try again.");

  const { client } = await parties(prisma, contract);
  if (client) {
    mailer
      .sendExtensionRequested({
        to: client.email,
        jobTitle: contract.job.title,
        days,
        reason: extension.reason,
        proposedDeliverBy: new Date(contract.deliverByAt.getTime() + days * DAY),
        answerDueAt,
      })
      .catch((err) => console.error("extension: failed to email the client:", err));
  }
  return { ok: true, extension };
}

/** Adds the extension's days to the delivery date; clears an overdue flag the new date makes stale. */
async function applyGrant(trx, extension, at) {
  const contract = await trx.contract.findUnique({ where: { id: extension.contractId } });
  const deliverByAt = new Date(contract.deliverByAt.getTime() + extension.requestedDays * DAY);
  const stillOverdue = deliverByAt.getTime() + RULES.overdueGraceMs <= at.getTime();
  await trx.contract.update({
    where: { id: contract.id },
    data: { deliverByAt, overdueFlaggedAt: stillOverdue ? contract.overdueFlaggedAt : null },
  });
  return deliverByAt;
}

/**
 * The client grants or declines. No time check: an answer that reaches the
 * server before the tick has auto-granted stands, even a little past 48 h.
 */
async function answerExtension({ contractId, extensionId, clientId, grant }, deps) {
  const { prisma, mailer, now } = baseDeps(deps);
  const at = now();
  const extension = await prisma.contractExtension.findUnique({
    where: { id: extensionId },
    include: { contract: { include: { job: true } } },
  });
  if (!extension || extension.contractId !== contractId) return refuse(404, "not_found", "Extension request not found.");

  const deliverByAt = await prisma.$transaction(async (trx) => {
    const { count } = await trx.contractExtension.updateMany({
      where: { id: extension.id, status: "pending" },
      data: { status: grant ? "granted" : "declined", resolvedAt: at, resolvedById: clientId },
    });
    if (count === 0) return null;
    const date = grant ? await applyGrant(trx, extension, at) : extension.contract.deliverByAt;
    await recordEvent(trx, {
      jobId: extension.contract.jobId,
      contractId,
      type: grant ? "extension_granted" : "extension_declined",
      meta: { extensionId, deliverByAt: date },
    });
    return date;
  });
  console.log(`extension: answer ${extensionId} contract=${contractId} grant=${grant} committed=${Boolean(deliverByAt)}`);
  if (!deliverByAt) {
    return refuse(409, "already_answered", "That request has already been answered (it may have been granted automatically after 48 hours).");
  }

  const { talent } = await parties(prisma, extension.contract);
  if (talent) {
    mailer
      .sendExtensionAnswered({ to: talent.email, jobTitle: extension.contract.job.title, outcome: grant ? "granted" : "declined", deliverByAt })
      .catch((err) => console.error("extension: failed to email the talent:", err));
  }
  return { ok: true, deliverByAt, contract: await prisma.contract.findUnique({ where: { id: contractId } }) };
}

/** Tick: grant every request the client left unanswered for 48 h. */
async function sweepExtensions(deps) {
  const { prisma, mailer, now } = baseDeps(deps);
  const at = now();
  const due = await prisma.contract.findMany({
    where: { extensions: { some: { status: "pending", answerDueAt: { lte: at } } } },
    select: { id: true },
  });
  let autoGranted = 0;
  for (const { id } of due) {
    const extension = await prisma.contractExtension.findFirst({
      where: { contractId: id, status: "pending", answerDueAt: { lte: at } },
      include: { contract: { include: { job: true } } },
    });
    if (!extension) continue;
    const deliverByAt = await prisma.$transaction(async (trx) => {
      const { count } = await trx.contractExtension.updateMany({
        where: { id: extension.id, status: "pending" },
        data: { status: "autoGranted", resolvedAt: at },
      });
      if (count === 0) return null;
      const date = await applyGrant(trx, extension, at);
      await recordEvent(trx, {
        jobId: extension.contract.jobId,
        contractId: id,
        type: "extension_auto_granted",
        meta: { extensionId: extension.id, answerDueAt: extension.answerDueAt, deliverByAt: date },
      });
      return date;
    });
    console.log(
      `extension: auto-grant ${extension.id} contract=${id} answerDueAt=${extension.answerDueAt.toISOString()} now=${at.toISOString()} committed=${Boolean(deliverByAt)}`,
    );
    if (!deliverByAt) continue;
    autoGranted++;
    const { client, talent } = await parties(prisma, extension.contract);
    const jobTitle = extension.contract.job.title;
    await Promise.allSettled([
      talent ? mailer.sendExtensionAnswered({ to: talent.email, jobTitle, outcome: "autoGranted", deliverByAt }) : null,
      client ? mailer.sendExtensionAutoGrantedToClient({ to: client.email, jobTitle, deliverByAt }) : null,
    ]);
  }
  return { autoGranted };
}

module.exports = { requestExtension, answerExtension, sweepExtensions };
