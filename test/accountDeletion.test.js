// Account deletion (docs/features/account-deletion-and-privacy.md in the mobile repo).
// Over real HTTP against the test database, a fake Paystack and a fake Supabase Storage. Every test
// makes its own disposable people: the shared fixture accounts are never deleted.
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const h = require("./helpers");
const { prisma } = h;
const accounts = require("../src/accounts");
const jobs = require("../src/jobs");
const userAuth = require("../src/user/auth");

const PASSWORD = "Test-Suite-2026!"; // what h.ensureUser sets
let ctx, server, provider, fakePaystack, storage;
const made = [];
const waitlistEmails = [];

before(async () => {
  ctx = await h.fixtures();
  provider = h.fakeProvider();
  fakePaystack = await h.serveFakeProvider(provider);
  storage = await h.serveFakeStorage();
  server = await h.startServer({ port: 4617, paystackUrl: fakePaystack.url, autoRelease: false, storageUrl: storage.url });
});
after(async () => {
  server?.stop();
  fakePaystack?.server.close();
  storage?.server.close();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.waitlistEntry.deleteMany({ where: { email: { in: waitlistEmails } } });
  await prisma.user.deleteMany({ where: { id: { in: made.map((u) => u.id) } } });
  await prisma.$disconnect();
});
beforeEach(() => {
  provider.deletedRecipients.length = 0;
  provider.refuseRecipientDelete = false;
  storage.faults.remove = false;
  storage.objects.clear();
});

const uniq = () => crypto.randomBytes(4).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** A new person with a talent profile (bank details, recipient) when they are a talent. */
async function person(role) {
  const email = `testsuite-del-${uniq()}@example.com`;
  const user = await h.ensureUser(email, role, `Delete Me ${role}`);
  made.push(user);
  if (role === "talent") {
    await prisma.talentProfile.update({
      where: { userId: user.id },
      data: { paystackRecipientCode: `RCP_${uniq()}`, bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank", bankAccountName: "Delete Me" },
    });
  }
  return { user, email, token: await h.tokenFor(user) };
}
const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);
// del(who) sends the right password; del(who, "x") a wrong one; del(who, undefined) none at all.
const del = (p, ...args) => api(p.token, "DELETE", "/users/me", args.length === 0 ? { password: PASSWORD } : args[0] === undefined ? {} : { password: args[0] });
const fresh = (u) => prisma.user.findUnique({ where: { id: u.user.id } });

/** A job by `client`, awarded to `talent` (selected application), with a contract in `status` (none when null). */
async function seedJob(client, talent, status, extra = {}) {
  const job = await prisma.job.create({
    data: { clientId: client.user.id, title: `${h.TITLE_PREFIX}del-${uniq()}`, category: h.CATEGORY, description: "suite", budget: 1000, ...extra },
  });
  const application = await prisma.application.create({ data: { jobId: job.id, talentId: talent.user.id, status: "selected" } });
  await prisma.job.update({ where: { id: job.id }, data: { awardedApplicationId: application.id } });
  const contract = status ? await prisma.contract.create({ data: { jobId: job.id, status, platformFeeAmount: 100, payByAt: h.future() } }) : null;
  return { job, application, contract };
}
const openJob = (client, extra = {}) =>
  prisma.job.create({ data: { clientId: client.user.id, title: `${h.TITLE_PREFIX}del-${uniq()}`, category: h.CATEGORY, description: "suite", budget: 500, ...extra } });

