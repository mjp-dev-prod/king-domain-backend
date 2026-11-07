// S8, packages: a verified talent publishes up to three tiers per skill, a client browses and orders, the talent has 48
// hours to accept, and an accepted order is an ordinary awarded job (pay within 24 hours, then the usual rules).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const packages = require("../src/packages");
const paystack = require("../src/paystack");
const { prisma } = h;

let ctx, server, fakeProvider, cl, ca, tb;

before(async () => {
  ctx = await h.fixtures();
  fakeProvider = await h.serveFakeProvider(h.fakeProvider());
  server = await h.startServer({ port: 4701, paystackUrl: fakeProvider.url, autoRelease: false });
  [cl, ca, tb] = await Promise.all([h.tokenFor(ctx.client), h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB)]);
  await reset();
  await prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey: "graphic-design", status: "verified", decidedAt: new Date() } }).catch(() => {});
});
after(async () => {
  server?.stop();
  fakeProvider?.server.close();
  await reset();
  await prisma.skillSubmission.deleteMany({ where: { userId: ctx.talentA.id, skillKey: "graphic-design" } });
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);

async function reset() {
  await prisma.packageOrder.deleteMany({ where: { OR: [{ clientId: ctx.client.id }, { talentId: ctx.talentA.id }] } });
  await prisma.package.deleteMany({ where: { talentId: { in: [ctx.talentA.id, ctx.talentB.id] } } });
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
}

const scope = { designKind: "Logo or brand identity", quantity: 2, concepts: 2, files: ["Transparent PNG", "Editable source file"] };
const input = (over = {}) => ({ title: `${h.TITLE_PREFIX}Logo pack`, summary: "A clean logo with two concepts.", included: "Two concepts, one chosen and refined, final files.", scope, revisions: 2, deliveryDays: 5, price: 20000, ...over });

describe("publishing", () => {
  it("only in a skill the talent is verified in, and only talents", async () => {
    assert.equal((await api(tb, "PUT", "/users/me/packages/graphic-design/basic", input())).json.code, "not_verified");
    assert.equal((await api(cl, "PUT", "/users/me/packages/graphic-design/basic", input())).status, 403);
    const ok = await api(ca, "PUT", "/users/me/packages/graphic-design/basic", input());
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.package.price, 20000);
    assert.equal(ok.json.package.tier, "basic");
  });

  it("is up to three tiers per skill, and saving again updates the same one", async () => {
    await api(ca, "PUT", "/users/me/packages/graphic-design/standard", input({ price: 35000, title: `${h.TITLE_PREFIX}Brand kit` }));
    await api(ca, "PUT", "/users/me/packages/graphic-design/premium", input({ price: 60000, title: `${h.TITLE_PREFIX}Full identity` }));
    assert.equal((await api(ca, "PUT", "/users/me/packages/graphic-design/fourth", input())).status, 400);
    await api(ca, "PUT", "/users/me/packages/graphic-design/basic", input({ price: 22000 }));
    const mine = await api(ca, "GET", "/users/me/packages");
    assert.equal(mine.json.packages.length, 3);
    assert.equal(mine.json.packages.find((p) => p.tier === "basic").price, 22000);
    assert.deepEqual(mine.json.skills.map((s) => s.skillKey), ["graphic-design"]);
    assert.deepEqual(mine.json.skills[0].fields.map((f) => f.key), ["designKind", "quantity", "concepts", "files"], "the skill's own package fields");
    const basic = mine.json.packages.find((p) => p.tier === "basic");
    assert.equal(basic.needsUpdate, false);
    assert.deepEqual(basic.scopeLines.map((l) => [l.label, l.value]), [["What kind of design", "Logo or brand identity"], ["How many designs", "2"], ["First ideas to choose from", "2"], ["Files you get", "Transparent PNG, Editable source file"]]);
  });

  it("refuses what the standard fields don't allow, and contact details or outside payment", () => {
    const v = (over) => packages.validatePackage("graphic-design", input(over));
    assert.equal(v({ price: 10 }).field, "price");
    assert.equal(v({ revisions: 5 }).field, "revisions");
    assert.equal(v({ deliveryDays: 0 }).field, "deliveryDays");
    assert.equal(v({ title: "ab" }).field, "title");
    const flagged = v({ summary: "Call me on 08031234567 and pay outside the app." });
    assert.equal(flagged.code, "flagged");
    assert.equal(v({}).ok, true);
    assert.equal(v({ scope: { ...scope, files: [] } }).field, "files", "a design package says which files you get");
    assert.equal(v({ scope: undefined }).field, "designKind");
    // A website package is scoped like a website: pages, features, what it is built with. Never "formats or sizes".
    const web = packages.validatePackage("web-development", input({ scope: { siteKind: "A landing page", pages: 1, features: ["Contact form"], builtWith: "Wix" } }));
    assert.equal(web.ok, true, JSON.stringify(web));
    assert.deepEqual(Object.keys(web.value.scope).sort(), ["builtWith", "features", "pages", "products", "siteKind"]);
  });

  it("can be paused (and then isn't browsable), and removed", async () => {
    const mine = (await api(ca, "GET", "/users/me/packages")).json.packages;
    const basic = mine.find((p) => p.tier === "basic");
    assert.equal((await api(ca, "PATCH", `/users/me/packages/${basic.id}`, { status: "paused" })).status, 200);
    const browse = await api(cl, "GET", "/packages?skill=graphic-design");
    assert.ok(!browse.json.packages.some((p) => p.id === basic.id));
    assert.equal((await api(ca, "PATCH", `/users/me/packages/${basic.id}`, { status: "active" })).status, 200);
    assert.ok((await api(cl, "GET", "/packages?skill=graphic-design")).json.packages.some((p) => p.id === basic.id));
  });
});

