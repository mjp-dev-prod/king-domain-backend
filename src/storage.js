const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

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
/**
 * The object key for a release APK. Staging shares the production bucket, so
 * it sets R2_APK_PREFIX (e.g. "staging/"): without it a staging release
 * "1.3.0" would overwrite production's king-domain-1.3.0.apk. Unset keeps
 * production's keys exactly as they have always been.
 */
function apkKey(version, prefix = process.env.R2_APK_PREFIX || "") {
  if (prefix && !/^[a-z0-9-]+\/$/.test(prefix)) {
    throw new Error(`R2_APK_PREFIX must look like "staging/" (got "${prefix}").`);
  }
  return `${prefix}king-domain-${version}.apk`;
}

async function uploadApk({ version, buffer }) {
  if (!r2) {
    throw new Error("R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
  }

  const key = apkKey(version);

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

const APK_CONTENT_TYPE = "application/vnd.android.package-archive";
const APK_UPLOAD_LINK_TTL_SECONDS = 15 * 60;

/** The public download URL of a release APK (the same key uploadApk writes). */
function apkPublicUrl(version) {
  if (!process.env.R2_PUBLIC_URL) {
    throw new Error("R2_PUBLIC_URL is not set — required to build a downloadable APK URL.");
  }
  return `${process.env.R2_PUBLIC_URL}/${apkKey(version)}`;
}

/**
 * A one-use upload link so CI can send the APK straight to R2 instead of
 * through this server. A ~50 MB multipart upload through a small free web
 * service behind a proxy was unreliable (connections reset mid-upload, or the
 * server answered before the file arrived); R2 takes a 50 MB PUT without
 * trouble. The link is for one key, expires in 15 minutes and is useless for
 * anything else in the bucket.
 */
async function presignApkUpload({ version }) {
  if (!r2) {
    throw new Error("R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
  }
  const key = apkKey(version);
  const uploadUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: APK_CONTENT_TYPE }),
    { expiresIn: APK_UPLOAD_LINK_TTL_SECONDS },
  );
  return { uploadUrl, key, apkUrl: apkPublicUrl(version), contentType: APK_CONTENT_TYPE, expiresInSeconds: APK_UPLOAD_LINK_TTL_SECONDS };
}

