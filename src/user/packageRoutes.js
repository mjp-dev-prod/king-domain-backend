// S8 over HTTP: packages (a talent publishes, a client browses and orders), and premium (buying through Google Play,
// reopening a paused job, asking before applying). Mounted at the root, with its own paths.
const express = require("express");
const { prisma } = require("../db");
const { requireUser, requireTalentProfile } = require("./routes");
const { requireVerifiedIdentity } = require("./identityGate");
const { rateLimit } = require("../admin/rateLimit");
const packages = require("../packages");
const premium = require("../premium");
const questions = require("../questions");

const router = express.Router();

const limiter = rateLimit({ windowMs: 3600_000, max: 60, key: "s8_action", by: (r) => r.user.id });
const fail = (res, r) => res.status(r.status).json({ error: r.error, code: r.code, field: r.field, productId: r.productId, feature: r.feature });
const talentOnly = (req, res, next) => (req.user.role === "talent" ? next() : res.status(403).json({ error: "Only talents can do that." }));
const clientOnly = (req, res, next) => (req.user.role === "client" ? next() : res.status(403).json({ error: "Only clients can do that." }));

// ── A talent's packages ──

router.get("/users/me/packages", requireUser, talentOnly, async (req, res) => res.json(await packages.mine(req.user.id)));

router.put("/users/me/packages/:skillKey/:tier", requireUser, talentOnly, limiter, async (req, res) => {
  const r = await packages.save({ userId: req.user.id, skillKey: req.params.skillKey, tier: req.params.tier, input: req.body });
  if (r.ok === false) return fail(res, r);
  res.json({ package: r.package });
});

router.patch("/users/me/packages/:id", requireUser, talentOnly, async (req, res) => {
  const r = await packages.setStatus({ userId: req.user.id, id: req.params.id, status: req.body?.status });
  if (r.ok === false) return fail(res, r);
  res.json({ ok: true });
});

router.delete("/users/me/packages/:id", requireUser, talentOnly, async (req, res) => {
  const r = await packages.remove({ userId: req.user.id, id: req.params.id });
  if (r.ok === false) return fail(res, r);
  res.json({ ok: true });
});

// ── Browsing and ordering ──

router.get("/packages", requireUser, clientOnly, async (req, res) => res.json(await packages.browse({ skill: req.query.skill, cursor: req.query.cursor, limit: req.query.limit })));

router.get("/packages/:id", requireUser, clientOnly, async (req, res) => {
  const d = await packages.detail({ id: req.params.id });
  if (!d) return res.status(404).json({ error: "This package isn't available." });
  res.json(d);
});

router.post("/packages/:id/order", requireUser, clientOnly, requireVerifiedIdentity(), limiter, async (req, res) => {
  const r = await packages.order({ packageId: req.params.id, clientId: req.user.id, brief: req.body?.brief, note: req.body?.note });
  if (r.ok === false) return fail(res, r);
  res.status(201).json({ orderId: r.order.id, jobId: r.jobId, answerDueAt: r.order.answerDueAt });
});

router.get("/users/me/package-orders", requireUser, async (req, res) => res.json({ orders: await packages.ordersFor({ userId: req.user.id, role: req.user.role }) }));

router.post("/package-orders/:id/accept", requireUser, talentOnly, requireTalentProfile, requireVerifiedIdentity(), async (req, res) => {
  const r = await packages.accept({ orderId: req.params.id, talentId: req.user.id });
  if (r.ok === false) return fail(res, r);
  res.json({ ok: true, jobId: r.jobId });
});

router.post("/package-orders/:id/decline", requireUser, talentOnly, async (req, res) => {
  const r = await packages.decline({ orderId: req.params.id, talentId: req.user.id });
  if (r.ok === false) return fail(res, r);
  res.json({ ok: true });
});

router.post("/package-orders/:id/cancel", requireUser, clientOnly, async (req, res) => {
  const r = await packages.cancel({ orderId: req.params.id, clientId: req.user.id });
  if (r.ok === false) return fail(res, r);
  res.json({ ok: true });
});

// ── Premium ──

router.get("/premium/status", requireUser, async (req, res) => res.json(await premium.status(req.user.id)));

/** The phone sends the token of a purchase it made; it completes the purchase only after this says yes. */
router.post("/premium/verify", requireUser, limiter, async (req, res) => {
  const r = await premium.verifyAndGrant({ userId: req.user.id, productId: req.body?.productId, purchaseToken: req.body?.purchaseToken });
  if (r.ok === false) return fail(res, r);
  res.json({ ok: true, already: Boolean(r.already), status: await premium.status(req.user.id) });
});

// ── Asking before applying ──

router.get("/jobs/:id/questions", requireUser, async (req, res) => {
  const list = await questions.listFor({ jobId: req.params.id, viewerId: req.user.id });
  if (!list) return res.status(404).json({ error: "Job not found." });
  res.json({ questions: list });
});

router.post("/jobs/:id/questions", requireUser, talentOnly, limiter, async (req, res) => {
  const r = await questions.ask({ jobId: req.params.id, talentId: req.user.id, question: req.body?.question });
  if (r.ok === false) return fail(res, r);
  res.status(201).json({ ok: true, questions: await questions.listFor({ jobId: req.params.id, viewerId: req.user.id }) });
});

router.post("/questions/:id/answer", requireUser, clientOnly, limiter, async (req, res) => {
  const r = await questions.answer({ questionId: req.params.id, clientId: req.user.id, answer: req.body?.answer });
  if (r.ok === false) return fail(res, r);
  const q = await prisma.preApplyQuestion.findUnique({ where: { id: req.params.id }, select: { jobId: true } });
  res.json({ ok: true, questions: await questions.listFor({ jobId: q.jobId, viewerId: req.user.id }) });
});

module.exports = { router };
