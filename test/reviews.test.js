// S7: reviews both ways (hidden until both are in, then locked, one reply each), the private question, facts, plain
// counts, Proven per skill, reported reviews, and portable credentials signed as VC-JWTs.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const h = require("./helpers");
const rep = require("../src/reputation");
const reviewsMod = require("../src/reviews");
const { prisma } = h;

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
process.env.CREDENTIAL_SIGNING_KEY = PEM;
process.env.PUBLIC_API_URL = "http://127.0.0.1:4691";
const credentials = require("../src/credentials");

let ctx, server, fakeProvider, cl, ca, tb, safetyTok, plainTok, safety, plain;
const admins = [];

before(async () => {
  ctx = await h.fixtures();
  fakeProvider = await h.serveFakeProvider(h.fakeProvider());
  server = await h.startServer({ port: 4691, paystackUrl: fakeProvider.url, autoRelease: false, env: { CREDENTIAL_SIGNING_KEY: PEM.replace(/\n/g, "\\n"), PUBLIC_API_URL: "http://127.0.0.1:4691" } });
  safety = await h.ensureAdmin("testsuite-s7-safety@example.com", { capabilities: ["safety"] });
  plain = await h.ensureAdmin("testsuite-s7-plain@example.com");
  admins.push(safety, plain);
  [cl, ca, tb, safetyTok, plainTok] = await Promise.all([h.tokenFor(ctx.client), h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB), h.adminTokenFor(safety), h.adminTokenFor(plain)]);
  await reset();
});
after(async () => {
  server?.stop();
  fakeProvider?.server.close();
  await reset();
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: { in: admins.map((a) => a.id) } } });
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);

async function reset() {
  await prisma.credential.deleteMany({ where: { userId: { in: [ctx.talentA.id, ctx.talentB.id] } } });
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
}

/** A finished, paid job with talent A, delivered `onTime` or late, `daysAgo` days ago. */
async function completed({ skillKey = "graphic-design", onTime = true, daysAgo = 1, status = "approved" } = {}) {
  const done = new Date(Date.now() - daysAgo * 86_400_000);
  const s = await h.seedWorking(ctx, { contract: { status, transferredAt: done, platformFeeAmount: 100, deliverByAt: new Date(done.getTime() - (onTime ? -86_400_000 : 86_400_000)), fundedAt: new Date(done.getTime() - 5 * 86_400_000), startProofSubmittedAt: new Date(done.getTime() - 4 * 86_400_000) } });
  await prisma.job.update({ where: { id: s.job.id }, data: { skillKey } });
  await prisma.contractDelivery.create({ data: { contractId: s.c.id, version: 1, note: "v1", submittedAt: new Date(done.getTime() - 3 * 3_600_000) } });
  return s;
}

const clientAnswers = (over = {}) => ({ answers: { followedBrief: "yes", qualityAsAgreed: "yes", communicated: "partly", recommend: true, ...over }, comment: "Clear drafts and quick replies.", privateAgain: true });
const talentAnswers = (over = {}) => ({ answers: { briefClear: "yes", feedbackClear: "partly", paidFairly: "yes", recommend: true, ...over }, comment: "Paid on time.", privateAgain: true });

describe("the questions", () => {
  it("are specific, with a recommendation and no stars", () => {
    const keys = rep.QUESTIONS.client_to_talent.map((q) => q.key);
    assert.deepEqual(keys, ["followedBrief", "qualityAsAgreed", "communicated", "recommend"]);
    assert.ok(!JSON.stringify(rep.QUESTIONS).match(/star|rating|score/i));
  });

  it("refuse a missing answer, a wrong value, and a missing private answer", () => {
    const base = { direction: "client_to_talent", ...clientAnswers() };
    assert.equal(rep.validateReview(base).ok, true);
    assert.equal(rep.validateReview({ ...base, answers: { ...base.answers, communicated: undefined } }).ok, false);
    assert.equal(rep.validateReview({ ...base, answers: { ...base.answers, followedBrief: "maybe" } }).ok, false);
    assert.equal(rep.validateReview({ ...base, privateAgain: undefined }).ok, false);
    assert.equal(rep.validateReview({ ...base, comment: "x".repeat(1001) }).ok, false);
  });

  it("system facts come from timestamps: on time, days late, change rounds", () => {
    const deliverByAt = new Date("2026-10-10T12:00:00Z");
    const onTime = rep.jobFacts({ status: "approved", deliverByAt, changeRounds: 1, extensionsUsed: 1 }, [{ version: 1, submittedAt: new Date("2026-10-10T08:00:00Z") }]);
    assert.equal(onTime.deliveredOnTime, true);
    assert.equal(onTime.changeRounds, 1);
    const late = rep.jobFacts({ status: "approved", deliverByAt }, [{ version: 1, submittedAt: new Date("2026-10-12T08:00:00Z") }]);
    assert.equal(late.deliveredOnTime, false);
    assert.equal(late.daysLate, 2);
    assert.equal(rep.jobFacts({ status: "approved", deliverByAt }, []).deliveredOnTime, null);
  });
});

