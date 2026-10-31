const express = require("express");
const { singleFile, checkUpload } = require("../uploads");
const crypto = require("node:crypto");
const { prisma } = require("../db");
const { requireUser, requireTalentProfile } = require("./routes");
const { uploadDeliverableFile, getDeliverableFileSignedUrl, getProofFileSignedUrl, avatarPublicUrl } = require("../storage");
const paystack = require("../paystack");
const { confirmFunding } = require("../contractFunding");
const lifecycle = require("../contractLifecycle");
const mailer = require("../admin/mailer");
const changes = require("../contractChanges");
const extensions = require("../contractExtensions");
const jobsService = require("../jobs");
const { requireVerifiedIdentity } = require("./identityGate");
const discovery = require("../discovery");
const discoveryRules = require("../discoveryRules");
const { capState } = discoveryRules;
const { skillByKey } = require("../skills");
const { recordAudit } = require("../admin/audit");

const router = express.Router();
router.use(requireUser);

// Uploads: one optional file, 10 MB, checked by its own bytes (src/uploads.js).

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
      ? { id: job.client.id, fullName: job.client.fullName, photoUrl: avatarPublicUrl(job.client.photoPath) } // never the email: no contact details before award (D18)
      : undefined,
    awardedApplicationId: job.awardedApplicationId,
    closedAt: job.closedAt ?? null,
    revision: job.revision ?? 0,
    ...structuredFields(job),
    applicationCount: job._count?.applications,
    myApplicationStatus: mine?.status ?? null,
    createdAt: job.createdAt,
    contract: job.contract ? await serializeContract(job.contract) : null,
  };
}

/** What a structured (S3) job adds to the old shape. Old jobs have a null skill and read as one delivery in naira. */
function structuredFields(job) {
  const count = job._count?.applications ?? 0;
  const cap = capState({ applicantCount: job._openCount ?? count, openedAt: job.reopenedAt ?? job.liveAt ?? job.createdAt });
  return {
    skillKey: job.skillKey ?? null,
    skillLabel: job.skillKey ? skillByKey(job.skillKey)?.label ?? job.skillKey : null,
    jobType: job.jobType ?? "oneDelivery",
    currency: job.currency ?? "NGN",
    visibility: job.visibility ?? "public",
    postStatus: job.postStatus ?? "live",
    brief: job.brief ?? null,
    screeningQuestions: Array.isArray(job.screeningQuestions) ? job.screeningQuestions : [],
    applicantCap: discoveryRules.RULES.applicantCap,
    paused: job.skillKey ? cap.paused : false,
    pausedReason: job.skillKey ? cap.reason : null,
    rejection: job.postStatus === "rejected" ? { reasonCode: job.rejectReasonCode, note: job.rejectNote } : null,
  };
}

function serializeApplication(app) {
  return {
    id: app.id,
    jobId: app.jobId,
    status: app.status,
    createdAt: app.createdAt,
    talent: app.talent
      ? { id: app.talent.id, fullName: app.talent.fullName, email: app.talent.email, photoUrl: avatarPublicUrl(app.talent.photoPath) }
      : undefined,
  };
}

/**
 * What a client weighs an applicant on (correction-talent-discovery-screen.md):
 * real, non-manipulable facts only. Verified status in this job's category,
 * up to three of their verified work samples in it (short-lived signed
 * links), and a plain count of jobs they've completed. No score, no rank.
 */
