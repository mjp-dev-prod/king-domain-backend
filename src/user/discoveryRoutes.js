// Browse talents, invitations, saved talents and searches, and "find someone for me" (PRD §3.2, §4.6; D21 to D24).
// Mounted at the root: paths are written in full.
const express = require("express");
const { prisma } = require("../db");
const { requireUser } = require("./routes");
const discovery = require("../discovery");
const briefs = require("../briefs");
const { skillByKey } = require("../skills");
const { rateLimit } = require("../admin/rateLimit");

const router = express.Router();

function clientOnly(req, res, next) {
  if (req.user.role !== "client") return res.status(403).json({ error: "Only client accounts can do that." });
  next();
}
function talentOnly(req, res, next) {
  if (req.user.role !== "talent") return res.status(403).json({ error: "Only talent accounts can do that." });
  next();
}

// ── The post-a-job form: what a brief asks for, per skill and type ──

router.get("/briefs/spec", requireUser, (req, res) => {
  const spec = briefs.briefSpec(String(req.query.skill ?? ""), String(req.query.type ?? ""));
  if (!spec) return res.status(404).json({ error: "Choose a skill and a job type from the lists." });
  res.json({ spec, jobTypes: briefs.JOB_TYPES, currencies: briefs.CURRENCIES, usageRights: briefs.USAGE_RIGHTS, limits: briefs.LIMITS });
});

// ── Browse talents (client) ──────────────────────────────

router.get("/talents", requireUser, clientOnly, async (req, res) => {
  res.json(await discovery.browseTalents(req.user, req.query));
});

router.get("/talents/:id", requireUser, clientOnly, async (req, res) => {
  const profile = await discovery.talentProfile(req.user, req.params.id);
  if (!profile) return res.status(404).json({ error: "Talent not found." });
  res.json(profile);
});

router.post("/talents/:id/save", requireUser, clientOnly, async (req, res) => {
  const talent = await prisma.user.findFirst({ where: { id: req.params.id, role: "talent", deletedAt: null }, select: { id: true } });
  if (!talent) return res.status(404).json({ error: "Talent not found." });
  await prisma.savedTalent.upsert({ where: { clientId_talentId: { clientId: req.user.id, talentId: talent.id } }, update: {}, create: { clientId: req.user.id, talentId: talent.id } });
  res.json({ ok: true, saved: true });
});

router.delete("/talents/:id/save", requireUser, clientOnly, async (req, res) => {
  await prisma.savedTalent.deleteMany({ where: { clientId: req.user.id, talentId: req.params.id } });
  res.json({ ok: true, saved: false });
});

router.get("/users/me/saved-talents", requireUser, clientOnly, async (req, res) => {
  const rows = await prisma.savedTalent.findMany({ where: { clientId: req.user.id, talent: { deletedAt: null } }, orderBy: { createdAt: "desc" }, take: 100, include: { talent: { include: discovery.talentInclude } } });
  const now = new Date();
  res.json({ talents: await Promise.all(rows.map((r) => discovery.talentCard(prisma, r.talent, { viewerId: req.user.id, now }))) });
});

// ── Invitations (talent) ─────────────────────────────────

router.get("/users/me/invitations", requireUser, talentOnly, async (req, res) => {
  res.json({ invitations: await discovery.invitationsFor(req.user.id) });
});

router.post("/users/me/invitations/:id/respond", requireUser, talentOnly, async (req, res) => {
  const accept = req.body?.accept === true;
  const { count } = await prisma.invitation.updateMany({
    where: { id: req.params.id, talentId: req.user.id, status: "pending", expiresAt: { gt: new Date() } },
    data: { status: accept ? "accepted" : "declined", respondedAt: new Date() },
  });
  if (count !== 1) return res.status(409).json({ error: "This invitation has expired or was already answered.", code: "not_pending" });
  res.json({ ok: true, status: accept ? "accepted" : "declined" });
});

// ── Saved searches and alerts (talent) ───────────────────

router.get("/users/me/saved-searches", requireUser, talentOnly, async (req, res) => {
  res.json({ searches: await prisma.savedSearch.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: 30 }) });
});

router.post("/users/me/saved-searches", requireUser, talentOnly, async (req, res) => {
  const checked = discovery.validateSearch(req.body);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  if ((await prisma.savedSearch.count({ where: { userId: req.user.id } })) >= 20) return res.status(409).json({ error: "You can keep up to 20 saved searches.", code: "limit" });
  res.status(201).json({ search: await prisma.savedSearch.create({ data: { userId: req.user.id, ...checked.value } }) });
});

router.patch("/users/me/saved-searches/:id", requireUser, talentOnly, async (req, res) => {
  if (typeof req.body?.alerts !== "boolean") return res.status(400).json({ error: "Say whether alerts are on." });
  const { count } = await prisma.savedSearch.updateMany({ where: { id: req.params.id, userId: req.user.id }, data: { alerts: req.body.alerts } });
  if (!count) return res.status(404).json({ error: "Search not found." });
  res.json({ ok: true });
});

