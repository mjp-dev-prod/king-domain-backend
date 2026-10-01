// Shared harness for the database-backed suites.
//
// These tests write real rows, so they refuse to run unless TEST_DATABASE_URL
// is set explicitly and does not look like production. They never fall back
// to DATABASE_URL: a missing variable is a loud failure, not a silent skip
// that would read as a green run.
const crypto = require("crypto");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  throw new Error("TEST_DATABASE_URL is not set. Put the disposable test database URL in .env.test (see docs/core/testing.md).");
}
if (/supabase/i.test(TEST_DB)) {
  throw new Error("TEST_DATABASE_URL looks like the production database. Refusing to run.");
}

// Everything the code under test reads at require time must be set first.
process.env.DATABASE_URL = TEST_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-jwt-secret-not-used-anywhere-else";
process.env.PAYSTACK_SECRET_KEY = "sk_test_suite";

const { prisma } = require("../src/db");
const userAuth = require("../src/user/auth");
const jwt = require("../src/user/jwt");

const CATEGORY = "Design & creative";
const TITLE_PREFIX = "TestSuite ";
const past = (ms = 60_000) => new Date(Date.now() - ms);
const future = (ms = 3_600_000) => new Date(Date.now() + ms);

/**
 * A Paystack stand-in that obeys the rules Paystack documents
 * (paystack.com/docs/transfers/how-transfers-work and /api/errors/transfer):
 *  - a transfer reference can be used once; reuse is refused;
 *  - verifying a transfer that was never created finds nothing (null here);
 *  - an unknown transaction reads as `abandoned`.
 * It is a model of the documented behaviour, not a recording of the real API.
 */
function fakeProvider({ refusePayouts = false, transferStatus = "success", transactions = {} } = {}) {
  const transfers = new Map();
  const payouts = [];
  const initialised = [];
  return {
    transfers,
    payouts,
    initialised,
    transactions,
    verifyTransfer: async (ref) => transfers.get(ref) ?? null,
    initiateTransfer: async ({ reference, amountNaira }) => {
      if (refusePayouts) throw new Error("You cannot initiate third party payouts as a starter business");
      if (transfers.has(reference)) throw new Error("Please provide a unique reference. Reference already exists on a transfer");
      const t = { transferCode: `TRF_${reference}`, status: transferStatus };
      transfers.set(reference, t);
      payouts.push({ reference, amountNaira: Number(amountNaira) });
      return t;
    },
    verifyTransaction: async (ref) => transactions[ref] ?? { status: "abandoned", reference: ref, amountKobo: 0 },
  };
}

/** The same fake, served over HTTP so the real src/paystack.js client runs against it. */
function serveFakeProvider(provider) {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : {};
      if (url.pathname === "/transaction/initialize") {
        provider.initialised.push(body);
        return send(200, { status: true, data: { authorization_url: `https://checkout.test/${body.reference}`, access_code: "ac", reference: body.reference } });
      }
      const verify = url.pathname.match(/^\/transaction\/verify\/(.+)$/);
      if (verify) {
        const ref = decodeURIComponent(verify[1]);
        const t = provider.transactions[ref] ?? { status: "abandoned", reference: ref, amountKobo: 0 };
        return send(200, { status: true, data: { status: t.status, amount: t.amountKobo, reference: ref } });
      }
      send(404, { status: false, message: "not found" });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

/**
 * runTick sweeps every due contract in the database. The test database may
 * hold other people's rows, so the suite hands it a client that can only see
 * contracts of jobs this suite created.
 */
function scopedPrisma() {
  const onlyOurs = (args = {}) => ({ ...args, where: { AND: [args.where ?? {}, { job: { title: { startsWith: TITLE_PREFIX } } }] } });
  const contract = new Proxy(prisma.contract, {
    get: (target, key) => (key === "findMany" ? (args) => target.findMany(onlyOurs(args)) : target[key].bind(target)),
  });
  return new Proxy(prisma, { get: (target, key) => (key === "contract" ? contract : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
}

function spyMailer() {
  const sent = [];
  const m = { sent };
  for (const k of [
    "sendAwardCancelledToClient",
    "sendAwardCancelledToTalent",
    "sendPaymentAutoReleasedToTalent",
    "sendPaymentAutoReleasedToClient",
    "sendDeliveryAwaitingReview",
  ]) {
    m[k] = async (args) => {
      sent.push({ k, to: args.to });
      return { sent: true };
    };
  }
  return m;
}

async function ensureUser(email, role, fullName) {
  const passwordHash = await userAuth.hashPassword("Test-Suite-2026!");
  const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, passwordHash, role, fullName, emailVerified: true } });
  if (role === "talent") {
    await prisma.talentProfile.upsert({
      where: { userId: user.id },
      update: { paystackRecipientCode: "RCP_test_suite" },
      create: { userId: user.id, headline: "Test", bio: "Test", skillCategories: [CATEGORY], paystackRecipientCode: "RCP_test_suite" },
    });
  }
  return user;
}

async function tokenFor(user) {
  const { sessionId } = await userAuth.createSession(user.id, "test-suite");
  return jwt.generateAccessToken(user, sessionId);
}


/** Three fixed accounts, and a clean slate of the jobs this suite created. */
async function fixtures() {
  const client = await ensureUser("testsuite-client@example.com", "client", "Suite Client");
  const talentA = await ensureUser("testsuite-talent-a@example.com", "talent", "Suite Talent A");
  const talentB = await ensureUser("testsuite-talent-b@example.com", "talent", "Suite Talent B");
  await prisma.job.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
  return { client, talentA, talentB };
}

/** A job awarded to talentA with talentB also having applied, written straight to the database. */
async function seedAward({ client, talentA, talentB }, { budget = 1000, contract = {} } = {}) {
  const job = await prisma.job.create({
    data: { clientId: client.id, title: `${TITLE_PREFIX}${crypto.randomBytes(3).toString("hex")}`, category: CATEGORY, description: "suite", budget },
  });
  const a = await prisma.application.create({ data: { jobId: job.id, talentId: talentA.id, status: "selected" } });
  const b = await prisma.application.create({ data: { jobId: job.id, talentId: talentB.id, status: "notSelected" } });
  await prisma.job.update({ where: { id: job.id }, data: { awardedApplicationId: a.id } });
  const c = await prisma.contract.create({
    data: { jobId: job.id, status: "awaitingPayment", platformFeeAmount: budget * 0.1, payByAt: past(), ...contract },
  });
  return { job, a, b, c };
}

/** Starts the real server against the test database, scheduler off, Paystack pointed at `paystackUrl`. */
async function startServer({ port, paystackUrl, autoRelease = true }) {
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: TEST_DB,
      PAYSTACK_BASE_URL: paystackUrl,
      AUTO_RELEASE_ENABLED: autoRelease ? "true" : "false",
      CONTRACT_SCHEDULER: "off",
      BREVO_API_KEY: "", // set-but-empty so dotenv cannot fill it from .env: no real email
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (i >= 300) {
      child.kill();
      throw new Error(`test server did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { base, logs: () => log, stop: () => child.kill() };
}

const call = async (base, tok, method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

module.exports = { prisma, CATEGORY, TITLE_PREFIX, past, future, fakeProvider, serveFakeProvider, scopedPrisma, spyMailer, fixtures, seedAward, tokenFor, startServer, call };
