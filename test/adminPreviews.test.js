// Queue rows carry a small preview of the work (admin redesign plan, step 5), so a reviewer can tell what a row is before
// opening it. Real HTTP, a fake private R2 bucket, and rows written straight to the database.
//
// The rules under test:
//   - the preview is the first finished-work file of the first piece, as { kind, name, pieceTitle, url } (or null);
//   - a link-only piece shows the link's host, never the full address;
//   - nothing in a row is ever another person's file;
//   - with no private storage the preview stays but its url is null.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const h = require("./helpers");
const { prisma } = h;

const SKILL = "short-form-video";
let ctx, provider, r2, server, bare, checker, reader, checkerTok, readerTok;
const admins = [];

before(async () => {
  ctx = await h.fixtures();
  provider = await h.serveFakeProvider(h.fakeProvider());
  r2 = await h.serveFakeR2();
  server = await h.startServer({
    port: 4731,
    paystackUrl: provider.url,
    autoRelease: false,
    env: { R2_ACCOUNT_ID: "test", R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_PRIVATE_BUCKET: "private-test", R2_ENDPOINT: r2.url },
  });
  // The same app with private storage not set up: previews keep their shape but have no link.
  bare = await h.startServer({ port: 4732, paystackUrl: provider.url, autoRelease: false });
  checker = await h.ensureAdmin("testsuite-previews-checker@example.com", { capabilities: ["checker"] });
  reader = await h.ensureAdmin("testsuite-previews-reader@example.com", { capabilities: ["reviewer"], reviewerSkills: [SKILL] });
  admins.push(checker, reader);
  [checkerTok, readerTok] = await Promise.all([h.adminTokenFor(checker), h.adminTokenFor(reader)]);
  await reset();
});

after(async () => {
  server?.stop();
  bare?.stop();
  r2?.server.close();
  provider?.server.close();
  await reset();
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: { in: admins.map((a) => a.id) } } });
  await prisma.$disconnect();
});

async function reset() {
  await prisma.skillSubmission.deleteMany({ where: { userId: { in: [ctx.talentA.id, ctx.talentB.id] } } });
}

const get = (base, tok, p) => h.call(base, tok, "GET", p);
const T0 = Date.parse("2026-11-01T10:00:00Z");

/**
 * A submission written straight to the database. pieces: [{ title, liveLink, processLink, files: [{ name, type, role, status, at }] }].
 * `at` orders files within the piece (earlier is first).
 */
async function seed(user, { status = "authenticity", pieces = [], submittedAt = new Date(T0) } = {}) {
  const s = await prisma.skillSubmission.create({
    data: { userId: user.id, skillKey: SKILL, status, submittedAt, authenticityAt: submittedAt },
  });
  for (const [i, p] of pieces.entries()) {
    const piece = await prisma.submissionPiece.create({
      data: { submissionId: s.id, position: i, title: p.title ?? "", liveLink: p.liveLink ?? "", processLink: p.processLink ?? "" },
    });
    for (const [j, f] of (p.files ?? []).entries()) await addFile(s.id, piece.id, f, j);
  }
  return s;
}

function addFile(submissionId, pieceId, f, j = 0) {
  return prisma.submissionFile.create({
    data: {
      submissionId,
      pieceId,
      role: f.role ?? "output",
      name: f.name,
      contentType: f.type ?? "image/png",
      sizeBytes: 2048,
      objectKey: `previews-test/${crypto.randomUUID()}/${f.name}`,
      status: f.status ?? "ready",
      createdAt: new Date(T0 + (f.at ?? j) * 1000),
    },
  });
}

const rowFor = async (base, tok, path, id) => (await get(base, tok, path)).json.submissions.find((r) => r.id === id);
const authRow = (id, base = server.base, tok = checkerTok) => rowFor(base, tok, "/admin/authenticity", id);
const reviewRow = (id) => rowFor(server.base, readerTok, "/admin/skill-reviews", id);

