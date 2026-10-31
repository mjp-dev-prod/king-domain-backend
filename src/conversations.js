// Conversations between a client and a talent (PRD §4.7; D18, D24, D27). One per relationship; the job's own events
// appear as cards between the messages. Everything here is the part that needs the database.
const crypto = require("node:crypto");
const { prisma: realPrisma } = require("./db");
const messaging = require("./messaging");
const storage = require("./storage");
const { skillByKey } = require("./skills");

const PAGE = 60;

const fail = (status, code, error) => ({ ok: false, status, code, error });

/** The other person in a conversation, from the viewer's side. */
const otherId = (conv, viewerId) => (conv.clientId === viewerId ? conv.talentId : conv.clientId);

async function loadConversation(db, id, userId) {
  const conv = await db.conversation.findUnique({ where: { id } });
  if (!conv || (conv.clientId !== userId && conv.talentId !== userId)) return null; // not theirs: not even its existence
  return conv;
}

/** Whether a job has been awarded between these two people: contact details are allowed after that, in the room (D18). */
async function awardedBetween(db, clientId, talentId) {
  return (await db.job.count({ where: { clientId, awardedApplicationId: { not: null }, applications: { some: { talentId, status: "selected" } } } })) > 0;
}

/** A job between them whose contract is not finished: blocking is not available while it runs (D18). */
async function activeContractBetween(db, clientId, talentId) {
  return (await db.contract.count({ where: { status: { not: "approved" }, job: { clientId, applications: { some: { talentId, status: "selected" } } } } })) > 0;
}

async function isBlocked(db, a, b) {
  return (await db.userBlock.count({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] } })) > 0;
}

/**
 * A client opens (or reopens) the conversation with a talent. They may write to someone who applied to or was invited
 * to one of their jobs, or who is on their shortlist: not to anyone at random (that is how spam starts).
 */
async function startConversation({ clientId, talentId }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  const talent = await db.user.findFirst({ where: { id: talentId, role: "talent", deletedAt: null }, select: { id: true } });
  if (!talent) return fail(404, "not_found", "Talent not found.");
  if (await isBlocked(db, clientId, talentId)) return fail(403, "blocked", "You can't message this person.");
  const existing = await db.conversation.findUnique({ where: { clientId_talentId: { clientId, talentId } } });
  if (existing) return { ok: true, conversation: existing, created: false };

  const related =
    (await db.application.count({ where: { talentId, job: { clientId } } })) > 0 ||
    (await db.invitation.count({ where: { talentId, clientId } })) > 0 ||
    (await db.shortlistItem.count({ where: { talentId, available: true, request: { clientId, status: "sent" } } })) > 0;
  if (!related) return fail(403, "no_relationship", "You can message someone who has applied to your job, whom you have invited, or who is on a shortlist we sent you.");
  const conv = await db.conversation.create({ data: { clientId, talentId } });
  return { ok: true, conversation: conv, created: true };
}

const unreadWhere = (conv, userId, since) => ({ conversationId: conv.id, senderId: { not: userId }, state: "sent", ...(since ? { createdAt: { gt: since } } : {}) });

/** The viewer's list of conversations: the other person, the last message, how many are unread. */
async function listConversations(userId, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  const convs = await db.conversation.findMany({
    where: { OR: [{ clientId: userId }, { talentId: userId }] },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 100,
    include: { client: { select: { id: true, fullName: true, photoPath: true } }, talent: { select: { id: true, fullName: true, photoPath: true } } },
  });
  return Promise.all(
    convs.map(async (c) => {
      const read = await db.conversationRead.findUnique({ where: { conversationId_userId: { conversationId: c.id, userId } } });
      const [last, unread, blocked] = await Promise.all([
        db.message.findFirst({ where: { conversationId: c.id, OR: [{ state: "sent" }, { senderId: userId, state: "held" }] }, orderBy: { createdAt: "desc" } }),
        db.message.count({ where: unreadWhere(c, userId, read?.lastReadAt) }),
        isBlocked(db, c.clientId, c.talentId),
      ]);
      const other = c.clientId === userId ? c.talent : c.client;
      return {
        id: c.id,
        other: { id: other.id, fullName: other.fullName, photoUrl: storage.avatarPublicUrl(other.photoPath) },
        last: last ? { kind: last.kind, preview: previewOf(last), mine: last.senderId === userId, at: last.createdAt, held: last.state === "held" } : null,
        unread,
        blocked,
      };
    }),
  );
}

