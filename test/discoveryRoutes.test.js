// S3 over real HTTP: structured job posts and screening, the feed, applying, the soft cap, applicants, invitations,
// browsing talents, saved searches and alerts, and "find someone for me". Storage and Paystack are local fakes.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const discovery = require("../src/discovery");
const { prisma } = h;

const SKILL = "short-form-video";
let ctx, server, fakeProvider, ca, cl, tc, talentC, tcTok;
let safety, support, safetyTok, supportTok;
const admins = [];

const common = { deliverables: "Edit three reels", revisionsIncluded: 1 };
const videoBrief = { ...common, quantity: 3, durationSeconds: 30, aspectRatio: "9:16", rawFootage: "Shared on Drive after award", projectFile: true, usageRights: "organic" };
const siteBrief = { ...common, siteKind: "A new website", pages: 4, builtWith: "Custom code", contentBy: "A mix", hosting: "Set them up in my name" };
const writingBrief = { ...common, writingKind: "Website copy", quantity: 5, wordCount: 800, tone: "Friendly", byline: "Mine: written for me, no credit to the talent", deliveredAs: "Word file" };
const post = (over = {}) => ({ title: `${h.TITLE_PREFIX}Reels for a salon`, description: "Edit three 30 second reels for a hair salon in Yaba.", skillKey: SKILL, jobType: "oneDelivery", brief: videoBrief, price: 25000, currency: "NGN", deliveryDays: 7, screeningQuestions: ["Have you edited reels before?"], ...over });

before(async () => {
  ctx = await h.fixtures();
  fakeProvider = await h.serveFakeProvider(h.fakeProvider());
  server = await h.startServer({ port: 4651, paystackUrl: fakeProvider.url, autoRelease: false });
  talentC = await h.ensureUser("testsuite-talent-c@example.com", "talent", "Suite Talent C");
  safety = await h.ensureAdmin("testsuite-s3-safety@example.com", { capabilities: ["safety"] });
  support = await h.ensureAdmin("testsuite-s3-support@example.com", { capabilities: ["support"] });
  admins.push(safety, support);
  [ca, tc, tcTok, cl, safetyTok, supportTok] = await Promise.all([
    h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB), h.tokenFor(talentC), h.tokenFor(ctx.client), h.adminTokenFor(safety), h.adminTokenFor(support),
  ]);
  await reset();
});
after(async () => {
  server?.stop();
  fakeProvider?.server.close();
  await reset();
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: { in: admins.map((a) => a.id) } } });
  await prisma.$disconnect();
});

const peopleIds = () => [ctx.client.id, ctx.talentA.id, ctx.talentB.id, talentC.id];

async function reset() {
  const ids = peopleIds();
  await prisma.shortlistRequest.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.savedSearch.deleteMany({ where: { userId: { in: ids } } });
  await prisma.savedTalent.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.invitation.deleteMany({ where: { OR: [{ clientId: { in: ids } }, { talentId: { in: ids } }] } });
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.skillSubmission.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.updateMany({ where: { id: { in: ids } }, data: { country: null, state: null, city: null, educationKind: null } });
}

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);

/** A talent verified in a skill: a verified submission with two pieces (and an output file on the first). */
async function makeVerified(user, skillKey = SKILL, { daysAgo = 40 } = {}) {
  const sub = await prisma.skillSubmission.create({
    data: { userId: user.id, skillKey, status: "verified", submittedAt: new Date(Date.now() - (daysAgo + 3) * 86_400_000), decidedAt: new Date(Date.now() - daysAgo * 86_400_000), declaredOwnWork: true },
  });
  const pieces = [];
  for (const n of [1, 2]) {
    pieces.push(await prisma.submissionPiece.create({ data: { submissionId: sub.id, position: n, title: `Reel ${n}`, brief: "A promo", role: "Editor", madeOn: "March 2026" } }));
  }
  await prisma.submissionFile.create({ data: { submissionId: sub.id, pieceId: pieces[0].id, role: "output", name: "reel1.mp4", contentType: "video/mp4", sizeBytes: 1000, objectKey: `submissions/${user.id}/${sub.id}/reel1.mp4`, status: "ready", etag: "e1" } });
  return { sub, pieces };
}

