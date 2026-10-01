// Change rounds: at most 2, each with a 3-day resubmit clock; still
// unresolved after round 2, or the talent misses the clock -> an admin.
const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const changes = require("../src/contractChanges");
const life = require("../src/contractLifecycle");

const WHY = "The logo colours don't match the brand guide.";
let ctx;
before(async () => {
  ctx = await h.fixtures();
});
after(async () => {
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});
const contractOf = (s) => prisma.contract.findUnique({ where: { id: s.c.id } });
const ask = (s, deps = {}) => changes.requestChanges({ contractId: s.c.id, clientId: ctx.client.id, reason: WHY }, { mailer: h.spyMailer(), ...deps });

describe("requesting changes", () => {
  it("round 1: changesRequested, 3-day resubmit clock, review clock stopped, talent emailed with the reason", async () => {
    const s = await h.seedSubmitted(ctx);
    const mailer = h.spyMailer();
    const at = new Date();
    const r = await ask(s, { mailer, now: () => at });
    assert.equal(r.ok, true);
    assert.equal(r.escalated, false);
    const c = await contractOf(s);
    assert.equal(c.status, "changesRequested");
    assert.equal(c.changeRounds, 1);
    assert.equal(c.changeDueAt.getTime(), at.getTime() + 3 * h.DAY_MS);
    assert.equal(c.reviewDueAt, null);
    const round = await prisma.changeRequest.findFirst({ where: { contractId: s.c.id } });
    assert.equal(round.reason, WHY);
    assert.deepEqual(mailer.sent.map((m) => [m.k, m.to, m.args.round]), [["sendChangesRequested", ctx.talentA.email, 1]]);
  });

  it("a reason is required; only delivered work can be sent back", async () => {
    const s = await h.seedSubmitted(ctx);
    assert.equal((await changes.requestChanges({ contractId: s.c.id, clientId: ctx.client.id, reason: "no" })).code, "bad_reason");
    const w = await h.seedWorking(ctx);
    assert.equal((await ask(w)).code, "not_submitted");
  });

  it("two requests at the same instant: one round", async () => {
    const s = await h.seedSubmitted(ctx);
    const racing = { prisma: h.barrierPrisma("contract", "findUnique") };
    const rs = await Promise.all([ask(s, racing), ask(s, racing)]);
    assert.equal(rs.filter((r) => r.ok).length, 1);
    assert.equal(await prisma.changeRequest.count({ where: { contractId: s.c.id } }), 1);
  });

  it("full cycle: round 1, resubmit, round 2, resubmit, still unhappy -> escalated to an admin, no round 3", async () => {
    const s = await h.seedSubmitted(ctx);
    for (let round = 1; round <= 2; round++) {
      assert.equal((await ask(s)).ok, true, `round ${round}`);
      assert.equal((await changes.submitDelivery({ contractId: s.c.id, note: `v${round + 1}` })).ok, true);
    }
    const mailer = h.spyMailer();
    const r = await ask(s, { mailer });
    assert.equal(r.escalated, true);
    assert.equal((await contractOf(s)).status, "disputed");
    assert.equal(await prisma.changeRequest.count({ where: { contractId: s.c.id } }), 2);
    const ev = await prisma.contractEvent.findFirst({ where: { contractId: s.c.id, type: "escalated" } });
    assert.equal(ev.meta.reason, "client_rejected_after_final_round");
    assert.equal(ev.meta.note, WHY);
    assert.equal(mailer.sent.filter((m) => m.k === "sendEscalated").length, 2, "client and talent told");
  });
});

