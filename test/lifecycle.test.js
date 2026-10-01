// The payment-lifecycle rules (decision "How a job gets paid", 2026-10-01):
// 24h to pay, 3 days to review, auto-release, and the guards that stop a real
// payment being lost. Runs against TEST_DATABASE_URL with a fake provider that
// follows Paystack's documented behaviour; the HTTP section runs the real
// server and the real src/paystack.js client against a local fake.
//
// What this does NOT prove: that the real Paystack behaves like the fake.
// See docs/core/testing.md for the list of things only a live key can show.
const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const h = require("./helpers");
const { prisma, past, future } = h;
const life = require("../src/contractLifecycle");
const { confirmFunding } = require("../src/contractFunding");

let ctx;
before(async () => {
  ctx = await h.fixtures();
});
after(async () => {
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});

describe("agreed numbers and Paystack's reference rules (no database needed)", () => {
  it("windows are 24h to pay and 3 days to review", () => {
    assert.equal(life.WINDOWS.paymentMs, 24 * 3600_000);
    assert.equal(life.WINDOWS.reviewMs, 3 * 24 * 3600_000);
  });

  it("auto-release is off unless AUTO_RELEASE_ENABLED is exactly 'true'", () => {
    const saved = process.env.AUTO_RELEASE_ENABLED;
    try {
      delete process.env.AUTO_RELEASE_ENABLED;
      assert.equal(life.autoReleaseEnabled(), false);
      process.env.AUTO_RELEASE_ENABLED = "1";
      assert.equal(life.autoReleaseEnabled(), false);
      process.env.AUTO_RELEASE_ENABLED = "true";
      assert.equal(life.autoReleaseEnabled(), true);
    } finally {
      if (saved === undefined) delete process.env.AUTO_RELEASE_ENABLED;
      else process.env.AUTO_RELEASE_ENABLED = saved;
    }
  });

  it("every payout reference we can generate satisfies Paystack's documented format (a-z 0-9 _ -, 16-50 chars)", () => {
    for (let n = 1; n <= life.WINDOWS.autoReleaseMaxAttempts + 5; n++) {
      const ref = `kd_payout_${crypto.randomUUID()}_${n}`;
      assert.match(ref, /^[a-z0-9_-]+$/, ref);
      assert.ok(ref.length >= 16 && ref.length <= 50, `${ref} is ${ref.length} chars`);
    }
  });
});