function previewOf(m) {
  if (m.kind === "voice") return "Voice note";
  if (m.kind === "image") return "Photo";
  if (m.kind === "file") return m.attachmentName || "File";
  if (m.kind === "agreement") return "What we agreed";
  return m.body.length > 80 ? `${m.body.slice(0, 80)}...` : m.body;
}

async function serialiseMessage(db, m, viewerId, conv) {
  const mine = m.senderId === viewerId;
  const out = {
    id: m.id,
    kind: m.kind,
    mine,
    state: m.state,
    body: m.body,
    edited: Boolean(m.editedAt),
    editableUntil: m.kind === "text" && m.state === "sent" && mine ? new Date(new Date(m.createdAt).getTime() + messaging.EDIT_WINDOW_MS) : null,
    createdAt: m.createdAt,
    clientMsgId: m.clientMsgId,
  };
  if (m.state === "held" && mine) out.heldWhy = messaging.holdExplanation(m.heldFlags ?? [], false);
  if (m.attachmentKey && m.state === "sent") {
    out.attachment = {
      name: m.attachmentName,
      contentType: m.attachmentType,
      sizeBytes: m.attachmentBytes,
      durationSec: m.durationSec,
      // A short-lived link, made only now: the app downloads it when the person taps, never by itself on mobile data (D26 data saver).
      url: storage.privateUploadsConfigured ? await storage.presignPrivateGet(m.attachmentKey, 300) : null,
    };
  }
  if (m.kind === "agreement") out.agreement = messaging.agreementState(m, conv.clientId === viewerId);
  return out;
}

/** Job events between the two people, as cards for the timeline (the contract room, PRD §4.7). */
async function eventsBetween(db, conv) {
  const jobs = await db.job.findMany({ where: { clientId: conv.clientId, applications: { some: { talentId: conv.talentId, status: "selected" } } }, select: { id: true, title: true } });
  if (!jobs.length) return [];
  const titles = new Map(jobs.map((j) => [j.id, j.title]));
  const events = await db.contractEvent.findMany({ where: { jobId: { in: jobs.map((j) => j.id) } }, orderBy: { createdAt: "asc" }, take: 200 });
  return events.map((e) => ({ id: e.id, jobId: e.jobId, jobTitle: titles.get(e.jobId), type: e.type, at: e.createdAt }));
}

/**
 * The conversation as the viewer sees it: other person, messages after `after` (a message id), job events, and what
 * they may do. Opening it marks everything up to now as read. A held message is only ever shown to its sender.
 */
async function openConversation({ id, userId, after }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  const conv = await loadConversation(db, id, userId);
  if (!conv) return fail(404, "not_found", "Conversation not found.");
  const anchor = after ? await db.message.findFirst({ where: { id: after, conversationId: id }, select: { createdAt: true } }) : null;
  const rows = await db.message.findMany({
    where: { conversationId: id, state: { in: ["sent", "held"] }, OR: [{ state: "sent" }, { senderId: userId }], ...(anchor ? { createdAt: { gt: anchor.createdAt } } : {}) },
    orderBy: { createdAt: "asc" },
    take: PAGE + 1,
  });
  const messages = await Promise.all(rows.slice(0, PAGE).map((m) => serialiseMessage(db, m, userId, conv)));
  const otherUser = await db.user.findUnique({ where: { id: otherId(conv, userId) }, select: { id: true, fullName: true, photoPath: true } });
  const [awarded, active, blocked] = await Promise.all([awardedBetween(db, conv.clientId, conv.talentId), activeContractBetween(db, conv.clientId, conv.talentId), isBlocked(db, conv.clientId, conv.talentId)]);
  await db.conversationRead.upsert({ where: { conversationId_userId: { conversationId: id, userId } }, update: { lastReadAt: new Date() }, create: { conversationId: id, userId, lastReadAt: new Date() } });
  return {
    ok: true,
    conversation: {
      id,
      other: { id: otherUser.id, fullName: otherUser.fullName, photoUrl: storage.avatarPublicUrl(otherUser.photoPath) },
      iAmClient: conv.clientId === userId,
      awarded,
      canBlock: !active,
      blocked,
      uploadsAvailable: storage.privateUploadsConfigured,
    },
    messages,
    hasMore: rows.length > PAGE,
    events: await eventsBetween(db, conv),
    reasons: messaging.REPORT_REASONS,
  };
}

