const { createClient } = require("@supabase/supabase-js");

// Server-side only — the service role key bypasses row-level security, so
// this client must never be exposed to the admin frontend or the mobile app.
const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const supabase = configured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const APK_BUCKET = "app-releases";

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

module.exports = { uploadApk, storageConfigured: configured };
