const express = require("express");
const multer = require("multer");
const crypto = require("node:crypto");
const { prisma } = require("../db");
const { requireUser, requireTalentProfile } = require("./routes");
const { uploadDeliverableFile, getDeliverableFileSignedUrl } = require("../storage");
const paystack = require("../paystack");
const { confirmFunding } = require("../contractFunding");

const router = express.Router();
router.use(requireUser);

// Matches proof-items' own limit — a deliverable is the same kind of
// personal work file (image/doc/video-thumbnail-sized), not bulk media.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Lifecycle: apply -> award (contract created awaitingPayment) -> fund
// (client pays on Paystack checkout; webhook or verify-payment flips it to
// funded) -> start -> submit -> approve (Paystack transfer to the talent).

/**
 * `myApplicationStatus` is the requesting talent's own status on this job
 * ('pending' | 'selected' | 'notSelected' | null if never applied) —
 * resolved from the `applications` relation loaded with a `where:
 * {talentId: req.user.id}` filter in the routes below, so it only ever
 * contains 0 or 1 rows: this talent's own application, if any. Lets the
 * Flutter app disable "Apply" right after applying, not only once the job
 * is awarded to someone — a job.dart-side gap this closes.
 */
async function serializeJob(job, viewerApplications) {
  const mine = viewerApplications?.[0];
  return {
    id: job.id,
    title: job.title,
    category: job.category,
    description: job.description,
    budget: job.budget.toString(),
    client: job.client
      ? { id: job.client.id, fullName: job.client.fullName, email: job.client.email }
      : undefined,
    awardedApplicationId: job.awardedApplicationId,
    applicationCount: job._count?.applications,
    myApplicationStatus: mine?.status ?? null,
    createdAt: job.createdAt,
    contract: job.contract ? await serializeContract(job.contract) : null,
  };
}

function serializeApplication(app) {
  return {
    id: app.id,
    jobId: app.jobId,
    status: app.status,
    createdAt: app.createdAt,
    talent: app.talent
      ? { id: app.talent.id, fullName: app.talent.fullName, email: app.talent.email }
      : undefined,
  };
}

/** Resolves deliverableFilePath to a short-lived signed URL — never returns the raw path. */
async function serializeContract(contract) {
  return {
    id: contract.id,
    jobId: contract.jobId,
    status: contract.status,
    platformFeeAmount: contract.platformFeeAmount?.toString() ?? null,
    paymentFailed: contract.paymentFailed,
    fundedAt: contract.fundedAt,
    transferredAt: contract.transferredAt,
    deliverableNote: contract.deliverableNote,
    deliverableUrl: contract.deliverableUrl,
    deliverableFileUrl: contract.deliverableFilePath
      ? await getDeliverableFileSignedUrl(contract.deliverableFilePath)
      : null,
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
  };
}

/** Only client accounts can post/manage jobs. */
function requireClient(req, res, next) {
  if (req.user.role !== "client") {
    return res.status(403).json({ error: "Only client accounts can do that." });
  }
  next();
}

// ── Jobs ─────────────────────────────────────────────────

/** Open job feed. Optional ?category= filter, matching job_feed_screen.dart's picker. */
router.get("/", async (req, res) => {
  const { category } = req.query;
  const jobs = await prisma.job.findMany({
    where: category ? { category: String(category) } : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      client: true,
      contract: true,
      _count: { select: { applications: true } },
      applications: { where: { talentId: req.user.id } },
    },
  });
  return res.json({ jobs: await Promise.all(jobs.map((job) => serializeJob(job, job.applications))) });
});

router.get("/:id", async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id },
    include: {
      client: true,
      contract: true,
      _count: { select: { applications: true } },
      applications: { where: { talentId: req.user.id } },
    },
  });
  if (!job) return res.status(404).json({ error: "Job not found." });
  return res.json({ job: await serializeJob(job, job.applications) });
});

router.post("/", requireClient, async (req, res) => {
  const { title, category, description, budget } = req.body ?? {};

  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "title is required." });
  }
  if (typeof category !== "string" || !category.trim()) {
    return res.status(400).json({ error: "category is required." });
  }
  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "description is required." });
  }
  const budgetNum = Number(budget);
  if (!Number.isFinite(budgetNum) || budgetNum <= 0) {
    return res.status(400).json({ error: "budget must be a positive number." });
  }

  const job = await prisma.job.create({
    data: {
      clientId: req.user.id,
      title: title.trim(),
      category: category.trim(),
      description: description.trim(),
      budget: budgetNum,
    },
    include: { client: true, contract: true, _count: { select: { applications: true } } },
  });

  return res.status(201).json({ job: await serializeJob(job) });
});

