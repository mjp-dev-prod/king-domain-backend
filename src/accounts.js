// Deleting an account. Design: docs/features/account-deletion-and-privacy.md in the mobile repo.
//
// Anonymise-and-remove, not "drop the row": a finished job is also a payment record and the other
// person's work history, so the user row stays (as "Deleted user") and everything personal goes.
//
// Race safety. An award or an application can arrive at the same moment as a deletion. The deletion
// takes the user row's exclusive lock first (it stamps deletedAt) and only then counts active
// contracts; awarding, applying and posting a job take a SHARED lock on the people involved
// (lockLive) and refuse if either is already deleted. So either the contract commits first (the
// deletion waits for it, sees it, and is refused) or the deletion commits first (the award is refused).
const { baseDeps, refuse } = require("./contractCore");

const UNAVAILABLE = "This account is no longer available.";
const BLOCKED = "You have a job in progress. Finish it, or wait for it to be resolved, before deleting your account.";

/**
 * Inside a transaction: share-lock each person's row and refuse if any is deleted (or missing).
 * Ids are locked in a fixed order so two callers can never wait on each other.
 */
async function lockLive(trx, userIds) {
  for (const id of [...new Set(userIds)].sort()) {
    const rows = await trx.$queryRaw`SELECT "deletedAt" FROM users WHERE id = ${id} FOR SHARE`;
    if (rows.length === 0 || rows[0].deletedAt) return refuse(409, "account_unavailable", UNAVAILABLE);
  }
  return null;
}

/** Every contract this person is in that is not finished, as the person would recognise it. */
async function activeContracts(db, userId) {
  const rows = await db.contract.findMany({
    where: {
      status: { not: "approved" },
      OR: [{ job: { clientId: userId } }, { job: { applications: { some: { talentId: userId, status: "selected" } } } }],
    },
    orderBy: { createdAt: "asc" },
    select: { status: true, job: { select: { id: true, title: true, clientId: true } } },
  });
  return rows.map((r) => ({ jobId: r.job.id, title: r.job.title, role: r.job.clientId === userId ? "client" : "talent", status: r.status }));
}

class Blocked extends Error {
  constructor(contracts) {
    super("active_contracts");
    this.contracts = contracts;
  }
}
class Gone extends Error {}

const log = (userId, text) => console.log(`[account-delete] ${userId}: ${text}`);

/**
 * Deletes one account. The caller has already proved who is asking (the app re-checks the password;
 * the delete-user script is run by an operator). Returns { ok: true, summary, cleanup } or a refusal;
 * `cleanup` lists what could not be removed afterwards ("files", "paystack"), which never undoes the
 * deletion: the database is the source of truth for what the person asked for.
 */
