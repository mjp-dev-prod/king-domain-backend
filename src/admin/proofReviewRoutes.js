const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const { getProofFileSignedUrl } = require("../storage");
const mailer = require("./mailer");

const router = express.Router();
router.use(requireAdmin);

// A ProofItem only reaches `verified` through a human reviewer hitting the
// approve route below; nothing on the talent-facing side
// (src/user/routes.js) can set that status itself.

// Prisma code for "record to update/delete not found" — another reviewer acted first.
const RECORD_GONE = "P2025";
const ALREADY_HANDLED = "Someone else just reviewed this submission. Refresh the list.";

const REJECT_REASON_MIN = 10;
const REJECT_REASON_MAX = 500;

/** Resolves filePath to a short-lived signed URL so a reviewer can actually
 * view the file — the proof-items bucket is private, see storage.js. */
async function serializeProofItem(item) {
  const profile = item.talentProfile;
  return {
    id: item.id,
    category: item.category,
    title: item.title,
    fileUrl: item.filePath ? await getProofFileSignedUrl(item.filePath) : null,
    fileName: item.filePath ? item.filePath.split("/").pop() : null,
    status: item.status,
    reviewedById: item.reviewedById,
    reviewedAt: item.reviewedAt,
    createdAt: item.createdAt,
    talent: profile?.user
      ? {
          id: profile.user.id,
          fullName: profile.user.fullName,
          email: profile.user.email,
          headline: profile.headline,
          bio: profile.bio,
          skillCategories: profile.skillCategories,
        }
      : null,
  };
}

const withTalent = { talentProfile: { include: { user: true } } };

/** Queue of items awaiting a decision, oldest first — a real review inbox. */
router.get("/", async (req, res) => {
  const status = req.query.status === "verified" ? "verified" : "pending";

  const items = await prisma.proofItem.findMany({
    where: { status },
    orderBy: { createdAt: status === "pending" ? "asc" : "desc" },
    include: withTalent,
  });

  return res.json({ proofItems: await Promise.all(items.map(serializeProofItem)) });
});

/** For the navigation badge — cheap, no signed URLs. */
router.get("/counts", async (req, res) => {
  const [pending, verified] = await Promise.all([
    prisma.proofItem.count({ where: { status: "pending" } }),
    prisma.proofItem.count({ where: { status: "verified" } }),
  ]);
  return res.json({ pending, verified });
});

router.get("/:id", async (req, res) => {
  const item = await prisma.proofItem.findUnique({ where: { id: req.params.id }, include: withTalent });
  if (!item) return res.status(404).json({ error: "Proof item not found." });
  return res.json({ proofItem: await serializeProofItem(item) });
});

router.post("/:id/approve", async (req, res) => {
  const item = await prisma.proofItem.findUnique({ where: { id: req.params.id }, include: withTalent });
  if (!item) return res.status(404).json({ error: "Proof item not found." });
  if (item.status === "verified") {
    return res.status(400).json({ error: "Already verified." });
  }

  let updated;
  try {
    updated = await prisma.proofItem.update({
      where: { id: item.id },
      data: { status: "verified", reviewedById: req.admin.id, reviewedAt: new Date() },
      include: withTalent,
    });
  } catch (err) {
    if (err.code === RECORD_GONE) return res.status(409).json({ error: ALREADY_HANDLED });
    throw err;
  }

  const to = item.talentProfile?.user?.email;
  const sent = to
    ? await mailer.sendProofVerified({ to, title: item.title, category: item.category })
    : { sent: false };
  console.log(`proof-review: approve item=${item.id} by admin=${req.admin.id} talent=${item.talentProfile?.userId} emailSent=${sent.sent}`);

  return res.json({ proofItem: await serializeProofItem(updated) });
});

/**
 * Rejecting has no enum state (ProofReviewStatus is only pending/verified,
 * matching the Flutter model): the item is deleted and the talent
 * resubmits. Because the item disappears from their profile, a reason is
 * required and emailed to them — otherwise their work just vanishes with
 * no explanation. Removal is only ever for items that never reached
 * verified, same rule as the talent's own delete in user/routes.js.
 */
router.post("/:id/reject", async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < REJECT_REASON_MIN) {
    return res.status(400).json({ error: `Give the talent a reason of at least ${REJECT_REASON_MIN} characters.` });
  }
  if (reason.length > REJECT_REASON_MAX) {
    return res.status(400).json({ error: `Keep the reason under ${REJECT_REASON_MAX} characters.` });
  }

  const item = await prisma.proofItem.findUnique({ where: { id: req.params.id }, include: withTalent });
  if (!item) return res.status(404).json({ error: "Proof item not found." });
  if (item.status === "verified") {
    return res.status(400).json({ error: "Can't reject an already-verified item." });
  }

  try {
    await prisma.proofItem.delete({ where: { id: item.id } });
  } catch (err) {
    if (err.code === RECORD_GONE) return res.status(409).json({ error: ALREADY_HANDLED });
    throw err;
  }

  const to = item.talentProfile?.user?.email;
  const sent = to
    ? await mailer.sendProofRejected({ to, title: item.title, category: item.category, reason })
    : { sent: false };
  console.log(
    `proof-review: reject item=${item.id} by admin=${req.admin.id} talent=${item.talentProfile?.userId} ` +
      `reasonLength=${reason.length} emailSent=${sent.sent}`,
  );

  return res.json({ ok: true });
});

module.exports = { router };
