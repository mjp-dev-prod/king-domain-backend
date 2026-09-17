// `prisma db push` / `migrate dev` hang indefinitely against Supabase's
// transaction-mode pooler (port 6543) — schema-diffing commands need the
// direct (session-mode, port 5432) connection. Runtime queries are fine
// through the pooler, so this override only applies to this one command.
require("dotenv/config");
const { spawnSync } = require("node:child_process");

const directUrl = process.env.DIRECT_URL;
if (!directUrl) {
  console.error("DIRECT_URL is not set — check your .env file.");
  process.exit(1);
}

const args = process.argv.slice(2);
const result = spawnSync("npx", ["prisma", ...args], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: directUrl },
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// `db push` changes the schema but does NOT regenerate the client — every
// schema change silently left the old generated client in place until the
// next unrelated `prisma generate`, which meant new/changed fields threw
// "Unknown argument" PrismaClientValidationErrors at runtime, not at push
// time. Caught the hard way once (deliverableFilePath, Sept 2026) — always
// regenerate right after a successful push so this can't happen again.
if (args[0] === "db" && args[1] === "push") {
  const generateResult = spawnSync("npx", ["prisma", "generate"], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: directUrl },
  });
  process.exit(generateResult.status ?? 1);
}

process.exit(0);
