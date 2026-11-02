// Card chargebacks (PRD §4.9; D36). A client can ask their bank to reverse a card payment. Paystack gives a Nigerian
// business 16 hours, weekdays only, to answer, or the chargeback is accepted automatically and the amount is taken from
// the next payout, with no way back. So: alert the team the moment it arrives, keep the receipt Paystack asks for ready
// (the client's name as on their ID, the amount, the card's first six and last four, the date, a description of the
// service), and answer through the Dispute API with it.
//
// Who absorbs a loss (D36): a chargeback lost after the talent was paid for approved work is absorbed by King Domain; the
// talent keeps what they earned and the client is removed.
const { prisma: realPrisma } = require("./db");
const realPaystack = require("./paystack");
const { recordEvent } = require("./contractCore");

const HOURS_TO_ANSWER = 16;
const LAGOS_OFFSET_H = 1; // Africa/Lagos is UTC+1 all year

/** Lagos weekday (0 Sunday to 6 Saturday) of an instant. */
const lagosDay = (d) => new Date(d.getTime() + LAGOS_OFFSET_H * 3_600_000).getUTCDay();

/**
 * The instant 16 weekday hours after `start`. Saturday and Sunday (Lagos time) do not count, so a chargeback that
 * arrives late on a Friday is due on Monday. Paystack's own dueAt is used when it sends one.
 */
function addWeekdayHours(start, hours = HOURS_TO_ANSWER) {
  let t = new Date(start.getTime());
  // Milliseconds, not whole minutes: rounding the time left in a day could land on 0 just short of midnight and never move on.
  let left = hours * 3_600_000;
  while (left > 0) {
    const day = lagosDay(t);
    if (day === 0 || day === 6) {
      // Jump to the next Monday 00:00 Lagos.
      const lagos = new Date(t.getTime() + LAGOS_OFFSET_H * 3_600_000);
      const add = day === 6 ? 2 : 1;
      lagos.setUTCHours(0, 0, 0, 0);
      lagos.setUTCDate(lagos.getUTCDate() + add);
      t = new Date(lagos.getTime() - LAGOS_OFFSET_H * 3_600_000);
      continue;
    }
    // Time until the end of this Lagos weekday: always more than zero, since `lagos` is before the next midnight.
    const lagos = new Date(t.getTime() + LAGOS_OFFSET_H * 3_600_000);
    const endOfDay = new Date(lagos);
    endOfDay.setUTCHours(24, 0, 0, 0);
    const room = endOfDay.getTime() - lagos.getTime();
    const step = Math.min(room, left);
    t = new Date(t.getTime() + step);
    left -= step;
  }
  return t;
}

async function alert(db, args, deps) {
  try {
    await require("./alerts").raiseAlert(db, args, deps);
  } catch (err) {
    console.error(`chargeback: could not alert the team: ${err.message}`);
  }
}

/**
 * Handles charge.dispute.create / .remind / .resolve. The payload is Paystack's Dispute resource
 * (paystack.com/docs/api/dispute): id, status, resolution, dueAt, bin, last4, refund_amount, transaction.{reference, amount},
 * customer.email. Safe to receive twice.
 */
async function receive(event, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = (deps.now ?? (() => new Date()))();
  const d = event.data ?? {};
  const disputeId = String(d.id ?? "");
  if (!disputeId) {
    console.error("chargeback: event without a dispute id ignored");
    return { ok: false };
  }
  const reference = d.transaction?.reference ?? d.transaction_reference ?? null;
  const contract = reference ? await prisma.contract.findFirst({ where: { paystackReference: reference }, include: { job: true } }) : null;
  const amountKobo = Number(d.transaction?.amount ?? d.refund_amount ?? 0);
  const dueAt = d.dueAt || d.due_at ? new Date(d.dueAt ?? d.due_at) : null;

  if (event.event === "charge.dispute.create") {
    const due = dueAt ?? addWeekdayHours(now);
    const row = await prisma.chargeback.upsert({
      where: { paystackDisputeId: disputeId },
      update: { dueAt: dueAt ?? undefined },
      create: { paystackDisputeId: disputeId, reference, contractId: contract?.id ?? null, amountKobo, dueAt: due, bin: d.bin ?? null, last4: d.last4 ?? null, customerEmail: d.customer?.email?.trim() ?? null, raw: d },
    });
    if (contract) await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "chargebackReceived", meta: { chargebackId: row.id } }).catch(() => {});
    console.error(`chargeback: RECEIVED id=${disputeId} reference=${reference} contract=${contract?.id ?? "unknown"} amountKobo=${amountKobo} due=${row.dueAt?.toISOString()}`);
    await alert(prisma, { severity: "urgent", queueKey: "chargeback", title: "Chargeback: answer within 16 weekday hours", body: `A client's bank is reversing a card payment of ₦${(amountKobo / 100).toLocaleString("en-NG")}. Due ${row.dueAt?.toISOString() ?? "soon"}. After that it is accepted for us and cannot be undone.`, link: `/chargebacks/${row.id}` }, deps);
    return { ok: true, chargeback: row };
  }

  const row = await prisma.chargeback.findUnique({ where: { paystackDisputeId: disputeId } });
  if (!row) {
    // A reminder or resolution for one we never saw: record it so the team sees it.
    return receive({ event: "charge.dispute.create", data: d }, deps);
  }

  if (event.event === "charge.dispute.remind") {
    if (row.status === "open") {
      await alert(prisma, { severity: "urgent", queueKey: "chargeback", title: "Chargeback still waiting for an answer", body: `Due ${row.dueAt?.toISOString() ?? "soon"}. After that it is accepted for us.`, link: `/chargebacks/${row.id}` }, deps);
    }
    return { ok: true, chargeback: row };
  }

  if (event.event === "charge.dispute.resolve") {
    // Paystack's resolution is "merchant-accepted" (the chargeback stood) or "declined" (we contested it and it did not).
    // Which of those means we won is Paystack's wording, so the raw payload is kept and shown to the team.
    const lost = d.resolution === "merchant-accepted" || Number(d.refund_amount ?? 0) > 0;
    const updated = await prisma.chargeback.update({ where: { id: row.id }, data: { status: lost ? "lost" : "won", resolution: d.resolution ?? null, raw: d } });
    console.error(`chargeback: RESOLVED id=${disputeId} resolution=${d.resolution} refund_amount=${d.refund_amount} -> ${updated.status}`);
    if (lost && contract) await removeClientAfterLoss(prisma, contract, updated, deps);
    return { ok: true, chargeback: updated };
  }
  return { ok: false };
}

