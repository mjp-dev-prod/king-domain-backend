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
      const r = await mailer[fn]({ to: "a@example.com", jobTitle: EVIL, ...args });
      assert.equal(r.sent, true);
      const html = captured[0].htmlContent;
      assert.ok(!html.includes("<script>"), "raw script tag in html");
      if (!["sendEscalated", "sendEscalationToAdmin"].includes(fn)) assert.match(html, /Oct/, "deadline date missing");
    });
  }

  it("an unknown reminder kind throws instead of sending nonsense", async () => {
    await assert.rejects(() => mailer.sendClockReminder({ to: "a@example.com", kind: "nope", jobTitle: "x", dueAt: due }));
  });
});
