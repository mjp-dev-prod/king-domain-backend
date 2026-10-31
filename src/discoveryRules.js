// Rules of discovery that need no database (PRD §4.6; decisions D21 to D25). Small pure functions, so each rule
// can be tested and argued with on its own.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const RULES = {
  applicantCap: 50,
  openDays: 5,
  invitationsPerJob: 20,
  invitationHours: 72,
  newDays: 30,
  promiseSample: 20,
  promiseMinSamples: 5,
  responseMinConversations: 3,
};

/**
 * Whether a job still takes applications (D21). It pauses at 50 applicants or 5 days after it went live or was last
 * reopened; the client reopens it. `openedAt` is when it went live or was reopened.
 */
function capState({ applicantCount, openedAt, now = new Date(), cap = RULES.applicantCap, days = RULES.openDays }) {
  if (applicantCount >= cap) return { paused: true, reason: "applicants", opensLeft: 0 };
  if (now.getTime() - new Date(openedAt).getTime() >= days * DAY) return { paused: true, reason: "days", opensLeft: 0 };
  return { paused: false, reason: null, opensLeft: cap - applicantCount };
}

/** Nearest-rank percentile; null when there is no data. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

/**
 * The shortlist promise (D24): the 90th percentile of the delivery times of the last 20 shortlists, in whole hours,
 * so it is kept 9 times in 10. Null until there are enough shortlists to say anything honest.
 */
function shortlistPromiseHours(deliveryHours) {
  const last = deliveryHours.slice(0, RULES.promiseSample);
  if (last.length < RULES.promiseMinSamples) return null;
  return Math.max(1, Math.ceil(percentile(last, 90)));
}

/** "New on King Domain": verified recently and nothing completed yet. A fact on the card, never a sort order (D23). */
function isNewOnPlatform({ firstVerifiedAt, completedJobs, now = new Date() }) {
  if (!firstVerifiedAt || completedJobs > 0) return false;
  return now.getTime() - new Date(firstVerifiedAt).getTime() <= RULES.newDays * DAY;
}

/** A talent's response time in buckets, shown only after enough conversations (D24). Input: median minutes. */
function responseBucket({ medianMinutes, conversations }) {
  if (conversations < RULES.responseMinConversations || medianMinutes === null || medianMinutes === undefined) return null;
  if (medianMinutes <= 60) return { key: "hour", label: "within an hour" };
  if (medianMinutes <= 6 * 60) return { key: "hours", label: "within a few hours" };
  if (medianMinutes <= 24 * 60) return { key: "day", label: "within a day" };
  return { key: "slow", label: "more than a day" };
}

/** When an invitation sent now stops being valid. */
function invitationExpiry(now = new Date()) {
  return new Date(now.getTime() + RULES.invitationHours * HOUR);
}

/**
 * Whether a saved search matches a job that just went live. `filters` is what the talent saved: skillKeys, jobTypes,
 * budgetMin, budgetMax, currency, deliveryDaysMax, query. An empty filter matches everything it does not mention.
 */
function matchesSearch(filters, job) {
  const f = filters ?? {};
  if (f.skillKeys?.length && !f.skillKeys.includes(job.skillKey)) return false;
  if (f.jobTypes?.length && !f.jobTypes.includes(job.jobType)) return false;
  if (f.currency && f.currency !== job.currency) return false;
  const budget = Number(job.budget);
  if (f.budgetMin !== undefined && f.budgetMin !== null && budget < Number(f.budgetMin)) return false;
  if (f.budgetMax !== undefined && f.budgetMax !== null && budget > Number(f.budgetMax)) return false;
  if (f.deliveryDaysMax && job.deliveryDays && job.deliveryDays > Number(f.deliveryDaysMax)) return false;
  if (f.query && !`${job.title} ${job.description}`.toLowerCase().includes(String(f.query).toLowerCase())) return false;
  return true;
}

module.exports = { RULES, HOUR, DAY, capState, percentile, shortlistPromiseHours, isNewOnPlatform, responseBucket, invitationExpiry, matchesSearch };
