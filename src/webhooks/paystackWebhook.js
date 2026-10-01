// Mounted BEFORE express.json() in index.js, using express.raw() for this
// path specifically — HMAC verification must run against the exact raw
// bytes Paystack signed, not a re-serialized JSON.stringify(req.body),
// which can differ in key order/whitespace and silently fail verification.
const express = require("express");
const crypto = require("crypto");
const { confirmFunding } = require("../contractFunding");

const router = express.Router();

function verifySignature(rawBody, signature) {
  if (!signature || !process.env.PAYSTACK_SECRET_KEY) return false;
  const expected = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * One of two paths to funding — the other is the app calling
 * POST /jobs/:id/contract/verify-payment when the client returns from
 * checkout, which asks Paystack directly. A missed webhook therefore
 * only leaves a contract unfunded until the client reopens it. There is
 * no background reconciliation job yet: a contract whose client never
 * returns AND whose webhook never arrives stays awaitingPayment.
 */
router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!verifySignature(req.body, signature)) {
    return res.status(401).json({ error: "Invalid signature." });
  }

  // Always 200 quickly — Paystack retries on non-200, and slow processing
  // here would just cause duplicate retries, not a real fix.
  res.sendStatus(200);

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    console.error("paystackWebhook: invalid JSON body:", err);
    return;
  }

  try {
    if (event.event === "charge.success") {
      await confirmFunding({ reference: event.data.reference, amountKobo: event.data.amount, source: "webhook" });
    } else if (event.event === "transfer.success") {
      console.log(`paystackWebhook: payout delivered reference=${event.data.reference} amount=${event.data.amount}`);
    } else if (event.event === "transfer.failed" || event.event === "transfer.reversed") {
      // The contract was already marked approved when Paystack accepted the
      // transfer as pending. The money is back in our balance; it has to be
      // re-sent by hand until payout state is tracked on the contract.
      console.error(
        `paystackWebhook: PAYOUT FAILED needs manual retry — event=${event.event} ` +
          `reference=${event.data.reference} amount=${event.data.amount} reason=${event.data.reason}`,
      );
    }
  } catch (err) {
    console.error(`paystackWebhook: failed handling ${event.event}:`, err);
  }
});

module.exports = { router };
