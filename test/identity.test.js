// Pure rules, no database.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const id = require("../src/identity");

describe("NIN", () => {
  it("is exactly eleven digits", () => {
    assert.equal(id.isNin("12345678901"), true);
    assert.equal(id.isNin(" 12345678901 "), true);
    assert.equal(id.isNin("1234567890"), false);
    assert.equal(id.isNin("123456789012"), false);
    assert.equal(id.isNin("1234567890a"), false);
    assert.equal(id.isNin(12345678901), false);
  });
});

describe("age", () => {
  it("counts whole years and flips at the birthday", () => {
    const at = new Date("2026-11-01T12:00:00Z");
    assert.equal(id.ageOn("2008-11-01", at), 18, "birthday today");
    assert.equal(id.ageOn("2008-11-02", at), 17, "birthday tomorrow");
    assert.equal(id.ageOn("2008-10-31", at), 18);
    assert.equal(id.isMinor("2010-06-15", at), true);
    assert.equal(id.isMinor("2008-11-01", at), false);
    assert.equal(id.isMinor(null, at), false, "no date of birth is not treated as a minor");
  });
});

describe("namesMatch", () => {
  it("ignores order, case, accents, punctuation and a missing middle name", () => {
    assert.equal(id.namesMatch("Ada Obi", "OBI ADA"), true);
    assert.equal(id.namesMatch("Adaeze Chioma Obi", "Adaeze Obi"), true);
    assert.equal(id.namesMatch("Ayọ Balogun", "Ayo Balogun"), true);
    assert.equal(id.namesMatch("Ada C. Obi", "Ada Chioma Obi"), true);
  });

  it("refuses a different surname, a single word, or an extra unrelated word", () => {
    assert.equal(id.namesMatch("Ada Obi", "Ada Okafor"), false);
    assert.equal(id.namesMatch("Ada", "Ada Obi"), false);
    assert.equal(id.namesMatch("Ada Obi", ""), false);
    assert.equal(id.namesMatch("Ada Obi Jide", "Ada Obi Kunle"), false);
  });
});

describe("identityState", () => {
  const at = new Date("2026-11-01T12:00:00Z");
  it("is notStarted, inReview or notYet before verification, and never transacts", () => {
    assert.deepEqual(id.identityState({ latestCheckStatus: undefined }, at), { status: "notStarted", minor: false, guardianNeeded: false, canTransact: false });
    assert.equal(id.identityState({ latestCheckStatus: "pending" }, at).status, "inReview");
    assert.equal(id.identityState({ latestCheckStatus: "notYet" }, at).status, "notYet");
  });

  it("an adult verified person can transact", () => {
    const s = id.identityState({ identityVerifiedAt: at, dateOfBirth: "2000-01-01" }, at);
    assert.deepEqual(s, { status: "verified", minor: false, guardianNeeded: false, canTransact: true });
  });

  it("a verified minor needs the guardian before transacting", () => {
    const waiting = id.identityState({ identityVerifiedAt: at, dateOfBirth: "2010-01-01" }, at);
    assert.equal(waiting.guardianNeeded, true);
    assert.equal(waiting.canTransact, false);
    const ok = id.identityState({ identityVerifiedAt: at, dateOfBirth: "2010-01-01", guardianConfirmedAt: at }, at);
    assert.equal(ok.canTransact, true);
  });
});
