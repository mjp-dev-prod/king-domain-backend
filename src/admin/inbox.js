// The team inbox (PRD §4.11, admin tools doc §4, decision D43). Each queue states its target,
// what happens if the target passes, and honest numbers: median and 90th percentile of handling
// time ("averages hide the slow tail"), and items still open past target counted as overdue.
// Later slices append their queues here (identity, job posts, shortlists, disputes, chargebacks...).

const { hasCapability } = require("./capabilities");

const RESOLVED_SAMPLE = 50;

/** Nearest-rank percentile. Null when there is no data, so the UI can say "not enough data yet". */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const QUEUES = [
  {
    key: "proof",
    label: "Proof verification",
    capability: "reviewer",
    path: "/proof-review",
    // Provisional: the admin tools doc says to measure for six to eight weeks, then set it.
    defaultTargetMinutes: 72 * 60,
    defaultWhenLate: "The talent sees it is still in review, with the expected date.",
    async openSince(db) {
      const rows = await db.proofItem.findMany({ where: { status: "pending" }, select: { createdAt: true } });
      return rows.map((r) => r.createdAt);
    },
    async resolvedDurationsMs(db) {
      // Only approvals have a reviewedAt today; rejected items are deleted (S2 keeps them),
      // so until then this sample is approvals only.
      const rows = await db.proofItem.findMany({
        where: { status: "verified", reviewedAt: { not: null } },
        select: { createdAt: true, reviewedAt: true },
        orderBy: { reviewedAt: "desc" },
        take: RESOLVED_SAMPLE,
      });
      return rows.map((r) => r.reviewedAt.getTime() - r.createdAt.getTime());
    },
  },
  {
    key: "identity",
    label: "Identity checks",
    capability: "checker",
    path: "/identity-checks",
    defaultTargetMinutes: 48 * 60,
    defaultWhenLate: "The person can still browse; paid actions wait until they are checked.",
    async openSince(db) {
      const rows = await db.identityCheck.findMany({ where: { status: "pending" }, select: { createdAt: true } });
      return rows.map((r) => r.createdAt);
    },
    async resolvedDurationsMs(db) {
      const rows = await db.identityCheck.findMany({
        where: { status: { not: "pending" }, reviewedAt: { not: null } },
        select: { createdAt: true, reviewedAt: true },
        orderBy: { reviewedAt: "desc" },
        take: RESOLVED_SAMPLE,
      });
      return rows.map((r) => r.reviewedAt.getTime() - r.createdAt.getTime());
    },
  },
];

async function targetFor(db, queue) {
  const row = await db.queueTarget.findUnique({ where: { queueKey: queue.key } });
  return {
    targetMinutes: row?.targetMinutes ?? queue.defaultTargetMinutes,
    defaultWhenLate: row?.defaultWhenLate ?? queue.defaultWhenLate,
  };
}

const toMinutes = (ms) => (ms === null ? null : Math.round(ms / 60000));

async function inboxFor(db, admin, now = new Date()) {
  const visible = QUEUES.filter((q) => hasCapability(admin, q.capability));
  return Promise.all(
    visible.map(async (q) => {
      const [{ targetMinutes, defaultWhenLate }, openSince, durations] = await Promise.all([
        targetFor(db, q),
        q.openSince(db),
        q.resolvedDurationsMs(db),
      ]);
      const waits = openSince.map((d) => now.getTime() - d.getTime());
      const overdue = waits.filter((w) => w > targetMinutes * 60000).length;
      return {
        key: q.key,
        label: q.label,
        path: q.path,
        capability: q.capability,
        targetMinutes,
        defaultWhenLate,
        open: waits.length,
        overdue,
        oldestWaitingMinutes: waits.length ? toMinutes(Math.max(...waits)) : null,
        p50Minutes: toMinutes(percentile(durations, 50)),
        p90Minutes: toMinutes(percentile(durations, 90)),
        sample: durations.length,
      };
    }),
  );
}

module.exports = { QUEUES, percentile, targetFor, inboxFor };
