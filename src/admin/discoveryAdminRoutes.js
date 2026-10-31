// The team's two S3 queues (PRD §4.11; decisions D17, D24, D43):
//   Job posts  : a new client's first post, or one that asks for money outside the app, held until a person reads it.
//   Shortlists : "find someone for me": build 3 to 5 verified talents, each asked first and each with a line why.
const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const { requireCapability } = require("./capabilities");
const { recordAudit } = require("./audit");
const mailer = require("./mailer");
const discovery = require("../discovery");
const { POST_REJECT_REASONS } = require("../safety");
const { skillByKey } = require("../skills");

const ALREADY_HANDLED = "Someone else just handled this one. Refresh the list.";

// ── Job posts ────────────────────────────────────────────

const postsRouter = express.Router();
postsRouter.use(requireAdmin);
postsRouter.use(requireCapability("safety"));

const jobWithClient = { client: { select: { id: true, fullName: true, email: true } } };

postsRouter.get("/", async (req, res) => {
  const rows = await prisma.job.findMany({ where: { postStatus: "screening" }, orderBy: { createdAt: "asc" }, take: 100, include: jobWithClient });
  res.json({
    posts: rows.map((j) => ({ id: j.id, title: j.title, skillLabel: skillByKey(j.skillKey)?.label ?? j.category, jobType: j.jobType, currency: j.currency, budget: j.budget.toString(), flags: j.screeningFlags ?? [], createdAt: j.createdAt, client: j.client })),
    reasons: POST_REJECT_REASONS,
  });
});

postsRouter.get("/counts", async (req, res) => {
  res.json({ screening: await prisma.job.count({ where: { postStatus: "screening" } }) });
});

postsRouter.get("/:id", async (req, res) => {
  const j = await prisma.job.findUnique({ where: { id: req.params.id }, include: jobWithClient });
  if (!j) return res.status(404).json({ error: "Post not found." });
  res.json({
    post: {
      id: j.id,
      status: j.postStatus,
      title: j.title,
      description: j.description,
      skillLabel: skillByKey(j.skillKey)?.label ?? j.category,
      jobType: j.jobType,
      currency: j.currency,
      budget: j.budget.toString(),
      deliveryDays: j.deliveryDays,
      visibility: j.visibility,
      brief: j.brief,
      screeningQuestions: j.screeningQuestions ?? [],
      flags: j.screeningFlags ?? [],
      createdAt: j.createdAt,
      client: j.client,
    },
    clientRecord: await discovery.clientRecord(prisma, j.clientId),
    reasons: POST_REJECT_REASONS,
  });
});

postsRouter.post("/:id/approve", async (req, res) => {
  const j = await prisma.job.findUnique({ where: { id: req.params.id }, include: jobWithClient });
  if (!j) return res.status(404).json({ error: "Post not found." });
  const at = new Date();
  const ok = await prisma.$transaction(async (tx) => {
    const done = await tx.job.updateMany({ where: { id: j.id, postStatus: "screening" }, data: { postStatus: "live", liveAt: at, screenedAt: at, screenedById: req.admin.id } });
    if (done.count !== 1) return false;
    await recordAudit(tx, req.admin, { action: "jobPost.approve", subjectType: "Job", subjectId: j.id, details: { clientId: j.clientId, flags: (j.screeningFlags ?? []).map((f) => f.code) } });
    return true;
  });
  if (!ok) return res.status(409).json({ error: ALREADY_HANDLED });
  const live = await prisma.job.findUnique({ where: { id: j.id } });
  discovery.notify(j.clientId, { title: "Your job is live", body: j.title, data: { type: "job_live", jobId: j.id } });
  discovery.alertSavedSearches(live).catch((e) => console.error("saved-search alerts failed:", e.message));
  console.log(`job-posts: approve job=${j.id} by admin=${req.admin.id} readBack.status=${live.postStatus}`);
  res.json({ ok: true });
});

