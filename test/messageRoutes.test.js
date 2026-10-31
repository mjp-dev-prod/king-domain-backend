// S4 over real HTTP: conversations, held messages, edits, attachments, agreements, reports, blocks, the safety queue
// and the response-time figure. Storage is a local fake of the private bucket.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const h = require("./helpers");
const convo = require("../src/conversations");
const { prisma } = h;

let ctx, server, r2, provider, fakeProvider, ca, tb, cl, safetyTok, plainTok, safety, plain;
const admins = [];

before(async () => {
  ctx = await h.fixtures();
  provider = h.fakeProvider();
  fakeProvider = await h.serveFakeProvider(provider);
  r2 = await h.serveFakeR2();
  server = await h.startServer({
    port: 4661,
    paystackUrl: fakeProvider.url,
    autoRelease: false,
    env: { R2_ACCOUNT_ID: "test", R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_PRIVATE_BUCKET: "private-test", R2_ENDPOINT: r2.url, MESSAGE_RATE_LIMIT: "1000" },
  });
  safety = await h.ensureAdmin("testsuite-s4-safety@example.com", { capabilities: ["safety"] });
  plain = await h.ensureAdmin("testsuite-s4-plain@example.com");
  admins.push(safety, plain);
  [ca, tb, cl, safetyTok, plainTok] = await Promise.all([h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB), h.tokenFor(ctx.client), h.adminTokenFor(safety), h.adminTokenFor(plain)]);
  await reset();
});
after(async () => {
  server?.stop();
  r2?.server.close();
  fakeProvider?.server.close();
  await reset();
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: { in: admins.map((a) => a.id) } } });
  await prisma.$disconnect();
});

const ids = () => [ctx.client.id, ctx.talentA.id, ctx.talentB.id];

async function reset() {
  await prisma.conversation.deleteMany({ where: { OR: [{ clientId: { in: ids() } }, { talentId: { in: ids() } }] } });
  await prisma.userBlock.deleteMany({ where: { OR: [{ blockerId: { in: ids() } }, { blockedId: { in: ids() } }] } });
  await prisma.invitation.deleteMany({ where: { clientId: { in: ids() } } });
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
}

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);
const uid = () => crypto.randomUUID();

/** A job the client posted that talent A applied to, so the client may write to them. */
async function relateA() {
  const job = await prisma.job.create({ data: { clientId: ctx.client.id, title: `${h.TITLE_PREFIX}${uid().slice(0, 6)}`, category: "Video & media", description: "d", budget: 1000, postStatus: "live" } });
  await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentA.id } });
  return job;
}

async function open(talent = ctx.talentA) {
  const r = await api(cl, "POST", "/conversations", { talentId: talent.id });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
  return r.json.conversationId;
}

describe("starting a conversation", () => {
  it("a client may write to someone who applied, was invited, or is on a shortlist, and to no one else", async () => {
    await reset();
    assert.equal((await api(cl, "POST", "/conversations", { talentId: ctx.talentA.id })).json.code, "no_relationship");
    assert.equal((await api(ca, "POST", "/conversations", { talentId: ctx.client.id })).status, 403, "talents reply, they do not start");
    await relateA();
    const first = await api(cl, "POST", "/conversations", { talentId: ctx.talentA.id });
    assert.equal(first.status, 201);
    const again = await api(cl, "POST", "/conversations", { talentId: ctx.talentA.id });
    assert.equal(again.status, 200);
    assert.equal(again.json.conversationId, first.json.conversationId, "one conversation per relationship");
    assert.equal((await api(cl, "POST", "/conversations", { talentId: "nobody" })).status, 404);
  });

  it("nobody can read a conversation that is not theirs, and not even learn that it exists", async () => {
    await reset();
    await relateA();
    const id = await open();
    assert.equal((await api(tb, "GET", `/conversations/${id}`)).status, 404);
    assert.equal((await api(tb, "POST", `/conversations/${id}/messages`, { body: "hello there", clientMsgId: uid() })).status, 404);
  });
});

