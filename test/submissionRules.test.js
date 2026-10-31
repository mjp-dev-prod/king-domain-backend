// Pure rules, no database.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../src/submissionRules");
const { rubricFor, RUBRICS } = require("../src/rubrics");
const { SKILLS } = require("../src/skills");

const rubric = rubricFor("short-form-video");
const allScores = (n) => Object.fromEntries(rubric.lines.map((l) => [l.key, n]));

describe("rubrics", () => {
  it("every launch skill has one, flagged as a draft until a practitioner has worked on it", () => {
    for (const s of SKILLS) {
      const r = RUBRICS[s.key];
      assert.ok(r, `${s.key} has a rubric`);
      assert.equal(r.draft, true);
      assert.ok(r.lines.length >= 6);
      assert.equal(new Set(r.lines.map((l) => l.key)).size, r.lines.length, "line keys are unique");
    }
  });
});

describe("validateReview", () => {
  it("accepts a full set of scores with a verdict", () => {
    const r = rules.validateReview({ scores: allScores(3), verdict: "pass", comment: "" }, rubric);
    assert.equal(r.ok, true);
  });

  it("refuses a pass with any line below the standard", () => {
    const scores = { ...allScores(3), sound: 1 };
    const r = rules.validateReview({ scores, verdict: "pass" }, rubric);
    assert.equal(r.ok, false);
    assert.match(r.error, /below the standard/);
  });

  it("refuses missing, out-of-range, non-integer and unknown scores", () => {
    const missing = allScores(3);
    delete missing.sound;
    assert.equal(rules.validateReview({ scores: missing, verdict: "pass" }, rubric).ok, false);
    assert.equal(rules.validateReview({ scores: { ...allScores(3), sound: 5 }, verdict: "pass" }, rubric).ok, false);
    assert.equal(rules.validateReview({ scores: { ...allScores(3), sound: 2.5 }, verdict: "pass" }, rubric).ok, false);
    assert.equal(rules.validateReview({ scores: { ...allScores(3), extra: 3 }, verdict: "pass" }, rubric).ok, false);
    assert.equal(rules.validateReview({ scores: allScores(3), verdict: "maybe" }, rubric).ok, false);
  });

  it("a not-yet needs a comment saying what to fix", () => {
    assert.equal(rules.validateReview({ scores: { ...allScores(3), sound: 1 }, verdict: "notYet", comment: "short" }, rubric).ok, false);
    assert.equal(rules.validateReview({ scores: { ...allScores(3), sound: 1 }, verdict: "notYet", comment: "Dialogue is hard to hear." }, rubric).ok, true);
  });
});

describe("decide", () => {
  const v = (...verdicts) => verdicts.map((verdict) => ({ verdict }));
  it("waits for two reviews", () => {
    assert.deepEqual(rules.decide([]), { state: "waiting", needed: 2 });
    assert.deepEqual(rules.decide(v("pass")), { state: "waiting", needed: 1 });
  });
  it("two that agree decide it", () => {
    assert.deepEqual(rules.decide(v("pass", "pass")), { state: "decided", outcome: "verified", needed: 0 });
    assert.deepEqual(rules.decide(v("notYet", "notYet")), { state: "decided", outcome: "notYet", needed: 0 });
  });
  it("two that disagree need a third, and the majority of three decides", () => {
    assert.deepEqual(rules.decide(v("pass", "notYet")), { state: "needThird", needed: 1 });
    assert.equal(rules.decide(v("pass", "notYet", "pass")).outcome, "verified");
    assert.equal(rules.decide(v("pass", "notYet", "notYet")).outcome, "notYet");
  });
});

describe("reasonsFor", () => {
  it("lists the lines the not-yet reviewers scored 2 or lower with their lowest score, and their comments, and nothing about who they are", () => {
    const reviews = [
      { verdict: "notYet", scores: { ...allScores(3), sound: 1, text: 2 }, comment: "Dialogue is buried.", reviewerId: "a" },
      { verdict: "pass", scores: { ...allScores(3), pacing: 1 }, comment: "ignored: this reviewer passed it", reviewerId: "b" },
      { verdict: "notYet", scores: { ...allScores(3), sound: 2 }, comment: "Music too loud.", reviewerId: "c" },
    ];
    const r = rules.reasonsFor(reviews, rubric);
    assert.deepEqual(r.lines.map((l) => [l.key, l.score]), [["sound", 1], ["text", 2]], "in rubric order; the reviewer who passed it is ignored");
    assert.deepEqual(r.comments, ["Dialogue is buried.", "Music too loud."]);
    assert.ok(!JSON.stringify(r).includes("reviewerId"));
  });
});

describe("penalties for resending rejected work", () => {
  it("2 months first, 3 months after", () => {
    assert.equal(rules.restrictionMonths(0), 2);
    assert.equal(rules.restrictionMonths(1), 3);
    assert.equal(rules.restrictionMonths(4), 3);
    assert.equal(rules.addMonths("2026-11-30T00:00:00Z", 2).toISOString().slice(0, 7), "2027-01");
  });

  it("is a repeat only when every finished file was in an earlier not-yet attempt", () => {
    assert.equal(rules.isRepeatOfRejected(["a", "b"], ["a", "b", "c"]), true);
    assert.equal(rules.isRepeatOfRejected(["a", "z"], ["a", "b"]), false, "one new file means changed work");
    assert.equal(rules.isRepeatOfRejected([], ["a"]), false);
    assert.equal(rules.isRepeatOfRejected(["a"], []), false);
  });
});

describe("readiness", () => {
  const file = (role) => ({ role, status: "ready" });
  const piece = (over = {}) => ({ title: "Reel", brief: "A 20s promo", role: "Editor", madeOn: "March 2026", liveLink: "", files: [file("output")], ...over });
  const sub = (over = {}) => ({ pieces: [piece({ files: [file("output"), file("working"), file("draft")] }), piece()], files: [file("walkthrough")], declaredOwnWork: true, aiUsed: false, ...over });

  it("is ready when everything is there", () => {
    const r = rules.readiness(sub(), { hadEarlierAttempt: false });
    assert.equal(r.ready, true);
  });

  it("says exactly what is missing", () => {
    const r = rules.readiness(sub({ pieces: [piece()], files: [], declaredOwnWork: false }), { hadEarlierAttempt: false });
    const missing = r.items.filter((i) => !i.done).map((i) => i.key);
    assert.deepEqual(missing, ["pieces", "working", "drafts", "walkthrough", "declaration"]);
  });

  it("a live link counts as the finished work, a declared AI use needs a note, and a second attempt needs the terms", () => {
    const linked = piece({ files: [], liveLink: "https://example.com/reel" });
    const r = rules.readiness(sub({ pieces: [linked, piece({ files: [file("output"), file("working"), file("draft")] })], aiUsed: true, aiNote: "" }), { hadEarlierAttempt: true });
    assert.equal(r.items.find((i) => i.key === "outputs").done, true);
    assert.equal(r.items.find((i) => i.key === "declaration").done, false);
    assert.equal(r.items.find((i) => i.key === "terms").done, false);
    assert.equal(r.ready, false);
  });
});
