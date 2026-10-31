// S1 over real HTTP: region and education, the identity submission and the checker, the guardian,
// the paid-action gate and the payout name match. Storage is a local fake so no real bucket is touched.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;

let ctx, server, gated, storage, fake, provider, ta, tc, checkerTok, readerTok, checker, reader;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

before(async () => {
  ctx = await h.fixtures();
  provider = h.fakeProvider();
  fake = await h.serveFakeProvider(provider);
  storage = await h.serveFakeStorage();
  server = await h.startServer({ port: 4631, paystackUrl: fake.url, autoRelease: false, storageUrl: storage.url, env: { PUBLIC_API_URL: "http://127.0.0.1:4631", IDENTITY_SUBMIT_LIMIT: "100", GUARDIAN_INVITE_LIMIT: "100" } });
  gated = await h.startServer({ port: 4632, paystackUrl: fake.url, autoRelease: false, storageUrl: storage.url, env: { IDENTITY_REQUIRED: "true" } });
  checker = await h.ensureAdmin("testsuite-checker@example.com", { capabilities: ["checker"] });
  reader = await h.ensureAdmin("testsuite-reader@example.com");
  [ta, tc, checkerTok, readerTok] = await Promise.all([h.tokenFor(ctx.talentA), h.tokenFor(ctx.client), h.adminTokenFor(checker), h.adminTokenFor(reader)]);
  await reset();
});
after(async () => {
  server?.stop();
  gated?.stop();
  storage?.server.close();
  fake?.server.close();
  await reset();
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: checker.id } });
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});

async function reset() {
  const ids = [ctx.talentA.id, ctx.client.id];
  await prisma.identityCheck.deleteMany({ where: { userId: { in: ids } } });
  await prisma.guardianConsent.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.updateMany({
    where: { id: { in: ids } },
    data: { country: null, state: null, city: null, educationKind: null, educationSchool: null, educationDetail: null, clientKind: null, legalName: null, dateOfBirth: null, identityVerifiedAt: null, guardianConfirmedAt: null },
  });
}

const json = (base, tok, method, p, body) => h.call(base, tok, method, p, body);
async function send(base, tok, path, fields, files = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const [name, { buffer, filename, type }] of Object.entries(files)) form.append(name, new Blob([buffer], { type }), filename);
  const r = await fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: form });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const fields = (over = {}) => ({ document: "ninSlip", documentNumber: "12345678901", fullName: "Suite Talent", dateOfBirth: "2000-03-04", ...over });
const files = () => ({ document: { buffer: PNG, filename: "slip.png", type: "image/png" }, video: { buffer: MP4, filename: "me.mp4", type: "video/mp4" } });
const submit = (over, f = files()) => send(server.base, ta, "/users/me/identity", fields(over), f);