describe("24-hour payment window", () => {
  it("A. unpaid past the deadline: award cancelled, everyone restored, client and talent emailed", async () => {
    const s = await h.seedAward(ctx);
    const mailer = h.spyMailer();
    const r = await life.voidUnpaidAward(s.c.id, { paystack: h.fakeProvider(), mailer });
    assert.equal(r.outcome, "voided");
    assert.equal(await prisma.contract.findUnique({ where: { id: s.c.id } }), null);
    const job = await prisma.job.findUnique({ where: { id: s.job.id } });
    assert.equal(job.awardedApplicationId, null);
    const apps = await prisma.application.findMany({ where: { jobId: s.job.id } });
    assert.deepEqual(apps.map((a) => a.status), ["pending", "pending"]);
    const events = await prisma.contractEvent.findMany({ where: { jobId: s.job.id } });
    assert.ok(events.some((e) => e.type === "award_voided"), "cancellation is recorded and survives the deleted contract");
    assert.deepEqual(mailer.sent.map((m) => m.to).sort(), [ctx.client.email, ctx.talentA.email].sort());
    ctx.voided = s;
  });

  it("B. paid on an OLDER checkout (slow bank transfer): funded, not cancelled", async () => {
    const s = await h.seedAward(ctx);
    const older = `kd_${s.c.id}_aaaaaaaa`;
    await prisma.contractEvent.create({ data: { jobId: s.job.id, contractId: s.c.id, type: "checkout_started", meta: { reference: older } } });
    await prisma.contract.update({ where: { id: s.c.id }, data: { paystackReference: `kd_${s.c.id}_bbbbbbbb`, checkoutStartedAt: past(3 * 3600_000) } });
    const paystack = h.fakeProvider({ transactions: { [older]: { status: "success", reference: older, amountKobo: 110000 } } });
    const r = await life.voidUnpaidAward(s.c.id, { paystack, mailer: h.spyMailer() });
    assert.equal(r.outcome, "was_paid");
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).status, "funded");
  });

  it("C. checkout opened 5 minutes ago: left alone, a payment may be settling", async () => {
    const s = await h.seedAward(ctx, { contract: { checkoutStartedAt: past(5 * 60_000) } });
    const r = await life.voidUnpaidAward(s.c.id, { paystack: h.fakeProvider(), mailer: h.spyMailer() });
    assert.equal(r.outcome, "checkout_in_flight");
    assert.ok(await prisma.contract.findUnique({ where: { id: s.c.id } }));
  });

  it("D. still inside the 24 hours: untouched", async () => {
    const s = await h.seedAward(ctx, { contract: { payByAt: future() } });
    const r = await life.voidUnpaidAward(s.c.id, { paystack: h.fakeProvider(), mailer: h.spyMailer() });
    assert.equal(r.outcome, "not_due");
  });

  it("E. a payment landing after cancellation is flagged and recorded, not silently kept", async () => {
    const ref = `kd_${ctx.voided.c.id}_cccccccc`;
    const r = await confirmFunding({ reference: ref, amountKobo: 110000, source: "suite" });
    assert.equal(r.outcome, "orphanPayment");
    assert.ok(await prisma.contractEvent.findFirst({ where: { contractId: ctx.voided.c.id, type: "late_payment_after_void" } }));
  });

  it("M. Paystack says the checkout is 'ongoing' (customer mid bank-transfer): wait, don't cancel", async () => {
    for (const status of ["ongoing", "pending", "processing"]) {
      const s = await h.seedAward(ctx);
      const ref = `kd_${s.c.id}_dddddddd`;
      await prisma.contract.update({ where: { id: s.c.id }, data: { paystackReference: ref, checkoutStartedAt: past(2 * 3600_000) } });
      const paystack = h.fakeProvider({ transactions: { [ref]: { status, reference: ref, amountKobo: 0 } } });
      const r = await life.voidUnpaidAward(s.c.id, { paystack, mailer: h.spyMailer() });
      assert.equal(r.outcome, "payment_in_flight", status);
      assert.ok(await prisma.contract.findUnique({ where: { id: s.c.id } }), `${status}: contract must still exist`);
    }
  });

  it("M2. the latest checkout is still 'ongoing' but an earlier one was paid: funded, not left waiting", async () => {
    const s = await h.seedAward(ctx);
    const paid = `kd_${s.c.id}_11111111`;
    const latest = `kd_${s.c.id}_22222222`;
    await prisma.contractEvent.create({ data: { jobId: s.job.id, contractId: s.c.id, type: "checkout_started", meta: { reference: paid } } });
    await prisma.contract.update({ where: { id: s.c.id }, data: { paystackReference: latest, checkoutStartedAt: past(2 * 3600_000) } });
    const paystack = h.fakeProvider({
      transactions: { [latest]: { status: "ongoing", reference: latest, amountKobo: 0 }, [paid]: { status: "success", reference: paid, amountKobo: 110000 } },
    });
    const r = await life.voidUnpaidAward(s.c.id, { paystack, mailer: h.spyMailer() });
    assert.equal(r.outcome, "was_paid");
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).status, "funded");
  });

  it("N. ...but not forever: still 'ongoing' 6 hours past the deadline, it is cancelled (a late payment is then an orphan alarm)", async () => {
    const s = await h.seedAward(ctx, { contract: { payByAt: past(7 * 3600_000) } });
    const ref = `kd_${s.c.id}_eeeeeeee`;
    await prisma.contract.update({ where: { id: s.c.id }, data: { paystackReference: ref, checkoutStartedAt: past(7 * 3600_000) } });
    const paystack = h.fakeProvider({ transactions: { [ref]: { status: "ongoing", reference: ref, amountKobo: 0 } } });
    const r = await life.voidUnpaidAward(s.c.id, { paystack, mailer: h.spyMailer() });
    assert.equal(r.outcome, "voided");
  });

  it("if Paystack cannot be reached the award is NOT cancelled (it waits for the next tick)", async () => {
    const s = await h.seedAward(ctx);
    const ref = `kd_${s.c.id}_ffffffff`;
    await prisma.contract.update({ where: { id: s.c.id }, data: { paystackReference: ref, checkoutStartedAt: past(2 * 3600_000) } });
    const paystack = h.fakeProvider();
    paystack.verifyTransaction = async () => { throw new Error("network down"); };
    const r = await life.voidUnpaidAward(s.c.id, { paystack, mailer: h.spyMailer() });
    assert.equal(r.outcome, "verify_failed");
    assert.ok(await prisma.contract.findUnique({ where: { id: s.c.id } }));
  });
});

