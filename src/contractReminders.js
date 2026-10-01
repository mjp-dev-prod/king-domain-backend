// The reminder schedule (docs/features/stage-2-delivery-and-changes.md in the
// mobile repo). Every clock whose silence has a default outcome warns the
// person whose silence triggers it. A reminder is a ContractReminder row
// inserted BEFORE the email goes out (unique per contract + key), so restarts
// and overlapping ticks can't send it twice; a send that fails removes its
// row so the next tick retries it. Keys include the deadline itself, so a
// deadline that moves (an extension) gets fresh reminders.
const { HOUR, RULES, autoReleaseEnabled, baseDeps, parties } = require("./contractCore");

/**
 * `before`: how long before the deadline each reminder goes, largest first.
 * `at`: also remind at the deadline itself, for `atWindowMs` afterwards.
 */
const SCHEDULE = [
  { clock: "extension", to: "client", before: [24 * HOUR, 6 * HOUR] },
  { clock: "review", to: "client", before: [24 * HOUR, 6 * HOUR] },
  { clock: "change", to: "talent", before: [24 * HOUR, 6 * HOUR] },
  { clock: "delivery", to: "talent", before: [24 * HOUR], at: true, atWindowMs: RULES.overdueGraceMs },
  { clock: "deliveryMissed", to: "client", before: [], at: true, atWindowMs: RULES.overdueGraceMs },
];

// The furthest ahead any reminder looks; deadlines beyond it are skipped.
const HORIZON_MS = 24 * HOUR;

/**
 * The label of the reminder that applies now, or null. A reminder only
 * applies until the next one does: after downtime nobody gets "24 hours
 * left" with 3 hours left.
 */
function currentReminder(entry, due, at) {
  const t = at.getTime();
  const d = due.getTime();
  const points = entry.before.map((ms) => ({ label: `${ms / HOUR}h`, from: d - ms }));
  if (entry.at) points.push({ label: "due", from: d, until: d + entry.atWindowMs });
  for (let i = 0; i < points.length; i++) {
    const until = points[i].until ?? (points[i + 1] ? points[i + 1].from : d);
    if (t >= points[i].from && t < until) return points[i].label;
  }
  return null;
}

async function sendOnce(prisma, { contractId, key }, send) {
  try {
    await prisma.contractReminder.create({ data: { contractId, key } });
  } catch (err) {
    if (err.code === "P2002") return "already_sent";
    throw err;
  }
  const result = await send().catch((err) => ({ sent: false, error: err }));
  if (result?.error) {
    await prisma.contractReminder.deleteMany({ where: { contractId, key } });
    console.error(`reminders: send failed key=${key} contract=${contractId}, will retry: ${result.error.message ?? result.error}`);
    return "failed";
  }
  return "sent";
}

/** Every deadline that could need a reminder now, as {clock, contract, due, ref}. */
async function candidates(prisma, at, autoRelease) {
  const horizon = new Date(at.getTime() + HORIZON_MS);
  const list = [];

  const asking = await prisma.contract.findMany({
    where: { extensions: { some: { status: "pending", answerDueAt: { lte: horizon } } } },
    include: { job: true, extensions: { where: { status: "pending" } } },
  });
  for (const c of asking) for (const e of c.extensions) list.push({ clock: "extension", contract: c, due: e.answerDueAt, ref: e.id });

  // Review silence only means something while auto-release is on.
  if (autoRelease) {
    const reviewing = await prisma.contract.findMany({ where: { status: "submitted", reviewDueAt: { lte: horizon } }, include: { job: true } });
    for (const c of reviewing) list.push({ clock: "review", contract: c, due: c.reviewDueAt, ref: c.reviewDueAt.toISOString() });
  }

  const resubmitting = await prisma.contract.findMany({ where: { status: "changesRequested", changeDueAt: { lte: horizon } }, include: { job: true } });
  for (const c of resubmitting) list.push({ clock: "change", contract: c, due: c.changeDueAt, ref: `round${c.changeRounds}` });

  const working = await prisma.contract.findMany({
    where: { status: { in: ["funded", "inProgress"] }, overdueFlaggedAt: null, deliverByAt: { lte: horizon } },
    include: { job: true },
  });
  for (const c of working) {
    list.push({ clock: "delivery", contract: c, due: c.deliverByAt, ref: c.deliverByAt.toISOString() });
    list.push({ clock: "deliveryMissed", contract: c, due: c.deliverByAt, ref: c.deliverByAt.toISOString() });
  }
  return list;
}

const KIND = { extension: "extension", review: "review", change: "change", delivery: "delivery" };
const PASSED_KIND = { delivery: "deliveryPassed", deliveryMissed: "deliveryMissedPassed" };

async function sweepReminders(deps = {}) {
  const { prisma, mailer, now } = baseDeps(deps);
  const autoRelease = deps.autoRelease ?? autoReleaseEnabled();
  const at = now();
  let reminded = 0;
  for (const cand of await candidates(prisma, at, autoRelease)) {
    const entry = SCHEDULE.find((s) => s.clock === cand.clock);
    const label = currentReminder(entry, cand.due, at);
    if (!label) continue;
    const { client, talent } = await parties(prisma, cand.contract);
    const person = entry.to === "client" ? client : talent;
    if (!person) continue;
    const key = `${cand.clock}:${cand.ref}:${label}`;
    const kind = label === "due" ? PASSED_KIND[cand.clock] : KIND[cand.clock];
    const outcome = await sendOnce(prisma, { contractId: cand.contract.id, key }, () =>
      mailer.sendClockReminder({ to: person.email, kind, jobTitle: cand.contract.job.title, dueAt: cand.due }),
    );
    if (outcome === "sent") {
      reminded++;
      console.log(`reminders: sent key=${key} contract=${cand.contract.id} to=${entry.to} due=${cand.due.toISOString()} now=${at.toISOString()}`);
    }
  }
  return { reminded };
}

module.exports = { SCHEDULE, currentReminder, sendOnce, sweepReminders };