describe("DELETE /users/me: who may delete", () => {
  it("needs the right password, and a wrong one changes nothing", async () => {
    const t = await person("talent");
    assert.equal((await del(t, undefined)).status, 400);
    // 403, not 401: the app treats a 401 as an expired session and would refresh and retry, spending a second attempt.
    const wrong = await del(t, "not-the-password");
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.code, "wrong_password");
    const u = await fresh(t);
    assert.equal(u.deletedAt, null);
    assert.equal(u.email, t.email);
    assert.ok(await prisma.talentProfile.findUnique({ where: { userId: t.user.id } }), "the profile is still there");
    assert.equal((await api(t.token, "GET", "/users/me")).status, 200, "and they are still signed in");
  });

  it("is refused with 409 and the jobs listed while any contract is unfinished, for a client and for a talent", async () => {
    // A fresh pair per status: attempts are rate limited per person, so one pair could not be refused six times.
    for (const status of ["awaitingPayment", "funded", "inProgress", "submitted", "changesRequested", "disputed"]) {
      const client = await person("client");
      const talent = await person("talent");
      const { job } = await seedJob(client, talent, status);
      for (const [who, role] of [[client, "client"], [talent, "talent"]]) {
        const r = await del(who);
        assert.equal(r.status, 409, `${role} with a ${status} contract: ${JSON.stringify(r.json)}`);
        assert.equal(r.json.code, "active_contracts");
        assert.deepEqual(r.json.contracts, [{ jobId: job.id, title: job.title, role, status }]);
        const u = await fresh(who);
        assert.equal(u.deletedAt, null, "a refused deletion leaves no mark behind");
        assert.equal(u.email, who.email);
      }
    }
  });

  it("is rate limited per person: the sixth try in 15 minutes is 429, even with the right password", async () => {
    const t = await person("talent");
    for (let i = 0; i < 5; i++) assert.equal((await del(t, "wrong-password")).status, 403);
    const sixth = await del(t);
    assert.equal(sixth.status, 429);
    assert.equal((await fresh(t)).deletedAt, null, "and nothing was deleted");
  });

  it("a finished (approved) contract does not block", async () => {
    const client = await person("client");
    const talent = await person("talent");
    await seedJob(client, talent, "approved");
    assert.equal((await del(client)).status, 200);
    assert.equal((await del(talent)).status, 200);
  });
});

