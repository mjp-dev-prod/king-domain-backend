// A nudge to review a finished job, twice: after 2 days and again after 9, inside the 14-day window (PRD §4.8). Only the
// person who has not reviewed yet is asked, and nobody twice: the reminder row is inserted before the push goes out, the
// same way contract reminders are (src/contractReminders.js).
const { prisma: realPrisma } = require("./db");
const { DAY } = require("./contractCore");
const rep = require("./reputation");

async function notify(userId, message) {
  try {
    await require("./discovery").notify(userId, message);
  } catch {
    // A push is a courtesy.
  }
}

async function sweepReviewReminders(deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - rep.REVIEW_WINDOW_MS);
  const contracts = await prisma.contract.findMany({ where: { status: "approved", transferredAt: { gte: since, lte: new Date(now.getTime() - 2 * DAY) } }, include: { job: true } });
  let sent = 0;
  for (const c of contracts) {
    const age = now.getTime() - c.transferredAt.getTime();
    const stage = age >= 9 * DAY ? "d9" : "d2";
    const app = c.job.awardedApplicationId ? await prisma.application.findUnique({ where: { id: c.job.awardedApplicationId } }) : null;
    const reviews = await prisma.review.findMany({ where: { contractId: c.id }, select: { authorId: true } });
    for (const [userId, other] of [[c.job.clientId, "the talent"], [app?.talentId, "the client"]]) {
      if (!userId || reviews.some((r) => r.authorId === userId)) continue;
      const key = `review_${userId}_${stage}`;
      try {
        await prisma.contractReminder.create({ data: { contractId: c.id, key } });
      } catch (err) {
        if (err.code === "P2002") continue;
        throw err;
      }
      await notify(userId, {
        title: stage === "d2" ? "How did it go?" : "Last days to review",
        body: `Tell us how "${c.job.title}" went with ${other}. It takes a minute, and helps the next person.`,
        data: { type: "review", jobId: c.jobId },
      });
      sent++;
    }
  }
  return { reviewReminders: sent };
}

module.exports = { sweepReviewReminders };
