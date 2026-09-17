const { createClient } = require("@supabase/supabase-js");

// Server-side only — the service role key bypasses row-level security, so
// this client must never be exposed to the admin frontend or the mobile app.
const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const supabase = configured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const APK_BUCKET = "app-releases";
const PROOF_ITEMS_BUCKET = "proof-items";
const DELIVERABLES_BUCKET = "deliverables";

/**
 * Upload an APK buffer to the app-releases bucket and return its public URL.
 * Overwrites any existing object at the same path (CI re-uploading the same
 * version is treated as replacing a bad build, not an error).
 */
async function uploadApk({ version, buffer }) {
  if (!supabase) {
    throw new Error("Supabase Storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  const path = `king-domain-${version}.apk`;

  const { error: uploadError } = await supabase.storage
    .from(APK_BUCKET)
    .upload(path, buffer, {
      contentType: "application/vnd.android.package-archive",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Supabase upload failed: ${uploadError.message}`);
  }

  const { data } = supabase.storage.from(APK_BUCKET).getPublicUrl(path);
  return data.publicUrl;
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
};