describe("browsing", () => {
  it("is for clients, by skill, with the talent and no score or rank", async () => {
    assert.equal((await api(ca, "GET", "/packages")).status, 403);
    const r = await api(cl, "GET", "/packages?skill=graphic-design");
    assert.equal(r.status, 200);
    assert.ok(r.json.packages.length >= 3);
    const first = r.json.packages[0];
    assert.equal(first.talent.id, ctx.talentA.id);
    assert.ok(first.talent.lastActive);
    assert.equal(JSON.stringify(r.json).match(/score|rank|rating/i), null);
  });

  it("a package whose talent is no longer verified isn't listed", async () => {
    await prisma.skillSubmission.updateMany({ where: { userId: ctx.talentA.id, skillKey: "graphic-design" }, data: { status: "notYet" } });
    assert.equal((await api(cl, "GET", "/packages?skill=graphic-design")).json.packages.length, 0);
    await prisma.skillSubmission.updateMany({ where: { userId: ctx.talentA.id, skillKey: "graphic-design" }, data: { status: "verified" } });
  });

  it("the detail asks only for what the package doesn't already say", async () => {
    const list = (await api(cl, "GET", "/packages?skill=graphic-design")).json.packages;
    const d = await api(cl, "GET", `/packages/${list[0].id}`);
    assert.equal(d.status, 200, JSON.stringify(d.json));
    const keys = d.json.formFields.map((f) => f.key);
    for (const k of ["deliverables", "revisionsIncluded", "designKind", "quantity", "concepts", "files"]) assert.ok(!keys.includes(k), `the package already says ${k}`);
    assert.ok(keys.includes("usageRights"));
    assert.ok(keys.includes("dimensions"), "the size is the client's to say");
    assert.ok(d.json.package.scopeLines.length >= 3, "what the package states, in words");
    assert.ok(d.json.fee > 0);
  });
});