describe("hidden until both are in, then locked", () => {
  it("nobody can review before the job is paid out", async () => {
    const s = await h.seedWorking(ctx, {});
    const r = await api(cl, "POST", `/jobs/${s.job.id}/review`, clientAnswers());
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "not_yet");
    assert.equal((await api(cl, "GET", `/jobs/${s.job.id}/review`)).json.review.state, "not_yet");
  });

  it("one review stays hidden from the other side, who sees only that it exists", async () => {
    const { job } = await completed();
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/review`, clientAnswers())).status, 201);
    const theirView = await api(ca, "GET", `/jobs/${job.id}/review`);
    assert.equal(theirView.json.review.state, "can_review");
    assert.equal(theirView.json.review.theirs, null, "not revealed yet");
    assert.equal(theirView.json.review.theirsExists, true);
    const mine = await api(cl, "GET", `/jobs/${job.id}/review`);
    assert.equal(mine.json.review.state, "waiting");
    assert.equal(mine.json.review.canEdit, true);
    assert.equal(mine.json.review.mine.privateAgain, true, "the author sees their own private answer");
  });

  it("the second review reveals both, and neither shows the other's private answer", async () => {
    const { job } = await completed();
    await api(cl, "POST", `/jobs/${job.id}/review`, clientAnswers({ recommend: false }));
    const second = await api(ca, "POST", `/jobs/${job.id}/review`, { ...talentAnswers(), privateAgain: false });
    assert.equal(second.status, 201, JSON.stringify(second.json));
    const forTalent = (await api(ca, "GET", `/jobs/${job.id}/review`)).json.review;
    assert.equal(forTalent.state, "revealed");
    assert.equal(forTalent.theirs.answers.recommend, false);
    assert.equal(forTalent.theirs.privateAgain, undefined, "never shown (D31)");
    assert.equal(JSON.stringify(forTalent).includes('"privateAgain":false'), true, "only their own private answer appears");
    const forClient = (await api(cl, "GET", `/jobs/${job.id}/review`)).json.review;
    assert.equal(forClient.theirs.answers.briefClear, "yes");
  });

  it("can be edited until revealed, then is locked", async () => {
    const { job } = await completed();
    await api(cl, "POST", `/jobs/${job.id}/review`, clientAnswers());
    const edited = await api(cl, "POST", `/jobs/${job.id}/review`, clientAnswers({ communicated: "yes" }));
    assert.equal(edited.status, 200);
    assert.equal(edited.json.review.mine.answers.communicated, "yes");
    await api(ca, "POST", `/jobs/${job.id}/review`, talentAnswers());
    const locked = await api(cl, "POST", `/jobs/${job.id}/review`, clientAnswers({ communicated: "no" }));
    assert.equal(locked.status, 409);
    assert.equal(locked.json.code, "locked");
  });

  it("opens to the other side by itself when the 14 days pass with only one in", async () => {
    const { job, c } = await completed({ daysAgo: 20 });
    const row = await prisma.review.create({ data: { jobId: job.id, contractId: c.id, authorId: ctx.client.id, subjectId: ctx.talentA.id, direction: "client_to_talent", answers: clientAnswers().answers, comment: "ok", privateAgain: true, windowEndsAt: new Date(Date.now() - 6 * 86_400_000) } });
    const view = (await api(ca, "GET", `/jobs/${job.id}/review`)).json.review;
    assert.equal(view.state, "window_closed");
    assert.equal(view.theirs?.id, row.id, "visible once the window has closed");
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/review`, talentAnswers())).json.code, "window_closed");
  });

  it("each side gets one public reply, only once reviews are visible", async () => {
    const { job } = await completed();
    await api(cl, "POST", `/jobs/${job.id}/review`, clientAnswers());
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/review/reply`, { text: "Thank you, glad it worked out." })).json.code, "hidden");
    await api(ca, "POST", `/jobs/${job.id}/review`, talentAnswers());
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/review/reply`, { text: "ok" })).status, 400);
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/review/reply`, { text: "Thank you, glad it worked out." })).status, 200);
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/review/reply`, { text: "And one more thing to add." })).json.code, "already_replied");
    const seen = (await api(cl, "GET", `/jobs/${job.id}/review`)).json.review;
    assert.equal(seen.theirs.answers.recommend, true);
    assert.equal((await api(ca, "GET", `/jobs/${job.id}/review`)).json.review.mine.reply, "Thank you, glad it worked out.");
  });

  it("a stranger can't read or write", async () => {
    const { job } = await completed();
    assert.equal((await api(tb, "GET", `/jobs/${job.id}/review`)).status, 404);
    assert.equal((await api(tb, "POST", `/jobs/${job.id}/review`, talentAnswers())).status, 404);
  });
});

