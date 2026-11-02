// S5: the start proof and the 20% release, drafts, receipts, the display currency, and the gate on job types and
// dollars. The money steps run against the Paystack stand-in; storage is a local fake of the private bucket.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const sp = require("../src/startProof");
const lifecycle = require("../src/contractLifecycle");
const flags = require("../src/featureFlags");
const { prisma } = h;

let ctx, server, r2, provider, fakeProvider, ca, cl, disputesTok, plainTok, disputes, plain;
const admins = [];

before(async () => {
  ctx = await h.fixtures();
  provider = h.fakeProvider();
  fakeProvider = await h.serveFakeProvider(provider);
  r2 = await h.serveFakeR2();
  server = await h.startServer({
    port: 4671,
    paystackUrl: fakeProvider.url,
    autoRelease: false,
    env: {
      R2_ACCOUNT_ID: "test",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
      R2_PRIVATE_BUCKET: "private-test",
      R2_ENDPOINT: r2.url,
      JOB_TYPES_ENABLED: "oneDelivery",
      USD_JOBS_ENABLED: "false",
      FX_NGN_PER_USD: "1500",
      FX_AS_OF: "2026-10-30",
    },
  });
  disputes = await h.ensureAdmin("testsuite-s5-disputes@example.com", { capabilities: ["disputes"] });
  plain = await h.ensureAdmin("testsuite-s5-plain@example.com");
  admins.push(disputes, plain);
  [ca, cl, disputesTok, plainTok] = await Promise.all([h.tokenFor(ctx.talentA), h.tokenFor(ctx.client), h.adminTokenFor(disputes), h.adminTokenFor(plain)]);
});
after(async () => {
  server?.stop();
  r2?.server.close();
  fakeProvider?.server.close();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.adminAuditEvent.deleteMany({ where: { actorId: { in: admins.map((a) => a.id) } } });
  await prisma.user.update({ where: { id: ctx.client.id }, data: { displayCurrency: "NGN" } });
  await prisma.$disconnect();
});

const api = (tok, method, p, body) => h.call(server.base, tok, method, p, body);

/** A funded, started graphic-design job priced at 10 000, awarded to talent A. */
async function working({ budget = 10000, contract = {} } = {}) {
  const s = await h.seedWorking(ctx, { contract: { platformFeeAmount: budget * 0.1, paystackReference: `kd_${Math.random().toString(16).slice(2)}`, ...contract } });
  await prisma.job.update({ where: { id: s.job.id }, data: { skillKey: "graphic-design", budget } });
  return s;
}

async function uploadFile(tok, jobId, fieldKey, name, contentType, bytes) {
  const made = await api(tok, "POST", `/jobs/${jobId}/contract/start-proof/files`, { fieldKey, name, contentType, sizeBytes: bytes.length });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const put = await fetch(made.json.upload.url, { method: "PUT", headers: made.json.upload.headers, body: bytes });
  assert.ok(put.ok, `upload failed ${put.status}`);
  return api(tok, "POST", `/jobs/${jobId}/contract/start-proof/files/${made.json.itemId}/complete`);
}

/** Everything graphic-design asks for, sent. */
async function sendFullProof(jobId) {
  await uploadFile(ca, jobId, "concepts", "one.png", "image/png", Buffer.alloc(200, 1));
  await uploadFile(ca, jobId, "concepts", "two.png", "image/png", Buffer.alloc(200, 2));
  await uploadFile(ca, jobId, "moodboard", "board.png", "image/png", Buffer.alloc(200, 3));
  return api(ca, "POST", `/jobs/${jobId}/contract/start-proof/submit`);
}

