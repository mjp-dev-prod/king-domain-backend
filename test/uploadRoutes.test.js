// The upload routes over real HTTP: a file that fails the checks is refused BEFORE storage is
// touched, and nothing is recorded. (The test server has storage switched off on purpose, so these
// tests can never write into the real buckets.)
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const { checkUpload } = require("../src/uploads");

let ctx, server, storedServer, storage, ta, ct;
before(async () => {
  ctx = await h.fixtures();
  server = await h.startServer({ port: 4614, paystackUrl: "http://127.0.0.1:9", autoRelease: false });
  // A second server whose storage is a local fake, so an ACCEPTED file can be followed all the way in.
  storage = await h.serveFakeStorage();
  storedServer = await h.startServer({ port: 4615, paystackUrl: "http://127.0.0.1:9", autoRelease: false, storageUrl: storage.url });
  [ta, ct] = await Promise.all([h.tokenFor(ctx.talentA), h.tokenFor(ctx.client)]);
});
after(async () => {
  server?.stop();
  storedServer?.stop();
  storage?.server.close();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

/** multipart POST: text fields plus any number of named files. */
async function send(tok, path, fields, files = {}, base = server.base) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const [name, { buffer, filename, type }] of Object.entries(files)) form.append(name, new Blob([buffer], { type }), filename);
  const r = await fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: form });
  return { status: r.status, json: await r.json().catch(() => null) };
}

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

describe("an ACCEPTED file, followed into storage (against a fake Supabase)", () => {
  it("a delivered PDF is stored as application/pdf in the deliverables bucket and recorded on the contract", async () => {
    const s = await h.seedWorking(ctx);
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]);
    const r = await send(ta, `/jobs/${s.job.id}/contract/submit`, { deliverableNote: "Final files" }, { file: { buffer: pdf, filename: "final.exe", type: "application/x-msdownload" } }, storedServer.base);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const keys = [...storage.objects.keys()].filter((k) => k.startsWith(`deliverables/${s.c.id}/`));
    assert.equal(keys.length, 1);
    assert.match(keys[0], /-final\.pdf$/);
    assert.equal(storage.objects.get(keys[0]).contentType, "application/pdf");
  });
});
