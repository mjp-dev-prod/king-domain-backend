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
  {
    key: "authenticity",
    label: "Authenticity checks",
    capability: "checker",
    path: "/authenticity",
    defaultTargetMinutes: 24 * 60,
    defaultWhenLate: "The talent sees their submission is waiting for the first check.",
    async openSince(db) {
      const rows = await db.skillSubmission.findMany({ where: { status: "authenticity" }, select: { submittedAt: true } });
      return rows.map((r) => r.submittedAt);
    },
    async resolvedDurationsMs(db) {
      const rows = await db.skillSubmission.findMany({
        where: { authenticityAt: { not: null }, submittedAt: { not: null } },
        select: { submittedAt: true, authenticityAt: true },
        orderBy: { authenticityAt: "desc" },
        take: RESOLVED_SAMPLE,
      });
      return rows.map((r) => r.authenticityAt.getTime() - r.submittedAt.getTime());
    },
  },
  {
    key: "skill-review",
    label: "Skill reviews",
    capability: "reviewer",
    path: "/skill-reviews",
    defaultTargetMinutes: 72 * 60,
    defaultWhenLate: "The talent sees it is still with the reviewers, with the expected date.",
    async openSince(db) {
      const rows = await db.skillSubmission.findMany({ where: { status: "review" }, select: { authenticityAt: true } });
      return rows.map((r) => r.authenticityAt);
    },
    async resolvedDurationsMs(db) {
      const rows = await db.skillSubmission.findMany({
        where: { status: { in: ["verified", "notYet"] }, decidedAt: { not: null }, authenticityAt: { not: null } },
        select: { authenticityAt: true, decidedAt: true },
        orderBy: { decidedAt: "desc" },
        take: RESOLVED_SAMPLE,
      });
      return rows.map((r) => r.decidedAt.getTime() - r.authenticityAt.getTime());
    },
  },
  {
    key: "job-post",
    label: "Job posts",
    capability: "safety",
    path: "/job-posts",
    defaultTargetMinutes: 4 * 60,
    defaultWhenLate: "The client sees their post is still being read; nothing goes live.",
    async openSince(db) {
      const rows = await db.job.findMany({ where: { postStatus: "screening" }, select: { createdAt: true } });
      return rows.map((r) => r.createdAt);
    },
    async resolvedDurationsMs(db) {
      const rows = await db.job.findMany({ where: { screenedAt: { not: null } }, select: { createdAt: true, screenedAt: true }, orderBy: { screenedAt: "desc" }, take: RESOLVED_SAMPLE });
      return rows.map((r) => r.screenedAt.getTime() - r.createdAt.getTime());
    },
  },
  {
    key: "shortlist",
    label: "Shortlists",
    capability: "support",
    path: "/shortlists",
    // The promise shown to clients is computed from real delivery times (D24); this is only the team's own alert line.
    defaultTargetMinutes: 24 * 60,
    defaultWhenLate: "The client keeps waiting; the promise they were shown is the 90th percentile of recent shortlists.",
    async openSince(db) {
      const rows = await db.shortlistRequest.findMany({ where: { status: { in: ["requested", "building"] } }, select: { clockStartedAt: true } });
      return rows.map((r) => r.clockStartedAt);
    },
    async resolvedDurationsMs(db) {
      const rows = await db.shortlistRequest.findMany({ where: { status: "sent", sentAt: { not: null } }, select: { clockStartedAt: true, sentAt: true }, orderBy: { sentAt: "desc" }, take: RESOLVED_SAMPLE });
      return rows.map((r) => r.sentAt.getTime() - r.clockStartedAt.getTime());
    },
  },
  {
    key: "safety-report",
    label: "Safety reports",
    capability: "safety",
    path: "/safety-reports",
    // A report on a pair with a live job also raises an urgent alert at once; this is the target for the rest.
    defaultTargetMinutes: 12 * 60,
    defaultWhenLate: "The report stays open; the reported message stays visible to the other person until someone decides.",
    async openSince(db) {
      const rows = await db.messageReport.findMany({ where: { status: "open" }, select: { createdAt: true } });
      return rows.map((r) => r.createdAt);
    },
    async resolvedDurationsMs(db) {
      const rows = await db.messageReport.findMany({ where: { status: { not: "open" }, handledAt: { not: null } }, select: { createdAt: true, handledAt: true }, orderBy: { handledAt: "desc" }, take: RESOLVED_SAMPLE });
      return rows.map((r) => r.handledAt.getTime() - r.createdAt.getTime());
    },
  },
  {
    key: "review-report",
    label: "Reported reviews",
    capability: "safety",
    path: "/review-reports",
    defaultTargetMinutes: 48 * 60,
    defaultWhenLate: "The review stays visible while it waits; a review that breaks the rules stays up longer.",
    async openSince(db) {
      const rows = await db.reviewReport.findMany({ where: { status: "open" }, select: { createdAt: true } });
      return rows.map((r) => r.createdAt);
    },
    async resolvedDurationsMs(db) {
      const rows = await db.reviewReport.findMany({ where: { status: { not: "open" }, handledAt: { not: null } }, select: { createdAt: true, handledAt: true }, orderBy: { handledAt: "desc" }, take: RESOLVED_SAMPLE });
      return rows.map((r) => r.handledAt.getTime() - r.createdAt.getTime());
    },
  },
  {
    key: "dispute",
    label: "Disputes",
    capability: "disputes",
    path: "/disputes",
    // The promise to both sides: a free ruling with written reasons within 5 days (D33).
    defaultTargetMinutes: 5 * 24 * 60,
    defaultWhenLate: "Both people keep waiting, the money stays held and the clocks stay paused.",
    async openSince(db) {
      const rows = await db.dispute.findMany({ where: { status: "escalated" }, select: { escalatedAt: true } });
      return rows.map((r) => r.escalatedAt);
    },
    async resolvedDurationsMs(db) {
      const rows = await db.dispute.findMany({ where: { status: "resolved", escalatedAt: { not: null }, resolvedAt: { not: null }, resolution: { path: ["by"], equals: "ruling" } }, select: { escalatedAt: true, resolvedAt: true }, orderBy: { resolvedAt: "desc" }, take: RESOLVED_SAMPLE });
      return rows.map((r) => r.resolvedAt.getTime() - r.escalatedAt.getTime());
    },
  },
  {
    key: "chargeback",
    label: "Chargebacks",
    capability: "finance",
    path: "/chargebacks",
    // Paystack gives 16 weekday hours (960 minutes); after that it is accepted for us and cannot be undone.
    defaultTargetMinutes: 8 * 60,
    defaultWhenLate: "At 16 weekday hours Paystack accepts the chargeback for us and takes the amount from the next payout.",
    async openSince(db) {
      const rows = await db.chargeback.findMany({ where: { status: "open" }, select: { receivedAt: true } });
      return rows.map((r) => r.receivedAt);
    },
    async resolvedDurationsMs(db) {
      const rows = await db.chargeback.findMany({ where: { status: { not: "open" }, respondedAt: { not: null } }, select: { receivedAt: true, respondedAt: true }, orderBy: { respondedAt: "desc" }, take: RESOLVED_SAMPLE });
      return rows.map((r) => r.respondedAt.getTime() - r.receivedAt.getTime());
    },
  },
  {
    key: "start-proof",
    label: "Start proof objections",
    capability: "disputes",
    path: "/start-proofs",
    // The talent is waiting on this to be paid the first 20%, so it is a same-day queue.
    defaultTargetMinutes: 12 * 60,
    defaultWhenLate: "The 20% stays unpaid and the talent can't deliver until a person rules on the objection.",
    async openSince(db) {
      const rows = await db.contract.findMany({ where: { startProofStatus: "objected" }, select: { startProofObjection: true, updatedAt: true } });
      return rows.map((r) => (r.startProofObjection?.at ? new Date(r.startProofObjection.at) : r.updatedAt));
    },
    async resolvedDurationsMs(db) {
      const rows = await db.contract.findMany({ where: { startProofObjection: { not: null }, startProofStatus: "accepted", startProofAcceptedAt: { not: null } }, select: { startProofObjection: true, startProofAcceptedAt: true }, orderBy: { startProofAcceptedAt: "desc" }, take: RESOLVED_SAMPLE });
      return rows.filter((r) => r.startProofObjection?.at).map((r) => r.startProofAcceptedAt.getTime() - new Date(r.startProofObjection.at).getTime());
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
