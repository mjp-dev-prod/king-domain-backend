// Editing, closing, applying to and awarding a job before it has a contract.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const h = require("./helpers");
const { prisma } = h;
const jobs = require("../src/jobs");

let ctx, otherClient;
before(async () => {
  ctx = await h.fixtures();
  otherClient = await h.ensureUser("testsuite-client-2@example.com", "client", "Suite Client Two");
});
after(async () => {
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});

const openJob = (data = {}) =>
  prisma.job.create({
    data: { clientId: ctx.client.id, title: `${h.TITLE_PREFIX}${crypto.randomBytes(3).toString("hex")}`, category: h.CATEGORY, description: "suite", budget: 1000, deliveryDays: 5, ...data },
  });
const input = (over = {}) => ({ title: `${h.TITLE_PREFIX}edited`, category: h.CATEGORY, description: "a new description", budget: 2500, deliveryDays: 9, ...over });
const edit = (job, over, clientId = ctx.client.id, deps) => jobs.editJob({ jobId: job.id, clientId, input: input(over) }, deps);

describe("validateJobInput", () => {
  it("accepts a good job and trims the text", () => {
    const r = jobs.validateJobInput({ title: "  Logo  ", category: " Design ", description: " Make one ", budget: "1500", deliveryDays: "7" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { title: "Logo", category: "Design", description: "Make one", budget: 1500, deliveryDays: 7 });
  });

  it("refuses each bad field with its own message", () => {
    const good = { title: "t", category: "c", description: "d", budget: 10, deliveryDays: 5 };
    const cases = [
      [{ title: "  " }, "title is required."],
      [{ category: undefined }, "category is required."],
      [{ description: "" }, "description is required."],
      [{ budget: 0 }, "budget must be a positive number."],
      [{ budget: "x" }, "budget must be a positive number."],
      [{ deliveryDays: 0 }, "deliveryDays must be a whole number of days from 1 to 60."],
      [{ deliveryDays: 61 }, "deliveryDays must be a whole number of days from 1 to 60."],
      [{ deliveryDays: 2.5 }, "deliveryDays must be a whole number of days from 1 to 60."],
    ];
    for (const [over, message] of cases) {
      const r = jobs.validateJobInput({ ...good, ...over });
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.equal(r.status, 400);
      assert.equal(r.code, "invalid");
      assert.equal(r.error, message);
    }
  });
});

describe("editJob", () => {
  it("changes every field, bumps the revision, and leaves the job open", async () => {
    const job = await openJob();
    const r = await edit(job);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.job.title, `${h.TITLE_PREFIX}edited`);
    assert.equal(r.job.description, "a new description");
    assert.equal(Number(r.job.budget), 2500);
    assert.equal(r.job.deliveryDays, 9);
    assert.equal(r.job.revision, 1);
    assert.equal(r.job.closedAt, null);
    assert.equal((await edit(job)).job.revision, 2);
  });

  it("is refused for another client's job (403) and a missing job (404)", async () => {
    const job = await openJob();
    assert.equal((await edit(job, {}, otherClient.id)).status, 403);
    assert.equal((await jobs.editJob({ jobId: "00000000-0000-0000-0000-000000000000", clientId: ctx.client.id, input: input() })).status, 404);
    assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).revision, 0);
  });

  it("is refused for invalid input and changes nothing", async () => {
    const job = await openJob();
    const r = await edit(job, { budget: -5 });
    assert.equal(r.code, "invalid");
    assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).revision, 0);
  });

  it("is refused once someone has applied (has_applicants) and the terms stay as they were", async () => {
    const job = await openJob({ title: `${h.TITLE_PREFIX}locked` });
    await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentA.id } });
    const r = await edit(job);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.code, "has_applicants");
    assert.match(r.error, /Someone has already applied/);
    const after = await prisma.job.findUnique({ where: { id: job.id } });
    assert.equal(after.title, `${h.TITLE_PREFIX}locked`);
    assert.equal(after.revision, 0);
  });

  it("is refused when the applicant pre-dates lastAppliedAt (applications exist, the column is null)", async () => {
    const job = await openJob();
    await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentA.id } });
    assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).lastAppliedAt, null);
    assert.equal((await edit(job)).code, "has_applicants");
  });

  it("is refused once awarded (awarded) or closed (closed)", async () => {
    const awarded = await h.seedAward(ctx);
    assert.equal((await edit(awarded.job)).code, "awarded");
    const closed = await openJob({ closedAt: new Date() });
    assert.equal((await edit(closed)).code, "closed");
  });
});

