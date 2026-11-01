// Reviews, reputation and portable credentials for the signed-in person (PRD §4.8), plus the public credential links
// anyone can check without signing in.
const express = require("express");
const { prisma } = require("../db");
const { requireUser } = require("./routes");
const { rateLimit } = require("../admin/rateLimit");
const reviews = require("../reviews");
const rep = require("../reputation");
const credentials = require("../credentials");

const router = express.Router(); // mounted at /jobs
const rootRouter = express.Router(); // mounted at /
const publicRouter = express.Router(); // mounted at /credentials, no sign-in
router.use(requireUser);

const limiter = rateLimit({ windowMs: 3600_000, max: 40, key: "review_action", by: (r) => r.user.id });
const send = (res, r, ok) => (r.ok === false ? res.status(r.status).json({ error: r.error, code: r.code }) : ok(r));

router.get("/:id/review", async (req, res) => {
  const state = await reviews.stateFor({ jobId: req.params.id, userId: req.user.id });
  if (!state) return res.status(404).json({ error: "Job not found." });
  res.json({ review: state });
});

router.post("/:id/review", limiter, async (req, res) => {
  const r = await reviews.submit({ jobId: req.params.id, userId: req.user.id, answers: req.body?.answers, comment: req.body?.comment, privateAgain: req.body?.privateAgain });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  res.status(r.edited ? 200 : 201).json({ review: await reviews.stateFor({ jobId: req.params.id, userId: req.user.id }) });
});

router.post("/:id/review/reply", limiter, async (req, res) => {
  const r = await reviews.reply({ jobId: req.params.id, userId: req.user.id, text: req.body?.text });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  res.json({ review: await reviews.stateFor({ jobId: req.params.id, userId: req.user.id }) });
});

rootRouter.post("/reviews/:id/report", requireUser, limiter, async (req, res) => {
  const r = await reviews.report({ reviewId: req.params.id, userId: req.user.id, reasonCode: req.body?.reasonCode, note: req.body?.note });
  send(res, r, () => res.status(201).json({ ok: true }));
});

rootRouter.get("/reviews/reasons", requireUser, (req, res) => res.json({ reasons: rep.REMOVAL_REASONS }));

/** The person's own reputation, as others see it (never the private answers). */
rootRouter.get("/users/me/reputation", requireUser, async (req, res) => {
  if (req.user.role === "talent") return res.json({ role: "talent", talent: await rep.talentReputation(req.user.id) });
  res.json({ role: "client", client: await rep.clientReputation(req.user.id) });
});

rootRouter.get("/users/me/credentials", requireUser, async (req, res) => {
  if (req.user.role !== "talent") return res.json({ credentials: [], signingAvailable: credentials.configured() });
  const rows = await credentials.sync(req.user.id);
  res.json({ credentials: rows.map(credentials.shape), signingAvailable: credentials.configured() });
});

// ── Public: anyone with the link can check a credential ──

publicRouter.get("/issuer", (req, res) => {
  const profile = credentials.issuerProfile();
  if (!profile) return res.status(404).json({ error: "Credentials aren't being issued yet." });
  res.json(profile);
});

/** The signed credential: the compact JWS an Open Badges 3.0 verifier reads. */
publicRouter.get("/:id", async (req, res) => {
  const row = await prisma.credential.findUnique({ where: { id: req.params.id } });
  if (!row || !row.jws) return res.status(404).json({ error: "Credential not found." });
  if (row.revokedAt) return res.status(410).json({ error: "This credential was revoked.", revokedAt: row.revokedAt });
  res.type("application/jwt").send(row.jws);
});

/** The same credential as readable JSON (unsigned view of the payload, for people rather than verifiers). */
publicRouter.get("/:id/json", async (req, res) => {
  const row = await prisma.credential.findUnique({ where: { id: req.params.id } });
  if (!row || !row.jws) return res.status(404).json({ error: "Credential not found." });
  if (row.revokedAt) return res.status(410).json({ error: "This credential was revoked.", revokedAt: row.revokedAt });
  const payload = JSON.parse(Buffer.from(row.jws.split(".")[1], "base64url").toString("utf8"));
  res.json(payload);
});

module.exports = { router, rootRouter, publicRouter };