/** D36: a lost chargeback on approved work is absorbed by King Domain, and the client is removed. */
async function removeClientAfterLoss(prisma, contract, chargeback, deps) {
  if (contract.status !== "approved" && contract.status !== "resolved") return;
  const clientId = contract.job.clientId;
  const at = (deps.now ?? (() => new Date()))();
  await prisma.user.update({ where: { id: clientId }, data: { removedAt: at, removedReason: "A card payment on a finished job was reversed by their bank." } });
  await prisma.userSession.updateMany({ where: { userId: clientId, revokedAt: null }, data: { revokedAt: at } });
  await prisma.chargeback.update({ where: { id: chargeback.id }, data: { clientRemovedAt: at } });
  await recordEvent(prisma, { jobId: contract.jobId, contractId: contract.id, type: "clientRemoved", meta: { chargebackId: chargeback.id } }).catch(() => {});
  console.error(`chargeback: client removed user=${clientId} after a lost chargeback ${chargeback.id}; the talent keeps what they earned`);
}

// ── The receipt Paystack asks for ────────────────────────

/** What a chargeback answer carries, from the records. Every field Paystack asks for, with where it came from. */
async function evidenceFor(prisma, chargebackId) {
  const cb = await prisma.chargeback.findUnique({ where: { id: chargebackId } });
  if (!cb) return null;
  const contract = cb.contractId
    ? await prisma.contract.findUnique({ where: { id: cb.contractId }, include: { job: { include: { client: true } }, deliveries: true } })
    : null;
  const events = contract ? await prisma.contractEvent.findMany({ where: { jobId: contract.jobId }, orderBy: { createdAt: "asc" }, take: 100 }) : [];
  const application = contract?.job.awardedApplicationId ? await prisma.application.findUnique({ where: { id: contract.job.awardedApplicationId }, include: { talent: true } }) : null;
  const client = contract?.job.client ?? null;
  const price = contract ? Number(contract.job.budget) : null;
  const fee = contract ? Number(contract.platformFeeAmount ?? 0) : null;
  const lines = contract
    ? [
        "King Domain: receipt for a payment",
        "",
        `Customer name (as on their ID): ${client?.legalName ?? client?.fullName ?? "not on record"}`,
        `Customer email: ${client?.email ?? cb.customerEmail ?? ""}`,
        `Amount paid: NGN ${((price ?? 0) + (fee ?? 0)).toLocaleString("en-NG")} (price NGN ${(price ?? 0).toLocaleString("en-NG")} plus service fee NGN ${(fee ?? 0).toLocaleString("en-NG")})`,
        `Card: first six ${cb.bin ?? "not given"}, last four ${cb.last4 ?? "not given"}`,
        `Date paid: ${contract.fundedAt ? contract.fundedAt.toISOString().slice(0, 10) : "not on record"}`,
        `Paystack reference: ${cb.reference ?? ""}`,
        "",
        `Service: ${contract.job.title}${contract.job.skillKey ? ` (${contract.job.skillKey})` : ""}, delivered by ${application?.talent?.legalName ?? application?.talent?.fullName ?? "the talent"}`,
        `Brief: ${String(contract.job.description).slice(0, 300)}`,
        "",
        "Record of the job:",
        ...events.map((e) => `  ${e.createdAt.toISOString().slice(0, 16).replace("T", " ")}  ${e.type}`),
        "",
        `Work delivered: ${contract.deliveries.length} version(s)${contract.transferredAt ? `; approved and paid out on ${contract.transferredAt.toISOString().slice(0, 10)}` : ""}`,
      ]
    : ["No contract matches this payment reference."];
  return {
    chargeback: cb,
    contract,
    client,
    talent: application?.talent ?? null,
    lines,
    ready: Boolean(contract && cb.bin && cb.last4 && (client?.legalName || client?.fullName)),
    missing: [
      !contract && "the contract this payment belongs to",
      contract && !cb.bin && "the card's first six digits",
      contract && !cb.last4 && "the card's last four digits",
      contract && !(client?.legalName || client?.fullName) && "the client's name as on their ID",
    ].filter(Boolean),
  };
}

