// The start proof and the 20% release (PRD §4.2; decisions D2, D8, D35).
//
// After a job is funded, the talent starts and sends a START PROOF in the skill's fixed format. The client has 24
// hours to accept or object (silence accepts). On acceptance 20% of the price goes to the talent at once; the other
// 80% is paid on approval as before. An objection is checked by a person against a checklist, never for quality.
// If the talent then abandons the job, the client keeps the start-proof work and gets the other 80% back; the 20%
// is not refunded, and this is said before payment (the refund itself belongs to disputes, S6).
//
// Money moves here, so everything follows the final payout's pattern (src/contractLifecycle.js releasePayment):
// claim first, one reference per attempt, never start a second transfer on top of a live one, record what happened.
const { prisma: realPrisma } = require("./db");
const realPaystack = require("./paystack");
const { HOUR, recordEvent } = require("./contractCore");
const { skillByKey } = require("./skills");
const storage = require("./storage");

const UPFRONT_SHARE = 0.2;
const DECISION_WINDOW_MS = 24 * HOUR;
const CLAIM_STALE_MS = 10 * 60 * 1000;
const LIVE_TRANSFER_STATUSES = new Set(["success", "pending", "otp", "received"]);

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const FILE_TYPES = [...IMAGE_TYPES, ...VIDEO_TYPES, "application/pdf", "application/zip", "application/x-zip-compressed", "text/plain", "application/octet-stream", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
const EXECUTABLE = /\.(?:apk|exe|bat|msi|scr|cmd|com|jar|dmg|sh|ps1|vbs)$/i;
const MB = 1024 * 1024;

/** What the client may object for. A checklist, not a taste test (D8): quality is never grounds. */
const OBJECTION_REASONS = [
  { code: "missing_part", label: "A required part is missing" },
  { code: "wrong_format", label: "It is not in the agreed format" },
  { code: "wrong_work", label: "It is not about this job" },
  { code: "not_their_work", label: "It does not look like their own work" },
  { code: "unreadable", label: "I can't open or read it" },
];

/** 20% of the price in naira, to the kobo. */
const upfrontAmountOf = (budget) => Math.round(Number(budget) * UPFRONT_SHARE * 100) / 100;

const fail = (status, code, error) => ({ ok: false, status, code, error });

/** The fields the skill asks for in its start proof (src/skills.js). */
function specFor(skillKey) {
  return skillByKey(skillKey)?.startProof ?? [];
}

const validUrl = (v) => typeof v === "string" && /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v.trim());

/** Whether a file of this field kind is acceptable by type. */
function typeAllowed(kind, contentType) {
  if (kind === "image") return IMAGE_TYPES.includes(contentType);
  if (kind === "video") return VIDEO_TYPES.includes(contentType);
  if (kind === "files") return FILE_TYPES.includes(contentType);
  return false;
}

/**
 * Checks a round's items against the skill's format. Returns { ok, missing: [{ key, label, problem }] } where each
 * missing entry says plainly what is short, so the talent sees exactly what to add before they can send.
 */
function checkProof(skillKey, items) {
  const missing = [];
  for (const f of specFor(skillKey)) {
    const mine = items.filter((i) => i.fieldKey === f.key && i.status === "ready");
    const usable = f.kind === "text" ? mine.filter((i) => (i.text ?? "").trim().length >= 20) : f.kind === "link" ? mine.filter((i) => validUrl(i.text)) : mine;
    if (usable.length < f.min) {
      const what = f.kind === "text" ? "write it (at least 20 characters)" : f.kind === "link" ? "add a link starting with http:// or https://" : `add ${f.min === 1 ? "one" : f.min}`;
      missing.push({ key: f.key, label: f.label, problem: f.kind === "text" || f.kind === "link" ? `${f.label}: ${what}` : `${f.label}: ${what}${f.min > 1 ? ` (you have ${usable.length})` : ""}` });
    } else if (usable.length > f.max) {
      missing.push({ key: f.key, label: f.label, problem: `${f.label}: at most ${f.max}` });
    }
  }
  return { ok: missing.length === 0, missing };
}

