// The rules of messaging that need no database (PRD §4.7; decisions D18, D24, D27). Small pure functions, so each
// rule can be tested and argued with on its own.
const { detectRisk } = require("./safety");
const { percentile } = require("./discoveryRules");

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TEXT = 4000;
const VOICE_MAX_SECONDS = 5 * 60;
const MB = 1024 * 1024;
/** A talent who never answers is counted as this slow, so the figure cannot flatter them (D24). */
const UNANSWERED_COUNTS_AS_MINUTES = 72 * 60;
const RESPONSE_WINDOW_DAYS = 30;

const REPORT_REASONS = [
  { code: "scam", label: "It looks like a scam" },
  { code: "contact_details", label: "It tries to move us off King Domain" },
  { code: "outside_payment", label: "It asks for money or payment outside King Domain" },
  { code: "harassment", label: "It is rude, threatening or harassing" },
  { code: "spam", label: "It is spam" },
  { code: "other", label: "Something else" },
];

const EXECUTABLE = /\.(?:apk|exe|bat|msi|scr|cmd|com|jar|dmg|sh|ps1|vbs)$/i;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"];
const AUDIO_TYPES = ["audio/mp4", "audio/aac", "audio/mpeg", "audio/ogg", "audio/webm", "audio/x-m4a", "audio/m4a", "audio/wav", "audio/x-wav", "audio/3gpp"];
const FILE_TYPES = ["application/pdf", "application/zip", "application/x-zip-compressed", "text/plain", "video/mp4", "video/quicktime", "video/webm", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/octet-stream"];

const ATTACHMENT_RULES = {
  voice: { types: AUDIO_TYPES, maxBytes: 15 * MB },
  image: { types: IMAGE_TYPES, maxBytes: 15 * MB },
  file: { types: [...FILE_TYPES, ...IMAGE_TYPES], maxBytes: 200 * MB },
};

/**
 * Whether a message is held rather than delivered (D18). Before a job is awarded between the two people, contact
 * details, links, other chat apps, outside payment, a fee, an invitation to meet or a program are all held. After
 * an award the contract room lets contact details through, but an outside-payment request, a fee and a program
 * are never allowed.
 */
function holdDecision({ text, awarded }) {
  const flags = detectRisk(text);
  const always = ["outside_payment", "pay_to_apply", "apk"];
  const held = awarded ? flags.filter((f) => always.includes(f.code)) : flags;
  return { hold: held.length > 0, flags: held };
}

/** What a held message tells the sender, in plain words. */
function holdExplanation(flags, awarded) {
  const what = flags.map((f) => f.label.toLowerCase()).join(", ");
  return awarded
    ? `We didn't send this: it contains ${what}. Payment and programs always stay inside King Domain.`
    : `We didn't send this: it contains ${what}. Until a job is awarded, everything stays inside King Domain, which is what keeps you both protected. Take it out and send again.`;
}

/** Text only, by its sender, inside the window. After that it is the record (D27). */
function canEdit(message, userId, now = new Date()) {
  if (message.senderId !== userId) return { ok: false, reason: "not_yours" };
  if (message.kind !== "text") return { ok: false, reason: "not_text" };
  if (message.state !== "sent") return { ok: false, reason: "not_sent" };
  if (now.getTime() - new Date(message.createdAt).getTime() > EDIT_WINDOW_MS) return { ok: false, reason: "too_late" };
  return { ok: true };
}

function validateText(body) {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return { ok: false, error: "Write something first." };
  if (text.length > MAX_TEXT) return { ok: false, error: `Keep it under ${MAX_TEXT} characters.` };
  return { ok: true, text };
}

/** An attachment the app asks to send: a kind, a name, a type, a size, and for voice a length. */
function validateAttachment({ kind, name, contentType, sizeBytes, durationSec }) {
  const rule = ATTACHMENT_RULES[kind];
  if (!rule) return { ok: false, error: "Say what kind of attachment this is." };
  const fileName = typeof name === "string" ? name.trim().slice(0, 120) : "";
  if (!fileName) return { ok: false, error: "The file needs a name." };
  if (EXECUTABLE.test(fileName)) return { ok: false, error: "Programs and installers can't be sent here. They are a common way to scam people.", code: "executable" };
  const type = typeof contentType === "string" ? contentType.toLowerCase() : "";
  if (!rule.types.includes(type)) return { ok: false, error: "That kind of file can't be sent here.", code: "type_not_allowed" };
  const size = Number(sizeBytes);
  if (!Number.isInteger(size) || size <= 0) return { ok: false, error: "The file is empty." };
  if (size > rule.maxBytes) return { ok: false, error: `That file is over the ${Math.round(rule.maxBytes / MB)} MB limit.`, code: "file_too_large" };
  let duration = null;
  if (kind === "voice") {
    duration = Number(durationSec);
    if (!Number.isInteger(duration) || duration < 1) return { ok: false, error: "A voice note needs its length in seconds." };
    if (duration > VOICE_MAX_SECONDS) return { ok: false, error: "A voice note can be up to 5 minutes.", code: "too_long" };
  }
  return { ok: true, value: { kind, name: fileName.replace(/[^A-Za-z0-9._ -]+/g, "_"), contentType: type, sizeBytes: size, durationSec: duration } };
}

function validateAgreement(body) {
  const text = typeof body === "string" ? body.trim() : "";
  if (text.length < 20) return { ok: false, error: "Write what you agreed in at least 20 characters: what, for how much, and by when." };
  if (text.length > 1500) return { ok: false, error: "Keep it under 1500 characters." };
  return { ok: true, text };
}

/** Blocking is not available while a contract is active (D18): the conversation must stay available. */
function blockAllowed({ activeContract }) {
  return activeContract ? { ok: false, error: "You can't block someone while you have a job running together. You can report them instead.", code: "contract_active" } : { ok: true };
}

/**
 * A talent's median first-reply time over the last 30 days, in minutes, from conversations where a client wrote first.
 * `threads`: [{ clientFirstAt, talentFirstReplyAt | null }]. A thread with no reply after 72 hours counts as 72 hours;
 * one still inside 72 hours is left out (it has not had its chance). Returns { medianMinutes, conversations }.
 */
function responseStats(threads, now = new Date()) {
  const since = now.getTime() - RESPONSE_WINDOW_DAYS * 86_400_000;
  const minutes = [];
  for (const t of threads) {
    const first = new Date(t.clientFirstAt).getTime();
    if (first < since) continue;
    if (t.talentFirstReplyAt) minutes.push(Math.max(0, Math.round((new Date(t.talentFirstReplyAt).getTime() - first) / 60000)));
    else if (now.getTime() - first >= UNANSWERED_COUNTS_AS_MINUTES * 60000) minutes.push(UNANSWERED_COUNTS_AS_MINUTES);
  }
  return { medianMinutes: minutes.length ? percentile(minutes, 50) : null, conversations: minutes.length };
}

/** The agreement card's state for one viewer. */
function agreementState(message, viewerIsClient) {
  const clientAt = message.agreementConfirmedByClientAt;
  const talentAt = message.agreementConfirmedByTalentAt;
  const mine = viewerIsClient ? clientAt : talentAt;
  const theirs = viewerIsClient ? talentAt : clientAt;
  return { confirmedByMe: Boolean(mine), confirmedByOther: Boolean(theirs), status: clientAt && talentAt ? "agreed" : "waiting" };
}

module.exports = {
  EDIT_WINDOW_MS,
  MAX_TEXT,
  VOICE_MAX_SECONDS,
  REPORT_REASONS,
  ATTACHMENT_RULES,
  holdDecision,
  holdExplanation,
  canEdit,
  validateText,
  validateAttachment,
  validateAgreement,
  blockAllowed,
  responseStats,
  agreementState,
};
