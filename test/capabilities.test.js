// Pure, no database.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const caps = require("../src/admin/capabilities");

const owner = { role: "owner", capabilities: [], reviewerSkills: [] };
const reviewer = { role: "admin", capabilities: ["reviewer"], reviewerSkills: ["writing"] };
const reader = { role: "admin", capabilities: [], reviewerSkills: [] };

function run(mw, admin) {
  let status = 200, body = null, nexted = false;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  mw({ admin }, res, () => { nexted = true; });
  return { status, body, nexted };
}

describe("capabilities", () => {
  it("lists the seven capabilities from decision D43", () => {
    assert.deepEqual(caps.CAPABILITIES, ["reviewer", "checker", "safety", "disputes", "finance", "support", "shareholder"]);
  });

  it("an owner has every capability; others only what they were given", () => {
    assert.equal(caps.hasCapability(owner, "finance"), true);
    assert.equal(caps.hasCapability(reviewer, "reviewer"), true);
    assert.equal(caps.hasCapability(reviewer, "finance"), false);
    assert.equal(caps.hasCapability(reader, "reviewer"), false);
  });

  it("requireCapability lets the right people through and refuses the rest with 403", () => {
    assert.equal(run(caps.requireCapability("reviewer"), reviewer).nexted, true);
    assert.equal(run(caps.requireCapability("reviewer"), owner).nexted, true);
    const refused = run(caps.requireCapability("reviewer", "checker"), reader);
    assert.equal(refused.nexted, false);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, "You don't have access to this.");
  });

  it("a reviewer reviews only their skills; an owner reviews any", () => {
    assert.equal(caps.canReviewSkill(reviewer, "writing"), true);
    assert.equal(caps.canReviewSkill(reviewer, "graphic-design"), false);
    assert.equal(caps.canReviewSkill(owner, "graphic-design"), true);
    assert.equal(caps.canReviewSkill(reader, "writing"), false);
  });
});
