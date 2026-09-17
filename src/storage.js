const { createClient } = require("@supabase/supabase-js");

// Server-side only — the service role key bypasses row-level security, so
// this client must never be exposed to the admin frontend or the mobile app.
const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const supabase = configured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const APK_BUCKET = "app-releases";
const PROOF_ITEMS_BUCKET = "proof-items";

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
 * Upload a proof-item file (a work sample a talent submits for human
 * review) and return its **storage path**, not a public URL — the
 * proof-items bucket is private (a work sample is personal content, not a
 * public download like the APK), so ProofItem.fileUrl actually stores a
 * path, and getProofFileSignedUrl below mints a time-limited link from it
 * on demand. Path is namespaced by talentProfileId so one talent's files
 * never collide with another's, and includes a timestamp + the original
 * filename — unlike uploadApk, a proof item isn't "the same slot, replace
 * on re-upload"; each submission is its own file.
 */
async function uploadProofFile({ talentProfileId, buffer, originalName, contentType }) {
  if (!supabase) {
    throw new Error("Supabase Storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  const safeName = (originalName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${talentProfileId}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(PROOF_ITEMS_BUCKET)
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
 * Mint a short-lived signed URL for a stored proof-item path. Called by
 * whoever is allowed to view the file right now (the owning talent, or an
 * admin reviewing it) — never stored or cached, since a stale signed URL
 * should just fail rather than silently keep working past its window.
 */
async function getProofFileSignedUrl(path, expiresInSeconds = 300) {
  if (!supabase) {
    throw new Error("Supabase Storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  const { data, error } = await supabase.storage
    .from(PROOF_ITEMS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error) {
    throw new Error(`Supabase signed URL failed: ${error.message}`);
  }

  return data.signedUrl;
}

module.exports = { uploadApk, uploadProofFile, getProofFileSignedUrl, storageConfigured: configured };