describe("what profiles show", () => {
  it("plain counts per skill, recent first, no average, and never the private answer", async () => {
    await reset();
    const a = await completed({ daysAgo: 3 });
    const b = await completed({ daysAgo: 2 });
    for (const s of [a, b]) {
      await api(cl, "POST", `/jobs/${s.job.id}/review`, clientAnswers({ recommend: s === a }));
      await api(ca, "POST", `/jobs/${s.job.id}/review`, talentAnswers());
    }
    const r = await rep.talentReputation(ctx.talentA.id);
    const row = r.skills.find((x) => x.skillKey === "graphic-design");
    assert.equal(row.jobs, 2);
    assert.equal(row.onTime, 2);
    assert.equal(row.reviewed, 2);
    assert.equal(row.recommend, 1);
    assert.equal(r.reviews.length, 2);
    assert.ok(new Date(r.reviews[0].at) >= new Date(r.reviews[1].at), "recent first");
    assert.equal(JSON.stringify(r).includes("privateAgain"), false);
    assert.ok(!("average" in r) && !("score" in r) && !("rank" in r));
    assert.ok(r.reviews[0].facts.deliveredOnTime);
  });

  it("the client's record shows what talents said, as counts, plus how they behave", async () => {
    const r = await rep.clientReputation(ctx.client.id);
    assert.ok(r.tally.reviewed >= 2);
    assert.ok(r.tally.briefClear >= 2);
    assert.ok(r.jobsDone >= 2);
    assert.ok(r.reviewHoursMedian !== null);
    assert.equal(r.disputesLost, 0);
    assert.equal(JSON.stringify(r).includes("privateAgain"), false);
  });

  it("the public profile route carries it", async () => {
    const p = await api(cl, "GET", `/talents/${ctx.talentA.id}`);
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.ok(p.json.reputation);
    assert.ok(Array.isArray(p.json.reputation.skills));
  });
});

