// Every clock whose silence has a default outcome warns the person whose
// silence triggers it: 24 h left, 6 h left; never twice; stale ones skipped.
const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const rem = require("../src/contractReminders");

const H = 3_600_000;
let ctx;
before(async () => {
  ctx = await h.fixtures();
});
after(async () => {
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});
const entry = (clock) => rem.SCHEDULE.find((e) => e.clock === clock);
const sweepAt = (at, mailer = h.spyMailer(), autoRelease = false) =>
  rem.sweepReminders({ prisma: h.scopedPrisma(), mailer, now: () => at, autoRelease }).then((r) => ({ r, mailer }));
const forJob = (mailer, s) => mailer.sent.filter((m) => m.args.jobTitle === s.job.title);

describe("which reminder is current (pure)", () => {
  const due = new Date("2026-10-10T12:00:00Z");
  const at = (hoursBefore) => new Date(due.getTime() - hoursBefore * H);
  it("nothing before 24 h left", () => assert.equal(rem.currentReminder(entry("change"), due, at(30)), null));
  it("24 h reminder between 24 h and 6 h left", () => assert.equal(rem.currentReminder(entry("change"), due, at(20)), "24h"));
  it("at 3 h left the 24 h one is stale; the 6 h one applies", () => assert.equal(rem.currentReminder(entry("change"), due, at(3)), "6h"));
  it("nothing once the clock has run out (the outcome email covers it)", () => assert.equal(rem.currentReminder(entry("change"), due, at(-1)), null));
  it("delivery: a reminder at the date itself, for 3 days", () => {
    assert.equal(rem.currentReminder(entry("delivery"), due, at(-1)), "due");
    assert.equal(rem.currentReminder(entry("delivery"), due, at(-73)), null);
  });
});

describe("sending", () => {
  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  });

  it("talent's resubmit clock at 20 h left: one '24h' reminder, never twice", async () => {
    const s = await h.seedSubmitted(ctx, { changeRounds: 1, contract: { status: "changesRequested", reviewDueAt: null, changeDueAt: new Date(Date.now() + 20 * H) } });
    const first = await sweepAt(new Date());
    assert.deepEqual(forJob(first.mailer, s).map((m) => [m.k, m.to, m.args.kind]), [["sendClockReminder", ctx.talentA.email, "change"]]);
    const second = await sweepAt(new Date());
    assert.equal(forJob(second.mailer, s).length, 0);
  });

  it("two sweeps at the same instant still send it once", async () => {
    const s = await h.seedSubmitted(ctx, { changeRounds: 1, contract: { status: "changesRequested", reviewDueAt: null, changeDueAt: new Date(Date.now() + 5 * H) } });
    const mailer = h.spyMailer();
    await Promise.all([sweepAt(new Date(), mailer), sweepAt(new Date(), mailer)]);
    assert.equal(forJob(mailer, s).length, 1);
  });

  it("extension waiting on the client: client reminded", async () => {
    const s = await h.seedWorking(ctx);
    await prisma.contractExtension.create({ data: { contractId: s.c.id, requestedDays: 1, reason: "Waiting on assets.", answerDueAt: new Date(Date.now() + 10 * H) } });
    const { mailer } = await sweepAt(new Date());
    assert.deepEqual(forJob(mailer, s).map((m) => [m.to, m.args.kind]), [[ctx.client.email, "extension"]]);
  });

  it("delivery date passed: talent and client both told; after an extension moves the date, the talent is reminded again", async () => {
    const s = await h.seedWorking(ctx, { deliverByAt: h.past(H) });
    const first = await sweepAt(new Date());
    assert.deepEqual(forJob(first.mailer, s).map((m) => m.args.kind).sort(), ["deliveryMissedPassed", "deliveryPassed"]);
    await prisma.contract.update({ where: { id: s.c.id }, data: { deliverByAt: new Date(Date.now() + 10 * H) } });
    const again = await sweepAt(new Date());
    assert.deepEqual(forJob(again.mailer, s).map((m) => m.args.kind), ["delivery"]);
  });

  it("review reminders only when auto-release is on (silence only means something then)", async () => {
    const s = await h.seedSubmitted(ctx, { contract: { reviewDueAt: new Date(Date.now() + 5 * H) } });
    const off = await sweepAt(new Date(), h.spyMailer(), false);
    assert.equal(forJob(off.mailer, s).length, 0);
    const on = await sweepAt(new Date(), h.spyMailer(), true);
    assert.deepEqual(forJob(on.mailer, s).map((m) => m.args.kind), ["review"]);
  });

  it("a failed send is retried on the next sweep", async () => {
    const s = await h.seedSubmitted(ctx, { changeRounds: 1, contract: { status: "changesRequested", reviewDueAt: null, changeDueAt: new Date(Date.now() + 5 * H) } });
    const spy = h.spyMailer();
    const broken = new Proxy(spy, {
      get: (t, k) => (k === "sendClockReminder" ? async () => ({ sent: false, error: new Error("Brevo down") }) : t[k]),
    });
    await sweepAt(new Date(), broken);
    assert.equal(await prisma.contractReminder.count({ where: { contractId: s.c.id } }), 0);
    const { mailer } = await sweepAt(new Date());
    assert.equal(forJob(mailer, s).length, 1);
  });
});
