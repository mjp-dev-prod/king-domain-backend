// The clocks on a job's money (shareholder decision "How a job gets paid",
// ledger 736051b0-…, 2026-10-01): a 24h payment window after award, and a
// 3-day review window after delivery. Everything here is driven by
// timestamps stored on the Contract, never by an in-memory timer, so a
// restart or a sleeping server only delays a step — the next tick catches up.
//
// Dependencies are passed in (defaulting to the real ones) so the rules can
// be exercised with a fake payment provider: a Starter-business Paystack
// test key refuses real transfers, which would otherwise leave the success
// paths untested.
const realPrisma = require("./db").prisma;
const realPaystack = require("./paystack");
const realMailer = require("./admin/mailer");
const { confirmFunding } = require("./contractFunding");
const { HOUR, RULES, autoReleaseEnabled, recordEvent } = require("./contractCore");
const extensions = require("./contractExtensions");
const changes = require("./contractChanges");

const IN_FLIGHT_TRANSACTION_STATUSES = new Set(["ongoing", "pending", "processing", "queued"]);
const WINDOWS = {
  paymentMs: 24 * HOUR,
  reviewMs: RULES.reviewMs,
  // A bank transfer can still be settling after the client leaves checkout,
  // so cancellation waits this long after the latest checkout was opened.
  checkoutGraceMs: 30 * 60 * 1000,
  // Paystack reports `ongoing` while a customer is mid bank-transfer and
  // `pending`/`processing` while a charge settles. Cancellation waits for
  // those, but never longer than this past the deadline: the docs don't say
  // how long `ongoing` can last, and a payment that still lands afterwards is
  // caught as an orphan payment.
  inFlightHardCapMs: 6 * HOUR,
  autoReleaseRetryMs: HOUR,
  autoReleaseMaxAttempts: 24,
};

function defaults(deps = {}) {
  return {
    prisma: deps.prisma ?? realPrisma,
    paystack: deps.paystack ?? realPaystack,
    mailer: deps.mailer ?? realMailer,
    now: deps.now ?? (() => new Date()),
    autoRelease: deps.autoRelease ?? autoReleaseEnabled(),
  };
}

// ── Money out (shared by the client's Approve and the auto-release) ──────

// Statuses where money is, or may still be, moving — never start another
// transfer on top of one of these.
const LIVE_TRANSFER_STATUSES = new Set(["success", "pending", "otp", "received"]);

/**
 * Payout references are kd_payout_<contractId>_<n>, one per attempt.
 * Returns the first attempt that is still live (reuse it, don't pay again)
 * or the first unused reference after conclusively failed ones. Two
 * concurrent releases land on the same next reference, so Paystack's
 * duplicate-reference check stops a double payout.
 */
async function findPayoutAttempt(paystack, contractId) {
  for (let n = 1; n <= 10; n++) {
    const reference = `kd_payout_${contractId}_${n}`;
    const existing = await paystack.verifyTransfer(reference);
    if (!existing || LIVE_TRANSFER_STATUSES.has(existing.status)) return { reference, existing };
  }
  throw new Error("Too many failed payout attempts for this contract — check the Paystack dashboard.");
}

/**
 * Sends the job budget (never the fee) to the awarded talent and marks the
 * contract approved — only if Paystack accepts the transfer.
 * Returns { ok: true, contract } or { ok: false, status, code, error }.
 */
