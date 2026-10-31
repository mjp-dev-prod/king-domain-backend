// The audit log and proof review behind the reviewer capability, over real HTTP.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const { recordAudit, actorRoleOf } = require("../src/admin/audit");

let ctx, server, owner, reviewer, reader, tOwner, tReviewer, tReader, profile;
before(async () => {
  ctx = await h.fixtures();
  owner = await h.ensureAdmin("testsuite-owner@example.com", { role: "owner" });
  reviewer = await h.ensureAdmin("testsuite-reviewer@example.com", { capabilities: ["reviewer"], reviewerSkills: ["writing"] });
  reader = await h.ensureAdmin("testsuite-reader@example.com");
  server = await h.startServer({ port: 4621, paystackUrl: "http://127.0.0.1:9", autoRelease: false });
  [tOwner, tReviewer, tReader] = await Promise.all([owner, reviewer, reader].map(h.adminTokenFor));
  profile = await prisma.talentProfile.findUnique({ where: { userId: ctx.talentA.id } });
});
after(async () => {
  server?.stop();
  await prisma.proofItem.deleteMany({ where: { talentProfileId: profile.id } });
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: { in: [owner.id, reviewer.id, reader.id] } } });
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);
const pending = () => prisma.proofItem.create({ data: { talentProfileId: profile.id, category: h.CATEGORY, title: `${h.TITLE_PREFIX}proof` } });

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

describe("proof review needs the reviewer capability and leaves an audit trail", () => {
  it("an admin without the capability gets 403 and nothing changes", async () => {
    const item = await pending();
    const r = await api(tReader, "POST", `/admin/proof-items/${item.id}/approve`);
    assert.equal(r.status, 403);
    assert.equal((await prisma.proofItem.findUnique({ where: { id: item.id } })).status, "pending");
  });

  it("a reviewer approves, and the approval and its audit event land together", async () => {
    const item = await pending();
    const r = await api(tReviewer, "POST", `/admin/proof-items/${item.id}/approve`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const events = await prisma.adminAuditEvent.findMany({ where: { subjectType: "ProofItem", subjectId: item.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "proof.approve");
    assert.equal(events[0].actorId, reviewer.id);
    assert.equal(events[0].actorRole, "admin:reviewer");
  });

  it("a rejection keeps its reason in the audit event even though the item is deleted", async () => {
    const item = await pending();
    const reason = "The file doesn't open. Please upload it again as an image or PDF.";
    const r = await api(tOwner, "POST", `/admin/proof-items/${item.id}/reject`, { reason });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await prisma.proofItem.findUnique({ where: { id: item.id } }), null);
    const [event] = await prisma.adminAuditEvent.findMany({ where: { subjectType: "ProofItem", subjectId: item.id } });
    assert.equal(event.action, "proof.reject");
    assert.equal(event.note, reason);
    assert.equal(event.details.title, `${h.TITLE_PREFIX}proof`);
  });
});
