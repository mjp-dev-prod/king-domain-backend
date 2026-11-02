// S6: "Something's wrong", the ways out, escalation, rulings and the second person, cancel-for-refund, settlement
// money, reopening a failed job, and chargebacks. Money runs against the Paystack stand-in.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const disputes = require("../src/disputes");
const settlement = require("../src/settlement");
const chargebacks = require("../src/chargebacks");
const { prisma } = h;

let ctx, server, provider, fakeProvider, cl, ca, ownerTok, secondTok, plainTok, owner, second, plain;
const admins = [];

before(async () => {
  ctx = await h.fixtures();
  provider = h.fakeProvider();
  fakeProvider = await h.serveFakeProvider(provider);
  server = await h.startServer({ port: 4681, paystackUrl: fakeProvider.url, autoRelease: false });
  owner = await h.ensureAdmin("testsuite-s6-ruler@example.com", { capabilities: ["disputes", "finance"] });
  second = await h.ensureAdmin("testsuite-s6-second@example.com", { capabilities: ["disputes"] });
  plain = await h.ensureAdmin("testsuite-s6-plain@example.com");
  admins.push(owner, second, plain);
  [cl, ca, ownerTok, secondTok, plainTok] = await Promise.all([h.tokenFor(ctx.client), h.tokenFor(ctx.talentA), h.adminTokenFor(owner), h.adminTokenFor(second), h.adminTokenFor(plain)]);
});
after(async () => {
  server?.stop();
  fakeProvider?.server.close();
  await prisma.chargeback.deleteMany({ where: { paystackDisputeId: { startsWith: "testsuite-" } } });
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.user.update({ where: { id: ctx.client.id }, data: { removedAt: null, removedReason: null } });
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: { in: admins.map((a) => a.id) } } });
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);
const ref = () => `kd_t_${Math.random().toString(16).slice(2)}`;

/** A funded job in progress, awarded to talent A, B also applied. */
async function working({ budget = 10000, contract = {}, status = "inProgress" } = {}) {
  const s = await h.seedWorking(ctx, { status, contract: { platformFeeAmount: budget * 0.1, paystackReference: ref(), ...contract } });
  await prisma.job.update({ where: { id: s.job.id }, data: { budget } });
  return s;
}

describe("the money", () => {
  it("splits what is held to the kobo, after the 20% already paid", () => {
    const contract = { upfrontPaidAt: new Date(), upfrontAmount: 2000 };
    const held = settlement.heldOf(contract, { budget: 10000 });
    assert.equal(held, 8000);
    assert.deepEqual(settlement.splitOf(held, 25), { talentAmount: 2000, clientRefund: 6000 });
    assert.deepEqual(settlement.splitOf(333.33, 50), { talentAmount: 166.67, clientRefund: 166.66 });
    assert.equal(settlement.heldOf({ upfrontPaidAt: null }, { budget: 10000 }), 10000);
  });

  it("pays the talent their share and refunds the client the rest, once, never the fee", async () => {
    const { c } = await working();
    const fp = h.fakeProvider();
    const r = await settlement.settle({ contractId: c.id, talentPercent: 60, kind: "split", trigger: "test" }, { prisma, paystack: fp });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(fp.payouts.map((p) => p.amountNaira), [6000]);
    assert.deepEqual(fp.refunds.map((x) => x.amountKobo), [400000], "4 000 back, in kobo; the 1 000 fee stays");
    const row = await prisma.contract.findUnique({ where: { id: c.id } });
    assert.equal(row.status, "resolved");
    assert.ok(row.settledAt);
    assert.equal(row.settlement.talentPercent, 60);

    const again = await settlement.settle({ contractId: c.id, talentPercent: 60, kind: "split", trigger: "test" }, { prisma, paystack: fp });
    assert.equal(again.already, true);
    assert.equal(fp.payouts.length, 1, "no second payout");
    assert.equal(fp.refunds.length, 1, "no second refund");
  });

  it("a failed refund leaves the contract open, keeps the payout, and a retry only does the refund", async () => {
    const { c } = await working();
    const fp = h.fakeProvider();
    fp.refuseRefunds = true;
    const first = await settlement.settle({ contractId: c.id, talentPercent: 50, kind: "split", trigger: "test" }, { prisma, paystack: fp });
    assert.equal(first.ok, false);
    assert.equal(first.code, "refund_error");
    let row = await prisma.contract.findUnique({ where: { id: c.id } });
    assert.notEqual(row.status, "resolved");
    assert.ok(row.settlement.talentPaidAt, "the payout is on record");
    assert.equal(row.settlementClaimedAt, null, "the claim is released so it can be tried again");

    fp.refuseRefunds = false;
    const retry = await settlement.settle({ contractId: c.id, talentPercent: 50, kind: "split", trigger: "test" }, { prisma, paystack: fp });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(fp.payouts.length, 1, "the talent is not paid twice");
    assert.equal(fp.refunds.length, 1);
  });

  it("refuses a different split once one has started", async () => {
    const { c } = await working();
    const fp = h.fakeProvider();
    fp.refuseRefunds = true;
    await settlement.settle({ contractId: c.id, talentPercent: 50, kind: "split", trigger: "test" }, { prisma, paystack: fp });
    const other = await settlement.settle({ contractId: c.id, talentPercent: 10, kind: "split", trigger: "test" }, { prisma, paystack: fp });
    assert.equal(other.code, "settlement_started");
  });
});