describe("DELETE /users/me: what is removed and what stays", () => {
  it("a talent: sign-in, profile, bank details, proofs and their files, photo, Paystack recipient and the applications that did not win go; the finished job stays", async () => {
    const talent = await person("talent");
    const client = await person("client");
    const other = await person("client");

    const profile = await prisma.talentProfile.findUnique({ where: { userId: talent.user.id } });
    const proofPaths = [`${profile.id}/1-a.pdf`, `${profile.id}/2-b.png`];
    for (const p of proofPaths) {
      storage.objects.set(`proof-items/${p}`, { buffer: Buffer.from("x"), contentType: "application/pdf" });
      await prisma.proofItem.create({ data: { talentProfileId: profile.id, category: h.CATEGORY, title: "Work", filePath: p } });
    }
    const photoPath = `${talent.user.id}/${uniq()}.png`;
    storage.objects.set(`avatars/${photoPath}`, { buffer: Buffer.from("x"), contentType: "image/png" });
    await prisma.user.update({ where: { id: talent.user.id }, data: { photoPath, verificationCodeHash: "abc", passwordResetCodeHash: "def" } });

    const finished = await seedJob(client, talent, "approved");
    const pendingJob = await openJob(other);
    await prisma.application.create({ data: { jobId: pendingJob.id, talentId: talent.user.id, status: "pending" } });
    const lostJob = await openJob(other);
    await prisma.application.create({ data: { jobId: lostJob.id, talentId: talent.user.id, status: "notSelected" } });
    const recipient = profile.paystackRecipientCode;

    const r = await del(talent);
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const u = await fresh(talent);
    assert.ok(u.deletedAt, "marked deleted");
    assert.equal(u.email, `deleted-${talent.user.id}@deleted.invalid`);
    assert.equal(u.fullName, "Deleted user");
    assert.equal(u.photoPath, null);
    assert.equal(u.verificationCodeHash, null);
    assert.equal(u.passwordResetCodeHash, null);
    assert.equal(await userAuth.verifyPassword(u.passwordHash, PASSWORD), false, "the old password opens nothing");
    assert.equal(await prisma.user.findUnique({ where: { email: talent.email } }), null, "the address is free again");
    assert.equal(await prisma.talentProfile.findUnique({ where: { userId: talent.user.id } }), null, "profile and bank details gone");
    assert.equal(await prisma.proofItem.count({ where: { talentProfileId: profile.id } }), 0);
    assert.equal(await prisma.userSession.count({ where: { userId: talent.user.id } }), 0);

    assert.deepEqual([...storage.objects.keys()].filter((k) => k.startsWith("proof-items/") || k.startsWith("avatars/")), [], "files removed from storage");
    assert.deepEqual(provider.deletedRecipients, [recipient], "the Paystack recipient was set inactive");

    assert.equal(await prisma.application.count({ where: { talentId: talent.user.id, status: { not: "selected" } } }), 0);
    assert.ok(await prisma.application.findUnique({ where: { id: finished.application.id } }), "the winning application of a finished job stays");
    assert.equal((await prisma.contract.findUnique({ where: { id: finished.contract.id } })).status, "approved");
    assert.ok(await prisma.job.findUnique({ where: { id: finished.job.id } }));

    assert.equal((await api(talent.token, "GET", "/users/me")).status, 401, "the old token is dead");
    const login = await fetch(`${server.base}/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: talent.email, password: PASSWORD }),
    });
    assert.equal(login.status, 401, "and so is the old login");
  });

  it("a client: jobs with no contract go with their applications, a cancelled award is closed and kept, a finished job is untouched", async () => {
    const client = await person("client");
    const talent = await person("talent");
    const talent2 = await person("talent");

    const withApplicants = await openJob(client);
    await prisma.application.create({ data: { jobId: withApplicants.id, talentId: talent.user.id, status: "pending" } });
    const empty = await openJob(client);
    const closedOne = await openJob(client, { closedAt: new Date() });

    const cancelled = await openJob(client);
    await prisma.contractEvent.create({ data: { jobId: cancelled.id, contractId: crypto.randomUUID(), type: "awardCancelled" } });
    const cancelledApp = await prisma.application.create({ data: { jobId: cancelled.id, talentId: talent2.user.id, status: "pending" } });

    const finished = await seedJob(client, talent, "approved");

    const r = await del(client);
    assert.equal(r.status, 200, JSON.stringify(r.json));

    for (const j of [withApplicants, empty, closedOne]) assert.equal(await prisma.job.findUnique({ where: { id: j.id } }), null, "deleted");
    assert.equal(await prisma.application.count({ where: { jobId: withApplicants.id } }), 0, "its applications went with it");

    const kept = await prisma.job.findUnique({ where: { id: cancelled.id } });
    assert.ok(kept?.closedAt, "kept for the money trail, but closed so nobody can apply to a job with no owner");
    assert.equal((await prisma.application.findUnique({ where: { id: cancelledApp.id } })).status, "notSelected");
    assert.equal(await prisma.contractEvent.count({ where: { jobId: cancelled.id } }), 1, "the evidence is still there");

    const fin = await prisma.job.findUnique({ where: { id: finished.job.id } });
    assert.equal(fin.closedAt, null, "a finished job is not rewritten");
    assert.equal(fin.clientId, client.user.id, "it still points at the (now anonymised) client row");
    assert.equal((await fresh(client)).fullName, "Deleted user");
  });

  it("removes the waitlist sign-up made with the same email", async () => {
    const t = await person("talent");
    waitlistEmails.push(t.email);
    await prisma.waitlistEntry.create({ data: { email: t.email, role: "talent" } });
    assert.equal((await del(t)).status, 200);
    assert.equal(await prisma.waitlistEntry.count({ where: { email: t.email } }), 0);
  });

  it("trouble with storage or Paystack never undoes the deletion, and the log names what was left", async () => {
    const t = await person("talent");
    const profile = await prisma.talentProfile.findUnique({ where: { userId: t.user.id } });
    const p = `${profile.id}/1-a.pdf`;
    storage.objects.set(`proof-items/${p}`, { buffer: Buffer.from("x"), contentType: "application/pdf" });
    await prisma.proofItem.create({ data: { talentProfileId: profile.id, category: h.CATEGORY, title: "Work", filePath: p } });
    storage.faults.remove = true;
    provider.refuseRecipientDelete = true;

    const r = await del(t);
    assert.equal(r.status, 200, "the person's data is gone from the database, which is what they asked for");
    assert.equal((await fresh(t)).fullName, "Deleted user");
    assert.ok(storage.objects.has(`proof-items/${p}`), "the file is still in storage (the fault)");
    assert.match(server.logs(), new RegExp(`\\[account-delete\\] ${t.user.id}: cleanup incomplete: files, paystack`));
  });
});

describe("deleteAccount (the service)", () => {
  const quiet = { storage: { removeAvatar: async () => {}, removePrivateFiles: async () => {} }, paystack: { configured: false, deleteTransferRecipient: async () => {} } };

  it("emails the old address once, saying it is done", async () => {
    const t = await person("talent");
    const mailer = h.spyMailer();
    const r = await accounts.deleteAccount({ userId: t.user.id }, { mailer, ...quiet });
    assert.equal(r.ok, true);
    assert.deepEqual(mailer.sent.map((m) => [m.k, m.to]), [["sendAccountDeleted", t.email]]);
  });

  it("a second request finds nothing to delete", async () => {
    const t = await person("talent");
    await accounts.deleteAccount({ userId: t.user.id }, { mailer: h.spyMailer(), ...quiet });
    const again = await accounts.deleteAccount({ userId: t.user.id }, { mailer: h.spyMailer(), ...quiet });
    assert.equal(again.ok, false);
    assert.equal(again.status, 404);
  });

  it("RACE: an award that is already in flight wins, and the deletion is then refused", async () => {
    const client = await person("client");
    const talent = await person("talent");
    const { job } = await seedJob(client, talent, null);

    const locked = defer();
    const release = defer();
    const inFlightAward = prisma.$transaction(
      async (trx) => {
        assert.equal(await accounts.lockLive(trx, [client.user.id, talent.user.id]), null);
        locked.resolve();
        await release.promise;
        await trx.contract.create({ data: { jobId: job.id, status: "awaitingPayment", platformFeeAmount: 100, payByAt: h.future() } });
      },
      { timeout: 30000 },
    );
    await locked.promise;

    let settled = false;
    const deletion = accounts.deleteAccount({ userId: talent.user.id }, { mailer: h.spyMailer(), ...quiet }).then((r) => ((settled = true), r));
    await sleep(1500);
    assert.equal(settled, false, "the deletion waits behind the award instead of counting too early");
    release.resolve();
    await inFlightAward;

    const r = await deletion;
    assert.equal(r.ok, false);
    assert.equal(r.code, "active_contracts");
    assert.equal((await fresh(talent)).deletedAt, null);
  });

  it("RACE: an award that arrives while a deletion is in progress is refused once it commits", async () => {
    const client = await person("client");
    const talent = await person("talent");
    const job = await openJob(client);
    const application = await prisma.application.create({ data: { jobId: job.id, talentId: talent.user.id, status: "pending" } });

    const locked = defer();
    const release = defer();
    const inFlightDeletion = prisma.$transaction(
      async (trx) => {
        await trx.user.update({ where: { id: talent.user.id }, data: { deletedAt: new Date() } });
        locked.resolve();
        await release.promise;
      },
      { timeout: 30000 },
    );
    await locked.promise;

    let settled = false;
    const award = jobs.awardJob({ jobId: job.id, clientId: client.user.id, applicationId: application.id }, { prisma }).then((r) => ((settled = true), r));
    await sleep(1500);
    assert.equal(settled, false, "the award waits for the deletion's lock");
    release.resolve();
    await inFlightDeletion;

    const r = await award;
    assert.equal(r.ok, false);
    assert.equal(r.code, "account_unavailable");
    assert.equal(await prisma.contract.count({ where: { jobId: job.id } }), 0, "no contract was made");
    assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).awardedApplicationId, null);
  });

  it("a deleted client cannot award, and a deleted talent cannot be awarded or apply", async () => {
    const client = await person("client");
    const talent = await person("talent");
    const job = await openJob(client);
    const application = await prisma.application.create({ data: { jobId: job.id, talentId: talent.user.id, status: "pending" } });
    await prisma.user.update({ where: { id: talent.user.id }, data: { deletedAt: new Date() } });
    const awardToDeleted = await jobs.awardJob({ jobId: job.id, clientId: client.user.id, applicationId: application.id }, { prisma });
    assert.equal(awardToDeleted.code, "account_unavailable");

    const job2 = await openJob(client);
    const talent2 = await person("talent");
    const app2 = await prisma.application.create({ data: { jobId: job2.id, talentId: talent2.user.id, status: "pending" } });
    await prisma.user.update({ where: { id: client.user.id }, data: { deletedAt: new Date() } });
    const byDeleted = await jobs.awardJob({ jobId: job2.id, clientId: client.user.id, applicationId: app2.id }, { prisma });
    assert.equal(byDeleted.code, "account_unavailable");

    const job3 = await openJob(await person("client"));
    const applies = await jobs.applyToJob({ jobId: job3.id, talentId: talent.user.id }, { prisma });
    assert.equal(applies.code, "account_unavailable");
    assert.equal(await prisma.application.count({ where: { jobId: job3.id } }), 0);
  });
});

describe("POST /jobs while the client is being deleted", () => {
  it("waits, then is refused once the deletion commits, and no job is made", async () => {
    const client = await person("client");
    const locked = defer();
    const release = defer();
    const inFlightDeletion = prisma.$transaction(
      async (trx) => {
        await trx.user.update({ where: { id: client.user.id }, data: { deletedAt: new Date() } });
        locked.resolve();
        await release.promise;
      },
      { timeout: 30000 },
    );
    await locked.promise;

    let settled = false;
    const post = api(client.token, "POST", "/jobs", { title: `${h.TITLE_PREFIX}del-post`, category: h.CATEGORY, description: "suite", budget: 500, deliveryDays: 5 }).then((r) => ((settled = true), r));
    await sleep(1500);
    assert.equal(settled, false, "the new job waits for the deletion's lock");
    release.resolve();
    await inFlightDeletion;

    const r = await post;
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.code, "account_unavailable");
    assert.equal(await prisma.job.count({ where: { clientId: client.user.id } }), 0);
  });
});

describe("scripts/delete-user.js (a request that arrived by email)", () => {
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["scripts/delete-user.js", ...args], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", PAYSTACK_SECRET_KEY: "", BREVO_API_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (status) => resolve({ status, out }));
    });

  it("shows what it would do and changes nothing without --yes", async () => {
    const t = await person("talent");
    const r = await run(["--email", t.email]);
    assert.equal(r.status, 1);
    assert.match(r.out, /--yes/);
    assert.equal((await fresh(t)).deletedAt, null);
  });

  it("deletes with --yes, and refuses an unknown address or an active contract", async () => {
    const client = await person("client");
    const talent = await person("talent");
    await seedJob(client, talent, "inProgress");
    const blocked = await run(["--email", client.email, "--yes"]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.out, /active_contracts|active contract/i);
    assert.equal((await fresh(client)).deletedAt, null);

    assert.equal((await run(["--email", `nobody-${uniq()}@example.com`, "--yes"])).status, 1);

    const solo = await person("client");
    const ok = await run(["--email", solo.email, "--yes"]);
    assert.equal(ok.status, 0, ok.out);
    assert.equal((await fresh(solo)).fullName, "Deleted user");
  });
});
