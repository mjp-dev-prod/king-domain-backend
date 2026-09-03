const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const mailer = require("./mailer");

const router = express.Router();
router.use(requireAdmin);

const STANCES = ["agree", "disagree", "need_discussion"];

function requireOwner(req, res, next) {
  if (req.admin.role !== "owner") {
    return res.status(403).json({ error: "Owner access required." });
  }
  next();
}

function publicAdmin(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email };
}

function serializeDecision(decision) {
  const stanceCounts = { agree: 0, disagree: 0, need_discussion: 0 };
  for (const s of decision.stances) stanceCounts[s.stance] += 1;

  return {
    id: decision.id,
    title: decision.title,
    description: decision.description,
    milestoneRef: decision.milestoneRef,
    status: decision.status,
    createdBy: publicAdmin(decision.createdBy),
    createdAt: decision.createdAt,
    closedAt: decision.closedAt,
    closedBy: publicAdmin(decision.closedBy),
    stanceCounts,
    stances: decision.stances.map((s) => ({
      user: publicAdmin(s.user),
      stance: s.stance,
      updatedAt: s.updatedAt,
    })),
    comments: (decision.comments ?? []).map((c) => ({
      id: c.id,
      body: c.body,
      user: publicAdmin(c.user),
      createdAt: c.createdAt,
    })),
  };
}

const listInclude = {
  createdBy: true,
  closedBy: true,
  stances: { include: { user: true } },
};

const detailInclude = {
  ...listInclude,
  comments: { include: { user: true }, orderBy: { createdAt: "asc" } },
};

const PAGE_SIZE = 20;

function buildWhere(query) {
  const where = {};
  if (query.status === "open" || query.status === "closed") where.status = query.status;
  if (typeof query.milestoneRef === "string" && query.milestoneRef) {
    where.milestoneRef = query.milestoneRef;
  }
  return where;
}

/** Queue (or bump) a comment-notification digest row for one recipient. */
async function queueCommentNotification(decisionId, recipientId) {
  await prisma.pendingNotification.upsert({
    where: { decisionId_recipientId: { decisionId, recipientId } },
    update: { commentCount: { increment: 1 } },
    create: { decisionId, recipientId },
  });
}

// ── List / detail / create ───────────────────────────────

router.get("/", async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const where = buildWhere(req.query);

  const [total, decisions] = await Promise.all([
    prisma.decision.count({ where }),
    prisma.decision.findMany({
      where,
      include: listInclude,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return res.json({
    decisions: decisions.map(serializeDecision),
    page,
    pageSize: PAGE_SIZE,
    total,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
});

router.get("/:id", async (req, res) => {
  const decision = await prisma.decision.findUnique({
    where: { id: req.params.id },
    include: detailInclude,
  });
  if (!decision) return res.status(404).json({ error: "Decision not found." });
  return res.json({ decision: serializeDecision(decision) });
});

router.post("/", requireAdmin, requireOwner, async (req, res) => {
  const { title, description, milestoneRef } = req.body ?? {};

  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "Title is required." });
  }
  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "Description is required." });
  }

  const decision = await prisma.decision.create({
    data: {
      title: title.trim(),
      description: description.trim(),
      milestoneRef: typeof milestoneRef === "string" && milestoneRef.trim() ? milestoneRef.trim() : null,
      createdById: req.admin.id,
    },
    include: detailInclude,
  });

  // New decision → notify every other admin immediately (not batched — this
  // is owner-only and rare enough that instant delivery is fine per the plan).
  const recipients = await prisma.adminUser.findMany({
    where: { status: "active", id: { not: req.admin.id } },
    select: { email: true },
  });
  await Promise.all(
    recipients.map((r) =>
      mailer.sendNewDecisionNotice({ to: r.email, decision }).catch((err) => {
        console.error("decisionRoutes: sendNewDecisionNotice failed:", err);
      }),
    ),
  );

  return res.status(201).json({ decision: serializeDecision(decision) });
});

// ── Stance ────────────────────────────────────────────────

router.post("/:id/stance", async (req, res) => {
  const { stance } = req.body ?? {};
  if (!STANCES.includes(stance)) {
    return res.status(400).json({ error: "Unknown stance." });
  }

  const decision = await prisma.decision.findUnique({ where: { id: req.params.id } });
  if (!decision) return res.status(404).json({ error: "Decision not found." });
  if (decision.status !== "open") {
    return res.status(400).json({ error: "This decision is closed." });
  }

  await prisma.decisionStance.upsert({
    where: { decisionId_userId: { decisionId: decision.id, userId: req.admin.id } },
    update: { stance },
    create: { decisionId: decision.id, userId: req.admin.id, stance },
  });

  const updated = await prisma.decision.findUnique({
    where: { id: decision.id },
    include: detailInclude,
  });
  return res.json({ decision: serializeDecision(updated) });
});

// ── Comments ──────────────────────────────────────────────

router.post("/:id/comments", async (req, res) => {
  const { body } = req.body ?? {};
  if (typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "Comment body is required." });
  }

  const decision = await prisma.decision.findUnique({ where: { id: req.params.id } });
  if (!decision) return res.status(404).json({ error: "Decision not found." });
  if (decision.status !== "open") {
    return res.status(400).json({ error: "This decision is closed." });
  }

  await prisma.decisionComment.create({
    data: { decisionId: decision.id, userId: req.admin.id, body: body.trim() },
  });

  // Notify everyone who hasn't cast a stance yet — except the commenter —
  // via the batched digest queue, not an instant email per comment.
  const [stances, admins] = await Promise.all([
    prisma.decisionStance.findMany({
      where: { decisionId: decision.id },
      select: { userId: true },
    }),
    prisma.adminUser.findMany({
      where: { status: "active", id: { not: req.admin.id } },
      select: { id: true },
    }),
  ]);
  const votedUserIds = new Set(stances.map((s) => s.userId));
  const recipients = admins.filter((a) => !votedUserIds.has(a.id));
  await Promise.all(recipients.map((a) => queueCommentNotification(decision.id, a.id)));

  const updated = await prisma.decision.findUnique({
    where: { id: decision.id },
    include: detailInclude,
  });
  return res.status(201).json({ decision: serializeDecision(updated) });
});

// ── Close / reopen (owner only) ──────────────────────────

router.post("/:id/close", requireAdmin, requireOwner, async (req, res) => {
  const decision = await prisma.decision.findUnique({ where: { id: req.params.id } });
  if (!decision) return res.status(404).json({ error: "Decision not found." });

  const updated = await prisma.decision.update({
    where: { id: decision.id },
    data: { status: "closed", closedAt: new Date(), closedById: req.admin.id },
    include: detailInclude,
  });
  return res.json({ decision: serializeDecision(updated) });
});

router.post("/:id/reopen", requireAdmin, requireOwner, async (req, res) => {
  const decision = await prisma.decision.findUnique({ where: { id: req.params.id } });
  if (!decision) return res.status(404).json({ error: "Decision not found." });

  const updated = await prisma.decision.update({
    where: { id: decision.id },
    data: { status: "open", closedAt: null, closedById: null },
    include: detailInclude,
  });
  return res.json({ decision: serializeDecision(updated) });
});

module.exports = { router };