function validateFileInput({ fieldKey, skillKey, name, contentType, sizeBytes }) {
  const field = specFor(skillKey).find((f) => f.key === fieldKey);
  if (!field || !["files", "image", "video"].includes(field.kind)) return fail(400, "invalid", "That part of the proof doesn't take a file.");
  const fileName = typeof name === "string" ? name.trim().slice(0, 120) : "";
  if (!fileName) return fail(400, "invalid", "The file needs a name.");
  if (EXECUTABLE.test(fileName)) return fail(400, "executable", "Programs and installers can't be sent here.");
  const type = typeof contentType === "string" ? contentType.toLowerCase() : "";
  if (!typeAllowed(field.kind, type)) return fail(400, "type_not_allowed", `${field.label}: that kind of file isn't accepted here.`);
  const size = Number(sizeBytes);
  if (!Number.isInteger(size) || size <= 0) return fail(400, "invalid", "The file is empty.");
  const max = field.kind === "video" ? 500 * MB : 100 * MB;
  if (size > max) return fail(413, "file_too_large", `That file is over the ${max / MB} MB limit.`);
  return { ok: true, field, value: { name: fileName.replace(/[^A-Za-z0-9._ -]+/g, "_"), contentType: type, sizeBytes: size } };
}

// ── The money: 20% to the talent ─────────────────────────

async function findUpfrontAttempt(paystack, contractId) {
  for (let n = 1; n <= 10; n++) {
    const reference = `kd_upfront_${contractId}_${n}`;
    const existing = await paystack.verifyTransfer(reference);
    if (!existing || LIVE_TRANSFER_STATUSES.has(existing.status)) return { reference, existing };
  }
  throw new Error("Too many failed upfront payout attempts for this contract: check the Paystack dashboard.");
}

/**
 * Pays the 20% and marks the proof accepted, only if Paystack accepts the transfer. Safe to call twice: the claim
 * and Paystack's duplicate-reference check mean money is never sent twice.
 */
async function releaseUpfront({ contractId, trigger }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const paystack = deps.paystack ?? realPaystack;
  const now = deps.now ?? (() => new Date());

  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true } });
  if (!contract) return fail(404, "not_found", "Contract not found.");
  if (contract.upfrontPaidAt) return { ok: true, contract, already: true };
  if (!["submitted", "objected"].includes(contract.startProofStatus ?? "")) return fail(409, "not_awaiting", "There is no start proof waiting to be accepted.");

  const application = await prisma.application.findUnique({ where: { id: contract.job.awardedApplicationId } });
  const profile = application ? await prisma.talentProfile.findUnique({ where: { userId: application.talentId } }) : null;
  if (!profile?.paystackRecipientCode) return fail(400, "no_payout_account", "The talent hasn't set up a payout bank account yet.");

  const claimedAt = now();
  const claim = await prisma.contract.updateMany({
    where: { id: contract.id, upfrontPaidAt: null, OR: [{ upfrontClaimedAt: null }, { upfrontClaimedAt: { lte: new Date(claimedAt.getTime() - CLAIM_STALE_MS) } }] },
    data: { upfrontClaimedAt: claimedAt },
  });
  console.log(`upfront: claim contract=${contract.id} trigger=${trigger} claimed=${claim.count === 1} previousClaim=${contract.upfrontClaimedAt?.toISOString() ?? "none"}`);
  if (claim.count === 0) return fail(409, "release_in_progress", "The payment is already being sent. Refresh in a moment.");
  const unclaim = () => prisma.contract.updateMany({ where: { id: contract.id, upfrontClaimedAt: claimedAt }, data: { upfrontClaimedAt: null } });

  const amount = upfrontAmountOf(contract.job.budget);
  let attempt;
  let transfer;
  try {
    attempt = await findUpfrontAttempt(paystack, contract.id);
    transfer = attempt.existing ?? (await paystack.initiateTransfer({ amountNaira: amount, recipientCode: profile.paystackRecipientCode, reference: attempt.reference, reason: `Start-proof payment for "${contract.job.title}"` }));
  } catch (err) {
    await unclaim();
    return fail(502, "transfer_error", err.message || "Could not send the payment right now.");
  }
  console.log(`upfront: contract=${contract.id} trigger=${trigger} amount=${amount} reference=${attempt.reference} reused=${Boolean(attempt.existing)} transfer=${transfer.transferCode} status=${transfer.status}`);

  if (transfer.status === "otp" || transfer.status === "received") {
    console.error(`upfront: PAYOUT NOT SENT: ${attempt.reference} waits on transfer approval (status=${transfer.status}). contract=${contract.id}`);
    await unclaim();
    return fail(502, "transfer_waiting", "The payment couldn't be sent yet. Please try again later.");
  }
  if (transfer.status !== "success" && transfer.status !== "pending") {
    console.error(`upfront: PAYOUT NOT SENT: ${attempt.reference} status=${transfer.status} contract=${contract.id}`);
    await unclaim();
    return fail(502, "transfer_failed", "The payment couldn't be sent right now. Please try again shortly.");
  }

  const at = now();
  await prisma.contract.updateMany({
    where: { id: contract.id, upfrontPaidAt: null },
    data: { startProofStatus: "accepted", startProofAcceptedAt: at, upfrontAmount: amount, upfrontTransferCode: transfer.transferCode, upfrontPaidAt: at },
  });
  const updated = await prisma.contract.findUnique({ where: { id: contract.id } });
  await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "startProofAccepted", meta: { trigger } });
  await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "upfrontReleased", meta: { trigger, amount, transferCode: transfer.transferCode, transferStatus: transfer.status } });
  console.log(`upfront: released contract=${contract.id} readBack.paidAt=${updated.upfrontPaidAt?.toISOString() ?? "NOT SET"} status=${updated.startProofStatus}`);
  return { ok: true, contract: updated };
}

