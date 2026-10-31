// Discovery: how talents find jobs and clients find talents (PRD §4.6; decisions D21 to D25).
// No score and no ranking of people anywhere in here: facts, recently active first, newcomers labelled (D23).
const { prisma: realPrisma } = require("./db");
const { skillByKey, SKILLS } = require("./skills");
const storage = require("./storage");
const { RULES, DAY, capState, shortlistPromiseHours, isNewOnPlatform, invitationExpiry, matchesSearch, responseBucket, HOUR } = require("./discoveryRules");

const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;

const csv = (v) => (typeof v === "string" && v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const num = (v) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

const encodeCursor = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function decodeCursor(c) {
  if (!c) return null;
  try {
    return JSON.parse(Buffer.from(String(c), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** The skills a person is verified in, with when each was first verified. S2 submissions, plus older proof items by category. */
async function verifiedSkills(prisma, userId) {
  const subs = await prisma.skillSubmission.findMany({ where: { userId, status: "verified" }, select: { skillKey: true, decidedAt: true }, orderBy: { decidedAt: "asc" } });
  const out = new Map();
  for (const s of subs) if (!out.has(s.skillKey)) out.set(s.skillKey, s.decidedAt);
  return [...out.entries()].map(([skillKey, at]) => ({ skillKey, label: skillByKey(skillKey)?.label ?? skillKey, verifiedAt: at }));
}

/** Older (pre-S2) verified proof items, as category labels. */
async function legacyVerifiedCategories(prisma, userId) {
  const rows = await prisma.proofItem.findMany({ where: { status: "verified", talentProfile: { userId } }, select: { category: true } });
  return [...new Set(rows.map((r) => r.category))];
}

// ── Jobs: the feed ───────────────────────────────────────

function feedWhere(viewer, f, now) {
  const mine = { clientId: viewer.id };
  const applied = { applications: { some: { talentId: viewer.id } } };
  const visible = {
    postStatus: "live",
    closedAt: null,
    // A job someone was already picked for is not for other talents any more (it stays visible to its owner and applicants).
    awardedApplicationId: null,
    OR: [{ visibility: "public" }, { invitations: { some: { talentId: viewer.id, status: { in: ["pending", "accepted"] }, expiresAt: { gt: now } } } }],
  };
  const and = [{ OR: [visible, mine, applied] }];
  if (f.skills.length) and.push({ skillKey: { in: f.skills } });
  if (f.types.length) and.push({ jobType: { in: f.types } });
  if (f.market === "local") and.push({ currency: "NGN" });
  if (f.market === "international") and.push({ currency: "USD" });
  if (f.budgetMin !== undefined) and.push({ budget: { gte: f.budgetMin } });
  if (f.budgetMax !== undefined) and.push({ budget: { lte: f.budgetMax } });
  if (f.deliveryDaysMax !== undefined) and.push({ deliveryDays: { lte: f.deliveryDaysMax } });
  if (f.verifiedClient) and.push({ client: { identityVerifiedAt: { not: null } } });
  if (f.q) and.push({ OR: [{ title: { contains: f.q, mode: "insensitive" } }, { description: { contains: f.q, mode: "insensitive" } }] });
  if (f.onlyMine) and.push({ clientId: viewer.id });
  // scope=mine: every job the person is a party to (posted, or applied to), whatever its state. The Work and My jobs tabs read this.
  if (f.partyOnly) and.push({ OR: [{ clientId: viewer.id }, { applications: { some: { talentId: viewer.id } } }] });
  return { AND: and };
}

/** A reopened job counts only the applicants since it reopened; one that never reopened is the plain total. */
async function attachOpenCounts(prisma, rows) {
  await Promise.all(rows.filter((r) => r.reopenedAt).map(async (r) => { r._openCount = await prisma.application.count({ where: { jobId: r.id, createdAt: { gte: r.reopenedAt } } }); }));
}

const jobCardInclude = (viewerId) => ({
  client: { select: { id: true, fullName: true, photoPath: true, identityVerifiedAt: true, createdAt: true } },
  _count: { select: { applications: true } },
  applications: { where: { talentId: viewerId }, select: { status: true } },
});

function cardOf(job, viewerId, now) {
  const count = job._count?.applications ?? 0;
  const cap = capState({ applicantCount: job._openCount ?? count, openedAt: job.reopenedAt ?? job.liveAt ?? job.createdAt, now });
  return {
    id: job.id,
    title: job.title,
    // The older fields the app already reads, so the feed stays one shape for old and new screens.
    category: job.category,
    description: job.description,
    closedAt: job.closedAt ?? null,
    revision: job.revision ?? 0,
    awardedApplicationId: job.awardedApplicationId ?? null,
    applicationCount: count,
    createdAt: job.createdAt,
    contract: null,
    skillKey: job.skillKey ?? null,
    skillLabel: job.skillKey ? skillByKey(job.skillKey)?.label ?? job.skillKey : job.category,
    jobType: job.jobType,
    currency: job.currency,
    budget: job.budget.toString(),
    deliveryDays: job.deliveryDays ?? null,
    postStatus: job.postStatus,
    visibility: job.visibility,
    applicantCount: count,
    applicantCap: RULES.applicantCap,
    paused: job.skillKey ? cap.paused : false,
    pausedReason: job.skillKey ? cap.reason : null,
    postedAt: job.liveAt ?? job.createdAt,
    mine: job.clientId === viewerId,
    myApplicationStatus: job.applications?.[0]?.status ?? null,
    closed: Boolean(job.closedAt),
    client: job.client ? { id: job.client.id, fullName: job.client.fullName, photoUrl: storage.avatarPublicUrl(job.client.photoPath), identityVerified: Boolean(job.client.identityVerifiedAt), memberSince: job.client.createdAt } : null,
  };
}

/**
 * The job feed (PRD §3.1 step 7). Server-side filters and paging. With `forYou`, jobs in the talent's verified skills
 * come first (stage "m"), then the rest (stage "o"); within a stage, newest first.
 */
async function feedJobs(viewer, query, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const f = {
    skills: csv(query.skill),
    types: csv(query.type),
    market: query.market,
    budgetMin: num(query.budgetMin),
    budgetMax: num(query.budgetMax),
    deliveryDaysMax: num(query.deliveryDaysMax),
    verifiedClient: query.verifiedClient === "true",
    fewApplicants: query.fewApplicants === "true",
    q: typeof query.q === "string" ? query.q.trim().slice(0, 80) : "",
    onlyMine: query.mine === "true",
    partyOnly: query.scope === "mine",
  };
  const limit = Math.min(PAGE_MAX, Math.max(1, num(query.limit) ?? PAGE_DEFAULT));
  const cursor = decodeCursor(query.cursor);
  const where = feedWhere(viewer, f, now);

  let matchWhere = null;
  if (query.forYou === "true" && viewer.role === "talent") {
    const [skills, categories] = await Promise.all([verifiedSkills(prisma, viewer.id), legacyVerifiedCategories(prisma, viewer.id)]);
    matchWhere = { OR: [{ skillKey: { in: skills.map((s) => s.skillKey) } }, { skillKey: null, category: { in: categories } }] };
  }

  const cards = [];
  let stage = cursor?.s ?? (matchWhere ? "m" : "o");
  let after = cursor?.t ? { t: new Date(cursor.t), id: cursor.id } : null;
  let next = null;

  // Fill a page, moving from the matching stage to the rest when the first runs out. `fewApplicants` is filtered
  // after reading (the count comes with the row), so a page may take a few reads to fill.
  for (let reads = 0; reads < 6 && cards.length < limit; reads++) {
    const stageWhere = stage === "m" ? { AND: [where, matchWhere] } : matchWhere ? { AND: [where, { NOT: matchWhere }] } : where;
    const page = after ? { AND: [stageWhere, { OR: [{ createdAt: { lt: after.t } }, { createdAt: after.t, id: { lt: after.id } }] }] } : stageWhere;
    const rows = await prisma.job.findMany({ where: page, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, include: jobCardInclude(viewer.id) });
    const more = rows.length > limit;
    await attachOpenCounts(prisma, rows);
    for (const row of rows.slice(0, limit)) {
      after = { t: row.createdAt, id: row.id };
      if (f.fewApplicants && (row._count?.applications ?? 0) >= 10) continue;
      cards.push(cardOf(row, viewer.id, now));
      if (cards.length === limit) break;
    }
    if (cards.length >= limit) {
      next = encodeCursor({ s: stage, t: after.t.toISOString(), id: after.id });
      break;
    }
    if (!more) {
      if (stage === "m") {
        stage = "o";
        after = null;
        continue;
      }
      break;
    }
  }
  return { jobs: cards, nextCursor: next };
}

/** Real facts about a client, shown on every job (D19). Review-derived facts (ratings, how fast they review) wait for S7. */
async function clientRecord(prisma, clientId) {
  const [user, posted, hired, completed, paid] = await Promise.all([
    prisma.user.findUnique({ where: { id: clientId }, select: { createdAt: true, identityVerifiedAt: true, clientKind: true } }),
    prisma.job.count({ where: { clientId, postStatus: "live" } }),
    prisma.job.count({ where: { clientId, awardedApplicationId: { not: null } } }),
    prisma.contract.count({ where: { status: "approved", job: { clientId } } }),
    prisma.job.findMany({ where: { clientId, contract: { status: "approved" } }, select: { budget: true, currency: true } }),
  ]);
  const totals = {};
  for (const j of paid) totals[j.currency] = (totals[j.currency] ?? 0) + Number(j.budget);
  return {
    memberSince: user?.createdAt ?? null,
    identityVerified: Boolean(user?.identityVerifiedAt),
    clientKind: user?.clientKind ?? null,
    jobsPosted: posted,
    jobsHired: hired,
    jobsCompleted: completed,
    paidOut: Object.entries(totals).map(([currency, amount]) => ({ currency, amount })),
  };
}

// ── Talents ──────────────────────────────────────────────

const activeBucket = (at, now) => {
  const d = now.getTime() - new Date(at).getTime();
  return d < DAY ? "today" : d < 7 * DAY ? "this_week" : d < 30 * DAY ? "this_month" : "earlier";
};

const talentInclude = {
  talentProfile: { select: { headline: true, bio: true, skillCategories: true } },
  skillSubmissions: { where: { status: "verified" }, select: { skillKey: true, decidedAt: true }, orderBy: { decidedAt: "asc" } },
};

async function talentCard(prisma, user, { viewerId, now }) {
  const seen = new Map();
  for (const s of user.skillSubmissions) if (!seen.has(s.skillKey)) seen.set(s.skillKey, s.decidedAt);
  const verified = [...seen.entries()].map(([skillKey, at]) => ({ skillKey, label: skillByKey(skillKey)?.label ?? skillKey, verifiedAt: at }));
  const stats = await require("./conversations").responseStatsFor(prisma, user.id, now);
  const [completed, saved] = await Promise.all([
    prisma.contract.count({ where: { status: "approved", job: { applications: { some: { talentId: user.id, status: "selected" } } } } }),
    viewerId ? prisma.savedTalent.count({ where: { clientId: viewerId, talentId: user.id } }) : 0,
  ]);
  const first = verified.map((v) => v.verifiedAt).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
  return {
    id: user.id,
    fullName: user.fullName,
    photoUrl: storage.avatarPublicUrl(user.photoPath),
    headline: user.talentProfile?.headline ?? null,
    verifiedSkills: verified,
    region: user.country ? { country: user.country, state: user.state, city: user.city } : null,
    education: user.educationKind ? { kind: user.educationKind, school: user.educationSchool, detail: user.educationDetail } : null,
    completedJobs: completed,
    newOnKingDomain: isNewOnPlatform({ firstVerifiedAt: first, completedJobs: completed, now }),
    lastActive: activeBucket(user.lastActiveAt, now),
    // Shown in buckets and only after 3 conversations; null otherwise. The talent sees how it is worked out (D24).
    responseTime: responseBucket({ medianMinutes: stats.medianMinutes, conversations: stats.conversations }),
    identityVerified: Boolean(user.identityVerifiedAt),
    saved: saved > 0,
  };
}

function talentsWhere(q) {
  const and = [{ role: "talent", deletedAt: null }];
  const skill = q.skill ? skillByKey(q.skill) : null;
  if (q.skill && !skill) and.push({ id: "none" });
  else if (skill) and.push({ OR: [{ skillSubmissions: { some: { skillKey: skill.key, status: "verified" } } }] });
  else and.push({ skillSubmissions: { some: { status: "verified" } } });
  if (q.country) and.push({ country: String(q.country) });
  if (q.state) and.push({ state: String(q.state) });
  if (q.city) and.push({ city: { equals: String(q.city), mode: "insensitive" } });
  if (q.education) and.push({ educationKind: String(q.education) });
  if (q.hasCompleted === "true") and.push({ applications: { some: { status: "selected", job: { contract: { status: "approved" } } } } });
  if (q.q) and.push({ OR: [{ fullName: { contains: String(q.q).slice(0, 60), mode: "insensitive" } }, { talentProfile: { headline: { contains: String(q.q).slice(0, 60), mode: "insensitive" } } }] });
  return { AND: and };
}

/** Browse talents (client side): recently active first, never a score (D23). */
async function browseTalents(viewer, query, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const limit = Math.min(PAGE_MAX, Math.max(1, num(query.limit) ?? PAGE_DEFAULT));
  const cursor = decodeCursor(query.cursor);
  const where = talentsWhere(query);
  const page = cursor ? { AND: [where, { OR: [{ lastActiveAt: { lt: new Date(cursor.t) } }, { lastActiveAt: new Date(cursor.t), id: { lt: cursor.id } }] }] } : where;
  const rows = await prisma.user.findMany({ where: page, orderBy: [{ lastActiveAt: "desc" }, { id: "desc" }], take: limit + 1, include: talentInclude });
  const slice = rows.slice(0, limit);
  const talents = await Promise.all(slice.map((u) => talentCard(prisma, u, { viewerId: viewer.id, now })));
  const last = slice[slice.length - 1];
  return { talents, nextCursor: rows.length > limit && last ? encodeCursor({ t: last.lastActiveAt.toISOString(), id: last.id }) : null };
}

/** One talent as a client sees them: the card, the bio, and the verified pieces with short-lived file links. */
async function talentProfile(viewer, talentId, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const user = await prisma.user.findFirst({ where: { id: talentId, role: "talent", deletedAt: null }, include: talentInclude });
  if (!user) return null;
  const card = await talentCard(prisma, user, { viewerId: viewer.id, now });
  const subs = await prisma.skillSubmission.findMany({
    where: { userId: talentId, status: "verified" },
    orderBy: { decidedAt: "desc" },
    include: { pieces: { orderBy: { position: "asc" }, include: { files: { where: { role: "output", status: "ready" } } } } },
  });
  const work = await Promise.all(
    subs.map(async (s) => ({
      skillKey: s.skillKey,
      skillLabel: skillByKey(s.skillKey)?.label ?? s.skillKey,
      verifiedAt: s.decidedAt,
      pieces: await Promise.all(
        s.pieces.map(async (p) => ({
          id: p.id,
          title: p.title,
          brief: p.brief,
          role: p.role,
          madeOn: p.madeOn,
          liveLink: p.liveLink || null,
          files: await Promise.all(p.files.slice(0, 3).map(async (f) => ({ name: f.name, contentType: f.contentType, url: storage.privateUploadsConfigured ? await storage.presignPrivateGet(f.objectKey, 300) : null }))),
        })),
      ),
    })),
  );
  return { talent: { ...card, bio: user.talentProfile?.bio ?? null }, work };
}

// ── Invitations ──────────────────────────────────────────

const notify = (userId, message) => {
  try {
    return require("./push").notifyUser(userId, message).catch(() => {});
  } catch {
    return Promise.resolve();
  }
};

async function invite({ clientId, jobId, talentId, message }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const fail = (status, code, error) => ({ ok: false, status, code, error });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clientId !== clientId) return fail(404, "not_found", "Job not found.");
  if (!job.skillKey) return fail(400, "not_supported", "This job was posted before invitations existed.");
  if (job.postStatus !== "live" || job.closedAt || job.awardedApplicationId) return fail(409, "not_open", "You can only invite people to a job that is live and open.");
  const talent = await prisma.user.findFirst({ where: { id: talentId, role: "talent", deletedAt: null } });
  if (!talent) return fail(404, "not_found", "Talent not found.");
  if (!(await verifiedSkills(prisma, talentId)).some((s) => s.skillKey === job.skillKey)) return fail(400, "not_verified", "They are not verified in this job's skill.");
  const text = typeof message === "string" ? message.trim().slice(0, 400) : "";
  if (require("./safety").detectRisk(text).length) return fail(400, "risky_message", "Keep contact details, links and payment talk out of the invitation. Everything happens inside King Domain.");
  if ((await prisma.invitation.count({ where: { jobId } })) >= RULES.invitationsPerJob) return fail(409, "limit", `You can invite up to ${RULES.invitationsPerJob} people to one job.`);
  try {
    const made = await prisma.invitation.create({ data: { jobId, clientId, talentId, message: text || null, expiresAt: invitationExpiry(now) } });
    await notify(talentId, { title: "You've been invited to a job", body: job.title, data: { type: "invitation", jobId } });
    return { ok: true, invitation: made };
  } catch (err) {
    if (err.code === "P2002") return fail(409, "already_invited", "You've already invited this person to this job.");
    throw err;
  }
}

/** A talent's invitations, with the ones past 72 hours marked expired first. */
async function invitationsFor(userId, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  await prisma.invitation.updateMany({ where: { talentId: userId, status: "pending", expiresAt: { lte: now } }, data: { status: "expired" } });
  const rows = await prisma.invitation.findMany({
    where: { talentId: userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { job: { include: jobCardInclude(userId) }, client: { select: { fullName: true } } },
  });
  return rows.map((i) => ({ id: i.id, status: i.status, message: i.message, expiresAt: i.expiresAt, createdAt: i.createdAt, from: i.client.fullName, job: cardOf(i.job, userId, now) }));
}

// ── Saved searches and alerts ────────────────────────────

/** A job just went live: tell every talent whose saved search matches it (once per person), free for everyone. */
async function alertSavedSearches(job, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  if (!job.skillKey || job.visibility !== "public") return { alerted: 0 };
  const searches = await prisma.savedSearch.findMany({ where: { alerts: true, user: { role: "talent", deletedAt: null } } });
  const seen = new Set();
  let alerted = 0;
  for (const s of searches) {
    if (seen.has(s.userId) || s.userId === job.clientId) continue;
    if (!matchesSearch(s.filters, job)) continue;
    seen.add(s.userId);
    await (deps.notify ?? notify)(s.userId, { title: `New job: ${job.title}`, body: `Matches your saved search "${s.name}"`, data: { type: "job_alert", jobId: job.id } });
    alerted++;
  }
  console.log(`discovery: job=${job.id} alerts sent=${alerted} of ${searches.length} saved searches checked`);
  return { alerted };
}

function validateSearch(body) {
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) return { ok: false, error: "Name the search so you can recognise it." };
  const f = body?.filters && typeof body.filters === "object" ? body.filters : {};
  const filters = {};
  if (Array.isArray(f.skillKeys)) filters.skillKeys = f.skillKeys.filter((k) => SKILLS.some((s) => s.key === k));
  if (Array.isArray(f.jobTypes)) filters.jobTypes = f.jobTypes.filter((t) => require("./briefs").JOB_TYPES.includes(t));
  if (["NGN", "USD"].includes(f.currency)) filters.currency = f.currency;
  for (const k of ["budgetMin", "budgetMax", "deliveryDaysMax"]) if (num(f[k]) !== undefined) filters[k] = num(f[k]);
  if (typeof f.query === "string" && f.query.trim()) filters.query = f.query.trim().slice(0, 80);
  if (!Object.keys(filters).length) return { ok: false, error: "Choose at least one filter to save." };
  return { ok: true, value: { name, filters, alerts: body?.alerts !== false } };
}

// ── Shortlist service ("find someone for me", D24) ───────

/** The promise shown to clients: the 90th percentile of how long the last 20 shortlists took, or null while there is too little to say. */
async function shortlistPromise(deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const rows = await prisma.shortlistRequest.findMany({ where: { status: "sent", sentAt: { not: null } }, orderBy: { sentAt: "desc" }, take: RULES.promiseSample, select: { clockStartedAt: true, sentAt: true } });
  const hours = rows.map((r) => (r.sentAt.getTime() - r.clockStartedAt.getTime()) / HOUR);
  return { hours: shortlistPromiseHours(hours), basedOn: rows.length };
}

module.exports = {
  attachOpenCounts,
  PAGE_DEFAULT,
  verifiedSkills,
  legacyVerifiedCategories,
  feedJobs,
  cardOf,
  jobCardInclude,
  clientRecord,
  browseTalents,
  talentProfile,
  talentCard,
  talentInclude,
  invite,
  invitationsFor,
  alertSavedSearches,
  validateSearch,
  shortlistPromise,
  notify,
};

// ── Applicants (client side) ─────────────────────────────

/**
 * What a client sees for one applicant: the facts panel (no score), the pieces they chose with short-lived links,
 * their answer and their answers to the screening questions. In the order they applied, never ranked.
 */
async function applicantPanel(application, job, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const user = await prisma.user.findUnique({ where: { id: application.talentId }, include: talentInclude });
  const card = await talentCard(prisma, user, { viewerId: job.clientId, now });
  const chosen = Array.isArray(application.pieces) ? application.pieces : [];
  const pieces = await Promise.all(
    chosen.map(async (c) => {
      if (c.type === "piece") {
        const p = await prisma.submissionPiece.findUnique({ where: { id: c.id }, include: { files: { where: { role: "output", status: "ready" } } } });
        if (!p) return null;
        return { type: "piece", id: p.id, title: p.title, brief: p.brief, role: p.role, madeOn: p.madeOn, liveLink: p.liveLink || null, files: await Promise.all(p.files.slice(0, 3).map(async (f) => ({ name: f.name, contentType: f.contentType, url: storage.privateUploadsConfigured ? await storage.presignPrivateGet(f.objectKey, 300) : null }))) };
      }
      const proof = await prisma.proofItem.findUnique({ where: { id: c.id } });
      if (!proof) return null;
      return { type: "proof", id: proof.id, title: proof.title, brief: "", role: "", madeOn: "", liveLink: null, files: proof.filePath ? [{ name: proof.title, contentType: "application/octet-stream", url: await storage.getProofFileSignedUrl(proof.filePath) }] : [] };
    }),
  );
  const questions = Array.isArray(job.screeningQuestions) ? job.screeningQuestions : [];
  const answers = Array.isArray(application.screeningAnswers) ? application.screeningAnswers : [];
  return {
    id: application.id,
    status: application.status,
    appliedAt: application.createdAt,
    declinedAt: application.declinedAt,
    invited: Boolean(application.invitationId),
    talent: card,
    answer: application.answer,
    screening: questions.map((q, i) => ({ question: q, answer: answers[i] ?? "" })),
    pieces: pieces.filter(Boolean),
  };
}

module.exports.applicantPanel = applicantPanel;
