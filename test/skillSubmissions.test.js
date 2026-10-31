// S2 over real HTTP: proving a skill. Files go to a local fake of the private R2 bucket, so nothing real is touched.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;

const SKILL = "short-form-video";
let providerServer, ctx, server, r2, ta, tb, tc, checkerTok, checker, readerA, readerB, readerC, outsider, tokA, tokB, tokC, tokOutsider, owner;
const admins = [];

before(async () => {
  ctx = await h.fixtures();
  const provider = h.fakeProvider();
  const fakeProvider = (providerServer = await h.serveFakeProvider(provider));
  r2 = await h.serveFakeR2();
  server = await h.startServer({
    port: 4641,
    paystackUrl: fakeProvider.url,
    autoRelease: false,
    env: { R2_ACCOUNT_ID: "test", R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_PRIVATE_BUCKET: "private-test", R2_ENDPOINT: r2.url, SUBMISSION_SUBMIT_LIMIT: "100", SUBMISSION_FILE_LIMIT: "1000" },
  });
  checker = await h.ensureAdmin("testsuite-s2-checker@example.com", { capabilities: ["checker"] });
  readerA = await h.ensureAdmin("testsuite-s2-reader-a@example.com", { capabilities: ["reviewer"], reviewerSkills: [SKILL] });
  readerB = await h.ensureAdmin("testsuite-s2-reader-b@example.com", { capabilities: ["reviewer"], reviewerSkills: [SKILL] });
  readerC = await h.ensureAdmin("testsuite-s2-reader-c@example.com", { capabilities: ["reviewer"], reviewerSkills: [SKILL] });
  outsider = await h.ensureAdmin("testsuite-s2-outsider@example.com", { capabilities: ["reviewer"], reviewerSkills: ["writing"] });
  admins.push(checker, readerA, readerB, readerC, outsider);
  [ta, tb, tc, checkerTok, tokA, tokB, tokC, tokOutsider] = await Promise.all([
    h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB), h.tokenFor(ctx.client),
    h.adminTokenFor(checker), h.adminTokenFor(readerA), h.adminTokenFor(readerB), h.adminTokenFor(readerC), h.adminTokenFor(outsider),
  ]);
  await reset();
});
after(async () => {
  server?.stop();
  r2?.server.close();
  providerServer?.server.close();
  await reset();
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: { in: admins.map((a) => a.id) } } });
  await prisma.$disconnect();
});

async function reset() {
  const ids = [ctx.talentA.id, ctx.talentB.id];
  await prisma.skillSubmission.deleteMany({ where: { userId: { in: ids } } });
  await prisma.skillRestriction.deleteMany({ where: { userId: { in: ids } } });
  await prisma.proofItem.deleteMany({ where: { title: { endsWith: "(verified)" }, talentProfile: { userId: { in: ids } } } });
}

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);
const bytes = (n, fill = 1) => Buffer.alloc(n, fill);

/** Asks for an upload link, PUTs the bytes to it, and confirms. Returns the confirm response. */
async function addFile(tok, subId, { role, pieceId, name = "clip.mp4", type = "video/mp4", content = bytes(2048) }) {
  const made = await api(tok, "POST", `/users/me/submissions/${subId}/files`, { role, pieceId, name, contentType: type, sizeBytes: content.length });
  if (made.status !== 201) return made;
  const put = await fetch(made.json.upload.url, { method: "PUT", headers: made.json.upload.headers, body: content });
  assert.equal(put.status, 200, "the presigned PUT is accepted by the (fake) bucket");
  return api(tok, "POST", `/users/me/submissions/${subId}/files/${made.json.file.id}/complete`);
}

