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

process.exit(result.status ?? 1);
