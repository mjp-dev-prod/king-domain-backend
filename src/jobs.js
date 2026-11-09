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
const { lockLive } = require("./accounts");
const briefs = require("./briefs");
const safety = require("./safety");
const { skillByKey, CATEGORIES } = require("./skills");
const { capState } = require("./discoveryRules");

const jobInclude = { client: true, contract: true, _count: { select: { applications: true } } };
const loadJob = (prisma, id) => prisma.job.findUnique({ where: { id }, include: jobInclude });

const MSG = {
  closed: "This job has been closed.",
  awarded: "This job has already been awarded.",
  awardedEdit: "This job has already been awarded, so it can't be changed.",
  locked: "Someone has already applied, so the terms are locked. Close this job and post a new one to change them.",
};

const categoryLabelOf = (skill) => CATEGORIES.find((c) => c.key === skill.category)?.label ?? skill.category;

/**
 * The structured post (S3): a skill, a job type, a brief checked against that skill and type, a price and currency,
 * delivery days, up to three screening questions and who may see it. Milestone, monthly and hourly jobs derive what
 * they can (src/briefs.js says what `budget` means for each).
 */
function validateStructuredJob(body) {
  const { title, description, skillKey, jobType, brief, price, currency, deliveryDays, screeningQuestions, visibility } = body;
  if (typeof title !== "string" || title.trim().length < 5) return refuse(400, "invalid", "Give the job a title of at least 5 characters.");
  if (typeof description !== "string" || description.trim().length < 20) return refuse(400, "invalid", "Describe the job in at least 20 characters.");
  const skill = skillByKey(skillKey);
  if (!skill) return refuse(400, "invalid", "Choose a skill from the list.");
  const cur = currency ?? "NGN";
  if (!briefs.CURRENCIES.includes(cur)) return refuse(400, "invalid", "Price the job in naira or dollars.");
  const vis = visibility ?? "public";
  if (!briefs.VISIBILITY.includes(vis)) return refuse(400, "invalid", "Choose public or invite-only.");
  const checked = briefs.validateBrief({ skillKey, jobType, brief, price });
  if (!checked.ok) return refuse(400, "invalid", checked.error, checked.field);
  const questions = briefs.validateScreeningQuestions(screeningQuestions);
  if (!questions.ok) return refuse(400, "invalid", questions.error);

  let days = Number(deliveryDays);
  if (jobType === "milestones") days = Math.min(RULES.deliveryDays.max, checked.brief.milestones.reduce((n, m) => n + m.days, 0));
  else if (jobType === "monthly") days = 30;
  else if (jobType === "hourly") days = 7;
  if (!Number.isInteger(days) || days < RULES.deliveryDays.min || days > RULES.deliveryDays.max) {
    return refuse(400, "invalid", `Delivery is ${RULES.deliveryDays.min} to ${RULES.deliveryDays.max} days.`);
  }
  return {
    ok: true,
    structured: true,
    value: {
      title: title.trim(),
      category: categoryLabelOf(skill),
      description: description.trim(),
      budget: checked.budget,
      deliveryDays: days,
      skillKey,
      jobType,
      brief: checked.brief,
      currency: cur,
      visibility: vis,
      screeningQuestions: questions.questions,
    },
  };
}