describe("sending, holding and reading", () => {
  it("delivers a text, shows it to the other person with an unread count, and clears the count when they open it", async () => {
    await reset();
    await relateA();
    const id = await open();
    const sent = await api(cl, "POST", `/conversations/${id}/messages`, { body: "Can you start tomorrow?", clientMsgId: uid() });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    assert.equal(sent.json.message.state, "sent");
    const list = (await api(ca, "GET", "/conversations")).json.conversations;
    assert.equal(list[0].unread, 1);
    assert.equal(list[0].last.preview, "Can you start tomorrow?");
    const opened = (await api(ca, "GET", `/conversations/${id}`)).json;
    assert.equal(opened.messages.length, 1);
    assert.equal(opened.messages[0].mine, false);
    assert.equal((await api(ca, "GET", "/conversations")).json.conversations[0].unread, 0);
    // Only what is new after a message comes back with ?after=
    await api(ca, "POST", `/conversations/${id}/messages`, { body: "Yes, I can.", clientMsgId: uid() });
    const next = (await api(cl, "GET", `/conversations/${id}?after=${sent.json.message.id}`)).json;
    assert.deepEqual(next.messages.map((m) => m.body), ["Yes, I can."]);
  });

  it("a retry with the same client id is the same message, not a second one", async () => {
    await reset();
    await relateA();
    const id = await open();
    const cid = uid();
    const a = await api(cl, "POST", `/conversations/${id}/messages`, { body: "Hello", clientMsgId: cid });
    const b = await api(cl, "POST", `/conversations/${id}/messages`, { body: "Hello", clientMsgId: cid });
    assert.equal(b.status, 200);
    assert.equal(b.json.message.id, a.json.message.id);
    assert.equal(await prisma.message.count({ where: { conversationId: id } }), 1);
  });

  it("before an award, a phone number is held: the sender is told why, the other person never sees it", async () => {
    await reset();
    await relateA();
    const id = await open();
    const held = await api(cl, "POST", `/conversations/${id}/messages`, { body: "call me on 08031234567", clientMsgId: uid() });
    assert.equal(held.status, 201);
    assert.equal(held.json.held, true);
    assert.equal(held.json.message.state, "held");
    assert.match(held.json.message.heldWhy, /Until a job is awarded/);
    assert.equal((await api(ca, "GET", `/conversations/${id}`)).json.messages.length, 0, "the talent sees nothing");
    assert.equal((await api(cl, "GET", `/conversations/${id}`)).json.messages.length, 1, "the sender still sees it, with the warning");
    assert.equal((await api(ca, "GET", "/conversations")).json.conversations[0].unread, 0);
  });

  it("after an award the same details pass, but outside payment never does", async () => {
    await reset();
    const seeded = await h.seedAward(ctx);
    const id = await open(ctx.talentA);
    const ok = await api(cl, "POST", `/conversations/${id}/messages`, { body: "my number is 08031234567", clientMsgId: uid() });
    assert.equal(ok.json.message.state, "sent");
    assert.equal((await api(cl, "GET", `/conversations/${id}`)).json.conversation.awarded, true);
    const pay = await api(cl, "POST", `/conversations/${id}/messages`, { body: "just pay me directly outside the app", clientMsgId: uid() });
    assert.equal(pay.json.message.state, "held");
    assert.ok(seeded.job);
  });

  it("job events appear in the conversation as cards", async () => {
    await reset();
    const seeded = await h.seedAward(ctx);
    await prisma.contractEvent.create({ data: { jobId: seeded.job.id, contractId: seeded.c.id, type: "awarded" } });
    const id = await open(ctx.talentA);
    const opened = (await api(ca, "GET", `/conversations/${id}`)).json;
    assert.equal(opened.events[0].type, "awarded");
    assert.equal(opened.events[0].jobTitle, seeded.job.title);
  });
});

