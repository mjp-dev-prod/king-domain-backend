// Skill submissions: what the talent routes and the admin queues share (PRD §4.3, decisions D5 to D9).

const { skillByKey, CATEGORIES } = require("./skills");
const { rubricFor, SCALE } = require("./rubrics");
const rules = require("./submissionRules");

const MB = 1024 * 1024;
const MAX_FILES_PER_SUBMISSION = 60;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
// Never HTML, SVG or scripts: a reviewer opens these in a browser. Working files (a project file, a PSD)
// legitimately arrive as an unknown binary, which is served as a download, not rendered.
const WORKING_TYPES = ["application/zip", "application/x-zip-compressed", "application/octet-stream", "text/plain", "application/json"];

/** What each kind of file may be and how big. */
const FILE_RULES = {
  output: { types: [...IMAGE_TYPES, ...VIDEO_TYPES, "application/pdf", "application/zip", "application/x-zip-compressed"], maxBytes: 500 * MB },
  working: { types: [...IMAGE_TYPES, ...VIDEO_TYPES, "application/pdf", ...WORKING_TYPES], maxBytes: 500 * MB },
  draft: { types: [...IMAGE_TYPES, ...VIDEO_TYPES, "application/pdf", ...WORKING_TYPES], maxBytes: 200 * MB },
  walkthrough: { types: VIDEO_TYPES, maxBytes: 300 * MB },
};

const TERMS = [
  "Send only work you made yourself, or the part you made in a team, and say which part.",
  "If a reviewer says Not yet, fix what they list before sending again. Sending the same files again, unchanged, is a breach of these terms.",
  "The first time that happens you cannot submit in that skill for 2 months. After that, for 3 months.",
  "Work that is someone else's, or made by AI and passed off as yours, means a ban from that skill.",
];

const OPEN_STATUSES = ["draft", "authenticity", "review"];

const categoryLabel = (skill) => CATEGORIES.find((c) => c.key === skill.category)?.label ?? skill.category;

/** An active restriction in this skill, or null. `until: null` is permanent. */
async function activeRestriction(db, userId, skillKey, now = new Date()) {
  return db.skillRestriction.findFirst({
    where: { userId, skillKey, OR: [{ until: null }, { until: { gt: now } }] },
    orderBy: { createdAt: "desc" },
  });
}

const restrictionJson = (r) => (r ? { kind: r.kind, until: r.until, reason: r.reason } : null);

const submissionInclude = { pieces: { orderBy: { position: "asc" } }, files: { orderBy: { createdAt: "asc" } } };

function serialiseFile(f) {
  return { id: f.id, role: f.role, pieceId: f.pieceId, name: f.name, contentType: f.contentType, sizeBytes: f.sizeBytes, status: f.status };
}

/** Whether the person has been told "Not yet" for this skill before: from then on the terms must be accepted. */
async function hadEarlierAttempt(db, userId, skillKey, exceptId) {
  return (await db.skillSubmission.count({ where: { userId, skillKey, status: "notYet", id: { not: exceptId } } })) > 0;
}

function readinessInput(s) {
  return {
    pieces: s.pieces.map((p) => ({ ...p, files: s.files.filter((f) => f.pieceId === p.id) })),
    files: s.files.filter((f) => !f.pieceId),
    declaredOwnWork: s.declaredOwnWork,
    aiUsed: s.aiUsed,
    aiNote: s.aiNote,
    termsAcceptedAt: s.termsAcceptedAt,
  };
}

