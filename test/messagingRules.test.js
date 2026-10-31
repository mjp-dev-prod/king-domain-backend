// Pure rules of S4, no database.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const m = require("../src/messaging");

const NOW = new Date("2026-11-20T12:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("held messages (D18)", () => {
  const codes = (text, awarded) => m.holdDecision({ text, awarded }).flags.map((f) => f.code);

  it("before an award, contact details, links, other chat apps, fees and meetings are held", () => {
    assert.ok(codes("call me on 08031234567", false).includes("phone"));
    assert.ok(codes("write to ada@example.com", false).includes("email"));
    assert.ok(codes("see https://example.com/x", false).includes("link"));
    assert.ok(codes("let's use whatsapp", false).includes("chat_app"));
    assert.ok(codes("pay a registration fee first", false).includes("pay_to_apply"));
    assert.ok(codes("come to my office", false).includes("meet"));
    assert.equal(m.holdDecision({ text: "call me on 08031234567", awarded: false }).hold, true);
  });

  it("after an award, contact details pass, but outside payment, fees and programs never do", () => {
    assert.equal(m.holdDecision({ text: "my number is 08031234567", awarded: true }).hold, false);
    assert.equal(m.holdDecision({ text: "email me at ada@example.com", awarded: true }).hold, false);
    assert.ok(codes("pay me directly outside the app", true).includes("outside_payment"));
    assert.ok(codes("install setup.apk", true).includes("apk"));
    assert.ok(codes("a registration fee first", true).includes("pay_to_apply"));
  });

  it("an ordinary message is never held, and the explanation names what was caught", () => {
    assert.equal(m.holdDecision({ text: "Can you send the draft by Friday?", awarded: false }).hold, false);
    const d = m.holdDecision({ text: "whatsapp me", awarded: false });
    assert.match(m.holdExplanation(d.flags, false), /Until a job is awarded/);
    assert.match(m.holdExplanation(d.flags, true), /always stay inside King Domain/);
  });
});

describe("editing (D27)", () => {
  const msg = (over = {}) => ({ senderId: "a", kind: "text", state: "sent", createdAt: ago(5 * MIN), ...over });
  it("only the sender, only text, only inside 15 minutes", () => {
    assert.deepEqual(m.canEdit(msg(), "a", NOW), { ok: true });
    assert.equal(m.canEdit(msg(), "b", NOW).reason, "not_yours");
    assert.equal(m.canEdit(msg({ kind: "voice" }), "a", NOW).reason, "not_text");
    assert.equal(m.canEdit(msg({ createdAt: ago(16 * MIN) }), "a", NOW).reason, "too_late");
    assert.equal(m.canEdit(msg({ state: "held" }), "a", NOW).reason, "not_sent");
  });
});

describe("text and agreements", () => {
  it("text must not be empty or enormous", () => {
    assert.equal(m.validateText("  ").ok, false);
    assert.equal(m.validateText("x".repeat(4001)).ok, false);
    assert.deepEqual(m.validateText(" hi "), { ok: true, text: "hi" });
  });
  it("an agreement says what, for how much and by when, so it has real length", () => {
    assert.equal(m.validateAgreement("ok").ok, false);
    assert.equal(m.validateAgreement("Three reels, ₦25,000, delivered by Friday 21 Nov.").ok, true);
  });
  it("an agreement counts only once both have confirmed", () => {
    const base = { agreementConfirmedByClientAt: ago(MIN), agreementConfirmedByTalentAt: null };
    assert.deepEqual(m.agreementState(base, true), { confirmedByMe: true, confirmedByOther: false, status: "waiting" });
    assert.deepEqual(m.agreementState(base, false), { confirmedByMe: false, confirmedByOther: true, status: "waiting" });
    assert.equal(m.agreementState({ ...base, agreementConfirmedByTalentAt: ago(MIN) }, false).status, "agreed");
  });
});

describe("attachments", () => {
  const ok = { kind: "voice", name: "note.m4a", contentType: "audio/mp4", sizeBytes: 100_000, durationSec: 40 };
  it("accepts a voice note up to 5 minutes, and says so when it is longer", () => {
    assert.equal(m.validateAttachment(ok).ok, true);
    assert.equal(m.validateAttachment({ ...ok, durationSec: 301 }).code, "too_long");
    assert.equal(m.validateAttachment({ ...ok, durationSec: undefined }).ok, false);
  });
  it("never accepts a program, whatever it claims to be", () => {
    assert.equal(m.validateAttachment({ kind: "file", name: "setup.apk", contentType: "application/octet-stream", sizeBytes: 10 }).code, "executable");
    assert.equal(m.validateAttachment({ kind: "file", name: "Setup.EXE", contentType: "application/pdf", sizeBytes: 10 }).code, "executable");
  });
  it("checks type and size by kind", () => {
    assert.equal(m.validateAttachment({ kind: "image", name: "a.png", contentType: "text/html", sizeBytes: 10 }).code, "type_not_allowed");
    assert.equal(m.validateAttachment({ kind: "image", name: "a.png", contentType: "image/png", sizeBytes: 20 * 1024 * 1024 }).code, "file_too_large");
    assert.equal(m.validateAttachment({ kind: "file", name: "brief.pdf", contentType: "application/pdf", sizeBytes: 5000 }).ok, true);
    assert.equal(m.validateAttachment({ kind: "nope", name: "a", contentType: "a", sizeBytes: 1 }).ok, false);
  });
});

describe("blocking", () => {
  it("is not available while a contract is active, and reporting is the way out", () => {
    assert.equal(m.blockAllowed({ activeContract: true }).code, "contract_active");
    assert.equal(m.blockAllowed({ activeContract: false }).ok, true);
  });
});

describe("response time (D24)", () => {
  it("is the median first reply over the last 30 days, in minutes", () => {
    const threads = [
      { clientFirstAt: ago(2 * HOUR), talentFirstReplyAt: ago(2 * HOUR - 10 * MIN) },
      { clientFirstAt: ago(5 * HOUR), talentFirstReplyAt: ago(5 * HOUR - 40 * MIN) },
      { clientFirstAt: ago(9 * HOUR), talentFirstReplyAt: ago(9 * HOUR - 90 * MIN) },
    ];
    assert.deepEqual(m.responseStats(threads, NOW), { medianMinutes: 40, conversations: 3 });
  });
  it("counts a thread nobody answered for 72 hours as slow, so the figure can't flatter, and leaves a fresh one out", () => {
    const threads = [
      { clientFirstAt: ago(100 * HOUR), talentFirstReplyAt: null },
      { clientFirstAt: ago(1 * HOUR), talentFirstReplyAt: null },
      { clientFirstAt: ago(3 * HOUR), talentFirstReplyAt: ago(3 * HOUR - 5 * MIN) },
    ];
    const s = m.responseStats(threads, NOW);
    assert.equal(s.conversations, 2);
    assert.equal(s.medianMinutes, 5, "nearest-rank median of [5, 4320]");
  });
  it("ignores anything older than 30 days, and has no figure with no data", () => {
    assert.deepEqual(m.responseStats([{ clientFirstAt: ago(40 * 24 * HOUR), talentFirstReplyAt: ago(40 * 24 * HOUR - MIN) }], NOW), { medianMinutes: null, conversations: 0 });
    assert.deepEqual(m.responseStats([], NOW), { medianMinutes: null, conversations: 0 });
  });
});
