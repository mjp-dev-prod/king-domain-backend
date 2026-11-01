// Reputation as facts, not scores (PRD §4.8; D29 to D32). No star averages, no rank: the system's own measurements per
// job (on time, change rounds, extensions, disputes), the other side's specific answers as plain counts, recent first,
// and a Proven level per skill earned through real King Domain jobs.
//
// Private answers (D31) are never read here except by `recheckSignal`, which only ever returns a yes/no for the team.
const { prisma: realPrisma } = require("./db");
const { DAY, HOUR } = require("./contractCore");
const { skillByKey } = require("./skills");

const REVIEW_WINDOW_MS = 14 * DAY;
const PROVEN_JOBS = 3;
const REMOVAL_REASONS = [
  { code: "abuse", label: "Threats or abuse" },
  { code: "personal_info", label: "Personal information" },
  { code: "unrelated", label: "Not about the work" },
  { code: "leverage", label: "Used as leverage (a bad review unless something extra is done)" },
];

const TRIPLE = ["yes", "partly", "no"];

/** The questions each side answers. No stars: specific, and a recommendation. */
const QUESTIONS = {
  client_to_talent: [
    { key: "followedBrief", label: "Did they follow the brief?", kind: "triple" },
    { key: "qualityAsAgreed", label: "Did the quality meet what was agreed?", kind: "triple" },
    { key: "communicated", label: "Did they communicate well?", kind: "triple" },
    { key: "recommend", label: "Would you recommend them?", kind: "bool" },
  ],
  talent_to_client: [
    { key: "briefClear", label: "Was the brief clear?", kind: "triple" },
    { key: "feedbackClear", label: "Was the feedback clear and on time?", kind: "triple" },
    { key: "paidFairly", label: "Did they pay and approve fairly?", kind: "triple" },
    { key: "recommend", label: "Would you recommend working with them?", kind: "bool" },
  ],
};
const PRIVATE_QUESTION = "Would you work with this person again? Only King Domain sees this answer.";

/** Checks a review's answers against the questions for its direction. Returns { ok, answers } or { ok: false, error }. */
function validateReview({ direction, answers, comment, privateAgain }) {
  const qs = QUESTIONS[direction];
  if (!qs) return { ok: false, error: "Unknown kind of review." };
  const clean = {};
  for (const q of qs) {
    const v = answers?.[q.key];
    if (q.kind === "triple" && !TRIPLE.includes(v)) return { ok: false, error: `Answer: ${q.label}` };
    if (q.kind === "bool" && typeof v !== "boolean") return { ok: false, error: `Answer: ${q.label}` };
    clean[q.key] = v;
  }
  if (typeof privateAgain !== "boolean") return { ok: false, error: "Answer the private question too." };
  const text = typeof comment === "string" ? comment.trim() : "";
  if (text.length > 1000) return { ok: false, error: "Keep the comment under 1000 characters." };
  return { ok: true, answers: clean, comment: text, privateAgain };
}

/** When a contract counts as completed for reviews: paid out on approval, or settled with the talent paid something. */
function completedAt(contract) {
  if (contract.status === "approved") return contract.transferredAt ?? contract.updatedAt ?? null;
  if (contract.status === "resolved" && Number(contract.settlement?.talentAmount ?? 0) > 0) return contract.settledAt ?? null;
  return null;
}

/** A pair of reviews is visible to others once both are in, or the window has closed. */
function isRevealed(reviews, windowEndsAt, now = new Date()) {
  // A review that was later removed still counts as "in", so removing one never un-hides or hides the other.
  const sides = new Set(reviews.map((r) => r.direction));
  return sides.size >= 2 || now >= windowEndsAt;
}

/** Measured from timestamps, not opinions. `deliveries` is the contract's ContractDelivery rows. */
function jobFacts(contract, deliveries = []) {
  const first = deliveries.slice().sort((a, b) => a.version - b.version)[0] ?? null;
  const onTime = first && contract.deliverByAt ? first.submittedAt <= contract.deliverByAt : null;
  const lateMs = first && contract.deliverByAt && first.submittedAt > contract.deliverByAt ? first.submittedAt - contract.deliverByAt : 0;
  const startProofHours = contract.startProofSubmittedAt && contract.fundedAt ? Math.max(0, Math.round((contract.startProofSubmittedAt - contract.fundedAt) / HOUR)) : null;
  return {
    startProofHours,
    deliveredOnTime: onTime,
    daysLate: lateMs > 0 ? Math.ceil(lateMs / DAY) : 0,
    changeRounds: contract.changeRounds ?? 0,
    extensionsUsed: contract.extensionsUsed ?? 0,
    outcome: contract.status === "approved" ? "completed" : "settled",
  };
}

