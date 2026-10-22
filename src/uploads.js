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
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx"];
const HEIF_BRANDS = ["mif1", "msf1"];

/** The type of [buffer] from its leading bytes, or null when it is not one we accept. */
function sniffType(buffer) {
  const at = (from, to) => buffer.toString("latin1", from, to);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return TYPES.png;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return TYPES.jpeg;
  if (buffer.length >= 6 && (at(0, 6) === "GIF87a" || at(0, 6) === "GIF89a")) return TYPES.gif;
  if (buffer.length >= 12 && at(0, 4) === "RIFF" && at(8, 12) === "WEBP") return TYPES.webp;
  if (buffer.length >= 5 && at(0, 5) === "%PDF-") return TYPES.pdf;
  if (buffer.length >= 12 && at(4, 8) === "ftyp") {
    if (HEIC_BRANDS.includes(at(8, 12))) return TYPES.heic;
    if (HEIF_BRANDS.includes(at(8, 12))) return TYPES.heif;
  }
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
function inspectUpload({ buffer, originalName }) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, status: 400, code: "empty_file", error: "That file is empty. Choose a different one." };
  }
  const type = sniffType(buffer);
  if (!type) {
    return {
      ok: false,
      status: 415,
      code: "unsupported_file",
      error: "That file type isn't supported. Upload an image (JPG, PNG, WebP, GIF, HEIC) or a PDF.",
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
function singleFile(field) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }).single(field);
  return (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "That file is too large. The limit is 10 MB.", code: "file_too_large" });
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
function checkUpload(req, res, next) {
  if (!req.file) return next();
  const checked = inspectUpload({ buffer: req.file.buffer, originalName: req.file.originalname });
  if (!checked.ok) return res.status(checked.status).json({ error: checked.error, code: checked.code });
  req.upload = { buffer: req.file.buffer, contentType: checked.contentType, fileName: checked.fileName };
  return next();
}

module.exports = { MAX_UPLOAD_BYTES, inspectUpload, singleFile, checkUpload };