describe("closeJob", () => {
  const close = (job, clientId = ctx.client.id, deps) => jobs.closeJob({ jobId: job.id, clientId }, deps);

  it("closes the job and marks every pending application not selected", async () => {
    const job = await openJob();
    await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentA.id } });
    await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentB.id } });
    const r = await close(job);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.job.closedAt);
    const statuses = (await prisma.application.findMany({ where: { jobId: job.id } })).map((a) => a.status);
    assert.deepEqual(statuses, ["notSelected", "notSelected"]);
  });

  it("closes a job nobody applied to", async () => {
    assert.equal((await close(await openJob())).ok, true);
  });

  it("is refused for another client (403), a missing job (404), a closed job and an awarded job (409)", async () => {
    const job = await openJob();
    assert.equal((await close(job, otherClient.id)).status, 403);
    assert.equal((await jobs.closeJob({ jobId: "00000000-0000-0000-0000-000000000000", clientId: ctx.client.id })).status, 404);
    assert.equal((await close(job)).ok, true);
    assert.equal((await close(job)).code, "closed");
    const awarded = await h.seedAward(ctx);
    const r = await close(awarded.job);
    assert.equal(r.code, "awarded");
    assert.equal((await prisma.job.findUnique({ where: { id: awarded.job.id } })).closedAt, null);
  });
});

describe("applyToJob", () => {
  const apply = (job, talent = ctx.talentA, revision, deps) => jobs.applyToJob({ jobId: job.id, talentId: talent.id, revision }, deps);

  it("creates the application and stamps lastAppliedAt", async () => {
    const job = await openJob();
    const r = await apply(job, ctx.talentA, 0);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.application.status, "pending");
    assert.ok((await prisma.job.findUnique({ where: { id: job.id } })).lastAppliedAt);
  });

  it("accepts an application without a revision (older app builds)", async () => {
    assert.equal((await apply(await openJob())).ok, true);
  });

  it("refuses an application made on older terms (terms_changed) and creates nothing", async () => {
    const job = await openJob();
    await edit(job); // revision is now 1
    const r = await apply(job, ctx.talentA, 0);
    assert.equal(r.status, 409);
    assert.equal(r.code, "terms_changed");
    assert.equal(await prisma.application.count({ where: { jobId: job.id } }), 0);
    assert.equal((await apply(job, ctx.talentA, 1)).ok, true);
  });

  it("refuses a closed job (409 closed) and an awarded job (400 awarded)", async () => {
    const closed = await openJob({ closedAt: new Date() });
    const c = await apply(closed);
    assert.equal(c.status, 409);
    assert.equal(c.code, "closed");
    const awarded = await h.seedAward(ctx);
    const a = await apply(awarded.job, ctx.talentA);
    assert.equal(a.status, 400);
    assert.equal(a.code, "awarded");
  });

  it("a second application by the same talent is already_applied and leaves one row", async () => {
    const job = await openJob();
    assert.equal((await apply(job)).ok, true);
    const r = await apply(job);
    assert.equal(r.status, 409);
    assert.equal(r.code, "already_applied");
    assert.equal(await prisma.application.count({ where: { jobId: job.id } }), 1);
  });

  it("a missing job is 404", async () => {
    assert.equal((await jobs.applyToJob({ jobId: "00000000-0000-0000-0000-000000000000", talentId: ctx.talentA.id })).status, 404);
  });
});

describe("awardJob", () => {
  it("refuses a closed job, creates no contract, and leaves the application as it was", async () => {
    const job = await openJob();
    const app = await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentA.id } });
    await jobs.closeJob({ jobId: job.id, clientId: ctx.client.id });
    const r = await jobs.awardJob({ jobId: job.id, clientId: ctx.client.id, applicationId: app.id });
    assert.equal(r.code, "closed");
    assert.equal(await prisma.contract.count({ where: { jobId: job.id } }), 0);
    assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).awardedApplicationId, null);
  });
});
