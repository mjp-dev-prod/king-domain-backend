const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const inbox = require("../src/admin/inbox");

let ctx, profile, owner, reader;
before(async () => {
  ctx = await h.fixtures();
  profile = await prisma.talentProfile.findUnique({ where: { userId: ctx.talentA.id } });
  owner = await h.ensureAdmin("testsuite-owner@example.com", { role: "owner" });
  reader = await h.ensureAdmin("testsuite-reader@example.com");
  await prisma.proofItem.deleteMany({ where: { talentProfileId: profile.id } });
  await prisma.queueTarget.deleteMany({ where: { queueKey: "proof" } });
});
after(async () => {
  await prisma.proofItem.deleteMany({ where: { talentProfileId: profile.id } });
  await prisma.queueTarget.deleteMany({ where: { queueKey: "proof" } });
  await prisma.$disconnect();
});

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
    assert.ok((await inbox.inboxFor(prisma, owner)).some((q) => q.key === "proof"));
    assert.equal((await inbox.inboxFor(prisma, reader)).some((q) => q.key === "proof"), false);
  });

  it("counts open and overdue items against the target, and the oldest wait", async () => {
    const now = new Date("2026-11-10T12:00:00Z");
    await prisma.proofItem.create({ data: { talentProfileId: profile.id, category: h.CATEGORY, title: `${h.TITLE_PREFIX}old`, createdAt: new Date("2026-11-05T12:00:00Z") } });
    await prisma.proofItem.create({ data: { talentProfileId: profile.id, category: h.CATEGORY, title: `${h.TITLE_PREFIX}new`, createdAt: new Date("2026-11-10T11:00:00Z") } });
    const proof = (await inbox.inboxFor(prisma, owner, now)).find((q) => q.key === "proof");
    assert.equal(proof.targetMinutes, 72 * 60, "default target with no stored row");
    assert.ok(proof.open >= 2);
    assert.ok(proof.overdue >= 1, "the five-day-old item is past 72 hours");
    assert.ok(proof.oldestWaitingMinutes >= 5 * 24 * 60);
  });

  it("a stored target replaces the default", async () => {
    await prisma.queueTarget.upsert({
      where: { queueKey: "proof" },
      update: { targetMinutes: 30, defaultWhenLate: "Escalate" },
      create: { queueKey: "proof", targetMinutes: 30, defaultWhenLate: "Escalate" },
    });
    const proof = (await inbox.inboxFor(prisma, owner)).find((q) => q.key === "proof");
    assert.equal(proof.targetMinutes, 30);
    assert.equal(proof.defaultWhenLate, "Escalate");
  });

  it("reports median and 90th percentile handling time from resolved items", async () => {
    await prisma.proofItem.create({ data: { talentProfileId: profile.id, category: h.CATEGORY, title: `${h.TITLE_PREFIX}done`, status: "verified", createdAt: new Date("2026-11-01T00:00:00Z"), reviewedAt: new Date("2026-11-01T02:00:00Z") } });
    const proof = (await inbox.inboxFor(prisma, owner)).find((q) => q.key === "proof");
    assert.ok(proof.sample >= 1);
    assert.ok(proof.p50Minutes !== null && proof.p90Minutes >= proof.p50Minutes);
  });
});
