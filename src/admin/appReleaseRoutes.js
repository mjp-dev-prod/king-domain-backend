const express = require("express");
const { prisma } = require("../db");
const { requireAdmin } = require("./routes");

const router = express.Router();
router.use(requireAdmin);

function requireOwner(req, res, next) {
  if (req.admin.role !== "owner") {
    return res.status(403).json({ error: "Owner access required." });
  }
  next();
}

function isValidChangelog(changelog) {
  if (!changelog || typeof changelog !== "object") return false;
  const buckets = ["highlights", "improvements", "fixes"];
  const total = buckets.reduce((sum, key) => sum + (Array.isArray(changelog[key]) ? changelog[key].length : 0), 0);
  return total > 0;
}

router.get("/", async (req, res) => {
  const releases = await prisma.appRelease.findMany({ orderBy: { createdAt: "desc" } });
  return res.json({ releases });
});

router.post("/", requireAdmin, requireOwner, async (req, res) => {
  const { version, changelog, forceUpdate, minVersion } = req.body ?? {};

  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version.trim())) {
    return res.status(400).json({ error: "Version must be a semver string like 1.2.3." });
  }
  if (!isValidChangelog(changelog)) {
    return res.status(400).json({ error: "Changelog needs at least one highlight, improvement, or fix." });
  }

  const existing = await prisma.appRelease.findUnique({ where: { version: version.trim() } });
  if (existing) return res.status(409).json({ error: "A release with that version already exists." });

  const release = await prisma.appRelease.create({
    data: {
      version: version.trim(),
      changelog,
      // Authored intent only — the live `forceUpdate` flag starts false
      // regardless, and only ever flips via the dedicated activate route.
      forceUpdateRequested: Boolean(forceUpdate),
      minVersion: typeof minVersion === "string" && minVersion.trim() ? minVersion.trim() : "1.0.0",
    },
  });

  return res.status(201).json({ release });
});

router.post("/:id/publish", requireAdmin, requireOwner, async (req, res) => {
  const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
  if (!release) return res.status(404).json({ error: "Release not found." });
  if (release.status === "published") {
    return res.status(409).json({ error: "This release is already published." });
  }
  if (!release.apkUrl) {
    return res.status(400).json({ error: "No APK has been uploaded for this release yet." });
  }

  const [, updated] = await prisma.$transaction([
    prisma.appRelease.updateMany({ where: { isLatest: true }, data: { isLatest: false } }),
    prisma.appRelease.update({
      where: { id: release.id },
      data: {
        status: "published",
        isLatest: true,
        publishedAt: new Date(),
        // Deliberately false even if forceUpdateRequested was true — a
        // successful build/upload only means the APK exists, not that
        // anyone has confirmed it actually installs and runs correctly.
        // Force-update activation is a separate, explicit step.
        forceUpdate: false,
      },
    }),
  ]);

  return res.json({ release: updated });
});

router.post("/:id/activate-force-update", requireAdmin, requireOwner, async (req, res) => {
  const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
  if (!release) return res.status(404).json({ error: "Release not found." });
  if (release.status !== "published") {
    return res.status(400).json({ error: "Only a published release can force-update." });
  }
  if (release.forceUpdate) {
    return res.status(409).json({ error: "Force update is already active for this release." });
  }

  const updated = await prisma.appRelease.update({
    where: { id: release.id },
    data: { forceUpdate: true, forceUpdateActivatedAt: new Date() },
  });

  return res.json({ release: updated });
});

router.post("/:id/deactivate-force-update", requireAdmin, requireOwner, async (req, res) => {
  const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
  if (!release) return res.status(404).json({ error: "Release not found." });

  const updated = await prisma.appRelease.update({
    where: { id: release.id },
    // forceUpdateRequested is left untouched — this only pulls back the
    // live flag, not the admin's original authored intent.
    data: { forceUpdate: false, forceUpdateActivatedAt: null },
  });

  return res.json({ release: updated });
});

router.delete("/:id", requireAdmin, requireOwner, async (req, res) => {
  const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
  if (!release) return res.status(404).json({ error: "Release not found." });
  if (release.status !== "draft") {
    return res.status(400).json({ error: "Only a draft release can be deleted." });
  }

  await prisma.appRelease.delete({ where: { id: release.id } });
  return res.json({ ok: true });
});

module.exports = { router };
