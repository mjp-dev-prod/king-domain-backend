// The upload routes over real HTTP: a file that fails the checks is refused BEFORE storage is
// touched, and nothing is recorded. (The test server has storage switched off on purpose, so these
// tests can never write into the real buckets.)
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const { checkUpload } = require("../src/uploads");

let ctx, server, ta, ct;
before(async () => {
  ctx = await h.fixtures();
  server = await h.startServer({ port: 4614, paystackUrl: "http://127.0.0.1:9", autoRelease: false });
  [ta, ct] = await Promise.all([h.tokenFor(ctx.talentA), h.tokenFor(ctx.client)]);
});
after(async () => {
  server?.stop();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

/** multipart POST: text fields plus any number of named files. */
async function send(tok, path, fields, files = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const [name, { buffer, filename, type }] of Object.entries(files)) form.append(name, new Blob([buffer], { type }), filename);
  const r = await fetch(server.base + path, { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: form });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const proofCount = async () => {
  const profile = await prisma.talentProfile.findUnique({ where: { userId: ctx.talentA.id } });
  return prisma.proofItem.count({ where: { talentProfileId: profile.id } });
};
const proofFields = { category: h.CATEGORY, title: "Upload check" };

describe("POST /users/me/proof-items", () => {
  before(async () => {
    const profile = await prisma.talentProfile.findUnique({ where: { userId: ctx.talentA.id } });
    await prisma.proofItem.deleteMany({ where: { talentProfileId: profile.id } });
  });
  after(async () => {
    const profile = await prisma.talentProfile.findUnique({ where: { userId: ctx.talentA.id } });
    await prisma.proofItem.deleteMany({ where: { talentProfileId: profile.id } });
  });

  it("refuses HTML dressed as a picture (415 unsupported_file) and records nothing", async () => {
    const before = await proofCount();
    const r = await send(ta, "/users/me/proof-items", proofFields, { file: { buffer: HTML, filename: "photo.png", type: "image/png" } });
    assert.equal(r.status, 415, JSON.stringify(r.json));
    assert.equal(r.json.code, "unsupported_file");
    assert.equal(await proofCount(), before);
  });

  it("refuses an empty file (400 empty_file)", async () => {
    const r = await send(ta, "/users/me/proof-items", proofFields, { file: { buffer: Buffer.alloc(0), filename: "a.png", type: "image/png" } });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "empty_file");
  });

  it("refuses a file over 10 MB with 413 file_too_large (not a 500)", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const before = await proofCount();
    const r = await send(ta, "/users/me/proof-items", proofFields, { file: { buffer: big, filename: "big.png", type: "image/png" } });
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "file_too_large");
    assert.match(r.json.error, /10 MB/);
    assert.equal(await proofCount(), before);
  });

  it("refuses more than one file (400 too_many_files)", async () => {
    const r = await send(ta, "/users/me/proof-items", proofFields, {
      file: { buffer: PNG, filename: "a.png", type: "image/png" },
      extra: { buffer: PNG, filename: "b.png", type: "image/png" },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "too_many_files");
  });

  it("still accepts a proof item with no file at all (the file is optional)", async () => {
    const r = await send(ta, "/users/me/proof-items", proofFields);
    assert.equal(r.status, 201, JSON.stringify(r.json));
  });
});

describe("POST /jobs/:id/contract/submit", () => {
  it("refuses a bad file, and the contract stays in progress with no delivery recorded", async () => {
    const s = await h.seedWorking(ctx);
    const r = await send(ta, `/jobs/${s.job.id}/contract/submit`, { deliverableNote: "Final files" }, { file: { buffer: HTML, filename: "final.png", type: "image/png" } });
    assert.equal(r.status, 415, JSON.stringify(r.json));
    assert.equal(r.json.code, "unsupported_file");
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).status, "inProgress");
    assert.equal(await prisma.contractDelivery.count({ where: { contractId: s.c.id } }), 0);
  });

  it("an oversize delivery is 413, and a note-only delivery still works", async () => {
    const s = await h.seedWorking(ctx);
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const tooBig = await send(ta, `/jobs/${s.job.id}/contract/submit`, { deliverableNote: "Final files" }, { file: { buffer: big, filename: "big.png", type: "image/png" } });
    assert.equal(tooBig.status, 413);
    const ok = await send(ta, `/jobs/${s.job.id}/contract/submit`, { deliverableNote: "Here is the work, link in the note" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });
});

describe("checkUpload (the step between reading the file and storing it)", () => {
  const run = (file) => {
    const req = { file };
    let sent = null;
    let nexted = false;
    const res = { status(c) { sent = { status: c }; return this; }, json(b) { sent = { ...sent, body: b }; return this; } };
    checkUpload(req, res, () => { nexted = true; });
    return { req, sent, nexted };
  };

  it("a good file continues with the REAL type and a cleaned name, ignoring what the client claimed", () => {
    const { req, nexted, sent } = run({ buffer: PNG, originalname: "../my holiday.JPG", mimetype: "text/html" });
    assert.equal(nexted, true);
    assert.equal(sent, null);
    assert.equal(req.upload.contentType, "image/png");
    assert.equal(req.upload.fileName, "my_holiday.png");
  });

  it("no file continues untouched", () => {
    const { req, nexted } = run(undefined);
    assert.equal(nexted, true);
    assert.equal(req.upload, undefined);
  });

  it("a bad file is answered here and never continues", () => {
    const { nexted, sent } = run({ buffer: HTML, originalname: "x.png", mimetype: "image/png" });
    assert.equal(nexted, false);
    assert.equal(sent.status, 415);
    assert.equal(sent.body.code, "unsupported_file");
  });
});
