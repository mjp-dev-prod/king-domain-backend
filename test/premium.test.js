// S8, premium: purchases bought through Google Play are checked with Google (a local stand-in speaking the calls the real
// API takes), recorded once, consumed, and used once. Premium never buys a better place, and nothing is charged for a
// purchase we couldn't check. Also: reopening a paused job, and asking a client a question before applying.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const h = require("./helpers");
const { prisma } = h;

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = JSON.stringify({ client_email: "play@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });

/** What Google would say about each purchase token, and what was asked of it. */
function serveFakeGoogle() {
  const purchases = new Map();
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/token") {
        const assertion = new URLSearchParams(raw).get("assertion") ?? "";
        const claims = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "e30", "base64url").toString());
        if (claims.iss !== "play@test.iam.gserviceaccount.com" || claims.scope !== "https://www.googleapis.com/auth/androidpublisher") return send(400, { error: "invalid_grant" });
        return send(200, { access_token: "fake-token", expires_in: 3600 });
      }
      if (req.headers.authorization !== "Bearer fake-token") return send(401, { error: { message: "no token" } });
      const m = url.pathname.match(/^\/androidpublisher\/v3\/applications\/([^/]+)\/purchases\/products\/([^/]+)\/tokens\/([^/:]+)(:consume)?$/);
      if (!m) return send(404, { error: { message: "no route" } });
      const p = purchases.get(decodeURIComponent(m[3]));
      if (!p || p.productId !== decodeURIComponent(m[2])) return send(404, { error: { message: "Purchase not found" } });
      if (m[4]) {
        p.consumptionState = 1;
        return send(200, {});
      }
      send(200, p);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, purchases, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

let ctx, server, google, fakeProvider, cl, ca, tb, premium;

const setEnv = (url) => {
  Object.assign(process.env, { PLAY_PACKAGE_NAME: "com.kingdomain", PLAY_SERVICE_ACCOUNT_JSON: SA, PLAY_PRODUCT_REOPEN: "kd.reopen", PLAY_PRODUCT_QUESTION: "kd.question", PLAY_API_BASE: url, PLAY_TOKEN_URL: `${url}/token`, PREMIUM_ENFORCED: "true" });
};