// ── The proof itself ─────────────────────────────────────

async function notify(userId, message) {
  try {
    await require("./discovery").notify(userId, message);
  } catch {
    // A push is a courtesy; the proof is recorded either way.
  }
}

/**
 * The talent sends the proof. Every required part must be there; the client then has 24 hours. A proof the team sent
 * back (status redo) is sent again the same way, as a new round.
 */
async function submitProof({ contractId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? (() => new Date());
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: { include: { client: true } } } });
  if (!contract) return fail(404, "not_found", "Contract not found.");
  if (!contract.job.skillKey) return fail(400, "not_needed", "This job has no start proof.");
  if (!["funded", "inProgress"].includes(contract.status)) return fail(400, "wrong_status", "The start proof is sent while the job is being worked on.");
  if (!["redo", null].includes(contract.startProofStatus)) return fail(409, "already_sent", contract.startProofStatus === "accepted" ? "Your start proof was already accepted." : "Your start proof is already with the client.");
  const items = await prisma.startProofItem.findMany({ where: { contractId, round: contract.startProofRound } });
  const checked = checkProof(contract.job.skillKey, items);
  if (!checked.ok) return { ...fail(400, "incomplete", `Still to add: ${checked.missing.map((m) => m.problem).join('; ')}.`), missing: checked.missing };
  const at = now();
  const done = await prisma.contract.updateMany({
    where: { id: contractId, OR: [{ startProofStatus: null }, { startProofStatus: "redo" }] },
    data: { startProofStatus: "submitted", startProofSubmittedAt: at, startProofDueAt: new Date(at.getTime() + DECISION_WINDOW_MS), startProofObjection: null, ...(contract.status === "funded" ? { status: "inProgress" } : {}) },
  });
  if (done.count !== 1) return fail(409, "already_sent", "Your start proof is already with the client.");
  await recordEvent(prisma, { jobId: contract.jobId, contractId, type: "startProofSubmitted", meta: { round: contract.startProofRound } });
  await notify(contract.job.clientId, { title: "Start proof to look at", body: `${contract.job.title}: accept it or tell us what is missing within 24 hours.`, data: { type: "start_proof", jobId: contract.jobId } });
  console.log(`start-proof: submitted contract=${contractId} round=${contract.startProofRound} items=${items.length} dueAt=${new Date(at.getTime() + DECISION_WINDOW_MS).toISOString()}`);
  return { ok: true, contract: await prisma.contract.findUnique({ where: { id: contractId } }) };
}

