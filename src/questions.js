// Asking a client a question before applying: a premium feature for talents (PRD §4.7; D28, D38). The answer is added to the
// job for every applicant, so information is never paywalled, and asking buys no better place than anyone else. Before an
// award nobody gives contact details or takes payment outside King Domain (D18), so questions and answers are screened like
// everything else typed before award.
const { prisma: realPrisma } = require("./db");
const safety = require("./safety");
const premium = require("./premium");

const MAX_PER_TALENT = 3;
const fail = (status, code, error) => ({ ok: false, status, code, error });

async function notify(userId, message) {
  if (!userId) return;
  try {
    await require("./discovery").notify(userId, message);
  } catch {
    // A push is a courtesy.
  }
}

async function ask({ jobId, talentId, question }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.postStatus !== "live" || job.closedAt || job.awardedApplicationId) return fail(404, "not_open", "This job isn't taking questions.");
  if (job.visibility === "invite") {
    const invited = await prisma.invitation.findFirst({ where: { jobId, talentId } });
    const applied = await prisma.application.findFirst({ where: { jobId, talentId } });
    if (!invited && !applied) return fail(404, "not_open", "This job isn't taking questions.");
  }
  if (job.clientId === talentId) return fail(400, "own_job", "That's your own job.");
  const text = typeof question === "string" ? question.trim() : "";
  if (text.length < 10 || text.length > 300) return fail(400, "invalid", "Write your question in 10 to 300 characters.");
  const flags = safety.detectRisk(text);
  if (flags.length) return fail(400, "flagged", `Keep it about the job: no contact details, links or payment outside King Domain (${flags.map((f) => f.label.toLowerCase()).join(", ")}).`);
  const count = await prisma.preApplyQuestion.count({ where: { jobId, talentId } });
  if (count >= MAX_PER_TALENT) return fail(409, "too_many", `You can ask up to ${MAX_PER_TALENT} questions on a job.`);

  const used = await premium.use({ userId: talentId, feature: "pre_apply_question", usedOn: jobId }, deps);
  if (used.ok === false) return used;
  const row = await prisma.preApplyQuestion.create({ data: { jobId, talentId, question: text, entitlementId: used.entitlement?.id ?? null } });
  await notify(job.clientId, { title: "A talent has a question", body: `${job.title}: your answer will be shown to everyone who applies.`, data: { type: "question", jobId } });
  console.log(`questions: asked question=${row.id} job=${jobId} talent=${talentId} free=${Boolean(used.free)}`);
  return { ok: true, question: row };
}

async function answer({ questionId, clientId, answer: text }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const q = await prisma.preApplyQuestion.findUnique({ where: { id: questionId } });
  if (!q) return fail(404, "not_found", "Question not found.");
  const job = await prisma.job.findUnique({ where: { id: q.jobId } });
  if (!job || job.clientId !== clientId) return fail(404, "not_found", "Question not found.");
  if (q.answer) return fail(409, "answered", "You already answered this one.");
  const body = typeof text === "string" ? text.trim() : "";
  if (body.length < 2 || body.length > 600) return fail(400, "invalid", "Write an answer of 2 to 600 characters.");
  const flags = safety.detectRisk(body);
  if (flags.length) return fail(400, "flagged", `Keep it about the job: no contact details, links or payment outside King Domain (${flags.map((f) => f.label.toLowerCase()).join(", ")}).`);
  const done = await prisma.preApplyQuestion.updateMany({ where: { id: questionId, answer: null }, data: { answer: body, answeredAt: new Date() } });
  if (done.count !== 1) return fail(409, "answered", "You already answered this one.");
  await notify(q.talentId, { title: "Your question was answered", body: `${job.title}: the answer is on the job for everyone.`, data: { type: "question", jobId: q.jobId } });
  console.log(`questions: answered question=${questionId} job=${q.jobId} readBack.answered=${Boolean((await prisma.preApplyQuestion.findUnique({ where: { id: questionId } })).answer)}`);
  return { ok: true };
}

/**
 * What a person may read on a job. Answered questions are for everyone, without names (information is never paywalled).
 * The client also sees the ones still waiting, and the asker sees their own.
 */
async function listFor({ jobId, viewerId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
  if (!job) return null;
  const rows = await prisma.preApplyQuestion.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  const isClient = job.clientId === viewerId;
  return rows
    .filter((r) => r.answer || isClient || r.talentId === viewerId)
    .map((r) => ({ id: r.id, question: r.question, answer: r.answer, askedAt: r.createdAt, answeredAt: r.answeredAt, mine: r.talentId === viewerId, canAnswer: isClient && !r.answer }));
}

module.exports = { MAX_PER_TALENT, ask, answer, listFor };