router.delete("/users/me/saved-searches/:id", requireUser, talentOnly, async (req, res) => {
  await prisma.savedSearch.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
  res.json({ ok: true });
});

// ── "Find someone for me" (client) ───────────────────────

const WAITING_STATES = ["requested", "building"];

async function shortlistView(request, { includeItems }) {
  const base = { id: request.id, skillKey: request.skillKey, skillLabel: skillByKey(request.skillKey)?.label ?? request.skillKey, jobType: request.jobType, currency: request.currency, budget: request.budget.toString(), status: request.status, requestedAt: request.createdAt, sentAt: request.sentAt };
  if (!includeItems || request.status !== "sent") return base;
  // Only talents who said yes are ever shown (D24).
  const yes = request.items.filter((i) => i.available === true);
  const now = new Date();
  const cards = await Promise.all(
    yes.map(async (i) => {
      const user = await prisma.user.findUnique({ where: { id: i.talentId }, include: discovery.talentInclude });
      return { reason: i.reason, talent: await discovery.talentCard(prisma, user, { viewerId: request.clientId, now }) };
    }),
  );
  return { ...base, shortlist: cards };
}

router.get("/shortlists/promise", requireUser, clientOnly, async (req, res) => {
  res.json(await discovery.shortlistPromise());
});

router.post("/shortlists", requireUser, clientOnly, rateLimit({ windowMs: 24 * 3600 * 1000, max: 5, key: "shortlist_request", by: (req) => req.user.id }), async (req, res) => {
  const b = req.body ?? {};
  const checked = briefs.validateBrief({ skillKey: b.skillKey, jobType: b.jobType ?? "oneDelivery", brief: b.brief, price: b.price });
  if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field });
  const currency = b.currency ?? "NGN";
  if (!briefs.CURRENCIES.includes(currency)) return res.status(400).json({ error: "Price it in naira or dollars." });
  if ((await prisma.shortlistRequest.count({ where: { clientId: req.user.id, status: { in: WAITING_STATES } } })) >= 2) {
    return res.status(409).json({ error: "You already have two requests waiting. We'll send those first.", code: "limit" });
  }
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 600) : "";
  if (require("../safety").detectRisk(note).length) return res.status(400).json({ error: "Keep contact details, links and payment talk out of the note. Everything happens inside King Domain." });
  const created = await prisma.shortlistRequest.create({ data: { clientId: req.user.id, skillKey: b.skillKey, jobType: b.jobType ?? "oneDelivery", currency, budget: checked.budget, brief: checked.brief, note: note || null, clockStartedAt: new Date() } });
  console.log(`shortlist: requested id=${created.id} client=${req.user.id} skill=${created.skillKey} clock=${created.clockStartedAt.toISOString()}`);
  res.status(201).json({ request: await shortlistView({ ...created, items: [] }, { includeItems: false }), promise: await discovery.shortlistPromise() });
});

router.get("/shortlists", requireUser, clientOnly, async (req, res) => {
  const rows = await prisma.shortlistRequest.findMany({ where: { clientId: req.user.id }, orderBy: { createdAt: "desc" }, take: 20, include: { items: true } });
  res.json({ requests: await Promise.all(rows.map((r) => shortlistView(r, { includeItems: true }))), promise: await discovery.shortlistPromise() });
});

// ── Asked first (talent) ─────────────────────────────────

router.get("/users/me/shortlist-asks", requireUser, talentOnly, async (req, res) => {
  const items = await prisma.shortlistItem.findMany({ where: { talentId: req.user.id, askedAt: { not: null }, request: { status: { in: WAITING_STATES } } }, orderBy: { askedAt: "desc" }, take: 20, include: { request: true } });
  res.json({
    asks: items.map((i) => ({ id: i.id, askedAt: i.askedAt, available: i.available, skillLabel: skillByKey(i.request.skillKey)?.label ?? i.request.skillKey, jobType: i.request.jobType, currency: i.request.currency, budget: i.request.budget.toString(), brief: i.request.brief })),
  });
});

router.post("/users/me/shortlist-asks/:itemId", requireUser, talentOnly, async (req, res) => {
  if (typeof req.body?.available !== "boolean") return res.status(400).json({ error: "Say whether you are available." });
  const { count } = await prisma.shortlistItem.updateMany({ where: { id: req.params.itemId, talentId: req.user.id, askedAt: { not: null }, available: null, request: { status: { in: WAITING_STATES } } }, data: { available: req.body.available } });
  if (!count) return res.status(409).json({ error: "This was already answered, or the request has closed.", code: "not_open" });
  res.json({ ok: true });
});

module.exports = { router };