postsRouter.post("/:id/reject", async (req, res) => {
  const j = await prisma.job.findUnique({ where: { id: req.params.id }, include: jobWithClient });
  if (!j) return res.status(404).json({ error: "Post not found." });
  const reason = POST_REJECT_REASONS.find((r) => r.code === req.body?.reasonCode);
  if (!reason) return res.status(400).json({ error: "Choose a reason." });
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 600) : "";
  if (reason.code === "other" && note.length < 10) return res.status(400).json({ error: "Say what is wrong, in at least 10 characters." });
  const ok = await prisma.$transaction(async (tx) => {
    const done = await tx.job.updateMany({ where: { id: j.id, postStatus: "screening" }, data: { postStatus: "rejected", rejectReasonCode: reason.code, rejectNote: note || null, screenedAt: new Date(), screenedById: req.admin.id } });
    if (done.count !== 1) return false;
    await recordAudit(tx, req.admin, { action: "jobPost.reject", subjectType: "Job", subjectId: j.id, reasonCode: reason.code, note: note || null, details: { clientId: j.clientId } });
    return true;
  });
  if (!ok) return res.status(409).json({ error: ALREADY_HANDLED });
  discovery.notify(j.clientId, { title: "Your job needs a change", body: reason.label, data: { type: "job_rejected", jobId: j.id } });
  const sent = await mailer.sendJobPostRejected({ to: j.client.email, name: j.client.fullName, jobTitle: j.title, reasonLabel: reason.label, note });
  console.log(`job-posts: reject job=${j.id} by admin=${req.admin.id} reason=${reason.code} emailSent=${sent.sent}`);
  res.json({ ok: true });
});

// ── Shortlists ───────────────────────────────────────────

const shortlistsRouter = express.Router();
shortlistsRouter.use(requireAdmin);
shortlistsRouter.use(requireCapability("support"));

const MIN_ITEMS = 3;
const MAX_ITEMS = 5;
const WAITING = ["requested", "building"];

shortlistsRouter.get("/", async (req, res) => {
  const status = req.query.status === "sent" ? "sent" : "waiting";
  const rows = await prisma.shortlistRequest.findMany({
    where: status === "sent" ? { status: "sent" } : { status: { in: WAITING } },
    orderBy: status === "sent" ? { sentAt: "desc" } : { clockStartedAt: "asc" },
    take: 100,
    include: { client: { select: { fullName: true } }, items: { select: { available: true } } },
  });
  res.json({
    requests: rows.map((r) => ({ id: r.id, status: r.status, skillLabel: skillByKey(r.skillKey)?.label ?? r.skillKey, client: r.client.fullName, clockStartedAt: r.clockStartedAt, sentAt: r.sentAt, items: r.items.length, yes: r.items.filter((i) => i.available === true).length })),
    promise: undefined,
  });
});

shortlistsRouter.get("/counts", async (req, res) => {
  res.json({ waiting: await prisma.shortlistRequest.count({ where: { status: { in: WAITING } } }) });
});

shortlistsRouter.get("/:id", async (req, res) => {
  const r = await prisma.shortlistRequest.findUnique({ where: { id: req.params.id }, include: { client: { select: { id: true, fullName: true } }, items: true } });
  if (!r) return res.status(404).json({ error: "Request not found." });
  const now = new Date();
  const items = await Promise.all(
    r.items.map(async (i) => {
      const user = await prisma.user.findUnique({ where: { id: i.talentId }, include: discovery.talentInclude });
      return { id: i.id, reason: i.reason, askedAt: i.askedAt, available: i.available, talent: await discovery.talentCard(prisma, user, { viewerId: null, now }) };
    }),
  );
  // Candidates: verified in this skill, recently active first, not yet on the list. A verified newcomer is marked so one can be included where it fits.
  const taken = new Set(r.items.map((i) => i.talentId));
  const found = await discovery.browseTalents({ id: null }, { skill: r.skillKey, limit: 20 });
  res.json({
    request: { id: r.id, status: r.status, skillKey: r.skillKey, skillLabel: skillByKey(r.skillKey)?.label ?? r.skillKey, jobType: r.jobType, currency: r.currency, budget: r.budget.toString(), brief: r.brief, note: r.note, clockStartedAt: r.clockStartedAt, sentAt: r.sentAt, client: r.client, claimedById: r.claimedById },
    items,
    candidates: found.talents.filter((t) => !taken.has(t.id)),
    limits: { min: MIN_ITEMS, max: MAX_ITEMS },
  });
});