describe("PATCH /users/me/region-education", () => {
  it("saves a student's region and education line", async () => {
    const r = await json(server.base, ta, "PATCH", "/users/me/region-education", { country: "Nigeria", state: "Lagos", city: "Yaba", educationKind: "student", educationSchool: "UNILAG", educationDetail: "2026/27" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.region, { country: "Nigeria", state: "Lagos", city: "Yaba" });
    assert.deepEqual(r.json.education, { kind: "student", school: "UNILAG", detail: "2026/27" });
  });

  it("self-taught needs no school; a student without one is refused; a missing state in Nigeria is refused", async () => {
    const ok = await json(server.base, ta, "PATCH", "/users/me/region-education", { country: "Nigeria", state: "Lagos", educationKind: "selfTaught" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.education.school, null);
    assert.equal((await json(server.base, ta, "PATCH", "/users/me/region-education", { country: "Nigeria", state: "Lagos", educationKind: "student" })).status, 400);
    assert.equal((await json(server.base, ta, "PATCH", "/users/me/region-education", { country: "Nigeria", educationKind: "selfTaught" })).status, 400);
    assert.equal((await json(server.base, ta, "PATCH", "/users/me/region-education", { country: "Nigeria", state: "Lagos", educationKind: "wizard" })).status, 400);
  });

  it("a client says individual or business instead", async () => {
    const r = await json(server.base, tc, "PATCH", "/users/me/region-education", { country: "Ghana", clientKind: "business" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.clientKind, "business");
    assert.equal((await json(server.base, tc, "PATCH", "/users/me/region-education", { country: "Ghana" })).status, 400);
  });
});

describe("POST /users/me/identity", () => {
  it("refuses a bad NIN, a missing video, a non-image document, an HTML video and an under-age date of birth", async () => {
    assert.equal((await submit({ documentNumber: "123" })).status, 400);
    assert.equal((await submit({}, { document: files().document })).status, 400);
    assert.equal((await submit({}, { document: { buffer: HTML, filename: "slip.png", type: "image/png" }, video: files().video })).status, 415);
    assert.equal((await submit({}, { document: files().document, video: { buffer: HTML, filename: "me.mp4", type: "video/mp4" } })).status, 415);
    const young = await submit({ dateOfBirth: new Date(Date.now() - 12 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10) });
    assert.equal(young.status, 400);
    assert.equal(young.json.code, "too_young");
    assert.equal(await prisma.identityCheck.count({ where: { userId: ctx.talentA.id } }), 0, "nothing recorded for refused submissions");
  });

  it("stores both files privately, records a pending check, and refuses a second while it is pending", async () => {
    const r = await submit();
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.identity.status, "inReview");
    const [row] = await prisma.identityCheck.findMany({ where: { userId: ctx.talentA.id } });
    assert.equal(row.status, "pending");
    assert.ok(storage.objects.has(`identity-docs/${row.documentPath}`));
    assert.ok(storage.objects.has(`identity-docs/${row.videoPath}`));
    assert.equal(storage.buckets.get("identity-docs").public, false, "the bucket is private");
    const again = await submit();
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "already_pending");
  });
});

describe("the checker", () => {
  it("needs the checker capability", async () => {
    assert.equal((await json(server.base, readerTok, "GET", "/admin/identity-checks")).status, 403);
  });

  it("lists the submission, opens it with signed links, and records that it was viewed", async () => {
    const list = await json(server.base, checkerTok, "GET", "/admin/identity-checks");
    const item = list.json.checks.find((c) => c.user.id === ctx.talentA.id);
    assert.ok(item);
    const one = await json(server.base, checkerTok, "GET", `/admin/identity-checks/${item.id}`);
    assert.equal(one.status, 200, JSON.stringify(one.json));
    assert.ok(one.json.check.documentUrl && one.json.check.videoUrl);
    assert.equal(await prisma.adminAuditEvent.count({ where: { action: "identity.view", subjectId: item.id } }), 1);
  });

  it("refuses an approval whose name or date of birth doesn't match what the person entered", async () => {
    const row = await prisma.identityCheck.findFirst({ where: { userId: ctx.talentA.id } });
    const wrongName = await json(server.base, checkerTok, "POST", `/admin/identity-checks/${row.id}/approve`, { legalName: "Someone Else", dateOfBirth: "2000-03-04" });
    assert.equal(wrongName.status, 400);
    assert.equal(wrongName.json.code, "name_mismatch");
    const wrongDob = await json(server.base, checkerTok, "POST", `/admin/identity-checks/${row.id}/approve`, { legalName: "Suite Talent", dateOfBirth: "1999-01-01" });
    assert.equal(wrongDob.json.code, "dob_mismatch");
    assert.equal((await prisma.identityCheck.findUnique({ where: { id: row.id } })).status, "pending");
  });

  it("'Not yet' keeps the reason, shows it to the person, and lets them send again", async () => {
    const row = await prisma.identityCheck.findFirst({ where: { userId: ctx.talentA.id } });
    const r = await json(server.base, checkerTok, "POST", `/admin/identity-checks/${row.id}/not-yet`, { reasonCode: "unreadable" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const me = await json(server.base, ta, "GET", "/users/me/identity");
    assert.equal(me.json.identity.status, "notYet");
    assert.equal(me.json.identity.reason.code, "unreadable");
    assert.equal((await json(server.base, checkerTok, "POST", `/admin/identity-checks/${row.id}/not-yet`, { reasonCode: "unreadable" })).status, 409, "already handled");
    assert.equal((await submit()).status, 201, "a new submission is allowed after Not yet");
  });

  it("approval verifies the person, stores the legal name, and records the audit event", async () => {
    const row = await prisma.identityCheck.findFirst({ where: { userId: ctx.talentA.id, status: "pending" } });
    const r = await json(server.base, checkerTok, "POST", `/admin/identity-checks/${row.id}/approve`, { legalName: "Talent Suite", dateOfBirth: "2000-03-04" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const user = await prisma.user.findUnique({ where: { id: ctx.talentA.id } });
    assert.ok(user.identityVerifiedAt);
    assert.equal(user.legalName, "Talent Suite");
    assert.equal(await prisma.adminAuditEvent.count({ where: { action: "identity.approve", subjectId: row.id } }), 1);
    const me = await json(server.base, ta, "GET", "/users/me/identity");
    assert.equal(me.json.identity.status, "verified");
    assert.equal(me.json.identity.canTransact, true);
    assert.equal((await submit()).status, 409, "already verified");
  });
});

describe("payout name match", () => {
  it("accepts an account in the verified name and refuses one in another name", async () => {
    provider.accountName = "SUITE TALENT";
    const ok = await json(server.base, ta, "POST", "/users/me/bank-account/resolve", { accountNumber: "0123456789", bankCode: "058" });
    assert.equal(ok.json.matchesVerifiedName, true);
    provider.accountName = "Somebody Different";
    const bad = await json(server.base, ta, "POST", "/users/me/bank-account/resolve", { accountNumber: "0123456789", bankCode: "058" });
    assert.equal(bad.json.matchesVerifiedName, false);
    const refused = await json(server.base, ta, "POST", "/users/me/bank-account", { accountNumber: "0123456789", bankCode: "058" });
    assert.equal(refused.status, 422);
    assert.equal(refused.json.code, "name_mismatch");
  });
});

describe("the paid-action gate (IDENTITY_REQUIRED=true)", () => {
  it("refuses an unverified client posting a job, and lets a verified adult through", async () => {
    await prisma.user.update({ where: { id: ctx.client.id }, data: { identityVerifiedAt: null, dateOfBirth: null } });
    const body = { title: `${h.TITLE_PREFIX}gate`, category: h.CATEGORY, description: "suite", budget: 1000, deliveryDays: 5 };
    const refused = await json(gated.base, tc, "POST", "/jobs", body);
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, "identity_required");
    await prisma.user.update({ where: { id: ctx.client.id }, data: { identityVerifiedAt: new Date(), dateOfBirth: new Date("1990-01-01") } });
    assert.equal((await json(gated.base, tc, "POST", "/jobs", body)).status, 201);
  });

  it("a verified minor needs the guardian first", async () => {
    await prisma.user.update({ where: { id: ctx.client.id }, data: { dateOfBirth: new Date(Date.now() - 17 * 365 * 24 * 3600 * 1000), guardianConfirmedAt: null } });
    const r = await json(gated.base, tc, "POST", "/jobs", { title: `${h.TITLE_PREFIX}gate2`, category: h.CATEGORY, description: "suite", budget: 1000, deliveryDays: 5 });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "guardian_required");
  });
});

describe("the guardian", () => {
  it("only a minor can invite one, the page asks for consent, and confirming records it", async () => {
    await reset();
    assert.equal((await json(server.base, ta, "POST", "/users/me/guardian", { guardianName: "Ada Obi", guardianEmail: "ada.obi@example.com", relationship: "parent" })).status, 400, "an adult has no guardian step");

    const seventeen = new Date(Date.now() - 17 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    assert.equal((await submit({ dateOfBirth: seventeen })).status, 201);
    const invite = await json(server.base, ta, "POST", "/users/me/guardian", { guardianName: "Ada Obi", guardianEmail: "ada.obi@example.com", relationship: "parent" });
    assert.equal(invite.status, 201, JSON.stringify(invite.json));
    assert.equal(invite.json.identity.guardian.confirmed, false);

    // The token is only in the emailed link: the test reads it the way a guardian's link would carry it,
    // by replacing the stored hash with one for a token it chose.
    const token = "suite-guardian-token";
    const crypto = require("node:crypto");
    await prisma.guardianConsent.updateMany({ where: { userId: ctx.talentA.id }, data: { tokenHash: crypto.createHash("sha256").update(token).digest("hex") } });

    const page = await fetch(`${server.base}/guardian/confirm?token=${token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Yes, I consent/);
    assert.match(html, /bank account in their own name/);

    const done = await fetch(`${server.base}/guardian/confirm`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `token=${token}` });
    assert.equal(done.status, 200);
    const user = await prisma.user.findUnique({ where: { id: ctx.talentA.id } });
    assert.ok(user.guardianConfirmedAt, "read back: the user row holds the confirmation");

    const expired = await fetch(`${server.base}/guardian/confirm?token=not-a-token`);
    assert.equal(expired.status, 410);
  });
});