async function applicantSignals(talent, category) {
  const profile = talent?.talentProfile;
  const verifiedProof = (profile?.proofItems ?? []).filter((p) => p.category === category && p.status === "verified");
  const jobsCompleted = talent
    ? await prisma.contract.count({
        where: { status: "approved", job: { applications: { some: { talentId: talent.id, status: "selected" } } } },
      })
    : 0;
  return {
    headline: profile?.headline || null,
    verifiedInCategory: verifiedProof.length > 0,
    proof: await Promise.all(
      verifiedProof.slice(0, 3).map(async (p) => ({
        id: p.id,
        title: p.title,
        fileUrl: p.filePath ? await getProofFileSignedUrl(p.filePath) : null,
      })),
    ),
    jobsCompleted,
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

/**
 * The job feed. Server-side filters and paging (S3): skill, type, market, budget, delivery, verified client, few
 * applicants, words; forYou puts jobs in the talent's verified skills first. The old ?category= still works.
 */
router.get("/", async (req, res) => {
  const query = { ...req.query };
  if (query.category && !query.skill) query.category = String(query.category);
  const result = await discovery.feedJobs(req.user, query);
  if (req.query.category) result.jobs = result.jobs.filter((j) => j.skillLabel === req.query.category);
  // A job the viewer is a party to carries its contract, as the Work tab has always read it from here.
  const mine = result.jobs.filter((j) => j.mine || j.myApplicationStatus).map((j) => j.id);
  if (mine.length) {
    const contracts = new Map((await prisma.contract.findMany({ where: { jobId: { in: mine } } })).map((c) => [c.jobId, c]));
    for (const j of result.jobs) if (contracts.has(j.id)) j.contract = await serializeContract(contracts.get(j.id));
  }
  return res.json(result);
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
  await discovery.attachOpenCounts(prisma, [job]);
  // A held or turned-down post is for its owner and the team only.
  if (job.postStatus !== "live" && job.clientId !== req.user.id) return res.status(404).json({ error: "Job not found." });
  const [record, invitation] = await Promise.all([
    discovery.clientRecord(prisma, job.clientId),
    prisma.invitation.findFirst({ where: { jobId: job.id, talentId: req.user.id, status: { in: ["pending", "accepted"] }, expiresAt: { gt: new Date() } } }),
  ]);
  return res.json({ job: await serializeJob(job, job.applications), clientRecord: record, invitation: invitation ? { id: invitation.id, expiresAt: invitation.expiresAt, message: invitation.message } : null });
});

router.post("/", requireClient, requireVerifiedIdentity(), async (req, res) => {
  const result = await jobsService.postJob({ clientId: req.user.id, input: req.body });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code, field: result.field });

  // A live post tells talents with a matching saved search. Best effort: a failure here never undoes the post.
  if (result.job.postStatus === "live") discovery.alertSavedSearches(result.job).catch((e) => console.error("saved-search alerts failed:", e.message));
  return res.status(201).json({ job: await serializeJob(result.job), heldForScreening: result.job.postStatus === "screening", screeningReason: result.screening?.reason ?? null });
});

/**
 * Edit an open job nobody has applied to yet: once the first applicant applies
 * the terms are locked and the client closes and reposts instead
 * (docs/features/work-gaps-applications-stepper-job-edit.md in the mobile repo).
 */
router.patch("/:id", requireClient, async (req, res) => {
  const result = await jobsService.editJob({ jobId: req.params.id, clientId: req.user.id, input: req.body });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code, field: result.field });
  return res.json({ job: await serializeJob(result.job), resubmitted: Boolean(result.resubmitted) });
});

/** Close an open job: final, hides it from other talents, ends pending applications. */
router.post("/:id/close", requireClient, async (req, res) => {
  const result = await jobsService.closeJob({ jobId: req.params.id, clientId: req.user.id });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
  return res.json({ job: await serializeJob(result.job) });
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
router.post("/:id/apply", requireTalentProfile, requireVerifiedIdentity(), async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) return res.status(404).json({ error: "Job not found." });

  // A job with a skill needs Verified in THAT skill (a verified submission, or an older proof item of its own).
  // The older category check stays for jobs posted before skills.
  let verifiedHere;
  if (job.skillKey) {
    verifiedHere =
      (await prisma.skillSubmission.findFirst({ where: { userId: req.user.id, skillKey: job.skillKey, status: "verified" } })) ||
      (await prisma.proofItem.findFirst({ where: { talentProfileId: req.talentProfile.id, category: job.category, status: "verified", NOT: { title: { endsWith: "(verified)" } } } }));
  } else {
    verifiedHere = await prisma.proofItem.findFirst({ where: { talentProfileId: req.talentProfile.id, category: job.category, status: "verified" } });
  }
  if (!verifiedHere) {
    return res.status(403).json({ error: job.skillKey ? `You need to be verified in ${skillByKey(job.skillKey)?.label ?? job.category} to apply.` : `You need Verified status in ${job.category} to apply.`, code: "not_verified_in_skill" });
  }

  // Shareholder call (2026-10-01): a talent must be payable before they can
  // be awarded, so the client is never left approving work that can't be paid.
  if (!req.talentProfile.paystackRecipientCode) {
    return res.status(403).json({ error: "Add a payout account before applying, so you can be paid." });
  }

  // The revision of the job the talent read: if the client edited it since, the
  // application is refused (terms_changed) so nobody applies to terms they never saw.
  const { revision } = req.body ?? {};
  if (revision !== undefined && !Number.isInteger(revision)) {
    return res.status(400).json({ error: "revision must be a whole number." });
  }

  const { answer, pieces, screeningAnswers } = req.body ?? {};
  const result = await jobsService.applyToJob({ jobId: job.id, talentId: req.user.id, revision, answer, pieces, screeningAnswers });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
  return res.status(201).json({ application: serializeApplication(result.application) });
});