/** A live structured job, written straight to the database (faster than posting it). */
function liveJob(over = {}) {
  return prisma.job.create({
    data: {
      clientId: ctx.client.id, title: `${h.TITLE_PREFIX}${Math.random().toString(36).slice(2, 8)}`, category: "Video & media", description: "A job for the suite to read.", budget: 20000, deliveryDays: 7,
      skillKey: SKILL, jobType: "oneDelivery", currency: "NGN", brief: videoBrief, postStatus: "live", liveAt: new Date(), screeningQuestions: [], ...over,
    },
  });
}

describe("posting a job", () => {
  it("a new client's first structured post is held, with the detector's flags kept, and the owner sees why", async () => {
    const r = await api(cl, "POST", "/jobs", post());
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.heldForScreening, true);
    assert.equal(r.json.screeningReason, "first_post");
    assert.equal(r.json.job.postStatus, "screening");
    assert.equal(r.json.job.jobType, "oneDelivery");
    assert.equal(r.json.job.skillLabel, "Short-form video editing");
    // Talents can't see it yet, and it can't be opened by id.
    const feed = await api(ca, "GET", "/jobs");
    assert.ok(!feed.json.jobs.some((j) => j.id === r.json.job.id));
    assert.equal((await api(ca, "GET", `/jobs/${r.json.job.id}`)).status, 404);
    assert.equal((await api(cl, "GET", `/jobs/${r.json.job.id}`)).status, 200);
  });

  it("names the field that is wrong so the form can focus it", async () => {
    const bad = await api(cl, "POST", "/jobs", post({ brief: { ...videoBrief, aspectRatio: "2:1" } }));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, "aspectRatio");
    assert.equal((await api(cl, "POST", "/jobs", post({ jobType: "contest" }))).status, 400);
    assert.equal((await api(cl, "POST", "/jobs", post({ screeningQuestions: ["a", "b", "c", "d"] }))).status, 400);
    assert.equal((await api(ca, "POST", "/jobs", post())).status, 403, "talent can't post");
  });

  it("a person approves it and it goes live; or turns it down with a reason, and editing sends it back", async () => {
    await reset();
    const first = (await api(cl, "POST", "/jobs", post())).json.job;
    assert.equal((await api(tcTok, "GET", "/admin/job-posts")).status, 401);
    assert.equal((await api(safetyTok, "GET", "/admin/job-posts")).json.posts.some((p) => p.id === first.id), true);
    assert.equal((await api(supportTok, "GET", "/admin/job-posts")).status, 403, "needs the safety role");

    const rej = await api(safetyTok, "POST", `/admin/job-posts/${first.id}/reject`, { reasonCode: "vague" });
    assert.equal(rej.status, 200);
    assert.equal((await api(safetyTok, "POST", `/admin/job-posts/${first.id}/reject`, { reasonCode: "vague" })).status, 409, "the second click finds it handled");
    const mine = (await api(cl, "GET", `/jobs/${first.id}`)).json.job;
    assert.equal(mine.postStatus, "rejected");
    assert.equal(mine.rejection.reasonCode, "vague");

    // Editing a turned-down post resubmits it.
    const edited = await api(cl, "PATCH", `/jobs/${first.id}`, post({ description: "Edit three 30 second reels for a hair salon, brand colours attached." }));
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.resubmitted, true);
    assert.equal(edited.json.job.postStatus, "screening");

    assert.equal((await api(safetyTok, "POST", `/admin/job-posts/${first.id}/approve`)).status, 200);
    const live = (await api(ca, "GET", `/jobs/${first.id}`)).json;
    assert.equal(live.job.postStatus, "live");
    assert.equal(live.clientRecord.jobsPosted >= 1, true);
    const audits = await prisma.adminAuditEvent.findMany({ where: { subjectId: first.id } });
    assert.ok(["jobPost.reject", "jobPost.approve"].every((a) => audits.some((e) => e.action === a)));
  });

  it("an established client's next post goes live at once, unless it asks for money outside the app", async () => {
    await reset();
    await liveJob(); // a first post that already went live
    const ok = await api(cl, "POST", "/jobs", post({ title: `${h.TITLE_PREFIX}Second post here` }));
    assert.equal(ok.json.heldForScreening, false);
    assert.equal(ok.json.job.postStatus, "live");
    const sneaky = await api(cl, "POST", "/jobs", post({ title: `${h.TITLE_PREFIX}Pay me directly please`, description: "Edit reels, and pay me directly outside the app after." }));
    assert.equal(sneaky.json.heldForScreening, true);
    assert.equal(sneaky.json.screeningReason, "flagged");
    const held = (await api(safetyTok, "GET", `/admin/job-posts/${sneaky.json.job.id}`)).json.post;
    assert.ok(held.flags.some((f) => f.code === "outside_payment"));
  });

  it("each job type derives its price from its brief", async () => {
    await reset();
    await liveJob();
    const ms = await api(cl, "POST", "/jobs", post({ skillKey: "web-development", jobType: "milestones", brief: { ...siteBrief, milestones: [{ title: "Design", amount: 30000, days: 7 }, { title: "Build", amount: 70000, days: 14 }] }, price: undefined, deliveryDays: undefined }));
    assert.equal(ms.status, 201, JSON.stringify(ms.json));
    assert.equal(ms.json.job.budget, "100000");
    assert.equal(ms.json.job.deliveryDays, 21);
    const hr = await api(cl, "POST", "/jobs", post({ skillKey: "writing", jobType: "hourly", brief: { ...writingBrief, hourlyRate: 3000, weeklyCapHours: 10, weeks: 4 }, price: undefined, deliveryDays: undefined }));
    assert.equal(hr.json.job.budget, "30000");
    assert.equal(hr.json.job.jobType, "hourly");
  });
});

