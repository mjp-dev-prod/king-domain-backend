// What the server accepts as an uploaded file (proof of skill, delivered work).
//
// The type is decided from the file's own first bytes. The client's mimetype and file name are
// never trusted: the stored content type decides how a signed link is served, so a file that
// merely claimed to be a picture (HTML, SVG, a program) must not be stored as one. The stored
// name is rebuilt from a cleaned base and the extension of the real type.
const multer = require("multer");

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const TYPES = {
  png: { contentType: "image/png", extension: "png" },
  jpeg: { contentType: "image/jpeg", extension: "jpg" },
  gif: { contentType: "image/gif", extension: "gif" },
  webp: { contentType: "image/webp", extension: "webp" },
  pdf: { contentType: "application/pdf", extension: "pdf" },
  heic: { contentType: "image/heic", extension: "heic" },
  heif: { contentType: "image/heif", extension: "heif" },
  // Short videos (identity selfie). Never accepted unless a route asks for them by name in `allow`.
  mp4: { contentType: "video/mp4", extension: "mp4" },
  mov: { contentType: "video/quicktime", extension: "mov" },
  webm: { contentType: "video/webm", extension: "webm" },
};

/** What a route accepts when it names nothing: pictures and PDFs, as before videos existed. */
const DEFAULT_ALLOW = ["png", "jpeg", "gif", "webp", "pdf", "heic", "heif"];
const VIDEO_ALLOW = ["mp4", "mov", "webm"];
const IMAGE_ALLOW = ["png", "jpeg", "webp", "heic", "heif"];

const MP4_BRANDS = ["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx"];
const HEIF_BRANDS = ["mif1", "msf1"];

/** The key (a TYPES key) of [buffer] from its leading bytes, or null when it is not one we accept. */
function sniffKey(buffer) {
  const at = (from, to) => buffer.toString("latin1", from, to);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 6 && (at(0, 6) === "GIF87a" || at(0, 6) === "GIF89a")) return "gif";
  if (buffer.length >= 12 && at(0, 4) === "RIFF" && at(8, 12) === "WEBP") return "webp";
  if (buffer.length >= 5 && at(0, 5) === "%PDF-") return "pdf";
  if (buffer.length >= 12 && at(4, 8) === "ftyp") {
    if (HEIC_BRANDS.includes(at(8, 12))) return "heic";
    if (HEIF_BRANDS.includes(at(8, 12))) return "heif";
    if (MP4_BRANDS.includes(at(8, 12))) return "mp4";
    if (at(8, 12) === "qt  ") return "mov";
  }
  // Matroska / WebM: the EBML header.
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "webm";
  return null;
}

const MAX_NAME_LENGTH = 64;

/** A storage-safe base name: no directories, no extension, only [A-Za-z0-9_-], never empty. */
function cleanBaseName(originalName, extension) {
  const name = typeof originalName === "string" ? originalName : "";
  const leaf = name.split(/[\\/]/).pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  const withoutExtension = (dot === -1 ? leaf : leaf.slice(0, dot)).replace(/^[.\s]+|[.\s]+$/g, "");
  const cleaned = withoutExtension.replace(/[^a-zA-Z0-9_-]/g, "_");
  const base = /^_*$/.test(cleaned) ? "upload" : cleaned;
  return base.slice(0, MAX_NAME_LENGTH - 1 - extension.length);
}

/**
 * Checks an uploaded file. On success: the real content type, the extension for it, and the name
 * to store it under. On refusal: an HTTP status, a stable code and a message for the person.
 */
function inspectUpload({ buffer, originalName, allow, unsupportedMessage }) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, status: 400, code: "empty_file", error: "That file is empty. Choose a different one." };
  }
  // [allow] narrows the accepted types for one route (a profile photo is only JPG, PNG or WebP).
  const key = sniffKey(buffer);
  const type = key && (allow ?? DEFAULT_ALLOW).includes(key) ? TYPES[key] : null;
  if (!type) {
    return {
      ok: false,
      status: 415,
      code: "unsupported_file",
      error: unsupportedMessage ?? "That file type isn't supported. Upload an image (JPG, PNG, WebP, GIF, HEIC) or a PDF.",
    };
  }
  return {
    ok: true,
    contentType: type.contentType,
    extension: type.extension,
    fileName: `${cleanBaseName(originalName, type.extension)}.${type.extension}`,
  };
}

/**
 * Express middleware for ONE optional file field: reads it into memory with a size cap and turns
 * multer's errors into clean answers instead of a 500.
 */
function singleFile(field, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1 } }).single(field);
  const limitMb = Math.round(maxBytes / (1024 * 1024));
  return (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: `That file is too large. The limit is ${limitMb} MB.`, code: "file_too_large" });
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ error: "Send one file at a time.", code: "too_many_files" });
      }
      return next(err);
    });
}

/**
 * After singleFile: when a file was sent, checks it and leaves the safe values on `req.upload`
 * ({ buffer, contentType, fileName }). No file is fine (the field is optional). Anything that
 * fails the check is refused here, before storage is touched.
 */
function checkUploadOf(options = {}) {
  return (req, res, next) => {
    if (!req.file) return next();
    const checked = inspectUpload({ buffer: req.file.buffer, originalName: req.file.originalname, ...options });
    if (!checked.ok) return res.status(checked.status).json({ error: checked.error, code: checked.code });
    req.upload = { buffer: req.file.buffer, contentType: checked.contentType, extension: checked.extension, fileName: checked.fileName };
    return next();
  };
}
const checkUpload = checkUploadOf();

/** Profile photos: pictures a phone can always draw. No GIF (not animated avatars), no HEIC, no PDF. */
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const checkPhoto = checkUploadOf({
  allow: ["png", "jpeg", "webp"],
  unsupportedMessage: "That file type isn't supported. Choose a JPG, PNG or WebP picture.",
});

/**
 * Identity submissions: a document photo (10 MB) and a short live video (25 MB), in one request.
 * Each is checked by its own bytes in the route with IMAGE_ALLOW and VIDEO_ALLOW.
 */
const IDENTITY_VIDEO_MAX_BYTES = 25 * 1024 * 1024;
function identityFiles() {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IDENTITY_VIDEO_MAX_BYTES, files: 2 } }).fields([
    { name: "document", maxCount: 1 },
    { name: "video", maxCount: 1 },
  ]);
  return (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "That file is too large. Photos can be up to 10 MB and the video up to 25 MB.", code: "file_too_large" });
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ error: "Send one document photo and one video.", code: "too_many_files" });
      }
      return next(err);
    });
}

module.exports = {
  MAX_UPLOAD_BYTES,
  PHOTO_MAX_BYTES,
  IDENTITY_VIDEO_MAX_BYTES,
  IMAGE_ALLOW,
  VIDEO_ALLOW,
  inspectUpload,
  singleFile,
  identityFiles,
  checkUpload,
  checkPhoto,
};