before(async () => {
  ctx = await h.fixtures();
  google = await serveFakeGoogle();
  setEnv(google.url);
  premium = require("../src/premium");
  fakeProvider = await h.serveFakeProvider(h.fakeProvider());
  server = await h.startServer({
    port: 4711,
    paystackUrl: fakeProvider.url,
    autoRelease: false,
    env: { PLAY_PACKAGE_NAME: "com.kingdomain", PLAY_SERVICE_ACCOUNT_JSON: SA, PLAY_PRODUCT_REOPEN: "kd.reopen", PLAY_PRODUCT_QUESTION: "kd.question", PLAY_API_BASE: google.url, PLAY_TOKEN_URL: `${google.url}/token`, PREMIUM_ENFORCED: "true" },
  });
  [cl, ca, tb] = await Promise.all([h.tokenFor(ctx.client), h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB)]);
  await reset();
});
after(async () => {
  server?.stop();
  google?.server.close();
  fakeProvider?.server.close();
  await reset();
  for (const k of ["PLAY_PACKAGE_NAME", "PLAY_SERVICE_ACCOUNT_JSON", "PLAY_PRODUCT_REOPEN", "PLAY_PRODUCT_QUESTION", "PLAY_API_BASE", "PLAY_TOKEN_URL", "PREMIUM_ENFORCED"]) delete process.env[k];
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);
let n = 0;
const token = () => `tok-${Date.now()}-${n++}-${crypto.randomBytes(6).toString("hex")}`;

async function reset() {
  await prisma.entitlement.deleteMany({ where: { userId: { in: [ctx.client.id, ctx.talentA.id, ctx.talentB.id] } } });
  await prisma.preApplyQuestion.deleteMany({ where: { job: undefined, talentId: { in: [ctx.talentA.id, ctx.talentB.id] } } }).catch(() => {});
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
}

const bought = (productId, over = {}) => {
  const t = token();
  google.purchases.set(t, { kind: "androidpublisher#productPurchase", productId, purchaseState: 0, consumptionState: 0, acknowledgementState: 0, orderId: `GPA.${t}`, ...over });
  return t;
};

describe("verifying a purchase", () => {
  it("grants one entitlement, consumes it with Google so it can be bought again, and says what is left", async () => {
    const t = bought("kd.question");
    const r = await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: t });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status.features.find((f) => f.feature === "pre_apply_question").credits, 1);
    assert.ok(google.calls.some((c) => c.includes(`${t}:consume`)), "consumed so the product can be bought again");
    assert.equal(google.purchases.get(t).consumptionState, 1);
  });

  it("is safe to send twice: one entitlement, not two", async () => {
    const t = bought("kd.question");
    await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: t });
    const again = await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: t });
    assert.equal(again.status, 200);
    assert.equal(again.json.already, true);
    assert.equal(await prisma.entitlement.count({ where: { purchaseToken: t } }), 1);
  });

  it("one account's purchase can't be spent by another", async () => {
    const t = bought("kd.question");
    await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: t });
    assert.equal((await api(tb, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: t })).json.code, "token_used");
    const tagged = bought("kd.question", { obfuscatedExternalAccountId: ctx.talentA.id });
    assert.equal((await api(tb, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: tagged })).json.code, "token_used");
  });

  it("refuses a purchase Google doesn't know, a cancelled one, a pending one, and a product we don't sell", async () => {
    assert.equal((await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: "does-not-exist-anywhere" })).json.code, "not_found");
    const cancelled = bought("kd.question", { purchaseState: 1 });
    assert.equal((await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: cancelled })).json.code, "not_paid");
    const pending = bought("kd.question", { purchaseState: 2 });
    const r = await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: pending });
    assert.equal(r.json.code, "not_paid");
    assert.match(r.json.error, /pending/);
    assert.equal((await api(ca, "POST", "/premium/verify", { productId: "kd.gold", purchaseToken: token() })).json.code, "unknown_product");
    assert.equal(await prisma.entitlement.count({ where: { purchaseToken: { in: [cancelled, pending] } } }), 0, "nothing granted for a purchase that isn't paid");
  });

  it("says plainly when buying isn't set up, so the phone never completes a purchase it couldn't verify", async () => {
    const keep = process.env.PLAY_SERVICE_ACCOUNT_JSON;
    delete process.env.PLAY_SERVICE_ACCOUNT_JSON;
    const r = await premium.verifyAndGrant({ userId: ctx.talentA.id, productId: "kd.question", purchaseToken: token().padEnd(20, "x") });
    process.env.PLAY_SERVICE_ACCOUNT_JSON = keep;
    assert.equal(r.code, "billing_unavailable");
    assert.equal(r.status, 503);
    assert.match(r.error, /Nothing was charged/);
  });

  it("states the rule: premium never buys a better place, and nobody asks for money to get a job", async () => {
    const s = await api(ca, "GET", "/premium/status");
    assert.equal(s.json.enforced, true);
    assert.equal(s.json.billingConfigured, true);
    assert.match(s.json.rule, /never buys a better place/);
    assert.match(s.json.rule, /Nobody on King Domain will ever ask you for money to get or do a job/);
  });
});

