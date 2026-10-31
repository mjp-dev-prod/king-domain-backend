// The rules of skill verification that need no database (PRD §4.3, decisions D5 to D9).
// Each is a small pure function so the rules can be tested and argued with on their own.

const MIN_PIECES = 2;
const MAX_PIECES = 3;
const COMMENT_MIN = 10;
const COMMENT_MAX = 800;

/**
 * Checks one reviewer's scores and verdict against the skill's rubric.
 * A pass is refused when any line is "below the standard" (1): that line is exactly what the person must fix.
 */
function validateReview({ scores, verdict, comment }, rubric) {
  if (!rubric) return { ok: false, error: "No rubric for this skill." };
  if (verdict !== "pass" && verdict !== "notYet") return { ok: false, error: "Choose pass or not yet." };
  if (!scores || typeof scores !== "object") return { ok: false, error: "Score every line." };
  const clean = {};
  for (const l of rubric.lines) {
    const v = scores[l.key];
    if (!Number.isInteger(v) || v < 1 || v > 4) return { ok: false, error: `Score "${l.label}" from 1 to 4.` };
    clean[l.key] = v;
  }
  if (Object.keys(scores).some((k) => !rubric.lines.some((l) => l.key === k))) return { ok: false, error: "Unknown rubric line." };
  const lowest = Math.min(...Object.values(clean));
  if (verdict === "pass" && lowest === 1) return { ok: false, error: "A line is below the standard, so this can't be a pass." };
  const note = typeof comment === "string" ? comment.trim() : "";
  if (verdict === "notYet" && note.length < COMMENT_MIN) return { ok: false, error: `Say what to fix, in at least ${COMMENT_MIN} characters.` };
  if (note.length > COMMENT_MAX) return { ok: false, error: `Keep the comment under ${COMMENT_MAX} characters.` };
  return { ok: true, scores: clean, verdict, comment: note };
}

/**
 * Where the reviews stand. Two reviewers; if they agree that is the result; if they differ a third decides.
 * Returns { state: "waiting" | "needThird" | "decided", outcome?: "verified" | "notYet", needed }.
 */
function decide(reviews) {
  const passes = reviews.filter((r) => r.verdict === "pass").length;
  const notYets = reviews.filter((r) => r.verdict === "notYet").length;
  if (reviews.length < 2) return { state: "waiting", needed: 2 - reviews.length };
  if (reviews.length === 2) {
    if (passes === 2) return { state: "decided", outcome: "verified", needed: 0 };
    if (notYets === 2) return { state: "decided", outcome: "notYet", needed: 0 };
    return { state: "needThird", needed: 1 };
  }
  return { state: "decided", outcome: passes > notYets ? "verified" : "notYet", needed: 0 };
}

/**
 * What to tell a person after "Not yet": the lines the not-yet reviewers scored 2 or lower (with the
 * lowest score each line got), and those reviewers' comments. Never who the reviewers were.
 */
function reasonsFor(reviews, rubric) {
  const against = reviews.filter((r) => r.verdict === "notYet");
  const lines = rubric.lines
    .map((l) => {
      const scores = against.map((r) => r.scores[l.key]).filter((v) => Number.isInteger(v));
      return { key: l.key, label: l.label, looksLike: l.looksLike, score: scores.length ? Math.min(...scores) : null };
    })
    .filter((l) => l.score !== null && l.score <= 2);
  return { lines, comments: against.map((r) => r.comment).filter(Boolean) };
}

/** Months a person may not submit in a skill after resending rejected work unchanged: 2, then 3 (D9). */
function restrictionMonths(priorRepeatCount) {
  return priorRepeatCount === 0 ? 2 : 3;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** True when every finished-work file is one that was in an earlier "Not yet" attempt (same storage ETag). */
function isRepeatOfRejected(outputEtags, earlierRejectedEtags) {
  const now = outputEtags.filter(Boolean);
  if (!now.length) return false;
  const before = new Set(earlierRejectedEtags.filter(Boolean));
  return now.every((e) => before.has(e));
}

/**
 * The checklist a talent sees while building a submission, and what "ready" means.
 * `submission` carries pieces (each with files and a liveLink) and the walkthrough and declaration state.
 */
function readiness(submission, { hadEarlierAttempt }) {
  const pieces = submission.pieces ?? [];
  const done = (p) => Boolean(p.title?.trim() && p.brief?.trim() && p.role?.trim() && p.madeOn?.trim());
  const hasOutput = (p) => p.files.some((f) => f.role === "output" && f.status === "ready") || Boolean(p.liveLink?.trim());
  const items = [
    { key: "pieces", label: `${MIN_PIECES} or ${MAX_PIECES} pieces of real work`, done: pieces.length >= MIN_PIECES && pieces.length <= MAX_PIECES },
    { key: "details", label: "Each piece: title, the brief, your role and when", done: pieces.length > 0 && pieces.every(done) },
    { key: "outputs", label: "Each piece: the finished work or a live link", done: pieces.length > 0 && pieces.every(hasOutput) },
    { key: "working", label: "Working files for at least one piece", done: pieces.some((p) => p.files.some((f) => f.role === "working" && f.status === "ready")) },
    { key: "drafts", label: "Drafts for at least one piece", done: pieces.some((p) => p.files.some((f) => f.role === "draft" && f.status === "ready")) },
    { key: "walkthrough", label: "A 2 to 3 minute walkthrough video", done: (submission.files ?? []).some((f) => f.role === "walkthrough" && f.status === "ready") },
    { key: "declaration", label: "Your declaration that the work is yours", done: submission.declaredOwnWork === true && (!submission.aiUsed || Boolean(submission.aiNote?.trim())) },
  ];
  if (hadEarlierAttempt) items.push({ key: "terms", label: "Accept the terms about sending work again", done: Boolean(submission.termsAcceptedAt) });
  return { items, ready: items.every((i) => i.done) };
}

module.exports = { MIN_PIECES, MAX_PIECES, COMMENT_MIN, COMMENT_MAX, validateReview, decide, reasonsFor, restrictionMonths, addMonths, isRepeatOfRejected, readiness };
