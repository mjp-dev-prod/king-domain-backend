// Proving a skill, from the talent's side (PRD §4.3; decisions D5 to D9). Mounted at /users.
// Files go from the phone straight to the private R2 bucket through a presigned link; this server
// only issues the link, then checks what actually landed before the file counts.
const express = require("express");
const crypto = require("node:crypto");
const { prisma } = require("../db");
const { requireUser } = require("./routes");
const { rateLimit } = require("../admin/rateLimit");
const { SKILLS, skillByKey } = require("../skills");
const storage = require("../storage");
const rules = require("../submissionRules");
const sub = require("../submissions");
const notices = require("../skillNotices");
const submissionWork = require("../submissionWork");
const linkPreview = require("../linkPreview");

const router = express.Router();

const cleaned = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function talentOnly(req, res, next) {
  if (req.user.role !== "talent") return res.status(403).json({ error: "Only talent accounts prove skills." });
  next();
}

/** Loads the submission the signed-in person owns. 404 for anyone else's: its existence is not for them to learn. */
async function ownSubmission(req, res, next) {
  const s = await prisma.skillSubmission.findFirst({ where: { id: req.params.id, userId: req.user.id }, include: sub.submissionInclude });
  if (!s) return res.status(404).json({ error: "Submission not found." });
  req.submission = s;
  next();
}

function draftOnly(req, res, next) {
  if (req.submission.status !== "draft") {
    return res.status(409).json({ error: "This submission has been sent and can't be changed.", code: "not_a_draft" });
  }
  next();
}

const reload = (id) => prisma.skillSubmission.findUnique({ where: { id }, include: sub.submissionInclude });
const respond = async (res, id, status = 200) => res.status(status).json({ submission: await sub.serialiseSubmission(prisma, await reload(id)) });

// ── The hub: every skill and where the person stands in it ──

router.get("/me/skills", requireUser, talentOnly, async (req, res) => {
  const now = new Date();
  const skills = await Promise.all(SKILLS.map((s) => sub.hubEntry(prisma, req.user.id, s, now)));
  res.json({ skills, uploadsAvailable: storage.privateUploadsConfigured });
});

router.get("/me/skills/:skillKey/submissions", requireUser, talentOnly, async (req, res) => {
  if (!skillByKey(req.params.skillKey)) return res.status(404).json({ error: "Unknown skill." });
  const rows = await prisma.skillSubmission.findMany({
    where: { userId: req.user.id, skillKey: req.params.skillKey, submittedAt: { not: null } }, // drafts, and drafts thrown away, are not attempts
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, submittedAt: true, decidedAt: true, resultReasons: true },
  });
  res.json({ submissions: rows.map((r) => ({ id: r.id, status: r.status, submittedAt: r.submittedAt, decidedAt: r.decidedAt, result: r.status === "verified" ? { outcome: "verified" } : r.resultReasons })) });
});

// ── Start or continue an attempt ──

router.post("/me/skills/:skillKey/submissions", requireUser, talentOnly, async (req, res) => {
  const skill = skillByKey(req.params.skillKey);
  if (!skill) return res.status(404).json({ error: "Unknown skill." });

  const restriction = await sub.activeRestriction(prisma, req.user.id, skill.key);
  if (restriction) {
    return res.status(403).json({ error: restriction.until ? "You can't submit in this skill yet." : "You can't submit in this skill.", code: "restricted", restriction: sub.restrictionJson(restriction) });
  }
  const existing = await prisma.skillSubmission.findMany({ where: { userId: req.user.id, skillKey: skill.key, status: { in: ["draft", "authenticity", "review", "verified"] } } });
  if (existing.some((s) => s.status === "verified")) return res.status(409).json({ error: "You're already verified in this skill.", code: "already_verified" });
  const inFlight = existing.find((s) => s.status === "authenticity" || s.status === "review");
  if (inFlight) return res.status(409).json({ error: "Your last submission in this skill is still being checked.", code: "in_review", submissionId: inFlight.id });
  const draft = existing.find((s) => s.status === "draft");
  if (draft) return respond(res, draft.id);

  const created = await prisma.skillSubmission.create({ data: { userId: req.user.id, skillKey: skill.key } });
  console.log(`submissions: draft started submission=${created.id} user=${req.user.id} skill=${skill.key}`);
  return respond(res, created.id, 201);
});