// ── Applications ─────────────────────────────────────────

/**
 * Apply to a job. Requires a payout account, and Verified status in the
 * job's category — the server-side twin of isVerifiedIn(category) in
 * talent_profile.dart / the gate job_detail_screen.dart enforces in the UI.
 * The UI gate alone isn't enough: without this check a direct API call
 * could apply to a job in an unverified category, which is exactly the
 * anti-spam rule Milestone 03 exists to enforce.
 */
router.post("/:id/apply", requireTalentProfile, async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) return res.status(404).json({ error: "Job not found." });

  const verifiedInCategory = await prisma.proofItem.findFirst({
    where: { talentProfileId: req.talentProfile.id, category: job.category, status: "verified" },
  });
  if (!verifiedInCategory) {
    return res.status(403).json({ error: `You need Verified status in ${job.category} to apply.` });
  }

  // Shareholder call (2026-10-01): a talent must be payable before they can
  // be awarded, so the client is never left approving work that can't be paid.
  if (!req.talentProfile.paystackRecipientCode) {
    return res.status(403).json({ error: "Add a payout account before applying, so you can be paid." });
  }

  if (job.awardedApplicationId) {
    return res.status(400).json({ error: "This job has already been awarded." });
  }

  try {
    const application = await prisma.application.create({
      data: { jobId: job.id, talentId: req.user.id },
      include: { talent: true },
    });
    return res.status(201).json({ application: serializeApplication(application) });
  } catch (err) {
    // Prisma's unique constraint violation — the @@unique([jobId, talentId]) in
    // schema.prisma, so a double-apply reads as a clean 409, not a 500.
    if (err.code === "P2002") {
      return res.status(409).json({ error: "You've already applied to this job." });
    }
    throw err;
  }
});

router.get("/:id/applications", requireClient, async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.clientId !== req.user.id) {
    return res.status(403).json({ error: "Not your job." });
  }

  const applications = await prisma.application.findMany({
    where: { jobId: job.id },
    orderBy: { createdAt: "asc" },
    include: { talent: true },
  });
  return res.json({ applications: applications.map(serializeApplication) });
});

/**
 * The single-award action — this IS the fix from
 * docs/core/correction-talent-discovery-screen.md, made real. Selecting one
 * applicant, in one atomic transaction: marks that Application `selected`,
 * every other Application on the job `notSelected`, stamps
 * Job.awardedApplicationId, and creates the Contract. Award no longer
 * means funded — the contract starts at awaitingPayment; the client still
 * has to actually pay (POST .../contract/fund) before work can start. The
 * platform fee is computed and frozen onto the contract right here, at
 * the budget that was true at award time.
 */
router.post("/:id/applications/:applicationId/award", requireClient, async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.clientId !== req.user.id) {
    return res.status(403).json({ error: "Not your job." });
  }
  if (job.awardedApplicationId) {
    return res.status(400).json({ error: "This job has already been awarded." });
  }

  const winning = await prisma.application.findUnique({ where: { id: req.params.applicationId } });
  if (!winning || winning.jobId !== job.id) {
    return res.status(404).json({ error: "Application not found on this job." });
  }

  const platformFeeAmount = paystack.calculatePlatformFee(job.budget);

  const [, , , contract] = await prisma.$transaction([
    prisma.application.update({ where: { id: winning.id }, data: { status: "selected" } }),
    prisma.application.updateMany({
      where: { jobId: job.id, id: { not: winning.id } },
      data: { status: "notSelected" },
    }),
    prisma.job.update({ where: { id: job.id }, data: { awardedApplicationId: winning.id } }),
    prisma.contract.create({ data: { jobId: job.id, status: "awaitingPayment", platformFeeAmount } }),
  ]);

  return res.status(201).json({ contract: await serializeContract(contract) });
});

/**
 * The client actually pays. Real money now: initializes a Paystack
 * transaction for budget + platformFeeAmount and hands back a checkout
 * URL for the app to open. Confirmation happens via the webhook
 * (paystackWebhook.js), not this response — Paystack's own checkout page
 * is where the client actually enters payment details, not here.
 */
