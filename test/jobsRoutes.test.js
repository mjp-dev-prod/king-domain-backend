// The job routes over real HTTP: the real server against the test database.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;

let ctx, otherClient, fake, server, ct, c2, ta, tb, pieceA, pieceB;
before(async () => {
  ctx = await h.fixtures();
  otherClient = await h.ensureUser("testsuite-client-2@example.com", "client", "Suite Client Two");
  // Verified in Graphic design through a passed submission: the only way to apply.
  pieceA = (await h.verifyTalentInSkill(ctx.talentA)).pieceId;
  pieceB = (await h.verifyTalentInSkill(ctx.talentB)).pieceId;
  fake = await h.serveFakeProvider(h.fakeProvider());
  server = await h.startServer({ port: 4613, paystackUrl: fake.url, autoRelease: false });
  [ct, c2, ta, tb] = await Promise.all([h.tokenFor(ctx.client), h.tokenFor(otherClient), h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB)]);
});
after(async () => {
  server?.stop();
  fake?.server.close();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  // Leave the shared test talents as other suites expect them: not verified in anything.
  await prisma.skillSubmission.deleteMany({ where: { userId: { in: [ctx.talentA.id, ctx.talentB.id] }, skillKey: "graphic-design" } });
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);
const body = (over = {}) => ({ title: `${h.TITLE_PREFIX}http`, category: h.CATEGORY, description: "suite", budget: 1000, deliveryDays: 5, ...over });
// A job with a skill: applying needs a verified submission in it. (These suites test the apply rules, not the brief.)
const post = async (over = {}) => {
  const { skillKey = "graphic-design", ...rest } = over;
  const job = (await api(ct, "POST", "/jobs", body(rest))).json.job;
  await prisma.job.update({ where: { id: job.id }, data: { skillKey } });
  return job;
};
const apply = (tok, extra = {}) => h.applyBody(tok === ta ? pieceA : pieceB, extra);

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

describe("POST /jobs/:id/close and feed visibility", () => {
  const feedIds = async (tok) => (await api(tok, "GET", "/jobs")).json.jobs.map((j) => j.id);

  it("the owner closes it: closedAt is set, and the pending applicant sees it as not selected", async () => {
    const job = await post();
    await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentA.id } });
    const r = await api(ct, "POST", `/jobs/${job.id}/close`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.job.closedAt);
    const seen = (await api(ta, "GET", "/jobs")).json.jobs.find((j) => j.id === job.id);
    assert.equal(seen.myApplicationStatus, "notSelected");
    assert.ok(seen.closedAt);
  });

  it("a closed job leaves the feed for talents who never applied, and stays for its owner", async () => {
    const job = await post();
    assert.ok((await feedIds(tb)).includes(job.id));
    await api(ct, "POST", `/jobs/${job.id}/close`);
    assert.ok(!(await feedIds(tb)).includes(job.id));
    assert.ok((await feedIds(ct)).includes(job.id));
  });

  it("a talent gets 403, another client gets 403, closing twice and closing an awarded job get 409 with a code", async () => {
    const job = await post();
    assert.equal((await api(ta, "POST", `/jobs/${job.id}/close`)).status, 403);
    assert.equal((await api(c2, "POST", `/jobs/${job.id}/close`)).status, 403);
    assert.equal((await api(ct, "POST", `/jobs/${job.id}/close`)).status, 200);
    const again = await api(ct, "POST", `/jobs/${job.id}/close`);
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "closed");
    const awarded = await h.seedAward(ctx);
    assert.equal((await api(ct, "POST", `/jobs/${awarded.job.id}/close`)).json.code, "awarded");
  });
});

