// Shared by the contract modules: the agreed numbers, the event trail and
// injectable dependencies. Kept apart from contractLifecycle.js so the
// stage 2 modules and the lifecycle orchestrator can all use it without a
// circular require.
const { prisma: realPrisma } = require("./db");
const realMailer = require("./admin/mailer");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Shareholder decision "How a job gets paid" (ledger 736051b0), stage 2. */
const RULES = {
  reviewMs: 3 * DAY,
  deliveryDays: { min: 1, max: 60 },
  maxExtensionRequests: 2,
  extensionAnswerMs: 48 * HOUR,
  maxChangeRounds: 2,
  changeResubmitMs: 3 * DAY,
  overdueGraceMs: 3 * DAY,
  reasonLength: { min: 10, max: 1000 },
  // A release that crashed mid-way stops blocking after this; the next
  // release still reuses any transfer the crash left live.
  releaseClaimStaleMs: 10 * 60 * 1000,
};

/**
 * Auto-release pays the talent when the client says nothing. Only fair once
 * the client can object AND an objection can be resolved (stage 3), so it
 * stays off until switched on deliberately.
 */
function autoReleaseEnabled() {
  return process.env.AUTO_RELEASE_ENABLED === "true";
}

function baseDeps(deps = {}) {
  return {
    prisma: deps.prisma ?? realPrisma,
    mailer: deps.mailer ?? realMailer,
    now: deps.now ?? (() => new Date()),
  };
}

function recordEvent(db, { jobId, contractId, type, meta }) {
  return db.contractEvent.create({ data: { jobId, contractId, type, meta: meta ?? undefined } });
}

/** A refused action or a lost race, in the shape the routes return. */
function refuse(status, code, error) {
  return { ok: false, status, code, error };
}

function validReason(reason) {
  if (typeof reason !== "string") return false;
  const length = reason.trim().length;
  return length >= RULES.reasonLength.min && length <= RULES.reasonLength.max;
}

/** The job, its client and the awarded talent (for emails). */
async function parties(prisma, contract) {
  const job = contract.job ?? (await prisma.job.findUnique({ where: { id: contract.jobId } }));
  const [client, application] = await Promise.all([
    prisma.user.findUnique({ where: { id: job.clientId } }),
    job.awardedApplicationId
      ? prisma.application.findUnique({ where: { id: job.awardedApplicationId }, include: { talent: true } })
      : null,
  ]);
  return { job, client, talent: application?.talent ?? null };
}

module.exports = { HOUR, DAY, RULES, autoReleaseEnabled, baseDeps, recordEvent, refuse, validReason, parties };
