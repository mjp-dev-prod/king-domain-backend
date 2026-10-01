// Stage 2 over real HTTP: the real server against the test database.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;

let ctx, fake, server, ct, tt, tb;
before(async () => {
  ctx = await h.fixtures();
  fake = await h.serveFakeProvider(h.fakeProvider());
  server = await h.startServer({ port: 4612, paystackUrl: fake.url, autoRelease: false });
  [ct, tt, tb] = await Promise.all([h.tokenFor(ctx.client), h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB)]);
});
after(async () => {
  server?.stop();
  fake?.server.close();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});

const post = (tok, p, body) => h.call(server.base, tok, "POST", p, body);
const jobBody = (deliveryDays) => ({ title: `${h.TITLE_PREFIX}routes`, category: h.CATEGORY, description: "suite", budget: 1000, deliveryDays });

describe("POST /jobs delivery days", () => {
  it("is required, a whole number from 1 to 60", async () => {
    for (const bad of [undefined, 0, 61, 2.5, "x"]) {
      const r = await post(ct, "/jobs", jobBody(bad));
      assert.equal(r.status, 400, `deliveryDays=${bad}`);
    }
    const ok = await post(ct, "/jobs", jobBody(7));
    assert.equal(ok.status, 201);
    assert.equal(ok.json.job.deliveryDays, 7);
  });
});

describe("contract history", () => {
  it("client and awarded talent can read it; anyone else gets 403", async () => {
    const s = await h.seedSubmitted(ctx);
    const path = `/jobs/${s.job.id}/contract/history`;
    const asClient = await h.call(server.base, ct, "GET", path);
    assert.equal(asClient.status, 200);
    assert.deepEqual(asClient.json.deliveries.map((d) => d.version), [1]);
    assert.equal((await h.call(server.base, tt, "GET", path)).status, 200);
    assert.equal((await h.call(server.base, tb, "GET", path)).status, 403);
  });

  it("a talent can resubmit over HTTP from changesRequested", async () => {
    const s = await h.seedSubmitted(ctx, { changeRounds: 1, contract: { status: "changesRequested", reviewDueAt: null, changeDueAt: h.future() } });
    const r = await post(tt, `/jobs/${s.job.id}/contract/submit`, { deliverableNote: "v2" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.contract.status, "submitted");
  });
});

describe("extension routes", () => {
  it("talent asks (201), other talent can't (403), client can't ask (403); client answers (200), talent can't answer (403)", async () => {
    const s = await h.seedWorking(ctx, { deliveryDays: 5 });
    const ask = (tok) => post(tok, `/jobs/${s.job.id}/contract/extension`, { days: 2, reason: "Waiting on the client's assets." });
    assert.equal((await ask(tb)).status, 403);
    assert.equal((await ask(ct)).status, 403);
    const asked = await ask(tt);
    assert.equal(asked.status, 201, JSON.stringify(asked.json));
    const answer = (tok, decision) => post(tok, `/jobs/${s.job.id}/contract/extension/${asked.json.extension.id}/answer`, { decision });
    assert.equal((await answer(tt, "grant")).status, 403);
    assert.equal((await answer(ct, "maybe")).status, 400);
    const granted = await answer(ct, "grant");
    assert.equal(granted.status, 200, JSON.stringify(granted.json));
    assert.ok(granted.json.contract.deliverByAt);
  });
});