describe("the talent's 3-day resubmit clock", () => {
  // Sweeps see every due contract; earlier tests' leftovers would be swept too.
  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  });
  const sentBack = async () => {
    const s = await h.seedSubmitted(ctx);
    await ask(s);
    return { s, due: (await contractOf(s)).changeDueAt };
  };

  it("missed: escalated to an admin", async () => {
    const { s, due } = await sentBack();
    const r = await changes.sweepChanges({ prisma: h.scopedPrisma(), mailer: h.spyMailer(), now: () => new Date(due.getTime() + 1) });
    assert.deepEqual(r, { escalated: 1 });
    assert.equal((await contractOf(s)).status, "disputed");
    const ev = await prisma.contractEvent.findFirst({ where: { contractId: s.c.id, type: "escalated" } });
    assert.equal(ev.meta.reason, "talent_missed_change_deadline");
  });

  it("not yet due: untouched", async () => {
    const { s } = await sentBack();
    await changes.sweepChanges({ prisma: h.scopedPrisma(), mailer: h.spyMailer() });
    assert.equal((await contractOf(s)).status, "changesRequested");
  });

  it("resubmitted a little late but before the tick: the resubmission stands", async () => {
    const { s, due } = await sentBack();
    const late = () => new Date(due.getTime() + 60_000);
    assert.equal((await changes.submitDelivery({ contractId: s.c.id, note: "v2" }, { now: late })).ok, true);
    await changes.sweepChanges({ prisma: h.scopedPrisma(), mailer: h.spyMailer(), now: late });
    assert.equal((await contractOf(s)).status, "submitted");
  });

  it("a sweep holding a stale read can't escalate a fresh round (its clock hasn't run out)", async () => {
    const { s, due } = await sentBack();
    const stale = await prisma.contract.findUnique({ where: { id: s.c.id }, include: { job: true } });
    // Meanwhile: resubmitted, and the client opened round 2 with a new 3-day clock.
    await changes.submitDelivery({ contractId: s.c.id, note: "v2" });
    await ask(s);
    const r = await changes.escalateContract(prisma, h.spyMailer(), {
      contract: stale,
      from: "changesRequested",
      reason: "talent_missed_change_deadline",
      at: new Date(due.getTime() + 1),
    });
    assert.equal(r.ok, false);
    const c = await contractOf(s);
    assert.equal(c.status, "changesRequested");
    assert.equal(c.changeRounds, 2);
  });

  it("the tick runs it", async () => {
    const { s, due } = await sentBack();
    await life.runTick({ prisma: h.scopedPrisma(), mailer: h.spyMailer(), paystack: h.fakeProvider(), autoRelease: false, now: () => new Date(due.getTime() + 1) });
    assert.equal((await contractOf(s)).status, "disputed");
  });
});

describe("money and change requests never cross", () => {
  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  });

  it("a disputed contract is never auto-released", async () => {
    const s = await h.seedSubmitted(ctx, { contract: { status: "disputed", reviewDueAt: h.past() } });
    const pay = h.fakeProvider();
    await life.runTick({ prisma: h.scopedPrisma(), mailer: h.spyMailer(), paystack: pay, autoRelease: true });
    assert.equal(pay.payouts.length, 0);
    assert.equal((await contractOf(s)).status, "disputed");
  });

  it("client taps Request changes while a payout is in flight: refused, and the contract ends approved with the money sent", async () => {
    const s = await h.seedSubmitted(ctx);
    const pay = h.fakeProvider();
    let releaseTransfer;
    const gate = new Promise((resolve) => (releaseTransfer = resolve));
    const realInitiate = pay.initiateTransfer;
    pay.initiateTransfer = async (args) => {
      await gate;
      return realInitiate(args);
    };
    const releasing = life.releasePayment({ contractId: s.c.id, trigger: "client_approved" }, { paystack: pay, mailer: h.spyMailer() });
    for (let i = 0; i < 100 && !(await contractOf(s)).releaseClaimedAt; i++) await new Promise((r) => setTimeout(r, 50));
    const r = await ask(s);
    releaseTransfer();
    const released = await releasing;
    assert.equal(r.ok, false);
    assert.equal(r.code, "conflict");
    assert.equal(released.ok, true);
    assert.equal((await contractOf(s)).status, "approved");
    assert.equal(pay.payouts.length, 1);
  });

  it("a failed payout releases the claim so the client can still ask for changes", async () => {
    const s = await h.seedSubmitted(ctx);
    const r = await life.releasePayment(
      { contractId: s.c.id, trigger: "client_approved" },
      { paystack: h.fakeProvider({ refusePayouts: true }), mailer: h.spyMailer() },
    );
    assert.equal(r.ok, false);
    assert.equal((await contractOf(s)).releaseClaimedAt, null);
    assert.equal((await ask(s)).ok, true);
  });
});