describe("POST /jobs/:id/apply", () => {
  it("applies (201), with or without the revision the talent read", async () => {
    const withRev = await post();
    const a = await api(ta, "POST", `/jobs/${withRev.id}/apply`, apply(ta, { revision: 0 }));
    assert.equal(a.status, 201, JSON.stringify(a.json));
    const without = await post();
    assert.equal((await api(tb, "POST", `/jobs/${without.id}/apply`, apply(tb))).status, 201);
  });

  it("a stale revision is 409 terms_changed; a non-integer revision is 400", async () => {
    const job = await post();
    await api(ct, "PATCH", `/jobs/${job.id}`, body({ description: "changed" }));
    const stale = await api(ta, "POST", `/jobs/${job.id}/apply`, apply(ta, { revision: 0 }));
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "terms_changed");
    assert.equal((await api(ta, "POST", `/jobs/${job.id}/apply`, apply(ta, { revision: "x" }))).status, 400);
    assert.equal((await api(ta, "POST", `/jobs/${job.id}/apply`, apply(ta, { revision: 1 }))).status, 201);
  });

  it("a closed job is 409 closed", async () => {
    const job = await post();
    await api(ct, "POST", `/jobs/${job.id}/close`);
    const r = await api(ta, "POST", `/jobs/${job.id}/apply`, apply(ta, { revision: 0 }));
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "closed");
  });

  it("applying twice is 409 already_applied; an unverified category is still 403", async () => {
    const job = await post();
    assert.equal((await api(ta, "POST", `/jobs/${job.id}/apply`, apply(ta))).status, 201);
    assert.equal((await api(ta, "POST", `/jobs/${job.id}/apply`, apply(ta))).json.code, "already_applied");
    const other = await post({ skillKey: "web-development" });
    const refused = await api(ta, "POST", `/jobs/${other.id}/apply`, apply(ta));
    assert.equal(refused.status, 403, "verified in Graphic design is not verified in Web development");
    assert.equal(refused.json.code, "not_verified_in_skill");
  });

  it("a job from before skills cannot take applications, and says why", async () => {
    const old = (await api(ct, "POST", "/jobs", body())).json.job;
    const r = await api(ta, "POST", `/jobs/${old.id}/apply`, apply(ta));
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "no_skill");
    assert.match(r.json.error, /before jobs asked for a skill/);
  });
});

describe("POST /jobs/:id/applications/:applicationId/award", () => {
  it("awards one applicant: selected, the rest not selected, a contract awaiting payment with the frozen fee and pay window", async () => {
    const job = await post({ budget: 2000 });
    const a = (await api(ta, "POST", `/jobs/${job.id}/apply`, apply(ta))).json.application;
    const b = (await api(tb, "POST", `/jobs/${job.id}/apply`, apply(tb))).json.application;
    const before = Date.now();
    const r = await api(ct, "POST", `/jobs/${job.id}/applications/${a.id}/award`);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.contract.status, "awaitingPayment");
    assert.equal(Number(r.json.contract.platformFeeAmount), 200);
    const payByMs = new Date(r.json.contract.payByAt).getTime() - before;
    assert.ok(Math.abs(payByMs - 24 * 3_600_000) < 60_000, `payBy window ${payByMs}`);
    const rows = await prisma.application.findMany({ where: { jobId: job.id } });
    assert.equal(rows.find((x) => x.id === a.id).status, "selected");
    assert.equal(rows.find((x) => x.id === b.id).status, "notSelected");
    assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).awardedApplicationId, a.id);
    assert.equal(await prisma.contractEvent.count({ where: { jobId: job.id, type: "awarded" } }), 1);
  });

  it("only the job's client; a second award and a missing application are refused", async () => {
    const job = await post();
    const a = (await api(ta, "POST", `/jobs/${job.id}/apply`, apply(ta))).json.application;
    assert.equal((await api(c2, "POST", `/jobs/${job.id}/applications/${a.id}/award`)).status, 403);
    assert.equal((await api(ct, "POST", `/jobs/${job.id}/applications/00000000-0000-0000-0000-000000000000/award`)).status, 404);
    assert.equal((await api(ct, "POST", `/jobs/${job.id}/applications/${a.id}/award`)).status, 201);
    assert.equal((await api(ct, "POST", `/jobs/${job.id}/applications/${a.id}/award`)).status, 400);
  });

  it("a closed job cannot be awarded (409 closed) and no contract is created", async () => {
    const job = await post();
    const a = (await api(ta, "POST", `/jobs/${job.id}/apply`, apply(ta))).json.application;
    await api(ct, "POST", `/jobs/${job.id}/close`);
    const r = await api(ct, "POST", `/jobs/${job.id}/applications/${a.id}/award`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "closed");
    assert.equal(await prisma.contract.count({ where: { jobId: job.id } }), 0);
  });
});
