/**
 * Bootstrap the first admin. Deliberately a CLI script rather than an
 * endpoint — there is no safe way to expose "make me an owner" over HTTP.
 *
 *   node scripts/create-owner.js you@example.com "Your Name"
 *
 * Prints a single-use invite link; open it to set a password.
 */
require("dotenv/config");
const auth = require("../src/admin/auth");
const { prisma } = require("../src/db");

async function main() {
  const [email, name] = process.argv.slice(2);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: node scripts/create-owner.js <email> ["Name"]');
    process.exit(1);
  }

  const { user, token } = await auth.createInvite({
    email,
    name: name ?? null,
    role: "owner",
  });

  const base = process.env.ADMIN_APP_URL || "http://localhost:5174";

  console.log(`\nOwner invited: ${user.email}`);
  console.log(`Expires in ${auth.INVITE_TTL_HOURS} hours. Single use.\n`);
  console.log(`${base}/accept-invite?token=${token}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
