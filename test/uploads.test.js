// What the server will accept as an upload. The type comes from the file's own first bytes:
// the client's mimetype and filename are never trusted (they decide how a signed link is served).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { inspectUpload } = require("../src/uploads");

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
const pad = (b, n = 64) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);

const SAMPLES = {
  png: pad(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: pad(bytes([0xff, 0xd8, 0xff, 0xe0])),
  gif87: pad(bytes("GIF87a")),
  gif89: pad(bytes("GIF89a")),
  webp: pad(bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ")),
  pdf: pad(bytes("%PDF-1.7\n")),
  heic: pad(bytes([0, 0, 0, 0x18], "ftypheic")),
  heif: pad(bytes([0, 0, 0, 0x18], "ftypmif1")),
};

describe("inspectUpload: accepted types, decided by the bytes", () => {
  const cases = [
    ["png", "image/png", "png"],
    ["jpeg", "image/jpeg", "jpg"],
    ["gif87", "image/gif", "gif"],
    ["gif89", "image/gif", "gif"],
    ["webp", "image/webp", "webp"],
    ["pdf", "application/pdf", "pdf"],
    ["heic", "image/heic", "heic"],
    ["heif", "image/heif", "heif"],
  ];
  for (const [name, contentType, extension] of cases) {
    it(`${name} is accepted as ${contentType}`, () => {
      const r = inspectUpload({ buffer: SAMPLES[name], originalName: "work" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.contentType, contentType);
      assert.equal(r.extension, extension);
      assert.equal(r.fileName, `work.${extension}`);
    });
  }
});

describe("inspectUpload: refusals", () => {
  it("HTML named like a picture is refused, however it is labelled", () => {
    const html = bytes("<!doctype html><script>alert(1)</script>");
    for (const originalName of ["photo.png", "photo.jpg", "x.pdf", "page.html"]) {
      const r = inspectUpload({ buffer: html, originalName, claimedType: "image/png" });
      assert.equal(r.ok, false, originalName);
      assert.equal(r.status, 415);
      assert.equal(r.code, "unsupported_file");
      assert.match(r.error, /JPG, PNG, WebP, GIF/);
    }
  });

  it("SVG (it can carry script), a Windows program, a zip and plain text are refused", () => {
    const refused = [bytes('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), bytes("MZ", Buffer.alloc(60)), bytes("PK\x03\x04", Buffer.alloc(60)), bytes("just some text, not a file")];
    for (const buffer of refused) assert.equal(inspectUpload({ buffer, originalName: "a.png" }).code, "unsupported_file");
  });

  it("an empty file is refused with its own message", () => {
    const r = inspectUpload({ buffer: Buffer.alloc(0), originalName: "a.png" });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(r.code, "empty_file");
  });

  it("a header that is cut short is not mistaken for a file", () => {
    assert.equal(inspectUpload({ buffer: bytes([0x89, 0x50, 0x4e]), originalName: "a.png" }).code, "unsupported_file");
    assert.equal(inspectUpload({ buffer: bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "), originalName: "a.webp" }).code, "unsupported_file", "RIFF but not WEBP");
    assert.equal(inspectUpload({ buffer: pad(bytes([0, 0, 0, 0x18], "ftypmp42")), originalName: "a.mp4" }).code, "unsupported_file", "an MP4 is not an image");
  });
});

describe("inspectUpload: the stored file name", () => {
  const png = SAMPLES.png;
  it("the extension follows the real type, not the name the client gave", () => {
    assert.equal(inspectUpload({ buffer: png, originalName: "holiday.jpg" }).fileName, "holiday.png");
    assert.equal(inspectUpload({ buffer: png, originalName: "noextension" }).fileName, "noextension.png");
  });

  it("directories, spaces and odd characters are removed; a missing name becomes upload", () => {
    assert.equal(inspectUpload({ buffer: png, originalName: "../../etc/passwd.png" }).fileName, "passwd.png");
    assert.equal(inspectUpload({ buffer: png, originalName: String.raw`C:\Users\Ada\My Logo (final).PNG` }).fileName, "My_Logo__final_.png");
    assert.equal(inspectUpload({ buffer: png, originalName: "" }).fileName, "upload.png");
    assert.equal(inspectUpload({ buffer: png, originalName: undefined }).fileName, "upload.png");
    assert.equal(inspectUpload({ buffer: png, originalName: "....png" }).fileName, "upload.png");
  });

  it("a very long name is cut so the storage path stays reasonable", () => {
    const r = inspectUpload({ buffer: png, originalName: `${"a".repeat(300)}.png` });
    assert.ok(r.fileName.length <= 64, r.fileName.length);
    assert.ok(r.fileName.endsWith(".png"));
  });
});
