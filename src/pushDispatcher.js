// The outbox: turns new ContractEvents into pushes. Every meaningful change already writes an event after
// its transaction commits, so this reads them back instead of being wired into the money code. Design:
// docs/features/push-notifications.md in the mobile repo.
//
// An event is claimed with ONE conditional update on pushedAt (null -> now), so two dispatchers, or two
// overlapping runs, can never send the same event twice. The claim comes before the send: if the process
// dies in between, that push is lost rather than repeated. Events that have nothing to say are claimed too,
// so they are not read again.
const { prisma: realPrisma } = require("./db");
const push = require("./push");
const { forEvent } = require("./pushMessages");

const WINDOW_MS = 15 * 60 * 1000; // never replay history: switching push on must not announce old events
const BATCH = 50;
const INTERVAL_MS = 5_000;
const PRUNE_EVERY_MS = 24 * 3_600_000;

/** Who is on the job, as the messages need to know. Null when the job no longer exists. */
async function contextFor(prisma, event) {
  const job = await prisma.job.findUnique({ where: { id: event.jobId }, select: { id: true, title: true, clientId: true, awardedApplicationId: true } });
  if (!job) return null;
  // A cancelled award has cleared job.awardedApplicationId; the event remembers who it was.
  const applicationId = event.meta?.awardedApplicationId ?? event.meta?.applicationId ?? job.awardedApplicationId;
  const application = applicationId ? await prisma.application.findUnique({ where: { id: applicationId }, select: { talentId: true } }) : null;
  return { job: { id: job.id, title: job.title }, clientId: job.clientId, talentId: application?.talentId ?? null };
}

/** One pass: claim recent unhandled events and push each. Returns how many it claimed and sent. */
async function dispatchPending({ prisma = realPrisma, push: sender = push, now = () => new Date() } = {}) {
  const at = now();
  const events = await prisma.contractEvent.findMany({
    where: { pushedAt: null, createdAt: { gte: new Date(at.getTime() - WINDOW_MS) } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  let claimed = 0;
  let sent = 0;
  for (const event of events) {
    const { count } = await prisma.contractEvent.updateMany({ where: { id: event.id, pushedAt: null }, data: { pushedAt: at } });
    if (count === 0) continue; // another dispatcher got it
    claimed++;
    try {
      const ctx = await contextFor(prisma, event);
      const outgoing = ctx ? forEvent(event, ctx) : [];
      for (const m of outgoing) {
        const { userId, ...message } = m;
        await sender.notifyUser(userId, message);
        sent++;
      }
      if (outgoing.length) console.log(`[push] event=${event.type} job=${event.jobId} -> ${outgoing.map((m) => m.userId).join(",")}`);
    } catch (err) {
      console.error(`[push] event=${event.type} id=${event.id} could not be pushed: ${err.message}`);
    }
  }
  return { claimed, sent };
}

/**
 * Runs dispatchPending every few seconds, and prunes stale tokens daily. Does nothing (returns null) when
 * push is not configured, so an environment without a key never polls the database for it.
 */
function startPushDispatcher({ intervalMs = INTERVAL_MS } = {}) {
  if (!push.configured()) {
    console.log("[push] FCM_SERVICE_ACCOUNT_JSON not set: push notifications are off");
    return null;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchPending();
    } catch (err) {
      console.error(`[push] dispatch failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const prune = () => push.pruneStaleTokens().then((r) => r.removed && console.log(`[push] pruned ${r.removed} stale device tokens`)).catch(() => {});
  prune();
  setInterval(prune, PRUNE_EVERY_MS).unref();
  console.log(`[push] dispatcher running every ${intervalMs / 1000}s`);
  return timer;
}

module.exports = { dispatchPending, startPushDispatcher, WINDOW_MS };
