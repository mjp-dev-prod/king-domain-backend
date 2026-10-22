// A job before it has a contract: edit it until someone applies, close it,
// apply to it, award it. Design: docs/features/work-gaps-applications-stepper-job-edit.md
// in the mobile repo.
//
// Every guard here is ONE conditional UPDATE on the job row. Concurrent
// requests queue on that row's lock and re-check its columns once they get it,
// so "no edit after the first applicant", "no application after a close" and
// "no award after a close" hold without raw SQL or serializable transactions.
const { RULES, baseDeps, refuse } = require("./contractCore");
const paystack = require("./paystack");
const lifecycle = require("./contractLifecycle");

const jobInclude = { client: true, contract: true, _count: { select: { applications: true } } };
const loadJob = (prisma, id) => prisma.job.findUnique({ where: { id }, include: jobInclude });

const MSG = {
  closed: "This job has been closed.",
  awarded: "This job has already been awarded.",
  awardedEdit: "This job has already been awarded, so it can't be changed.",
  locked: "Someone has already applied, so the terms are locked. Close this job and post a new one to change them.",
};

/** The fields a client sets when posting or editing a job, checked and trimmed. */
function validateJobInput(body) {
  const { title, category, description, budget, deliveryDays } = body ?? {};
  if (typeof title !== "string" || !title.trim()) return refuse(400, "invalid", "title is required.");
  if (typeof category !== "string" || !category.trim()) return refuse(400, "invalid", "category is required.");
  if (typeof description !== "string" || !description.trim()) return refuse(400, "invalid", "description is required.");
  const budgetNum = Number(budget);
  if (!Number.isFinite(budgetNum) || budgetNum <= 0) return refuse(400, "invalid", "budget must be a positive number.");
  const days = Number(deliveryDays);
  if (!Number.isInteger(days) || days < RULES.deliveryDays.min || days > RULES.deliveryDays.max) {
    return refuse(400, "invalid", `deliveryDays must be a whole number of days from ${RULES.deliveryDays.min} to ${RULES.deliveryDays.max}.`);
  }
  return { ok: true, value: { title: title.trim(), category: category.trim(), description: description.trim(), budget: budgetNum, deliveryDays: days } };
}

/** Why a guarded update touched nothing, from the row as it is now. Null when the row is open. */
async function stateRefusal(prisma, jobId, { editing }) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return refuse(404, "not_found", "Job not found.");
  if (job.closedAt) return refuse(409, "closed", MSG.closed);
  if (job.awardedApplicationId) return refuse(409, "awarded", editing ? MSG.awardedEdit : MSG.awarded);
  return null;
}

/**
 * The client edits their own job, only while it is open and nobody has applied.
 * The update's WHERE is the rule; if it matches nothing we read the row again
 * to say which part of the rule failed.
 */
async function editJob({ jobId, clientId, input }, deps) {
  const { prisma } = baseDeps(deps);
  const checked = validateJobInput(input);
  if (!checked.ok) return checked;

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return refuse(404, "not_found", "Job not found.");
  if (job.clientId !== clientId) return refuse(403, "not_yours", "Not your job.");

  const { count } = await prisma.job.updateMany({
    where: { id: job.id, clientId, closedAt: null, awardedApplicationId: null, lastAppliedAt: null, applications: { none: {} } },
    data: { ...checked.value, revision: { increment: 1 } },
  });
  if (count === 1) return { ok: true, job: await loadJob(prisma, job.id) };

  return (await stateRefusal(prisma, job.id, { editing: true })) ?? refuse(409, "has_applicants", MSG.locked);
}

/**
 * The client closes their own open job: final. In one transaction the job gets
 * closedAt (only if it is still open and unawarded) and every pending
 * application becomes notSelected, so no applicant is left waiting on a job
 * that will never pick anyone. An application written at the same moment
 * either commits first (and is swept by the second statement) or finds the
 * job closed and is refused (applyToJob).
 */
async function closeJob({ jobId, clientId }, deps) {
  const { prisma, now } = baseDeps(deps);
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return refuse(404, "not_found", "Job not found.");
  if (job.clientId !== clientId) return refuse(403, "not_yours", "Not your job.");

  const closed = await prisma.$transaction(async (trx) => {
    const { count } = await trx.job.updateMany({
      where: { id: job.id, clientId, closedAt: null, awardedApplicationId: null },
      data: { closedAt: now() },
    });
    if (count === 0) return false;
    await trx.application.updateMany({ where: { jobId: job.id, status: "pending" }, data: { status: "notSelected" } });
    return true;
  });
  if (closed) return { ok: true, job: await loadJob(prisma, job.id) };

  return (await stateRefusal(prisma, job.id, { editing: false })) ?? refuse(409, "closed", MSG.closed);
}

