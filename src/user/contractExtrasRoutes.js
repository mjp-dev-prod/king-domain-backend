// The contract room's extra pieces (PRD §3.1 steps 10 to 13, §4.2, §4.10): the start proof and the 20% release,
// shared drafts, receipts, and the display currency. Mounted at /jobs, next to the original contract routes.
const express = require("express");
const crypto = require("node:crypto");
const { prisma } = require("../db");
const { requireUser } = require("./routes");
const { rateLimit } = require("../admin/rateLimit");
const storage = require("../storage");
const sp = require("../startProof");
const fx = require("../fx");
const { skillByKey } = require("../skills");
const { recordEvent } = require("../contractCore");
const { notify } = require("../discovery");

const router = express.Router();
const rootRouter = express.Router();
router.use(requireUser);

// ── Who is who on a contract ─────────────────────────────

async function loadContract(req, res, next) {
  const job = await prisma.job.findUnique({ where: { id: req.params.id }, include: { contract: true, client: true } });
  if (!job || !job.contract) return res.status(404).json({ error: "Contract not found." });
  const application = job.awardedApplicationId ? await prisma.application.findUnique({ where: { id: job.awardedApplicationId }, include: { talent: true } }) : null;
  req.job = job;
  req.contract = job.contract;
  req.talent = application?.talent ?? null;
  req.isClient = job.clientId === req.user.id;
  req.isTalent = application?.talentId === req.user.id;
  if (!req.isClient && !req.isTalent) return res.status(404).json({ error: "Contract not found." });
  next();
}

const talentOnly = (req, res, next) => (req.isTalent ? next() : res.status(403).json({ error: "Only the talent on this job can do that." }));
const clientOnly = (req, res, next) => (req.isClient ? next() : res.status(403).json({ error: "Only the client on this job can do that." }));

const reply = (res, r, ok = (x) => x, status = 200) => (r.ok === false ? res.status(r.status).json({ error: r.error, code: r.code, missing: r.missing }) : res.status(status).json(ok(r)));

// ── The start proof ──────────────────────────────────────

async function proofView(req) {
  const c = req.contract;
  const job = req.job;
  const items = await prisma.startProofItem.findMany({ where: { contractId: c.id, round: c.startProofRound }, orderBy: { createdAt: "asc" } });
  const check = sp.checkProof(job.skillKey, items);
  const fields = sp.specFor(job.skillKey).map((f) => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    min: f.min,
    max: f.max,
    items: items.filter((i) => i.fieldKey === f.key && i.status === "ready").map((i) => ({ id: i.id, text: i.text, name: i.name, contentType: i.contentType, sizeBytes: i.sizeBytes })),
  }));
  // Files are shown by short-lived links, to the two people on the job and no one else.
  for (const f of fields) {
    for (const it of f.items) {
      const row = items.find((i) => i.id === it.id);
      if (row?.objectKey) it.url = await sp.linkFor(row.objectKey);
    }
  }
  return {
    startProof: {
      required: Boolean(job.skillKey),
      status: c.startProofStatus,
      round: c.startProofRound,
      submittedAt: c.startProofSubmittedAt,
      dueAt: c.startProofDueAt,
      acceptedAt: c.startProofAcceptedAt,
      objection: c.startProofObjection,
      upfrontAmount: sp.upfrontAmountOf(job.budget),
      upfrontPaidAt: c.upfrontPaidAt,
      fields,
      missing: check.missing,
      readyToSend: check.ok,
      objectionReasons: sp.OBJECTION_REASONS,
      uploadsAvailable: storage.privateUploadsConfigured,
      currency: job.currency,
    },
  };
}

router.get("/:id/contract/start-proof", loadContract, async (req, res) => res.json(await proofView(req)));

const editable = (req) => ["funded", "inProgress"].includes(req.contract.status) && [null, "redo"].includes(req.contract.startProofStatus);

