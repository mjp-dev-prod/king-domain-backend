// Extensions: up to 2 requests (a declined one counts), one open at a time,
// up to the job's original duration, 48 h to answer, silence = granted.
const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const ext = require("../src/contractExtensions");
const changes = require("../src/contractChanges");
const life = require("../src/contractLifecycle");

const REASON = "The client changed the brief on day 2.";
let ctx;
before(async () => {
  ctx = await h.fixtures();
});
after(async () => {
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});
const contractOf = (s) => prisma.contract.findUnique({ where: { id: s.c.id } });

describe("requesting an extension", () => {
  it("valid request: pending, counted, 48 h to answer, client emailed", async () => {
    const s = await h.seedWorking(ctx, { deliveryDays: 5 });
    const mailer = h.spyMailer();
    const at = new Date();
    const r = await ext.requestExtension({ contractId: s.c.id, days: 3, reason: REASON }, { mailer, now: () => at });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.extension.status, "pending");
    assert.equal(r.extension.answerDueAt.getTime(), at.getTime() + 48 * 3_600_000);
    assert.equal((await contractOf(s)).extensionsUsed, 1);
    assert.deepEqual(mailer.sent.map((m) => [m.k, m.to]), [["sendExtensionRequested", ctx.client.email]]);
  });

  it("days must be 1 to the job's original duration; a reason is required", async () => {
    const s = await h.seedWorking(ctx, { deliveryDays: 5 });
    for (const days of [0, 6, 2.5, NaN]) {
      assert.equal((await ext.requestExtension({ contractId: s.c.id, days, reason: REASON }, { mailer: h.spyMailer() })).code, "bad_days", String(days));
    }
    assert.equal((await ext.requestExtension({ contractId: s.c.id, days: 2, reason: "short" }, { mailer: h.spyMailer() })).code, "bad_reason");
    assert.equal((await contractOf(s)).extensionsUsed, 0, "refused requests don't count");
  });

  it("only one open at a time", async () => {
    const s = await h.seedWorking(ctx);
    await ext.requestExtension({ contractId: s.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() });
    assert.equal((await ext.requestExtension({ contractId: s.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() })).code, "already_pending");
  });

  it("two requests at the same instant: exactly one is created", async () => {
    const s = await h.seedWorking(ctx);
    const racing = { prisma: h.barrierPrisma("contractExtension", "findFirst"), mailer: h.spyMailer() };
    const rs = await Promise.all([1, 2].map((days) => ext.requestExtension({ contractId: s.c.id, days, reason: REASON }, racing)));
    assert.equal(rs.filter((r) => r.ok).length, 1);
    assert.equal(await prisma.contractExtension.count({ where: { contractId: s.c.id } }), 1);
    assert.equal((await contractOf(s)).extensionsUsed, 1);
  });

  it("a declined request counts: after 2 requests there are none left", async () => {
    const s = await h.seedWorking(ctx);
    for (let i = 0; i < 2; i++) {
      const r = await ext.requestExtension({ contractId: s.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() });
      await ext.answerExtension({ contractId: s.c.id, extensionId: r.extension.id, clientId: ctx.client.id, grant: false }, { mailer: h.spyMailer() });
    }
    assert.equal((await ext.requestExtension({ contractId: s.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() })).code, "no_requests_left");
  });

  it("refused after delivery, on a legacy job, and 3+ days past the date", async () => {
    const delivered = await h.seedSubmitted(ctx);
    assert.equal((await ext.requestExtension({ contractId: delivered.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() })).code, "not_open");
    const legacy = await h.seedAward(ctx, { contract: { status: "inProgress", payByAt: null } });
    assert.equal((await ext.requestExtension({ contractId: legacy.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() })).code, "no_delivery_date");
    const late = await h.seedWorking(ctx, { deliverByAt: h.past(3 * h.DAY_MS + 60_000) });
    assert.equal((await ext.requestExtension({ contractId: late.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() })).code, "too_late");
  });
});

