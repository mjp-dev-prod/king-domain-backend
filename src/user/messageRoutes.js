// Messaging (PRD §4.7; D18, D26, D27). Mounted at the root; paths are written in full.
const express = require("express");
const { requireUser } = require("./routes");
const { rateLimit } = require("../admin/rateLimit");
const convo = require("../conversations");

const router = express.Router();

const sendLimit = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.MESSAGE_RATE_LIMIT || 60), key: "user_messages", by: (req) => req.user.id });

/** Turns a service result into a response: its status when it refused, 200 with the body otherwise. */
function reply(res, result, ok = (r) => r, status = 200) {
  if (result.ok === false) return res.status(result.status).json({ error: result.error, code: result.code });
  return res.status(status).json(ok(result));
}

router.get("/conversations", requireUser, async (req, res) => {
  res.json({ conversations: await convo.listConversations(req.user.id) });
});

router.post("/conversations", requireUser, async (req, res) => {
  if (req.user.role !== "client") return res.status(403).json({ error: "A client starts a conversation. Talents reply." });
  const r = await convo.startConversation({ clientId: req.user.id, talentId: req.body?.talentId });
  return reply(res, r, (x) => ({ conversationId: x.conversation.id, created: x.created }), r.created ? 201 : 200);
});

router.get("/conversations/:id", requireUser, async (req, res) => {
  const r = await convo.openConversation({ id: req.params.id, userId: req.user.id, after: typeof req.query.after === "string" ? req.query.after : undefined });
  return reply(res, r, ({ ok, ...rest }) => rest);
});

router.post("/conversations/:id/messages", requireUser, sendLimit, async (req, res) => {
  const r = await convo.sendText({ conversationId: req.params.id, userId: req.user.id, clientMsgId: req.body?.clientMsgId, body: req.body?.body });
  return reply(res, r, ({ ok, ...rest }) => rest, r.duplicate ? 200 : 201);
});

router.patch("/conversations/:id/messages/:mid", requireUser, async (req, res) => {
  const r = await convo.editMessage({ conversationId: req.params.id, messageId: req.params.mid, userId: req.user.id, body: req.body?.body });
  return reply(res, r, ({ ok, ...rest }) => rest);
});

router.post("/conversations/:id/attachments", requireUser, sendLimit, async (req, res) => {
  const b = req.body ?? {};
  const r = await convo.startAttachment({ conversationId: req.params.id, userId: req.user.id, clientMsgId: b.clientMsgId, input: b });
  return reply(res, r, ({ ok, ...rest }) => rest, 201);
});

router.post("/conversations/:id/messages/:mid/complete", requireUser, async (req, res) => {
  const r = await convo.completeAttachment({ conversationId: req.params.id, messageId: req.params.mid, userId: req.user.id });
  return reply(res, r, ({ ok, ...rest }) => rest);
});

router.post("/conversations/:id/agreements", requireUser, sendLimit, async (req, res) => {
  const r = await convo.sendText({ conversationId: req.params.id, userId: req.user.id, clientMsgId: req.body?.clientMsgId, body: req.body?.body, kind: "agreement" });
  return reply(res, r, ({ ok, ...rest }) => rest, 201);
});

router.post("/conversations/:id/messages/:mid/confirm", requireUser, async (req, res) => {
  const r = await convo.confirmAgreement({ conversationId: req.params.id, messageId: req.params.mid, userId: req.user.id });
  return reply(res, r, ({ ok, ...rest }) => rest);
});

router.post("/conversations/:id/messages/:mid/report", requireUser, rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: "user_report", by: (req) => req.user.id }), async (req, res) => {
  const r = await convo.reportMessage({ conversationId: req.params.id, messageId: req.params.mid, userId: req.user.id, reasonCode: req.body?.reasonCode, note: req.body?.note });
  return reply(res, r, ({ urgent }) => ({ ok: true, urgent }), 201);
});

router.post("/users/:id/block", requireUser, async (req, res) => {
  return reply(res, await convo.blockUser({ userId: req.user.id, targetId: req.params.id }));
});

router.delete("/users/:id/block", requireUser, async (req, res) => {
  return reply(res, await convo.unblockUser({ userId: req.user.id, targetId: req.params.id }));
});

module.exports = { router };
