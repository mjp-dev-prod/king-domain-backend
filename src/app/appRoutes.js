const express = require("express");
const multer = require("multer");
const { prisma } = require("../db");
const { uploadApk } = require("../storage");

const router = express.Router();
// Matches the app-releases Supabase Storage bucket's own 50MB file-size
// limit (the project's free tier caps it there) — keep these in sync.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/** What the mobile app polls at launch/resume to check for updates. */
router.get("/version", async (req, res) => {
  const release = await prisma.appRelease.findFirst({
    where: { status: "published", isLatest: true },
  });

  if (!release) {
    return res.json({
      latest_version: null,
      min_supported_version: "1.0.0",
      force_update: false,
      apk_url: null,
      changelog: null,
    });
  }

  return res.json({
    latest_version: release.version,
    min_supported_version: release.minVersion,
    force_update: release.forceUpdate,
    apk_url: release.apkUrl,
    changelog: release.changelog,
  });
});

/** What CI fetches before building — the version/changelog a human already authored. */
router.get("/release/pending", async (req, res) => {
  const expected = process.env.CI_API_TOKEN;
  const auth = req.headers["authorization"];
  if (!expected || auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const release = await prisma.appRelease.findFirst({
    where: { status: "draft" },
    orderBy: { createdAt: "desc" },
  });

  if (!release) {
    return res.status(404).json({
      error: "No draft release found. Create one from the admin dashboard before building.",
    });
  }

  return res.json({ version: release.version, changelog: release.changelog });
});

/**
 * CI uploads the built APK here once it has a version to attach it to.
 * Stores the file in Supabase Storage but does NOT publish — publishing is
 * a separate, deliberate admin action taken after manually verifying the
 * build actually installs and runs correctly.
 */
router.post("/release/:version/upload", upload.single("apk"), async (req, res) => {
  const expected = process.env.CI_API_TOKEN;
  const auth = req.headers["authorization"];
  if (!expected || auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No APK file uploaded (expected field name 'apk')." });
  }

  const release = await prisma.appRelease.findUnique({ where: { version: req.params.version } });
  if (!release) return res.status(404).json({ error: "No release found for that version." });
  if (release.status !== "draft") {
    return res.status(400).json({ error: "Only draft releases accept an APK upload." });
  }

  const apkUrl = await uploadApk({ version: release.version, buffer: req.file.buffer });

  await prisma.appRelease.update({ where: { id: release.id }, data: { apkUrl } });

  return res.json({ ok: true, apkUrl });
});

module.exports = { router };
