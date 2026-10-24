// Push notifications (docs/features/push-notifications.md in the mobile repo): device tokens, the FCM
// sender against a fake FCM server (real HTTP, so the request shape is what Firebase documents), the
// outbox dispatcher over ContractEvent, the funded event, and reminders. Disposable users throughout.
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const h = require("./helpers");
const { prisma } = h;
const push = require("../src/push");
const messages = require("../src/pushMessages");
const dispatcher = require("../src/pushDispatcher");
const accounts = require("../src/accounts");
const { confirmFunding } = require("../src/contractFunding");
const { sweepReminders } = require("../src/contractReminders");

const uniq = () => crypto.randomBytes(4).toString("hex");
const fcmToken = () => `${uniq()}:APA91b${crypto.randomBytes(40).toString("hex")}`;
const made = [];
let server, fcm;

/** A Firebase Cloud Messaging stand-in: records every request, answers from a per-token script. */
function serveFakeFcm() {
  const requests = [];
  const script = new Map(); // token -> [{status, body}] consumed in order; the default is success
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const token = body.message?.token;
      requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
      const next = script.get(token)?.shift() ?? { status: 200, body: { name: `projects/king-test/messages/${requests.length}` } };
      res.writeHead(next.status, { "Content-Type": "application/json", ...(next.headers ?? {}) });
      res.end(JSON.stringify(next.body));
    });
  });
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}`, requests, script })));
}
const unregistered = { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } } };
const badToken = { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } } };
const badPayload = { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid value at 'message.data' (map)" } } };

let tokenCalls = [];
const sender = () =>
  push.createPush({
    prisma,
    projectId: "king-test",
    fcmBase: fcm.url,
    getAccessToken: async ({ force } = {}) => {
      tokenCalls.push(Boolean(force));
      return force ? "access-token-2" : "access-token-1";
    },
    sleep: async () => {},
  });

async function person(role = "talent") {
  const user = await h.ensureUser(`testsuite-push-${uniq()}@example.com`, role, `Push ${role}`);
  made.push(user);
  return user;
}
const tokensOf = async (u) => (await prisma.deviceToken.findMany({ where: { userId: u.id }, orderBy: { createdAt: "asc" } })).map((t) => t.token);

before(async () => {
  await h.fixtures();
  fcm = await serveFakeFcm();
  server = await h.startServer({ port: 4618, paystackUrl: "http://127.0.0.1:9", autoRelease: false });
});
after(async () => {
  server?.stop();
  fcm?.server.close();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { in: made.map((u) => u.id) } } });
  await prisma.$disconnect();
});
beforeEach(() => {
  fcm.requests.length = 0;
  fcm.script.clear();
  tokenCalls = [];
});

describe("device tokens", () => {
  it("registering stores the token for the person, and registering again only refreshes it", async () => {
    const u = await person();
    const t = fcmToken();
    assert.equal((await push.registerToken({ userId: u.id, token: t })).ok, true);
    const first = await prisma.deviceToken.findUnique({ where: { token: t } });
    await new Promise((r) => setTimeout(r, 20));
    await push.registerToken({ userId: u.id, token: t });
    const second = await prisma.deviceToken.findUnique({ where: { token: t } });
    assert.equal(await prisma.deviceToken.count({ where: { userId: u.id } }), 1);
    assert.ok(second.lastSeenAt > first.lastSeenAt, "lastSeenAt moves on every registration");
  });

  it("a token seen on another account moves to it (a shared phone)", async () => {
    const a = await person();
    const b = await person("client");
    const t = fcmToken();
    await push.registerToken({ userId: a.id, token: t });
    await push.registerToken({ userId: b.id, token: t });
    assert.deepEqual(await tokensOf(a), []);
    assert.deepEqual(await tokensOf(b), [t]);
  });

  it("keeps at most 10 devices per person, dropping the longest unseen", async () => {
    const u = await person();
    const tokens = Array.from({ length: 12 }, fcmToken);
    for (const [i, t] of tokens.entries()) {
      await push.registerToken({ userId: u.id, token: t });
      await prisma.deviceToken.update({ where: { token: t }, data: { lastSeenAt: new Date(Date.now() - (12 - i) * 60000) } });
    }
    await push.registerToken({ userId: u.id, token: tokens[11] }); // one more registration triggers the trim
    const kept = await tokensOf(u);
    assert.equal(kept.length, 10);
    assert.ok(!kept.includes(tokens[0]) && !kept.includes(tokens[1]), "the two least recently seen are gone");
    assert.ok(kept.includes(tokens[11]));
  });

  it("refuses something that is not a token", async () => {
    const u = await person();
    for (const bad of [undefined, null, 5, "", "short", "has spaces " + "x".repeat(40), "x".repeat(5000)]) {
      const r = await push.registerToken({ userId: u.id, token: bad });
      assert.equal(r.ok, false, String(bad).slice(0, 20));
      assert.equal(r.status, 400);
    }
    assert.deepEqual(await tokensOf(u), []);
  });

  it("unregistering removes the person's own token, and nobody else's", async () => {
    const a = await person();
    const b = await person();
    const ta = fcmToken();
    const tb = fcmToken();
    await push.registerToken({ userId: a.id, token: ta });
    await push.registerToken({ userId: b.id, token: tb });
    await push.unregisterToken({ userId: a.id, token: tb });
    assert.deepEqual(await tokensOf(b), [tb], "another person's token is untouched");
    await push.unregisterToken({ userId: a.id, token: ta });
    assert.deepEqual(await tokensOf(a), []);
    assert.equal((await push.unregisterToken({ userId: a.id, token: ta })).ok, true, "idempotent");
  });

  it("tokens unseen for 60 days are pruned, fresh ones stay", async () => {
    const u = await person();
    const old = fcmToken();
    const fresh = fcmToken();
    await push.registerToken({ userId: u.id, token: old });
    await push.registerToken({ userId: u.id, token: fresh });
    await prisma.deviceToken.update({ where: { token: old }, data: { lastSeenAt: new Date(Date.now() - 61 * 86400000) } });
    const r = await push.pruneStaleTokens({ days: 60 });
    assert.ok(r.removed >= 1);
    assert.deepEqual(await tokensOf(u), [fresh]);
  });

  it("deleting an account deletes its tokens", async () => {
    const u = await person();
    await push.registerToken({ userId: u.id, token: fcmToken() });
    const quiet = { storage: { removeAvatar: async () => {}, removePrivateFiles: async () => {} }, paystack: { configured: false }, mailer: h.spyMailer() };
    assert.equal((await accounts.deleteAccount({ userId: u.id }, quiet)).ok, true);
    assert.deepEqual(await tokensOf(u), []);
  });
});

describe("PUT and DELETE /users/me/device", () => {
  it("need a signed-in person, store and remove the token, and refuse junk", async () => {
    const u = await person();
    const tok = await h.tokenFor(u);
    const t = fcmToken();
    assert.equal((await h.call(server.base, "bad-token", "PUT", "/users/me/device", { token: t })).status, 401);
    assert.equal((await h.call(server.base, tok, "PUT", "/users/me/device", { token: "x" })).status, 400);
    const put = await h.call(server.base, tok, "PUT", "/users/me/device", { token: t });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.deepEqual(await tokensOf(u), [t]);
    const del = await h.call(server.base, tok, "DELETE", "/users/me/device", { token: t });
    assert.equal(del.status, 200);
    assert.deepEqual(await tokensOf(u), []);
  });
});

describe("the FCM sender", () => {
  it("sends the documented v1 request to every token of the person, with a bearer token", async () => {
    const u = await person();
    const [t1, t2] = [fcmToken(), fcmToken()];
    await push.registerToken({ userId: u.id, token: t1 });
    await push.registerToken({ userId: u.id, token: t2 });
    const r = await sender().notifyUser(u.id, { title: "You were picked", body: 'The client picked you for "Logo".', data: { type: "awarded", jobId: 42 } });
    assert.deepEqual([r.sent, r.removed, r.failed], [2, 0, 0]);
    assert.equal(fcm.requests.length, 2);
    for (const q of fcm.requests) {
      assert.equal(q.method, "POST");
      assert.equal(q.path, "/v1/projects/king-test/messages:send");
      assert.equal(q.auth, "Bearer access-token-1");
      assert.deepEqual(q.body.message.notification, { title: "You were picked", body: 'The client picked you for "Logo".' });
      assert.deepEqual(q.body.message.data, { type: "awarded", jobId: "42" }, "data values are strings, as FCM requires");
      assert.equal(q.body.message.android.priority, "HIGH");
      assert.equal(q.body.message.android.notification.channel_id, "kd_updates");
    }
    assert.deepEqual(fcm.requests.map((q) => q.body.message.token).sort(), [t1, t2].sort());
  });

  it("does nothing, and asks FCM nothing, for a person with no device", async () => {
    const u = await person();
    const r = await sender().notifyUser(u.id, { title: "x", body: "y" });
    assert.deepEqual([r.sent, r.removed, r.failed], [0, 0, 0]);
    assert.equal(fcm.requests.length, 0);
  });

  it("removes a token FCM says is dead (unregistered, or not a valid registration token) and keeps the others", async () => {
    const u = await person();
    const [dead, invalid, alive] = [fcmToken(), fcmToken(), fcmToken()];
    for (const t of [dead, invalid, alive]) await push.registerToken({ userId: u.id, token: t });
    fcm.script.set(dead, [unregistered]);
    fcm.script.set(invalid, [badToken]);
    const r = await sender().notifyUser(u.id, { title: "x", body: "y" });
    assert.deepEqual([r.sent, r.removed, r.failed], [1, 2, 0]);
    assert.deepEqual(await tokensOf(u), [alive]);
  });

  it("keeps a token when the refusal is about the message, not the token", async () => {
    const u = await person();
    const t = fcmToken();
    await push.registerToken({ userId: u.id, token: t });
    fcm.script.set(t, [badPayload]);
    const r = await sender().notifyUser(u.id, { title: "x", body: "y" });
    assert.deepEqual([r.sent, r.removed, r.failed], [0, 0, 1]);
    assert.deepEqual(await tokensOf(u), [t]);
  });

  it("retries a throttled send and succeeds; gives up on a server that stays down, keeping the token", async () => {
    const u = await person();
    const [flaky, down] = [fcmToken(), fcmToken()];
    await push.registerToken({ userId: u.id, token: flaky });
    await push.registerToken({ userId: u.id, token: down });
    fcm.script.set(flaky, [{ status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } }, headers: { "Retry-After": "1" } }]);
    fcm.script.set(down, [{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }]);
    const r = await sender().notifyUser(u.id, { title: "x", body: "y" });
    assert.deepEqual([r.sent, r.removed, r.failed], [1, 0, 1]);
    assert.equal(fcm.requests.filter((q) => q.body.message.token === flaky).length, 2);
    assert.equal(fcm.requests.filter((q) => q.body.message.token === down).length, 3, "one try and two retries, then it stops");
    assert.deepEqual((await tokensOf(u)).sort(), [flaky, down].sort());
  });

  it("an expired access token (401) is refreshed once and the send is repeated", async () => {
    const u = await person();
    const t = fcmToken();
    await push.registerToken({ userId: u.id, token: t });
    fcm.script.set(t, [{ status: 401, body: { error: { status: "UNAUTHENTICATED" } } }]);
    const r = await sender().notifyUser(u.id, { title: "x", body: "y" });
    assert.deepEqual([r.sent, r.failed], [1, 0]);
    assert.deepEqual(tokenCalls, [false, true], "the second call forced a fresh token");
    assert.deepEqual(fcm.requests.map((q) => q.auth), ["Bearer access-token-1", "Bearer access-token-2"]);
  });

  it("never throws: an unreachable FCM is a failed push, not a crash", async () => {
    const u = await person();
    await push.registerToken({ userId: u.id, token: fcmToken() });
    const dead = push.createPush({ prisma, projectId: "p", fcmBase: "http://127.0.0.1:9", getAccessToken: async () => "t", sleep: async () => {} });
    const r = await dead.notifyUser(u.id, { title: "x", body: "y" });
    assert.deepEqual([r.sent, r.failed], [0, 1]);
  });

  it("with no service account configured, nothing is sent and nothing is read", async () => {
    const saved = process.env.FCM_SERVICE_ACCOUNT_JSON;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    try {
      assert.equal(push.configured(), false);
      const r = await push.notifyUser("nobody", { title: "x", body: "y" });
      assert.deepEqual(r, { sent: 0, removed: 0, failed: 0, skipped: "not_configured" });
    } finally {
      if (saved !== undefined) process.env.FCM_SERVICE_ACCOUNT_JSON = saved;
    }
  });
});

describe("what each push says", () => {
  const job = { id: "j1", title: "Logo and brand kit" };
  it("an award tells the talent, a delivery tells the client, with the job in the data", () => {
    const awarded = messages.forEvent({ type: "awarded", meta: {} }, { job, clientId: "c", talentId: "t" });
    assert.deepEqual(awarded.map((m) => [m.userId, m.title]), [["t", "You were picked"]]);
    assert.match(awarded[0].body, /Logo and brand kit/);
    assert.deepEqual(awarded[0].data, { type: "awarded", jobId: "j1" });
    const submitted = messages.forEvent({ type: "submitted", meta: {} }, { job, clientId: "c", talentId: "t" });
    assert.deepEqual(submitted.map((m) => [m.userId, m.title]), [["c", "Work delivered"]]);
  });

  it("every mapped event goes to the right person", () => {
    const ctx = { job, clientId: "c", talentId: "t" };
    const who = (type, meta = {}) => messages.forEvent({ type, meta }, ctx).map((m) => m.userId).sort().join("");
    assert.equal(who("funded"), "t");
    assert.equal(who("resubmitted"), "c");
    assert.equal(who("changes_requested"), "t");
    assert.equal(who("extension_requested"), "c");
    assert.equal(who("extension_granted"), "t");
    assert.equal(who("extension_declined"), "t");
    assert.equal(who("extension_auto_granted"), "ct");
    assert.equal(who("released", { trigger: "client_approve" }), "t");
    assert.equal(who("released", { trigger: "auto_release" }), "ct");
    assert.equal(who("award_voided"), "ct");
    assert.equal(who("overdue"), "ct");
    assert.equal(who("escalated"), "ct");
  });

  it("events that are not for a person's phone say nothing", () => {
    const ctx = { job, clientId: "c", talentId: "t" };
    for (const type of ["checkout_started", "auto_release_failed", "late_payment_after_void", "something_new"]) {
      assert.deepEqual(messages.forEvent({ type, meta: {} }, ctx), [], type);
    }
  });

  it("a long job title is cut, and a missing person gets nothing", () => {
    const long = { id: "j", title: "x".repeat(200) };
    const m = messages.forEvent({ type: "awarded", meta: {} }, { job: long, clientId: "c", talentId: "t" })[0];
    assert.ok(m.body.length < 140, `${m.body.length}`);
    assert.deepEqual(messages.forEvent({ type: "awarded", meta: {} }, { job, clientId: "c", talentId: null }), []);
  });

  it("reminders say which clock, and name the job", () => {
    for (const kind of ["extension", "review", "change", "delivery", "deliveryPassed", "deliveryMissedPassed"]) {
      const m = messages.reminderMessage({ kind, jobTitle: "Logo", jobId: "j1" });
      assert.ok(m.title && m.body.includes("Logo"), kind);
      assert.deepEqual(m.data, { type: `reminder_${kind}`, jobId: "j1" });
    }
  });
});

describe("the dispatcher (outbox over ContractEvent)", () => {
  const spy = () => {
    const sent = [];
    return { sent, notifyUser: async (userId, message) => (sent.push({ userId, ...message }), { sent: 1, removed: 0, failed: 0 }) };
  };

  async function awarded(status = "awaitingPayment") {
    const client = await person("client");
    const talent = await person("talent");
    const job = await prisma.job.create({ data: { clientId: client.id, title: `${h.TITLE_PREFIX}push-${uniq()}`, category: h.CATEGORY, description: "suite", budget: 1000 } });
    const application = await prisma.application.create({ data: { jobId: job.id, talentId: talent.id, status: "selected" } });
    await prisma.job.update({ where: { id: job.id }, data: { awardedApplicationId: application.id } });
    const contract = await prisma.contract.create({ data: { jobId: job.id, status, platformFeeAmount: 100, payByAt: h.future() } });
    const event = (type, meta = {}, createdAt) => prisma.contractEvent.create({ data: { jobId: job.id, contractId: contract.id, type, meta, ...(createdAt ? { createdAt } : {}) } });
    return { client, talent, job, application, contract, event };
  }

  it("sends each new event once, to the right person, then marks it done", async () => {
    const s = await awarded();
    await s.event("awarded");
    await s.event("submitted");
    const p = spy();
    const r = await dispatcher.dispatchPending({ prisma, push: p });
    assert.equal(r.claimed >= 2, true);
    const mine = p.sent.filter((m) => m.data.jobId === s.job.id);
    assert.deepEqual(mine.map((m) => [m.userId, m.data.type]).sort(), [[s.talent.id, "awarded"], [s.client.id, "submitted"]].sort());
    assert.equal(await prisma.contractEvent.count({ where: { jobId: s.job.id, pushedAt: null } }), 0);
    const again = spy();
    await dispatcher.dispatchPending({ prisma, push: again });
    assert.equal(again.sent.filter((m) => m.data.jobId === s.job.id).length, 0, "nothing is sent twice");
  });

  it("two dispatchers at once still send each event exactly once", async () => {
    const s = await awarded();
    await s.event("funded");
    await s.event("changes_requested");
    const [a, b] = [spy(), spy()];
    await Promise.all([dispatcher.dispatchPending({ prisma, push: a }), dispatcher.dispatchPending({ prisma, push: b })]);
    const all = [...a.sent, ...b.sent].filter((m) => m.data.jobId === s.job.id);
    assert.equal(all.length, 2, JSON.stringify(all.map((m) => m.data.type)));
  });

  it("only looks at recent events: switching push on never replays history", async () => {
    const s = await awarded();
    await s.event("awarded", {}, new Date(Date.now() - 20 * 60 * 1000));
    const p = spy();
    await dispatcher.dispatchPending({ prisma, push: p });
    assert.equal(p.sent.filter((m) => m.data.jobId === s.job.id).length, 0);
  });

  it("events with nothing to say are marked done without a send", async () => {
    const s = await awarded();
    const e = await s.event("checkout_started", { reference: "r" });
    const p = spy();
    await dispatcher.dispatchPending({ prisma, push: p });
    assert.equal(p.sent.filter((m) => m.data.jobId === s.job.id).length, 0);
    assert.ok((await prisma.contractEvent.findUnique({ where: { id: e.id } })).pushedAt);
  });

  it("a cancelled award (contract already deleted) still reaches the talent who was picked", async () => {
    const s = await awarded();
    await s.event("award_voided", { awardedApplicationId: s.application.id });
    await prisma.job.update({ where: { id: s.job.id }, data: { awardedApplicationId: null } });
    await prisma.contract.delete({ where: { id: s.contract.id } });
    const p = spy();
    await dispatcher.dispatchPending({ prisma, push: p });
    const mine = p.sent.filter((m) => m.data.jobId === s.job.id);
    assert.deepEqual(mine.map((m) => m.userId).sort(), [s.client.id, s.talent.id].sort());
  });

  it("a push that throws does not stop the others, and is not retried forever", async () => {
    const s = await awarded();
    await s.event("funded");
    await s.event("changes_requested");
    const sent = [];
    const flaky = { notifyUser: async (userId, m) => { sent.push(m.data.type); if (m.data.type === "funded") throw new Error("boom"); return { sent: 1, removed: 0, failed: 0 }; } };
    await dispatcher.dispatchPending({ prisma, push: flaky });
    assert.ok(sent.includes("funded") && sent.includes("changes_requested"));
    assert.equal(await prisma.contractEvent.count({ where: { jobId: s.job.id, pushedAt: null } }), 0);
  });

  it("is not started at all when push is not configured (nothing polls the database)", () => {
    const saved = process.env.FCM_SERVICE_ACCOUNT_JSON;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    try {
      assert.equal(dispatcher.startPushDispatcher(), null);
    } finally {
      if (saved !== undefined) process.env.FCM_SERVICE_ACCOUNT_JSON = saved;
    }
  });
});

describe("events and reminders that feed it", () => {
  it("confirming a payment writes a funded event, once", async () => {
    const ctx = await h.fixtures();
    const { c, job } = await h.seedAward(ctx, { budget: 1000, contract: { payByAt: h.future() } });
    const reference = `kd_${c.id}_abcdef12`;
    const kobo = (1000 + 100) * 100;
    assert.equal((await confirmFunding({ reference, amountKobo: kobo, source: "test" })).outcome, "funded");
    assert.equal((await confirmFunding({ reference, amountKobo: kobo, source: "test" })).outcome, "alreadyFunded");
    assert.equal(await prisma.contractEvent.count({ where: { jobId: job.id, type: "funded" } }), 1);
  });

  it("a deadline reminder also pushes to the person whose silence triggers it, once", async () => {
    const ctx = await h.fixtures();
    const s = await h.seedWorking(ctx, { deliverByAt: new Date(Date.now() + 20 * 3600 * 1000) });
    const sent = [];
    const p = { notifyUser: async (userId, m) => (sent.push({ userId, ...m }), { sent: 1, removed: 0, failed: 0 }) };
    const scoped = h.scopedPrisma();
    await sweepReminders({ prisma: scoped, mailer: h.spyMailer(), push: p, autoRelease: false });
    const mine = sent.filter((m) => m.data.jobId === s.job.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].userId, ctx.talentA.id, "the talent is the one who has to deliver");
    assert.equal(mine[0].data.type, "reminder_delivery");
    await sweepReminders({ prisma: scoped, mailer: h.spyMailer(), push: p, autoRelease: false });
    assert.equal(sent.filter((m) => m.data.jobId === s.job.id).length, 1, "not repeated on the next sweep");
  });
});