describe("saying what is wrong", () => {
  it("each side can pick only the problems that are theirs, and the contract is held", async () => {
    const { c, job } = await working();
    const bad = await api(ca, "POST", `/jobs/${job.id}/contract/dispute`, { problem: "not_delivered", note: "They didn't deliver anything." });
    assert.equal(bad.status, 400, "a talent can't say the work wasn't delivered");
    const ok = await api(cl, "POST", `/jobs/${job.id}/contract/dispute`, { problem: "other_side_silent", note: "I have not heard from them in days." });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.dispute.status, "open");
    assert.ok((await prisma.contract.findUnique({ where: { id: c.id } })).disputeHoldAt, "clocks wait");
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/contract/dispute`, { problem: "quality", note: "A second one at once." })).status, 409);
    const view = await api(ca, "GET", `/jobs/${job.id}/contract/dispute`);
    assert.equal(view.json.canFile, false);
    assert.equal(view.json.dispute.filedByMe, false);
  });

  it("while a dispute is open the clocks and the money routes stand still", async () => {
    const { c, job } = await working({ status: "submitted", contract: { submittedAt: new Date(), reviewDueAt: h.past() } });
    await api(cl, "POST", `/jobs/${job.id}/contract/dispute`, { problem: "quality", note: "This is not the quality we agreed on." });
    const approve = await api(cl, "POST", `/jobs/${job.id}/contract/approve`, {});
    assert.equal(approve.status, 409);
    assert.equal(approve.json.code, "dispute_open");
    const lifecycle = require("../src/contractLifecycle");
    await lifecycle.runTick({ prisma: h.scopedPrisma(), paystack: h.fakeProvider(), mailer: h.spyMailer(), now: () => new Date(), autoRelease: true });
    assert.equal((await prisma.contract.findUnique({ where: { id: c.id } })).status, "submitted", "auto-release did not pay while the dispute was open");
  });

  it("a stranger cannot see it", async () => {
    const { job } = await working();
    const stranger = await h.tokenFor(ctx.talentB);
    assert.equal((await api(stranger, "GET", `/jobs/${job.id}/contract/dispute`)).status, 404);
  });
});

describe("ways out", () => {
  async function open(opts) {
    const s = await working(opts);
    const r = await api(cl, "POST", `/jobs/${s.job.id}/contract/dispute`, { problem: "other_side_silent", note: "Nothing from them for days." });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return { ...s, dispute: r.json.dispute };
  }

  it("more time is accepted by the other side and moves the date and the hold", async () => {
    const { job, c, dispute } = await open();
    const before = (await prisma.contract.findUnique({ where: { id: c.id } })).deliverByAt;
    const offer = await api(ca, "POST", `/jobs/${job.id}/contract/dispute/proposals`, { kind: "more_time", params: { days: 3 } });
    assert.equal(offer.status, 201, JSON.stringify(offer.json));
    const pid = offer.json.dispute.proposals[0].id;
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/contract/dispute/proposals/${pid}/answer`, { decision: "accept" })).status, 403, "you can't accept your own offer");
    const accepted = await api(cl, "POST", `/jobs/${job.id}/contract/dispute/proposals/${pid}/answer`, { decision: "accept" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    const row = await prisma.contract.findUnique({ where: { id: c.id } });
    assert.equal(row.disputeHoldAt, null);
    assert.ok(row.deliverByAt > before);
    assert.equal((await prisma.dispute.findUnique({ where: { id: dispute.id } })).status, "resolved");
  });

  it("an agreed split moves the money and the job ends resolved", async () => {
    const { job, c } = await open();
    const offer = await api(cl, "POST", `/jobs/${job.id}/contract/dispute/proposals`, { kind: "split", params: { talentPercent: 30 } });
    const pid = offer.json.dispute.proposals[0].id;
    const accepted = await api(ca, "POST", `/jobs/${job.id}/contract/dispute/proposals/${pid}/answer`, { decision: "accept" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    const row = await prisma.contract.findUnique({ where: { id: c.id } });
    assert.equal(row.status, "resolved");
    assert.equal(row.settlement.talentAmount, 3000);
    assert.equal(row.settlement.clientRefund, 7000);
    assert.ok(provider.payouts.some((p) => p.reference.startsWith(`kd_settle_${c.id}`) && p.amountNaira === 3000));
  });

  it("a cancel by agreement refunds what is held and reopens the job to the others", async () => {
    const { job, c } = await open();
    const offer = await api(ca, "POST", `/jobs/${job.id}/contract/dispute/proposals`, { kind: "cancel" });
    const pid = offer.json.dispute.proposals[0].id;
    await api(cl, "POST", `/jobs/${job.id}/contract/dispute/proposals/${pid}/answer`, { decision: "accept" });
    assert.equal((await prisma.contract.findUnique({ where: { id: c.id } })).status, "resolved");
    assert.ok(provider.refunds.length > 0, "the held money is on its way back to the client");
    const reopened = await prisma.job.findFirst({ where: { reopenedFromId: job.id }, include: { applications: true } });
    assert.ok(reopened, "a new post exists for the other applicants");
    assert.equal(reopened.applications.length, 1, "talent B carries over");
    assert.equal(reopened.applications[0].talentId, ctx.talentB.id);
    assert.equal(reopened.applications[0].status, "pending");
  });

  it("only one offer waits at a time, a bad share is refused, and a declined offer can be followed by another", async () => {
    const { job } = await open();
    const bad = await api(cl, "POST", `/jobs/${job.id}/contract/dispute/proposals`, { kind: "split", params: { talentPercent: 140 } });
    assert.equal(bad.status, 400);
    const first = await api(cl, "POST", `/jobs/${job.id}/contract/dispute/proposals`, { kind: "split", params: { talentPercent: 40 } });
    assert.equal(first.status, 201);
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/contract/dispute/proposals`, { kind: "cancel" })).json.code, "pending_exists");
    await api(ca, "POST", `/jobs/${job.id}/contract/dispute/proposals/${first.json.dispute.proposals[0].id}/answer`, { decision: "decline" });
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/contract/dispute/proposals`, { kind: "split", params: { talentPercent: 70 } })).status, 201);
  });

  it("silence for 48 hours expires the offer and sends it to the team", async () => {
    const { job, dispute } = await open();
    await api(cl, "POST", `/jobs/${job.id}/contract/dispute/proposals`, { kind: "carry_on" });
    const future = new Date(Date.now() + 49 * 3_600_000);
    const r = await disputes.sweepDisputes({ prisma, now: () => future });
    assert.ok(r.disputesEscalated >= 1);
    const row = await prisma.dispute.findUnique({ where: { id: dispute.id } });
    assert.equal(row.status, "escalated");
    assert.equal(row.escalationReason, "unanswered");
    assert.ok(row.rulingDueAt > future, "5 days from when it was escalated");
  });
});