router.get("/:id/applications", requireClient, async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.clientId !== req.user.id) {
    return res.status(403).json({ error: "Not your job." });
  }

  // In the order they applied: no ranking (docs/core/correction-talent-discovery-screen.md).
  const applications = await prisma.application.findMany({
    where: { jobId: job.id },
    orderBy: { createdAt: "asc" },
    include: { talent: { include: { talentProfile: { include: { proofItems: true } } } } },
  });
  const signals = await Promise.all(applications.map((a) => applicantSignals(a.talent, job.category)));
  const count = job.reopenedAt ? applications.filter((a) => a.createdAt >= job.reopenedAt).length : applications.length;
  const cap = capState({ applicantCount: count, openedAt: job.reopenedAt ?? job.liveAt ?? job.createdAt });
  // Structured jobs also get the full panel (facts, chosen pieces, answers). Same order: when they applied.
  const panels = job.skillKey ? await Promise.all(applications.map((a) => discovery.applicantPanel(a, job))) : [];
  return res.json({
    applications: applications.map((a, i) => ({ ...serializeApplication(a), signals: signals[i], panel: panels[i] ?? null })),
    cap: { applicantCount: count, applicantCap: discoveryRules.RULES.applicantCap, paused: job.skillKey ? cap.paused : false, reason: job.skillKey ? cap.reason : null },
  });
});

/** Shortlist or un-shortlist an applicant: the client's own working list. The talent is not told. */
router.post("/:id/applications/:applicationId/shortlist", requireClient, async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job || job.clientId !== req.user.id) return res.status(404).json({ error: "Job not found." });
  const on = req.body?.shortlisted !== false;
  const { count } = await prisma.application.updateMany({
    where: { id: req.params.applicationId, jobId: job.id, status: on ? "pending" : "shortlisted" },
    data: { status: on ? "shortlisted" : "pending" },
  });
  if (count !== 1) return res.status(409).json({ error: "That application can't be changed any more." });
  return res.json({ ok: true, status: on ? "shortlisted" : "pending" });
});

/** Decline an applicant: they are told, by notification and email (D21: declined talents are told). */
router.post("/:id/applications/:applicationId/decline", requireClient, async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id }, include: { client: true } });
  if (!job || job.clientId !== req.user.id) return res.status(404).json({ error: "Job not found." });
  const { count } = await prisma.application.updateMany({
    where: { id: req.params.applicationId, jobId: job.id, status: { in: ["pending", "shortlisted"] } },
    data: { status: "declined", declinedAt: new Date() },
  });
  if (count !== 1) return res.status(409).json({ error: "That application can't be declined any more." });
  const app = await prisma.application.findUnique({ where: { id: req.params.applicationId }, include: { talent: true } });
  discovery.notify(app.talentId, { title: "Update on your application", body: `The client chose not to go ahead with your application for "${job.title}".`, data: { type: "application_declined", jobId: job.id } });
  const sent = await mailer.sendApplicationDeclined({ to: app.talent.email, name: app.talent.fullName, jobTitle: job.title });
  console.log(`jobs: declined application=${app.id} job=${job.id} talent=${app.talentId} readBack.status=${(await prisma.application.findUnique({ where: { id: app.id }, select: { status: true } })).status} emailSent=${sent.sent}`);
  return res.json({ ok: true });
});

