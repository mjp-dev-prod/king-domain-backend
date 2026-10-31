const express = require("express");
const { prisma } = require("../db");
const { requireAdmin, requireOwner, publicUser } = require("./routes");
const { CAPABILITIES, requireCapability } = require("./capabilities");
const { recordAudit } = require("./audit");
const { QUEUES, inboxFor } = require("./inbox");
const { raiseAlert } = require("../alerts");
const { isSkillKey } = require("../skills");

const router = express.Router();
router.use(requireAdmin);

const MAX_SHIFT_MS = 7 * 24 * 3600 * 1000;

router.get("/inbox", async (req, res) => {
  res.json({ queues: await inboxFor(prisma, req.admin) });
});

router.put("/inbox/targets/:queueKey", requireOwner, async (req, res) => {
  const queue = QUEUES.find((q) => q.key === req.params.queueKey);
  if (!queue) return res.status(404).json({ error: "No such queue." });
  const { targetMinutes, defaultWhenLate } = req.body ?? {};
  if (!Number.isInteger(targetMinutes) || targetMinutes < 1 || targetMinutes > 43200) {
    return res.status(400).json({ error: "targetMinutes must be a whole number from 1 to 43200 (30 days)." });
  }
  if (typeof defaultWhenLate !== "string" || defaultWhenLate.trim().length < 5 || defaultWhenLate.length > 300) {
    return res.status(400).json({ error: "Say what happens when the target passes, in 5 to 300 characters." });
  }
  const target = await prisma.$transaction(async (tx) => {
    const before = await tx.queueTarget.findUnique({ where: { queueKey: queue.key } });
    const row = await tx.queueTarget.upsert({
      where: { queueKey: queue.key },
      update: { targetMinutes, defaultWhenLate: defaultWhenLate.trim() },
      create: { queueKey: queue.key, targetMinutes, defaultWhenLate: defaultWhenLate.trim() },
    });
    await recordAudit(tx, req.admin, {
      action: "queue.target",
      subjectType: "Queue",
      subjectId: queue.key,
      details: { before, after: { targetMinutes: row.targetMinutes, defaultWhenLate: row.defaultWhenLate } },
    });
    return row;
  });
  res.json({ target });
});

router.get("/audit", requireCapability("shareholder"), async (req, res) => {
  const { subjectType, subjectId, actorId, action, before } = req.query;
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? "50", 10) || 50));
  const where = {
    ...(subjectType ? { subjectType: String(subjectType) } : {}),
    ...(subjectId ? { subjectId: String(subjectId) } : {}),
    ...(actorId ? { actorId: String(actorId) } : {}),
    ...(action ? { action: String(action) } : {}),
    ...(before && !Number.isNaN(Date.parse(before)) ? { createdAt: { lt: new Date(before) } } : {}),
  };
  const rows = await prisma.adminAuditEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    include: { actor: { select: { id: true, name: true, email: true } } },
  });
  const page = rows.slice(0, limit);
  res.json({
    events: page.map((e) => ({
      id: e.id,
      action: e.action,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      reasonCode: e.reasonCode,
      note: e.note,
      details: e.details,
      actorRole: e.actorRole,
      createdAt: e.createdAt,
      actor: e.actor,
    })),
    nextBefore: rows.length > limit ? page.at(-1).createdAt.toISOString() : null,
  });
});

router.get("/on-call", async (req, res) => {
  const from = req.query.from && !Number.isNaN(Date.parse(req.query.from)) ? new Date(req.query.from) : new Date();
  const shifts = await prisma.onCallShift.findMany({
    where: { endsAt: { gt: from } },
    orderBy: { startsAt: "asc" },
    take: 100,
    include: { admin: { select: { id: true, name: true, email: true } } },
  });
  res.json({ shifts: shifts.map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, admin: s.admin })) });
});

router.post("/on-call", requireOwner, async (req, res) => {
  const { adminId, startsAt, endsAt } = req.body ?? {};
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return res.status(400).json({ error: "A shift needs a start and an end after it." });
  }
  if (end - start > MAX_SHIFT_MS) return res.status(400).json({ error: "A shift can be at most 7 days long." });
  const admin = await prisma.adminUser.findUnique({ where: { id: String(adminId ?? "") } });
  if (!admin || admin.status !== "active") return res.status(400).json({ error: "Choose an active team member." });
  const shift = await prisma.$transaction(async (tx) => {
    const row = await tx.onCallShift.create({ data: { adminId: admin.id, startsAt: start, endsAt: end } });
    await recordAudit(tx, req.admin, {
      action: "oncall.create",
      subjectType: "OnCallShift",
      subjectId: row.id,
      details: { adminId: admin.id, startsAt: start, endsAt: end },
    });
    return row;
  });
  res.status(201).json({ shift });
});

router.delete("/on-call/:id", requireOwner, async (req, res) => {
  const shift = await prisma.onCallShift.findUnique({ where: { id: req.params.id } });
  if (!shift) return res.status(404).json({ error: "Shift not found." });
  await prisma.$transaction(async (tx) => {
    await tx.onCallShift.delete({ where: { id: shift.id } });
    await recordAudit(tx, req.admin, {
      action: "oncall.delete",
      subjectType: "OnCallShift",
      subjectId: shift.id,
      details: { adminId: shift.adminId, startsAt: shift.startsAt, endsAt: shift.endsAt },
    });
  });
  res.json({ ok: true });
});

router.patch("/admins/:id/capabilities", requireOwner, async (req, res) => {
  const { capabilities, reviewerSkills } = req.body ?? {};
  if (!Array.isArray(capabilities) || capabilities.some((c) => !CAPABILITIES.includes(c))) {
    return res.status(400).json({ error: `capabilities must be a list drawn from: ${CAPABILITIES.join(", ")}.` });
  }
  if (!Array.isArray(reviewerSkills) || reviewerSkills.some((s) => !isSkillKey(s))) {
    return res.status(400).json({ error: "reviewerSkills must be skill keys from GET /skills." });
  }
  const target = await prisma.adminUser.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "Admin not found." });
  const caps = [...new Set(capabilities)];
  const skills = [...new Set(reviewerSkills)];
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.adminUser.update({ where: { id: target.id }, data: { capabilities: caps, reviewerSkills: skills } });
    await recordAudit(tx, req.admin, {
      action: "admin.capabilities",
      subjectType: "AdminUser",
      subjectId: target.id,
      details: {
        before: { capabilities: target.capabilities, reviewerSkills: target.reviewerSkills },
        after: { capabilities: row.capabilities, reviewerSkills: row.reviewerSkills },
      },
    });
    return row;
  });
  res.json({ admin: publicUser(updated) });
});

router.post("/alerts/test", requireOwner, async (req, res) => {
  const name = req.admin.name || req.admin.email;
  const alert = await raiseAlert(prisma, {
    severity: "urgent",
    queueKey: "test",
    title: `Test alert from ${name}`,
    body: "If you can read this on your phone, urgent alerts reach you.",
    link: "/inbox",
  });
  await recordAudit(prisma, req.admin, {
    action: "alert.test",
    subjectType: "OpsAlert",
    subjectId: alert.id,
    details: { slackSent: alert.slackSent, emailedTo: alert.emailedTo },
  });
  res.json({ alert });
});

module.exports = { router };