describe("the team rules", () => {
  async function escalated(opts) {
    const s = await working(opts);
    const r = await api(cl, "POST", `/jobs/${s.job.id}/contract/dispute`, { problem: "not_as_briefed", note: "The brief asked for three concepts and I got one." });
    const e = await api(cl, "POST", `/jobs/${s.job.id}/contract/dispute/escalate`);
    assert.equal(e.status, 200, JSON.stringify(e.json));
    return { ...s, dispute: r.json.dispute };
  }

  it("needs the Disputes role and reasons that can be followed", async () => {
    const { dispute } = await escalated();
    assert.equal((await api(plainTok, "GET", "/admin/disputes")).status, 403);
    const short = await h.call(server.base, ownerTok, "POST", `/admin/disputes/${dispute.id}/rule`, { outcome: "refund", reasons: "No." });
    assert.equal(short.status, 400, "reasons must be written so both people can follow them");
  });

  it("a split ruling under the limit pays at once, records the loser, and shows both people the reasons", async () => {
    const { dispute, job, c } = await escalated();
    const adm = (p, b) => h.call(server.base, ownerTok, "POST", `/admin${p}`, b);
    assert.equal((await adm(`/disputes/${dispute.id}/rule`, { outcome: "refund", reasons: "No." })).status, 400);
    assert.equal((await adm(`/disputes/${dispute.id}/rule`, { outcome: "split", talentPercent: 0, reasons: "x".repeat(100) })).status, 400, "a split is between 1 and 99");
    const reasons = "The brief asked for three concept directions and one was delivered. The conversation shows the talent agreed to three on day one. We rule 30% to the talent for the work that was done.";
    const ruled = await adm(`/disputes/${dispute.id}/rule`, { outcome: "split", talentPercent: 30, reasons });
    assert.equal(ruled.status, 200, JSON.stringify(ruled.json));
    assert.equal(ruled.json.awaitingApproval, false);
    const row = await prisma.contract.findUnique({ where: { id: c.id } });
    assert.equal(row.status, "resolved");
    assert.equal(row.settlement.talentAmount, 3000);
    const d = await prisma.dispute.findUnique({ where: { id: dispute.id } });
    assert.equal(d.status, "resolved");
    assert.equal(d.loserId, ctx.talentA.id, "30% to the talent means they lost");
    const seen = await api(cl, "GET", `/jobs/${job.id}/contract/dispute`);
    assert.equal(seen.json.dispute.ruling.reasons, reasons);
    assert.equal(seen.json.dispute.ruling.talentPercent, 30);
    assert.equal((await adm(`/disputes/${dispute.id}/rule`, { outcome: "refund", reasons })).status, 409, "rulings are final: no second ruling");
  });

  it("above ₦100,000 a second person has to approve, and not the same one", async () => {
    const { dispute, c } = await escalated({ budget: 150000 });
    const reasons = "The brief and the delivered files were compared in the case screen and the work meets the format asked for. Full release.";
    const ruled = await h.call(server.base, ownerTok, "POST", `/admin/disputes/${dispute.id}/rule`, { outcome: "release", reasons });
    assert.equal(ruled.json.awaitingApproval, true);
    assert.notEqual((await prisma.contract.findUnique({ where: { id: c.id } })).status, "resolved", "nothing moved yet");
    assert.equal((await h.call(server.base, ownerTok, "POST", `/admin/disputes/${dispute.id}/approve`)).status, 403, "the same person can't approve");
    const approved = await h.call(server.base, secondTok, "POST", `/admin/disputes/${dispute.id}/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal((await prisma.contract.findUnique({ where: { id: c.id } })).status, "resolved");
    assert.ok(provider.payouts.some((p) => p.reference.startsWith(`kd_settle_${c.id}`) && p.amountNaira === 150000));
  });

  it("a ruling that is sent back leaves the case open for another", async () => {
    const { dispute } = await escalated({ budget: 150000 });
    const reasons = "The brief and the delivered files were compared; the work meets what was asked for, so this releases in full to the talent.";
    await h.call(server.base, ownerTok, "POST", `/admin/disputes/${dispute.id}/rule`, { outcome: "release", reasons });
    const back = await h.call(server.base, secondTok, "POST", `/admin/disputes/${dispute.id}/send-back`, { note: "Check the second delivery" });
    assert.equal(back.status, 200);
    assert.equal(await prisma.disputeRuling.count({ where: { disputeId: dispute.id } }), 0);
    assert.equal((await prisma.dispute.findUnique({ where: { id: dispute.id } })).status, "escalated");
  });

  it("a dispute still with the two sides can't be ruled on", async () => {
    const s = await working();
    const r = await api(cl, "POST", `/jobs/${s.job.id}/contract/dispute`, { problem: "quality", note: "Not the quality we agreed on." });
    const ruled = await h.call(server.base, ownerTok, "POST", `/admin/disputes/${r.json.dispute.id}/rule`, { outcome: "refund", reasons: "x".repeat(100) });
    assert.equal(ruled.status, 409);
  });
});

describe("a system dispute", () => {
  it("is opened already escalated, with the 5-day clock, when a contract is parked", async () => {
    const { c } = await working();
    const d = await disputes.openSystemDispute({ contractId: c.id, reason: "talent_missed_change_deadline" }, { prisma });
    assert.equal(d.status, "escalated");
    assert.equal(d.problem, "resubmit_missed");
    assert.equal(d.filedByRole, "system");
    assert.ok(d.rulingDueAt.getTime() - d.escalatedAt.getTime() === 5 * 24 * 3_600_000);
    assert.ok((await prisma.contract.findUnique({ where: { id: c.id } })).disputeHoldAt);
    const again = await disputes.openSystemDispute({ contractId: c.id, reason: "talent_missed_change_deadline" }, { prisma });
    assert.equal(again.id, d.id, "one case per contract");
  });
});

describe("cancel for a refund", () => {
  it("is for the client, only when 3 days past the date with nothing delivered", async () => {
    const early = await working({ contract: { deliverByAt: h.future() } });
    assert.equal((await api(cl, "POST", `/jobs/${early.job.id}/contract/cancel`)).json.code, "too_early");
    assert.equal((await api(ca, "POST", `/jobs/${early.job.id}/contract/cancel`)).status, 403);

    const late = await working({ contract: { deliverByAt: new Date(Date.now() - 4 * 24 * 3_600_000) } });
    const r = await api(cl, "POST", `/jobs/${late.job.id}/contract/cancel`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.refund, 10000);
    const row = await prisma.contract.findUnique({ where: { id: late.c.id } });
    assert.equal(row.status, "resolved");
    assert.equal(row.settlement.kind, "cancelled_overdue");
    assert.ok(await prisma.job.findFirst({ where: { reopenedFromId: late.job.id } }), "reopened to the other applicants");
  });

  it("refunds only the 80% when the 20% was already paid for the start proof", async () => {
    const { job, c } = await working({ contract: { deliverByAt: new Date(Date.now() - 4 * 24 * 3_600_000), upfrontPaidAt: new Date(), upfrontAmount: 2000, startProofStatus: "accepted" } });
    const r = await api(cl, "POST", `/jobs/${job.id}/contract/cancel`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.refund, 8000);
    assert.equal((await prisma.contract.findUnique({ where: { id: c.id } })).settlement.clientRefund, 8000);
  });

  it("is refused once something was delivered", async () => {
    const { job, c } = await working({ contract: { deliverByAt: new Date(Date.now() - 4 * 24 * 3_600_000) } });
    await prisma.contractDelivery.create({ data: { contractId: c.id, version: 1, note: "here" } });
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/contract/cancel`)).json.code, "delivered");
  });
});