describe("the rules", () => {
  it("20% of the price, to the kobo", () => {
    assert.equal(sp.upfrontAmountOf(10000), 2000);
    assert.equal(sp.upfrontAmountOf(333.33), 66.67);
  });

  it("says plainly what is short before the proof can be sent", () => {
    const r = sp.checkProof("graphic-design", [{ fieldKey: "concepts", status: "ready" }]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing.map((m) => m.key), ["concepts", "moodboard"]);
    assert.match(r.missing[0].problem, /you have 1/);
    const ok = sp.checkProof("graphic-design", [{ fieldKey: "concepts", status: "ready" }, { fieldKey: "concepts", status: "ready" }, { fieldKey: "moodboard", status: "ready" }]);
    assert.equal(ok.ok, true);
  });

  it("refuses programs, wrong types and oversize files", () => {
    const base = { skillKey: "graphic-design", fieldKey: "moodboard", name: "a.png", contentType: "image/png", sizeBytes: 1000 };
    assert.equal(sp.validateFileInput(base).ok, true);
    assert.equal(sp.validateFileInput({ ...base, name: "setup.exe" }).code, "executable");
    assert.equal(sp.validateFileInput({ ...base, contentType: "application/pdf" }).code, "type_not_allowed");
    assert.equal(sp.validateFileInput({ ...base, sizeBytes: 200 * 1024 * 1024 }).code, "file_too_large");
    assert.equal(sp.validateFileInput({ ...base, fieldKey: "nope" }).code, "invalid");
  });

  it("only oneDelivery in naira is payable unless the others are switched on", () => {
    const keep = { t: process.env.JOB_TYPES_ENABLED, u: process.env.USD_JOBS_ENABLED };
    try {
      delete process.env.JOB_TYPES_ENABLED;
      delete process.env.USD_JOBS_ENABLED;
      assert.equal(flags.unavailableReason({ jobType: "oneDelivery", currency: "NGN" }), null);
      assert.equal(flags.unavailableReason({ jobType: "hourly", currency: "NGN" }).code, "type_not_available");
      assert.equal(flags.unavailableReason({ jobType: "oneDelivery", currency: "USD" }).code, "usd_not_available");
      process.env.JOB_TYPES_ENABLED = "oneDelivery,hourly";
      process.env.USD_JOBS_ENABLED = "true";
      assert.equal(flags.unavailableReason({ jobType: "hourly", currency: "USD" }), null);
    } finally {
      for (const [k, v] of [["JOB_TYPES_ENABLED", keep.t], ["USD_JOBS_ENABLED", keep.u]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });
});

describe("sending the start proof", () => {
  it("a structured job cannot be delivered before its start proof is accepted", async () => {
    const { job } = await working();
    const r = await api(ca, "POST", `/jobs/${job.id}/contract/submit`, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "start_proof_required");
  });

  it("the talent builds it part by part, and cannot send it incomplete", async () => {
    const { job } = await working();
    const first = await api(ca, "GET", `/jobs/${job.id}/contract/start-proof`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.startProof.fields.map((f) => f.key), ["concepts", "moodboard"]);
    assert.equal(first.json.startProof.upfrontAmount, 2000);
    assert.equal(first.json.startProof.readyToSend, false);

    await uploadFile(ca, job.id, "concepts", "one.png", "image/png", Buffer.alloc(100, 1));
    const early = await api(ca, "POST", `/jobs/${job.id}/contract/start-proof/submit`);
    assert.equal(early.status, 400);
    assert.equal(early.json.code, "incomplete");
    assert.ok(early.json.missing.length >= 1);

    // The client may see the job's proof only once it is sent: they have no route to edit it.
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/contract/start-proof/files`, { fieldKey: "concepts", name: "x.png", contentType: "image/png", sizeBytes: 10 })).status, 403);
  });

  it("a file whose size differs from what was promised is removed", async () => {
    const { job } = await working();
    const made = await api(ca, "POST", `/jobs/${job.id}/contract/start-proof/files`, { fieldKey: "moodboard", name: "b.png", contentType: "image/png", sizeBytes: 500 });
    await fetch(made.json.upload.url, { method: "PUT", headers: made.json.upload.headers, body: Buffer.alloc(100) });
    const done = await api(ca, "POST", `/jobs/${job.id}/contract/start-proof/files/${made.json.itemId}/complete`);
    assert.equal(done.status, 400);
    assert.equal(done.json.code, "size_mismatch");
    assert.equal(await prisma.startProofItem.count({ where: { id: made.json.itemId } }), 0, "no row left behind");
  });

  it("sending starts the client's 24 hours and they see the files", async () => {
    const { job, c } = await working();
    const sent = await sendFullProof(job.id);
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.startProof.status, "submitted");
    const due = new Date(sent.json.startProof.dueAt).getTime() - new Date(sent.json.startProof.submittedAt).getTime();
    assert.equal(due, 24 * 3_600_000);
    const seen = await api(cl, "GET", `/jobs/${job.id}/contract/start-proof`);
    assert.equal(seen.status, 200);
    assert.equal(seen.json.startProof.fields.find((f) => f.key === "concepts").items.length, 2);
    assert.ok(seen.json.startProof.fields[0].items[0].url, "a short-lived link to the file");
    // Nobody else is on this job.
    const stranger = await h.tokenFor(ctx.talentB);
    assert.equal((await api(stranger, "GET", `/jobs/${job.id}/contract/start-proof`)).status, 404);
    assert.equal((await prisma.contractEvent.count({ where: { contractId: c.id, type: "startProofSubmitted" } })), 1);
    // Sent proof is locked.
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/contract/start-proof/files`, { fieldKey: "concepts", name: "x.png", contentType: "image/png", sizeBytes: 10 })).status, 409);
  });
});