router.get("/me/submissions/:id", requireUser, talentOnly, ownSubmission, async (req, res) => {
  res.json({ submission: await sub.serialiseSubmission(prisma, req.submission) });
});

/**
 * Everything the person sent, laid out to be looked at: each piece with its files (private links that expire), what each
 * requirement was for, and plain advice on anything thin. Read-only, and for the owner alone.
 */
router.get("/me/submissions/:id/work", requireUser, talentOnly, ownSubmission, async (req, res) => {
  const ser = await sub.serialiseSubmission(prisma, req.submission);
  res.json({ work: await submissionWork.buildWork(req.submission, ser) });
});

/** A preview of a link the person typed (title, description, picture), so they can see what a reviewer will meet. */
router.get("/link-preview", requireUser, talentOnly, rateLimit({ windowMs: 10 * 60_000, max: 60, key: "link_preview", by: (r) => r.user.id }), async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim().slice(0, 500) : "";
  if (!url) return res.status(400).json({ error: "Give a link to preview." });
  res.json({ preview: await linkPreview.preview(url) });
});

/** Throws a draft away. The row stays (a person's history is never deleted); its files do not. */
router.delete("/me/submissions/:id", requireUser, talentOnly, ownSubmission, draftOnly, async (req, res) => {
  const keys = req.submission.files.map((f) => f.objectKey);
  await prisma.$transaction([
    prisma.submissionFile.deleteMany({ where: { submissionId: req.submission.id } }),
    prisma.submissionPiece.deleteMany({ where: { submissionId: req.submission.id } }),
    prisma.skillSubmission.update({ where: { id: req.submission.id }, data: { status: "removed", resultReasons: { kind: "discarded" } } }),
  ]);
  if (storage.privateUploadsConfigured) await storage.deletePrivateObjects(keys).catch((e) => console.warn(`submissions: could not delete files of discarded draft ${req.submission.id}: ${e.message}`));
  res.json({ ok: true });
});

// ── Declaration and terms ──

router.patch("/me/submissions/:id", requireUser, talentOnly, ownSubmission, draftOnly, async (req, res) => {
  const b = req.body ?? {};
  const data = {};
  if (typeof b.declaredOwnWork === "boolean") data.declaredOwnWork = b.declaredOwnWork;
  if (typeof b.aiUsed === "boolean") {
    data.aiUsed = b.aiUsed;
    if (!b.aiUsed) data.aiNote = null;
  }
  if (b.aiUsed !== false && typeof b.aiNote === "string") data.aiNote = cleaned(b.aiNote, 500) || null;
  if (b.acceptTerms === true) data.termsAcceptedAt = new Date();
  if (b.acceptTerms === false) data.termsAcceptedAt = null;
  await prisma.skillSubmission.update({ where: { id: req.submission.id }, data });
  return respond(res, req.submission.id);
});

// ── Pieces of work ──

function pieceFields(b) {
  const out = {};
  if (typeof b.title === "string") out.title = cleaned(b.title, 120);
  if (typeof b.brief === "string") out.brief = cleaned(b.brief, 600);
  if (typeof b.role === "string") out.role = cleaned(b.role, 120);
  if (typeof b.madeOn === "string") out.madeOn = cleaned(b.madeOn, 60);
  if (typeof b.liveLink === "string") out.liveLink = cleaned(b.liveLink, 300);
  if (typeof b.processLink === "string") out.processLink = cleaned(b.processLink, 300);
  return out;
}

const validLink = (v) => !v || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v);

router.post("/me/submissions/:id/pieces", requireUser, talentOnly, ownSubmission, draftOnly, async (req, res) => {
  if (req.submission.pieces.length >= rules.MAX_PIECES) return res.status(400).json({ error: `Send at most ${rules.MAX_PIECES} pieces.`, code: "too_many_pieces" });
  const fields = pieceFields(req.body ?? {});
  if (!validLink(fields.liveLink)) return res.status(400).json({ error: "The live link must start with http:// or https://." });
  if (!validLink(fields.processLink)) return res.status(400).json({ error: "The link that shows how it was made must start with http:// or https://." });
  const position = req.submission.pieces.reduce((m, p) => Math.max(m, p.position), 0) + 1;
  await prisma.submissionPiece.create({ data: { submissionId: req.submission.id, position, ...fields } });
  return respond(res, req.submission.id, 201);
});

