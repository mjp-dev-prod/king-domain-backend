// Profile photos over real HTTP, against a fake Supabase Storage (test/helpers.js serveFakeStorage).
// Rules (docs/features/profile-photos.md in the mobile repo): public, JPG/PNG/WebP only, 5 MB,
// one per person, the type decided by the bytes, never a half-saved state.
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;

let ctx, server, storage, ta, ct;
before(async () => {
  ctx = await h.fixtures();
  storage = await h.serveFakeStorage();
  server = await h.startServer({ port: 4616, paystackUrl: "http://127.0.0.1:9", autoRelease: false, storageUrl: storage.url });
  [ta, ct] = await Promise.all([h.tokenFor(ctx.talentA), h.tokenFor(ctx.client)]);
});
after(async () => {
  server?.stop();
  storage?.server.close();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.user.updateMany({ where: { id: { in: [ctx.talentA.id, ctx.client.id] } }, data: { photoPath: null } });
  await prisma.$disconnect();
});
beforeEach(async () => {
  storage.faults.upload = false;
  storage.faults.remove = false;
  storage.objects.clear();
  await prisma.user.updateMany({ where: { id: { in: [ctx.talentA.id, ctx.client.id] } }, data: { photoPath: null } });
});

const zeros = (n) => Buffer.alloc(n);
const SAMPLE = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), zeros(64)]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), zeros(64)]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), zeros(64)]),
  gif: Buffer.concat([Buffer.from("GIF89a"), zeros(64)]),
  heic: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), zeros(64)]),
  pdf: Buffer.concat([Buffer.from("%PDF-1.7"), zeros(64)]),
  html: Buffer.from("<!doctype html><script>alert(1)</script>"),
};

async function call(method, tok, path, files = {}) {
  const form = new FormData();
  for (const [name, { buffer, filename, type }] of Object.entries(files)) form.append(name, new Blob([buffer], { type }), filename);
  const r = await fetch(server.base + path, {
    method,
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    body: Object.keys(files).length ? form : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const put = (tok, buffer, filename = "me.png", type = "image/png") => call("PUT", tok, "/users/me/photo", { file: { buffer, filename, type } });
const photoPathOf = async (user) => (await prisma.user.findUnique({ where: { id: user.id } })).photoPath;
const publicUrl = (path) => `${storage.url}/storage/v1/object/public/avatars/${path}`;

describe("PUT /users/me/photo: accepting a photo", () => {
  it("stores it in the PUBLIC avatars bucket (created on first use) and returns its public link", async () => {
    storage.buckets.delete("avatars");
    const r = await put(ta, SAMPLE.png);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const path = await photoPathOf(ctx.talentA);
    assert.match(path, new RegExp(`^${ctx.talentA.id}/[0-9a-f-]{36}\\.png$`));
    assert.equal(r.json.user.photoUrl, publicUrl(path));
    assert.equal(storage.buckets.get("avatars")?.public, true, "the bucket must be created public");
    assert.equal(storage.objects.get(`avatars/${path}`).contentType, "image/png");
  });

  it("the public link opens with no sign-in and serves the picture", async () => {
    const r = await put(ta, SAMPLE.png);
    const res = await fetch(r.json.user.photoUrl);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), SAMPLE.png);
  });

  it("JPG, PNG and WebP are accepted, each stored with its real type and extension, whatever the client claimed", async () => {
    for (const [kind, ext, type] of [["jpeg", "jpg", "image/jpeg"], ["png", "png", "image/png"], ["webp", "webp", "image/webp"]]) {
      const r = await put(ta, SAMPLE[kind], "whatever.gif", "text/html");
      assert.equal(r.status, 200, `${kind}: ${JSON.stringify(r.json)}`);
      const path = await photoPathOf(ctx.talentA);
      assert.ok(path.endsWith(`.${ext}`), path);
      assert.equal(storage.objects.get(`avatars/${path}`).contentType, type);
    }
  });

  it("a client can set a photo too", async () => {
    const r = await put(ct, SAMPLE.jpeg, "me.jpg", "image/jpeg");
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, "client");
    assert.ok(r.json.user.photoUrl);
  });

  it("GET /users/me shows it, and is null before one is set", async () => {
    assert.equal((await call("GET", ta, "/users/me")).json.user.photoUrl, null);
    await put(ta, SAMPLE.png);
    const me = await call("GET", ta, "/users/me");
    assert.equal(me.json.user.photoUrl, publicUrl(await photoPathOf(ctx.talentA)));
  });
});

describe("PUT /users/me/photo: replacing", () => {
  it("a new photo replaces the old one: the old object is deleted and the path updated", async () => {
    await put(ta, SAMPLE.png);
    const first = await photoPathOf(ctx.talentA);
    await new Promise((r) => setTimeout(r, 5)); // the path carries a timestamp
    await put(ta, SAMPLE.webp);
    const second = await photoPathOf(ctx.talentA);
    assert.notEqual(second, first);
    assert.equal(storage.objects.has(`avatars/${first}`), false, "old object left behind");
    assert.equal(storage.objects.has(`avatars/${second}`), true);
  });

  it("if deleting the old object fails, the new photo is still saved", async () => {
    await put(ta, SAMPLE.png);
    const first = await photoPathOf(ctx.talentA);
    storage.faults.remove = true;
    await new Promise((r) => setTimeout(r, 5));
    const r = await put(ta, SAMPLE.jpeg, "b.jpg", "image/jpeg");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const second = await photoPathOf(ctx.talentA);
    assert.notEqual(second, first);
    assert.equal(r.json.user.photoUrl, publicUrl(second));
  });

  it("if the new upload fails, nothing changes: the old photo and its path stay", async () => {
    await put(ta, SAMPLE.png);
    const first = await photoPathOf(ctx.talentA);
    storage.faults.upload = true;
    const r = await put(ta, SAMPLE.jpeg, "b.jpg", "image/jpeg");
    assert.equal(r.status, 502);
    assert.equal(r.json.code, "storage_failed");
    assert.equal(await photoPathOf(ctx.talentA), first);
    assert.equal(storage.objects.has(`avatars/${first}`), true);
  });
});