describe("the feed", () => {
  it("filters on the server and pages without repeating or dropping a job", async () => {
    await reset();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await liveJob({ title: `${h.TITLE_PREFIX}Feed ${i}`, budget: 10000 * (i + 1), createdAt: new Date(Date.now() - i * 60_000) }));
    await liveJob({ title: `${h.TITLE_PREFIX}Feed usd`, currency: "USD", budget: 200 });
    await liveJob({ title: `${h.TITLE_PREFIX}Feed writing`, skillKey: "writing", jobType: "monthly", budget: 40000 });

    const all = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await api(ca, "GET", `/jobs?limit=3&q=${encodeURIComponent(h.TITLE_PREFIX + "Feed")}${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(r.status, 200);
      all.push(...r.json.jobs.map((j) => j.id));
      cursor = r.json.nextCursor;
      pages++;
    } while (cursor && pages < 6);
    assert.equal(all.length, 7);
    assert.equal(new Set(all).size, 7, "no job twice across pages");

    const writing = (await api(ca, "GET", "/jobs?skill=writing&q=Feed")).json.jobs;
    assert.equal(writing.length, 1);
    assert.equal(writing[0].jobType, "monthly");
    assert.equal((await api(ca, "GET", "/jobs?market=international&q=Feed")).json.jobs.length, 1);
    assert.equal((await api(ca, "GET", "/jobs?market=local&q=Feed")).json.jobs.length, 6);
    assert.equal((await api(ca, "GET", "/jobs?type=monthly&q=Feed")).json.jobs.length, 1);
    const mid = (await api(ca, "GET", "/jobs?budgetMin=20000&budgetMax=40000&market=local&skill=short-form-video&q=Feed")).json.jobs;
    assert.deepEqual(mid.map((j) => Number(j.budget)).sort((a, b) => a - b), [20000, 30000, 40000]);
  });

  it("Jobs for you puts the talent's verified skills first, then the rest", async () => {
    await reset();
    await makeVerified(ctx.talentA, SKILL);
    await liveJob({ title: `${h.TITLE_PREFIX}Other older`, skillKey: "writing", jobType: "oneDelivery", createdAt: new Date(Date.now() - 10 * 60_000) });
    await liveJob({ title: `${h.TITLE_PREFIX}Mine newer`, createdAt: new Date(Date.now() - 20 * 60_000) });
    const r = (await api(ca, "GET", `/jobs?forYou=true&q=${encodeURIComponent(h.TITLE_PREFIX)}`)).json.jobs;
    assert.deepEqual(r.map((j) => j.title), [`${h.TITLE_PREFIX}Mine newer`, `${h.TITLE_PREFIX}Other older`], "the verified skill's job leads even though it is older");
  });

  it("an invite-only job is invisible to everyone but its owner and the invited", async () => {
    await reset();
    await makeVerified(ctx.talentA);
    const job = await liveJob({ visibility: "invite" });
    assert.ok(!(await api(ca, "GET", "/jobs")).json.jobs.some((j) => j.id === job.id));
    assert.ok((await api(cl, "GET", "/jobs?mine=true")).json.jobs.some((j) => j.id === job.id));
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/invitations`, { talentId: ctx.talentA.id })).status, 201);
    assert.ok((await api(ca, "GET", "/jobs")).json.jobs.some((j) => j.id === job.id));
  });
});