/** Sends a text. Held (not delivered) if it breaks the D18 rules; the sender is told why. Safe to retry with the same clientMsgId. */
async function sendText({ conversationId, userId, clientMsgId, body, kind = "text" }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  const conv = await loadConversation(db, conversationId, userId);
  if (!conv) return fail(404, "not_found", "Conversation not found.");
  if (await isBlocked(db, conv.clientId, conv.talentId)) return fail(403, "blocked", "You can't message this person.");
  const checked = kind === "agreement" ? messaging.validateAgreement(body) : messaging.validateText(body);
  if (!checked.ok) return fail(400, "invalid", checked.error);
  const cid = typeof clientMsgId === "string" && clientMsgId.length >= 8 && clientMsgId.length <= 64 ? clientMsgId : crypto.randomUUID();

  const prior = await db.message.findUnique({ where: { conversationId_senderId_clientMsgId: { conversationId, senderId: userId, clientMsgId: cid } } });
  if (prior) return { ok: true, message: await serialiseMessage(db, prior, userId, conv), duplicate: true };

  const awarded = await awardedBetween(db, conv.clientId, conv.talentId);
  const decision = messaging.holdDecision({ text: checked.text, awarded });
  const now = new Date();
  const confirmedAt = kind === "agreement" ? { [conv.clientId === userId ? "agreementConfirmedByClientAt" : "agreementConfirmedByTalentAt"]: now } : {};
  const message = await db.message.create({
    data: { conversationId, senderId: userId, kind, body: checked.text, clientMsgId: cid, state: decision.hold ? "held" : "sent", heldFlags: decision.hold ? decision.flags : undefined, ...confirmedAt },
  });
  if (!decision.hold) {
    await db.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: message.createdAt } });
    (deps.notify ?? require("./discovery").notify)(otherId(conv, userId), { title: "New message", body: previewOf(message), data: { type: "message", conversationId } });
  }
  console.log(`messages: send conv=${conversationId} by=${userId} kind=${kind} state=${message.state} flags=${decision.flags.map((f) => f.code).join(",") || "none"} awarded=${awarded} readBack=${(await db.message.count({ where: { id: message.id, state: message.state } })) === 1}`);
  return { ok: true, message: await serialiseMessage(db, message, userId, conv), held: decision.hold };
}

/** Edit a text within 15 minutes. The first edit keeps the original, for a dispute (D27). */
async function editMessage({ conversationId, messageId, userId, body }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  const conv = await loadConversation(db, conversationId, userId);
  if (!conv) return fail(404, "not_found", "Conversation not found.");
  const msg = await db.message.findFirst({ where: { id: messageId, conversationId } });
  if (!msg) return fail(404, "not_found", "Message not found.");
  const can = messaging.canEdit(msg, userId, deps.now ?? new Date());
  if (!can.ok) return fail(409, can.reason, can.reason === "too_late" ? "It's too late to change this message. Messages stay as sent so they can be relied on." : "You can't change this message.");
  const checked = messaging.validateText(body);
  if (!checked.ok) return fail(400, "invalid", checked.error);
  const decision = messaging.holdDecision({ text: checked.text, awarded: await awardedBetween(db, conv.clientId, conv.talentId) });
  if (decision.hold) return fail(400, "held", messaging.holdExplanation(decision.flags, false));
  const updated = await db.message.update({ where: { id: msg.id }, data: { body: checked.text, editedAt: new Date(), originalBody: msg.originalBody ?? msg.body } });
  return { ok: true, message: await serialiseMessage(db, updated, userId, conv) };
}

