const { PrismaClient } = require("./generated/prisma");
const { PrismaPg } = require("@prisma/adapter-pg");

// Prisma 7 requires an explicit driver adapter. Runtime queries go through
// the pooled connection; schema-diffing commands (db push/migrate) use
// DIRECT_URL instead — see scripts/db-push.js.
// Prisma 7's pg adapter has no connect timeout by default, so a database
// that never answers (rather than refusing) would hang requests forever.
// 10s covers a Neon compute waking from scale-to-zero (~0.5–2s).
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
const prisma = new PrismaClient({ adapter });

module.exports = { prisma };
