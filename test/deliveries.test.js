// Every delivery is an immutable version; resubmission makes a new one.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const changes = require("../src/contractChanges");

let ctx;
before(async () => {
  ctx = await h.fixtures();
});
after(async () => {
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});

describe("delivery versions", () => {
  it("first delivery: version 1, submitted, 3-day review clock, contract mirrors it", async () => {
    const s = await h.seedWorking(ctx);
    const at = new Date();
    const r = await changes.submitDelivery({ contractId: s.c.id, note: "first cut", url: "https://example.com/a" }, { now: () => at });
    assert.equal(r.ok, true);
    assert.equal(r.version, 1);
    const c = await prisma.contract.findUnique({ where: { id: s.c.id } });
    assert.equal(c.status, "submitted");
    assert.equal(c.reviewDueAt.getTime(), at.getTime() + 3 * h.DAY_MS);
    assert.equal(c.deliverableNote, "first cut");
    const v = await prisma.contractDelivery.findMany({ where: { contractId: s.c.id } });
    assert.deepEqual(v.map((d) => [d.version, d.note, d.url]), [[1, "first cut", "https://example.com/a"]]);
  });

  it("an empty delivery is refused", async () => {
    const s = await h.seedWorking(ctx);
    const r = await changes.submitDelivery({ contractId: s.c.id, note: "   " });
    assert.equal(r.ok, false);
    assert.equal(r.code, "empty_delivery");
  });

  it("can't deliver before starting or after delivering", async () => {
    for (const status of ["funded", "submitted", "approved", "disputed"]) {
      const s = await h.seedWorking(ctx, { status });
      const r = await changes.submitDelivery({ contractId: s.c.id, note: "x" });
      assert.equal(r.code, "not_deliverable", status);
    }
  });

  it("two simultaneous deliveries: exactly one version is recorded", async () => {
    const s = await h.seedWorking(ctx);
    const racing = { prisma: h.barrierPrisma("contract", "findUnique") };
    const results = await Promise.all([
      changes.submitDelivery({ contractId: s.c.id, note: "a" }, racing),
      changes.submitDelivery({ contractId: s.c.id, note: "b" }, racing),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(await prisma.contractDelivery.count({ where: { contractId: s.c.id } }), 1);
  });

  it("resubmission after a change request: version 2, version 1 untouched, round marked resubmitted, review clock restarts", async () => {
    const s = await h.seedSubmitted(ctx, { changeRounds: 1, contract: { status: "changesRequested", reviewDueAt: null, changeDueAt: h.future() } });
    await prisma.changeRequest.create({ data: { contractId: s.c.id, round: 1, reason: "Please fix the colours", resubmitDueAt: h.future() } });
    const at = new Date();
    const r = await changes.submitDelivery({ contractId: s.c.id, note: "v2" }, { now: () => at });
    assert.equal(r.ok, true);
    assert.equal(r.version, 2);
    assert.equal(r.resubmission, true);
    const versions = await prisma.contractDelivery.findMany({ where: { contractId: s.c.id }, orderBy: { version: "asc" } });
    assert.deepEqual(versions.map((d) => d.note), ["v1", "v2"]);
    const c = await prisma.contract.findUnique({ where: { id: s.c.id } });
    assert.equal(c.status, "submitted");
    assert.equal(c.changeDueAt, null);
    assert.equal(c.reviewDueAt.getTime(), at.getTime() + 3 * h.DAY_MS);
    const round = await prisma.changeRequest.findFirst({ where: { contractId: s.c.id, round: 1 } });
    assert.equal(round.resubmittedAt.getTime(), at.getTime());
  });
});