/** What a viewer may read of a review: the public answers, never the private one. */
function publicReview(r, { job, facts }) {
  return {
    id: r.id,
    direction: r.direction,
    jobTitle: job.title,
    skillKey: job.skillKey ?? null,
    skillLabel: job.skillKey ? skillByKey(job.skillKey)?.label ?? job.skillKey : job.category,
    at: r.createdAt,
    answers: r.answers,
    comment: r.comment,
    reply: r.reply,
    repliedAt: r.repliedAt,
    facts: facts ?? null,
  };
}

const twelveMonthsAgo = (now) => new Date(now.getTime() - 365 * DAY);

/**
 * Everything a profile shows about a talent's work on King Domain: plain counts per skill, the visible reviews with
 * their facts (recent first, the last 12 months leading), and the Proven level per skill.
 */
async function talentReputation(talentId, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const contracts = await prisma.contract.findMany({
    where: { job: { applications: { some: { talentId, status: "selected" } } }, status: { in: ["approved", "resolved"] } },
    include: { job: true, deliveries: true, disputes: true },
    orderBy: { updatedAt: "desc" },
    take: 300,
  });
  const done = contracts.filter((c) => completedAt(c));
  const reviews = done.length ? await prisma.review.findMany({ where: { contractId: { in: done.map((c) => c.id) } } }) : [];
  const bySubject = new Map();
  for (const r of reviews) {
    const list = bySubject.get(r.contractId) ?? [];
    list.push(r);
    bySubject.set(r.contractId, list);
  }

  const perSkill = new Map();
  const visible = [];
  for (const c of done) {
    const facts = jobFacts(c, c.deliveries);
    const key = c.job.skillKey ?? `cat:${c.job.category}`;
    const row = perSkill.get(key) ?? { skillKey: c.job.skillKey ?? null, skillLabel: c.job.skillKey ? skillByKey(c.job.skillKey)?.label ?? c.job.skillKey : c.job.category, jobs: 0, onTime: 0, reviewed: 0, recommend: 0 };
    row.jobs++;
    if (facts.deliveredOnTime === true) row.onTime++;
    const pair = bySubject.get(c.id) ?? [];
    const windowEnds = pair[0]?.windowEndsAt ?? new Date(completedAt(c).getTime() + REVIEW_WINDOW_MS);
    const revealed = isRevealed(pair, windowEnds, now);
    const mine = pair.find((r) => r.direction === "client_to_talent");
    if (mine && revealed && !mine.removedAt) {
      row.reviewed++;
      if (mine.answers?.recommend === true) row.recommend++;
      visible.push({ ...publicReview(mine, { job: c.job, facts }), older: mine.createdAt < twelveMonthsAgo(now) });
    }
    perSkill.set(key, row);
  }
  visible.sort((a, b) => new Date(b.at) - new Date(a.at));

  const lostDisputes = contracts.reduce((n, c) => n + c.disputes.filter((d) => d.loserId === talentId).length, 0);
  const verified = await prisma.skillSubmission.findMany({ where: { userId: talentId, status: "verified" }, select: { skillKey: true } });
  const proven = [];
  for (const skillKey of [...new Set(verified.map((v) => v.skillKey))]) proven.push(await provenState(talentId, skillKey, { prisma, now, contracts, reviews }));

  return {
    completedJobs: done.length,
    lostDisputes,
    skills: [...perSkill.values()],
    reviews: visible.slice(0, 30),
    reviewCount: visible.length,
    proven,
  };
}

/**
 * Proven, per skill (D32): 3 completed jobs in the skill, none lost in a dispute, all delivered on time (an extension the
 * client granted counts as on time), and every client said they would recommend. Returns what is met and what is not,
 * so the talent can see exactly what is left.
 */
async function provenState(talentId, skillKey, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const contracts = (deps.contracts ?? (await prisma.contract.findMany({ where: { job: { applications: { some: { talentId, status: "selected" } } }, status: { in: ["approved", "resolved"] } }, include: { job: true, deliveries: true, disputes: true }, take: 300 }))).filter((c) => c.job.skillKey === skillKey);
  const done = contracts.filter((c) => completedAt(c));
  const reviews = deps.reviews ?? (done.length ? await prisma.review.findMany({ where: { contractId: { in: done.map((c) => c.id) } } }) : []);

  const onTimeAll = done.length > 0 && done.every((c) => jobFacts(c, c.deliveries).deliveredOnTime === true);
  const lost = contracts.reduce((n, c) => n + c.disputes.filter((d) => d.loserId === talentId).length, 0);
  let recommendAll = done.length > 0;
  let reviewedCount = 0;
  for (const c of done) {
    const pair = reviews.filter((r) => r.contractId === c.id);
    const windowEnds = pair[0]?.windowEndsAt ?? new Date(completedAt(c).getTime() + REVIEW_WINDOW_MS);
    const mine = pair.find((r) => r.direction === "client_to_talent");
    const revealed = isRevealed(pair, windowEnds, now);
    if (mine && revealed && !mine.removedAt && mine.answers?.recommend === true) reviewedCount++;
    else recommendAll = false;
  }
  const unmet = [];
  if (done.length < PROVEN_JOBS) unmet.push(`${PROVEN_JOBS - done.length} more completed job${PROVEN_JOBS - done.length === 1 ? '' : 's'} in this skill`);
  if (done.length > 0 && !onTimeAll) unmet.push("Every job delivered on time");
  if (lost > 0) unmet.push("No dispute lost");
  if (done.length > 0 && !recommendAll) unmet.push("Every client recommending you");
  return {
    skillKey,
    skillLabel: skillByKey(skillKey)?.label ?? skillKey,
    proven: done.length >= PROVEN_JOBS && onTimeAll && lost === 0 && recommendAll,
    completed: done.length,
    needed: PROVEN_JOBS,
    recommended: reviewedCount,
    unmet,
  };
}