async function releasePayment({ contractId, trigger }, deps) {
  const { prisma, paystack, now } = defaults(deps);

  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { job: true } });
  if (!contract) return { ok: false, status: 404, code: "not_found", error: "Contract not found." };
  if (contract.status !== "submitted") {
    return { ok: false, status: 400, code: "not_submitted", error: `Contract must be 'submitted' (currently '${contract.status}').` };
  }

  const application = await prisma.application.findUnique({ where: { id: contract.job.awardedApplicationId } });
  const talentProfile = application
    ? await prisma.talentProfile.findUnique({ where: { userId: application.talentId } })
    : null;
  if (!talentProfile?.paystackRecipientCode) {
    return { ok: false, status: 400, code: "no_payout_account", error: "The talent hasn't set up a payout bank account yet." };
  }

  // Claim the release before any money moves, so a change request (or a
  // second release) can't slip in between the transfer and the status
  // update. A claim older than RULES.releaseClaimStaleMs belongs to a release
  // that crashed mid-way and may be taken over: findPayoutAttempt still
  // reuses any transfer that crash left live.
  const claimedAt = now();
  const claim = await prisma.contract.updateMany({
    where: {
      id: contract.id,
      status: "submitted",
      OR: [{ releaseClaimedAt: null }, { releaseClaimedAt: { lte: new Date(claimedAt.getTime() - RULES.releaseClaimStaleMs) } }],
    },
    data: { releaseClaimedAt: claimedAt },
  });
  console.log(
    `release: claim contract=${contract.id} trigger=${trigger} claimed=${claim.count === 1} previousClaim=${contract.releaseClaimedAt?.toISOString() ?? "none"}`,
  );
  if (claim.count === 0) {
    return { ok: false, status: 409, code: "release_in_progress", error: "Payment is already being released. Refresh in a moment." };
  }
  const unclaim = () =>
    prisma.contract.updateMany({ where: { id: contract.id, releaseClaimedAt: claimedAt }, data: { releaseClaimedAt: null } });

  let attempt;
  let transfer;
  try {
    attempt = await findPayoutAttempt(paystack, contract.id);
    transfer =
      attempt.existing ??
      (await paystack.initiateTransfer({
        amountNaira: contract.job.budget,
        recipientCode: talentProfile.paystackRecipientCode,
        reference: attempt.reference,
        reason: `Payment for "${contract.job.title}"`,
      }));
  } catch (err) {
    await unclaim();
    return { ok: false, status: 502, code: "transfer_error", error: err.message || "Could not release payment right now." };
  }

  console.log(
    `release: contract=${contract.id} trigger=${trigger} reference=${attempt.reference} ` +
      `reused=${Boolean(attempt.existing)} transfer=${transfer.transferCode} status=${transfer.status}`,
  );

  if (transfer.status === "otp" || transfer.status === "received") {
    console.error(
      `release: PAYOUT NOT SENT — ${attempt.reference} is waiting on transfer approval (status=${transfer.status}). ` +
        `Turn off "Confirm transfers before sending" in Paystack Preferences. contract=${contract.id}`,
    );
    await unclaim();
    return { ok: false, status: 502, code: "transfer_waiting", error: "Payment couldn't be released yet. Please try again later." };
  }
  if (transfer.status !== "success" && transfer.status !== "pending") {
    console.error(`release: PAYOUT NOT SENT — ${attempt.reference} status=${transfer.status} contract=${contract.id}`);
    await unclaim();
    return { ok: false, status: 502, code: "transfer_failed", error: "Payment couldn't be released right now. Please try again shortly." };
  }

  // Conditional on still being 'submitted': if the client's tap and the
  // auto-release raced, only one of them records the release.
  const { count } = await prisma.contract.updateMany({
    where: { id: contract.id, status: "submitted" },
    data: { status: "approved", paystackTransferCode: transfer.transferCode, transferredAt: new Date() },
  });
  const updated = await prisma.contract.findUnique({ where: { id: contract.id } });
  await recordEvent(prisma, {
    jobId: contract.jobId,
    contractId: contract.id,
    type: "released",
    meta: { trigger, transferCode: transfer.transferCode, transferStatus: transfer.status, recorded: count === 1 },
  });
  return { ok: true, contract: updated };
}

// ── 24-hour payment window ───────────────────────────────────────────────

/**
 * Cancels an award the client never paid for: the contract goes, the
 * awarded applicant and everyone who was passed over return to "pending",
 * and the job is open again. Returns { outcome, ... } so the tick can log
 * exactly why a contract was or wasn't cancelled.
 */
