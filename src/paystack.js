// Real money movement for King Domain — see docs/research (shareholder
// decisions "Set King Domain's platform fee on job payments" and the
// original Paystack track approval). Paystack has no native escrow
// product: a client's payment lands in OUR Paystack balance (the funding
// charge), and approving delivered work moves it out again via a separate
// Transfer call to the talent's own bank account. Nothing sits in an
// in-app wallet at any point.
//
// Transfers only complete in one call if "Confirm transfers before
// sending" (transfer OTP) is off in the Paystack business's Preferences —
// a per-business setting. With it on, POST /transfer returns status `otp`
// and the approve route refuses to mark the contract paid.
// Overridable only so the test suite can point the real client at a local fake.
const PAYSTACK_BASE = process.env.PAYSTACK_BASE_URL || "https://api.paystack.co";

const configured = Boolean(process.env.PAYSTACK_SECRET_KEY);

/// 10% — see the shareholder decision "Set King Domain's platform fee on
/// job payments" (2026-09-18). Charged on top of the job budget, paid by
/// the client; the talent always receives the full posted budget. A
/// starting number, not permanent — revisit once there's real volume.
const PLATFORM_FEE_RATE = 0.10;

function calculatePlatformFee(budgetNaira) {
  return Math.round(Number(budgetNaira) * PLATFORM_FEE_RATE * 100) / 100;
}

async function paystackFetch(path, { method = "GET", body } = {}) {
  if (!configured) {
    throw new Error("Paystack is not configured — set PAYSTACK_SECRET_KEY.");
  }

  const response = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.status) {
    const error = new Error(data?.message || `Paystack API responded ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }

  return data.data;
}

/** Naira -> kobo. Paystack takes every amount in the currency's subunit. */
function toKobo(naira) {
  return Math.round(Number(naira) * 100);
}

function fromKobo(kobo) {
  return Number(kobo) / 100;
}

/**
 * Starts a real payment. Returns the hosted checkout URL to hand the
 * client's browser/webview off to — we never collect card details
 * ourselves. amountNaira should already include the platform fee (job
 * budget + platformFeeAmount), computed by the caller.
 */
async function initializeTransaction({ email, amountNaira, reference, metadata }) {
  const data = await paystackFetch("/transaction/initialize", {
    method: "POST",
    body: {
      email,
      amount: String(toKobo(amountNaira)),
      reference,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
    },
  });
  return { authorizationUrl: data.authorization_url, accessCode: data.access_code, reference: data.reference };
}

/**
 * Source of truth for a transaction's real status — used both by the
 * webhook handler (belt-and-braces re-check, never trust the webhook
 * payload's own status field alone) and a reconciliation job for
 * transactions whose webhook never arrived.
 */
async function verifyTransaction(reference) {
  const data = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
  return { status: data.status, amountKobo: data.amount, reference: data.reference };
}

/** Nigerian banks, for the bank-details picker UI. */
async function listBanks() {
  const data = await paystackFetch("/bank?currency=NGN&country=nigeria");
  return data.map((b) => ({ name: b.name, code: b.code }));
}

/**
 * Confirms an account number is real and returns the account holder's
 * name so the talent can visually confirm it's actually theirs before we
 * save it — same UX as adding a new payee in a banking app.
 */
async function resolveAccountNumber({ accountNumber, bankCode }) {
  const data = await paystackFetch(
    `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
  );
  return { accountNumber: String(data.account_number), accountName: data.account_name };
}

/**
 * Creates a reusable payout destination. Called once per talent (or again
 * if they change their bank details) — the returned recipient_code is
 * what every future Transfer for that talent is addressed to.
 */
async function createTransferRecipient({ accountNumber, bankCode, accountName }) {
  const data = await paystackFetch("/transferrecipient", {
    method: "POST",
    body: { type: "nuban", name: accountName, account_number: accountNumber, bank_code: bankCode, currency: "NGN" },
  });
  return { recipientCode: data.recipient_code };
}

/**
 * The actual "release payment" action — moves money out of our Paystack
 * balance to the talent's bank account. amountNaira here is the job
 * budget ONLY, never budget + platform fee — the fee stays in our balance.
 * Returned status is not final: `pending` resolves later via the
 * transfer.success / transfer.failed / transfer.reversed webhooks.
 */
async function initiateTransfer({ amountNaira, recipientCode, reference, reason }) {
  const data = await paystackFetch("/transfer", {
    method: "POST",
    body: {
      source: "balance",
      amount: toKobo(amountNaira),
      recipient: recipientCode,
      reference,
      reason,
    },
  });
  return { transferCode: data.transfer_code, status: data.status };
}

/** Returns null when Paystack has no transfer with this reference (404). */
async function verifyTransfer(reference) {
  try {
    const data = await paystackFetch(`/transfer/verify/${encodeURIComponent(reference)}`);
    return { transferCode: data.transfer_code, status: data.status };
  } catch (err) {
    if (err.httpStatus === 404) return null;
    throw err;
  }
}

module.exports = {
  configured,
  PLATFORM_FEE_RATE,
  calculatePlatformFee,
  toKobo,
  fromKobo,
  initializeTransaction,
  verifyTransaction,
  listBanks,
  resolveAccountNumber,
  createTransferRecipient,
  initiateTransfer,
  verifyTransfer,
};