router.patch("/me/submissions/:id/pieces/:pieceId", requireUser, talentOnly, ownSubmission, draftOnly, async (req, res) => {
  const piece = req.submission.pieces.find((p) => p.id === req.params.pieceId);
  if (!piece) return res.status(404).json({ error: "Piece not found." });
  const fields = pieceFields(req.body ?? {});
  if (!validLink(fields.liveLink)) return res.status(400).json({ error: "The live link must start with http:// or https://." });
  if (!validLink(fields.processLink)) return res.status(400).json({ error: "The link that shows how it was made must start with http:// or https://." });
  await prisma.submissionPiece.update({ where: { id: piece.id }, data: fields });
  return respond(res, req.submission.id);
});

router.delete("/me/submissions/:id/pieces/:pieceId", requireUser, talentOnly, ownSubmission, draftOnly, async (req, res) => {
  const piece = req.submission.pieces.find((p) => p.id === req.params.pieceId);
  if (!piece) return res.status(404).json({ error: "Piece not found." });
  const keys = req.submission.files.filter((f) => f.pieceId === piece.id).map((f) => f.objectKey);
  await prisma.submissionPiece.delete({ where: { id: piece.id } }); // its files go with it (cascade)
  if (keys.length && storage.privateUploadsConfigured) await storage.deletePrivateObjects(keys).catch((e) => console.warn(`submissions: could not delete files of piece ${piece.id}: ${e.message}`));
  return respond(res, req.submission.id);
});

// ── Files: ask for a link, upload to it, then confirm ──

const safeName = (n) => (cleaned(n, 120).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "file");

router.post(
  "/me/submissions/:id/files",
  requireUser,
  talentOnly,
  rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.SUBMISSION_FILE_LIMIT || 200), key: "user_submission_file", by: (req) => req.user.id }),
  ownSubmission,
  draftOnly,
  async (req, res) => {
    if (!storage.privateUploadsConfigured) {
      return res.status(503).json({ error: "File uploads aren't available right now. Try again later.", code: "uploads_unavailable" });
    }
    const b = req.body ?? {};
    const rule = sub.FILE_RULES[b.role];
    if (!rule) return res.status(400).json({ error: "Say what kind of file this is." });

    let pieceId = null;
    if (b.role === "walkthrough") {
      if (req.submission.files.some((f) => f.role === "walkthrough")) {
        return res.status(409).json({ error: "You've already added a walkthrough. Remove it first to replace it.", code: "walkthrough_exists" });
      }
    } else {
      const piece = req.submission.pieces.find((p) => p.id === b.pieceId);
      if (!piece) return res.status(400).json({ error: "Choose which piece this file belongs to." });
      pieceId = piece.id;
    }
    if (req.submission.files.length >= sub.MAX_FILES_PER_SUBMISSION) return res.status(400).json({ error: "That's the most files one submission can hold.", code: "too_many_files" });

    const contentType = typeof b.contentType === "string" ? b.contentType.toLowerCase() : "";
    if (!rule.types.includes(contentType)) return res.status(400).json({ error: "That kind of file isn't accepted here.", code: "type_not_allowed" });
    const sizeBytes = Number(b.sizeBytes);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return res.status(400).json({ error: "The file is empty." });
    if (sizeBytes > rule.maxBytes) return res.status(413).json({ error: `That file is over the ${Math.round(rule.maxBytes / (1024 * 1024))} MB limit.`, code: "file_too_large" });

    const name = safeName(b.name);
    const objectKey = `submissions/${req.user.id}/${req.submission.id}/${crypto.randomUUID()}-${name}`;
    const file = await prisma.submissionFile.create({
      data: { submissionId: req.submission.id, pieceId, role: b.role, name, contentType, sizeBytes, objectKey },
    });
    const uploadUrl = await storage.presignPrivatePut({ key: objectKey, contentType });
    return res.status(201).json({ file: sub.serialiseFile(file), upload: { url: uploadUrl, method: "PUT", headers: { "Content-Type": contentType } } });
  },
);

