// Reviews, both ways (PRD §4.8; D29 to D31). Asked after a job is paid out, inside 14 days. Hidden from everyone but the
// author until both are in or the window closes, then locked. One public reply each. A private "would you work with
// them again?" that only King Domain sees. Removed only for abuse, personal data, irrelevance or leverage.
const { prisma: realPrisma } = require("./db");
const rep = require("./reputation");

const fail = (status, code, error) => ({ ok: false, status, code, error });

async function notify(userId, message) {
  if (!userId) return;
  try {
    await require("./discovery").notify(userId, message);
  } catch {
    // A push is a courtesy.
  }
}

/** Who is who on a job, from the viewer's side. */
async function context(prisma, jobId, userId) {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { contract: true } });
  if (!job?.contract) return null;
  const app = job.awardedApplicationId ? await prisma.application.findUnique({ where: { id: job.awardedApplicationId } }) : null;
  const role = job.clientId === userId ? "client" : app?.talentId === userId ? "talent" : null;
  if (!role) return null;
  return { job, contract: job.contract, role, clientId: job.clientId, talentId: app?.talentId ?? null };
}

/** The review screen's state for one person on one job. */
async function stateFor({ jobId, userId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const c = await context(prisma, jobId, userId);
  if (!c) return null;
  const direction = c.role === "client" ? "client_to_talent" : "talent_to_client";
  const done = rep.completedAt(c.contract);
  const base = {
    role: c.role,
    direction,
    questions: rep.QUESTIONS[direction],
    privateQuestion: rep.PRIVATE_QUESTION,
    facts: done ? rep.jobFacts(c.contract, await prisma.contractDelivery.findMany({ where: { contractId: c.contract.id } })) : null,
    otherName: null,
  };
  const other = await prisma.user.findUnique({ where: { id: c.role === "client" ? c.talentId : c.clientId }, select: { fullName: true } });
  base.otherName = other?.fullName ?? null;
  if (!done) return { ...base, state: "not_yet", message: "You can review once the job has been paid out." };

  const windowEndsAt = new Date(done.getTime() + rep.REVIEW_WINDOW_MS);
  const reviews = await prisma.review.findMany({ where: { contractId: c.contract.id } });
  const mine = reviews.find((r) => r.authorId === userId) ?? null;
  const theirs = reviews.find((r) => r.authorId !== userId) ?? null;
  const revealed = rep.isRevealed(reviews, mine?.windowEndsAt ?? windowEndsAt, now);
  const open = now < windowEndsAt;

  const shape = (r, { includePrivate }) =>
    r && {
      id: r.id,
      answers: r.answers,
      comment: r.comment,
      reply: r.reply,
      repliedAt: r.repliedAt,
      at: r.createdAt,
      removed: Boolean(r.removedAt),
      ...(includePrivate ? { privateAgain: r.privateAgain } : {}),
    };

  let state;
  if (!mine) state = open ? "can_review" : "window_closed";
  else if (!revealed) state = "waiting";
  else state = "revealed";

  return {
    ...base,
    state,
    windowEndsAt,
    daysLeft: open ? Math.max(0, Math.ceil((windowEndsAt - now) / 86_400_000)) : 0,
    mine: shape(mine, { includePrivate: true }),
    // Their review is shown only once both are in, or the window has closed (D30).
    theirs: revealed && theirs && !theirs.removedAt ? shape(theirs, { includePrivate: false }) : null,
    theirsExists: Boolean(theirs),
    canEdit: Boolean(mine) && !revealed && open,
    canReply: revealed && Boolean(theirs) && !theirs.removedAt && !theirs.reply,
  };
}

async function submit({ jobId, userId, answers, comment, privateAgain }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const c = await context(prisma, jobId, userId);
  if (!c) return fail(404, "not_found", "Job not found.");
  const done = rep.completedAt(c.contract);
  if (!done) return fail(409, "not_yet", "You can review once the job has been paid out.");
  const windowEndsAt = new Date(done.getTime() + rep.REVIEW_WINDOW_MS);
  if (now >= windowEndsAt) return fail(409, "window_closed", "The 14 days to review this job have passed.");
  const direction = c.role === "client" ? "client_to_talent" : "talent_to_client";
  const checked = rep.validateReview({ direction, answers, comment, privateAgain });
  if (!checked.ok) return fail(400, "invalid", checked.error);

  const existing = await prisma.review.findUnique({ where: { contractId_authorId: { contractId: c.contract.id, authorId: userId } } });
  if (existing) {
    // Editable only until it is revealed; after that it is locked.
    const pair = await prisma.review.findMany({ where: { contractId: c.contract.id } });
    if (rep.isRevealed(pair, existing.windowEndsAt, now)) return fail(409, "locked", "Reviews are locked once both are in. You can still reply to theirs.");
    const updated = await prisma.review.update({ where: { id: existing.id }, data: { answers: checked.answers, comment: checked.comment, privateAgain: checked.privateAgain } });
    console.log(`review: edited review=${updated.id} by=${userId} direction=${direction}`);
    return { ok: true, review: updated, edited: true };
  }
  const subjectId = c.role === "client" ? c.talentId : c.clientId;
  const review = await prisma.review.create({
    data: { jobId, contractId: c.contract.id, authorId: userId, subjectId, direction, answers: checked.answers, comment: checked.comment, privateAgain: checked.privateAgain, windowEndsAt },
  });
  const pair = await prisma.review.findMany({ where: { contractId: c.contract.id } });
  const revealed = rep.isRevealed(pair, windowEndsAt, now);
  console.log(`review: submitted review=${review.id} by=${userId} direction=${direction} revealedNow=${revealed} readBack.count=${pair.length}`);
  if (revealed) {
    // The second review in: both become visible, and each person is told.
    await Promise.all([
      notify(c.clientId, { title: "Reviews are in", body: `${c.job.title}: you can read what they wrote.`, data: { type: "review", jobId } }),
      notify(c.talentId, { title: "Reviews are in", body: `${c.job.title}: you can read what they wrote.`, data: { type: "review", jobId } }),
    ]);
  } else {
    await notify(subjectId, { title: "They reviewed you", body: `${c.job.title}: write yours to see theirs. You have until ${windowEndsAt.toISOString().slice(0, 10)}.`, data: { type: "review", jobId } });
  }
  return { ok: true, review, edited: false, revealed };
}

async function reply({ jobId, userId, text }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const c = await context(prisma, jobId, userId);
  if (!c) return fail(404, "not_found", "Job not found.");
  const reviews = await prisma.review.findMany({ where: { contractId: c.contract.id } });
  const about = reviews.find((r) => r.subjectId === userId);
  if (!about || about.removedAt) return fail(404, "no_review", "There is no review about you to reply to.");
  if (!rep.isRevealed(reviews, about.windowEndsAt, now)) return fail(409, "hidden", "You can reply once reviews are visible.");
  if (about.reply) return fail(409, "already_replied", "You already replied. Each person gets one public reply.");
  const body = typeof text === "string" ? text.trim() : "";
  if (body.length < 5 || body.length > 500) return fail(400, "invalid", "Write a reply of 5 to 500 characters.");
  const updated = await prisma.review.update({ where: { id: about.id }, data: { reply: body, repliedAt: now } });
  console.log(`review: replied review=${about.id} by=${userId} readBack.hasReply=${Boolean(updated.reply)}`);
  await notify(about.authorId, { title: "They replied to your review", body: c.job.title, data: { type: "review", jobId } });
  return { ok: true };
}

/** Anyone who can see a review may report it for breaking the rules. Disagreeing with it is not a reason. */
async function report({ reviewId, userId, reasonCode, note }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  if (!rep.REMOVAL_REASONS.some((r) => r.code === reasonCode)) return fail(400, "invalid", "Choose why it breaks the rules.");
  const review = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!review || review.removedAt) return fail(404, "not_found", "Review not found.");
  if (review.authorId === userId) return fail(400, "own_review", "That's your own review.");
  const pair = await prisma.review.findMany({ where: { contractId: review.contractId } });
  if (!rep.isRevealed(pair, review.windowEndsAt) && review.subjectId !== userId) return fail(404, "not_found", "Review not found.");
  try {
    const row = await prisma.reviewReport.create({ data: { reviewId, reporterId: userId, reasonCode, note: typeof note === "string" ? note.trim().slice(0, 500) : "" } });
    try {
      await require("./alerts").raiseAlert(prisma, { severity: "digest", queueKey: "review-report", title: "A review was reported", body: "Read it and decide whether it breaks the rules.", link: `/review-reports/${row.id}` }, deps);
    } catch (err) {
      console.error(`review: could not queue the alert: ${err.message}`);
    }
    return { ok: true, report: row };
  } catch (err) {
    if (err.code === "P2002") return fail(409, "already_reported", "You already reported this review.");
    throw err;
  }
}