describe("applying, the cap, and the applicants", () => {
  async function ready() {
    await reset();
    const v = await makeVerified(ctx.talentA);
    const job = await liveJob({ screeningQuestions: ["Have you edited reels before?"] });
    return { v, job };
  }
  const apply = (job, body) => api(ca, "POST", `/jobs/${job.id}/apply`, { revision: job.revision, ...body });

  it("needs an answer, 1 to 3 verified pieces and an answer to every question", async () => {
    const { v, job } = await ready();
    const good = { answer: "I have edited reels for two salons and know the style.", pieces: [{ type: "piece", id: v.pieces[0].id }], screeningAnswers: ["Yes, twenty of them."] };
    assert.equal((await apply(job, { ...good, answer: "short" })).status, 400);
    assert.equal((await apply(job, { ...good, pieces: [] })).status, 400);
    assert.equal((await apply(job, { ...good, pieces: [{ type: "piece", id: v.pieces[0].id }, { type: "piece", id: v.pieces[0].id }] })).status, 400, "the same piece twice");
    assert.equal((await apply(job, { ...good, screeningAnswers: [] })).status, 400);
    const stranger = await prisma.submissionPiece.findFirst({ where: { submission: { userId: { not: ctx.talentA.id } } } });
    if (stranger) assert.equal((await apply(job, { ...good, pieces: [{ type: "piece", id: stranger.id }] })).status, 400, "someone else's piece");
    const ok = await apply(job, good);
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal((await apply(job, good)).status, 409, "once only");
  });

  it("a talent not verified in the job's skill is refused", async () => {
    await reset();
    const job = await liveJob();
    const r = await api(ca, "POST", `/jobs/${job.id}/apply`, { answer: "I would love to do this one, here is why.", pieces: [{ type: "piece", id: "x" }], screeningAnswers: [] });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "not_verified_in_skill");
  });

  it("pauses after 5 days, still takes an invited talent, and a reopen starts it again", async () => {
    const { v, job } = await ready();
    const good = { answer: "I have edited reels for two salons and know the style.", pieces: [{ type: "piece", id: v.pieces[0].id }], screeningAnswers: ["Yes, twenty of them."] };
    await prisma.job.update({ where: { id: job.id }, data: { liveAt: new Date(Date.now() - 6 * 86_400_000) } });
    const stale = (await api(ca, "GET", `/jobs/${job.id}`)).json.job;
    assert.equal(stale.paused, true);
    assert.equal(stale.pausedReason, "days");
    const blocked = await apply(job, good);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, "cap_paused");

    // The client reopens (premium gate is off until billing exists), and the talent can apply.
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/reopen`)).status, 403, "only the client");
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/reopen`)).status, 200);
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/reopen`)).json.code, "not_paused");
    assert.equal((await apply(job, good)).status, 201);
  });

  it("an invited talent can apply to a paused job", async () => {
    const { v, job } = await ready();
    await prisma.job.update({ where: { id: job.id }, data: { liveAt: new Date(Date.now() - 6 * 86_400_000) } });
    await api(cl, "POST", `/jobs/${job.id}/invitations`, { talentId: ctx.talentA.id, message: "Your reel on the salon was lovely." });
    const r = await apply(job, { answer: "I have edited reels for two salons and know the style.", pieces: [{ type: "piece", id: v.pieces[0].id }], screeningAnswers: ["Yes."] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const inv = (await api(ca, "GET", "/users/me/invitations")).json.invitations;
    assert.equal(inv[0].status, "accepted", "applying accepts the invitation");
  });

  it("shows the client each applicant with facts and chosen work, lets them shortlist and decline, and tells a declined talent", async () => {
    const { v, job } = await ready();
    await apply(job, { answer: "I have edited reels for two salons and know the style.", pieces: [{ type: "piece", id: v.pieces[0].id }], screeningAnswers: ["Yes."] });
    const list = (await api(cl, "GET", `/jobs/${job.id}/applications`)).json;
    assert.equal(list.cap.applicantCount, 1);
    assert.equal(list.cap.applicantCap, 50);
    const a = list.applications[0];
    assert.equal(a.panel.talent.fullName, "Suite Talent A");
    assert.equal(a.panel.talent.verifiedSkills[0].skillKey, SKILL);
    assert.equal(a.panel.pieces[0].title, "Reel 1");
    assert.equal(a.panel.screening[0].answer, "Yes.");
    assert.equal(a.panel.talent.newOnKingDomain, false, "verified 40 days ago");

    assert.equal((await api(ca, "POST", `/jobs/${job.id}/applications/${a.id}/shortlist`)).status, 403, "only the client");
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/applications/${a.id}/shortlist`, {})).status, 200);
    assert.equal((await prisma.application.findUnique({ where: { id: a.id } })).status, "shortlisted");
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/applications/${a.id}/shortlist`, { shortlisted: false })).status, 200);
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/applications/${a.id}/decline`)).status, 200);
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/applications/${a.id}/decline`)).status, 409, "already declined");
    const mine = (await api(ca, "GET", `/jobs/${job.id}`)).json.job;
    assert.equal(mine.myApplicationStatus, "declined", "the talent can see they were declined");
  });
});

describe("browsing talents, invitations, saved talents", () => {
  it("lists verified talents recently active first with facts, filters by region, and never as a score", async () => {
    await reset();
    await makeVerified(ctx.talentA, SKILL, { daysAgo: 40 });
    await makeVerified(ctx.talentB, SKILL, { daysAgo: 5 });
    await prisma.user.update({ where: { id: ctx.talentA.id }, data: { lastActiveAt: new Date(Date.now() - 3 * 86_400_000), country: "Nigeria", state: "Lagos", city: "Yaba", educationKind: "student" } });
    await prisma.user.update({ where: { id: ctx.talentB.id }, data: { lastActiveAt: new Date(), country: "Nigeria", state: "Oyo", educationKind: "graduate" } });

    const r = (await api(cl, "GET", `/talents?skill=${SKILL}`)).json;
    const ids = r.talents.map((t) => t.id);
    assert.ok(ids.indexOf(ctx.talentB.id) < ids.indexOf(ctx.talentA.id), "most recently active first");
    const b = r.talents.find((t) => t.id === ctx.talentB.id);
    assert.equal(b.newOnKingDomain, true, "verified 5 days ago, nothing completed");
    assert.equal(b.lastActive, "today");
    assert.ok(!("score" in b) && !("rank" in b));

    assert.deepEqual((await api(cl, "GET", `/talents?skill=${SKILL}&state=Lagos`)).json.talents.map((t) => t.id), [ctx.talentA.id]);
    assert.deepEqual((await api(cl, "GET", `/talents?skill=${SKILL}&education=graduate`)).json.talents.map((t) => t.id), [ctx.talentB.id]);
    assert.equal((await api(cl, "GET", "/talents?skill=writing")).json.talents.length, 0);
    assert.equal((await api(ca, "GET", "/talents")).status, 403, "talents can't browse talents");
  });

  it("opens a profile with the verified pieces, and saves and unsaves a talent", async () => {
    await reset();
    await makeVerified(ctx.talentA);
    const p = (await api(cl, "GET", `/talents/${ctx.talentA.id}`)).json;
    assert.equal(p.work[0].skillKey, SKILL);
    assert.equal(p.work[0].pieces[0].title, "Reel 1");
    assert.equal(p.work[0].pieces[0].files[0].name, "reel1.mp4");
    assert.equal((await api(cl, "POST", `/talents/${ctx.talentA.id}/save`)).json.saved, true);
    assert.equal((await api(cl, "GET", "/users/me/saved-talents")).json.talents[0].id, ctx.talentA.id);
    assert.equal((await api(cl, "GET", `/talents?skill=${SKILL}`)).json.talents.find((t) => t.id === ctx.talentA.id).saved, true);
    assert.equal((await api(cl, "DELETE", `/talents/${ctx.talentA.id}/save`)).json.saved, false);
    assert.equal((await api(cl, "GET", "/users/me/saved-talents")).json.talents.length, 0);
    assert.equal((await api(cl, "GET", "/talents/nobody")).status, 404);
  });

  it("invites only a verified talent, once, without contact details; the talent answers or it expires", async () => {
    await reset();
    await makeVerified(ctx.talentA);
    const job = await liveJob();
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/invitations`, { talentId: ctx.talentB.id })).json.code, "not_verified");
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/invitations`, { talentId: ctx.talentA.id, message: "call me on 08031234567" })).json.code, "risky_message");
    const ok = await api(cl, "POST", `/jobs/${job.id}/invitations`, { talentId: ctx.talentA.id, message: "Your work looks right for this." });
    assert.equal(ok.status, 201);
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/invitations`, { talentId: ctx.talentA.id })).json.code, "already_invited");
    const mine = (await api(ca, "GET", "/users/me/invitations")).json.invitations;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, "pending");
    assert.equal(mine[0].job.id, job.id);
    assert.equal((await api(ca, "POST", `/users/me/invitations/${mine[0].id}/respond`, { accept: false })).status, 200);
    assert.equal((await api(ca, "POST", `/users/me/invitations/${mine[0].id}/respond`, { accept: true })).json.code, "not_pending");

    // Past 72 hours it reads as expired.
    const job2 = await liveJob();
    await api(cl, "POST", `/jobs/${job2.id}/invitations`, { talentId: ctx.talentA.id });
    await prisma.invitation.updateMany({ where: { jobId: job2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const after = (await api(ca, "GET", "/users/me/invitations")).json.invitations.find((i) => i.job.id === job2.id);
    assert.equal(after.status, "expired");
  });
});