describe("chargebacks", () => {
  it("counts 16 hours over weekdays only", () => {
    // Friday 2026-10-30 at 17:00 Lagos (16:00 UTC): 7 hours left on Friday, so 9 more on Monday morning.
    const friday = new Date("2026-10-30T16:00:00Z");
    assert.equal(chargebacks.addWeekdayHours(friday, 16).toISOString(), "2026-11-02T08:00:00.000Z");
    const monday = new Date("2026-11-02T08:00:00Z");
    assert.equal(chargebacks.addWeekdayHours(monday, 16).toISOString(), "2026-11-03T00:00:00.000Z");
  });

  it("always finishes, whatever second it starts on (a rounding slip once looped forever just before midnight)", () => {
    // Monday 13:56:35.123 UTC is 14:56:35.123 Lagos: 9h03m24.877s of Monday, the rest on Tuesday.
    assert.equal(chargebacks.addWeekdayHours(new Date("2026-11-02T13:56:35.123Z"), 16).toISOString(), "2026-11-03T05:56:35.123Z");
    for (let sec = 0; sec < 60; sec += 7) {
      for (const ms of [0, 1, 499, 500, 999]) {
        const start = new Date(Date.UTC(2026, 10, 3, 10, 14, sec, ms)); // a Tuesday: no weekend in the way
        assert.equal(chargebacks.addWeekdayHours(start, 16).getTime() - start.getTime(), 16 * 3_600_000, `from :${sec}.${ms}`);
      }
    }
  });

  it("is recorded when it arrives, linked to its contract, and the team is alerted", async () => {
    const { c } = await working({ contract: { paystackReference: "kd_cb_ref_1" } });
    const r = await chargebacks.receive({ event: "charge.dispute.create", data: { id: "testsuite-1", transaction: { reference: "kd_cb_ref_1", amount: 1100000 }, bin: "408408", last4: "4081", customer: { email: "c@example.com" } } }, { prisma });
    assert.equal(r.ok, true);
    assert.equal(r.chargeback.contractId, c.id);
    assert.equal(r.chargeback.status, "open");
    assert.ok(r.chargeback.dueAt);
    const again = await chargebacks.receive({ event: "charge.dispute.create", data: { id: "testsuite-1", transaction: { reference: "kd_cb_ref_1", amount: 1100000 } } }, { prisma });
    assert.equal(again.chargeback.id, r.chargeback.id, "receiving it twice makes one row");
    assert.ok(await prisma.opsAlert.findFirst({ where: { queueKey: "chargeback" }, orderBy: { createdAt: "desc" } }));
  });

  it("builds the receipt Paystack asks for, and says what is missing", async () => {
    const { c } = await working({ contract: { paystackReference: "kd_cb_ref_2", fundedAt: new Date() } });
    await chargebacks.receive({ event: "charge.dispute.create", data: { id: "testsuite-2", transaction: { reference: "kd_cb_ref_2", amount: 1100000 }, last4: "4081" } }, { prisma });
    const cb = await prisma.chargeback.findUnique({ where: { paystackDisputeId: "testsuite-2" } });
    const ev = await chargebacks.evidenceFor(prisma, cb.id);
    assert.equal(ev.ready, false);
    assert.ok(ev.missing.some((m) => /first six/.test(m)));
    const res = await h.call(server.base, ownerTok, "POST", `/admin/chargebacks/${cb.id}/respond`, {});
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "evidence_incomplete");
    assert.equal(chargebacks.receiptPdf(ev.lines).subarray(0, 8).toString(), "%PDF-1.4");
  });

  it("a lost one after approved work removes the client and leaves the talent paid", async () => {
    const { c } = await working({ status: "approved", contract: { paystackReference: "kd_cb_ref_3", transferredAt: new Date() } });
    await chargebacks.receive({ event: "charge.dispute.create", data: { id: "testsuite-3", transaction: { reference: "kd_cb_ref_3", amount: 1100000 } } }, { prisma });
    const r = await chargebacks.receive({ event: "charge.dispute.resolve", data: { id: "testsuite-3", resolution: "merchant-accepted", transaction: { reference: "kd_cb_ref_3" } } }, { prisma });
    assert.equal(r.chargeback.status, "lost");
    const client = await prisma.user.findUnique({ where: { id: ctx.client.id } });
    assert.ok(client.removedAt, "the client is removed");
    assert.equal((await prisma.contract.findUnique({ where: { id: c.id } })).transferredAt !== null, true, "what the talent was paid stays paid");
    const login = await fetch(`${server.base}/users/me`, { headers: { Authorization: `Bearer ${cl}` } });
    assert.equal(login.status, 401, "their sessions no longer work");
    await prisma.user.update({ where: { id: ctx.client.id }, data: { removedAt: null, removedReason: null } });
  });
});

describe("where a King Domain agent can reach a person", () => {
  it("is saved with its purpose, and refuses a half address", async () => {
    const bad = await api(ca, "PUT", "/users/me/address", { line: "1", city: "Lagos", state: "Lagos" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, "line");
    const ok = await api(ca, "PUT", "/users/me/address", { line: "12 Unity Road", city: "Ibadan", state: "Oyo" });
    assert.equal(ok.status, 200);
    assert.match(ok.json.purpose, /in person/);
    const got = await api(ca, "GET", "/users/me/address");
    assert.equal(got.json.address.city, "Ibadan");
  });
});