describe("Proven", () => {
  async function verifiedIn(skillKey) {
    await prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey, status: "verified", decidedAt: new Date() } }).catch(() => {});
  }

  it("takes 3 jobs in the skill, all on time, none lost, every client recommending", async () => {
    await reset();
    await prisma.skillSubmission.deleteMany({ where: { userId: ctx.talentA.id, skillKey: "graphic-design" } });
    await verifiedIn("graphic-design");
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(await completed({ daysAgo: 20 - i }));
    let state = await rep.provenState(ctx.talentA.id, "graphic-design");
    assert.equal(state.proven, false);
    assert.equal(state.completed, 3);
    assert.ok(state.unmet.some((u) => /recommending/.test(u)), "reviews are missing");

    for (const j of jobs) {
      await prisma.review.create({ data: { jobId: j.job.id, contractId: j.c.id, authorId: ctx.client.id, subjectId: ctx.talentA.id, direction: "client_to_talent", answers: clientAnswers().answers, comment: "", privateAgain: true, windowEndsAt: new Date(Date.now() - 86_400_000) } });
    }
    state = await rep.provenState(ctx.talentA.id, "graphic-design");
    assert.equal(state.proven, true, JSON.stringify(state));
  });

  it("is lost when one client doesn't recommend, or a dispute is lost, or a job is late", async () => {
    const js = await prisma.review.findMany({ where: { subjectId: ctx.talentA.id } });
    await prisma.review.update({ where: { id: js[0].id }, data: { answers: { ...js[0].answers, recommend: false } } });
    assert.equal((await rep.provenState(ctx.talentA.id, "graphic-design")).proven, false);
    await prisma.review.update({ where: { id: js[0].id }, data: { answers: { ...js[0].answers, recommend: true } } });
    assert.equal((await rep.provenState(ctx.talentA.id, "graphic-design")).proven, true);

    const c = await prisma.contract.findFirst({ where: { job: { skillKey: "graphic-design", applications: { some: { talentId: ctx.talentA.id } } } } });
    await prisma.dispute.create({ data: { contractId: c.id, jobId: c.jobId, filedById: ctx.client.id, filedByRole: "client", problem: "quality", status: "resolved", loserId: ctx.talentA.id } });
    const afterLoss = await rep.provenState(ctx.talentA.id, "graphic-design");
    assert.equal(afterLoss.proven, false);
    assert.ok(afterLoss.unmet.includes("No dispute lost"));
    await prisma.dispute.deleteMany({ where: { contractId: c.id } });
  });

  it("a late delivery counts against it, an extension the client granted does not", async () => {
    await reset();
    await prisma.skillSubmission.deleteMany({ where: { userId: ctx.talentA.id, skillKey: "graphic-design" } });
    await verifiedIn("graphic-design");
    const a = await completed({ daysAgo: 10 });
    const b = await completed({ daysAgo: 9 });
    const late = await completed({ daysAgo: 8, onTime: false });
    for (const j of [a, b, late]) {
      await prisma.review.create({ data: { jobId: j.job.id, contractId: j.c.id, authorId: ctx.client.id, subjectId: ctx.talentA.id, direction: "client_to_talent", answers: clientAnswers().answers, comment: "", privateAgain: true, windowEndsAt: new Date(Date.now() - 86_400_000) } });
    }
    const state = await rep.provenState(ctx.talentA.id, "graphic-design");
    assert.equal(state.proven, false);
    assert.ok(state.unmet.includes("Every job delivered on time"));
    // The client granted more time: the date moved, so the same delivery is now on time.
    await prisma.contract.update({ where: { id: late.c.id }, data: { deliverByAt: new Date(Date.now() + 86_400_000), extensionsUsed: 1 } });
    assert.equal((await rep.provenState(ctx.talentA.id, "graphic-design")).proven, true);
  });
});

describe("reported reviews", () => {
  async function aReview() {
    const { job } = await completed();
    await api(cl, "POST", `/jobs/${job.id}/review`, { ...clientAnswers(), comment: "Five stars only if you redo the whole logo free." });
    await api(ca, "POST", `/jobs/${job.id}/review`, talentAnswers());
    return prisma.review.findFirst({ where: { jobId: job.id, authorId: ctx.client.id } });
  }

  it("can be reported for one of four reasons, once per person", async () => {
    const review = await aReview();
    assert.equal((await api(ca, "POST", `/reviews/${review.id}/report`, { reasonCode: "i_disagree" })).status, 400);
    const ok = await api(ca, "POST", `/reviews/${review.id}/report`, { reasonCode: "leverage", note: "They asked for free work in return." });
    assert.equal(ok.status, 201);
    assert.equal((await api(ca, "POST", `/reviews/${review.id}/report`, { reasonCode: "leverage" })).json.code, "already_reported");
    assert.equal((await api(cl, "POST", `/reviews/${review.id}/report`, { reasonCode: "abuse" })).json.code, "own_review");
  });

  it("is decided by the safety team: removal needs a rule that was broken, and is audited", async () => {
    const review = await aReview();
    await api(ca, "POST", `/reviews/${review.id}/report`, { reasonCode: "leverage", note: "They asked for free work in return." });
    const report = await prisma.reviewReport.findFirst({ where: { reviewId: review.id } });
    assert.equal((await api(plainTok, "GET", "/admin/review-reports")).status, 403);
    const adm = (p, b) => h.call(server.base, safetyTok, "POST", `/admin/review-reports${p}`, b);
    assert.equal((await adm(`/${report.id}/handle`, { decision: "remove", reasonCode: "disagree", note: "I disagree with it." })).status, 400);
    assert.equal((await adm(`/${report.id}/handle`, { decision: "remove", reasonCode: "leverage", note: "short" })).status, 400);
    const done = await adm(`/${report.id}/handle`, { decision: "remove", reasonCode: "leverage", note: "It makes the stars depend on extra free work." });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.ok((await prisma.review.findUnique({ where: { id: review.id } })).removedAt);
    assert.equal((await adm(`/${report.id}/handle`, { decision: "keep", note: "Second look, keep it." })).status, 409, "someone else already decided");
    assert.ok(await prisma.adminAuditEvent.findFirst({ where: { subjectId: report.id, action: "reviewReport.removed" } }));
    const talentView = await rep.talentReputation(ctx.talentA.id);
    assert.ok(!talentView.reviews.some((r) => r.id === review.id), "a removed review is gone from the profile");
  });
});

