const express = require("express");
const multer = require("multer");
const { prisma } = require("../db");
const { requireUser, requireTalentProfile } = require("./routes");
const { uploadDeliverableFile, getDeliverableFileSignedUrl } = require("../storage");

const router = express.Router();
router.use(requireUser);

// Matches proof-items' own limit — a deliverable is the same kind of
// personal work file (image/doc/video-thumbnail-sized), not bulk media.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Mirrors the state machine already built and proven in king-domain-mobile's
// Flutter app (lib/presentation/providers/jobs_provider.dart): applyTo ->
// (client awards one applicant, which funds the contract in the same step,
// same as JobsNotifier.simulateAcceptAndFund — there's no separate payment
// step yet, see Sprint 5) -> startWork -> submitDeliverable -> approve.

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
 * Apply to a job. Requires the applicant to hold Verified status in the
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
 * Job.awardedApplicationId, and creates the Contract (status: funded,
 * mirroring JobsNotifier.simulateAcceptAndFund — award and fund happen
 * together until Sprint 5 wires a real payment step in between).
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

  const [, , , contract] = await prisma.$transaction([
    prisma.application.update({ where: { id: winning.id }, data: { status: "selected" } }),
    prisma.application.updateMany({
      where: { jobId: job.id, id: { not: winning.id } },
      data: { status: "notSelected" },
    }),
    prisma.job.update({ where: { id: job.id }, data: { awardedApplicationId: winning.id } }),
    prisma.contract.create({ data: { jobId: job.id, status: "funded" } }),
  ]);

  return res.status(201).json({ contract: await serializeContract(contract) });
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

router.post(
  "/:id/contract/approve",
  loadContractForJob,
  requireClient,
  requireContractStatus("submitted"),
  async (req, res) => {
    if (req.job.clientId !== req.user.id) {
      return res.status(403).json({ error: "Not your job." });
    }
    const updated = await prisma.contract.update({
      where: { id: req.contract.id },
      data: { status: "approved" },
    });
    return res.json({ contract: await serializeContract(updated) });
  },
);

module.exports = { router };