/**
 * Whether the signal has turned bad enough for the team to re-check a skill (research 5.7): two lost disputes in the
 * skill, or two private "no" answers from different clients. Returns only a yes/no; the private answers stay private.
 */
async function recheckSignal(talentId, skillKey, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const contracts = await prisma.contract.findMany({ where: { job: { skillKey, applications: { some: { talentId, status: "selected" } } }, status: { in: ["approved", "resolved"] } }, include: { disputes: true } });
  const lost = contracts.reduce((n, c) => n + c.disputes.filter((d) => d.loserId === talentId).length, 0);
  const noAnswers = contracts.length ? await prisma.review.count({ where: { contractId: { in: contracts.map((c) => c.id) }, authorId: { not: talentId }, privateAgain: false, removedAt: null } }) : 0;
  return lost >= 2 || noAnswers >= 2;
}

/** What a talent's answers say about a client, as plain counts, plus the client's own measured habits (D19). */
async function clientReputation(clientId, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const contracts = await prisma.contract.findMany({
    where: { job: { clientId }, status: { in: ["approved", "resolved"] } },
    include: { job: true, deliveries: true, disputes: true },
    orderBy: { updatedAt: "desc" },
    take: 300,
  });
  const done = contracts.filter((c) => completedAt(c));
  const reviews = done.length ? await prisma.review.findMany({ where: { contractId: { in: done.map((c) => c.id) }, direction: "talent_to_client", removedAt: null } }) : [];
  const all = done.length ? await prisma.review.findMany({ where: { contractId: { in: done.map((c) => c.id) } }, select: { contractId: true, direction: true, windowEndsAt: true } }) : [];

  const tally = { reviewed: 0, briefClear: 0, feedbackClear: 0, paidFairly: 0, recommend: 0 };
  const recent = [];
  for (const r of reviews) {
    const pair = all.filter((x) => x.contractId === r.contractId);
    if (!isRevealed(pair, r.windowEndsAt, now)) continue;
    tally.reviewed++;
    if (r.answers?.briefClear === "yes") tally.briefClear++;
    if (r.answers?.feedbackClear === "yes") tally.feedbackClear++;
    if (r.answers?.paidFairly === "yes") tally.paidFairly++;
    if (r.answers?.recommend === true) tally.recommend++;
    const c = done.find((x) => x.id === r.contractId);
    recent.push({ ...publicReview(r, { job: c.job, facts: null }), older: r.createdAt < twelveMonthsAgo(now) });
  }
  recent.sort((a, b) => new Date(b.at) - new Date(a.at));

  // How fast they review: hours from the first delivery to being paid out (an automatic release counts as the full wait).
  const waits = done
    .filter((c) => c.status === "approved" && c.transferredAt && c.deliveries.length)
    .map((c) => (c.transferredAt - c.deliveries.slice().sort((a, b) => a.version - b.version)[0].submittedAt) / HOUR)
    .sort((a, b) => a - b);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  const rounds = done.length ? done.reduce((n, c) => n + (c.changeRounds ?? 0), 0) / done.length : null;
  const disputesLost = contracts.reduce((n, c) => n + c.disputes.filter((d) => d.loserId === clientId).length, 0);

  return {
    tally,
    reviews: recent.slice(0, 30),
    reviewCount: recent.length,
    reviewHoursMedian: median === null ? null : Math.round(median),
    changeRoundsPerJob: rounds === null ? null : Math.round(rounds * 10) / 10,
    disputesLost,
    jobsDone: done.length,
  };
}

module.exports = {
  REVIEW_WINDOW_MS,
  PROVEN_JOBS,
  REMOVAL_REASONS,
  QUESTIONS,
  PRIVATE_QUESTION,
  validateReview,
  completedAt,
  isRevealed,
  jobFacts,
  publicReview,
  talentReputation,
  clientReputation,
  provenState,
  recheckSignal,
};