describe("PUT /users/me/photo: refusals", () => {
  it("GIF, HEIC, PDF and HTML are refused (415 unsupported_file) and nothing is stored", async () => {
    for (const kind of ["gif", "heic", "pdf", "html"]) {
      const r = await put(ta, SAMPLE[kind], `x.${kind}`, "image/png");
      assert.equal(r.status, 415, kind);
      assert.equal(r.json.code, "unsupported_file", kind);
      assert.match(r.json.error, /JPG, PNG or WebP/, kind);
    }
    assert.equal(storage.objects.size, 0);
    assert.equal(await photoPathOf(ctx.talentA), null);
  });

  it("an empty file is 400 empty_file; no file at all is 400 file_required", async () => {
    const empty = await put(ta, zeros(0));
    assert.equal(empty.status, 400);
    assert.equal(empty.json.code, "empty_file");
    const none = await call("PUT", ta, "/users/me/photo", {});
    assert.equal(none.status, 400);
    assert.equal(none.json.code, "file_required");
  });

  it("over 5 MB is 413 file_too_large, and a second file is 400 too_many_files", async () => {
    const big = Buffer.concat([SAMPLE.png, zeros(5 * 1024 * 1024)]);
    const r = await put(ta, big);
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "file_too_large");
    assert.match(r.json.error, /5 MB/);
    const two = await call("PUT", ta, "/users/me/photo", {
      file: { buffer: SAMPLE.png, filename: "a.png", type: "image/png" },
      extra: { buffer: SAMPLE.png, filename: "b.png", type: "image/png" },
    });
    assert.equal(two.status, 400);
    assert.equal(two.json.code, "too_many_files");
  });

  it("signing in is required", async () => {
    assert.equal((await put(null, SAMPLE.png)).status, 401);
  });
});

describe("DELETE /users/me/photo", () => {
  it("removes the object and clears the path; doing it again is fine", async () => {
    await put(ta, SAMPLE.png);
    const path = await photoPathOf(ctx.talentA);
    const r = await call("DELETE", ta, "/users/me/photo");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.user.photoUrl, null);
    assert.equal(await photoPathOf(ctx.talentA), null);
    assert.equal(storage.objects.has(`avatars/${path}`), false);
    assert.equal((await call("DELETE", ta, "/users/me/photo")).status, 200);
  });

  it("clears the photo even if storage can't delete the file (the leftover is only logged)", async () => {
    await put(ta, SAMPLE.png);
    storage.faults.remove = true;
    const r = await call("DELETE", ta, "/users/me/photo");
    assert.equal(r.status, 200);
    assert.equal(r.json.user.photoUrl, null);
    assert.equal(await photoPathOf(ctx.talentA), null);
  });
});

describe("where a photo appears", () => {
  const seedJob = () =>
    prisma.job.create({ data: { clientId: ctx.client.id, title: `${h.TITLE_PREFIX}photo`, category: h.CATEGORY, description: "d", budget: 1000, deliveryDays: 5 } });

  it("on the job's client, for a talent browsing the feed", async () => {
    await put(ct, SAMPLE.jpeg, "c.jpg", "image/jpeg");
    const job = await seedJob();
    const feed = await call("GET", ta, "/jobs");
    const mine = feed.json.jobs.find((j) => j.id === job.id);
    assert.equal(mine.client.photoUrl, publicUrl(await photoPathOf(ctx.client)));
  });

  it("on each applicant, for the client reviewing them (null for one without a photo)", async () => {
    await put(ta, SAMPLE.png);
    const job = await seedJob();
    await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentA.id } });
    await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentB.id } });
    const r = await call("GET", ct, `/jobs/${job.id}/applications`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const byId = Object.fromEntries(r.json.applications.map((a) => [a.talent.id, a.talent.photoUrl]));
    assert.equal(byId[ctx.talentA.id], publicUrl(await photoPathOf(ctx.talentA)));
    assert.equal(byId[ctx.talentB.id], null);
  });
});

describe("simultaneous changes", () => {
  it("two photos set at once: both requests succeed and exactly one file is left, the one the account points at", async () => {
    for (let round = 0; round < 4; round++) {
      storage.objects.clear();
      await prisma.user.update({ where: { id: ctx.talentA.id }, data: { photoPath: null } });
      const [a, b] = await Promise.all([put(ta, SAMPLE.png), put(ta, SAMPLE.jpeg, "b.jpg", "image/jpeg")]);
      assert.equal(a.status, 200, `round ${round}: ${JSON.stringify(a.json)}`);
      assert.equal(b.status, 200, `round ${round}: ${JSON.stringify(b.json)}`);
      const mine = [...storage.objects.keys()].filter((k) => k.startsWith(`avatars/${ctx.talentA.id}/`));
      assert.equal(mine.length, 1, `round ${round}: ${mine.join(", ")}`);
      assert.equal(mine[0], `avatars/${await photoPathOf(ctx.talentA)}`, `round ${round}: the account points at a file that is not there`);
    }
  });
});
