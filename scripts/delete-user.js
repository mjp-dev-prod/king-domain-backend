/**
 * Delete a user's account on their request when they cannot use the app (the web page tells people to
 * email us from the address on the account). Same rules and same code as the app's Delete account:
 * refused while a contract is unfinished, everything personal removed, finished jobs kept anonymised.
 *
 *   node scripts/delete-user.js --email person@example.com          shows what would happen, changes nothing
 *   node scripts/delete-user.js --email person@example.com --yes    does it
 *
 * Check the request came from the address on the account before running it with --yes. It runs against
 * whatever DATABASE_URL is set, and prints which database that is first.
 */
require("dotenv/config");
const { prisma } = require("../src/db");
const accounts = require("../src/accounts");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: node scripts/delete-user.js --email <address> [--yes]");
    return 1;
  }
  console.log(`database: ${new URL(process.env.DATABASE_URL).host}`);

  const user = await prisma.user.findUnique({ where: { email }, include: { talentProfile: { select: { id: true } } } });
  if (!user || user.deletedAt) {
    console.error(`No live account with the address ${email}.`);
    return 1;
  }
  const contracts = await accounts.activeContracts(prisma, user.id);
  console.log(`${user.role} "${user.fullName}" (${user.id}), ${contracts.length} unfinished contract(s).`);
  if (contracts.length) {
    for (const c of contracts) console.log(`  - ${c.role} on "${c.title}": ${c.status}`);
    console.error("Refused (active_contracts): an account with an active contract cannot be deleted until it is resolved.");
    return 1;
  }
  if (!process.argv.includes("--yes")) {
    console.error("Nothing changed. Re-run with --yes to delete this account.");
    return 1;
  }

  const result = await accounts.deleteAccount({ userId: user.id });
  if (!result.ok) {
    console.error(`Refused (${result.code}): ${result.error}`);
    return 1;
  }
  console.log(`Deleted. Counts: ${JSON.stringify(result.summary)}. Cleanup left over: ${result.cleanup.length ? result.cleanup.join(", ") : "nothing"}.`);
  return 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
