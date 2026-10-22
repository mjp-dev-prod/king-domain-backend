// A job before it has a contract: edit it until someone applies, close it,
// apply to it, award it. Design: docs/features/work-gaps-applications-stepper-job-edit.md
// in the mobile repo.
//
// Every guard here is ONE conditional UPDATE on the job row. Concurrent
// requests queue on that row's lock and re-check its columns once they get it,
// so "no edit after the first applicant", "no application after a close" and
// "no award after a close" hold without raw SQL or serializable transactions.
const { RULES, baseDeps, refuse } = require("./contractCore");

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

module.exports = { validateJobInput, jobInclude, loadJob, stateRefusal, editJob, closeJob, MSG };