describe("3-day review window and auto-release", () => {
  // runTick sweeps every due contract, so earlier tests' leftovers would be swept (and emailed about) too.
  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  });
  const submitted = (extra = {}) =>
    h.seedAward(ctx, { contract: { status: "submitted", payByAt: null, fundedAt: new Date(), submittedAt: past(4 * 86400_000), reviewDueAt: past(3600_000), ...extra } });
  const tick = (paystack, mailer, autoRelease) => life.runTick({ prisma: h.scopedPrisma(), paystack, mailer, autoRelease });

  it("F. silence for 3 days: paid once, budget only, both sides told, event says auto_release", async () => {
    const s = await submitted();
    const paystack = h.fakeProvider();
    const mailer = h.spyMailer();
    await tick(paystack, mailer, true);
    const c = await prisma.contract.findUnique({ where: { id: s.c.id } });
    assert.equal(c.status, "approved");
    assert.ok(c.transferredAt);
    assert.deepEqual(paystack.payouts.map((p) => p.amountNaira), [1000], "exactly one transfer, of the budget, no fee");
    assert.deepEqual(mailer.sent.map((m) => m.k).sort(), ["sendPaymentAutoReleasedToClient", "sendPaymentAutoReleasedToTalent"]);
    const ev = await prisma.contractEvent.findMany({ where: { contractId: s.c.id, type: "released" } });
    assert.ok(ev.some((e) => e.meta.trigger === "auto_release"));
    await tick(paystack, mailer, true);
    assert.equal(paystack.payouts.length, 1, "a second tick pays nothing more");
  });

  it("G. switched off: an overdue contract stays submitted and nothing is sent", async () => {
    const s = await submitted();
    const paystack = h.fakeProvider();
    await tick(paystack, h.spyMailer(), false);
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).status, "submitted");
    assert.equal(paystack.payouts.length, 0);
  });

  it("H. not yet due: untouched", async () => {
    const s = await submitted({ reviewDueAt: future(86400_000) });
    await tick(h.fakeProvider(), h.spyMailer(), true);
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).status, "submitted");
  });

  it("I. Paystack refuses: stays submitted, retried hourly (not every tick), then paid when it works", async () => {
    const s = await submitted();
    await tick(h.fakeProvider({ refusePayouts: true }), h.spyMailer(), true);
    let c = await prisma.contract.findUnique({ where: { id: s.c.id } });
    assert.equal(c.status, "submitted", "a refused transfer must not read as paid");
    assert.equal(c.autoReleaseAttempts, 1);
    await tick(h.fakeProvider({ refusePayouts: true }), h.spyMailer(), true);
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).autoReleaseAttempts, 1, "no hammering within the hour");
    await prisma.contract.update({ where: { id: s.c.id }, data: { lastAutoReleaseAttemptAt: past(2 * 3600_000) } });
    await tick(h.fakeProvider(), h.spyMailer(), true);
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).status, "approved");
  });

  it("J. client taps Approve while auto-release fires: ONE transfer (relies on the provider refusing a reused reference, which Paystack documents)", async () => {
    const s = await submitted();
    const paystack = h.fakeProvider();
    const deps = { paystack, mailer: h.spyMailer(), autoRelease: true };
    await Promise.all([
      life.releasePayment({ contractId: s.c.id, trigger: "client_approved" }, deps),
      life.autoReleaseOne(s.c.id, deps),
    ]);
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).status, "approved");
    assert.equal(paystack.payouts.length, 1);
  });

  it("O. transfer needs approval (otp): NOT marked paid, nobody told they were paid", async () => {
    const s = await submitted();
    const mailer = h.spyMailer();
    const r = await life.releasePayment({ contractId: s.c.id, trigger: "client_approved" }, { paystack: h.fakeProvider({ transferStatus: "otp" }), mailer });
    assert.equal(r.ok, false);
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).status, "submitted");
  });

  it("P. an earlier payout failed conclusively: the retry uses a NEW reference (Paystack refuses reuse)", async () => {
    const s = await submitted();
    const paystack = h.fakeProvider();
    paystack.transfers.set(`kd_payout_${s.c.id}_1`, { transferCode: "TRF_old", status: "failed" });
    const r = await life.releasePayment({ contractId: s.c.id, trigger: "client_approved" }, { paystack, mailer: h.spyMailer() });
    assert.equal(r.ok, true);
    assert.equal(paystack.payouts.length, 1);
    assert.equal(paystack.payouts[0].reference, `kd_payout_${s.c.id}_2`);
  });

  it("Q. an earlier payout is still live (pending): it is reused, never doubled", async () => {
    const s = await submitted();
    const paystack = h.fakeProvider();
    paystack.transfers.set(`kd_payout_${s.c.id}_1`, { transferCode: "TRF_live", status: "pending" });
    const r = await life.releasePayment({ contractId: s.c.id, trigger: "client_approved" }, { paystack, mailer: h.spyMailer() });
    assert.equal(r.ok, true);
    assert.equal(paystack.payouts.length, 0, "no second transfer was sent");
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).status, "approved");
  });
});