shortlistsRouter.post("/:id/items", async (req, res) => {
  const r = await prisma.shortlistRequest.findUnique({ where: { id: req.params.id }, include: { items: true } });
  if (!r) return res.status(404).json({ error: "Request not found." });
  if (!WAITING.includes(r.status)) return res.status(409).json({ error: ALREADY_HANDLED });
  if (r.items.length >= MAX_ITEMS + 3) return res.status(409).json({ error: "That is plenty of people to ask. Wait for answers first." });
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 10 || reason.length > 300) return res.status(400).json({ error: "Say in one line why this talent fits (10 to 300 characters)." });
  const verified = await discovery.verifiedSkills(prisma, req.body?.talentId);
  if (!verified.some((s) => s.skillKey === r.skillKey)) return res.status(400).json({ error: "That talent is not verified in this skill." });
  try {
    const now = new Date();
    const item = await prisma.$transaction(async (tx) => {
      const made = await tx.shortlistItem.create({ data: { requestId: r.id, talentId: req.body.talentId, reason, askedAt: now } });
      await tx.shortlistRequest.update({ where: { id: r.id }, data: { status: "building", claimedById: r.claimedById ?? req.admin.id } });
      await recordAudit(tx, req.admin, { action: "shortlist.ask", subjectType: "ShortlistRequest", subjectId: r.id, details: { talentId: req.body.talentId } });
      return made;
    });
    discovery.notify(req.body.talentId, { title: "A client may want you", body: "Are you available for a job? Answer in the app.", data: { type: "shortlist_ask", itemId: item.id } });
    res.status(201).json({ ok: true, itemId: item.id });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "That talent is already on the list." });
    throw err;
  }
});

shortlistsRouter.delete("/:id/items/:itemId", async (req, res) => {
  const { count } = await prisma.shortlistItem.deleteMany({ where: { id: req.params.itemId, requestId: req.params.id, request: { status: { in: WAITING } } } });
  if (!count) return res.status(409).json({ error: ALREADY_HANDLED });
  res.json({ ok: true });
});

/** Send the shortlist: 3 to 5 talents who said they are available. The clock stops here; its length feeds the promise (D24). */
shortlistsRouter.post("/:id/send", async (req, res) => {
  const r = await prisma.shortlistRequest.findUnique({ where: { id: req.params.id }, include: { items: true, client: true } });
  if (!r) return res.status(404).json({ error: "Request not found." });
  if (!WAITING.includes(r.status)) return res.status(409).json({ error: ALREADY_HANDLED });
  const yes = r.items.filter((i) => i.available === true);
  if (yes.length < MIN_ITEMS || yes.length > MAX_ITEMS) {
    return res.status(400).json({ error: `Send ${MIN_ITEMS} to ${MAX_ITEMS} talents who have said they are available. ${yes.length} have.`, code: "wrong_count" });
  }
  const sentAt = new Date();
  const ok = await prisma.$transaction(async (tx) => {
    const done = await tx.shortlistRequest.updateMany({ where: { id: r.id, status: { in: WAITING } }, data: { status: "sent", sentAt } });
    if (done.count !== 1) return false;
    await recordAudit(tx, req.admin, { action: "shortlist.send", subjectType: "ShortlistRequest", subjectId: r.id, details: { talents: yes.length, minutes: Math.round((sentAt - r.clockStartedAt) / 60000) } });
    return true;
  });
  if (!ok) return res.status(409).json({ error: ALREADY_HANDLED });
  discovery.notify(r.clientId, { title: "Your shortlist is ready", body: `${yes.length} verified talents, each asked first.`, data: { type: "shortlist_sent", requestId: r.id } });
  const sent = await mailer.sendShortlistReady({ to: r.client.email, name: r.client.fullName });
  console.log(`shortlists: sent id=${r.id} by admin=${req.admin.id} talents=${yes.length} tookMinutes=${Math.round((sentAt - r.clockStartedAt) / 60000)} emailSent=${sent.sent}`);
  res.json({ ok: true });
});

module.exports = { postsRouter, shortlistsRouter };
