const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");

const router = express.Router();
router.use(requireAdmin);

const PAGE_SIZE = 50;

// ── Overview ─────────────────────────────────────────────

router.get("/stats", async (req, res) => {
  const [total, byRole, withNote, entries] = await Promise.all([
    prisma.waitlistEntry.count(),
    prisma.waitlistEntry.groupBy({ by: ["role"], _count: true }),
    prisma.waitlistEntry.count({ where: { note: { not: null } } }),
    // Category counts have to be tallied in JS — Postgres arrays don't
    // group cleanly through Prisma's typed API.
    prisma.waitlistEntry.findMany({ select: { role: true, categories: true, joinedAt: true } }),
  ]);

  const categories = new Map();
  for (const entry of entries) {
    for (const category of entry.categories) {
      const row = categories.get(category) ?? { category, total: 0, talent: 0, client: 0 };
      row.total += 1;
      row[entry.role] += 1;
      categories.set(category, row);
    }
  }

  // Signups per day, oldest first.
  const daily = new Map();
  for (const entry of entries) {
    const day = entry.joinedAt.toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + 1);
  }

  return res.json({
    total,
    talent: byRole.find((r) => r.role === "talent")?._count ?? 0,
    client: byRole.find((r) => r.role === "client")?._count ?? 0,
    withNote,
    categories: [...categories.values()].sort((a, b) => b.total - a.total),
    daily: [...daily.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  });
});

/** Free-text "other" answers — the categories we didn't think of. */
router.get("/notes", async (req, res) => {
  const notes = await prisma.waitlistEntry.findMany({
    where: { note: { not: null } },
    select: { id: true, note: true, role: true, joinedAt: true },
    orderBy: { joinedAt: "desc" },
    take: 200,
  });
  return res.json({ notes });
});

// ── Entries ──────────────────────────────────────────────

function buildWhere(query) {
  const where = {};
  const search = typeof query.search === "string" ? query.search.trim() : "";
  if (search) {
    where.OR = [
      { email: { contains: search, mode: "insensitive" } },
      { note: { contains: search, mode: "insensitive" } },
    ];
  }
  if (query.role === "talent" || query.role === "client") where.role = query.role;
  if (typeof query.category === "string" && query.category) {
    where.categories = { has: query.category };
  }
  return where;
}

router.get("/entries", async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const where = buildWhere(req.query);

  const [total, entries] = await Promise.all([
    prisma.waitlistEntry.count({ where }),
    prisma.waitlistEntry.findMany({
      where,
      orderBy: { joinedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return res.json({
    entries,
    page,
    pageSize: PAGE_SIZE,
    total,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
});

// ── Export ───────────────────────────────────────────────

/** Escape a value for CSV: quote it and double any interior quotes. */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

router.get("/export.csv", async (req, res) => {
  const entries = await prisma.waitlistEntry.findMany({
    where: buildWhere(req.query),
    orderBy: { joinedAt: "desc" },
  });

  const header = ["email", "role", "categories", "note", "joinedAt"];
  const rows = entries.map((e) =>
    [e.email, e.role, e.categories, e.note, e.joinedAt.toISOString()].map(csvCell).join(","),
  );

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="waitlist-${stamp}.csv"`);
  return res.send([header.join(","), ...rows].join("\n"));
});

module.exports = { router };