describe("saved searches and alerts", () => {
  it("saves, lists, switches alerts and deletes a search; a search needs at least one filter", async () => {
    await reset();
    assert.equal((await api(ca, "POST", "/users/me/saved-searches", { name: "Empty", filters: {} })).status, 400);
    const made = await api(ca, "POST", "/users/me/saved-searches", { name: "Reels in Naira", filters: { skillKeys: [SKILL], currency: "NGN", budgetMin: 10000 } });
    assert.equal(made.status, 201);
    assert.equal((await api(ca, "GET", "/users/me/saved-searches")).json.searches.length, 1);
    assert.equal((await api(ca, "PATCH", `/users/me/saved-searches/${made.json.search.id}`, { alerts: false })).status, 200);
    assert.equal((await api(cl, "GET", "/users/me/saved-searches")).status, 403, "talents only");
    assert.equal((await api(ca, "DELETE", `/users/me/saved-searches/${made.json.search.id}`)).status, 200);
    assert.equal((await api(ca, "GET", "/users/me/saved-searches")).json.searches.length, 0);
  });

  it("a job going live alerts each matching talent once, and nobody whose alerts are off", async () => {
    await reset();
    await prisma.savedSearch.createMany({
      data: [
        { userId: ctx.talentA.id, name: "Mine", filters: { skillKeys: [SKILL] }, alerts: true },
        { userId: ctx.talentA.id, name: "Mine again", filters: { currency: "NGN" }, alerts: true },
        { userId: ctx.talentB.id, name: "Off", filters: { skillKeys: [SKILL] }, alerts: false },
        { userId: talentC.id, name: "Other skill", filters: { skillKeys: ["writing"] }, alerts: true },
      ],
    });
    const job = await liveJob();
    const told = [];
    const r = await discovery.alertSavedSearches(job, { notify: async (userId, msg) => told.push({ userId, title: msg.title }) });
    assert.equal(r.alerted, 1);
    assert.deepEqual(told.map((t) => t.userId), [ctx.talentA.id], "A matched two searches but is told once");
    assert.match(told[0].title, /New job/);
    const invite = await liveJob({ visibility: "invite" });
    assert.equal((await discovery.alertSavedSearches(invite, { notify: async () => {} })).alerted, 0, "invite-only jobs are never announced");
  });
});