/** Starts an attachment: a pending message and a link the phone uploads to. */
async function startAttachment({ conversationId, userId, clientMsgId, input }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  if (!storage.privateUploadsConfigured) return fail(503, "uploads_unavailable", "Sending files isn't available right now. Try again later.");
  const conv = await loadConversation(db, conversationId, userId);
  if (!conv) return fail(404, "not_found", "Conversation not found.");
  if (await isBlocked(db, conv.clientId, conv.talentId)) return fail(403, "blocked", "You can't message this person.");
  const checked = messaging.validateAttachment(input ?? {});
  if (!checked.ok) return fail(checked.code === "file_too_large" ? 413 : 400, checked.code ?? "invalid", checked.error);
  const v = checked.value;
  const cid = typeof clientMsgId === "string" && clientMsgId.length >= 8 && clientMsgId.length <= 64 ? clientMsgId : crypto.randomUUID();
  const prior = await db.message.findUnique({ where: { conversationId_senderId_clientMsgId: { conversationId, senderId: userId, clientMsgId: cid } } });
  if (prior) return fail(409, "duplicate", "That attachment was already started.");
  const key = `messages/${conversationId}/${crypto.randomUUID()}-${v.name}`;
  const message = await db.message.create({
    data: { conversationId, senderId: userId, kind: v.kind, state: "pending", body: "", clientMsgId: cid, attachmentKey: key, attachmentName: v.name, attachmentType: v.contentType, attachmentBytes: v.sizeBytes, durationSec: v.durationSec },
  });
  const url = await storage.presignPrivatePut({ key, contentType: v.contentType });
  return { ok: true, messageId: message.id, upload: { url, method: "PUT", headers: { "Content-Type": v.contentType } } };
}

/** The upload finished: check what storage really holds, then deliver. */
async function completeAttachment({ conversationId, messageId, userId }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  const conv = await loadConversation(db, conversationId, userId);
  if (!conv) return fail(404, "not_found", "Conversation not found.");
  const msg = await db.message.findFirst({ where: { id: messageId, conversationId, senderId: userId } });
  if (!msg || !msg.attachmentKey) return fail(404, "not_found", "Message not found.");
  if (msg.state === "sent") return { ok: true, message: await serialiseMessage(db, msg, userId, conv) };
  const held = await storage.headPrivate(msg.attachmentKey);
  if (!held) return fail(409, "upload_missing", "The upload didn't finish. Try sending it again.");
  if (held.size !== msg.attachmentBytes) {
    await storage.deletePrivateObjects([msg.attachmentKey]).catch(() => {});
    await db.message.delete({ where: { id: msg.id } });
    return fail(400, "size_mismatch", "The uploaded file wasn't the size you said, so it was removed. Send it again.");
  }
  const done = await db.message.update({ where: { id: msg.id }, data: { state: "sent" } });
  await db.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: done.createdAt } });
  (deps.notify ?? require("./discovery").notify)(otherId(conv, userId), { title: "New message", body: previewOf(done), data: { type: "message", conversationId } });
  console.log(`messages: attachment sent conv=${conversationId} by=${userId} kind=${done.kind} bytes=${held.size} etag=${held.etag}`);
  return { ok: true, message: await serialiseMessage(db, done, userId, conv) };
}

/** The other person confirms what was agreed. Counts only when both have (D26). */
async function confirmAgreement({ conversationId, messageId, userId }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  const conv = await loadConversation(db, conversationId, userId);
  if (!conv) return fail(404, "not_found", "Conversation not found.");
  const msg = await db.message.findFirst({ where: { id: messageId, conversationId, kind: "agreement", state: "sent" } });
  if (!msg) return fail(404, "not_found", "Agreement not found.");
  const field = conv.clientId === userId ? "agreementConfirmedByClientAt" : "agreementConfirmedByTalentAt";
  if (msg[field]) return { ok: true, message: await serialiseMessage(db, msg, userId, conv) };
  const updated = await db.message.update({ where: { id: msg.id }, data: { [field]: new Date() } });
  return { ok: true, message: await serialiseMessage(db, updated, userId, conv) };
}

