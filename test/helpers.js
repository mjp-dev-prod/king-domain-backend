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
    // DELETE /transferrecipient/:code (paystack.com/docs/api/transfer-recipient): sets it inactive.
    deletedRecipients: [],
    refuseRecipientDelete: false,
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
      const recipient = url.pathname.match(/^\/transferrecipient\/(.+)$/);
      if (req.method === "DELETE" && recipient) {
        if (provider.refuseRecipientDelete) return send(500, { status: false, message: "Paystack is having a bad day" });
        provider.deletedRecipients.push(decodeURIComponent(recipient[1]));
        return send(200, { status: true, message: "Transfer recipient set as inactive" });
      }
      // Bank lookups for the payout-account routes. `provider.accountName` is who the account belongs to.
      if (url.pathname === "/bank/resolve") {
        return send(200, { status: true, data: { account_number: url.searchParams.get("account_number"), account_name: provider.accountName ?? "Suite Talent" } });
      }
      if (url.pathname === "/bank") return send(200, { status: true, data: [{ name: "Test Bank", code: "058" }] });
      if (req.method === "POST" && url.pathname === "/transferrecipient") {
        return send(200, { status: true, data: { recipient_code: `RCP_${body.account_number}` } });
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

/**
 * A Supabase Storage stand-in speaking the REST calls @supabase/storage-js really makes (checked
 * against v2.115 in node_modules): create bucket, upload (raw body), remove by prefixes, sign, and a
 * public GET. `objects` maps "bucket/path" to { buffer, contentType } so a test can see exactly what
 * was stored; `faults` makes the next uploads or removals fail. The private buckets exist from the
 * start; anything else answers "Bucket not found" until it is created, like the real service.
 */
function serveFakeStorage() {
  const objects = new Map();
  const buckets = new Map([["proof-items", { public: false }], ["deliverables", { public: false }]]);
  const faults = { upload: false, remove: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (code, value) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let m;
      if (req.method === "POST" && p === "/storage/v1/bucket") {
        const b = JSON.parse(body.toString() || "{}");
        if (buckets.has(b.id)) return json(409, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
        buckets.set(b.id, { public: Boolean(b.public) });
        return json(200, { name: b.id });
      }
      if (req.method === "POST" && (m = p.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/))) {
        return json(200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=fake` });
      }
      if (req.method === "POST" && (m = p.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/))) {
        const [, bucket, path] = m;
        if (faults.upload) return json(500, { statusCode: "500", error: "Internal", message: "upload failed" });
        if (!buckets.has(bucket)) return json(404, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
        if (objects.has(`${bucket}/${path}`) && req.headers["x-upsert"] !== "true") {
          return json(409, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
        }
        objects.set(`${bucket}/${path}`, { buffer: body, contentType: req.headers["content-type"] });
        return json(200, { Id: `id-${objects.size}`, Key: `${bucket}/${path}` });
      }
      if (req.method === "DELETE" && (m = p.match(/^\/storage\/v1\/object\/([^/]+)$/))) {
        if (faults.remove) return json(500, { statusCode: "500", error: "Internal", message: "remove failed" });
        const removed = [];
        for (const prefix of JSON.parse(body.toString() || "{}").prefixes ?? []) {
          if (objects.delete(`${m[1]}/${prefix}`)) removed.push({ name: prefix });
        }
        return json(200, removed);
      }
      if (req.method === "GET" && (m = p.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/))) {
        const obj = buckets.get(m[1])?.public ? objects.get(`${m[1]}/${m[2]}`) : null;
        if (!obj) return json(404, { statusCode: "404", error: "not_found", message: "Object not found" });
        res.writeHead(200, { "Content-Type": obj.contentType });
        return res.end(obj.buffer);
      }
      json(404, { message: `fake storage: no route for ${req.method} ${p}` });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, objects, buckets, faults })),
  );
}

/**
 * A private R2 / S3 stand-in, path-style (/bucket/key), speaking what the SDK really sends for the calls
 * src/storage.js makes: a presigned PUT and GET (refused unless the link carries a signature, as the real
 * service refuses an unsigned one), HEAD, and DeleteObjects (POST /bucket?delete with an XML body).
 * `objects` maps "bucket/key" to { buffer, contentType, etag } so a test sees exactly what was stored.
 */
function serveFakeR2() {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      const key = decodeURIComponent(url.pathname).slice(1);
      const signed = url.searchParams.has("X-Amz-Signature") || Boolean(req.headers.authorization);
      const xml = (code, text) => {
        res.writeHead(code, { "Content-Type": "application/xml" });
        res.end(text);
      };
      if (!signed) return xml(403, "<Error><Code>AccessDenied</Code></Error>");
      if (req.method === "PUT") {
        const etag = crypto.createHash("md5").update(body).digest("hex");
        objects.set(key, { buffer: body, contentType: req.headers["content-type"], etag });
        res.writeHead(200, { ETag: `"${etag}"` });
        return res.end();
      }
      if (req.method === "HEAD" || req.method === "GET") {
        const o = objects.get(key);
        if (!o) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { "Content-Type": o.contentType, "Content-Length": o.buffer.length, ETag: `"${o.etag}"` });
        return res.end(req.method === "HEAD" ? undefined : o.buffer);
      }
      if (req.method === "POST" && url.searchParams.has("delete")) {
        const bucket = key.endsWith("/") ? key.slice(0, -1) : key;
        const deleted = [...body.toString().matchAll(new RegExp("<Key>([^<]+)</Key>", "g"))].map((m) => m[1].replace(/&amp;/g, "&"));
        for (const k of deleted) objects.delete(`${bucket}/${k}`);
        return xml(200, `<DeleteResult>${deleted.map((k) => `<Deleted><Key>${k}</Key></Deleted>`).join("")}</DeleteResult>`);
      }
      xml(404, "<Error><Code>NoSuchKey</Code></Error>");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, objects })));
}

/** Records every email the code tries to send, whatever the template. */
/**
 * A prisma client whose `model.method` holds its first `n` callers until all
 * of them have arrived, then lets them go together. Without it, two
 * "simultaneous" calls in a test can simply run one after the other, and a
 * race test passes even with its guard removed.
 */
function barrierPrisma(model, method, n = 2) {
  let waiting = [];
  let released = false;
  const gate = () =>
    released
      ? Promise.resolve()
      : new Promise((resolve) => {
          waiting.push(resolve);
          if (waiting.length >= n) {
            released = true;
            waiting.forEach((r) => r());
          }
        });
  const bind = (t, k) => (typeof t[k] === "function" ? t[k].bind(t) : t[k]);
  const wrapped = new Proxy(prisma[model], {
    get: (t, k) =>
      k === method
        ? async (args) => {
            const result = await t[method](args);
            await gate();
            return result;
          }
        : bind(t, k),
  });
  return new Proxy(prisma, { get: (t, k) => (k === model ? wrapped : bind(t, k)) });
}

function spyMailer() {
  const sent = [];
  return new Proxy(
    {},
    {
      get(_, key) {
        if (key === "sent") return sent;
        if (key === "then") return undefined; // not a promise
        return async (args = {}) => {
          sent.push({ k: key, to: args.to, args });
          return { sent: true };
        };
      },
    },
  );
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

const adminAuth = require("../src/admin/auth");
const adminJwt = require("../src/admin/jwt");

/** An active admin for tests; capabilities and reviewer skills are reset to what is passed. */
/** An incoming-webhook stand-in: records each JSON body, answers 200 "ok" like Slack does (500 when `fail`). */
function serveFakeSlack({ fail = false } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push(JSON.parse(raw || "{}"));
      res.writeHead(fail ? 500 : 200, { "Content-Type": "text/plain" });
      res.end(fail ? "error" : "ok");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/hook`, received, server })));
}