/** The client objects, from the checklist, inside the 24 hours. A person decides (D8). */
async function objectToProof({ contractId, reasonCode, note }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? (() => new Date());
  const reason = OBJECTION_REASONS.find((r) => r.code === reasonCode);
  if (!reason) return fail(400, "invalid", "Choose what is wrong.");
  const text = typeof note === "string" ? note.trim().slice(0, 500) : "";
  if (text.length < 10) return fail(400, "invalid", "Say what is missing or wrong, in at least 10 characters.");
  const at = now();
  const done = await prisma.contract.updateMany({
    where: { id: contractId, startProofStatus: "submitted", startProofDueAt: { gt: at }, upfrontPaidAt: null },
    data: { startProofStatus: "objected", startProofObjection: { reasonCode: reason.code, label: reason.label, note: text, at: at.toISOString() } },
  });
  if (done.count !== 1) return fail(409, "not_open", "The 24 hours to respond have passed, or this proof was already answered.");
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true } });
  const application = await prisma.application.findUnique({ where: { id: contract.job.awardedApplicationId } });
  await recordEvent(prisma, { jobId: contract.jobId, contractId, type: "startProofObjected", meta: { reasonCode: reason.code } });
  if (application) await notify(application.talentId, { title: "The client raised a point", body: "A person from King Domain will check your start proof against the list. You'll hear back.", data: { type: "start_proof", jobId: contract.jobId } });
  console.log(`start-proof: objected contract=${contractId} reason=${reason.code}`);
  return { ok: true, contract };
}

/** The 24 hours passed in silence: it is accepted (D2) unless switched off. */
async function autoAcceptDue(deps = {}) {
  if (process.env.START_PROOF_AUTO_ACCEPT === "false") return { startProofsAutoAccepted: 0 };
  const prisma = deps.prisma ?? realPrisma;
  const at = (deps.now ?? (() => new Date()))();
  const due = await prisma.contract.findMany({ where: { startProofStatus: "submitted", startProofDueAt: { lte: at }, upfrontPaidAt: null }, select: { id: true } });
  let accepted = 0;
  for (const { id } of due) {
    const r = await releaseUpfront({ contractId: id, trigger: "auto_accepted_after_24h" }, deps).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) accepted++;
    else console.error(`start-proof: auto-accept failed contract=${id}: ${r.error}`);
  }
  return { startProofsAutoAccepted: accepted };
}

/**
 * A team member rules on an objection. Upheld: the proof goes back to the talent to redo (a new round). Dismissed:
 * the objection did not stand against the checklist, so the 20% is paid.
 */
async function resolveObjection({ contractId, decision }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true } });
  if (!contract || contract.startProofStatus !== "objected") return fail(409, "not_open", "Someone else just ruled on this one. Refresh the list.");
  if (decision === "dismiss") return releaseUpfront({ contractId, trigger: "admin_dismissed_objection" }, deps);
  const done = await prisma.contract.updateMany({ where: { id: contractId, startProofStatus: "objected" }, data: { startProofStatus: "redo", startProofRound: { increment: 1 } } });
  if (done.count !== 1) return fail(409, "not_open", "Someone else just ruled on this one. Refresh the list.");
  const application = await prisma.application.findUnique({ where: { id: contract.job.awardedApplicationId } });
  await recordEvent(prisma, { jobId: contract.jobId, contractId, type: "startProofSentBack", meta: {} });
  if (application) await notify(application.talentId, { title: "Your start proof needs another go", body: "A person checked it against the list. Open the job to see what to fix.", data: { type: "start_proof", jobId: contract.jobId } });
  return { ok: true, contract: await prisma.contract.findUnique({ where: { id: contractId } }) };
}

/** A short-lived link for a file in a start proof or draft. */
const linkFor = async (key) => (key && storage.privateUploadsConfigured ? storage.presignPrivateGet(key, 300) : null);

module.exports = {
  UPFRONT_SHARE,
  DECISION_WINDOW_MS,
  OBJECTION_REASONS,
  upfrontAmountOf,
  specFor,
  checkProof,
  validateFileInput,
  releaseUpfront,
  submitProof,
  objectToProof,
  autoAcceptDue,
  resolveObjection,
  linkFor,
  validUrl,
};
