const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const alerts = require("../src/alerts");

let slack, failing, owner, onCall, offDuty, mails;
const fakeMailer = { sendOpsAlert: async ({ to }) => { mails.push(to); return { sent: true }; } };
const deps = () => ({ fetchImpl: fetch, mailer: fakeMailer, webhookUrl: slack.url, dashboardUrl: "https://admin.example" });
const ids = () => [owner.id, onCall.id, offDuty.id];

before(async () => {
  slack = await h.serveFakeSlack();
  failing = await h.serveFakeSlack({ fail: true });
  owner = await h.ensureAdmin("testsuite-owner@example.com", { role: "owner" });
  onCall = await h.ensureAdmin("testsuite-oncall@example.com", { capabilities: ["finance"] });
  offDuty = await h.ensureAdmin("testsuite-offduty@example.com", { capabilities: ["safety"] });
  await prisma.onCallShift.deleteMany({ where: { adminId: { in: ids() } } });
  await prisma.opsAlert.deleteMany({ where: { queueKey: { startsWith: "test-" } } });
});
after(async () => {
  slack.server.close();
  failing.server.close();
  await prisma.onCallShift.deleteMany({ where: { adminId: { in: ids() } } });
  await prisma.opsAlert.deleteMany({ where: { queueKey: { startsWith: "test-" } } });
  await prisma.$disconnect();
});

describe("on call", () => {
  it("finds who is on call at a moment, and nobody outside their shift", async () => {
    const at = new Date("2026-11-14T21:00:00Z");
    await prisma.onCallShift.create({ data: { adminId: onCall.id, startsAt: new Date("2026-11-14T17:00:00Z"), endsAt: new Date("2026-11-15T07:00:00Z") } });
    assert.deepEqual((await alerts.onCallNow(prisma, at)).map((a) => a.id), [onCall.id]);
    assert.deepEqual(await alerts.onCallNow(prisma, new Date("2026-11-15T08:00:00Z")), []);
  });
});

describe("raiseAlert", () => {
  it("an urgent alert goes to Slack and to the person on call, and the row records what was sent", async () => {
    mails = [];
    const before = slack.received.length;
    const row = await alerts.raiseAlert(
      prisma,
      { severity: "urgent", queueKey: "test-chargebacks", title: "Chargeback on ₦55,000", body: "16 working hours to answer.", link: "/inbox" },
      { ...deps(), now: new Date("2026-11-14T21:00:00Z") },
    );
    assert.equal(slack.received.length, before + 1);
    assert.match(slack.received.at(-1).text, /Chargeback on ₦55,000/);
    assert.match(slack.received.at(-1).text, /https:\/\/admin\.example\/inbox/);
    assert.deepEqual(mails, ["testsuite-oncall@example.com"]);
    const back = await prisma.opsAlert.findUnique({ where: { id: row.id } });
    assert.equal(back.slackSent, true);
    assert.deepEqual(back.emailedTo, ["testsuite-oncall@example.com"]);
  });

  it("with nobody on call, an urgent alert emails the owners instead", async () => {
    mails = [];
    await alerts.raiseAlert(prisma, { severity: "urgent", queueKey: "test-safety", title: "Report", body: "A scam report." }, { ...deps(), now: new Date("2026-11-20T12:00:00Z") });
    assert.ok(mails.includes("testsuite-owner@example.com"));
    assert.ok(!mails.includes("testsuite-offduty@example.com"));
  });

  it("a Slack failure is recorded as not sent, and email still goes out", async () => {
    mails = [];
    const row = await alerts.raiseAlert(prisma, { severity: "urgent", queueKey: "test-payouts", title: "Payout failed", body: "x" }, { ...deps(), webhookUrl: failing.url, now: new Date("2026-11-20T12:00:00Z") });
    const back = await prisma.opsAlert.findUnique({ where: { id: row.id } });
    assert.equal(back.slackSent, false);
    assert.ok(mails.length >= 1);
  });

  it("a digest alert is stored, not sent, until the digest goes out once", async () => {
    mails = [];
    const before = slack.received.length;
    await alerts.raiseAlert(prisma, { severity: "digest", queueKey: "test-proof", title: "2 proofs past target", body: "Oldest 5 days." }, deps());
    assert.equal(slack.received.length, before);
    const first = await alerts.sendDigest(prisma, deps());
    assert.ok(first.sent >= 1);
    assert.match(slack.received.at(-1).text, /2 proofs past target/);
    const second = await alerts.sendDigest(prisma, deps());
    assert.equal(second.sent, 0, "nothing is sent twice");
  });

  it("refuses an unknown severity", async () => {
    await assert.rejects(() => alerts.raiseAlert(prisma, { severity: "loud", queueKey: "test-x", title: "t", body: "b" }, deps()), /severity/);
  });
});