async function voidUnpaidAward(contractId, deps) {
  const { prisma, paystack, mailer, now } = defaults(deps);
  const at = now();

  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    include: { job: { include: { client: true } } },
  });
  if (!contract || contract.status !== "awaitingPayment") return { outcome: "not_awaiting_payment" };
  if (!contract.payByAt || contract.payByAt > at) return { outcome: "not_due" };

  if (contract.checkoutStartedAt && at - contract.checkoutStartedAt < WINDOWS.checkoutGraceMs) {
    return { outcome: "checkout_in_flight" };
  }

  // Ask Paystack about EVERY checkout this contract ever opened, not just the
  // latest: a slow bank transfer on an older checkout may have settled.
  const checkouts = await prisma.contractEvent.findMany({
    where: { contractId: contract.id, type: "checkout_started" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const references = [...new Set([contract.paystackReference, ...checkouts.map((c) => c.meta?.reference)].filter(Boolean))];
  let inFlight = null;
  for (const reference of references) {
    let verified;
    try {
      verified = await paystack.verifyTransaction(reference);
    } catch (err) {
      console.error(`void: could not verify ${reference} with Paystack, leaving contract ${contract.id} for the next tick: ${err.message}`);
      return { outcome: "verify_failed" };
    }
    // A paid checkout anywhere in the list wins over one that is merely still in flight.
    if (verified.status === "success") {
      const funded = await confirmFunding({ reference: verified.reference, amountKobo: verified.amountKobo, source: "void-check" });
      console.log(`void: contract=${contract.id} was actually paid (reference=${reference}) — funded instead of cancelled, outcome=${funded.outcome}`);
      return { outcome: "was_paid" };
    }
    if (!inFlight && IN_FLIGHT_TRANSACTION_STATUSES.has(verified.status)) inFlight = { reference, status: verified.status };
  }
  if (inFlight && at - contract.payByAt < WINDOWS.inFlightHardCapMs) {
    console.log(`void: contract=${contract.id} reference=${inFlight.reference} is ${inFlight.status} at Paystack, waiting rather than cancelling`);
    return { outcome: "payment_in_flight" };
  }

  const application = contract.job.awardedApplicationId
    ? await prisma.application.findUnique({ where: { id: contract.job.awardedApplicationId }, include: { talent: true } })
    : null;

  const cancelled = await prisma.$transaction(async (trx) => {
    // The delete is the commit point: conditional on still awaiting payment,
    // so a payment confirmed a moment ago wins and nothing is cancelled.
    const { count } = await trx.contract.deleteMany({ where: { id: contract.id, status: "awaitingPayment" } });
    if (count === 0) return false;
    await trx.application.updateMany({
      where: { jobId: contract.jobId, status: { in: ["selected", "notSelected"] } },
      data: { status: "pending" },
    });
    await trx.job.update({ where: { id: contract.jobId }, data: { awardedApplicationId: null } });
    await recordEvent(trx, {
      jobId: contract.jobId,
      contractId: contract.id,
      type: "award_voided",
      meta: { payByAt: contract.payByAt, references, awardedApplicationId: application?.id ?? null },
    });
    return true;
  });
  if (!cancelled) return { outcome: "paid_first" };

  console.log(`void: contract=${contract.id} job=${contract.jobId} payByAt=${contract.payByAt.toISOString()} — award cancelled, applicants restored`);
  await Promise.allSettled([
    mailer.sendAwardCancelledToClient({ to: contract.job.client.email, jobTitle: contract.job.title }),
    application?.talent
      ? mailer.sendAwardCancelledToTalent({ to: application.talent.email, jobTitle: contract.job.title })
      : null,
  ]);
  return { outcome: "voided" };
}

// ── 3-day review window ──────────────────────────────────────────────────

async function autoReleaseOne(contractId, deps) {
  const { prisma, mailer, now } = defaults(deps);
  const at = now();

  // Claim this attempt first (conditional), so two ticks can't both try.
  const claimed = await prisma.contract.updateMany({
    where: {
      id: contractId,
      status: "submitted",
      reviewDueAt: { lte: at },
      autoReleaseAttempts: { lt: WINDOWS.autoReleaseMaxAttempts },
      OR: [{ lastAutoReleaseAttemptAt: null }, { lastAutoReleaseAttemptAt: { lte: new Date(at - WINDOWS.autoReleaseRetryMs) } }],
    },
    data: { autoReleaseAttempts: { increment: 1 }, lastAutoReleaseAttemptAt: at },
  });
  if (claimed.count === 0) return { outcome: "not_claimed" };

  const result = await releasePayment({ contractId, trigger: "auto_release" }, deps);
  // Lost a race with the client's own Approve (or a change request): not a failure.
  if (!result.ok && (result.code === "release_in_progress" || result.code === "not_submitted")) {
    return { outcome: "superseded" };
  }
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    include: { job: { include: { client: true } } },
  });

  if (!result.ok) {
    console.error(
      `AUTO-RELEASE FAILED contract=${contractId} code=${result.code} attempt=${contract.autoReleaseAttempts}/${WINDOWS.autoReleaseMaxAttempts} ` +
        `error="${result.error}"` +
        (contract.autoReleaseAttempts >= WINDOWS.autoReleaseMaxAttempts ? " — NEEDS ADMIN, no more automatic retries" : ""),
    );
    await recordEvent(prisma, {
      jobId: contract.jobId,
      contractId,
      type: "auto_release_failed",
      meta: { code: result.code, attempt: contract.autoReleaseAttempts },
    });
    return { outcome: "failed", code: result.code };
  }

  const application = await prisma.application.findUnique({ where: { id: contract.job.awardedApplicationId }, include: { talent: true } });
  await Promise.allSettled([
    application?.talent ? mailer.sendPaymentAutoReleasedToTalent({ to: application.talent.email, jobTitle: contract.job.title }) : null,
    mailer.sendPaymentAutoReleasedToClient({ to: contract.job.client.email, jobTitle: contract.job.title }),
  ]);
  return { outcome: "released" };
}

