const { createClient } = require("@supabase/supabase-js");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// Server-side only — the service role key bypasses row-level security, so
// this client must never be exposed to the admin frontend or the mobile app.
const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const supabase = configured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const PROOF_ITEMS_BUCKET = "proof-items";
const DELIVERABLES_BUCKET = "deliverables";

// APKs moved off Supabase Storage to Cloudflare R2 — Supabase's free tier
// caps individual file uploads at 50MB project-wide, and King Domain's
// first real release build came in at 50.19MB, over that cap (confirmed by
// a real production upload failure, not a preemptive guess). R2's free
// tier has no per-file size limit and no egress fees, so APK downloads by
// end users cost nothing either.
const r2Configured = Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
);
const r2 = r2Configured
  ? new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;
const R2_BUCKET = process.env.R2_APK_BUCKET || "king-domain-releases";

/**
 * Upload an APK buffer to Cloudflare R2 and return its public URL.
 * Overwrites any existing object at the same key (CI re-uploading the same
 * version is treated as replacing a bad build, not an error — R2's
 * PutObjectCommand overwrites by default, no explicit upsert flag needed).
 */
async function uploadApk({ version, buffer }) {
  if (!r2) {
    throw new Error("R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
  }

  const key = `king-domain-${version}.apk`;

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: "application/vnd.android.package-archive",
    }),
  );

  if (!process.env.R2_PUBLIC_URL) {
    throw new Error("R2_PUBLIC_URL is not set — required to build a downloadable APK URL.");
  }
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

/**
 * Upload a file to a private bucket and return its **storage path**, not a
 * public URL — both proof-items and deliverables are personal work
 * product, not a public download like the APK, so the DB stores a path and
 * getPrivateFileSignedUrl below mints a time-limited link from it on
 * demand. Path is namespaced by ownerId so one owner's files never collide
 * with another's, and includes a timestamp + the original filename — each
 * submission is its own file, never overwritten.
 */
async function uploadPrivateFile({ bucket, ownerId, buffer, originalName, contentType }) {
  if (!supabase) {
    throw new Error("Supabase Storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  const safeName = (originalName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${ownerId}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, {
      contentType: contentType || "application/octet-stream",
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Supabase upload failed: ${uploadError.message}`);
  }

  return path;
}

/**
 * Mint a short-lived signed URL for a stored private-bucket path. Called by
 * whoever is allowed to view the file right now — never stored or cached,
 * since a stale signed URL should just fail rather than silently keep
 * working past its window.
 */
async function getPrivateFileSignedUrl(bucket, path, expiresInSeconds = 300) {
  if (!supabase) {
    throw new Error("Supabase Storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);

  if (error) {
    throw new Error(`Supabase signed URL failed: ${error.message}`);
  }

  return data.signedUrl;
}

async function uploadProofFile({ talentProfileId, buffer, originalName, contentType }) {
  return uploadPrivateFile({ bucket: PROOF_ITEMS_BUCKET, ownerId: talentProfileId, buffer, originalName, contentType });
}

function getProofFileSignedUrl(path, expiresInSeconds = 300) {
  return getPrivateFileSignedUrl(PROOF_ITEMS_BUCKET, path, expiresInSeconds);
}

async function uploadDeliverableFile({ contractId, buffer, originalName, contentType }) {
  return uploadPrivateFile({ bucket: DELIVERABLES_BUCKET, ownerId: contractId, buffer, originalName, contentType });
}

function getDeliverableFileSignedUrl(path, expiresInSeconds = 300) {
  return getPrivateFileSignedUrl(DELIVERABLES_BUCKET, path, expiresInSeconds);
}

module.exports = {
  uploadApk,
  uploadProofFile,
  getProofFileSignedUrl,
  uploadDeliverableFile,
  getDeliverableFileSignedUrl,
  storageConfigured: configured,
  r2Configured,
};