async function ensureAdmin(email, { role = "admin", capabilities = [], reviewerSkills = [] } = {}) {
  return prisma.adminUser.upsert({
    where: { email },
    update: { role, capabilities, reviewerSkills, status: "active" },
    create: { email, name: email.split("@")[0], role, capabilities, reviewerSkills, status: "active" },
  });
}

async function adminTokenFor(admin) {
  const { sessionId } = await adminAuth.createSession(admin.id, "test-suite");
  return adminJwt.generateAccessToken(admin, sessionId);
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
async function seedAward({ client, talentA, talentB }, { budget = 1000, contract = {}, job: jobData = {} } = {}) {
  const job = await prisma.job.create({
    data: { clientId: client.id, title: `${TITLE_PREFIX}${crypto.randomBytes(3).toString("hex")}`, category: CATEGORY, description: "suite", budget, ...jobData },
  });
  const a = await prisma.application.create({ data: { jobId: job.id, talentId: talentA.id, status: "selected" } });
  const b = await prisma.application.create({ data: { jobId: job.id, talentId: talentB.id, status: "notSelected" } });
  await prisma.job.update({ where: { id: job.id }, data: { awardedApplicationId: a.id } });
  const c = await prisma.contract.create({
    data: { jobId: job.id, status: "awaitingPayment", platformFeeAmount: budget * 0.1, payByAt: past(), ...contract },
  });
  return { job, a, b, c };
}

const DAY_MS = 24 * 3_600_000;

/** Funded and being worked on, with a delivery date. */
function seedWorking(ctx, { deliveryDays = 5, status = "inProgress", deliverByAt, contract = {} } = {}) {
  return seedAward(ctx, {
    job: { deliveryDays },
    contract: {
      status,
      payByAt: null,
      fundedAt: new Date(),
      deliverByAt: deliverByAt ?? new Date(Date.now() + deliveryDays * DAY_MS),
      ...contract,
    },
  });
}

/** Delivered (version 1 exists) and awaiting review. */
async function seedSubmitted(ctx, { changeRounds = 0, contract = {} } = {}) {
  const s = await seedWorking(ctx, {
    status: "submitted",
    contract: { submittedAt: new Date(), reviewDueAt: new Date(Date.now() + 3 * DAY_MS), deliverableNote: "v1", changeRounds, ...contract },
  });
  await prisma.contractDelivery.create({ data: { contractId: s.c.id, version: 1, note: "v1" } });
  return s;
}

/** Starts the real server against the test database, scheduler off, Paystack pointed at `paystackUrl`. */
async function startServer({ port, paystackUrl, autoRelease = true, storageUrl, env = {} }) {
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
      FCM_SERVICE_ACCOUNT_JSON: "", // same: a test server never pushes to a real phone
      // Same for storage: a test must never write a file into the real Supabase buckets in .env.
      // Off unless the test hands it a fake (serveFakeStorage).
      SUPABASE_URL: storageUrl ?? "",
      SUPABASE_SERVICE_ROLE_KEY: storageUrl ? "test-service-role-key" : "",
      R2_PRIVATE_BUCKET: "", // and never touches the real private R2 bucket unless a test passes a fake (env)
      R2_ENDPOINT: "",
      OPS_SCHEDULER: "off", // a test server never sweeps or sends a digest on its own
      OPS_SLACK_WEBHOOK_URL: "", // and never posts to the real Slack unless a test passes a fake
      // Every job type and currency is payable in a test server; the S5 test turns them off to check the gate.
      JOB_TYPES_ENABLED: "oneDelivery,milestones,monthly,hourly",
      USD_JOBS_ENABLED: "true",
      ...env,
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
    // 150 s: a cold Neon test branch plus the server's own start-up has taken 20 s to over a minute.
    if (i >= 750) {
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

module.exports = { serveFakeSlack, ensureAdmin, adminTokenFor, prisma, CATEGORY, TITLE_PREFIX, past, future, fakeProvider, serveFakeProvider, scopedPrisma, barrierPrisma, spyMailer, serveFakeStorage, serveFakeR2, ensureUser, fixtures, seedAward, seedWorking, seedSubmitted, DAY_MS, tokenFor, startServer, call };
