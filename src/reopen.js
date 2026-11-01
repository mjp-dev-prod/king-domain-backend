// A job that failed after award reopens to the people who were not picked (PRD §3.2 step 9; D20). The old job keeps
// its contract, deliveries and money trail untouched, so the reopened job is a new post with the same terms, and the
// other applicants carry over as pending applications with what they already wrote.
const { prisma: realPrisma } = require("./db");
const { recordEvent } = require("./contractCore");

async function notify(userId, message) {
  try {
    await require("./discovery").notify(userId, message);
  } catch {
    // A push is a courtesy.
  }
}

/** Returns { jobId, carriedOver } or null when there is nothing to reopen (already reopened, or no such job). */
async function reopenFailedJob({ jobId, failedTalentId, contractId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const old = await prisma.job.findUnique({ where: { id: jobId }, include: { applications: true } });
  if (!old) return null;
  const already = await prisma.job.findFirst({ where: { reopenedFromId: old.id }, select: { id: true } });
  if (already) return { jobId: already.id, carriedOver: 0, already: true };

  const others = old.applications.filter((a) => a.status === "notSelected" && a.talentId !== failedTalentId);
  const now = new Date();
  const created = await prisma.$transaction(async (trx) => {
    const job = await trx.job.create({
      data: {
        clientId: old.clientId,
        title: old.title,
        category: old.category,
        description: old.description,
        budget: old.budget,
        deliveryDays: old.deliveryDays,
        jobType: old.jobType,
        skillKey: old.skillKey,
        brief: old.brief ?? undefined,
        currency: old.currency,
        visibility: old.visibility,
        screeningQuestions: old.screeningQuestions ?? undefined,
        postStatus: "live",
        liveAt: now,
        reopenedFromId: old.id,
      },
    });
    for (const a of others) {
      await trx.application.create({
        data: { jobId: job.id, talentId: a.talentId, status: "pending", answer: a.answer, pieces: a.pieces ?? undefined, screeningAnswers: a.screeningAnswers ?? undefined },
      });
    }
    return job;
  });
  await recordEvent(prisma, { jobId: old.id, contractId: contractId ?? "none", type: "jobReopened", meta: { newJobId: created.id, carriedOver: others.length } }).catch(() => {});
  for (const a of others) {
    await notify(a.talentId, { title: "A job you applied to is open again", body: `${old.title}: the client is looking again, and your application carried over.`, data: { type: "job_reopened", jobId: created.id } });
  }
  console.log(`reopen: job=${old.id} -> ${created.id} carriedOver=${others.length} excluded=${failedTalentId ?? "none"}`);
  return { jobId: created.id, carriedOver: others.length };
}

module.exports = { reopenFailedJob };