describe("portable credentials", () => {
  it("are issued for completed jobs, signed as VC-JWTs, and verify against our key", async () => {
    await reset();
    const { job } = await completed();
    const list = await api(ca, "GET", "/users/me/credentials");
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.signingAvailable, true);
    const mine = list.json.credentials.find((c) => c.title.includes("Completed"));
    assert.ok(mine, "one for the finished job");
    assert.equal(mine.signed, true);
    assert.ok(mine.url);

    const res = await fetch(`${server.base}/credentials/${mine.id}`);
    assert.equal(res.status, 200);
    const jws = await res.text();
    assert.equal(credentials.verify(jws), true, "the signature checks out");
    const [h64, p64] = jws.split(".");
    const header = JSON.parse(Buffer.from(h64, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p64, "base64url").toString());
    assert.equal(header.alg, "RS256");
    assert.ok(header.jwk && header.kid);
    assert.deepEqual(payload.type, ["VerifiableCredential", "OpenBadgeCredential"]);
    assert.equal(payload.iss, payload.issuer.id);
    assert.equal(payload.jti, payload.id);
    assert.equal(payload.sub, payload.credentialSubject.id);
    assert.ok(payload.credentialSubject.achievement.criteria.narrative);
    assert.equal(JSON.stringify(payload).includes(ctx.talentA.email), false, "the email is hashed, not published");
    assert.equal(job.id.length > 0, true);

    const tampered = `${h64}.${Buffer.from(JSON.stringify({ ...payload, name: "Forged" })).toString("base64url")}.${jws.split(".")[2]}`;
    assert.equal(credentials.verify(tampered), false);
    assert.equal((await fetch(`${server.base}/credentials/${mine.id}/json`)).status, 200);
    const issuer = await (await fetch(`${server.base}/credentials/issuer`)).json();
    assert.equal(issuer.type[0], "Profile");
    assert.ok(issuer.publicKeyJwk.n);
  });

  it("issuing twice makes one, and a client gets none", async () => {
    await completed();
    const first = (await api(ca, "GET", "/users/me/credentials")).json.credentials.length;
    const second = (await api(ca, "GET", "/users/me/credentials")).json.credentials.length;
    assert.equal(first, second);
    assert.deepEqual((await api(cl, "GET", "/users/me/credentials")).json.credentials, []);
  });

  it("a revoked one is gone from its link", async () => {
    const list = (await api(ca, "GET", "/users/me/credentials")).json.credentials;
    const row = list[0];
    await prisma.credential.update({ where: { id: row.id }, data: { revokedAt: new Date(), revokedReason: "test" } });
    assert.equal((await fetch(`${server.base}/credentials/${row.id}`)).status, 410);
  });
});

describe("reminders", () => {
  it("asks each person who hasn't reviewed, once per stage, inside the window", async () => {
    await reset();
    const { c } = await completed({ daysAgo: 3 });
    const reminders = require("../src/reviewReminders");
    const first = await reminders.sweepReviewReminders({ prisma });
    assert.ok(first.reviewReminders >= 2, "the client and the talent");
    const again = await reminders.sweepReviewReminders({ prisma });
    assert.equal(again.reviewReminders, 0, "never twice");
    assert.equal(await prisma.contractReminder.count({ where: { contractId: c.id, key: { startsWith: "review_" } } }), 2);
    await reviewsMod.submit({ jobId: c.jobId, userId: ctx.client.id, ...clientAnswers() }, { prisma });
    const later = await reminders.sweepReviewReminders({ prisma, now: () => new Date(Date.now() + 8 * 86_400_000) });
    assert.equal(later.reviewReminders, 1, "only the talent, who still hasn't reviewed, at the second stage");
  });
});