router.post(
  "/:id/contract/fund",
  loadContractForJob,
  requireClient,
  requireContractStatus("awaitingPayment"),
  async (req, res) => {
    if (req.job.clientId !== req.user.id) {
      return res.status(403).json({ error: "Not your job." });
    }

    // If the previous checkout actually went through (the client paid, then
    // tapped Pay again before the webhook landed), record that payment
    // rather than opening a second checkout they'd also pay.
    if (req.contract.paystackReference) {
      const previous = await paystack.verifyTransaction(req.contract.paystackReference).catch(() => null);
      if (previous?.status === "success") {
        const { contract } = await confirmFunding({
          reference: previous.reference,
          amountKobo: previous.amountKobo,
          source: "fund-precheck",
        });
        if (contract?.status === "funded") {
          return res.json({ funded: true, contract: await serializeContract(contract) });
        }
      }
    }

    const totalAmount = Number(req.job.budget) + Number(req.contract.platformFeeAmount);
    const reference = `kd_${req.contract.id}_${crypto.randomBytes(4).toString("hex")}`;

    let checkout;
    try {
      checkout = await paystack.initializeTransaction({
        email: req.user.email,
        amountNaira: totalAmount,
        reference,
        metadata: { jobId: req.job.id, contractId: req.contract.id },
      });
    } catch (err) {
      return res.status(502).json({ error: err.message || "Could not start payment right now." });
    }

    await prisma.contract.update({
      where: { id: req.contract.id },
      data: { paystackReference: checkout.reference, paymentFailed: false },
    });

    return res.json({ funded: false, authorizationUrl: checkout.authorizationUrl, reference: checkout.reference });
  },
);

/**
 * Asks Paystack directly whether the latest checkout was paid — called by
 * the app when the client comes back from checkout, so funding doesn't
 * depend on the webhook alone. paymentStatus is Paystack's own transaction
 * status ('success', 'abandoned', 'failed', 'ongoing', ...).
 */
router.post("/:id/contract/verify-payment", loadContractForJob, requireClient, async (req, res) => {
  if (req.job.clientId !== req.user.id) {
    return res.status(403).json({ error: "Not your job." });
  }
  if (req.contract.status !== "awaitingPayment") {
    return res.json({ paymentStatus: "success", contract: await serializeContract(req.contract) });
  }
  if (!req.contract.paystackReference) {
    return res.status(400).json({ error: "No payment has been started for this contract yet." });
  }

  let verified;
  try {
    verified = await paystack.verifyTransaction(req.contract.paystackReference);
  } catch (err) {
    return res.status(502).json({ error: err.message || "Could not check the payment right now." });
  }

  if (verified.status === "success") {
    const { outcome, contract } = await confirmFunding({
      reference: verified.reference,
      amountKobo: verified.amountKobo,
      source: "verify",
    });
    if (outcome === "amountMismatch") {
      return res.status(409).json({ error: "The amount paid doesn't match this contract. Contact support." });
    }
    return res.json({ paymentStatus: "success", contract: await serializeContract(contract) });
  }

  let contract = req.contract;
  if (verified.status === "failed") {
    contract = await prisma.contract.update({ where: { id: req.contract.id }, data: { paymentFailed: true } });
  }
  return res.json({ paymentStatus: verified.status, contract: await serializeContract(contract) });
});

// ── Contract lifecycle ───────────────────────────────────
//
// funded -> inProgress -> submitted -> approved. Same states as
// ContractStatus in job.dart. Each transition is gated by who's allowed to
// make it: the awarded talent starts work and submits; the job's client
// approves. Neither side can skip a state or act out of turn.

async function loadContractForJob(req, res, next) {
  const job = await prisma.job.findUnique({ where: { id: req.params.id }, include: { contract: true } });
  if (!job || !job.contract) return res.status(404).json({ error: "Contract not found." });
  req.job = job;
  req.contract = job.contract;
  next();
}

/** Only the awarded talent may act on the talent side of the contract. */
async function requireAwardedTalent(req, res, next) {
  const application = await prisma.application.findUnique({ where: { id: req.job.awardedApplicationId } });
  if (!application || application.talentId !== req.user.id) {
    return res.status(403).json({ error: "You're not the talent awarded this job." });
  }
  next();
}

function requireContractStatus(status) {
  return (req, res, next) => {
    if (req.contract.status !== status) {
      return res.status(400).json({ error: `Contract must be '${status}' for this action (currently '${req.contract.status}').` });
    }
    next();
  };
}

router.post(
  "/:id/contract/start",
  loadContractForJob,
  requireAwardedTalent,
  requireContractStatus("funded"),
  async (req, res) => {
    const updated = await prisma.contract.update({
      where: { id: req.contract.id },
      data: { status: "inProgress" },
    });
    return res.json({ contract: await serializeContract(updated) });
  },
);

