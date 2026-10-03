const crypto = require("crypto");
const express = require("express");

// A real APK of this app is ~50 MB. Anything far smaller means the upload to
// the link didn't actually land (an error page, an empty file), and attaching
// it to a release would hand testers a broken download.
const MIN_APK_BYTES = 5 * 1024 * 1024;

/** Same CI bearer-token check as the other /app/release routes, compared in constant time. */
function ciAuthorized(req) {
  const expected = process.env.CI_API_TOKEN;
  if (!expected) return false;
  const given = Buffer.from(String(req.headers["authorization"] ?? ""));
  const want = Buffer.from(`Bearer ${expected}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/**
 * CI uploads the APK straight to R2 in three small steps instead of pushing
 * ~50 MB through this server (which was unreliable on the free hosting: see
 * storage.presignApkUpload):
 *   1. POST /release/:version/upload-url -> a one-use link for that version's file
 *   2. CI PUTs the APK to that link (this server never sees the bytes)
 *   3. POST /release/:version/complete   -> the server checks the file is really
 *      there and big enough, then attaches its URL to the draft
 * Publishing stays a separate, human action in the admin dashboard.
 */
function buildCiUploadRouter({ prisma, storage }) {
  const router = express.Router();

  async function draftFor(version, res) {
    const release = await prisma.appRelease.findUnique({ where: { version } });
    if (!release) {
      res.status(404).json({ error: "No release found for that version." });
      return null;
    }
    if (release.status !== "draft") {
      res.status(400).json({ error: "Only draft releases accept an APK." });
      return null;
    }
    return release;
  }

  router.post("/release/:version/upload-url", async (req, res) => {
    try {
      if (!ciAuthorized(req)) return res.status(401).json({ error: "Unauthorized." });
      const release = await draftFor(req.params.version, res);
      if (!release) return;

      const link = await storage.presignApkUpload({ version: release.version });
      console.log(`ci-upload: link issued version=${release.version} key=${link.key} expires_in=${link.expiresInSeconds}s`);
      return res.json({
        uploadUrl: link.uploadUrl,
        contentType: link.contentType,
        apkUrl: link.apkUrl,
        expiresInSeconds: link.expiresInSeconds,
      });
    } catch (err) {
      console.error("ci-upload: could not issue an upload link:", err);
      return res.status(500).json({ error: "Could not create an upload link." });
    }
  });

  router.post("/release/:version/complete", async (req, res) => {
    try {
      if (!ciAuthorized(req)) return res.status(401).json({ error: "Unauthorized." });
      const release = await draftFor(req.params.version, res);
      if (!release) return;

      const size = await storage.apkObjectSize({ version: release.version });
      console.log(`ci-upload: complete version=${release.version} stored_bytes=${size} min_bytes=${MIN_APK_BYTES}`);
      if (size === null) {
        return res.status(400).json({ error: "No APK found in storage for that version. Upload to the link from upload-url first." });
      }
      if (size < MIN_APK_BYTES) {
        return res.status(400).json({ error: `The stored file is only ${size} bytes, too small to be the APK. Upload it again.` });
      }

      const apkUrl = storage.apkPublicUrl(release.version);
      // Only a still-draft release may change; publishing could have raced us.
      const { count } = await prisma.appRelease.updateMany({
        where: { id: release.id, status: "draft" },
        data: { apkUrl },
      });
      if (count === 0) return res.status(409).json({ error: "That release is no longer a draft." });

      return res.json({ ok: true, apkUrl, sizeBytes: size });
    } catch (err) {
      console.error("ci-upload: could not complete the upload:", err);
      return res.status(500).json({ error: "Could not finish attaching the APK." });
    }
  });

  return router;
}

module.exports = { buildCiUploadRouter, ciAuthorized, MIN_APK_BYTES };
