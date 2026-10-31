// Pure module test, no database.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const skills = require("../src/skills");

describe("skill catalogue", () => {
  it("has exactly the five launch skills from the PRD, all open", () => {
    assert.deepEqual(
      skills.SKILLS.map((s) => s.key),
      ["graphic-design", "short-form-video", "social-media", "writing", "web-development"],
    );
    assert.ok(skills.SKILLS.every((s) => s.open === true));
  });

  it("keeps the six existing category labels so old jobs and proof still match", () => {
    assert.deepEqual(skills.CATEGORIES.map((c) => c.label), [
      "Software & tech", "Design & creative", "Writing & content", "Marketing & growth", "Tutoring & training", "Video & media",
    ]);
    for (const s of skills.SKILLS) {
      assert.ok(skills.CATEGORIES.some((c) => c.key === s.category), `${s.key} points at a real category`);
    }
  });

  it("gives every skill a start-proof format with sane bounds", () => {
    const kinds = new Set(["files", "image", "video", "text", "link"]);
    for (const s of skills.SKILLS) {
      assert.ok(s.startProof.length >= 1, `${s.key} has a start proof`);
      for (const f of s.startProof) {
        assert.ok(kinds.has(f.kind), `${s.key}.${f.key} kind`);
        assert.ok(f.min >= 1 && f.max >= f.min, `${s.key}.${f.key} bounds`);
      }
    }
    assert.deepEqual(skills.skillByKey("short-form-video").startProof.map((f) => f.key), ["roughCut", "timeline"]);
  });

  it("looks skills up by key and refuses unknown keys", () => {
    assert.equal(skills.skillByKey("writing").label, "Writing");
    assert.equal(skills.skillByKey("nope"), null);
    assert.equal(skills.isSkillKey("writing"), true);
    assert.equal(skills.isSkillKey(""), false);
  });
});
