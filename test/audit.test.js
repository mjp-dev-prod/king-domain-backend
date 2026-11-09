// The audit log, and the first check behind the checker capability, over real HTTP.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const { recordAudit, actorRoleOf } = require("../src/admin/audit");

let ctx, server, owner, checker, reader, tOwner, tChecker, tReader;
before(async () => {
  ctx = await h.fixtures();
  owner = await h.ensureAdmin("testsuite-owner@example.com", { role: "owner" });
  checker = await h.ensureAdmin("testsuite-checker@example.com", { capabilities: ["checker"] });
  reader = await h.ensureAdmin("testsuite-reader@example.com");
  server = await h.startServer({ port: 4621, paystackUrl: "http://127.0.0.1:9", autoRelease: false });
  [tOwner, tChecker, tReader] = await Promise.all([owner, checker, reader].map(h.adminTokenFor));
});
after(async () => {
  server?.stop();
  await prisma.skillSubmission.deleteMany({ where: { userId: ctx.talentA.id, skillKey: SKILL } });
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: { in: [owner.id, checker.id, reader.id] } } });
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);
const SKILL = "short-form-video";
const { AUTH_CHECKLIST } = require("../src/admin/skillReviewRoutes");
const ticked = Object.fromEntries(AUTH_CHECKLIST.map((c) => [c.key, true]));
const waiting = () => prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey: SKILL, status: "authenticity", submittedAt: new Date() } });

describe("audit log", () => {
  it("actorRoleOf records role and sorted capabilities", () => {
    assert.equal(actorRoleOf({ role: "owner", capabilities: [] }), "owner");
    assert.equal(actorRoleOf({ role: "admin", capabilities: ["reviewer", "checker"] }), "admin:checker,reviewer");
  });

  it("recordAudit writes the event and refuses one without a subject", async () => {
    const e = await recordAudit(prisma, owner, { action: "test.write", subjectType: "Test", subjectId: "t1", note: "hello" });
    const back = await prisma.adminAuditEvent.findUnique({ where: { id: e.id } });
    assert.equal(back.action, "test.write");
    assert.equal(back.actorRole, "owner");
    await assert.rejects(() => recordAudit(prisma, owner, { action: "test.write", subjectType: "Test" }), /subjectId/);
  });
});

describe("the first check needs the checker capability and leaves an audit trail", () => {
  it("an admin without the capability gets 403 and nothing changes", async () => {
    const item = await waiting();
    const r = await api(tReader, "POST", `/admin/authenticity/${item.id}/pass`, { checklist: ticked });
    assert.equal(r.status, 403);
    assert.equal((await prisma.skillSubmission.findUnique({ where: { id: item.id } })).status, "authenticity");
  });

  it("a checker passes it, and the pass and its audit event land together", async () => {
    const item = await waiting();
    const r = await api(tChecker, "POST", `/admin/authenticity/${item.id}/pass`, { checklist: ticked });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await prisma.skillSubmission.findUnique({ where: { id: item.id } })).status, "review");
    const events = await prisma.adminAuditEvent.findMany({ where: { subjectType: "SkillSubmission", subjectId: item.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "authenticity.pass");
    assert.equal(events[0].actorId, checker.id);
    assert.equal(events[0].actorRole, "admin:checker");
  });

  it("stopping it keeps the reason in the audit event", async () => {
    const item = await waiting();
    const reason = "The files don't open. Please send them again as an image or PDF.";
    const r = await api(tOwner, "POST", `/admin/authenticity/${item.id}/stop`, { note: reason });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [event] = await prisma.adminAuditEvent.findMany({ where: { subjectType: "SkillSubmission", subjectId: item.id } });
    assert.equal(event.action, "authenticity.stop");
    assert.equal(event.note, reason);
  });
});
