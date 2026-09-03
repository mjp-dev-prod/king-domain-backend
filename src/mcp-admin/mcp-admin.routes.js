const express = require("express");
const { prisma } = require("../db");
const { requireMcpToken } = require("./mcp-admin.middleware");

const router = express.Router();
router.use(requireMcpToken);

const STANCES = ["agree", "disagree", "need_discussion"];
const DECISION_PAGE_SIZE = 20;
const WAITLIST_PAGE_SIZE = 50;
const LATEST_SIGNUPS_LIMIT = 10;

// The MCP token has no session user — mutations attribute to a fixed
// "system" actor rather than any real AdminUser row, since AdminUser.id is
// a foreign key everywhere. Tools that logically belong to a person (e.g.
// create_decision) instead take an explicit onBehalfOfEmail so the caller
// says who they're acting for; the tool descriptions carry this.
async function resolveActingAdmin(email) {
  if (!email) return null;
  return prisma.adminUser.findUnique({ where: { email } });
}

/** Log tier-2/3 calls to the shared, durable audit table (see schema.prisma). */
async function auditLog({ tool, tier, method, path, args, statusCode }) {
  if (tier < 2) return;
  try {
    await prisma.mcpAuditLog.create({
      data: { tool, tier, method, path, args: args ?? undefined, statusCode },
    });
  } catch (err) {
    console.error("mcp-admin: audit log write failed:", err);
  }
}

function publicAdmin(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status };
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

const listInclude = { createdBy: true, closedBy: true, stances: { include: { user: true } } };
const detailInclude = { ...listInclude, comments: { include: { user: true }, orderBy: { createdAt: "asc" } } };

// ── Decisions (tier 1: read) ──────────────────────────────

router.get("/decisions", async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const where = {};
  if (req.query.status === "open" || req.query.status === "closed") where.status = req.query.status;
  if (typeof req.query.milestoneRef === "string" && req.query.milestoneRef) {
    where.milestoneRef = req.query.milestoneRef;
  }

  const [total, decisions] = await Promise.all([
    prisma.decision.count({ where }),
    prisma.decision.findMany({
      where,
      include: listInclude,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * DECISION_PAGE_SIZE,
      take: DECISION_PAGE_SIZE,
    }),
  ]);

  return res.json({
    decisions: decisions.map(serializeDecision),
    page,
    pageSize: DECISION_PAGE_SIZE,
    total,
    pages: Math.max(1, Math.ceil(total / DECISION_PAGE_SIZE)),
  });
});

router.get("/decisions/:id", async (req, res) => {
  const decision = await prisma.decision.findUnique({
    where: { id: req.params.id },
    include: detailInclude,
  });
  if (!decision) return res.status(404).json({ error: "Decision not found." });
  return res.json({ decision: serializeDecision(decision) });
});

// ── Decisions (tier 2: scoped writes) ─────────────────────

router.post("/decisions", async (req, res) => {
  const { title, description, milestoneRef, onBehalfOfEmail } = req.body ?? {};

  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "Title is required." });
  }
  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "Description is required." });
  }

  const actor = await resolveActingAdmin(onBehalfOfEmail);
  if (!actor || actor.role !== "owner") {
    return res.status(400).json({
      error: "onBehalfOfEmail must be the email of an active owner-role admin.",
    });
  }

  const decision = await prisma.decision.create({
    data: {
      title: title.trim(),
      description: description.trim(),
      milestoneRef: typeof milestoneRef === "string" && milestoneRef.trim() ? milestoneRef.trim() : null,
      createdById: actor.id,
    },
    include: detailInclude,
  });

  await auditLog({
    tool: "create_decision",
    tier: 2,
    method: "POST",
    path: "/decisions",
    args: { title, milestoneRef, onBehalfOfEmail },
    statusCode: 201,
  });

  return res.status(201).json({ decision: serializeDecision(decision) });
});

router.post("/decisions/:id/stance", async (req, res) => {
  const { stance, onBehalfOfEmail } = req.body ?? {};
  if (!STANCES.includes(stance)) return res.status(400).json({ error: "Unknown stance." });

  const actor = await resolveActingAdmin(onBehalfOfEmail);
  if (!actor) return res.status(400).json({ error: "onBehalfOfEmail must be an active admin's email." });

  const decision = await prisma.decision.findUnique({ where: { id: req.params.id } });
  if (!decision) return res.status(404).json({ error: "Decision not found." });
  if (decision.status !== "open") return res.status(400).json({ error: "This decision is closed." });

  await prisma.decisionStance.upsert({
    where: { decisionId_userId: { decisionId: decision.id, userId: actor.id } },
    update: { stance },
    create: { decisionId: decision.id, userId: actor.id, stance },
  });

  const updated = await prisma.decision.findUnique({ where: { id: decision.id }, include: detailInclude });

  await auditLog({
    tool: "cast_decision_stance",
    tier: 2,
    method: "POST",
    path: `/decisions/${req.params.id}/stance`,
    args: { stance, onBehalfOfEmail },
    statusCode: 200,
  });

  return res.json({ decision: serializeDecision(updated) });
});