router.post("/me/submissions/:id/files/:fileId/complete", requireUser, talentOnly, ownSubmission, draftOnly, async (req, res) => {
  const file = req.submission.files.find((f) => f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: "File not found." });
  if (file.status === "ready") return respond(res, req.submission.id);

  const held = await storage.headPrivate(file.objectKey);
  if (!held) return res.status(409).json({ error: "The upload didn't finish. Try adding the file again.", code: "upload_missing" });
  const rule = sub.FILE_RULES[file.role];
  if (held.size > rule.maxBytes || held.size !== file.sizeBytes) {
    await storage.deletePrivateObjects([file.objectKey]).catch(() => {});
    await prisma.submissionFile.delete({ where: { id: file.id } });
    return res.status(400).json({ error: "The uploaded file wasn't the size you said it was, so it was removed. Add it again.", code: "size_mismatch" });
  }
  await prisma.submissionFile.update({ where: { id: file.id }, data: { status: "ready", etag: held.etag } });
  console.log(`submissions: file ready file=${file.id} role=${file.role} bytes=${held.size} etag=${held.etag} readBack=${(await prisma.submissionFile.count({ where: { id: file.id, status: "ready" } })) === 1}`);
  return respond(res, req.submission.id);
});

router.delete("/me/submissions/:id/files/:fileId", requireUser, talentOnly, ownSubmission, draftOnly, async (req, res) => {
  const file = req.submission.files.find((f) => f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: "File not found." });
  await prisma.submissionFile.delete({ where: { id: file.id } });
  if (storage.privateUploadsConfigured) await storage.deletePrivateObjects([file.objectKey]).catch((e) => console.warn(`submissions: could not delete file ${file.id}: ${e.message}`));
  return respond(res, req.submission.id);
});

// ── Send it ──

router.post(
  "/me/submissions/:id/submit",
  requireUser,
  talentOnly,
  rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.SUBMISSION_SUBMIT_LIMIT || 10), key: "user_submission_submit", by: (req) => req.user.id }),
  ownSubmission,
  draftOnly,
  async (req, res) => {
    const s = req.submission;
    const restriction = await sub.activeRestriction(prisma, req.user.id, s.skillKey);
    if (restriction) return res.status(403).json({ error: "You can't submit in this skill yet.", code: "restricted", restriction: sub.restrictionJson(restriction) });

    const earlier = await sub.hadEarlierAttempt(prisma, req.user.id, s.skillKey, s.id);
    const readiness = rules.readiness(sub.readinessInput(s), { hadEarlierAttempt: earlier });
    if (!readiness.ready) {
      return res.status(400).json({ error: "Finish the checklist first.", code: "not_ready", missing: readiness.items.filter((i) => !i.done).map((i) => i.key) });
    }

    const nowEtags = s.files.filter((f) => f.role === "output" && f.status === "ready").map((f) => f.etag);
    const before = await sub.rejectedEtags(prisma, req.user.id, s.skillKey, s.id);
    const repeatOfRejected = rules.isRepeatOfRejected(nowEtags, before);

    const moved = await prisma.skillSubmission.updateMany({
      where: { id: s.id, status: "draft" },
      data: { status: "authenticity", submittedAt: new Date(), repeatOfRejected },
    });
    if (moved.count !== 1) return res.status(409).json({ error: "This submission has already been sent.", code: "not_a_draft" });
    console.log(`submissions: sent submission=${s.id} user=${req.user.id} skill=${s.skillKey} outputs=${nowEtags.length} previouslyRejectedEtags=${before.length} repeatOfRejected=${repeatOfRejected}`);
    // Tell the team now, not at the next sweep. Failures are swallowed inside, so the person's "Sent" never fails on it.
    notices.submissionSent({ submission: s, person: { fullName: req.user.fullName } });
    return respond(res, s.id);
  },
);

module.exports = { router };