// ── The tick ─────────────────────────────────────────────────────────────

// Stage 2 sweeps, run after the stage 1 work on every tick. Each starts from
// prisma.contract.findMany, so a test can scope a whole tick to its own rows.
const STAGE2_SWEEPS = [
  ["extensions", (deps) => extensions.sweepExtensions(deps)],
  ["changes", (deps) => changes.sweepChanges(deps)],
];

let ticking = false;

/** One pass over everything whose clock has run out. Safe to run repeatedly. */
async function runTick(deps) {
  if (ticking) return { skipped: "already_running" };
  ticking = true;
  const { prisma, now, autoRelease } = defaults(deps);
  const summary = { voided: 0, released: 0, failed: 0, waiting: 0 };
  try {
    const at = now();

    const unpaid = await prisma.contract.findMany({
      where: { status: "awaitingPayment", payByAt: { lte: at } },
      select: { id: true },
    });
    for (const { id } of unpaid) {
      const r = await voidUnpaidAward(id, deps).catch((err) => {
        console.error(`tick: void failed for contract=${id}:`, err);
        return { outcome: "error" };
      });
      if (r.outcome === "voided") summary.voided++;
      else if (r.outcome === "checkout_in_flight" || r.outcome === "verify_failed") summary.waiting++;
    }

    if (autoRelease) {
      const due = await prisma.contract.findMany({
        where: { status: "submitted", reviewDueAt: { lte: at } },
        select: { id: true },
      });
      for (const { id } of due) {
        const r = await autoReleaseOne(id, deps).catch((err) => {
          console.error(`tick: auto-release failed for contract=${id}:`, err);
          return { outcome: "error" };
        });
        if (r.outcome === "released") summary.released++;
        else if (r.outcome === "failed" || r.outcome === "error") summary.failed++;
      }
    }

    for (const [name, sweep] of STAGE2_SWEEPS) {
      try {
        Object.assign(summary, await sweep(deps));
      } catch (err) {
        console.error(`tick: ${name} sweep failed:`, err);
      }
    }

    if (Object.values(summary).some(Boolean)) {
      console.log(`tick: ${JSON.stringify(summary)}`);
    }
    return summary;
  } finally {
    ticking = false;
  }
}

/**
 * Runs the tick every few minutes inside the server. The server is kept
 * awake by the external health ping, and every step is timestamp-driven, so
 * a missed tick or a restart only delays things.
 */
function startContractScheduler({ intervalMs = 5 * 60 * 1000 } = {}) {
  if (process.env.CONTRACT_SCHEDULER === "off") {
    console.log("contractLifecycle: scheduler OFF (CONTRACT_SCHEDULER=off)");
    return;
  }
  const run = () => runTick().catch((err) => console.error("contractLifecycle: tick failed:", err));
  setTimeout(run, 30_000).unref();
  setInterval(run, intervalMs).unref();
  console.log(`contractLifecycle: scheduler on (every ${intervalMs / 60000} min), auto-release ${autoReleaseEnabled() ? "ON" : "OFF"}`);
}

module.exports = {
  WINDOWS,
  autoReleaseEnabled,
  recordEvent,
  releasePayment,
  voidUnpaidAward,
  autoReleaseOne,
  runTick,
  startContractScheduler,
};