describe("asking before applying", () => {
  async function liveJob() {
    return prisma.job.create({ data: { clientId: ctx.client.id, title: `${h.TITLE_PREFIX}Q${n++}`, category: h.CATEGORY, description: "d", budget: 5000, postStatus: "live", skillKey: "graphic-design" } });
  }

  it("costs one entitlement when premium is enforced, and says which product to buy when there is none", async () => {
    await reset();
    const job = await liveJob();
    const none = await api(ca, "POST", `/jobs/${job.id}/questions`, { question: "Is the logo for print or screen only?" });
    assert.equal(none.status, 402);
    assert.equal(none.json.code, "premium_required");
    assert.equal(none.json.productId, "kd.question");

    await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: bought("kd.question") });
    const ok = await api(ca, "POST", `/jobs/${job.id}/questions`, { question: "Is the logo for print or screen only?" });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal((await api(ca, "GET", "/premium/status")).json.features.find((f) => f.feature === "pre_apply_question").credits, 0);
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/questions`, { question: "And what size is the artboard?" })).status, 402, "one purchase, one question");
  });

  it("the answer is shown to every applicant, without names, and the asker sees theirs before it is answered", async () => {
    await reset();
    const job = await liveJob();
    await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: bought("kd.question") });
    const q = (await api(ca, "POST", `/jobs/${job.id}/questions`, { question: "Is the logo for print or screen only?" })).json.questions[0];
    assert.equal(q.mine, true);
    assert.equal((await api(tb, "GET", `/jobs/${job.id}/questions`)).json.questions.length, 0, "an unanswered question is not for everyone");
    const forClient = (await api(cl, "GET", `/jobs/${job.id}/questions`)).json.questions[0];
    assert.equal(forClient.canAnswer, true);

    assert.equal((await api(ca, "POST", `/questions/${q.id}/answer`, { answer: "Both." })).status, 403, "only the client answers");
    const answered = await api(cl, "POST", `/questions/${q.id}/answer`, { answer: "Both, so please send vector files too." });
    assert.equal(answered.status, 200, JSON.stringify(answered.json));
    const other = (await api(tb, "GET", `/jobs/${job.id}/questions`)).json.questions;
    assert.equal(other.length, 1, "information is never paywalled");
    assert.equal(other[0].answer, "Both, so please send vector files too.");
    assert.equal(other[0].mine, false);
    assert.equal(JSON.stringify(other).includes(ctx.talentA.id), false, "no names");
    assert.equal((await api(cl, "POST", `/questions/${q.id}/answer`, { answer: "Again." })).json.code, "answered");
  });

  it("catches contact details in a question or an answer", async () => {
    await reset();
    const job = await liveJob();
    await api(ca, "POST", "/premium/verify", { productId: "kd.question", purchaseToken: bought("kd.question") });
    const bad = await api(ca, "POST", `/jobs/${job.id}/questions`, { question: "Can you WhatsApp me on 08031234567 about it?" });
    assert.equal(bad.json.code, "flagged");
    assert.equal((await api(ca, "GET", "/premium/status")).json.features.find((f) => f.feature === "pre_apply_question").credits, 1, "a refused question keeps the purchase");
  });

  it("is free when premium isn't enforced (before launch)", async () => {
    await reset();
    const job = await liveJob();
    process.env.PREMIUM_ENFORCED = "false";
    const r = await premium.use({ userId: ctx.talentB.id, feature: "pre_apply_question", usedOn: job.id });
    process.env.PREMIUM_ENFORCED = "true";
    assert.deepEqual({ ok: r.ok, free: r.free }, { ok: true, free: true });
  });
});

describe("reopening a paused job", () => {
  async function pausedJob() {
    const job = await prisma.job.create({ data: { clientId: ctx.client.id, title: `${h.TITLE_PREFIX}Paused${n++}`, category: h.CATEGORY, description: "d", budget: 5000, postStatus: "live", skillKey: "graphic-design", liveAt: new Date(Date.now() - 6 * 86_400_000) } });
    return job;
  }

  it("costs one entitlement, names the product when there is none, and lifts the cap once", async () => {
    await reset();
    const job = await pausedJob();
    const none = await api(cl, "POST", `/jobs/${job.id}/reopen`);
    assert.equal(none.status, 402);
    assert.equal(none.json.code, "premium_required");
    assert.equal(none.json.productId, "kd.reopen");
    assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).reopenedAt, null);

    await api(cl, "POST", "/premium/verify", { productId: "kd.reopen", purchaseToken: bought("kd.reopen") });
    const ok = await api(cl, "POST", `/jobs/${job.id}/reopen`);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.ok((await prisma.job.findUnique({ where: { id: job.id } })).reopenedAt);
    assert.equal((await prisma.entitlement.findFirst({ where: { userId: ctx.client.id, feature: "reopen_job" } })).status, "used");
  });

  it("a job that isn't paused doesn't use one up", async () => {
    await reset();
    await api(cl, "POST", "/premium/verify", { productId: "kd.reopen", purchaseToken: bought("kd.reopen") });
    const fresh = await prisma.job.create({ data: { clientId: ctx.client.id, title: `${h.TITLE_PREFIX}Fresh`, category: h.CATEGORY, description: "d", budget: 5000, postStatus: "live", skillKey: "graphic-design", liveAt: new Date() } });
    const r = await api(cl, "POST", `/jobs/${fresh.id}/reopen`);
    assert.equal(r.json.code, "not_paused");
    assert.equal((await prisma.entitlement.findFirst({ where: { userId: ctx.client.id } })).status, "granted");
  });
});