describe("HTTP routes (real server, real paystack.js client, fake Paystack over HTTP)", () => {
  let provider, fake, server;
  before(async () => {
    provider = h.fakeProvider();
    fake = await h.serveFakeProvider(provider);
    server = await h.startServer({ port: 4611, paystackUrl: fake.url, autoRelease: true });
  });
  after(() => {
    server?.stop();
    fake?.server.close();
  });

  it("K. award sets payByAt = now + 24h; opening a NEW checkout after it is refused", async () => {
    const ct = await h.tokenFor(ctx.client);
    const tt = await h.tokenFor(ctx.talentA);
    const job = (await h.call(server.base, ct, "POST", "/jobs", { title: `${h.TITLE_PREFIX}http`, category: h.CATEGORY, description: "suite", budget: 2000 })).json.job;
    const talentProfile = await prisma.talentProfile.findUnique({ where: { userId: ctx.talentA.id } });
    await prisma.proofItem.upsert({
      where: { id: "00000000-0000-4000-8000-000000000001" },
      update: { talentProfileId: talentProfile.id, category: h.CATEGORY, status: "verified" },
      create: { id: "00000000-0000-4000-8000-000000000001", talentProfileId: talentProfile.id, category: h.CATEGORY, title: "Verified sample", status: "verified" },
    });
    const applied = await h.call(server.base, tt, "POST", `/jobs/${job.id}/apply`);
    assert.equal(applied.status, 201, JSON.stringify(applied.json));
    const apps = (await h.call(server.base, ct, "GET", `/jobs/${job.id}/applications`)).json.applications;
    const t0 = Date.now();
    const award = await h.call(server.base, ct, "POST", `/jobs/${job.id}/applications/${apps[0].id}/award`);
    assert.equal(award.status, 201, JSON.stringify(award.json));
    const due = new Date(award.json.contract.payByAt).getTime();
    assert.ok(Math.abs(due - (t0 + 24 * 3600_000)) < 15_000, `payByAt ${award.json.contract.payByAt}`);

    await prisma.contract.update({ where: { id: award.json.contract.id }, data: { payByAt: past() } });
    const refused = await h.call(server.base, ct, "POST", `/jobs/${job.id}/contract/fund`);
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /24-hour/);
    assert.equal(provider.initialised.length, 0, "no checkout may be opened after the deadline");

    ctx.http = { job, contractId: award.json.contract.id, ct, tt };
  });

  it("L. fund (signed webhook) -> start -> submit: reviewDueAt = now + 3 days, event trail complete", async () => {
    const { job, contractId, ct, tt } = ctx.http;
    await prisma.contract.update({ where: { id: contractId }, data: { payByAt: future() } });
    const fund = await h.call(server.base, ct, "POST", `/jobs/${job.id}/contract/fund`);
    assert.equal(fund.status, 200, JSON.stringify(fund.json));
    assert.equal(provider.initialised.length, 1);

    const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: fund.json.reference, amount: 2200 * 100, status: "success" } }));
    provider.transactions[fund.json.reference] = { status: "success", reference: fund.json.reference, amountKobo: 2200 * 100 };
    const hook = await fetch(`${server.base}/webhooks/paystack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-paystack-signature": crypto.createHmac("sha512", "sk_test_suite").update(raw).digest("hex") },
      body: raw,
    });
    assert.equal(hook.status, 200);
    for (let i = 0; i < 25; i++) {
      if ((await prisma.contract.findUnique({ where: { id: contractId } })).status === "funded") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal((await prisma.contract.findUnique({ where: { id: contractId } })).status, "funded", server.logs().slice(-600));

    await h.call(server.base, tt, "POST", `/jobs/${job.id}/contract/start`);
    const t1 = Date.now();
    const sub = await h.call(server.base, tt, "POST", `/jobs/${job.id}/contract/submit`, { deliverableNote: "done" });
    assert.equal(sub.status, 200, JSON.stringify(sub.json));
    assert.ok(Math.abs(new Date(sub.json.contract.reviewDueAt).getTime() - (t1 + 3 * 86400_000)) < 15_000);
    const trail = (await prisma.contractEvent.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" } })).map((e) => e.type);
    assert.deepEqual(trail, ["awarded", "checkout_started", "submitted"]);
  });

  it("a webhook with a bad signature is rejected and changes nothing", async () => {
    const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "kd_nope_00000000", amount: 1, status: "success" } }));
    const res = await fetch(`${server.base}/webhooks/paystack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-paystack-signature": "0".repeat(128) },
      body: raw,
    });
    assert.ok(res.status === 401 || res.status === 400, `status ${res.status}`);
  });
});