/** Report a message (any message, always available). A report on a pair with a running contract alerts the team at once. */
async function reportMessage({ conversationId, messageId, userId, reasonCode, note }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  const conv = await loadConversation(db, conversationId, userId);
  if (!conv) return fail(404, "not_found", "Conversation not found.");
  const msg = await db.message.findFirst({ where: { id: messageId, conversationId, state: "sent" } });
  if (!msg) return fail(404, "not_found", "Message not found.");
  if (msg.senderId === userId) return fail(400, "own_message", "You can't report your own message.");
  const reason = messaging.REPORT_REASONS.find((r) => r.code === reasonCode);
  if (!reason) return fail(400, "invalid", "Choose a reason.");
  const text = typeof note === "string" ? note.trim().slice(0, 500) : "";
  if (reason.code === "other" && text.length < 10) return fail(400, "invalid", "Say what is wrong, in at least 10 characters.");
  try {
    await db.messageReport.create({ data: { messageId: msg.id, reporterId: userId, reasonCode: reason.code, note: text || null } });
  } catch (err) {
    if (err.code === "P2002") return fail(409, "already_reported", "You've already reported this message.");
    throw err;
  }
  const active = await activeContractBetween(db, conv.clientId, conv.talentId);
  if (active) {
    await (deps.raiseAlert ?? require("./alerts").raiseAlert)(db, { severity: "urgent", queueKey: "safety-report", title: "Report on a live job", body: `A message was reported (${reason.label}) between two people with a job running.`, link: "/safety-reports" }, deps.alertDeps).catch((e) => console.error("messages: could not alert the team:", e.message));
  }
  console.log(`messages: reported message=${msg.id} by=${userId} reason=${reason.code} liveContract=${active}`);
  return { ok: true, urgent: active };
}

async function blockUser({ userId, targetId }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  if (userId === targetId) return fail(400, "invalid", "You can't block yourself.");
  const user = await db.user.findFirst({ where: { id: targetId, deletedAt: null }, select: { id: true, role: true } });
  if (!user) return fail(404, "not_found", "Person not found.");
  const me = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  const [clientId, talentId] = me.role === "client" ? [userId, targetId] : [targetId, userId];
  const allowed = messaging.blockAllowed({ activeContract: await activeContractBetween(db, clientId, talentId) });
  if (!allowed.ok) return fail(409, allowed.code, allowed.error);
  await db.userBlock.upsert({ where: { blockerId_blockedId: { blockerId: userId, blockedId: targetId } }, update: {}, create: { blockerId: userId, blockedId: targetId } });
  return { ok: true };
}

async function unblockUser({ userId, targetId }, deps = {}) {
  const db = deps.prisma ?? realPrisma;
  await db.userBlock.deleteMany({ where: { blockerId: userId, blockedId: targetId } });
  return { ok: true };
}

/** A talent's response time (D24): threads where a client wrote first, over the last 30 days. */
async function responseStatsFor(db, talentId, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const convs = await db.conversation.findMany({ where: { talentId, createdAt: { gte: since } }, select: { id: true, clientId: true } });
  const threads = [];
  for (const c of convs) {
    const first = await db.message.findFirst({ where: { conversationId: c.id, senderId: c.clientId, state: "sent" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
    if (!first) continue;
    const reply = await db.message.findFirst({ where: { conversationId: c.id, senderId: talentId, state: "sent", createdAt: { gt: first.createdAt } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
    threads.push({ clientFirstAt: first.createdAt, talentFirstReplyAt: reply?.createdAt ?? null });
  }
  return messaging.responseStats(threads, now);
}

module.exports = {
  startConversation,
  listConversations,
  openConversation,
  sendText,
  editMessage,
  startAttachment,
  completeAttachment,
  confirmAgreement,
  reportMessage,
  blockUser,
  unblockUser,
  responseStatsFor,
  awardedBetween,
  activeContractBetween,
  skillByKey,
};
