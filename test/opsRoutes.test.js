// The ops routes over real HTTP.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;

let server, slack, owner, reader, shareholder, target, tOwner, tReader, tShare;
before(async () => {
  slack = await h.serveFakeSlack();
  owner = await h.ensureAdmin("testsuite-owner@example.com", { role: "owner" });
  reader = await h.ensureAdmin("testsuite-reader@example.com");
  shareholder = await h.ensureAdmin("testsuite-shareholder@example.com", { capabilities: ["shareholder"] });
  target = await h.ensureAdmin("testsuite-target@example.com");
  await prisma.onCallShift.deleteMany({ where: { adminId: { in: [owner.id, target.id] } } });
  await prisma.queueTarget.deleteMany({ where: { queueKey: "proof" } });
  server = await h.startServer({
    port: 4622,
    paystackUrl: "http://127.0.0.1:9",
    autoRelease: false,
    env: { OPS_SLACK_WEBHOOK_URL: slack.url, ADMIN_DASHBOARD_URL: "https://admin.example" },
  });
  [tOwner, tReader, tShare] = await Promise.all([owner, reader, shareholder].map(h.adminTokenFor));
});
after(async () => {
  server?.stop();
  slack.server.close();
  await prisma.onCallShift.deleteMany({ where: { adminId: { in: [owner.id, target.id] } } });
  await prisma.queueTarget.deleteMany({ where: { queueKey: "proof" } });
  await prisma.opsAlert.deleteMany({ where: { title: { startsWith: "Test alert from" } } });
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: owner.id } });
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);

describe("GET /admin/inbox", () => {
  it("shows the proof queue to an owner and nothing to an admin without capabilities", async () => {
    const o = await api(tOwner, "GET", "/admin/inbox");
    assert.equal(o.status, 200);
    assert.ok(o.json.queues.some((q) => q.key === "proof" && q.path === "/proof-review"));
    const r = await api(tReader, "GET", "/admin/inbox");
    assert.deepEqual(r.json.queues, []);
  });
});

describe("PUT /admin/inbox/targets/:queueKey", () => {
  it("an owner changes a target; bad input and non-owners are refused; unknown queues are 404", async () => {
    const ok = await api(tOwner, "PUT", "/admin/inbox/targets/proof", { targetMinutes: 2880, defaultWhenLate: "Escalate to the owner." });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.target.targetMinutes, 2880);
    assert.equal((await api(tOwner, "PUT", "/admin/inbox/targets/proof", { targetMinutes: 0, defaultWhenLate: "x" })).status, 400);
    assert.equal((await api(tReader, "PUT", "/admin/inbox/targets/proof", { targetMinutes: 60, defaultWhenLate: "Escalate." })).status, 403);
    assert.equal((await api(tOwner, "PUT", "/admin/inbox/targets/nope", { targetMinutes: 60, defaultWhenLate: "Escalate." })).status, 404);
  });
});

describe("capabilities", () => {
  it("an owner grants capabilities and reviewer skills, and it is audited with before and after", async () => {
    const r = await api(tOwner, "PATCH", `/admin/admins/${target.id}/capabilities`, { capabilities: ["reviewer", "checker"], reviewerSkills: ["writing"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.admin.capabilities.sort(), ["checker", "reviewer"]);
    assert.deepEqual(r.json.admin.reviewerSkills, ["writing"]);
    const [e] = await prisma.adminAuditEvent.findMany({ where: { action: "admin.capabilities", subjectId: target.id }, orderBy: { createdAt: "desc" }, take: 1 });
    assert.deepEqual(e.details.after.capabilities.sort(), ["checker", "reviewer"]);
  });

  it("refuses unknown capabilities and unknown skills", async () => {
    assert.equal((await api(tOwner, "PATCH", `/admin/admins/${target.id}/capabilities`, { capabilities: ["wizard"], reviewerSkills: [] })).status, 400);
    assert.equal((await api(tOwner, "PATCH", `/admin/admins/${target.id}/capabilities`, { capabilities: ["reviewer"], reviewerSkills: ["juggling"] })).status, 400);
    assert.equal((await api(tReader, "PATCH", `/admin/admins/${target.id}/capabilities`, { capabilities: [], reviewerSkills: [] })).status, 403);
  });
});

describe("on-call", () => {
  it("an owner adds and removes a shift; everyone can read the rota; bad shifts are refused", async () => {
    const add = await api(tOwner, "POST", "/admin/on-call", { adminId: target.id, startsAt: "2026-11-14T17:00:00Z", endsAt: "2026-11-15T07:00:00Z" });
    assert.equal(add.status, 201, JSON.stringify(add.json));
    const list = await api(tReader, "GET", "/admin/on-call?from=2026-11-01T00:00:00Z");
    assert.ok(list.json.shifts.some((s) => s.id === add.json.shift.id && s.admin.id === target.id));
    assert.equal((await api(tOwner, "POST", "/admin/on-call", { adminId: target.id, startsAt: "2026-11-15T07:00:00Z", endsAt: "2026-11-14T17:00:00Z" })).status, 400);
    assert.equal((await api(tOwner, "POST", "/admin/on-call", { adminId: target.id, startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-20T00:00:00Z" })).status, 400);
    assert.equal((await api(tReader, "POST", "/admin/on-call", { adminId: target.id, startsAt: "2026-11-14T17:00:00Z", endsAt: "2026-11-15T07:00:00Z" })).status, 403);
    assert.equal((await api(tOwner, "DELETE", `/admin/on-call/${add.json.shift.id}`)).status, 200);
  });
});

describe("audit log and test alert", () => {
  it("an owner sends a test alert that reaches Slack, and the shareholder reads it in the audit log", async () => {
    const before = slack.received.length;
    const t = await api(tOwner, "POST", "/admin/alerts/test");
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.equal(slack.received.length, before + 1);
    assert.equal(t.json.alert.slackSent, true);
    const log = await api(tShare, "GET", "/admin/audit?action=alert.test&limit=5");
    assert.equal(log.status, 200);
    assert.ok(log.json.events.some((e) => e.action === "alert.test" && e.actor.id === owner.id));
    assert.equal((await api(tReader, "GET", "/admin/audit")).status, 403);
  });
});