/** The team's decision: remove it (for one of the four reasons) or keep it. */
async function handleReport({ reportId, adminId, decision, reasonCode, note }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const r = await prisma.reviewReport.findUnique({ where: { id: reportId }, include: { review: true } });
  if (!r) return fail(404, "not_found", "Report not found.");
  if (r.status !== "open") return fail(409, "handled", "Someone else just handled this report. Refresh the list.");
  if (!["remove", "keep"].includes(decision)) return fail(400, "invalid", "Choose remove or keep.");
  const text = typeof note === "string" ? note.trim() : "";
  if (text.length < 10) return fail(400, "invalid", "Say why, in at least 10 characters.");
  if (decision === "remove" && !rep.REMOVAL_REASONS.some((x) => x.code === reasonCode)) return fail(400, "invalid", "Removal needs one of the four reasons. Disagreeing with an honest review is not one: the reply is for that.");

  await prisma.$transaction(async (tx) => {
    await tx.reviewReport.update({ where: { id: reportId }, data: { status: decision === "remove" ? "removed" : "kept", handledById: adminId, handledNote: text, handledAt: new Date() } });
    if (decision === "remove") {
      await tx.review.update({ where: { id: r.reviewId }, data: { removedAt: new Date(), removedReason: reasonCode } });
      await tx.reviewReport.updateMany({ where: { reviewId: r.reviewId, status: "open" }, data: { status: "removed", handledById: adminId, handledNote: "Removed with another report.", handledAt: new Date() } });
    }
  });
  console.log(`review: report ${reportId} -> ${decision} by admin=${adminId} readBack.removedAt=${(await prisma.review.findUnique({ where: { id: r.reviewId } })).removedAt?.toISOString() ?? "none"}`);
  return { ok: true };
}

module.exports = { stateFor, submit, reply, report, handleReport, context };