/** Reopen a paused job: the 5 days and the 50 start again. Premium (D21, D39); the paid gate switches on with billing (S8). */
router.post("/:id/reopen", requireClient, async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id }, include: { _count: { select: { applications: true } } } });
  if (!job || job.clientId !== req.user.id) return res.status(404).json({ error: "Job not found." });
  if (!job.skillKey || job.postStatus !== "live" || job.closedAt || job.awardedApplicationId) return res.status(409).json({ error: "This job can't be reopened.", code: "not_open" });
  await discovery.attachOpenCounts(prisma, [job]);
  if (!capState({ applicantCount: job._openCount ?? job._count.applications, openedAt: job.reopenedAt ?? job.liveAt ?? job.createdAt }).paused) return res.status(409).json({ error: "This job is still taking applications.", code: "not_paused" });
  if (process.env.REOPEN_REQUIRES_PREMIUM === "true") return res.status(402).json({ error: "Reopening a paused job is a premium feature.", code: "premium_required" });
  // The cap counts applicants, so reopening also lifts it: another 50 may apply from now.
  await prisma.job.update({ where: { id: job.id }, data: { reopenedAt: new Date() } });
  return res.json({ ok: true });
});

/** Invite a talent to a job: up to 20 per job, valid 72 hours (D23). */
router.post("/:id/invitations", requireClient, async (req, res) => {
  const result = await discovery.invite({ clientId: req.user.id, jobId: req.params.id, talentId: req.body?.talentId, message: req.body?.message });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
  return res.status(201).json({ invitation: { id: result.invitation.id, expiresAt: result.invitation.expiresAt } });
});

router.get("/:id/invitations", requireClient, async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job || job.clientId !== req.user.id) return res.status(404).json({ error: "Job not found." });
  const rows = await prisma.invitation.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "desc" }, include: { talent: { select: { id: true, fullName: true } } } });
  return res.json({ invitations: rows.map((i) => ({ id: i.id, status: i.status, expiresAt: i.expiresAt, talent: i.talent })), limit: discoveryRules.RULES.invitationsPerJob });
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
router.post("/:id/applications/:applicationId/award", requireClient, requireVerifiedIdentity(), async (req, res) => {
  const result = await jobsService.awardJob({ jobId: req.params.id, clientId: req.user.id, applicationId: req.params.applicationId });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
  return res.status(201).json({ contract: await serializeContract(result.contract) });
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
  singleFile("file"),
  checkUpload,
  async (req, res) => {
    const { deliverableNote, deliverableUrl } = req.body ?? {};
    let filePath = null;
    if (req.upload) {
      // The type and name are the checked ones, never the client's.
      filePath = await uploadDeliverableFile({
        contractId: req.contract.id,
        buffer: req.upload.buffer,
        originalName: req.upload.fileName,
        contentType: req.upload.contentType,
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

router.post("/:id/contract/extension", loadContractForJob, requireAwardedTalent, async (req, res) => {
  const result = await extensions.requestExtension({
    contractId: req.contract.id,
    days: Number(req.body?.days),
    reason: req.body?.reason,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.status(201).json({ extension: serializeExtension(result.extension) });
});

router.post("/:id/contract/extension/:extensionId/answer", loadContractForJob, requireClient, async (req, res) => {
  if (req.job.clientId !== req.user.id) return res.status(403).json({ error: "Not your job." });
  const decision = req.body?.decision;
  if (decision !== "grant" && decision !== "decline") {
    return res.status(400).json({ error: "decision must be 'grant' or 'decline'." });
  }
  const result = await extensions.answerExtension({
    contractId: req.contract.id,
    extensionId: req.params.extensionId,
    clientId: req.user.id,
    grant: decision === "grant",
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.json({ contract: await serializeContract(result.contract) });
});

/**
 * The client sends delivered work back with a reason. After the second
 * round the same action escalates the job to an admin instead
 * (`escalated: true` in the response).
 */
router.post(
  "/:id/contract/request-changes",
  loadContractForJob,
  requireClient,
  requireContractStatus("submitted"),
  async (req, res) => {
    if (req.job.clientId !== req.user.id) return res.status(403).json({ error: "Not your job." });
    const result = await changes.requestChanges({ contractId: req.contract.id, clientId: req.user.id, reason: req.body?.reason });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ escalated: result.escalated, contract: await serializeContract(result.contract) });
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