describe("accepting it pays the first 20%", () => {
  it("pays 2 000 once, reads it back, and the final release pays only the rest", async () => {
    const { job, c } = await working();
    await sendFullProof(job.id);
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/contract/start-proof/accept`)).status, 403, "the talent can't accept their own proof");
    const accepted = await api(cl, "POST", `/jobs/${job.id}/contract/start-proof/accept`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.startProof.status, "accepted");
    assert.ok(accepted.json.startProof.upfrontPaidAt);
    const row = await prisma.contract.findUnique({ where: { id: c.id } });
    assert.equal(Number(row.upfrontAmount), 2000);
    assert.ok(row.upfrontTransferCode);
    assert.deepEqual(provider.payouts.filter((p) => p.reference.startsWith(`kd_upfront_${c.id}`)).map((p) => p.amountNaira), [2000]);

    // Accepting again does not send money again.
    const again = await api(cl, "POST", `/jobs/${job.id}/contract/start-proof/accept`);
    assert.equal(again.status, 409);
    assert.equal(provider.payouts.filter((p) => p.reference.startsWith(`kd_upfront_${c.id}`)).length, 1);

    // Now deliverable; the final release is the price less what was paid.
    await prisma.contract.update({ where: { id: c.id }, data: { status: "submitted", submittedAt: new Date(), reviewDueAt: h.future(86_400_000) } });
    const mine = h.fakeProvider();
    const released = await lifecycle.releasePayment({ contractId: c.id, trigger: "test" }, { prisma, paystack: mine });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.deepEqual(mine.payouts.map((p) => p.amountNaira), [8000], "8 000, not 10 000");
  });

  it("two taps at once send one payment", async () => {
    const { job, c } = await working();
    await sendFullProof(job.id);
    const [x, y] = await Promise.all([api(cl, "POST", `/jobs/${job.id}/contract/start-proof/accept`), api(cl, "POST", `/jobs/${job.id}/contract/start-proof/accept`)]);
    assert.ok([x.status, y.status].includes(200));
    assert.equal(provider.payouts.filter((p) => p.reference.startsWith(`kd_upfront_${c.id}`)).length, 1);
  });

  it("silence for 24 hours accepts it, unless that is switched off", async () => {
    const { job, c } = await working();
    await sendFullProof(job.id);
    await prisma.contract.update({ where: { id: c.id }, data: { startProofDueAt: new Date(Date.now() - 1000) } });
    const mine = h.fakeProvider();
    process.env.START_PROOF_AUTO_ACCEPT = "false";
    const off = await sp.autoAcceptDue({ prisma, paystack: mine });
    delete process.env.START_PROOF_AUTO_ACCEPT;
    assert.equal(off.startProofsAutoAccepted, 0);
    assert.equal(mine.payouts.length, 0);
    const on = await sp.autoAcceptDue({ prisma, paystack: mine });
    assert.ok(on.startProofsAutoAccepted >= 1);
    assert.equal((await prisma.contract.findUnique({ where: { id: c.id } })).startProofStatus, "accepted");
    assert.deepEqual(mine.payouts.filter((p) => p.reference.includes(c.id)).map((p) => p.amountNaira), [2000]);
  });

  it("a payout that Paystack refuses leaves the proof waiting, not accepted", async () => {
    const { c } = await working();
    await prisma.contract.update({ where: { id: c.id }, data: { startProofStatus: "submitted", startProofSubmittedAt: new Date(), startProofDueAt: h.future(86_400_000) } });
    const refusing = h.fakeProvider({ refusePayouts: true });
    const r = await sp.releaseUpfront({ contractId: c.id, trigger: "test" }, { prisma, paystack: refusing });
    assert.equal(r.ok, false);
    assert.equal(r.code, "transfer_error");
    const row = await prisma.contract.findUnique({ where: { id: c.id } });
    assert.equal(row.startProofStatus, "submitted");
    assert.equal(row.upfrontPaidAt, null);
    assert.equal(row.upfrontClaimedAt, null, "the claim is released so it can be tried again");
  });
});

describe("an objection is ruled on by a person", () => {
  async function objected() {
    const s = await working();
    await sendFullProof(s.job.id);
    const r = await api(cl, "POST", `/jobs/${s.job.id}/contract/start-proof/object`, { reasonCode: "wrong_format", note: "The moodboard is a screenshot, not a board." });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return s;
  }

  it("needs a reason from the list and a note, and quality is not on the list", async () => {
    const { job } = await working();
    await sendFullProof(job.id);
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/contract/start-proof/object`, { reasonCode: "i_dont_like_it", note: "It is ugly and I want it redone." })).status, 400);
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/contract/start-proof/object`, { reasonCode: "missing_part", note: "short" })).status, 400);
    assert.ok(!sp.OBJECTION_REASONS.some((r) => /quality|ugly|dislike|don't like/i.test(r.label)));
  });

  it("is refused once the 24 hours have passed", async () => {
    const { job, c } = await working();
    await sendFullProof(job.id);
    await prisma.contract.update({ where: { id: c.id }, data: { startProofDueAt: new Date(Date.now() - 1000) } });
    const r = await api(cl, "POST", `/jobs/${job.id}/contract/start-proof/object`, { reasonCode: "missing_part", note: "Something is missing here." });
    assert.equal(r.status, 409);
  });

  it("only the disputes team sees the queue, and upholding sends it back for a second round", async () => {
    const { job, c } = await objected();
    assert.equal((await api(plainTok, "GET", "/admin/start-proofs")).status, 403);
    const list = await api(disputesTok, "GET", "/admin/start-proofs");
    assert.equal(list.status, 200);
    assert.ok(list.json.startProofs.some((s) => s.contractId === c.id));
    const detail = await api(disputesTok, "GET", `/admin/start-proofs/${c.id}`);
    assert.equal(detail.json.checklist.meetsFormat, true, "the list shows what the format asks and whether it is all there");
    assert.equal(detail.json.startProof.objection.reasonCode, "wrong_format");

    assert.equal((await api(disputesTok, "POST", `/admin/start-proofs/${c.id}/resolve`, { decision: "uphold", note: "no" })).status, 400, "a ruling needs a note");
    const upheld = await api(disputesTok, "POST", `/admin/start-proofs/${c.id}/resolve`, { decision: "uphold", note: "Checked: the moodboard is one screenshot." });
    assert.equal(upheld.status, 200);
    assert.equal(upheld.json.status, "redo");
    const row = await prisma.contract.findUnique({ where: { id: c.id } });
    assert.equal(row.startProofRound, 1);
    assert.equal(row.upfrontPaidAt, null);
    // Round 1 starts empty and the talent can send again.
    const again = await api(ca, "GET", `/jobs/${job.id}/contract/start-proof`);
    assert.equal(again.json.startProof.fields.every((f) => f.items.length === 0), true);
    // A second ruling on the same objection is refused.
    assert.equal((await api(disputesTok, "POST", `/admin/start-proofs/${c.id}/resolve`, { decision: "dismiss", note: "Checked it also." })).status, 409);
    const sent = await sendFullProof(job.id);
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.startProof.round, 1);
  });

  it("dismissing it pays the 20%", async () => {
    const { c } = await objected();
    const r = await api(disputesTok, "POST", `/admin/start-proofs/${c.id}/resolve`, { decision: "dismiss", note: "Checked: it meets the format." });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, "accepted");
    assert.equal(provider.payouts.filter((p) => p.reference.startsWith(`kd_upfront_${c.id}`)).length, 1);
    const audit = await prisma.adminAuditEvent.findFirst({ where: { subjectId: c.id, action: "startProof.dismissed" } });
    assert.ok(audit, "every ruling is audited");
  });
});

describe("drafts, receipts and the display currency", () => {
  it("a draft is shared without starting any clock, and the client is told", async () => {
    const { job, c } = await working();
    const bytes = Buffer.alloc(300, 7);
    const made = await api(ca, "POST", `/jobs/${job.id}/contract/drafts`, { note: "First pass", files: [{ name: "draft.png", contentType: "image/png", sizeBytes: bytes.length }] });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    await fetch(made.json.uploads[0].url, { method: "PUT", headers: made.json.uploads[0].headers, body: bytes });
    const done = await api(ca, "POST", `/jobs/${job.id}/contract/drafts/${made.json.draftId}/complete`);
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const seen = await api(cl, "GET", `/jobs/${job.id}/contract/drafts`);
    assert.equal(seen.json.drafts.length, 1);
    assert.equal(seen.json.drafts[0].note, "First pass");
    assert.ok(seen.json.drafts[0].files[0].url);
    assert.equal((await prisma.contract.findUnique({ where: { id: c.id } })).status, "inProgress", "a draft does not start the review clock");
    assert.equal((await prisma.contractEvent.count({ where: { contractId: c.id, type: "draftShared" } })), 1);
    assert.equal((await api(cl, "POST", `/jobs/${job.id}/contract/drafts`, { files: [{ name: "x.png", contentType: "image/png", sizeBytes: 5 }] })).status, 403);
    assert.equal((await api(ca, "POST", `/jobs/${job.id}/contract/drafts`, { files: [{ name: "run.exe", contentType: "application/octet-stream", sizeBytes: 5 }] })).json.code, "executable");
  });

  it("the receipt shows the client the total and the talent what they were paid", async () => {
    const { job, c } = await working();
    await sendFullProof(job.id);
    await api(cl, "POST", `/jobs/${job.id}/contract/start-proof/accept`);
    const asClient = await api(cl, "GET", `/jobs/${job.id}/contract/receipt`);
    assert.equal(asClient.status, 200);
    assert.equal(asClient.json.receipt.price, 10000);
    assert.equal(asClient.json.receipt.platformFee, 1000);
    assert.equal(asClient.json.receipt.totalPaidByClient, 11000);
    assert.equal(asClient.json.receipt.payouts, undefined, "the client does not see the talent's payouts");
    const asTalent = await api(ca, "GET", `/jobs/${job.id}/contract/receipt`);
    assert.equal(asTalent.json.receipt.payouts.upfront.amount, 2000);
    assert.equal(asTalent.json.receipt.payouts.final, null);
    const unpaid = await h.seedAward(ctx);
    assert.equal((await api(cl, "GET", `/jobs/${unpaid.job.id}/contract/receipt`)).json.code, "not_paid");
    const list = await api(cl, "GET", "/jobs/receipts/mine");
    assert.ok(list.json.receipts.some((r) => r.jobId === job.id && r.amount === 11000));
    assert.equal(c.id.length > 0, true);
  });

  it("shows the rate only when the team has set one, and remembers the display currency", async () => {
    const rate = await api(cl, "GET", "/rates");
    assert.equal(rate.json.ngnPerUsd, 1500);
    assert.equal(rate.json.asOf.slice(0, 10), "2026-10-30");
    assert.equal((await api(cl, "PATCH", "/users/me/settings", { displayCurrency: "EUR" })).status, 400);
    assert.equal((await api(cl, "PATCH", "/users/me/settings", { displayCurrency: "USD" })).json.displayCurrency, "USD");
    assert.equal((await api(cl, "GET", "/users/me/settings")).json.displayCurrency, "USD");
  });
});

describe("what cannot be paid for yet is refused", () => {
  it("posting a milestone or dollar job says so plainly", async () => {
    const t = await api(cl, "POST", "/jobs", { jobType: "milestones", skillKey: "graphic-design" });
    assert.equal(t.status, 400);
    assert.equal(t.json.code, "type_not_available");
    assert.equal(t.json.field, "jobType");
    const u = await api(cl, "POST", "/jobs", { jobType: "oneDelivery", currency: "USD", skillKey: "graphic-design" });
    assert.equal(u.json.code, "usd_not_available");
    assert.equal(u.json.field, "currency");
  });

  it("a job already posted that way cannot be awarded", async () => {
    const job = await prisma.job.create({ data: { clientId: ctx.client.id, title: `${h.TITLE_PREFIX}hourly`, category: h.CATEGORY, description: "d", budget: 1000, jobType: "hourly", postStatus: "live" } });
    const app = await prisma.application.create({ data: { jobId: job.id, talentId: ctx.talentA.id } });
    const r = await api(cl, "POST", `/jobs/${job.id}/applications/${app.id}/award`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "type_not_available");
    assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).awardedApplicationId, null);
  });
});