/** A complete, ready-to-send submission for talent `tok`. `seed` makes the files differ from other attempts. */
async function buildReady(tok, seed = 1, skill = SKILL) {
  const start = await api(tok, "POST", `/users/me/skills/${skill}/submissions`);
  assert.ok([200, 201].includes(start.status), JSON.stringify(start.json));
  const id = start.json.submission.id;
  for (const n of [1, 2]) {
    const p = await api(tok, "POST", `/users/me/submissions/${id}/pieces`, { title: `Reel ${n}`, brief: "A 20 second promo", role: "Editor", madeOn: "March 2026" });
    assert.equal(p.status, 201);
  }
  let sbm = (await api(tok, "GET", `/users/me/submissions/${id}`)).json.submission;
  const [p1, p2] = sbm.pieces;
  for (const [piece, role, mark] of [[p1, "output", 10], [p2, "output", 20], [p1, "working", 30], [p1, "draft", 40]]) {
    const r = await addFile(tok, id, { role, pieceId: piece.id, content: bytes(2048 + seed, mark + seed) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.equal((await addFile(tok, id, { role: "walkthrough", content: bytes(4096, 99) })).status, 200);
  const decl = await api(tok, "PATCH", `/users/me/submissions/${id}`, { declaredOwnWork: true, aiUsed: false });
  assert.equal(decl.status, 200);
  return id;
}

const scores = (n, over = {}) => ({ structure: n, pacing: n, sound: n, picture: n, text: n, brief: n, export: n, ...over });
const pass = { scores: scores(3), verdict: "pass", comment: "" };
const notYet = (comment = "The dialogue is buried under the music.") => ({ scores: scores(3, { sound: 1, text: 2 }), verdict: "notYet", comment });
const allChecked = { walkthrough: true, working: true, drafts: true, elsewhere: true };
const checkerPass = (id) => api(checkerTok, "POST", `/admin/authenticity/${id}/pass`, { checklist: allChecked, note: "Looks genuine." });

describe("the hub", () => {
  it("lists every skill as not started, for talent only", async () => {
    const r = await api(ta, "GET", "/users/me/skills");
    assert.equal(r.status, 200);
    assert.equal(r.json.skills.length, 5);
    assert.ok(r.json.skills.every((s) => s.state === "notStarted" && s.rubricDraft === true));
    assert.equal(r.json.uploadsAvailable, true);
    assert.equal((await api(tc, "GET", "/users/me/skills")).status, 403);
  });
});

describe("building a submission", () => {
  it("starts one draft per skill and returns the same draft again", async () => {
    const a = await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`);
    assert.equal(a.status, 201);
    assert.equal(a.json.submission.status, "draft");
    assert.equal(a.json.submission.readiness.ready, false);
    const b = await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`);
    assert.equal(b.status, 200);
    assert.equal(b.json.submission.id, a.json.submission.id);
    assert.equal((await api(ta, "POST", "/users/me/skills/nope/submissions")).status, 404);
    await api(ta, "DELETE", `/users/me/submissions/${a.json.submission.id}`);
  });

  it("only the owner can see or change it", async () => {
    const id = (await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`)).json.submission.id;
    assert.equal((await api(tb, "GET", `/users/me/submissions/${id}`)).status, 404);
    assert.equal((await api(tb, "POST", `/users/me/submissions/${id}/pieces`, { title: "x" })).status, 404);
    await api(ta, "DELETE", `/users/me/submissions/${id}`);
  });

  it("holds 2 or 3 pieces, and refuses a bad live link", async () => {
    const id = (await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`)).json.submission.id;
    assert.equal((await api(ta, "POST", `/users/me/submissions/${id}/pieces`, { title: "A", liveLink: "not a link" })).status, 400);
    for (let i = 0; i < 3; i++) assert.equal((await api(ta, "POST", `/users/me/submissions/${id}/pieces`, { title: `P${i}` })).status, 201);
    const fourth = await api(ta, "POST", `/users/me/submissions/${id}/pieces`, { title: "P4" });
    assert.equal(fourth.status, 400);
    assert.equal(fourth.json.code, "too_many_pieces");
    await api(ta, "DELETE", `/users/me/submissions/${id}`);
  });

  it("refuses types that aren't allowed, files over the limit, and an upload that never happened", async () => {
    const id = (await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`)).json.submission.id;
    const piece = (await api(ta, "POST", `/users/me/submissions/${id}/pieces`, { title: "A" })).json.submission.pieces[0];
    const html = await api(ta, "POST", `/users/me/submissions/${id}/files`, { role: "output", pieceId: piece.id, name: "x.html", contentType: "text/html", sizeBytes: 10 });
    assert.equal(html.json.code, "type_not_allowed");
    const big = await api(ta, "POST", `/users/me/submissions/${id}/files`, { role: "walkthrough", name: "w.mp4", contentType: "video/mp4", sizeBytes: 301 * 1024 * 1024 });
    assert.equal(big.status, 413);
    const noPiece = await api(ta, "POST", `/users/me/submissions/${id}/files`, { role: "output", name: "o.mp4", contentType: "video/mp4", sizeBytes: 10 });
    assert.equal(noPiece.status, 400);
    const asked = await api(ta, "POST", `/users/me/submissions/${id}/files`, { role: "output", pieceId: piece.id, name: "o.mp4", contentType: "video/mp4", sizeBytes: 10 });
    assert.equal(asked.status, 201);
    const early = await api(ta, "POST", `/users/me/submissions/${id}/files/${asked.json.file.id}/complete`);
    assert.equal(early.status, 409);
    assert.equal(early.json.code, "upload_missing");
    await api(ta, "DELETE", `/users/me/submissions/${id}`);
  });

  it("removes a file whose size isn't what was announced", async () => {
    const id = (await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`)).json.submission.id;
    const piece = (await api(ta, "POST", `/users/me/submissions/${id}/pieces`, { title: "A" })).json.submission.pieces[0];
    const asked = await api(ta, "POST", `/users/me/submissions/${id}/files`, { role: "output", pieceId: piece.id, name: "o.mp4", contentType: "video/mp4", sizeBytes: 100 });
    await fetch(asked.json.upload.url, { method: "PUT", headers: asked.json.upload.headers, body: bytes(500) });
    const done = await api(ta, "POST", `/users/me/submissions/${id}/files/${asked.json.file.id}/complete`);
    assert.equal(done.status, 400);
    assert.equal(done.json.code, "size_mismatch");
    assert.equal(await prisma.submissionFile.count({ where: { id: asked.json.file.id } }), 0);
    await api(ta, "DELETE", `/users/me/submissions/${id}`);
  });

  it("says exactly what is missing and refuses to send before it's all there", async () => {
    const id = (await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`)).json.submission.id;
    const r = await api(ta, "POST", `/users/me/submissions/${id}/submit`);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "not_ready");
    assert.ok(r.json.missing.includes("pieces") && r.json.missing.includes("walkthrough") && r.json.missing.includes("declaration"));
    await api(ta, "DELETE", `/users/me/submissions/${id}`);
  });

  it("a declared AI use needs a note", async () => {
    const id = (await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`)).json.submission.id;
    const r = await api(ta, "PATCH", `/users/me/submissions/${id}`, { declaredOwnWork: true, aiUsed: true });
    assert.equal(r.json.submission.readiness.items.find((i) => i.key === "declaration").done, false);
    const noted = await api(ta, "PATCH", `/users/me/submissions/${id}`, { aiNote: "Captions were generated, then corrected by me." });
    assert.equal(noted.json.submission.readiness.items.find((i) => i.key === "declaration").done, true);
    await api(ta, "DELETE", `/users/me/submissions/${id}`);
  });
});