describe("packages saved before the skill's own fields (2026-11-07)", () => {
  it("are kept for the talent, marked to update, and hidden from clients until updated", async () => {
    await reset();
    await prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey: "graphic-design", status: "verified", decidedAt: new Date() } }).catch(() => {});
    const old = await prisma.package.create({ data: { talentId: ctx.talentA.id, skillKey: "graphic-design", tier: "basic", title: `${h.TITLE_PREFIX}Old logo pack`, summary: "A logo the old way.", price: 20000, deliveryDays: 5, revisions: 1, included: "One logo and its files.", quantity: 1, formats: "PNG" } });
    const mine = (await api(ca, "GET", "/users/me/packages")).json.packages.find((p) => p.id === old.id);
    assert.equal(mine.needsUpdate, true);
    assert.deepEqual(mine.scopeLines.map((l) => l.value), ["1", "PNG"], "the old answers still read");
    assert.ok(!(await api(cl, "GET", "/packages?skill=graphic-design")).json.packages.some((p) => p.id === old.id));
    assert.equal((await api(cl, "GET", `/packages/${old.id}`)).status, 404);
    assert.equal((await api(cl, "POST", `/packages/${old.id}/order`, { brief: { usageRights: "organic", dimensions: "A4" } })).status, 404);
    const saved = await api(ca, "PUT", "/users/me/packages/graphic-design/basic", input({ price: 22000 }));
    assert.equal(saved.json.package.needsUpdate, false);
    const row = await prisma.package.findUnique({ where: { id: old.id } });
    assert.equal(row.formats, null, "updating clears the old answers");
    assert.ok((await api(cl, "GET", "/packages?skill=graphic-design")).json.packages.some((p) => p.id === old.id));
  });
});