/** A typed part (an outline) or a link (a repository, a staging site). */
router.post("/:id/contract/start-proof/items", loadContract, talentOnly, async (req, res) => {
  if (!req.job.skillKey) return res.status(400).json({ error: "This job has no start proof." });
  if (!editable(req)) return res.status(409).json({ error: "The start proof can't be changed now.", code: "locked" });
  const field = sp.specFor(req.job.skillKey).find((f) => f.key === req.body?.fieldKey);
  if (!field || !["text", "link"].includes(field.kind)) return res.status(400).json({ error: "That part of the proof isn't typed in." });
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 4000) : "";
  if (field.kind === "link" && !sp.validUrl(text)) return res.status(400).json({ error: "The link must start with http:// or https://." });
  if (field.kind === "text" && text.length < 20) return res.status(400).json({ error: "Write at least 20 characters." });
  // One typed answer per field: writing again replaces it.
  await prisma.startProofItem.deleteMany({ where: { contractId: req.contract.id, round: req.contract.startProofRound, fieldKey: field.key } });
  await prisma.startProofItem.create({ data: { contractId: req.contract.id, round: req.contract.startProofRound, fieldKey: field.key, kind: field.kind, text } });
  res.status(201).json(await proofView(req));
});

router.post("/:id/contract/start-proof/files", loadContract, talentOnly, rateLimit({ windowMs: 3600_000, max: 100, key: "start_proof_file", by: (r) => r.user.id }), async (req, res) => {
  if (!storage.privateUploadsConfigured) return res.status(503).json({ error: "Sending files isn't available right now. Try again later.", code: "uploads_unavailable" });
  if (!editable(req)) return res.status(409).json({ error: "The start proof can't be changed now.", code: "locked" });
  const checked = sp.validateFileInput({ ...(req.body ?? {}), skillKey: req.job.skillKey });
  if (!checked.ok) return res.status(checked.status).json({ error: checked.error, code: checked.code });
  const existing = await prisma.startProofItem.count({ where: { contractId: req.contract.id, round: req.contract.startProofRound, fieldKey: checked.field.key } });
  if (existing >= checked.field.max) return res.status(400).json({ error: `${checked.field.label}: at most ${checked.field.max}. Remove one first.`, code: "too_many" });
  const key = `start-proof/${req.contract.id}/${crypto.randomUUID()}-${checked.value.name}`;
  const item = await prisma.startProofItem.create({
    data: { contractId: req.contract.id, round: req.contract.startProofRound, fieldKey: checked.field.key, kind: checked.field.kind, name: checked.value.name, contentType: checked.value.contentType, sizeBytes: checked.value.sizeBytes, objectKey: key, status: "pending" },
  });
  const url = await storage.presignPrivatePut({ key, contentType: checked.value.contentType });
  res.status(201).json({ itemId: item.id, upload: { url, method: "PUT", headers: { "Content-Type": checked.value.contentType } } });
});

router.post("/:id/contract/start-proof/files/:itemId/complete", loadContract, talentOnly, async (req, res) => {
  const item = await prisma.startProofItem.findFirst({ where: { id: req.params.itemId, contractId: req.contract.id, status: "pending" } });
  if (!item) return res.status(404).json({ error: "File not found." });
  const held = await storage.headPrivate(item.objectKey);
  if (!held) return res.status(409).json({ error: "The upload didn't finish. Try adding the file again.", code: "upload_missing" });
  if (held.size !== item.sizeBytes) {
    await storage.deletePrivateObjects([item.objectKey]).catch(() => {});
    await prisma.startProofItem.delete({ where: { id: item.id } });
    return res.status(400).json({ error: "The uploaded file wasn't the size you said, so it was removed. Add it again.", code: "size_mismatch" });
  }
  await prisma.startProofItem.update({ where: { id: item.id }, data: { status: "ready" } });
  console.log(`start-proof: file ready item=${item.id} field=${item.fieldKey} bytes=${held.size} etag=${held.etag}`);
  res.json(await proofView(req));
});

router.delete("/:id/contract/start-proof/items/:itemId", loadContract, talentOnly, async (req, res) => {
  if (!editable(req)) return res.status(409).json({ error: "The start proof can't be changed now.", code: "locked" });
  const item = await prisma.startProofItem.findFirst({ where: { id: req.params.itemId, contractId: req.contract.id, round: req.contract.startProofRound } });
  if (!item) return res.status(404).json({ error: "Not found." });
  await prisma.startProofItem.delete({ where: { id: item.id } });
  if (item.objectKey && storage.privateUploadsConfigured) await storage.deletePrivateObjects([item.objectKey]).catch(() => {});
  res.json(await proofView(req));
});

router.post("/:id/contract/start-proof/submit", loadContract, talentOnly, async (req, res) => {
  const r = await sp.submitProof({ contractId: req.contract.id });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code, missing: r.missing });
  req.contract = r.contract;
  res.json(await proofView(req));
});