describe("editing keeps the record (D27)", () => {
  it("a text can change for 15 minutes with an edited mark, the original is kept, and later it cannot", async () => {
    await reset();
    await relateA();
    const id = await open();
    const sent = (await api(cl, "POST", `/conversations/${id}/messages`, { body: "Delivery on Friday", clientMsgId: uid() })).json.message;
    const edited = await api(cl, "PATCH", `/conversations/${id}/messages/${sent.id}`, { body: "Delivery on Thursday" });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.message.edited, true);
    const row = await prisma.message.findUnique({ where: { id: sent.id } });
    assert.equal(row.originalBody, "Delivery on Friday");
    assert.equal((await api(ca, "PATCH", `/conversations/${id}/messages/${sent.id}`, { body: "hacked" })).json.code, "not_yours");
    await prisma.message.update({ where: { id: sent.id }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    const late = await api(cl, "PATCH", `/conversations/${id}/messages/${sent.id}`, { body: "Delivery on Monday" });
    assert.equal(late.status, 409);
    assert.equal(late.json.code, "too_late");
    assert.equal((await api(cl, "PATCH", `/conversations/${id}/messages/${sent.id}`, { body: "x" })).status, 409);
  });

  it("there is no way to delete a message", async () => {
    await reset();
    await relateA();
    const id = await open();
    const sent = (await api(cl, "POST", `/conversations/${id}/messages`, { body: "hello there", clientMsgId: uid() })).json.message;
    assert.equal((await api(cl, "DELETE", `/conversations/${id}/messages/${sent.id}`)).status, 404);
  });
});

describe("attachments", () => {
  async function send(tok, id, input, content = Buffer.alloc(input.sizeBytes ?? 2000, 7)) {
    const made = await api(tok, "POST", `/conversations/${id}/attachments`, { clientMsgId: uid(), ...input });
    if (made.status !== 201) return made;
    const put = await fetch(made.json.upload.url, { method: "PUT", headers: made.json.upload.headers, body: content });
    assert.equal(put.status, 200);
    return api(tok, "POST", `/conversations/${id}/messages/${made.json.messageId}/complete`);
  }

  it("a voice note goes to private storage, arrives with a short-lived link, and plays for the other person", async () => {
    await reset();
    await relateA();
    const id = await open();
    const r = await send(ca, id, { kind: "voice", name: "note.m4a", contentType: "audio/mp4", sizeBytes: 5000, durationSec: 42 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.message.kind, "voice");
    const mine = (await api(cl, "GET", `/conversations/${id}`)).json.messages[0];
    assert.equal(mine.attachment.durationSec, 42);
    assert.equal((await fetch(mine.attachment.url)).status, 200);
    assert.equal((await fetch(mine.attachment.url.split("?")[0])).status, 403, "the bare link is refused");
  });

  it("refuses a program, an over-long voice note and a wrong-size upload", async () => {
    await reset();
    await relateA();
    const id = await open();
    assert.equal((await api(ca, "POST", `/conversations/${id}/attachments`, { clientMsgId: uid(), kind: "file", name: "setup.apk", contentType: "application/octet-stream", sizeBytes: 10 })).json.code, "executable");
    assert.equal((await api(ca, "POST", `/conversations/${id}/attachments`, { clientMsgId: uid(), kind: "voice", name: "n.m4a", contentType: "audio/mp4", sizeBytes: 100, durationSec: 400 })).json.code, "too_long");
    const made = await api(ca, "POST", `/conversations/${id}/attachments`, { clientMsgId: uid(), kind: "image", name: "a.png", contentType: "image/png", sizeBytes: 100 });
    await fetch(made.json.upload.url, { method: "PUT", headers: made.json.upload.headers, body: Buffer.alloc(500) });
    const done = await api(ca, "POST", `/conversations/${id}/messages/${made.json.messageId}/complete`);
    assert.equal(done.json.code, "size_mismatch");
    assert.equal(await prisma.message.count({ where: { id: made.json.messageId } }), 0);
    const missing = await api(ca, "POST", `/conversations/${id}/attachments`, { clientMsgId: uid(), kind: "image", name: "b.png", contentType: "image/png", sizeBytes: 100 });
    assert.equal((await api(ca, "POST", `/conversations/${id}/messages/${missing.json.messageId}/complete`)).json.code, "upload_missing");
  });

  it("a half-sent attachment is not delivered", async () => {
    await reset();
    await relateA();
    const id = await open();
    await api(ca, "POST", `/conversations/${id}/attachments`, { clientMsgId: uid(), kind: "image", name: "c.png", contentType: "image/png", sizeBytes: 100 });
    assert.equal((await api(cl, "GET", `/conversations/${id}`)).json.messages.length, 0);
    assert.equal((await api(cl, "GET", "/conversations")).json.conversations[0].unread, 0);
  });
});

describe("what we agreed", () => {
  it("counts only once both people have confirmed it", async () => {
    await reset();
    await relateA();
    const id = await open();
    assert.equal((await api(cl, "POST", `/conversations/${id}/agreements`, { body: "ok", clientMsgId: uid() })).status, 400);
    const made = await api(cl, "POST", `/conversations/${id}/agreements`, { body: "Three reels, ₦25,000, delivered by Friday 21 Nov.", clientMsgId: uid() });
    assert.equal(made.status, 201);
    assert.deepEqual(made.json.message.agreement, { confirmedByMe: true, confirmedByOther: false, status: "waiting" });
    const seen = (await api(ca, "GET", `/conversations/${id}`)).json.messages[0];
    assert.equal(seen.agreement.confirmedByMe, false);
    const confirmed = await api(ca, "POST", `/conversations/${id}/messages/${seen.id}/confirm`);
    assert.equal(confirmed.json.message.agreement.status, "agreed");
    assert.equal((await api(cl, "GET", `/conversations/${id}`)).json.messages[0].agreement.status, "agreed");
  });
});

describe("reports and blocks", () => {
  it("any message can be reported once, not your own; a bad reason is refused", async () => {
    await reset();
    await relateA();
    const id = await open();
    const sent = (await api(cl, "POST", `/conversations/${id}/messages`, { body: "Send me your bank login to be paid", clientMsgId: uid() })).json.message;
    assert.equal((await api(cl, "POST", `/conversations/${id}/messages/${sent.id}/report`, { reasonCode: "scam" })).json.code, "own_message");
    assert.equal((await api(ca, "POST", `/conversations/${id}/messages/${sent.id}/report`, { reasonCode: "nope" })).status, 400);
    assert.equal((await api(ca, "POST", `/conversations/${id}/messages/${sent.id}/report`, { reasonCode: "other", note: "short" })).status, 400);
    const ok = await api(ca, "POST", `/conversations/${id}/messages/${sent.id}/report`, { reasonCode: "scam" });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.urgent, false, "no live job between them");
    assert.equal((await api(ca, "POST", `/conversations/${id}/messages/${sent.id}/report`, { reasonCode: "scam" })).json.code, "already_reported");
  });

  it("blocking works when no job is running, stops messages both ways, and can be undone", async () => {
    await reset();
    await relateA();
    const id = await open();
    assert.equal((await api(ca, "POST", `/users/${ctx.client.id}/block`)).status, 200);
    const sent = await api(cl, "POST", `/conversations/${id}/messages`, { body: "hello again", clientMsgId: uid() });
    assert.equal(sent.status, 403);
    assert.equal(sent.json.code, "blocked");
    assert.equal((await api(ca, "POST", `/conversations/${id}/messages`, { body: "hi", clientMsgId: uid() })).status, 403);
    assert.equal((await api(ca, "DELETE", `/users/${ctx.client.id}/block`)).status, 200);
    assert.equal((await api(cl, "POST", `/conversations/${id}/messages`, { body: "hello again", clientMsgId: uid() })).status, 201);
  });

  it("blocking is refused while a job is running, and a report then is urgent", async () => {
    await reset();
    const seeded = await h.seedWorking(ctx);
    const id = await open(ctx.talentA);
    assert.equal((await api(ca, "POST", `/users/${ctx.client.id}/block`)).json.code, "contract_active");
    assert.equal((await api(cl, "GET", `/conversations/${id}`)).json.conversation.canBlock, false);
    const sent = (await api(cl, "POST", `/conversations/${id}/messages`, { body: "this is rude", clientMsgId: uid() })).json.message;
    const rep = await api(ca, "POST", `/conversations/${id}/messages/${sent.id}/report`, { reasonCode: "harassment" });
    assert.equal(rep.json.urgent, true);
    assert.ok(seeded.job);
  });
});

describe("the team's safety reports", () => {
  it("lists a report with the messages around it, and a decision is final, audited and needs a reason when action is taken", async () => {
    await reset();
    await relateA();
    const id = await open();
    await api(cl, "POST", `/conversations/${id}/messages`, { body: "Hello, ready when you are", clientMsgId: uid() });
    const bad = (await api(cl, "POST", `/conversations/${id}/messages`, { body: "Send me your bank login", clientMsgId: uid() })).json.message;
    await api(ca, "POST", `/conversations/${id}/messages/${bad.id}/report`, { reasonCode: "scam" });

    assert.equal((await api(plainTok, "GET", "/admin/safety-reports")).status, 403, "needs the safety role");
    const list = (await api(safetyTok, "GET", "/admin/safety-reports")).json.reports;
    const mine = list.find((r) => r.preview.includes("bank login"));
    assert.ok(mine);
    const detail = (await api(safetyTok, "GET", `/admin/safety-reports/${mine.id}`)).json;
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages.find((m) => m.flagged).body, "Send me your bank login");
    assert.match(detail.report.reported, /\(client\)/);

    assert.equal((await api(safetyTok, "POST", `/admin/safety-reports/${mine.id}/handle`, { action: "actioned", note: "short" })).status, 400);
    assert.equal((await api(safetyTok, "POST", `/admin/safety-reports/${mine.id}/handle`, { action: "actioned", note: "Warned the client; account watched." })).status, 200);
    assert.equal((await api(safetyTok, "POST", `/admin/safety-reports/${mine.id}/handle`, { action: "dismiss" })).status, 409, "already handled");
    const audit = await prisma.adminAuditEvent.findMany({ where: { subjectId: mine.id } });
    assert.equal(audit[0].action, "safetyReport.actioned");
    const inbox = (await api(safetyTok, "GET", "/admin/inbox")).json.queues.map((q) => q.key);
    assert.ok(inbox.includes("safety-report"));
  });
});

