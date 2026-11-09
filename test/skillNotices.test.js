// Who is told as a skill submission moves through the first check and the two reviewers (2026-11-09).
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const notices = require("../src/skillNotices");

const HOUR = 3_600_000;
let ctx, slack, owner, checker, plain, webReviewer, videoReviewer, mails;
const fakeMailer = { sendOpsAlert: async ({ to, title }) => { mails.push({ to, title }); return { sent: true }; } };
const deps = () => ({ db: prisma, fetchImpl: fetch, mailer: fakeMailer, webhookUrl: slack.url, dashboardUrl: "https://admin.example" });
const adminIds = () => [owner.id, checker.id, plain.id, webReviewer.id, videoReviewer.id];
const emailed = () => mails.map((m) => m.to);

async function wipe() {
  await prisma.skillSubmission.deleteMany({ where: { userId: ctx.talentA.id, skillKey: { in: ["web-development", "short-form-video"] } } });
}

before(async () => {
  ctx = await h.fixtures();
  slack = await h.serveFakeSlack();
  owner = await h.ensureAdmin("testsuite-notice-owner@example.com", { role: "owner" });
  checker = await h.ensureAdmin("testsuite-notice-checker@example.com", { capabilities: ["checker"] });
  plain = await h.ensureAdmin("testsuite-notice-plain@example.com", { capabilities: ["finance"] });
  webReviewer = await h.ensureAdmin("testsuite-notice-web@example.com", { capabilities: ["reviewer"], reviewerSkills: ["web-development"] });
  videoReviewer = await h.ensureAdmin("testsuite-notice-video@example.com", { capabilities: ["reviewer"], reviewerSkills: ["short-form-video"] });
});
after(async () => {
  await wipe();
  slack.server.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  mails = [];
  await wipe();
});

const seed = (over = {}) => prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey: "web-development", status: "authenticity", submittedAt: new Date(), ...over } });

describe("work lands at the first check", () => {
  it("emails the people who can check it, with a link to it, and not an admin who can't", async () => {
    const s = await seed();
    await notices.submissionSent({ submission: s, person: { fullName: "Suite Talent A" } }, deps());
    assert.ok(emailed().includes("testsuite-notice-checker@example.com"), "a checker is told");
    assert.ok(emailed().includes("testsuite-notice-owner@example.com"), "so is an owner");
    assert.ok(!emailed().includes("testsuite-notice-plain@example.com"), "an admin without the capability is not");
    assert.ok(!emailed().includes("testsuite-notice-web@example.com"), "and a reviewer is not asked to do the first check");
    assert.match(slack.received.at(-1).text, new RegExp(`https://admin.example/authenticity/${s.id}`));
    assert.match(mails[0].title, /Web development work to check/);
    const row = await prisma.opsAlert.findFirst({ where: { link: `/authenticity/${s.id}` } });
    assert.ok(row.emailedTo.includes("testsuite-notice-checker@example.com"), "the row records who was emailed");
    await prisma.opsAlert.deleteMany({ where: { link: `/authenticity/${s.id}` } });
  });

  it("never throws, whatever goes wrong", async () => {
    const boom = { sendOpsAlert: async () => { throw new Error("mail is down"); } };
    const s = await seed();
    const r = await notices.submissionSent({ submission: s, person: { fullName: "x" } }, { ...deps(), mailer: boom });
    assert.ok(r === null || typeof r === "object");
    await prisma.opsAlert.deleteMany({ where: { link: `/authenticity/${s.id}` } });
  });
});

describe("work is ready for the reviewers", () => {
  it("emails reviewers who hold that skill, and an owner, and no reviewer of another skill", async () => {
    const s = await seed({ status: "review", authenticityAt: new Date() });
    await notices.readyForReview({ submission: s }, deps());
    assert.ok(emailed().includes("testsuite-notice-web@example.com"));
    assert.ok(emailed().includes("testsuite-notice-owner@example.com"));
    assert.ok(!emailed().includes("testsuite-notice-video@example.com"), "a reviewer of another skill is not");
    assert.ok(!emailed().includes("testsuite-notice-checker@example.com"));
    await prisma.opsAlert.deleteMany({ where: { link: `/skill-reviews/${s.id}` } });
  });
});

