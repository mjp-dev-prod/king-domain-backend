const { PrismaClient } = require("./generated/prisma");
const { PrismaPg } = require("@prisma/adapter-pg");

// Prisma 7 requires an explicit driver adapter. Runtime queries go through
// the pooled connection; schema-diffing commands (db push/migrate) use
// DIRECT_URL instead — see scripts/db-push.js.
const adapter = new PrismaPg(process.env.DATABASE_URL);
const prisma = new PrismaClient({ adapter });

module.exports = { prisma };