router.post("/:id/contract/start-proof/accept", loadContract, clientOnly, async (req, res) => {
  if (req.contract.startProofStatus !== "submitted") return res.status(409).json({ error: "There is no start proof waiting for you.", code: "not_awaiting" });
  const r = await sp.releaseUpfront({ contractId: req.contract.id, trigger: "client_accepted" });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  if (req.talent) notify(req.talent.id, { title: "Your start proof was accepted", body: "The first 20% is on its way to your bank account.", data: { type: "start_proof", jobId: req.job.id } });
  req.contract = r.contract;
  res.json(await proofView(req));
});

router.post("/:id/contract/start-proof/object", loadContract, clientOnly, async (req, res) => {
  const r = await sp.objectToProof({ contractId: req.contract.id, reasonCode: req.body?.reasonCode, note: req.body?.note });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code });
  req.contract = r.contract;
  res.json(await proofView(req));
});

// ── Drafts: shared without starting the review clock ─────

async function draftsView(contractId) {
  const rows = await prisma.contractDraft.findMany({ where: { contractId, status: "ready" }, orderBy: { createdAt: "desc" }, take: 50 });
  return Promise.all(
    rows.map(async (d) => ({
      id: d.id,
      note: d.note,
      createdAt: d.createdAt,
      files: await Promise.all((d.files ?? []).map(async (f) => ({ name: f.name, contentType: f.contentType, sizeBytes: f.sizeBytes, url: await sp.linkFor(f.objectKey) }))),
    })),
  );
}

router.get("/:id/contract/drafts", loadContract, async (req, res) => res.json({ drafts: await draftsView(req.contract.id), uploadsAvailable: storage.privateUploadsConfigured }));

router.post("/:id/contract/drafts", loadContract, talentOnly, rateLimit({ windowMs: 3600_000, max: 30, key: "draft_share", by: (r) => r.user.id }), async (req, res) => {
  if (!storage.privateUploadsConfigured) return res.status(503).json({ error: "Sharing files isn't available right now. Try again later.", code: "uploads_unavailable" });
  if (!["funded", "inProgress", "changesRequested"].includes(req.contract.status)) return res.status(409).json({ error: "You can share a draft while the job is being worked on.", code: "wrong_status" });
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 600) : "";
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (files.length < 1 || files.length > 10) return res.status(400).json({ error: "Share 1 to 10 files." });
  const entries = [];
  for (const f of files) {
    const type = typeof f?.contentType === "string" ? f.contentType.toLowerCase() : "";
    const name = typeof f?.name === "string" ? f.name.trim().slice(0, 120) : "";
    const size = Number(f?.sizeBytes);
    if (!name || !Number.isInteger(size) || size <= 0 || size > 500 * 1024 * 1024) return res.status(400).json({ error: "A file needs a name and a size under 500 MB." });
    if (/\.(?:apk|exe|bat|msi|scr|cmd|com|jar|dmg|sh|ps1|vbs)$/i.test(name)) return res.status(400).json({ error: "Programs and installers can't be sent here.", code: "executable" });
    if (!type || type.startsWith("text/html") || type.includes("svg")) return res.status(400).json({ error: "That kind of file can't be shared.", code: "type_not_allowed" });
    entries.push({ name: name.replace(/[^A-Za-z0-9._ -]+/g, "_"), contentType: type, sizeBytes: size, objectKey: `drafts/${req.contract.id}/${crypto.randomUUID()}-${name.replace(/[^A-Za-z0-9._-]+/g, "_")}` });
  }
  const draft = await prisma.contractDraft.create({ data: { contractId: req.contract.id, note, files: entries, status: "pending" } });
  const uploads = await Promise.all(entries.map(async (e) => ({ name: e.name, url: await storage.presignPrivatePut({ key: e.objectKey, contentType: e.contentType }), headers: { "Content-Type": e.contentType } })));
  res.status(201).json({ draftId: draft.id, uploads });
});