/** The fields a client sets when posting or editing a job, checked and trimmed. */
function validateJobInput(body) {
  if (body && typeof body === "object" && body.skillKey !== undefined) return validateStructuredJob(body);
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

/** Codes the detector found that always hold a post for a person, even from an established client (D17, D18). */
const HOLD_CODES = ["outside_payment", "pay_to_apply", "apk"];

/** Whether this post goes live now or waits for a person: a client's first post, or anything that asks for money or a program. */
async function screeningDecision(prisma, clientId, value) {
  const flags = safety.detectRisk(safety.jobPostText(value));
  const before = await prisma.job.count({ where: { clientId, postStatus: "live" } });
  const hold = before === 0 || flags.some((f) => HOLD_CODES.includes(f.code));
  return { flags, hold, reason: before === 0 ? "first_post" : flags.some((f) => HOLD_CODES.includes(f.code)) ? "flagged" : null };
}

/**
 * A client posts a job. The client's row is share-locked and checked first (src/accounts.js), so a job
 * can never be created for someone whose account is being deleted at that moment.
 */
async function postJob({ clientId, input }, deps) {
  const { prisma } = baseDeps(deps);
  const checked = validateJobInput(input);
  if (!checked.ok) return checked;
  // The old shape (no skill) stays as it was: live at once. Structured posts are screened (D17).
  let screening = { hold: false, flags: [], reason: null };
  if (checked.structured) screening = await screeningDecision(prisma, clientId, checked.value);
  const at = new Date();
  const created = await prisma.$transaction(async (trx) => {
    const unavailable = await lockLive(trx, [clientId]);
    if (unavailable) return unavailable;
    return trx.job.create({
      data: {
        clientId,
        ...checked.value,
        postStatus: screening.hold ? "screening" : "live",
        liveAt: screening.hold ? null : at,
        screeningFlags: screening.flags.length ? screening.flags : undefined,
      },
      include: jobInclude,
    });
  });
  if (created.ok === false) return created;
  console.log(`jobs: posted job=${created.id} client=${clientId} structured=${Boolean(checked.structured)} status=${created.postStatus} screeningReason=${screening.reason} flags=${screening.flags.map((f) => f.code).join(",") || "none"} readBack=${(await prisma.job.count({ where: { id: created.id, postStatus: created.postStatus } })) === 1}`);
  return { ok: true, job: created, screening };
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

  // Editing a post a person turned down sends it back for another look (with a fresh scan).
  const resubmit = job.postStatus === "rejected";
  const flags = checked.structured ? safety.detectRisk(safety.jobPostText(checked.value)) : [];
  const { count } = await prisma.job.updateMany({
    where: { id: job.id, clientId, closedAt: null, awardedApplicationId: null, lastAppliedAt: null, applications: { none: {} } },
    data: {
      ...checked.value,
      revision: { increment: 1 },
      ...(resubmit ? { postStatus: "screening", rejectReasonCode: null, rejectNote: null, screenedAt: null, screenedById: null } : {}),
      ...(checked.structured ? { screeningFlags: flags.length ? flags : null } : {}),
    },
  });
  if (count === 1) return { ok: true, job: await loadJob(prisma, job.id), resubmitted: resubmit };

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
    await trx.application.updateMany({ where: { jobId: job.id, status: { in: ["pending", "shortlisted"] } }, data: { status: "notSelected" } });
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
async function applyToJob({ jobId, talentId, revision, answer, pieces, screeningAnswers }, deps) {
  const { prisma, now } = baseDeps(deps);
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return refuse(404, "not_found", "Job not found.");
  if (job.closedAt) return refuse(409, "closed", MSG.closed);
  if (job.awardedApplicationId) return refuse(400, "awarded", MSG.awarded);

  // A structured job (S3) asks for more than a name: an answer, the work that fits, the client's questions.
  let extra = {};
  if (job.skillKey) {
    if (job.postStatus !== "live") return refuse(409, "not_live", "This job isn't open yet.");
    const invitation = await prisma.invitation.findFirst({ where: { jobId: job.id, talentId, status: { in: ["pending", "accepted"] }, expiresAt: { gt: now() } } });
    if (job.visibility === "invite" && !invitation) return refuse(403, "invite_only", "This job is invite-only, and you haven't been invited.");
    // An invited talent may apply even when the cap has paused the job (the client asked them).
    if (!invitation) {
      const count = await prisma.application.count({ where: { jobId: job.id, ...(job.reopenedAt ? { createdAt: { gte: job.reopenedAt } } : {}) } });
      const cap = capState({ applicantCount: count, openedAt: job.reopenedAt ?? job.liveAt ?? job.createdAt, now: now() });
      if (cap.paused) return refuse(409, "cap_paused", cap.reason === "applicants" ? "This job has all the applications it can take for now." : "This job has been open for 5 days, so applications are paused.");
    }
    const text = typeof answer === "string" ? answer.trim() : "";
    if (text.length < 20 || text.length > 1500) return refuse(400, "invalid", "Answer the brief in 20 to 1500 characters.");
    const questions = Array.isArray(job.screeningQuestions) ? job.screeningQuestions : [];
    const given = Array.isArray(screeningAnswers) ? screeningAnswers.map((a) => (typeof a === "string" ? a.trim() : "")) : [];
    if (given.length !== questions.length || given.some((a) => !a || a.length > 500)) return refuse(400, "invalid", "Answer every question the client asked (up to 500 characters each).");
    const picked = await checkPieces(prisma, talentId, job.skillKey, pieces);
    if (!picked.ok) return picked;
    extra = { answer: text, pieces: picked.pieces, screeningAnswers: given, invitationId: invitation?.id ?? null };
  }

  try {
    const application = await prisma.$transaction(async (trx) => {
      const unavailable = await lockLive(trx, [talentId]);
      if (unavailable) return unavailable;
      const { count } = await trx.job.updateMany({
        where: { id: job.id, closedAt: null, awardedApplicationId: null, ...(revision === undefined ? {} : { revision }) },
        data: { lastAppliedAt: now() },
      });
      if (count === 0) return null;
      const made = await trx.application.create({ data: { jobId: job.id, talentId, ...extra }, include: { talent: true } });
      if (extra.invitationId) await trx.invitation.update({ where: { id: extra.invitationId }, data: { status: "accepted", respondedAt: now() } });
      return made;
    });
    if (application?.ok === false) return application;
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
  const awarded = await prisma.$transaction(async (trx) => {
    const unavailable = await lockLive(trx, [job.clientId, winning.talentId]);
    if (unavailable) return unavailable;
    const { count } = await trx.job.updateMany({
      where: { id: job.id, awardedApplicationId: null, closedAt: null },
      data: { awardedApplicationId: winning.id },
    });
    if (count === 0) return null;
    await trx.application.update({ where: { id: winning.id }, data: { status: "selected" } });
    await trx.application.updateMany({ where: { jobId: job.id, id: { not: winning.id }, status: { not: "declined" } }, data: { status: "notSelected" } });
    return trx.contract.create({
      data: { jobId: job.id, status: "awaitingPayment", platformFeeAmount, payByAt: new Date(Date.now() + lifecycle.WINDOWS.paymentMs) },
    });
  });
  if (awarded?.ok === false) return awarded;
  const contract = awarded;
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

/**
 * 1 to 3 pieces of VERIFIED work the talent chooses to show for this application. A piece is either one of the pieces
 * of a verified skill submission in this skill (S2), or an older verified proof item. Nothing unverified can be shown.
 */
async function checkPieces(prisma, talentId, skillKey, pieces) {
  const list = Array.isArray(pieces) ? pieces : [];
  if (list.length < 1 || list.length > 3) return refuse(400, "invalid", "Choose 1 to 3 pieces of your verified work to show.");
  const out = [];
  for (const piece of list) {
    if (!piece || typeof piece.id !== "string") return refuse(400, "invalid", "A chosen piece wasn't understood.");
    if (piece.type === "piece") {
      const found = await prisma.submissionPiece.findFirst({ where: { id: piece.id, submission: { userId: talentId, skillKey, status: "verified" } }, select: { id: true } });
      if (!found) return refuse(400, "invalid", "You can only show pieces from your verified work in this skill.");
    } else {
      return refuse(400, "invalid", "A chosen piece wasn't understood.");
    }
    if (out.some((o) => o.id === piece.id)) return refuse(400, "invalid", "You chose the same piece twice.");
    out.push({ type: piece.type, id: piece.id });
  }
  return { ok: true, pieces: out };
}

module.exports = { checkPieces, validateJobInput, jobInclude, loadJob, stateRefusal, postJob, editJob, closeJob, applyToJob, awardJob, MSG };
