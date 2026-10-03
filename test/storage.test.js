const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { apkKey } = require("../src/storage");

describe("release APK keys (staging shares the production bucket)", () => {
  it("production, with no prefix, keeps the key it has always used", () => {
    assert.equal(apkKey("1.3.0", ""), "king-domain-1.3.0.apk");
  });

  it("staging's prefix keeps its APKs apart from production's", () => {
    assert.equal(apkKey("1.3.0", "staging/"), "staging/king-domain-1.3.0.apk");
    assert.notEqual(apkKey("1.3.0", "staging/"), apkKey("1.3.0", ""));
  });

  it("a malformed prefix is refused rather than silently writing somewhere odd", () => {
    for (const bad of ["staging", "/staging/", "../", "Staging/", "a b/"]) {
      assert.throws(() => apkKey("1.3.0", bad), /R2_APK_PREFIX/, bad);
    }
  });
});
