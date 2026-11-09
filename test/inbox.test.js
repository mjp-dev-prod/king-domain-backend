const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const inbox = require("../src/admin/inbox");

let ctx, owner, reader;
before(async () => {
  ctx = await h.fixtures();
  owner = await h.ensureAdmin("testsuite-owner@example.com", { role: "owner" });
  reader = await h.ensureAdmin("testsuite-reader@example.com");
  await wipe();
});
after(async () => {
  await wipe();
  await prisma.$disconnect();
});

// The queue mechanics (targets, counts, handling times) are exercised on the first-check queue: it needs only
// submissions, and "reader" has no checker capability, so it must not see it.
const SKILL = "short-form-video";
async function wipe() {
  await prisma.skillSubmission.deleteMany({ where: { userId: ctx.talentA.id, skillKey: SKILL } });
  await prisma.queueTarget.deleteMany({ where: { queueKey: "authenticity" } });
}

describe("percentile", () => {
  it("uses nearest rank and is null for no data", () => {
    assert.equal(inbox.percentile([], 90), null);
    assert.equal(inbox.percentile([5], 50), 5);
    assert.equal(inbox.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
    assert.equal(inbox.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
    assert.equal(inbox.percentile([10, 1, 9, 2], 90), 10);
  });
});

describe("inboxFor", () => {
  it("shows a queue only to admins with its capability", async () => {
    assert.ok((await inbox.inboxFor(prisma, owner)).some((q) => q.key === "authenticity"));
    assert.equal((await inbox.inboxFor(prisma, reader)).some((q) => q.key === "authenticity"), false);
    assert.equal((await inbox.inboxFor(prisma, owner)).some((q) => q.key === "proof"), false, "the old proof queue is gone");
  });

  it("counts open and overdue items against the target, and the oldest wait", async () => {
    const now = new Date("2026-11-10T12:00:00Z");
    await prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey: SKILL, status: "authenticity", submittedAt: new Date("2026-11-05T12:00:00Z") } });
    await prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey: SKILL, status: "authenticity", submittedAt: new Date("2026-11-10T11:00:00Z") } });
    const proof = (await inbox.inboxFor(prisma, owner, now)).find((q) => q.key === "authenticity");
    assert.equal(proof.targetMinutes, 24 * 60, "default target with no stored row");
    assert.ok(proof.open >= 2);
    assert.ok(proof.overdue >= 1, "the five-day-old item is past 24 hours");
    assert.ok(proof.oldestWaitingMinutes >= 5 * 24 * 60);
  });

  it("a stored target replaces the default", async () => {
    await prisma.queueTarget.upsert({
      where: { queueKey: "authenticity" },
      update: { targetMinutes: 30, defaultWhenLate: "Escalate" },
      create: { queueKey: "authenticity", targetMinutes: 30, defaultWhenLate: "Escalate" },
    });
    const proof = (await inbox.inboxFor(prisma, owner)).find((q) => q.key === "authenticity");
    assert.equal(proof.targetMinutes, 30);
    assert.equal(proof.defaultWhenLate, "Escalate");
  });

  it("reports median and 90th percentile handling time from resolved items", async () => {
    await prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey: SKILL, status: "review", submittedAt: new Date("2026-11-01T00:00:00Z"), authenticityAt: new Date("2026-11-01T06:00:00Z") } });
    const proof = (await inbox.inboxFor(prisma, owner)).find((q) => q.key === "authenticity");
    assert.ok(proof.sample >= 1);
    assert.ok(proof.p50Minutes !== null && proof.p90Minutes >= proof.p50Minutes);
  });
});
