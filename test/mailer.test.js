// Stage 2 emails escape what users typed and name the deadline. Brevo is
// stubbed by replacing fetch in this process; no email is sent.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.BREVO_API_KEY = "test";
process.env.BREVO_SENDER_EMAIL = "noreply@example.com";
const captured = [];
global.fetch = async (_url, opts) => {
  captured.push(JSON.parse(opts.body));
  return { ok: true, text: async () => "" };
};
const mailer = require("../src/admin/mailer");

const EVIL = `<script>alert(1)</script>`;
const due = new Date("2026-10-10T12:00:00Z");

describe("stage 2 emails", () => {
  const cases = [
    ["sendExtensionRequested", { days: 2, reason: EVIL, proposedDeliverBy: due, answerDueAt: due }],
    ["sendExtensionAnswered", { outcome: "autoGranted", deliverByAt: due }],
    ["sendExtensionAutoGrantedToClient", { deliverByAt: due }],
    ["sendChangesRequested", { round: 2, maxRounds: 2, reason: EVIL, resubmitDueAt: due }],
    ["sendEscalated", { reason: "talent_missed_change_deadline" }],
    ["sendEscalationToAdmin", { contractId: "c1", reason: "client_rejected_after_final_round", note: EVIL }],
    ["sendDeliveryOverdueToClient", { deliverByAt: due }],
    ...["extension", "review", "change", "delivery", "deliveryPassed", "deliveryMissedPassed"].map((kind) => [
      "sendClockReminder",
      { kind, dueAt: due },
    ]),
  ];
  for (const [fn, args] of cases) {
    it(`${fn}${args.kind ? ` (${args.kind})` : ""}: escapes user text and states the date`, async () => {
      captured.length = 0;
      const r = await mailer[fn]({ to: "a@stubbed-brevo.dev", jobTitle: EVIL, ...args });
      assert.equal(r.sent, true);
      const html = captured[0].htmlContent;
      assert.ok(!html.includes("<script>"), "raw script tag in html");
      if (!["sendEscalated", "sendEscalationToAdmin"].includes(fn)) assert.match(html, /Oct/, "deadline date missing");
    });
  }

  it("an unknown reminder kind throws instead of sending nonsense", async () => {
    await assert.rejects(() => mailer.sendClockReminder({ to: "a@stubbed-brevo.dev", kind: "nope", jobTitle: "x", dueAt: due }));
  });
});

describe("reserved test domains are never emailed (they only bounce)", () => {
  it("recognises the reserved domains, their subdomains and reserved TLDs, and nothing real", () => {
    for (const reserved of ["ada.demo@example.com", "a@EXAMPLE.org", "a@example.net", "a@mail.example.com", "a@kingdomain.test", "a@x.invalid", "a@foo.example", "a@host.localhost", "a@example.com."]) {
      assert.equal(mailer.isReservedRecipient(reserved), true, reserved);
    }
    for (const real of ["ayeniv69@gmail.com", "ayeniv69+kdreset@gmail.com", "kehindealo18@gmail.com", "a@notexample.com", "a@example.com.ng", "a@mytest.io", "a@stubbed-brevo.dev", "no-at-sign", ""]) {
      assert.equal(mailer.isReservedRecipient(real), false, real);
    }
  });

  it("an email to a demo account makes no Brevo request and says it was skipped", async () => {
    captured.length = 0;
    const r = await mailer.sendVerificationCode({ to: "chinedu.demo@example.com", code: "123456" });
    assert.deepEqual(r, { sent: false, skipped: "reserved_address" });
    assert.equal(captured.length, 0, "nothing may be sent to Brevo");
  });

  it("the skip is logged without the email's subject, which carries the code", async () => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      await mailer.sendVerificationCode({ to: "chinedu.demo@example.com", code: "482913" });
      await mailer.sendUserPasswordResetCode({ to: "chinedu.demo@example.com", code: "482913", expiresInMinutes: 15 });
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(line, /skipped: chinedu\.demo@example\.com/);
      assert.ok(!line.includes("482913"), `a code leaked into the log: ${line}`);
    }
  });

  it("an email to a real address is still sent", async () => {
    captured.length = 0;
    const r = await mailer.sendVerificationCode({ to: "someone@gmail.com", code: "123456" });
    assert.equal(r.sent, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].to[0].email, "someone@gmail.com");
  });
});