/** The talent's view of one submission: everything they need to build it, see where it is, and read the result. */
async function serialiseSubmission(db, s) {
  const skill = skillByKey(s.skillKey);
  const earlier = await hadEarlierAttempt(db, s.userId, s.skillKey, s.id);
  const readiness = rules.readiness(readinessInput(s), { hadEarlierAttempt: earlier });
  const rubric = rubricFor(s.skillKey);
  return {
    id: s.id,
    skillKey: s.skillKey,
    skillLabel: skill?.label ?? s.skillKey,
    status: s.status,
    declaredOwnWork: s.declaredOwnWork,
    aiUsed: s.aiUsed,
    aiNote: s.aiNote,
    termsAccepted: Boolean(s.termsAcceptedAt),
    termsNeeded: earlier,
    terms: TERMS,
    submittedAt: s.submittedAt,
    decidedAt: s.decidedAt,
    pieces: s.pieces.map((p) => ({
      id: p.id,
      position: p.position,
      title: p.title,
      brief: p.brief,
      role: p.role,
      madeOn: p.madeOn,
      liveLink: p.liveLink,
      processLink: p.processLink ?? "",
      files: s.files.filter((f) => f.pieceId === p.id).map(serialiseFile),
    })),
    walkthrough: s.files.filter((f) => !f.pieceId && f.role === "walkthrough").map(serialiseFile),
    readiness,
    limits: { minPieces: rules.MIN_PIECES, maxPieces: rules.MAX_PIECES, files: Object.fromEntries(Object.entries(FILE_RULES).map(([k, v]) => [k, { maxBytes: v.maxBytes, types: v.types }])) },
    howMade: skill?.howMade ?? null,
    rubric: rubric ? { draft: rubric.draft, scale: SCALE, lines: rubric.lines } : null,
    result: resultOf(s),
  };
}

function resultOf(s) {
  if (s.status === "verified") return { outcome: "verified" };
  if (s.status === "notYet" || s.status === "removed") return { outcome: s.status, ...(s.resultReasons ?? {}) };
  return null;
}

/** A line for the hub: where this skill stands for the person. */
async function hubEntry(db, userId, skill, now = new Date()) {
  const [subs, restriction] = await Promise.all([
    db.skillSubmission.findMany({ where: { userId, skillKey: skill.key, status: { not: "removed" } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, submittedAt: true, decidedAt: true, createdAt: true } }),
    activeRestriction(db, userId, skill.key, now),
  ]);
  const verified = subs.find((s) => s.status === "verified");
  const open = subs.find((s) => OPEN_STATUSES.includes(s.status));
  const last = subs[0] ?? null;
  let state = "notStarted";
  if (verified) state = "verified";
  else if (restriction) state = "restricted";
  else if (open) state = open.status === "draft" ? "draft" : "inReview";
  else if (last?.status === "notYet") state = "notYet";
  return {
    skillKey: skill.key,
    label: skill.label,
    category: skill.category,
    state,
    currentSubmissionId: (open ?? last)?.id ?? null,
    attempts: subs.filter((s) => s.status !== "draft").length,
    restriction: restrictionJson(restriction),
    rubricDraft: rubricFor(skill.key)?.draft ?? true,
  };
}

/**
 * What a verified result changes beyond the submission's own status. Today nothing: being verified IS a verified
 * submission in the skill. (It used to also write an old-flow proof item as the gate; that flow was retired on
 * 2026-11-09, and the table is kept only so old files can be cleaned up when an account is deleted.)
 */
async function markVerified() {
  return null;
}

/**
 * All output files' ETags this person sent in earlier attempts the REVIEWERS turned down. An attempt stopped at the
 * authenticity check never reached them, so resending its files is not resending rejected work.
 */
async function rejectedEtags(db, userId, skillKey, exceptId) {
  const files = await db.submissionFile.findMany({
    where: { role: "output", status: "ready", etag: { not: null }, submission: { userId, skillKey, status: "notYet", resultReasons: { path: ["kind"], equals: "review" }, id: { not: exceptId } } },
    select: { etag: true },
  });
  return files.map((f) => f.etag);
}

module.exports = {
  FILE_RULES,
  MAX_FILES_PER_SUBMISSION,
  TERMS,
  OPEN_STATUSES,
  categoryLabel,
  activeRestriction,
  restrictionJson,
  submissionInclude,
  serialiseFile,
  serialiseSubmission,
  hubEntry,
  hadEarlierAttempt,
  readinessInput,
  markVerified,
  rejectedEtags,
};
