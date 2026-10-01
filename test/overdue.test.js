// Delivery date + 3 days, nothing delivered, no extension pending: flagged
// once and the client is told. No cancel and no refund in stage 2.
const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const ext = require("../src/contractExtensions");
const life = require("../src/contractLifecycle");

let ctx;
before(async () => {
  ctx = await h.fixtures();
});
// Sweeps see every due contract; each test starts from a clean slate.
beforeEach(async () => {
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
});
after(async () => {
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});
const sweep = (mailer = h.spyMailer()) => ext.sweepOverdue({ prisma: h.scopedPrisma(), mailer });
const flagOf = async (s) => (await prisma.contract.findUnique({ where: { id: s.c.id } })).overdueFlaggedAt;

describe("overdue", () => {
  it("3 days past the date with nothing delivered: flagged once, client emailed, event recorded", async () => {
    const s = await h.seedWorking(ctx, { deliverByAt: h.past(3 * h.DAY_MS + 60_000) });
    const mailer = h.spyMailer();
    assert.deepEqual(await sweep(mailer), { flagged: 1 });
    assert.ok(await flagOf(s));
    assert.deepEqual(mailer.sent.map((m) => [m.k, m.to]), [["sendDeliveryOverdueToClient", ctx.client.email]]);
    assert.ok(await prisma.contractEvent.findFirst({ where: { contractId: s.c.id, type: "overdue" } }));
    assert.deepEqual(await sweep(), { flagged: 0 }, "only once");
  });

  it("less than 3 days past: not flagged", async () => {
    const s = await h.seedWorking(ctx, { deliverByAt: h.past(2 * h.DAY_MS) });
    await sweep();
    assert.equal(await flagOf(s), null);
  });

  it("a pending extension request pauses it", async () => {
    const s = await h.seedWorking(ctx, { deliverByAt: h.past(3 * h.DAY_MS + 60_000) });
    await prisma.contractExtension.create({ data: { contractId: s.c.id, requestedDays: 2, reason: "Waiting on assets.", answerDueAt: h.future() } });
    await sweep();
    assert.equal(await flagOf(s), null);
  });

  it("delivered work and legacy jobs are never flagged", async () => {
    const delivered = await h.seedSubmitted(ctx, { contract: { deliverByAt: h.past(10 * h.DAY_MS) } });
    const legacy = await h.seedAward(ctx, { contract: { status: "inProgress", payByAt: null } });
    await sweep();
    assert.equal(await flagOf(delivered), null);
    assert.equal(await flagOf(legacy), null);
  });

  it("the tick runs it", async () => {
    const s = await h.seedWorking(ctx, { deliverByAt: h.past(3 * h.DAY_MS + 60_000) });
    await life.runTick({ prisma: h.scopedPrisma(), mailer: h.spyMailer(), paystack: h.fakeProvider(), autoRelease: false });
    assert.ok(await flagOf(s));
  });
});