/** Size in bytes of the stored APK for [version], or null if nothing is there. */
async function apkObjectSize({ version }) {
  if (!r2) {
    throw new Error("R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
  }
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: apkKey(version) }));
    return head.ContentLength ?? 0;
  } catch (err) {
    if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
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

// ── Profile photos: a PUBLIC bucket ─────────────────────────────────
// Unlike proofs and deliveries (private, links that expire in minutes), a profile photo is meant to
// be seen by everyone, so its link is permanent and needs no sign-in. Each upload gets its own random
// path, so a link never changes meaning and can be cached for good.
const AVATARS_BUCKET = "avatars";
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** The public link for a stored photo path, built from the project URL: never stored, never stale. */
function avatarPublicUrl(path) {
  const base = process.env.SUPABASE_URL;
  if (!path || !base) return null;
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/${AVATARS_BUCKET}/${path}`;
}

async function ensureAvatarsBucket() {
  const { error } = await supabase.storage.createBucket(AVATARS_BUCKET, {
    public: true,
    // Defence in depth: the storage service refuses anything else even if our checks were bypassed.
    fileSizeLimit: AVATAR_MAX_BYTES,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`Supabase bucket create failed: ${error.message}`);
  }
}

/** Stores a photo and returns its path. Creates the public bucket the first time it is needed. */
async function uploadAvatar({ userId, buffer, contentType, extension }) {
  if (!supabase) {
    throw new Error("Supabase Storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;
  const put = () => supabase.storage.from(AVATARS_BUCKET).upload(path, buffer, { contentType, upsert: false, cacheControl: "31536000" });
  let { error } = await put();
  if (error && /bucket not found/i.test(error.message)) {
    await ensureAvatarsBucket();
    ({ error } = await put());
  }
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  return path;
}

/** Removes files from a private bucket (account deletion). Missing files are not an error. */
async function removePrivateFiles(bucket, paths) {
  if (!supabase) throw new Error("Supabase Storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  if (!paths.length) return;
  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) throw new Error(`Supabase remove failed: ${error.message}`);
}

async function removeAvatar(path) {
  if (!supabase) throw new Error("Supabase Storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  const { error } = await supabase.storage.from(AVATARS_BUCKET).remove([path]);
  if (error) throw new Error(`Supabase remove failed: ${error.message}`);
}

// ── Skill evidence and walkthrough videos: a PRIVATE Cloudflare R2 bucket (PRD §4.3; D: video on R2) ──
// Uploads go straight from the phone to R2 through a presigned link, so a big video never passes through
// this server. The bucket must be a separate, private one (never the public APK bucket): R2_PRIVATE_BUCKET.
// R2_ENDPOINT overrides the account endpoint (tests point it at a local fake; path-style then).
const privateBucketName = process.env.R2_PRIVATE_BUCKET || "";
const privateUploadsConfigured = Boolean(r2Configured && privateBucketName);
const r2Private = privateUploadsConfigured
  ? new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: Boolean(process.env.R2_ENDPOINT),
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    })
  : null;

function requirePrivateR2() {
  if (!r2Private) throw new Error("Private uploads are not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PRIVATE_BUCKET.");
  return r2Private;
}

/** A link the phone PUTs the file to. The content type is part of the signature, so the file cannot be swapped for another kind. */
async function presignPrivatePut({ key, contentType, expiresInSeconds = 3600 }) {
  const client = requirePrivateR2();
  return getSignedUrl(client, new PutObjectCommand({ Bucket: privateBucketName, Key: key, ContentType: contentType }), {
    expiresIn: expiresInSeconds,
    signableHeaders: new Set(["content-type"]),
  });
}

/** What R2 actually holds at the key: size and ETag, or null when nothing was uploaded. */
async function headPrivate(key) {
  const client = requirePrivateR2();
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: privateBucketName, Key: key }));
    return { size: Number(r.ContentLength), etag: String(r.ETag ?? "").replace(/"/g, ""), contentType: r.ContentType };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return null;
    throw err;
  }
}

/** A short-lived link a reviewer opens the file with. */
function presignPrivateGet(key, expiresInSeconds = 300) {
  const client = requirePrivateR2();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: privateBucketName, Key: key }), { expiresIn: expiresInSeconds });
}

async function deletePrivateObjects(keys) {
  if (!keys.length) return;
  const client = requirePrivateR2();
  await client.send(new DeleteObjectsCommand({ Bucket: privateBucketName, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
}

// ── Identity documents and selfie videos: a PRIVATE bucket (PRD §4.4) ──
// Opened only inside a review, through links that expire in minutes. Created the first time it is
// needed, the same way the avatars bucket is, so a fresh environment needs no manual step.
const IDENTITY_BUCKET = "identity-docs";

async function ensureIdentityBucket() {
  const { error } = await supabase.storage.createBucket(IDENTITY_BUCKET, { public: false });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`Supabase bucket create failed: ${error.message}`);
  }
}

/** Stores an identity file and returns its path (`<userId>/<timestamp>-<name>`). */
async function uploadIdentityFile({ userId, buffer, originalName, contentType }) {
  if (!supabase) {
    throw new Error("Supabase Storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  const safeName = (originalName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${userId}/${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${safeName}`;
  const put = () => supabase.storage.from(IDENTITY_BUCKET).upload(path, buffer, { contentType, upsert: false });
  let { error } = await put();
  if (error && /bucket not found/i.test(error.message)) {
    await ensureIdentityBucket();
    ({ error } = await put());
  }
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  return path;
}

function getIdentityFileSignedUrl(path, expiresInSeconds = 300) {
  return getPrivateFileSignedUrl(IDENTITY_BUCKET, path, expiresInSeconds);
}

module.exports = {
  privateUploadsConfigured,
  presignPrivatePut,
  headPrivate,
  presignPrivateGet,
  deletePrivateObjects,
  IDENTITY_BUCKET,
  uploadIdentityFile,
  getIdentityFileSignedUrl,
  uploadAvatar,
  removeAvatar,
  removePrivateFiles,
  avatarPublicUrl,
  apkKey,
  apkPublicUrl,
  presignApkUpload,
  apkObjectSize,
  uploadApk,
  uploadProofFile,
  getProofFileSignedUrl,
  uploadDeliverableFile,
  getDeliverableFileSignedUrl,
  storageConfigured: configured,
  r2Configured,
};