describe("waiting too long", () => {
  const link = (s) => `/authenticity/${s.id}`;
  const reminders = (s) => prisma.opsAlert.count({ where: { link: link(s), title: { startsWith: "Reminder" } } });
  const clean = (s) => prisma.opsAlert.deleteMany({ where: { link: link(s) } });

  it("reminds once past the target, again at twice the target, and then stops", async () => {
    const t0 = new Date("2026-11-09T09:00:00Z");
    const s = await seed({ submittedAt: new Date(t0.getTime() - 10 * HOUR) });
    const run = (hoursAfter) => notices.sweepWaiting(prisma, new Date(t0.getTime() + hoursAfter * HOUR), deps());

    await run(0);
    assert.equal(await reminders(s), 0, "10 hours in, nothing is late yet (the first check's target is 24 hours)");
    await run(16);
    assert.equal(await reminders(s), 1, "26 hours in: the first reminder");
    await run(17);
    await run(20);
    assert.equal(await reminders(s), 1, "running again, even many times, never repeats it");
    await run(40);
    assert.equal(await reminders(s), 2, "past twice the target: the second");
    await run(100);
    await run(200);
    assert.equal(await reminders(s), 2, "and never a third");
    assert.ok(mails.some((m) => /Reminder: Web development work waiting/.test(m.title)));
    await clean(s);
  });

  it("work that is already far past its target gets one reminder now and the next a full target later, never two in a row", async () => {
    const t0 = new Date("2026-11-09T09:00:00Z");
    const s = await seed({ submittedAt: new Date(t0.getTime() - 172 * HOUR) });
    const run = (hoursAfter) => notices.sweepWaiting(prisma, new Date(t0.getTime() + hoursAfter * HOUR), deps());
    await run(0);
    await run(0.25);
    await run(0.5);
    assert.equal(await reminders(s), 1, "172 hours old on the first sweep, and the sweeps that follow 15 minutes later stay quiet");
    await run(23);
    assert.equal(await reminders(s), 1, "still inside the target since the first reminder");
    await run(24.5);
    assert.equal(await reminders(s), 2, "a full target (24 hours) after the first, the second");
    await run(100);
    assert.equal(await reminders(s), 2);
    await clean(s);
  });

  it("two sweeps at the same moment send no more than the two reminders a step allows", async () => {
    const t0 = new Date("2026-11-09T09:00:00Z");
    const s = await seed({ submittedAt: new Date(t0.getTime() - 30 * HOUR) });
    await Promise.all([notices.sweepWaiting(prisma, t0, deps()), notices.sweepWaiting(prisma, t0, deps())]);
    const n = await reminders(s);
    assert.ok(n >= 1 && n <= 2, `at most the two a step allows, got ${n}`);
    await clean(s);
  });

  it("the review step counts from the first check, and tells the reviewers who hold the skill", async () => {
    const t0 = new Date("2026-11-09T09:00:00Z");
    const s = await seed({ status: "review", submittedAt: new Date(t0.getTime() - 100 * HOUR), authenticityAt: new Date(t0.getTime() - 80 * HOUR) });
    await notices.sweepWaiting(prisma, t0, deps());
    const row = await prisma.opsAlert.findFirst({ where: { link: `/skill-reviews/${s.id}`, title: { startsWith: "Reminder" } } });
    assert.ok(row, "80 hours since the first check, target 72: a reminder");
    assert.ok(row.emailedTo.includes("testsuite-notice-web@example.com"));
    assert.ok(!row.emailedTo.includes("testsuite-notice-video@example.com"));
    await prisma.opsAlert.deleteMany({ where: { link: `/skill-reviews/${s.id}` } });
  });

  it("work that already has a result is left alone", async () => {
    const t0 = new Date("2026-11-09T09:00:00Z");
    const s = await seed({ status: "verified", submittedAt: new Date(t0.getTime() - 500 * HOUR), authenticityAt: new Date(t0.getTime() - 400 * HOUR), decidedAt: new Date(t0.getTime() - 300 * HOUR) });
    await notices.sweepWaiting(prisma, t0, deps());
    assert.equal(await prisma.opsAlert.count({ where: { link: { contains: s.id } } }), 0);
  });
});

describe("telling the talent", () => {
  const spy = () => {
    const sent = [];
    return { sent, notifyUser: async (userId, message) => { sent.push({ userId, message }); return { sent: 1 }; } };
  };

  it("says it in plain words and names what changed, so the app can refresh the right screen", async () => {
    const push = spy();
    await notices.tellTalent(ctx.talentA.id, "verified", "web-development", { push });
    await notices.tellTalent(ctx.talentA.id, "not_yet", "web-development", { push });
    await notices.tellTalent(ctx.talentA.id, "checked", "short-form-video", { push });
    await notices.tellTalent(ctx.talentA.id, "needs_change", "web-development", { push });
    assert.deepEqual(push.sent.map((p) => p.message.data), [
      { type: "skill_verified", skillKey: "web-development" },
      { type: "skill_not_yet", skillKey: "web-development" },
      { type: "skill_checked", skillKey: "short-form-video" },
      { type: "skill_needs_change", skillKey: "web-development" },
    ]);
    assert.equal(push.sent[0].message.title, "You're verified in Web development");
    assert.match(push.sent[2].message.body, /two reviewers/);
    for (const p of push.sent) assert.ok(p.message.title.length < 45 && p.message.body.length < 110, "short enough to read on a lock screen");
    assert.ok(push.sent.every((p) => p.userId === ctx.talentA.id));
  });

  it("an unknown kind sends nothing, and a push that fails does not throw", async () => {
    const push = spy();
    assert.equal(await notices.tellTalent(ctx.talentA.id, "banana", "web-development", { push }), null);
    assert.equal(push.sent.length, 0);
    const boom = { notifyUser: async () => { throw new Error("fcm down"); } };
    assert.equal(await notices.tellTalent(ctx.talentA.id, "verified", "web-development", { push: boom }), null);
  });
});
