const express = require("express");
const multer = require("multer");
const crypto = require("node:crypto");
const { prisma } = require("../db");
const { requireUser, requireTalentProfile } = require("./routes");
const { uploadDeliverableFile, getDeliverableFileSignedUrl } = require("../storage");
const paystack = require("../paystack");
const { confirmFunding } = require("../contractFunding");
const lifecycle = require("../contractLifecycle");
const mailer = require("../admin/mailer");
const { RULES } = require("../contractCore");
const changes = require("../contractChanges");

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
    deliveryDays: job.deliveryDays ?? null,
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

function serializeExtension(e) {
  return {
    id: e.id,
    requestedDays: e.requestedDays,
    reason: e.reason,
    status: e.status,
    requestedAt: e.requestedAt,
    answerDueAt: e.answerDueAt,
    resolvedAt: e.resolvedAt,
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
    // Deadlines the apps show. reviewDueAt is only sent while auto-release is
    // actually on, so the app never promises an automatic payment that
    // won't happen.
    payByAt: contract.payByAt,
    submittedAt: contract.submittedAt,
    reviewDueAt: lifecycle.autoReleaseEnabled() ? contract.reviewDueAt : null,
    deliverByAt: contract.deliverByAt ?? null,
    extensionsUsed: contract.extensionsUsed ?? 0,
    changeRounds: contract.changeRounds ?? 0,
    changeDueAt: contract.changeDueAt ?? null,
    overdue: Boolean(contract.overdueFlaggedAt),
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
  const { title, category, description, budget, deliveryDays } = req.body ?? {};

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
  const days = Number(deliveryDays);
  if (!Number.isInteger(days) || days < RULES.deliveryDays.min || days > RULES.deliveryDays.max) {
    return res.status(400).json({
      error: `deliveryDays must be a whole number of days from ${RULES.deliveryDays.min} to ${RULES.deliveryDays.max}.`,
    });
  }

  const job = await prisma.job.create({
    data: {
      clientId: req.user.id,
      title: title.trim(),
      category: category.trim(),
      description: description.trim(),
      budget: budgetNum,
      deliveryDays: days,
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
    prisma.contract.create({
      data: {
        jobId: job.id,
        status: "awaitingPayment",
        platformFeeAmount,
        payByAt: new Date(Date.now() + lifecycle.WINDOWS.paymentMs),
      },
    }),
  ]);
  await lifecycle.recordEvent(prisma, {
    jobId: job.id,
    contractId: contract.id,
    type: "awarded",
    meta: { applicationId: winning.id, payByAt: contract.payByAt },
  });

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

    if (req.contract.payByAt && req.contract.payByAt < new Date()) {
      return res.status(400).json({
        error: "The 24-hour payment window for this award has ended. The award will be cancelled shortly and you can award the job again.",
      });
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
      data: { paystackReference: checkout.reference, paymentFailed: false, checkoutStartedAt: new Date() },
    });
    // Every checkout ever opened is remembered, so cancelling an unpaid award
    // can check all of them with Paystack, not just the latest.
    await lifecycle.recordEvent(prisma, {
      jobId: req.job.id,
      contractId: req.contract.id,
      type: "checkout_started",
      meta: { reference: checkout.reference },
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

/** The job's client or its awarded talent — nobody else sees a contract's history. */
async function requireParty(req, res, next) {
  if (req.job.clientId === req.user.id) return next();
  const application = req.job.awardedApplicationId
    ? await prisma.application.findUnique({ where: { id: req.job.awardedApplicationId } })
    : null;
  if (application?.talentId === req.user.id) return next();
  return res.status(403).json({ error: "Only the client and the awarded talent can see this contract's history." });
}

function requireContractStatus(statuses) {
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  return (req, res, next) => {
    if (!allowed.includes(req.contract.status)) {
      return res.status(400).json({
        error: `Contract must be '${allowed.join("' or '")}' for this action (currently '${req.contract.status}').`,
      });
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
  requireContractStatus(["inProgress", "changesRequested"]),
  upload.single("file"),
  async (req, res) => {
    const { deliverableNote, deliverableUrl } = req.body ?? {};
    let filePath = null;
    if (req.file) {
      filePath = await uploadDeliverableFile({
        contractId: req.contract.id,
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        contentType: req.file.mimetype,
      });
    }

    const result = await changes.submitDelivery({ contractId: req.contract.id, note: deliverableNote, url: deliverableUrl, filePath });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    // Tell the client what was delivered and exactly how long they have.
    const client = await prisma.user.findUnique({ where: { id: req.job.clientId } });
    if (client) {
      mailer
        .sendDeliveryAwaitingReview({
          to: client.email,
          jobTitle: req.job.title,
          reviewDueAt: result.contract.reviewDueAt,
          autoRelease: lifecycle.autoReleaseEnabled(),
          version: result.version,
        })
        .catch((err) => console.error("submit: failed to email the client:", err));
    }

    return res.json({ contract: await serializeContract(result.contract) });
  },
);

/**
 * Approving is the real "release payment" action; the 3-day auto-release
 * uses the very same code (contractLifecycle.releasePayment): the job budget
 * (never budget + fee) goes to the awarded talent, and the contract only
 * becomes approved if Paystack accepts the transfer.
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

    const result = await lifecycle.releasePayment({ contractId: req.contract.id, trigger: "client_approved" });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ contract: await serializeContract(result.contract) });
  },
);

/** Every delivery version, extension request and change round, oldest first. */
router.get("/:id/contract/history", loadContractForJob, requireParty, async (req, res) => {
  const contractId = req.contract.id;
  const [deliveries, extensions, changeRequests] = await Promise.all([
    prisma.contractDelivery.findMany({ where: { contractId }, orderBy: { version: "asc" } }),
    prisma.contractExtension.findMany({ where: { contractId }, orderBy: { requestedAt: "asc" } }),
    prisma.changeRequest.findMany({ where: { contractId }, orderBy: { round: "asc" } }),
  ]);
  return res.json({
    deliveries: await Promise.all(
      deliveries.map(async (d) => ({
        version: d.version,
        note: d.note,
        url: d.url,
        fileUrl: d.filePath ? await getDeliverableFileSignedUrl(d.filePath) : null,
        submittedAt: d.submittedAt,
      })),
    ),
    extensions: extensions.map(serializeExtension),
    changeRequests: changeRequests.map((c) => ({
      round: c.round,
      reason: c.reason,
      requestedAt: c.requestedAt,
      resubmitDueAt: c.resubmitDueAt,
      resubmittedAt: c.resubmittedAt,
    })),
  });
});

module.exports = { router };
