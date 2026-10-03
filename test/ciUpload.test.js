// The CI direct-to-R2 upload handshake (src/app/ciUploadRoutes.js). The storage
// is a fake, so these tests never touch the real R2 bucket; releases are real
// rows in the test database.
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const h = require("./helpers");
const { prisma } = h;
const { buildCiUploadRouter, MIN_APK_BYTES } = require("../src/app/ciUploadRoutes");

const TOKEN = "test-ci-token";
const V = (n) => `9.9.${n}-citest`;
let server, base, stored, issued;

const fakeStorage = {
  async presignApkUpload({ version }) {
    issued.push(version);
    return { uploadUrl: `https://r2.test/put/${version}?sig=1`, key: `staging/king-domain-${version}.apk`, apkUrl: `https://cdn.test/staging/king-domain-${version}.apk`, contentType: "application/vnd.android.package-archive", expiresInSeconds: 900 };
  },
  async apkObjectSize({ version }) {
    return version in stored ? stored[version] : null;
  },
  apkPublicUrl: (version) => `https://cdn.test/staging/king-domain-${version}.apk`,
};

before(async () => {
  process.env.CI_API_TOKEN = TOKEN;
  const app = express();
  app.use("/app", buildCiUploadRouter({ prisma, storage: fakeStorage }));
  await new Promise((resolve) => (server = app.listen(4613, "127.0.0.1", resolve)));
  base = "http://127.0.0.1:4613/app";
});
after(async () => {
  server?.close();
  await prisma.appRelease.deleteMany({ where: { version: { endsWith: "-citest" } } });
  await prisma.$disconnect();
});
beforeEach(async () => {
  stored = {};
  issued = [];
  await prisma.appRelease.deleteMany({ where: { version: { endsWith: "-citest" } } });
});

const call = (path, token = TOKEN) =>
  fetch(`${base}${path}`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, json: await r.json() }));
const draft = (n, extra = {}) => prisma.appRelease.create({ data: { version: V(n), status: "draft", ...extra } });

describe("CI direct upload", () => {
  it("needs the CI token on both steps", async () => {
    await draft(1);
    for (const path of [`/release/${V(1)}/upload-url`, `/release/${V(1)}/complete`]) {
      assert.equal((await call(path, null)).status, 401, `${path} without a token`);
      assert.equal((await call(path, "wrong")).status, 401, `${path} with a wrong token`);
    }
    assert.deepEqual(issued, [], "no link is issued to an unauthorised caller");
  });

  it("upload-url: a link for a draft, nothing changed on the release yet", async () => {
    await draft(2);
    const r = await call(`/release/${V(2)}/upload-url`);
    assert.equal(r.status, 200);
    assert.match(r.json.uploadUrl, /^https:\/\/r2\.test\/put\//);
    assert.equal(r.json.expiresInSeconds, 900);
    assert.equal((await prisma.appRelease.findUnique({ where: { version: V(2) } })).apkUrl, null);
  });

  it("refuses an unknown version (404) and a published release (400)", async () => {
    assert.equal((await call(`/release/${V(3)}/upload-url`)).status, 404);
    await draft(4, { status: "published" });
    assert.equal((await call(`/release/${V(4)}/upload-url`)).status, 400);
    assert.equal((await call(`/release/${V(4)}/complete`)).status, 400);
    assert.deepEqual(issued, []);
  });

  it("complete: nothing uploaded, or a file too small to be the APK, is refused and changes nothing", async () => {
    await draft(5);
    assert.equal((await call(`/release/${V(5)}/complete`)).status, 400, "no object");
    stored[V(5)] = 12_345;
    const tiny = await call(`/release/${V(5)}/complete`);
    assert.equal(tiny.status, 400);
    assert.match(tiny.json.error, /too small/);
    assert.equal((await prisma.appRelease.findUnique({ where: { version: V(5) } })).apkUrl, null);
  });

  it("complete: a real-sized file is attached to the draft, which stays a draft", async () => {
    await draft(6);
    stored[V(6)] = 51_433_371;
    const r = await call(`/release/${V(6)}/complete`);
    assert.equal(r.status, 200);
    assert.equal(r.json.sizeBytes, 51_433_371);
    const row = await prisma.appRelease.findUnique({ where: { version: V(6) } });
    assert.equal(row.apkUrl, `https://cdn.test/staging/king-domain-${V(6)}.apk`);
    assert.equal(row.status, "draft", "publishing stays a human action");
  });

  it("the size floor is a real number, well under any real APK", () => {
    assert.ok(MIN_APK_BYTES >= 1024 * 1024 && MIN_APK_BYTES < 40 * 1024 * 1024);
  });
});