router.post(
  "/:id/contract/submit",
  loadContractForJob,
  requireAwardedTalent,
  requireContractStatus("inProgress"),
  upload.single("file"),
  async (req, res) => {
    const { deliverableNote, deliverableUrl } = req.body ?? {};

    let deliverableFilePath = req.contract.deliverableFilePath;
    if (req.file) {
      deliverableFilePath = await uploadDeliverableFile({
        contractId: req.contract.id,
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        contentType: req.file.mimetype,
      });
    }

    const updated = await prisma.contract.update({
      where: { id: req.contract.id },
      data: {
        status: "submitted",
        deliverableNote: typeof deliverableNote === "string" ? deliverableNote : req.contract.deliverableNote,
        deliverableUrl: typeof deliverableUrl === "string" ? deliverableUrl : req.contract.deliverableUrl,
        deliverableFilePath,
      },
    });
    return res.json({ contract: await serializeContract(updated) });
  },
);

// Statuses where money is, or may still be, moving — never start another
// transfer on top of one of these.
const LIVE_TRANSFER_STATUSES = new Set(["success", "pending", "otp", "received"]);

/**
 * Payout references are kd_payout_<contractId>_<n>, one per attempt.
 * Returns the first attempt that is still live (reuse it, don't pay again)
 * or the first unused reference after conclusively failed ones (failed,
 * reversed, abandoned, ...). Two concurrent approvals land on the same next
 * reference, so Paystack's duplicate-reference check stops a double payout.
 */
async function findPayoutAttempt(contractId) {
  for (let n = 1; n <= 10; n++) {
    const reference = `kd_payout_${contractId}_${n}`;
    const existing = await paystack.verifyTransfer(reference);
    if (!existing || LIVE_TRANSFER_STATUSES.has(existing.status)) return { reference, existing };
  }
  throw new Error("Too many failed payout attempts for this contract — check the Paystack dashboard.");
}

/**
 * Approving is the real "release payment" action. Moves Job.budget
 * (never budget + fee — the fee stays in our balance) out to the awarded
 * talent's saved Paystack recipient. Only `success`/`pending` mean the
 * money is actually on its way; anything else (notably `otp`, when
 * "Confirm transfers before sending" is still on in the Paystack business's
 * Preferences) leaves the contract `submitted` so nobody is told they've
 * been paid when they haven't.
 */
router.post(
  "/:id/contract/approve",
  loadContractForJob,
  requireClient,
  requireContractStatus("submitted"),
  async (req, res) => {
    if (req.job.clientId !== req.user.id) {
      return res.status(403).json({ error: "Not your job." });
    }

    const application = await prisma.application.findUnique({ where: { id: req.job.awardedApplicationId } });
    const talentProfile = await prisma.talentProfile.findUnique({ where: { userId: application.talentId } });

    if (!talentProfile?.paystackRecipientCode) {
      return res.status(400).json({ error: "The talent hasn't set up a payout bank account yet." });
    }

    let attempt;
    let transfer;
    try {
      attempt = await findPayoutAttempt(req.contract.id);
      transfer =
        attempt.existing ??
        (await paystack.initiateTransfer({
          amountNaira: req.job.budget,
          recipientCode: talentProfile.paystackRecipientCode,
          reference: attempt.reference,
          reason: `Payment for "${req.job.title}"`,
        }));
    } catch (err) {
      return res.status(502).json({ error: err.message || "Could not release payment right now." });
    }

    console.log(
      `approve: contract=${req.contract.id} reference=${attempt.reference} reused=${Boolean(attempt.existing)} ` +
        `transfer=${transfer.transferCode} status=${transfer.status}`,
    );
    if (transfer.status === "otp" || transfer.status === "received") {
      console.error(
        `approve: PAYOUT NOT SENT — ${attempt.reference} is waiting on transfer approval (status=${transfer.status}). ` +
          `Turn off "Confirm transfers before sending" in Paystack Preferences. contract=${req.contract.id}`,
      );
      return res.status(502).json({ error: "Payment couldn't be released yet. Please try again later." });
    }
    if (transfer.status !== "success" && transfer.status !== "pending") {
      console.error(`approve: PAYOUT NOT SENT — ${attempt.reference} status=${transfer.status} contract=${req.contract.id}`);
      return res.status(502).json({ error: "Payment couldn't be released right now. Please try again shortly." });
    }

    const updated = await prisma.contract.update({
      where: { id: req.contract.id },
      data: { status: "approved", paystackTransferCode: transfer.transferCode, transferredAt: new Date() },
    });
    return res.json({ contract: await serializeContract(updated) });
  },
);

module.exports = { router };