describe("find someone for me", () => {
  const request = (over = {}) => ({ skillKey: SKILL, jobType: "oneDelivery", currency: "NGN", price: 30000, brief: videoBrief, note: "A salon chain wants a steady editor.", ...over });

  it("asks the talents first, sends only those who said yes, and the promise comes from real times", async () => {
    await reset();
    await makeVerified(ctx.talentA);
    await makeVerified(ctx.talentB, SKILL, { daysAgo: 3 });
    await makeVerified(talentC);
    const promise0 = (await api(cl, "GET", "/shortlists/promise")).json;
    assert.equal(promise0.hours, null, "no promise while there is nothing to base it on");

    const bad = await api(cl, "POST", "/shortlists", request({ note: "whatsapp me" }));
    assert.equal(bad.status, 400);
    const made = await api(cl, "POST", "/shortlists", request());
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = made.json.request.id;
    assert.equal(made.json.request.status, "requested");

    // The team builds it.
    assert.equal((await api(safetyTok, "GET", "/admin/shortlists")).status, 403, "support role only");
    const detail = (await api(supportTok, "GET", `/admin/shortlists/${id}`)).json;
    assert.equal(detail.candidates.length >= 3, true);
    assert.equal(detail.candidates.find((c) => c.id === ctx.talentB.id).newOnKingDomain, true, "a verified newcomer is marked so one can be included");
    assert.equal((await api(supportTok, "POST", `/admin/shortlists/${id}/items`, { talentId: ctx.talentA.id, reason: "short" })).status, 400, "a real line on why");
    for (const t of [ctx.talentA, ctx.talentB, talentC]) {
      const r = await api(supportTok, "POST", `/admin/shortlists/${id}/items`, { talentId: t.id, reason: "Edited reels for salons and gyms, quick turnaround." });
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    assert.equal((await api(supportTok, "POST", `/admin/shortlists/${id}/send`)).json.code, "wrong_count", "nobody has said yes yet");

    // Each is asked first.
    const asks = (await api(ca, "GET", "/users/me/shortlist-asks")).json.asks;
    assert.equal(asks.length, 1);
    assert.equal((await api(ca, "POST", `/users/me/shortlist-asks/${(await prisma.shortlistItem.findFirst({ where: { talentId: ctx.talentA.id, requestId: id } })).id}`, { available: true })).status, 200);
    const itemB = await prisma.shortlistItem.findFirst({ where: { talentId: ctx.talentB.id, requestId: id } });
    assert.equal((await api(tc, "POST", `/users/me/shortlist-asks/${itemB.id}`, { available: true })).status, 200);
    const itemC = await prisma.shortlistItem.findFirst({ where: { talentId: talentC.id, requestId: id } });
    assert.equal((await api(tcTok, "POST", `/users/me/shortlist-asks/${itemC.id}`, { available: false })).status, 200);
    assert.equal((await api(tcTok, "POST", `/users/me/shortlist-asks/${itemC.id}`, { available: true })).status, 409, "an answer is final");
    assert.equal((await api(supportTok, "POST", `/admin/shortlists/${id}/send`)).json.code, "wrong_count", "two yeses is not enough");
    await prisma.shortlistItem.update({ where: { id: itemC.id }, data: { available: true } });

    assert.equal((await api(supportTok, "POST", `/admin/shortlists/${id}/send`)).status, 200);
    assert.equal((await api(supportTok, "POST", `/admin/shortlists/${id}/send`)).status, 409);
    const mine = (await api(cl, "GET", "/shortlists")).json.requests[0];
    assert.equal(mine.status, "sent");
    assert.equal(mine.shortlist.length, 3);
    assert.ok(mine.shortlist.every((s) => s.reason && s.talent.fullName));

    // The promise: the 90th percentile of recent shortlists, whole hours, once there are 5.
    const hours = [2, 3, 3, 4, 30];
    for (const hr of hours) {
      const at = new Date(Date.now() - 86_400_000);
      await prisma.shortlistRequest.create({ data: { clientId: ctx.client.id, skillKey: SKILL, budget: 1, brief: {}, status: "sent", clockStartedAt: at, sentAt: new Date(at.getTime() + hr * 3_600_000) } });
    }
    assert.equal((await api(cl, "GET", "/shortlists/promise")).json.hours, 30, "9th of 5 clamps to the slowest, so the promise is kept");
  });
});

describe("the inbox", () => {
  it("shows the two new queues to the right roles", async () => {
    const forSafety = (await api(safetyTok, "GET", "/admin/inbox")).json.queues.map((q) => q.key);
    assert.ok(forSafety.includes("job-post") && !forSafety.includes("shortlist"));
    const forSupport = (await api(supportTok, "GET", "/admin/inbox")).json.queues.map((q) => q.key);
    assert.ok(forSupport.includes("shortlist") && !forSupport.includes("job-post"));
  });
});

describe("the brief form", () => {
  it("serves the fields for a skill and type, and refuses a contest", async () => {
    const ok = await api(cl, "GET", `/briefs/spec?skill=${SKILL}&type=hourly`);
    assert.equal(ok.status, 200);
    assert.ok(ok.json.spec.fields.some((f) => f.key === "aspectRatio"));
    assert.ok(ok.json.spec.fields.some((f) => f.key === "weeklyCapHours"));
    assert.deepEqual(ok.json.jobTypes, ["oneDelivery", "milestones", "monthly", "hourly"]);
    assert.equal((await api(cl, "GET", `/briefs/spec?skill=${SKILL}&type=contest`)).status, 404);
  });
});

describe("scope=mine", () => {
  it("returns every job the person posted or applied to, including closed ones, and nothing else", async () => {
    await reset();
    const mine = await liveJob({ title: `${h.TITLE_PREFIX}Mine posted` });
    const closed = await liveJob({ title: `${h.TITLE_PREFIX}Mine closed`, closedAt: new Date() });
    const applied = await liveJob({ title: `${h.TITLE_PREFIX}Applied to` });
    await prisma.application.create({ data: { jobId: applied.id, talentId: ctx.talentA.id } });
    const other = await liveJob({ title: `${h.TITLE_PREFIX}Not mine` });
    const asClient = (await api(cl, "GET", "/jobs?scope=mine&limit=50")).json.jobs.map((j) => j.id);
    for (const j of [mine, closed, applied, other]) assert.ok(asClient.includes(j.id), "the client posted all four");
    const asTalent = (await api(ca, "GET", "/jobs?scope=mine&limit=50")).json.jobs.map((j) => j.id);
    assert.deepEqual(asTalent, [applied.id]);
  });
});

describe("awarded and closed jobs", () => {
  it("leave the open feed for talents who never applied, and stay for the owner and the applicants", async () => {
    await reset();
    const open = await liveJob({ title: `${h.TITLE_PREFIX}Still open` });
    const filled = await liveJob({ title: `${h.TITLE_PREFIX}Already filled` });
    const app = await prisma.application.create({ data: { jobId: filled.id, talentId: ctx.talentB.id, status: "selected" } });
    await prisma.job.update({ where: { id: filled.id }, data: { awardedApplicationId: app.id } });
    const ids = (tok) => api(tok, "GET", `/jobs?q=${encodeURIComponent(h.TITLE_PREFIX)}&limit=50`).then((r) => r.json.jobs.map((j) => j.id));
    const forA = await ids(ca);
    assert.ok(forA.includes(open.id));
    assert.ok(!forA.includes(filled.id), "filled by someone else");
    assert.ok((await ids(tc)).includes(filled.id), "the talent who was picked still sees it");
    assert.ok((await ids(cl)).includes(filled.id), "the owner too");
  });
});