describe("response time (D24)", () => {
  it("is null with fewer than 3 conversations, then a bucket from the real first replies", async () => {
    await reset();
    const talent = ctx.talentA;
    const stat = (await api(cl, "GET", "/talents")).status; // clients may browse; the figure rides on every card
    assert.equal(stat, 200);
    // Three conversations where the client wrote first and the talent replied within the hour.
    const clients = [ctx.client, await h.ensureUser("testsuite-s4-client2@example.com", "client", "S4 Client Two"), await h.ensureUser("testsuite-s4-client3@example.com", "client", "S4 Client Three")];
    for (const c of clients) {
      const conv = await prisma.conversation.create({ data: { clientId: c.id, talentId: talent.id } });
      const first = new Date(Date.now() - 3 * 3_600_000);
      await prisma.message.create({ data: { conversationId: conv.id, senderId: c.id, kind: "text", body: "hello", clientMsgId: uid(), createdAt: first } });
      await prisma.message.create({ data: { conversationId: conv.id, senderId: talent.id, kind: "text", body: "hi", clientMsgId: uid(), createdAt: new Date(first.getTime() + 20 * 60_000) } });
    }
    const s = await convo.responseStatsFor(prisma, talent.id);
    assert.deepEqual(s, { medianMinutes: 20, conversations: 3 });
    const two = await convo.responseStatsFor(prisma, ctx.talentB.id);
    assert.equal(two.conversations, 0);
    await prisma.conversation.deleteMany({ where: { clientId: { in: clients.map((c) => c.id) } } });
  });
});