async function deleteAccount({ userId }, deps = {}) {
  const { prisma, mailer, now } = baseDeps(deps);
  const storage = deps.storage ?? require("./storage");
  const paystack = deps.paystack ?? require("./paystack");

  let removed;
  try {
    removed = await prisma.$transaction(
      async (trx) => {
        // The claim: takes the row's exclusive lock, and makes a second deletion find nothing to do.
        const claimed = await trx.user.updateMany({ where: { id: userId, deletedAt: null }, data: { deletedAt: now() } });
        if (claimed.count === 0) throw new Gone();

        const contracts = await activeContracts(trx, userId);
        if (contracts.length) throw new Blocked(contracts);

        const user = await trx.user.findUnique({ where: { id: userId } });
        const profile = await trx.talentProfile.findUnique({ where: { userId }, include: { proofItems: { select: { filePath: true } } } });

        // Identity documents and videos are the most sensitive thing we hold: rows and files both go.
        const identityRows = await trx.identityCheck.findMany({ where: { userId }, select: { documentPath: true, videoPath: true } });
        const identityPaths = identityRows.flatMap((r) => [r.documentPath, r.videoPath]).filter(Boolean);
        await trx.identityCheck.deleteMany({ where: { userId } });
        await trx.guardianConsent.deleteMany({ where: { userId } });

        // Skill submissions: the files in the private bucket go with the rows (reviews, pieces and file rows cascade).
        const submissionKeys = (await trx.submissionFile.findMany({ where: { submission: { userId } }, select: { objectKey: true } })).map((f) => f.objectKey);
        await trx.skillSubmission.deleteMany({ where: { userId } });
        await trx.skillRestriction.deleteMany({ where: { userId } });

        // Discovery (S3): saved searches and talents, invitations either way, and shortlist requests go with the person.
        await trx.savedSearch.deleteMany({ where: { userId } });
        await trx.savedTalent.deleteMany({ where: { OR: [{ clientId: userId }, { talentId: userId }] } });
        await trx.invitation.deleteMany({ where: { OR: [{ clientId: userId }, { talentId: userId }] } });
        await trx.shortlistItem.deleteMany({ where: { talentId: userId } });
        await trx.shortlistRequest.deleteMany({ where: { clientId: userId } });

        const noContract = { contract: { is: null } };
        const counts = {};
        counts.sessions = (await trx.userSession.deleteMany({ where: { userId } })).count;
        counts.devices = (await trx.deviceToken.deleteMany({ where: { userId } })).count;
        counts.profile = (await trx.talentProfile.deleteMany({ where: { userId } })).count; // proof items cascade
        counts.applications = (await trx.application.deleteMany({ where: { talentId: userId, status: { not: "selected" } } })).count;
        // Jobs with no contract and no money trail go, with their applications. A job that was awarded and
        // then cancelled keeps its events as evidence, so it stays: closed, so nobody can apply to it.
        counts.jobsDeleted = (await trx.job.deleteMany({ where: { clientId: userId, ...noContract, events: { none: {} } } })).count;
        await trx.application.updateMany({ where: { status: "pending", job: { clientId: userId, ...noContract } }, data: { status: "notSelected" } });
        counts.jobsClosed = (await trx.job.updateMany({ where: { clientId: userId, ...noContract, closedAt: null }, data: { closedAt: now() } })).count;
        counts.waitlist = (await trx.waitlistEntry.deleteMany({ where: { email: { equals: user.email, mode: "insensitive" } } })).count;

        await trx.user.update({
          where: { id: userId },
          data: {
            email: `deleted-${userId}@deleted.invalid`,
            fullName: "Deleted user",
            passwordHash: "deleted",
            photoPath: null,
            emailVerified: false,
            verificationCodeHash: null,
            verificationCodeExpiresAt: null,
            passwordResetCodeHash: null,
            passwordResetCodeExpiresAt: null,
            passwordResetAttempts: 0,
            country: null,
            state: null,
            city: null,
            educationKind: null,
            educationSchool: null,
            educationDetail: null,
            clientKind: null,
            legalName: null,
            dateOfBirth: null,
            identityVerifiedAt: null,
            guardianConfirmedAt: null,
          },
        });

        return {
          email: user.email,
          photoPath: user.photoPath,
          identityPaths,
          submissionKeys,
          proofPaths: (profile?.proofItems ?? []).map((p) => p.filePath).filter(Boolean),
          recipientCode: profile?.paystackRecipientCode ?? null,
          counts,
        };
      },
      { timeout: 30000, maxWait: 10000 },
    );
  } catch (err) {
    if (err instanceof Blocked) return { ...refuse(409, "active_contracts", BLOCKED), contracts: err.contracts };
    if (err instanceof Gone) return refuse(404, "not_found", "Account not found.");
    throw err;
  }

  // The database is done. What is left is files and the Paystack recipient: each is tried on its own,
  // none can undo the deletion, and whatever is left over is named in the log.
  const leftovers = new Set();
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      leftovers.add(what);
      log(userId, `${what} cleanup failed: ${err.message}`);
    }
  };
  if (removed.proofPaths.length) await attempt("files", () => storage.removePrivateFiles("proof-items", removed.proofPaths));
  if (removed.identityPaths.length) await attempt("files", () => storage.removePrivateFiles("identity-docs", removed.identityPaths));
  if (removed.submissionKeys.length) {
    if (storage.privateUploadsConfigured) await attempt("files", () => storage.deletePrivateObjects(removed.submissionKeys));
    else {
      leftovers.add("files");
      log(userId, `${removed.submissionKeys.length} submission file(s) not deleted: the private bucket is not configured here`);
    }
  }
  if (removed.photoPath) await attempt("files", () => storage.removeAvatar(removed.photoPath));
  if (removed.recipientCode) {
    if (paystack.configured) await attempt("paystack", () => paystack.deleteTransferRecipient(removed.recipientCode));
    else {
      leftovers.add("paystack");
      log(userId, `recipient ${removed.recipientCode} not deactivated: Paystack is not configured here`);
    }
  }

  // Read back what the database holds now, not what we meant to write (docs: CLAUDE.md hard rule 1).
  const after = await prisma.user.findUnique({
    where: { id: userId },
    select: { deletedAt: true, email: true, _count: { select: { sessions: true } }, talentProfile: { select: { id: true } } },
  });
  const c = removed.counts;
  log(
    userId,
    `removed sessions=${c.sessions} devices=${c.devices} profile=${c.profile} applications=${c.applications} jobsDeleted=${c.jobsDeleted} jobsClosed=${c.jobsClosed} waitlist=${c.waitlist}; ` +
      `read-back deletedAt=${after?.deletedAt?.toISOString() ?? "NULL"} email=${after?.email} sessionsLeft=${after?._count.sessions} profileLeft=${after?.talentProfile ? "YES" : "no"}`,
  );
  log(userId, leftovers.size ? `cleanup incomplete: ${[...leftovers].join(", ")}` : "cleanup complete");

  await mailer.sendAccountDeleted({ to: removed.email });
  return { ok: true, summary: removed.counts, cleanup: [...leftovers] };
}

module.exports = { lockLive, activeContracts, deleteAccount };