describe("ordering", () => {
  const brief = { usageRights: "organic", dimensions: "1080x1080", quantity: 40 };

  async function aPackage() {
    return (await prisma.package.findFirst({ where: { talentId: ctx.talentA.id, tier: "basic" } }));
  }

  it("makes a private job for this talent alone, with 48 hours to answer", async () => {
    const pkg = await aPackage();
    const r = await api(cl, "POST", `/packages/${pkg.id}/order`, { brief, note: "For our cafe opening." });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const job = await prisma.job.findUnique({ where: { id: r.json.jobId }, include: { applications: true } });
    assert.equal(job.visibility, "invite");
    assert.equal(Number(job.budget), 22000);
    assert.equal(job.skillKey, "graphic-design");
    assert.equal(job.brief.quantity, 2, "the package's own answers are in the brief");
    assert.deepEqual(job.brief.files, ["Transparent PNG", "Editable source file"]);
    assert.equal(job.brief.usageRights, "organic");
    assert.notEqual(job.brief.quantity, 40, "the client can't change what the package states");
    assert.equal(job.applications.length, 1);
    assert.equal(job.applications[0].talentId, ctx.talentA.id);
    const order = await prisma.packageOrder.findUnique({ where: { id: r.json.orderId } });
    // The deadline is set from the clock a moment before the database stamps createdAt, so allow a few seconds.
    assert.ok(Math.abs(order.answerDueAt - order.createdAt - 48 * 3_600_000) < 5_000, "48 hours to answer");
    assert.equal((await api(cl, "POST", `/packages/${pkg.id}/order`, { brief })).json.code, "already_ordered");
  });

  it("the brief form is checked, and contact details are caught", async () => {
    await reset();
    await prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey: "graphic-design", status: "verified", decidedAt: new Date() } }).catch(() => {});
    await api(ca, "PUT", "/users/me/packages/graphic-design/basic", input());
    const pkg = await aPackage();
    assert.equal((await api(cl, "POST", `/packages/${pkg.id}/order`, { brief: { usageRights: "anything" } })).status, 400);
    const flagged = await api(cl, "POST", `/packages/${pkg.id}/order`, { brief: { ...brief, dimensions: "WhatsApp me on 08031234567" } });
    assert.equal(flagged.json.code, "flagged");
    assert.equal((await api(ca, "POST", `/packages/${pkg.id}/order`, { brief })).status, 403, "a talent can't order");
  });

  it("accepting awards the job: the client has 24 hours to pay", async () => {
    const pkg = await aPackage();
    const r = await api(cl, "POST", `/packages/${pkg.id}/order`, { brief });
    const orders = await api(ca, "GET", "/users/me/package-orders");
    assert.equal(orders.json.orders[0].status, "requested");
    assert.equal(orders.json.orders[0].other.length > 0, true);
    assert.ok([403, 404].includes((await api(tb, "POST", `/package-orders/${r.json.orderId}/accept`)).status), "someone else's order is not theirs to accept");
    const accepted = await api(ca, "POST", `/package-orders/${r.json.orderId}/accept`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    const contract = await prisma.contract.findUnique({ where: { jobId: r.json.jobId } });
    assert.equal(contract.status, "awaitingPayment");
    assert.ok(contract.payByAt > new Date());
    assert.equal(Number(contract.platformFeeAmount), paystack.calculatePlatformFee((await prisma.job.findUnique({ where: { id: r.json.jobId } })).budget), "the usual 10% on top of the package price");
    assert.equal((await prisma.packageOrder.findUnique({ where: { id: r.json.orderId } })).status, "accepted");
    assert.equal((await api(ca, "POST", `/package-orders/${r.json.orderId}/accept`)).json.code, "not_open", "once");
  });

  it("declining closes the private job and nothing is charged", async () => {
    const pkg = await aPackage();
    await prisma.packageOrder.updateMany({ where: { packageId: pkg.id, status: "requested" }, data: { status: "cancelled" } });
    const r = await api(cl, "POST", `/packages/${pkg.id}/order`, { brief });
    assert.equal((await api(ca, "POST", `/package-orders/${r.json.orderId}/decline`)).status, 200);
    const job = await prisma.job.findUnique({ where: { id: r.json.jobId } });
    assert.ok(job.closedAt);
    assert.equal(await prisma.contract.count({ where: { jobId: r.json.jobId } }), 0);
    assert.equal((await prisma.packageOrder.findUnique({ where: { id: r.json.orderId } })).status, "declined");
  });

  it("the client can cancel while it waits, and silence for 48 hours lapses it", async () => {
    const pkg = await aPackage();
    const a = await api(cl, "POST", `/packages/${pkg.id}/order`, { brief });
    assert.equal((await api(cl, "POST", `/package-orders/${a.json.orderId}/cancel`)).status, 200);
    assert.equal((await prisma.packageOrder.findUnique({ where: { id: a.json.orderId } })).status, "cancelled");

    const b = await api(cl, "POST", `/packages/${pkg.id}/order`, { brief });
    const later = new Date(Date.now() + 49 * 3_600_000);
    const r = await packages.sweepOrders({ prisma, now: () => later });
    assert.ok(r.packageOrdersExpired >= 1);
    assert.equal((await prisma.packageOrder.findUnique({ where: { id: b.json.orderId } })).status, "expired");
    assert.ok((await prisma.job.findUnique({ where: { id: b.json.jobId } })).closedAt);
    assert.equal((await api(ca, "POST", `/package-orders/${b.json.orderId}/accept`)).json.code, "not_open");
  });

  it("an order can't be accepted after its 48 hours even before the sweep runs", async () => {
    const pkg = await aPackage();
    const r = await api(cl, "POST", `/packages/${pkg.id}/order`, { brief });
    await prisma.packageOrder.update({ where: { id: r.json.orderId }, data: { answerDueAt: new Date(Date.now() - 1000) } });
    assert.equal((await api(ca, "POST", `/package-orders/${r.json.orderId}/accept`)).json.code, "expired");
  });

  it("a package with an order waiting can't be removed", async () => {
    const pkg = await aPackage();
    await prisma.packageOrder.updateMany({ where: { packageId: pkg.id, status: "requested" }, data: { status: "cancelled" } });
    await api(cl, "POST", `/packages/${pkg.id}/order`, { brief });
    assert.equal((await api(ca, "DELETE", `/users/me/packages/${pkg.id}`)).json.code, "has_orders");
  });
});