describe("queue previews: the Authenticity list", () => {
  it("an image shows as an image, with the piece title and a short-lived link to that file", async () => {
    const s = await seed(ctx.talentA, { pieces: [{ title: "Salon promo", files: [{ name: "cover.png", type: "image/png" }] }] });
    const row = await authRow(s.id);
    assert.deepEqual(Object.keys(row.preview).sort(), ["kind", "name", "pieceTitle", "url"], "exactly the agreed shape");
    assert.equal(row.preview.kind, "image");
    assert.equal(row.preview.name, "cover.png");
    assert.equal(row.preview.pieceTitle, "Salon promo");
    const u = new URL(row.preview.url);
    assert.equal(u.origin, r2.url, "a link into the private bucket");
    assert.ok(u.pathname.endsWith("/cover.png"));
    assert.ok(u.searchParams.has("X-Amz-Signature"), "signed, so it expires");
  });

  it("a video and a document are named as such", async () => {
    const v = await seed(ctx.talentA, { pieces: [{ title: "Reel", files: [{ name: "reel.mp4", type: "video/mp4" }] }] });
    const d = await seed(ctx.talentA, { pieces: [{ title: "Article", files: [{ name: "story.pdf", type: "application/pdf" }] }] });
    assert.equal((await authRow(v.id)).preview.kind, "video");
    assert.equal((await authRow(d.id)).preview.kind, "document");
  });

  it("a piece with only a link shows the link's host, never the whole address, and has no file link", async () => {
    const s = await seed(ctx.talentA, { pieces: [{ title: "Booking app", liveLink: "https://www.behance.net/gallery/123/Private-Title?token=secret#x" }] });
    const row = await authRow(s.id);
    assert.deepEqual(row.preview, { kind: "link", name: "www.behance.net", pieceTitle: "Booking app", url: null });
    assert.ok(!JSON.stringify(row).includes("secret"), "no part of the address beyond the host leaves the server");
  });

  it("a finished file wins over a link on the same piece", async () => {
    const s = await seed(ctx.talentA, { pieces: [{ title: "Logo", liveLink: "https://example.com/x", files: [{ name: "logo.png" }] }] });
    assert.equal((await authRow(s.id)).preview.kind, "image");
  });

  it("no file and no link, or an address that is not a web link, is null, not an empty object", async () => {
    const none = await seed(ctx.talentA, { pieces: [{ title: "Empty" }] });
    const nothing = await seed(ctx.talentA, {});
    const junk = await seed(ctx.talentA, { pieces: [{ title: "Odd", liveLink: "javascript:alert(1)" }] });
    assert.equal((await authRow(none.id)).preview, null);
    assert.equal((await authRow(nothing.id)).preview, null, "a submission with no pieces at all");
    assert.equal((await authRow(junk.id)).preview, null, "only http and https addresses are ever shown");
  });

  it("only finished work counts: working files, drafts, the walkthrough and unfinished uploads are never the preview", async () => {
    const s = await seed(ctx.talentA, {
      pieces: [
        {
          title: "Reel",
          files: [
            { name: "working.psd", role: "working", type: "application/octet-stream", at: 0 },
            { name: "draft.png", role: "draft", at: 1 },
            { name: "half.png", role: "output", status: "pending", at: 2 },
            { name: "final.png", role: "output", at: 3 },
          ],
        },
      ],
    });
    assert.equal((await authRow(s.id)).preview.name, "final.png");
    const onlyOthers = await seed(ctx.talentA, { pieces: [{ title: "Reel", files: [{ name: "working.psd", role: "working" }, { name: "half.png", status: "pending" }] }] });
    assert.equal((await authRow(onlyOthers.id)).preview, null);
  });

  it("the first piece and its earliest finished file are the preview, whatever order they were written in", async () => {
    const s = await seed(ctx.talentA, {
      pieces: [
        { title: "First piece", files: [{ name: "b-later.png", at: 20 }, { name: "a-first.png", at: 5 }] },
        { title: "Second piece", files: [{ name: "z.png", at: 0 }] },
      ],
    });
    const row = await authRow(s.id);
    assert.equal(row.preview.pieceTitle, "First piece");
    assert.equal(row.preview.name, "a-first.png");
  });

  it("with private storage not set up the preview stays and only its link is null", async () => {
    const s = await seed(ctx.talentA, { pieces: [{ title: "Salon promo", files: [{ name: "cover.png" }] }] });
    const tok = await h.adminTokenFor(checker);
    const row = await authRow(s.id, bare.base, tok);
    assert.deepEqual(row.preview, { kind: "image", name: "cover.png", pieceTitle: "Salon promo", url: null });
  });

  it("the row keeps what it had, so the existing screen is unaffected", async () => {
    const s = await seed(ctx.talentA, { pieces: [{ title: "Salon promo", files: [{ name: "cover.png" }] }] });
    const row = await authRow(s.id);
    assert.equal(row.skillKey, SKILL);
    assert.ok(row.skillLabel);
    assert.equal(row.repeatOfRejected, false);
    assert.equal(row.person.name, ctx.talentA.fullName);
    assert.ok(row.submittedAt);
  });
});