router.post("/decisions/:id/comments", async (req, res) => {
  const { body, onBehalfOfEmail } = req.body ?? {};
  if (typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "Comment body is required." });
  }

  const actor = await resolveActingAdmin(onBehalfOfEmail);
  if (!actor) return res.status(400).json({ error: "onBehalfOfEmail must be an active admin's email." });

  const decision = await prisma.decision.findUnique({ where: { id: req.params.id } });
  if (!decision) return res.status(404).json({ error: "Decision not found." });
  if (decision.status !== "open") return res.status(400).json({ error: "This decision is closed." });

  await prisma.decisionComment.create({
    data: { decisionId: decision.id, userId: actor.id, body: body.trim() },
  });

  const [stances, admins] = await Promise.all([
    prisma.decisionStance.findMany({ where: { decisionId: decision.id }, select: { userId: true } }),
    prisma.adminUser.findMany({
      where: { status: "active", id: { not: actor.id } },
      select: { id: true },
    }),
  ]);
  const votedUserIds = new Set(stances.map((s) => s.userId));
  const recipients = admins.filter((a) => !votedUserIds.has(a.id));
  await Promise.all(
    recipients.map((a) =>
      prisma.pendingNotification.upsert({
        where: { decisionId_recipientId: { decisionId: decision.id, recipientId: a.id } },
        update: { commentCount: { increment: 1 } },
        create: { decisionId: decision.id, recipientId: a.id },
      }),
    ),
  );

  const updated = await prisma.decision.findUnique({ where: { id: decision.id }, include: detailInclude });

  await auditLog({
    tool: "add_decision_comment",
    tier: 2,
    method: "POST",
    path: `/decisions/${req.params.id}/comments`,
    args: { onBehalfOfEmail },
    statusCode: 201,
  });

  return res.status(201).json({ decision: serializeDecision(updated) });
});

// ── Decisions (tier 3: harder to reverse) ─────────────────

router.post("/decisions/:id/close", async (req, res) => {
  const { onBehalfOfEmail } = req.body ?? {};
  const actor = await resolveActingAdmin(onBehalfOfEmail);
  if (!actor || actor.role !== "owner") {
    return res.status(400).json({ error: "onBehalfOfEmail must be an active owner's email." });
  }

  const decision = await prisma.decision.findUnique({ where: { id: req.params.id } });
  if (!decision) return res.status(404).json({ error: "Decision not found." });

  const updated = await prisma.decision.update({
    where: { id: decision.id },
    data: { status: "closed", closedAt: new Date(), closedById: actor.id },
    include: detailInclude,
  });

  await auditLog({
    tool: "close_decision",
    tier: 3,
    method: "POST",
    path: `/decisions/${req.params.id}/close`,
    args: { onBehalfOfEmail },
    statusCode: 200,
  });

  return res.json({ decision: serializeDecision(updated) });
});

// ── Waitlist (tier 1: read) ────────────────────────────────

router.get("/waitlist/stats", async (req, res) => {
  const [total, byRole, entries] = await Promise.all([
    prisma.waitlistEntry.count(),
    prisma.waitlistEntry.groupBy({ by: ["role"], _count: true }),
    prisma.waitlistEntry.findMany({ select: { categories: true } }),
  ]);

  const categoryCounts = new Map();
  for (const entry of entries) {
    for (const category of entry.categories) {
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
  }

  return res.json({
    total,
    talent: byRole.find((r) => r.role === "talent")?._count ?? 0,
    client: byRole.find((r) => r.role === "client")?._count ?? 0,
    countByCategory: Object.fromEntries(categoryCounts),
  });
});

/**
 * Structured summary, not a raw file dump — MCP's stdio JSON-RPC channel
 * isn't a file-transfer mechanism, and this would eventually blow past
 * reasonable tool-output size as the waitlist grows. The real CSV download
 * stays on the dashboard's existing /admin/waitlist/export.csv endpoint.
 */
router.get("/waitlist/export-summary", async (req, res) => {
  const [total, categoryEntries, latest] = await Promise.all([
    prisma.waitlistEntry.count(),
    prisma.waitlistEntry.findMany({ select: { categories: true } }),
    prisma.waitlistEntry.findMany({
      orderBy: { joinedAt: "desc" },
      take: LATEST_SIGNUPS_LIMIT,
      select: { email: true, role: true, joinedAt: true },
    }),
  ]);

  const countByCategory = new Map();
  for (const entry of categoryEntries) {
    for (const category of entry.categories) {
      countByCategory.set(category, (countByCategory.get(category) ?? 0) + 1);
    }
  }

  return res.json({
    totalCount: total,
    countByCategory: Object.fromEntries(countByCategory),
    latestSignups: latest,
  });
});

router.get("/admins", async (req, res) => {
  const users = await prisma.adminUser.findMany({ orderBy: { createdAt: "asc" } });
  return res.json({ admins: users.map(publicAdmin) });
});

// ── Admin management (tier 3) ─────────────────────────────

router.post("/admins/:id/revoke", async (req, res) => {
  const { id } = req.params;
  const user = await prisma.adminUser.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: "Admin not found." });

  await prisma.$transaction([
    prisma.adminUser.update({ where: { id }, data: { status: "revoked" } }),
    prisma.adminSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.adminToken.updateMany({
      where: { userId: id, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);

  await auditLog({
    tool: "revoke_admin",
    tier: 3,
    method: "POST",
    path: `/admins/${id}/revoke`,
    args: { targetEmail: user.email },
    statusCode: 200,
  });

  return res.json({ ok: true });
});

module.exports = { router };
