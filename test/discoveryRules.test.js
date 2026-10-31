// Pure rules of S3, no database.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const briefs = require("../src/briefs");
const safety = require("../src/safety");
const rules = require("../src/discoveryRules");

const NOW = new Date("2026-11-10T12:00:00Z");
const common = { deliverables: "Edit 3 reels", quantity: 3, formats: "MP4 1080x1920", revisionsIncluded: 2, usageRights: "organic" };
const video = { ...common, durationSeconds: 30, aspectRatio: "9:16", rawFootage: "Google Drive link, shared after award" };

describe("structured brief", () => {
  it("every skill and type has a spec with the common fields", () => {
    for (const skill of ["graphic-design", "short-form-video", "social-media", "writing", "web-development"]) {
      for (const type of briefs.JOB_TYPES) {
        const spec = briefs.briefSpec(skill, type);
        assert.ok(spec, `${skill}/${type}`);
        assert.ok(spec.fields.some((f) => f.key === "deliverables"));
      }
    }
    assert.equal(briefs.briefSpec("nope", "oneDelivery"), null);
    assert.equal(briefs.briefSpec("writing", "contest"), null, "no contests (D1)");
  });

  it("one delivery: the price is what the client typed", () => {
    const r = briefs.validateBrief({ skillKey: "short-form-video", jobType: "oneDelivery", brief: video, price: 25000 });
    assert.equal(r.ok, true);
    assert.equal(r.budget, 25000);
  });

  it("names the first field that is wrong, in plain words", () => {
    const r = briefs.validateBrief({ skillKey: "short-form-video", jobType: "oneDelivery", brief: { ...video, aspectRatio: "2:1" }, price: 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.field, "aspectRatio");
    assert.match(r.error, /choose one/);
    assert.equal(briefs.validateBrief({ skillKey: "short-form-video", jobType: "oneDelivery", brief: { ...video, revisionsIncluded: 5 }, price: 1000 }).field, "revisionsIncluded", "more than 2 change rounds is not a rule we have");
    assert.equal(briefs.validateBrief({ skillKey: "short-form-video", jobType: "oneDelivery", brief: video, price: 0 }).field, "price");
  });

  it("milestones: 2 to 5, and the price is their sum", () => {
    const m = (title, amount, days = 7) => ({ title, amount, days });
    const ok = briefs.validateBrief({ skillKey: "web-development", jobType: "milestones", brief: { ...common, pages: 5, milestones: [m("Design", 30000), m("Build", 70000, 14)] } });
    assert.equal(ok.ok, true);
    assert.equal(ok.budget, 100000);
    assert.equal(briefs.validateBrief({ skillKey: "web-development", jobType: "milestones", brief: { ...common, pages: 5, milestones: [m("One", 1)] } }).field, "milestones");
    assert.equal(briefs.validateBrief({ skillKey: "web-development", jobType: "milestones", brief: { ...common, pages: 5, milestones: [m("A", 5), m("B", -1)] } }).field, "milestones");
  });

  it("monthly: the price is one month, the brief says how many", () => {
    const r = briefs.validateBrief({ skillKey: "social-media", jobType: "monthly", brief: { ...common, platforms: "Instagram", postsPerWeek: 3, months: 3, monthlyScope: "12 posts and a calendar" }, price: 80000 });
    assert.equal(r.ok, true);
    assert.equal(r.budget, 80000);
    assert.equal(r.brief.months, 3);
  });

  it("hourly: the price is the weekly cap, rate times hours", () => {
    const r = briefs.validateBrief({ skillKey: "writing", jobType: "hourly", brief: { ...common, wordCount: 800, tone: "Friendly", hourlyRate: 3000, weeklyCapHours: 10, weeks: 4 } });
    assert.equal(r.ok, true);
    assert.equal(r.budget, 30000);
  });

  it("screening questions: at most 3, each of real length", () => {
    assert.deepEqual(briefs.validateScreeningQuestions(undefined), { ok: true, questions: [] });
    assert.equal(briefs.validateScreeningQuestions(["Have you edited reels before?"]).ok, true);
    assert.equal(briefs.validateScreeningQuestions(["a", "b", "c", "d"]).ok, false);
    assert.equal(briefs.validateScreeningQuestions(["hi"]).ok, false);
  });
});

describe("risk detection", () => {
  const codes = (t) => safety.detectRisk(t).map((f) => f.code);
  it("catches the things D18 names", () => {
    assert.ok(codes("Call me on 08031234567").includes("phone"));
    assert.ok(codes("Reach me: +234 803 123 4567").includes("phone"));
    assert.ok(codes("mail ada at example dot com").length === 0, "spelled-out words are not guessed at");
    assert.ok(codes("write to ada@example.com").includes("email"));
    assert.ok(codes("see https://example.com/job").includes("link"));
    assert.ok(codes("let's talk on WhatsApp").includes("chat_app"));
    assert.ok(codes("I will pay outside the app").includes("outside_payment"));
    assert.ok(codes("a small registration fee first").includes("pay_to_apply"));
    assert.ok(codes("come to my office tomorrow").includes("meet"));
    assert.ok(codes("install setup.apk first").includes("apk"));
  });
  it("leaves an ordinary brief alone", () => {
    assert.deepEqual(safety.detectRisk("Edit three 30-second reels for a hair salon. Captions in English, 9:16."), []);
    assert.deepEqual(safety.detectRisk(""), []);
    assert.deepEqual(safety.detectRisk(undefined), []);
  });
  it("reads every part of a job post a talent will read", () => {
    const text = safety.jobPostText({ title: "Logo", description: "Simple", brief: { clientFiles: "Message me on telegram", milestones: [{ title: "Pay me directly" }] }, screeningQuestions: ["What is your number?"] });
    assert.ok(text.includes("telegram") && text.includes("Pay me directly") && text.includes("What is your number?"));
  });
});

describe("soft cap", () => {
  const openedAt = new Date("2026-11-08T12:00:00Z");
  it("is open under 50 applicants inside 5 days", () => {
    assert.deepEqual(rules.capState({ applicantCount: 10, openedAt, now: NOW }), { paused: false, reason: null, opensLeft: 40 });
  });
  it("pauses at 50 applicants", () => {
    assert.equal(rules.capState({ applicantCount: 50, openedAt, now: NOW }).reason, "applicants");
  });
  it("pauses after 5 days, and reopening restarts the clock", () => {
    assert.equal(rules.capState({ applicantCount: 3, openedAt: new Date("2026-11-05T11:59:00Z"), now: NOW }).reason, "days");
    assert.equal(rules.capState({ applicantCount: 3, openedAt: new Date("2026-11-10T11:00:00Z"), now: NOW }).paused, false);
  });
});

describe("shortlist promise (D24)", () => {
  it("is the 90th percentile of the last 20, in whole hours, and silent until there is enough to say", () => {
    assert.equal(rules.shortlistPromiseHours([4, 5]), null);
    const hours = [3, 4, 4, 5, 5, 6, 6, 7, 8, 30];
    assert.equal(rules.shortlistPromiseHours(hours), 8, "9th of 10 sorted values");
    assert.equal(rules.shortlistPromiseHours([1, 1, 1, 1, 1]), 1);
  });
  it("counts only the 20 most recent (the list is newest first)", () => {
    const recent = Array(20).fill(2);
    assert.equal(rules.shortlistPromiseHours([...recent, 500, 500, 500]), 2);
  });
});

describe("talent facts", () => {
  it("New on King Domain: verified in the last 30 days, no completed job", () => {
    assert.equal(rules.isNewOnPlatform({ firstVerifiedAt: "2026-11-01T00:00:00Z", completedJobs: 0, now: NOW }), true);
    assert.equal(rules.isNewOnPlatform({ firstVerifiedAt: "2026-11-01T00:00:00Z", completedJobs: 1, now: NOW }), false);
    assert.equal(rules.isNewOnPlatform({ firstVerifiedAt: "2026-09-01T00:00:00Z", completedJobs: 0, now: NOW }), false);
    assert.equal(rules.isNewOnPlatform({ firstVerifiedAt: null, completedJobs: 0, now: NOW }), false);
  });
  it("response time shows only after 3 conversations, in buckets", () => {
    assert.equal(rules.responseBucket({ medianMinutes: 10, conversations: 2 }), null);
    assert.equal(rules.responseBucket({ medianMinutes: 45, conversations: 3 }).key, "hour");
    assert.equal(rules.responseBucket({ medianMinutes: 200, conversations: 9 }).key, "hours");
    assert.equal(rules.responseBucket({ medianMinutes: 900, conversations: 9 }).key, "day");
    assert.equal(rules.responseBucket({ medianMinutes: 5000, conversations: 9 }).key, "slow");
    assert.equal(rules.responseBucket({ medianMinutes: null, conversations: 9 }), null);
  });
  it("an invitation lasts 72 hours", () => {
    assert.equal(rules.invitationExpiry(NOW).toISOString(), "2026-11-13T12:00:00.000Z");
  });
});

describe("saved search matching", () => {
  const job = { skillKey: "short-form-video", jobType: "oneDelivery", currency: "NGN", budget: 25000, deliveryDays: 7, title: "Edit reels", description: "For a hair salon" };
  it("an empty search matches everything; each filter narrows", () => {
    assert.equal(rules.matchesSearch({}, job), true);
    assert.equal(rules.matchesSearch({ skillKeys: ["writing"] }, job), false);
    assert.equal(rules.matchesSearch({ skillKeys: ["writing", "short-form-video"] }, job), true);
    assert.equal(rules.matchesSearch({ jobTypes: ["hourly"] }, job), false);
    assert.equal(rules.matchesSearch({ currency: "USD" }, job), false);
    assert.equal(rules.matchesSearch({ budgetMin: 30000 }, job), false);
    assert.equal(rules.matchesSearch({ budgetMax: 20000 }, job), false);
    assert.equal(rules.matchesSearch({ budgetMin: 20000, budgetMax: 30000 }, job), true);
    assert.equal(rules.matchesSearch({ deliveryDaysMax: 5 }, job), false);
    assert.equal(rules.matchesSearch({ query: "SALON" }, job), true);
    assert.equal(rules.matchesSearch({ query: "plumber" }, job), false);
  });
});