router.post("/:id/contract/drafts/:draftId/complete", loadContract, talentOnly, async (req, res) => {
  const draft = await prisma.contractDraft.findFirst({ where: { id: req.params.draftId, contractId: req.contract.id } });
  if (!draft) return res.status(404).json({ error: "Draft not found." });
  if (draft.status === "ready") return res.json({ drafts: await draftsView(req.contract.id) });
  for (const f of draft.files) {
    const held = await storage.headPrivate(f.objectKey);
    if (!held) return res.status(409).json({ error: `${f.name} didn't finish uploading. Try sharing again.`, code: "upload_missing" });
    if (held.size !== f.sizeBytes) {
      await storage.deletePrivateObjects(draft.files.map((x) => x.objectKey)).catch(() => {});
      await prisma.contractDraft.delete({ where: { id: draft.id } });
      return res.status(400).json({ error: `${f.name} wasn't the size you said, so the draft was removed. Share it again.`, code: "size_mismatch" });
    }
  }
  await prisma.contractDraft.update({ where: { id: draft.id }, data: { status: "ready" } });
  await recordEvent(prisma, { jobId: req.job.id, contractId: req.contract.id, type: "draftShared", meta: { files: draft.files.length } });
  notify(req.job.clientId, { title: "A draft to look at", body: `${req.job.title}: no need to do anything yet. This is work in progress.`, data: { type: "draft", jobId: req.job.id } });
  console.log(`drafts: shared draft=${draft.id} contract=${req.contract.id} files=${draft.files.length}`);
  res.json({ drafts: await draftsView(req.contract.id) });
});

// ── Receipts (PRD §4.9, §4.10) ───────────────────────────

/** What Paystack asks for when a payment is questioned: who paid, how much, when, for what, and the approvals. */
router.get("/:id/contract/receipt", loadContract, async (req, res) => {
  const { job, contract } = req;
  if (!contract.fundedAt) return res.status(409).json({ error: "There is no receipt until the job has been paid for.", code: "not_paid" });
  const price = Number(job.budget);
  const fee = Number(contract.platformFeeAmount ?? 0);
  const events = await prisma.contractEvent.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" }, take: 100 });
  const base = {
    jobTitle: job.title,
    service: job.skillKey ? `${skillByKey(job.skillKey)?.label ?? job.category}: ${job.title}` : `${job.category}: ${job.title}`,
    currency: job.currency,
    price,
    platformFee: fee,
    totalPaidByClient: price + fee,
    paidAt: contract.fundedAt,
    reference: contract.paystackReference,
    client: { name: job.client.legalName ?? job.client.fullName },
    talent: req.talent ? { name: req.talent.legalName ?? req.talent.fullName } : null,
    status: contract.status,
    events: events.map((e) => ({ type: e.type, at: e.createdAt })),
  };
  if (req.isTalent) {
    base.payouts = {
      upfront: contract.upfrontPaidAt ? { amount: Number(contract.upfrontAmount), paidAt: contract.upfrontPaidAt, reference: contract.upfrontTransferCode } : null,
      final: contract.transferredAt ? { amount: price - Number(contract.upfrontPaidAt ? contract.upfrontAmount : 0), paidAt: contract.transferredAt, reference: contract.paystackTransferCode } : null,
    };
  }
  res.json({ receipt: base, viewer: req.isClient ? "client" : "talent" });
});

/** Every paid job for the signed-in person: what they paid (client) or are paid (talent). */
router.get("/receipts/mine", async (req, res) => {
  const where = req.user.role === "client" ? { clientId: req.user.id } : { applications: { some: { talentId: req.user.id, status: "selected" } } };
  const jobs = await prisma.job.findMany({ where: { ...where, contract: { fundedAt: { not: null } } }, include: { contract: true }, orderBy: { updatedAt: "desc" }, take: 100 });
  res.json({
    receipts: jobs.map((j) => ({
      jobId: j.id,
      title: j.title,
      currency: j.currency,
      amount: req.user.role === "client" ? Number(j.budget) + Number(j.contract.platformFeeAmount ?? 0) : Number(j.budget),
      paidAt: j.contract.fundedAt,
      status: j.contract.status,
    })),
  });
});

// ── Display currency and the rate (D37) ──────────────────

rootRouter.get("/rates", requireUser, (req, res) => res.json(fx.currentRate()));

rootRouter.get("/users/me/settings", requireUser, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { displayCurrency: true } });
  res.json({ displayCurrency: user.displayCurrency });
});

rootRouter.patch("/users/me/settings", requireUser, async (req, res) => {
  const c = req.body?.displayCurrency;
  if (c !== "NGN" && c !== "USD") return res.status(400).json({ error: "Choose naira or dollars." });
  await prisma.user.update({ where: { id: req.user.id }, data: { displayCurrency: c } });
  res.json({ displayCurrency: c });
});

module.exports = { router, rootRouter };