/** A one-page PDF of plain text lines, so the receipt can be uploaded as the evidence file. No library needed. */
function receiptPdf(lines) {
  const esc = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
  const body = [];
  let y = 800;
  body.push("BT /F1 10 Tf 40 " + y + " Td 12 TL");
  for (const line of lines.slice(0, 60)) {
    body.push(`(${esc(line).slice(0, 110)}) Tj T*`);
  }
  body.push("ET");
  const stream = body.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Contests the chargeback with the receipt and the evidence (the team decides to; this sends it). */
async function respond({ chargebackId, adminId, note }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const paystack = deps.paystack ?? realPaystack;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ev = await evidenceFor(prisma, chargebackId);
  if (!ev) return { ok: false, status: 404, code: "not_found", error: "Chargeback not found." };
  if (ev.chargeback.status !== "open") return { ok: false, status: 409, code: "not_open", error: "This chargeback was already answered." };
  if (!ev.ready) return { ok: false, status: 409, code: "evidence_incomplete", error: `Paystack needs ${ev.missing.join(", ")}. Without it the answer is likely to fail.` };

  const { chargeback, client, contract } = ev;
  const filename = `receipt-${chargeback.paystackDisputeId}.pdf`;
  const pdf = receiptPdf(ev.lines);
  try {
    const upload = await paystack.chargebackUploadUrl(chargeback.paystackDisputeId, filename);
    const put = await fetchImpl(upload.signedUrl, { method: "PUT", body: pdf, headers: { "Content-Type": "application/pdf" } });
    if (!put.ok) throw new Error(`Paystack's storage refused the receipt (${put.status}).`);
    await paystack.addChargebackEvidence(chargeback.paystackDisputeId, {
      customerEmail: client.email,
      customerName: client.legalName ?? client.fullName,
      customerPhone: "not collected",
      serviceDetails: `${contract.job.title}: a remote service paid through King Domain and delivered in the app. The client approved it. Full record attached.`,
      deliveryAddress: [client.addressLine, client.addressCity, client.addressState].filter(Boolean).join(", ") || undefined,
      deliveryDate: contract.transferredAt ? contract.transferredAt.toISOString().slice(0, 10) : undefined,
    });
    await paystack.resolveChargeback(chargeback.paystackDisputeId, { resolution: "declined", message: note?.trim() || "The service was delivered and approved. Receipt and record attached.", uploadedFilename: upload.fileName });
  } catch (err) {
    console.error(`chargeback: response FAILED id=${chargeback.paystackDisputeId}: ${err.message}`);
    return { ok: false, status: 502, code: "paystack_error", error: err.message || "Paystack didn't take the answer. Try again before it is due." };
  }
  const updated = await prisma.chargeback.update({ where: { id: chargeback.id }, data: { status: "responded", respondedAt: new Date(), respondedById: adminId, responseNote: note ?? null } });
  console.log(`chargeback: responded id=${chargeback.paystackDisputeId} by=${adminId} readBack.status=${updated.status}`);
  return { ok: true, chargeback: updated };
}

/** The team decides not to contest it. */
async function accept({ chargebackId, adminId, note }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const paystack = deps.paystack ?? realPaystack;
  const cb = await prisma.chargeback.findUnique({ where: { id: chargebackId } });
  if (!cb) return { ok: false, status: 404, code: "not_found", error: "Chargeback not found." };
  if (cb.status !== "open") return { ok: false, status: 409, code: "not_open", error: "This chargeback was already answered." };
  try {
    await paystack.resolveChargeback(cb.paystackDisputeId, { resolution: "merchant-accepted", message: note?.trim() || "Accepted." });
  } catch (err) {
    return { ok: false, status: 502, code: "paystack_error", error: err.message || "Paystack didn't take the answer." };
  }
  const updated = await prisma.chargeback.update({ where: { id: cb.id }, data: { status: "lost", respondedAt: new Date(), respondedById: adminId, resolution: "merchant-accepted", responseNote: note ?? null } });
  const contract = cb.contractId ? await prisma.contract.findUnique({ where: { id: cb.contractId }, include: { job: true } }) : null;
  if (contract) await removeClientAfterLoss(prisma, contract, updated, deps);
  return { ok: true, chargeback: updated };
}

module.exports = { receive, evidenceFor, respond, accept, receiptPdf, addWeekdayHours, HOURS_TO_ANSWER, removeClientAfterLoss };