describe("queue previews: never another person's file", () => {
  it("each row shows its own person's work, with many people in one list", async () => {
    await reset();
    const a = await seed(ctx.talentA, { pieces: [{ title: "A's piece", files: [{ name: "a-work.png" }] }] });
    const b = await seed(ctx.talentB, { pieces: [{ title: "B's piece", files: [{ name: "b-work.mp4", type: "video/mp4" }] }] });
    const list = (await get(server.base, checkerTok, "/admin/authenticity")).json.submissions;
    const rowA = list.find((r) => r.id === a.id);
    const rowB = list.find((r) => r.id === b.id);
    assert.equal(rowA.preview.name, "a-work.png");
    assert.equal(rowB.preview.name, "b-work.mp4");
    assert.ok(rowA.preview.url.includes("a-work.png") && !rowA.preview.url.includes("b-work"));
    assert.ok(rowB.preview.url.includes("b-work.mp4") && !rowB.preview.url.includes("a-work"));
    assert.ok(!JSON.stringify(rowA).includes("b-work") && !JSON.stringify(rowB).includes("a-work"));
  });

  it("a file that belongs to another submission is ignored even if it is attached to this one's piece", async () => {
    await reset();
    const a = await seed(ctx.talentA, { pieces: [{ title: "A's piece", files: [{ name: "a-work.png" }] }] });
    const b = await seed(ctx.talentB, { pieces: [{ title: "B's piece", files: [{ name: "b-own.png", at: 50 }] }] });
    // A stray row: A's file hung on B's piece, and older than B's own, so a careless query would pick it first.
    const bPiece = await prisma.submissionPiece.findFirst({ where: { submissionId: b.id } });
    await addFile(a.id, bPiece.id, { name: "a-stray.png", at: 0 });
    const rowB = await authRow(b.id);
    assert.equal(rowB.preview.name, "b-own.png");
    assert.ok(!JSON.stringify(rowB).includes("a-stray"));
  });

  it("with only a stray file on its piece, the row has no preview rather than someone else's", async () => {
    await reset();
    const a = await seed(ctx.talentA, { pieces: [{ title: "A's piece", files: [{ name: "a-work.png" }] }] });
    const b = await seed(ctx.talentB, { pieces: [{ title: "B's piece" }] });
    const bPiece = await prisma.submissionPiece.findFirst({ where: { submissionId: b.id } });
    await addFile(a.id, bPiece.id, { name: "a-stray.png" });
    assert.equal((await authRow(b.id)).preview, null);
  });
});

describe("queue previews: the Skill reviews list", () => {
  it("carries the same preview, and still shows reviewers no person", async () => {
    await reset();
    const s = await seed(ctx.talentA, { status: "review", pieces: [{ title: "Salon promo", files: [{ name: "cover.png" }] }] });
    const row = await reviewRow(s.id);
    assert.equal(row.preview.kind, "image");
    assert.equal(row.preview.name, "cover.png");
    assert.equal(row.preview.pieceTitle, "Salon promo");
    assert.ok(row.preview.url.includes("cover.png"));
    assert.equal(row.person, undefined, "reviewers judge the work blind");
    assert.ok(!JSON.stringify(row).includes(ctx.talentA.fullName));
    assert.equal(row.pieces, 1, "the existing fields are still there");
  });

  it("is null for a submission with nothing to show, and link-only works here too", async () => {
    await reset();
    const empty = await seed(ctx.talentA, { status: "review", pieces: [{ title: "Empty" }] });
    const link = await seed(ctx.talentA, { status: "review", pieces: [{ title: "Site", liveLink: "https://shop.example.ng/a?b=c" }] });
    assert.equal((await reviewRow(empty.id)).preview, null);
    assert.deepEqual((await reviewRow(link.id)).preview, { kind: "link", name: "shop.example.ng", pieceTitle: "Site", url: null });
  });

  it("still lists only what this reviewer may review", async () => {
    await reset();
    const mine = await seed(ctx.talentA, { status: "review", pieces: [{ title: "Mine", files: [{ name: "m.png" }] }] });
    const other = await prisma.skillSubmission.create({ data: { userId: ctx.talentB.id, skillKey: "writing", status: "review", submittedAt: new Date(T0), authenticityAt: new Date(T0) } });
    const ids = (await get(server.base, readerTok, "/admin/skill-reviews")).json.submissions.map((r) => r.id);
    assert.ok(ids.includes(mine.id));
    assert.ok(!ids.includes(other.id), "a skill this reviewer does not hold is not listed");
  });
});