/**
 * A verified talent applies. The job row is claimed first (guarded on open,
 * unawarded and, when the app sent it, the revision the talent read) and the
 * application is written in the same transaction, so an application can never
 * land on a job that closed, was awarded, or was edited since the talent
 * looked at it. Setting lastAppliedAt is also what locks the terms (editJob).
 * The caller has already checked verified-in-category and the payout account.
 */
async function applyToJob({ jobId, talentId, revision }, deps) {
  const { prisma, now } = baseDeps(deps);
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return refuse(404, "not_found", "Job not found.");
  if (job.closedAt) return refuse(409, "closed", MSG.closed);
  if (job.awardedApplicationId) return refuse(400, "awarded", MSG.awarded);

  try {
    const application = await prisma.$transaction(async (trx) => {
      const { count } = await trx.job.updateMany({
        where: { id: job.id, closedAt: null, awardedApplicationId: null, ...(revision === undefined ? {} : { revision }) },
        data: { lastAppliedAt: now() },
      });
      if (count === 0) return null;
      return trx.application.create({ data: { jobId: job.id, talentId }, include: { talent: true } });
    });
    if (application) return { ok: true, application };
  } catch (err) {
    // The @@unique([jobId, talentId]) in schema.prisma: a double apply is a clean 409.
    if (err.code === "P2002") return refuse(409, "already_applied", "You've already applied to this job.");
    throw err;
  }

  const fresh = await prisma.job.findUnique({ where: { id: job.id } });
  if (fresh?.closedAt) return refuse(409, "closed", MSG.closed);
  if (fresh?.awardedApplicationId) return refuse(400, "awarded", MSG.awarded);
  return refuse(409, "terms_changed", "This job was just edited. Read the new details, then apply again.");
}

/**
 * The single-award action (docs/core/correction-talent-discovery-screen.md in
 * the mobile repo): one applicant selected, every other one not selected, the
 * contract created awaiting payment with the fee frozen at today's budget, all
 * or nothing. The job row is claimed first (still open and unawarded) so an
 * award can never race a close or a second award.
 */
async function awardJob({ jobId, clientId, applicationId }, deps) {
  const { prisma } = baseDeps(deps);
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return refuse(404, "not_found", "Job not found.");
  if (job.clientId !== clientId) return refuse(403, "not_yours", "Not your job.");
  if (job.closedAt) return refuse(409, "closed", MSG.closed);
  if (job.awardedApplicationId) return refuse(400, "awarded", MSG.awarded);

  const winning = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!winning || winning.jobId !== job.id) return refuse(404, "not_found", "Application not found on this job.");

  const platformFeeAmount = paystack.calculatePlatformFee(job.budget);
  const contract = await prisma.$transaction(async (trx) => {
    const { count } = await trx.job.updateMany({
      where: { id: job.id, awardedApplicationId: null, closedAt: null },
      data: { awardedApplicationId: winning.id },
    });
    if (count === 0) return null;
    await trx.application.update({ where: { id: winning.id }, data: { status: "selected" } });
    await trx.application.updateMany({ where: { jobId: job.id, id: { not: winning.id } }, data: { status: "notSelected" } });
    return trx.contract.create({
      data: { jobId: job.id, status: "awaitingPayment", platformFeeAmount, payByAt: new Date(Date.now() + lifecycle.WINDOWS.paymentMs) },
    });
  });
  if (!contract) {
    const fresh = await prisma.job.findUnique({ where: { id: job.id } });
    return fresh?.closedAt ? refuse(409, "closed", MSG.closed) : refuse(400, "awarded", MSG.awarded);
  }
  await lifecycle.recordEvent(prisma, {
    jobId: job.id,
    contractId: contract.id,
    type: "awarded",
    meta: { applicationId: winning.id, payByAt: contract.payByAt },
  });
  return { ok: true, contract };
}

module.exports = { validateJobInput, jobInclude, loadJob, stateRefusal, editJob, closeJob, applyToJob, awardJob, MSG };
