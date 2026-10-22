// The job routes over real HTTP: the real server against the test database.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;

let ctx, otherClient, fake, server, ct, c2, ta, tb;
before(async () => {
  ctx = await h.fixtures();
  otherClient = await h.ensureUser("testsuite-client-2@example.com", "client", "Suite Client Two");
  for (const t of [ctx.talentA, ctx.talentB]) {
    const profile = await prisma.talentProfile.findUnique({ where: { userId: t.id } });
    await prisma.proofItem.deleteMany({ where: { talentProfileId: profile.id } });
    await prisma.proofItem.create({ data: { talentProfileId: profile.id, category: h.CATEGORY, title: "Verified work", status: "verified" } });
  }
  fake = await h.serveFakeProvider(h.fakeProvider());
  server = await h.startServer({ port: 4613, paystackUrl: fake.url, autoRelease: false });
  [ct, c2, ta, tb] = await Promise.all([h.tokenFor(ctx.client), h.tokenFor(otherClient), h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB)]);
});
after(async () => {
  server?.stop();
  fake?.server.close();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  // Leave the shared test talents as other suites expect them: no verified proof.
  const profiles = await prisma.talentProfile.findMany({ where: { userId: { in: [ctx.talentA.id, ctx.talentB.id] } } });
  await prisma.proofItem.deleteMany({ where: { talentProfileId: { in: profiles.map((p) => p.id) } } });
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);
const body = (over = {}) => ({ title: `${h.TITLE_PREFIX}http`, category: h.CATEGORY, description: "suite", budget: 1000, deliveryDays: 5, ...over });
const post = async (over) => (await api(ct, "POST", "/jobs", body(over))).json.job;

describe("POST /jobs", () => {
  it("returns closedAt null and revision 0 on a new job", async () => {
    const r = await api(ct, "POST", "/jobs", body());
    assert.equal(r.status, 201);
    assert.equal(r.json.job.closedAt, null);
    assert.equal(r.json.job.revision, 0);
  });

  it("keeps refusing bad input with the same messages", async () => {
    const r = await api(ct, "POST", "/jobs", body({ deliveryDays: 0 }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /deliveryDays must be a whole number of days from 1 to 60/);
  });
});

describe("PATCH /jobs/:id", () => {
  it("the owner edits an open job with no applicants", async () => {
    const job = await post();
    const r = await api(ct, "PATCH", `/jobs/${job.id}`, body({ title: `${h.TITLE_PREFIX}renamed`, budget: 4000 }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.job.title, `${h.TITLE_PREFIX}renamed`);
    assert.equal(Number(r.json.job.budget), 4000);
    assert.equal(r.json.job.revision, 1);
  });

  it("a talent gets 403, another client gets 403, a missing job gets 404, bad input gets 400", async () => {
    const job = await post();
    assert.equal((await api(ta, "PATCH", `/jobs/${job.id}`, body())).status, 403);
    assert.equal((await api(c2, "PATCH", `/jobs/${job.id}`, body())).status, 403);
    assert.equal((await api(ct, "PATCH", "/jobs/00000000-0000-0000-0000-000000000000", body())).status, 404);
    assert.equal((await api(ct, "PATCH", `/jobs/${job.id}`, body({ budget: 0 }))).status, 400);
  });

  it("is refused with 409 and a code once someone applied, once awarded, and once closed", async () => {
    const applied = await post();
    await prisma.application.create({ data: { jobId: applied.id, talentId: ctx.talentA.id } });
    const a = await api(ct, "PATCH", `/jobs/${applied.id}`, body());
    assert.equal(a.status, 409);
    assert.equal(a.json.code, "has_applicants");

    const awarded = await h.seedAward(ctx);
    assert.equal((await api(ct, "PATCH", `/jobs/${awarded.job.id}`, body())).json.code, "awarded");

    const closed = await post();
    await prisma.job.update({ where: { id: closed.id }, data: { closedAt: new Date() } });
    assert.equal((await api(ct, "PATCH", `/jobs/${closed.id}`, body())).json.code, "closed");
  });
});