describe("answering", () => {
  const open = async (days = 3) => {
    const s = await h.seedWorking(ctx, { deliveryDays: 5 });
    const r = await ext.requestExtension({ contractId: s.c.id, days, reason: REASON }, { mailer: h.spyMailer() });
    return { s, e: r.extension, before: (await contractOf(s)).deliverByAt };
  };

  it("grant: the days are added to the delivery date and the talent is told", async () => {
    const { s, e, before } = await open(3);
    const mailer = h.spyMailer();
    const r = await ext.answerExtension({ contractId: s.c.id, extensionId: e.id, clientId: ctx.client.id, grant: true }, { mailer });
    assert.equal(r.ok, true);
    assert.equal((await contractOf(s)).deliverByAt.getTime(), before.getTime() + 3 * h.DAY_MS);
    assert.deepEqual(mailer.sent.map((m) => [m.k, m.args.outcome]), [["sendExtensionAnswered", "granted"]]);
  });

  it("decline: the date stays", async () => {
    const { s, e, before } = await open();
    await ext.answerExtension({ contractId: s.c.id, extensionId: e.id, clientId: ctx.client.id, grant: false }, { mailer: h.spyMailer() });
    assert.equal((await contractOf(s)).deliverByAt.getTime(), before.getTime());
  });

  it("answering twice: the second is refused", async () => {
    const { s, e } = await open();
    await ext.answerExtension({ contractId: s.c.id, extensionId: e.id, clientId: ctx.client.id, grant: false }, { mailer: h.spyMailer() });
    const again = await ext.answerExtension({ contractId: s.c.id, extensionId: e.id, clientId: ctx.client.id, grant: true }, { mailer: h.spyMailer() });
    assert.equal(again.code, "already_answered");
  });

  it("an extension id from another contract is not found", async () => {
    const a = await open();
    const b = await h.seedWorking(ctx);
    assert.equal((await ext.answerExtension({ contractId: b.c.id, extensionId: a.e.id, clientId: ctx.client.id, grant: true })).code, "not_found");
  });

  it("a grant that moves the date clears the overdue flag", async () => {
    const s = await h.seedWorking(ctx, { deliveryDays: 5, deliverByAt: h.past(2 * h.DAY_MS), contract: { overdueFlaggedAt: new Date() } });
    const r = await ext.requestExtension({ contractId: s.c.id, days: 5, reason: REASON }, { mailer: h.spyMailer() });
    assert.equal(r.code, "too_late", "flagged contracts can't ask");
    // A request made before the flag, then flagged anyway (the race the pending-pause prevents):
    await prisma.contract.update({ where: { id: s.c.id }, data: { overdueFlaggedAt: null } });
    const ok = await ext.requestExtension({ contractId: s.c.id, days: 5, reason: REASON }, { mailer: h.spyMailer() });
    await prisma.contract.update({ where: { id: s.c.id }, data: { overdueFlaggedAt: new Date() } });
    await ext.answerExtension({ contractId: s.c.id, extensionId: ok.extension.id, clientId: ctx.client.id, grant: true }, { mailer: h.spyMailer() });
    assert.equal((await contractOf(s)).overdueFlaggedAt, null);
  });

  it("delivering withdraws an open request", async () => {
    const { s, e } = await open();
    await changes.submitDelivery({ contractId: s.c.id, note: "done early" });
    assert.equal((await prisma.contractExtension.findUnique({ where: { id: e.id } })).status, "withdrawn");
  });
});

describe("48-hour auto-grant", () => {
  // Sweeps see every due request; earlier tests' leftovers would be swept too.
  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  });

  it("unanswered after 48 h: granted, date moved, both told; a second sweep does nothing", async () => {
    const s = await h.seedWorking(ctx, { deliveryDays: 5 });
    const r = await ext.requestExtension({ contractId: s.c.id, days: 2, reason: REASON }, { mailer: h.spyMailer() });
    const before = (await contractOf(s)).deliverByAt;
    const later = () => new Date(r.extension.answerDueAt.getTime() + 60_000);
    const mailer = h.spyMailer();
    const deps = { prisma: h.scopedPrisma(), mailer, now: later };
    assert.deepEqual(await ext.sweepExtensions(deps), { autoGranted: 1 });
    assert.equal((await prisma.contractExtension.findUnique({ where: { id: r.extension.id } })).status, "autoGranted");
    assert.equal((await contractOf(s)).deliverByAt.getTime(), before.getTime() + 2 * h.DAY_MS);
    assert.deepEqual(mailer.sent.map((m) => m.k).sort(), ["sendExtensionAnswered", "sendExtensionAutoGrantedToClient"]);
    assert.deepEqual(await ext.sweepExtensions(deps), { autoGranted: 0 });
  });

  it("not yet 48 h: untouched", async () => {
    const s = await h.seedWorking(ctx);
    const r = await ext.requestExtension({ contractId: s.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() });
    await ext.sweepExtensions({ prisma: h.scopedPrisma(), mailer: h.spyMailer() });
    assert.equal((await prisma.contractExtension.findUnique({ where: { id: r.extension.id } })).status, "pending");
  });

  it("the client answers after 48 h but before the tick: their answer stands", async () => {
    const s = await h.seedWorking(ctx);
    const r = await ext.requestExtension({ contractId: s.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() });
    const later = () => new Date(r.extension.answerDueAt.getTime() + 60_000);
    await ext.answerExtension({ contractId: s.c.id, extensionId: r.extension.id, clientId: ctx.client.id, grant: false }, { mailer: h.spyMailer(), now: later });
    await ext.sweepExtensions({ prisma: h.scopedPrisma(), mailer: h.spyMailer(), now: later });
    assert.equal((await prisma.contractExtension.findUnique({ where: { id: r.extension.id } })).status, "declined");
  });

  it("the 5-minute tick runs the auto-grant", async () => {
    const s = await h.seedWorking(ctx);
    const r = await ext.requestExtension({ contractId: s.c.id, days: 1, reason: REASON }, { mailer: h.spyMailer() });
    await life.runTick({
      prisma: h.scopedPrisma(),
      mailer: h.spyMailer(),
      paystack: h.fakeProvider(),
      autoRelease: false,
      now: () => new Date(r.extension.answerDueAt.getTime() + 1),
    });
    assert.equal((await prisma.contractExtension.findUnique({ where: { id: r.extension.id } })).status, "autoGranted");
  });
});