describe("the whole journey to verified", () => {
  it("sends, passes the authenticity check, is reviewed blind by two, and becomes verified", async () => {
    const id = await buildReady(ta, 1);
    const sent = await api(ta, "POST", `/users/me/submissions/${id}/submit`);
    assert.equal(sent.status, 200);
    assert.equal(sent.json.submission.status, "authenticity");
    assert.equal((await api(ta, "PATCH", `/users/me/submissions/${id}`, { declaredOwnWork: false })).status, 409, "a sent submission is frozen");

    // The checker sees the person and the work, with working links.
    const queue = await api(checkerTok, "GET", "/admin/authenticity");
    assert.ok(queue.json.submissions.some((s) => s.id === id));
    const detail = await api(checkerTok, "GET", `/admin/authenticity/${id}`);
    assert.equal(detail.json.submission.person.name, "Suite Talent A");
    assert.equal(detail.json.submission.pieces.length, 2);
    const link = detail.json.submission.pieces[0].files[0].url;
    assert.equal((await fetch(link)).status, 200, "the signed download link works");
    assert.equal((await fetch(link.split("?")[0])).status, 403, "the bare link does not");

    // Not everything ticked: refused.
    const partial = await api(checkerTok, "POST", `/admin/authenticity/${id}/pass`, { checklist: { walkthrough: true } });
    assert.equal(partial.status, 400);
    assert.equal(partial.json.code, "checklist_incomplete");
    assert.equal((await checkerPass(id)).status, 200);
    assert.equal((await checkerPass(id)).status, 409, "the second click finds it already handled");

    // Reviewers: blind (no person, no scores), only those holding the skill.
    const list = await api(tokA, "GET", "/admin/skill-reviews");
    assert.ok(list.json.submissions.some((s) => s.id === id));
    assert.equal((await api(tokOutsider, "GET", `/admin/skill-reviews/${id}`)).status, 403);
    assert.equal((await api(checkerTok, "GET", "/admin/skill-reviews")).status, 403, "a checker is not a reviewer");
    const seen = await api(tokA, "GET", `/admin/skill-reviews/${id}`);
    assert.equal(seen.status, 200);
    assert.ok(!JSON.stringify(seen.json).includes("Suite Talent"), "the reviewer never learns who made it");
    assert.equal(seen.json.rubric.lines.length, 7);

    const first = await api(tokA, "POST", `/admin/skill-reviews/${id}/review`, pass);
    assert.deepEqual([first.status, first.json.state], [200, "waiting"]);
    assert.equal((await api(tokA, "POST", `/admin/skill-reviews/${id}/review`, pass)).status, 409, "no second review from the same person");
    assert.ok(!(await api(tokA, "GET", "/admin/skill-reviews")).json.submissions.some((s) => s.id === id), "what you've reviewed leaves your list");
    const second = await api(tokB, "POST", `/admin/skill-reviews/${id}/review`, pass);
    assert.deepEqual([second.status, second.json.state, second.json.outcome], [200, "decided", "verified"]);

    const mine = (await api(ta, "GET", `/users/me/submissions/${id}`)).json.submission;
    assert.equal(mine.status, "verified");
    const hub = (await api(ta, "GET", "/users/me/skills")).json.skills.find((s) => s.skillKey === SKILL);
    assert.equal(hub.state, "verified");
    const proof = await prisma.proofItem.findFirst({ where: { title: "Short-form video editing (verified)", talentProfile: { userId: ctx.talentA.id } } });
    assert.equal(proof?.status, "verified", "the older apply gate sees the verification");
    assert.equal((await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`)).json.code, "already_verified");

    const audits = await prisma.adminAuditEvent.findMany({ where: { subjectId: id } });
    assert.ok(["authenticity.pass", "skillReview.review", "skillReview.verified"].every((a) => audits.some((e) => e.action === a)));
  });
});

describe("Not yet", () => {
  let firstId, firstFiles;

  it("two that agree on not-yet give reasons with the lines and the words, and never who", async () => {
    firstId = await buildReady(tb, 5);
    assert.equal((await api(tb, "POST", `/users/me/submissions/${firstId}/submit`)).status, 200);
    firstFiles = (await prisma.submissionFile.findMany({ where: { submissionId: firstId, role: "output" } })).map((f) => f.etag);
    await checkerPass(firstId);
    assert.equal((await api(tokA, "POST", `/admin/skill-reviews/${firstId}/review`, notYet())).json.state, "waiting");
    const done = await api(tokB, "POST", `/admin/skill-reviews/${firstId}/review`, notYet("Music too loud in the second reel."));
    assert.equal(done.json.outcome, "notYet");

    const result = (await api(tb, "GET", `/users/me/submissions/${firstId}`)).json.submission.result;
    assert.equal(result.outcome, "notYet");
    assert.deepEqual(result.lines.map((l) => [l.key, l.score]), [["sound", 1], ["text", 2]]);
    assert.deepEqual(result.comments.sort(), ["Music too loud in the second reel.", "The dialogue is buried under the music."].sort());
    assert.ok(!JSON.stringify(result).includes("reviewer"), "no reviewer identity in the result");
    const history = await api(tb, "GET", `/users/me/skills/${SKILL}/submissions`);
    assert.equal(history.json.submissions.length, 1);
    assert.equal(history.json.submissions[0].status, "notYet");
  });

  it("a not-yet vote needs a real comment, and a pass can't hide a line below the standard", async () => {
    const probe = await buildReady(tb, 7);
    // talent B already has a not-yet, so the second attempt needs the terms accepted before it can go.
    const gated = await api(tb, "POST", `/users/me/submissions/${probe}/submit`);
    assert.equal(gated.json.code, "not_ready");
    assert.ok(gated.json.missing.includes("terms"));
    assert.equal((await api(tb, "PATCH", `/users/me/submissions/${probe}`, { acceptTerms: true })).status, 200);
    assert.equal((await api(tb, "POST", `/users/me/submissions/${probe}/submit`)).status, 200);
    await checkerPass(probe);
    const shortComment = await api(tokA, "POST", `/admin/skill-reviews/${probe}/review`, notYet("short"));
    assert.equal(shortComment.status, 400);
    const hiding = await api(tokA, "POST", `/admin/skill-reviews/${probe}/review`, { scores: scores(3, { sound: 1 }), verdict: "pass" });
    assert.equal(hiding.status, 400);
    // A split goes to a third reviewer, whose vote decides.
    assert.equal((await api(tokA, "POST", `/admin/skill-reviews/${probe}/review`, pass)).json.state, "waiting");
    const split = await api(tokB, "POST", `/admin/skill-reviews/${probe}/review`, notYet());
    assert.equal(split.json.state, "needThird");
    const open = await api(tokC, "GET", "/admin/skill-reviews");
    assert.equal(open.json.submissions.find((s) => s.id === probe)?.thirdOpinion, true);
    assert.equal((await api(tokC, "POST", `/admin/skill-reviews/${probe}/review`, pass)).json.outcome, "verified");
    assert.equal((await api(tokOutsider, "POST", `/admin/skill-reviews/${probe}/review`, pass)).status, 403);
    assert.equal((await api(tokA, "POST", `/admin/skill-reviews/${probe}/review`, pass)).status, 409);
  });
});

describe("sending rejected work again", () => {
  it("is flagged by file, penalised 2 months then 3, and blocks new attempts while it lasts", async () => {
    await reset();
    // First attempt, rejected.
    const first = await buildReady(ta, 11);
    await api(ta, "POST", `/users/me/submissions/${first}/submit`);
    await checkerPass(first);
    await api(tokA, "POST", `/admin/skill-reviews/${first}/review`, notYet());
    await api(tokB, "POST", `/admin/skill-reviews/${first}/review`, notYet());
    assert.equal((await prisma.skillSubmission.findUnique({ where: { id: first } })).status, "notYet");

    // Second attempt: the very same bytes (same seed) for the finished work.
    const second = await buildReady(ta, 11);
    assert.equal((await api(ta, "POST", `/users/me/submissions/${second}/submit`)).json.code, "not_ready", "the terms come first");
    await api(ta, "PATCH", `/users/me/submissions/${second}`, { acceptTerms: true });
    assert.equal((await api(ta, "POST", `/users/me/submissions/${second}/submit`)).status, 200);
    const flagged = await api(checkerTok, "GET", `/admin/authenticity/${second}`);
    assert.equal(flagged.json.submission.repeatOfRejected, true);
    assert.equal(flagged.json.earlier.length, 1);
    assert.equal(flagged.json.nextPenaltyMonths, 2);

    const done = await api(checkerTok, "POST", `/admin/authenticity/${second}/penalize`, { note: "Same files as the rejected attempt." });
    assert.equal(done.status, 200);
    assert.equal(done.json.months, 2);
    const blocked = await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, "restricted");
    assert.equal((await api(ta, "GET", "/users/me/skills")).json.skills.find((s) => s.skillKey === SKILL).state, "restricted");

    // After that restriction ends, a second repeat costs 3 months.
    await prisma.skillRestriction.updateMany({ where: { userId: ctx.talentA.id }, data: { until: new Date(Date.now() - 1000) } });
    const third = await buildReady(ta, 11);
    await api(ta, "PATCH", `/users/me/submissions/${third}`, { acceptTerms: true });
    await api(ta, "POST", `/users/me/submissions/${third}/submit`);
    const next = await api(checkerTok, "GET", `/admin/authenticity/${third}`);
    assert.equal(next.json.nextPenaltyMonths, 3);
    assert.equal((await api(checkerTok, "POST", `/admin/authenticity/${third}/penalize`, {})).json.months, 3);
  });

  it("changed work is not a repeat, and penalise is refused on it", async () => {
    await reset();
    const first = await buildReady(ta, 21);
    await api(ta, "POST", `/users/me/submissions/${first}/submit`);
    await checkerPass(first);
    await api(tokA, "POST", `/admin/skill-reviews/${first}/review`, notYet());
    await api(tokB, "POST", `/admin/skill-reviews/${first}/review`, notYet());
    const second = await buildReady(ta, 22);
    await api(ta, "PATCH", `/users/me/submissions/${second}`, { acceptTerms: true });
    await api(ta, "POST", `/users/me/submissions/${second}/submit`);
    assert.equal((await api(checkerTok, "GET", `/admin/authenticity/${second}`)).json.submission.repeatOfRejected, false);
    const r = await api(checkerTok, "POST", `/admin/authenticity/${second}/penalize`, {});
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "not_a_repeat");
  });
});

describe("stopping and banning at the authenticity step", () => {
  it("stop gives a reason and no penalty; ban removes the skill for good", async () => {
    await reset();
    const a = await buildReady(ta, 31);
    await api(ta, "POST", `/users/me/submissions/${a}/submit`);
    assert.equal((await api(checkerTok, "POST", `/admin/authenticity/${a}/stop`, { note: "x" })).status, 400, "a reason is required");
    assert.equal((await api(checkerTok, "POST", `/admin/authenticity/${a}/stop`, { note: "The walkthrough doesn't show you explaining the work." })).status, 200);
    const stopped = (await api(ta, "GET", `/users/me/submissions/${a}`)).json.submission;
    assert.equal(stopped.result.kind, "authenticity");
    assert.match(stopped.result.note, /walkthrough/);
    assert.equal((await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`)).status, 201, "no penalty: they can start again");
    await prisma.skillSubmission.updateMany({ where: { userId: ctx.talentA.id, status: "draft" }, data: { status: "removed" } });

    // The very same files again after a stop (which never reached reviewers) are not "rejected work sent again".
    const b = await buildReady(ta, 31);
    await api(ta, "PATCH", `/users/me/submissions/${b}`, { acceptTerms: true });
    await api(ta, "POST", `/users/me/submissions/${b}/submit`);
    assert.equal((await api(checkerTok, "GET", `/admin/authenticity/${b}`)).json.submission.repeatOfRejected, false);
    assert.equal((await api(checkerTok, "POST", `/admin/authenticity/${b}/ban`, { note: "This reel is on another editor's channel." })).status, 200);
    const blocked = await api(ta, "POST", `/users/me/skills/${SKILL}/submissions`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.restriction.kind, "ban");
    assert.equal(blocked.json.restriction.until, null);
    const audits = await prisma.adminAuditEvent.findMany({ where: { subjectId: { in: [a, b] } } });
    assert.ok(["authenticity.stop", "authenticity.ban"].every((x) => audits.some((e) => e.action === x)));
  });
});

describe("access", () => {
  it("authenticity and review need the right capability", async () => {
    const plain = await h.ensureAdmin("testsuite-s2-plain@example.com");
    admins.push(plain);
    const tok = await h.adminTokenFor(plain);
    assert.equal((await api(tok, "GET", "/admin/authenticity")).status, 403);
    assert.equal((await api(tok, "GET", "/admin/skill-reviews")).status, 403);
    assert.equal((await fetch(server.base + "/admin/authenticity")).status, 401);
  });

  it("the inbox gets both queues, each for the right role", async () => {
    const mineChecker = await api(checkerTok, "GET", "/admin/inbox");
    assert.ok(mineChecker.json.queues.some((q) => q.key === "authenticity"));
    assert.ok(!mineChecker.json.queues.some((q) => q.key === "skill-review"));
    const mineReader = await api(tokA, "GET", "/admin/inbox");
    assert.ok(mineReader.json.queues.some((q) => q.key === "skill-review"));
  });
});
