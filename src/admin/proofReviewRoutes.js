const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");
const { getProofFileSignedUrl } = require("../storage");

const router = express.Router();
router.use(requireAdmin);

// This is the real replacement for king-domain-mobile's
// TalentProfileNotifier.simulateReviewApproval() — see that method's own
// comment: "Real approval happens on the admin side once that flow
// exists." A ProofItem only reaches `verified` through a human reviewer
// hitting the approve route below; nothing on the talent-facing side
// (src/user/routes.js) can set that status itself.

/** Resolves filePath to a short-lived signed URL so a reviewer can actually
 * view the file — the proof-items bucket is private, see storage.js. */
async function serializeProofItem(item) {
  return {
    id: item.id,
    category: item.category,
    title: item.title,
    fileUrl: item.filePath ? await getProofFileSignedUrl(item.filePath) : null,
    status: item.status,
    reviewedById: item.reviewedById,
    reviewedAt: item.reviewedAt,
    createdAt: item.createdAt,
    talent: item.talentProfile?.user
      ? {
          id: item.talentProfile.user.id,
          fullName: item.talentProfile.user.fullName,
          email: item.talentProfile.user.email,
        }
      : null,
  };
}

/** Queue of items awaiting a decision, oldest first — a real review inbox. */
router.get("/", async (req, res) => {
  const status = req.query.status === "verified" ? "verified" : "pending";

  const items = await prisma.proofItem.findMany({
    where: { status },
    orderBy: { createdAt: "asc" },
    include: { talentProfile: { include: { user: true } } },
  });

  return res.json({ proofItems: await Promise.all(items.map(serializeProofItem)) });
});

router.get("/:id", async (req, res) => {
  const item = await prisma.proofItem.findUnique({
    where: { id: req.params.id },
    include: { talentProfile: { include: { user: true } } },
  });
  if (!item) return res.status(404).json({ error: "Proof item not found." });
  return res.json({ proofItem: await serializeProofItem(item) });
});

router.post("/:id/approve", async (req, res) => {
  const item = await prisma.proofItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Proof item not found." });
  if (item.status === "verified") {
    return res.status(400).json({ error: "Already verified." });
  }

  const updated = await prisma.proofItem.update({
    where: { id: item.id },
    data: { status: "verified", reviewedById: req.admin.id, reviewedAt: new Date() },
    include: { talentProfile: { include: { user: true } } },
  });

  return res.json({ proofItem: await serializeProofItem(updated) });
});

/**
 * Rejecting doesn't have its own enum state (ProofReviewStatus is only
 * pending/verified, matching the Flutter model exactly) — a reviewer
 * rejecting a submission deletes it and the talent resubmits, rather than
 * the item sitting in a permanent "rejected" state with no path forward.
 * This mirrors requireTalentProfile's own delete rule in user/routes.js:
 * removal is only ever for items that never reached verified.
 */
router.post("/:id/reject", async (req, res) => {
  const item = await prisma.proofItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Proof item not found." });
  if (item.status === "verified") {
    return res.status(400).json({ error: "Can't reject an already-verified item." });
  }

  await prisma.proofItem.delete({ where: { id: item.id } });
  return res.json({ ok: true });
});

module.exports = { router };
