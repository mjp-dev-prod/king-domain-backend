const { prisma } = require("../db");
const mailer = require("./mailer");

// How long a burst of comments on one thread collapses into a single digest
// email, per shareholder-decisions.md — tune once there's real usage to look at.
const DIGEST_DELAY_MS = 4 * 60 * 60 * 1000;

/**
 * Drain PendingNotification rows older than the delay window into digest
 * emails, one per (decision, recipient) pair, then delete them. Meant to be
 * called on an interval — see startNotificationScheduler.
 */
async function drainPendingNotifications() {
  const due = await prisma.pendingNotification.findMany({
    where: { firstQueuedAt: { lte: new Date(Date.now() - DIGEST_DELAY_MS) } },
    include: { decision: { select: { id: true, title: true } }, recipient: { select: { email: true } } },
  });

  for (const row of due) {
    try {
      await mailer.sendCommentDigest({
        to: row.recipient.email,
        decisionTitle: row.decision.title,
        decisionId: row.decision.id,
        commentCount: row.commentCount,
      });
      await prisma.pendingNotification.delete({ where: { id: row.id } });
    } catch (err) {
      console.error("notifications: failed to drain digest for", row.id, err);
    }
  }

  return due.length;
}

function startNotificationScheduler({ intervalMs = 15 * 60 * 1000 } = {}) {
  const timer = setInterval(() => {
    drainPendingNotifications().catch((err) => {
      console.error("notifications: drain cycle failed:", err);
    });
  }, intervalMs);
  // Don't keep the process alive solely for this timer.
  timer.unref();
  return timer;
}

module.exports = { drainPendingNotifications, startNotificationScheduler };
