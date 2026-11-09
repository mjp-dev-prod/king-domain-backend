// Alerts to the team (PRD §4.11, decisions D45 and D46). Urgent alerts go out at once to Slack
// (phones get them through the Slack app) and by email to whoever is on call, or to the owners
// when nobody is. Digest alerts wait for one daily message. Each row records what was actually
// sent (read back from Slack's answer and the mailer's result), not what was attempted.

const { prisma: defaultDb } = require("./db");
const mailer = require("./admin/mailer");
const { QUEUES, inboxFor } = require("./admin/inbox");

const SEVERITIES = ["urgent", "digest"];
const DIGEST_HOUR_LAGOS = 8; // 08:00 Africa/Lagos (UTC+1, no daylight saving)

function defaults(deps = {}) {
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    mailer: deps.mailer ?? mailer,
    webhookUrl: deps.webhookUrl ?? process.env.OPS_SLACK_WEBHOOK_URL ?? "",
    dashboardUrl: deps.dashboardUrl ?? process.env.ADMIN_DASHBOARD_URL ?? process.env.ADMIN_APP_URL ?? "",
    now: deps.now ?? new Date(),
  };
}

async function onCallNow(db, at = new Date()) {
  const shifts = await db.onCallShift.findMany({
    where: { startsAt: { lte: at }, endsAt: { gt: at }, admin: { status: "active" } },
    include: { admin: true },
  });
  return shifts.map((s) => s.admin);
}

async function postSlack(d, text) {
  if (!d.webhookUrl) return false;
  try {
    const r = await d.fetchImpl(d.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return r.ok;
  } catch (err) {
    console.error("alerts: slack post failed:", err.message);
    return false;
  }
}

const fullLink = (d, link) => (link ? `${d.dashboardUrl}${link}` : null);

/**
 * `to` names who gets the email (the people who can do this work); without it an urgent alert goes to whoever is on
 * call, or to the owners when nobody is.
 */
async function raiseAlert(db, { severity, queueKey, title, body, link = null, to = null }, deps) {
  if (!SEVERITIES.includes(severity)) throw new Error(`Unknown alert severity "${severity}".`);
  const d = defaults(deps);
  const row = await db.opsAlert.create({ data: { severity, queueKey, title, body, link } });
  if (severity === "digest") {
    console.log(`alerts: digest queued queue=${queueKey} alert=${row.id}`);
    return row;
  }

  const url = fullLink(d, link);
  const slackSent = await postSlack(d, `:rotating_light: *${title}*\n${body}${url ? `\n${url}` : ""}`);

  let recipients = to?.length ? to : await onCallNow(db, d.now);
  const reason = to?.length ? "named" : recipients.length ? "on-call" : "no-one-on-call:owners";
  if (!recipients.length) recipients = await db.adminUser.findMany({ where: { role: "owner", status: "active" } });
  const emailedTo = [];
  for (const admin of recipients) {
    const result = await d.mailer.sendOpsAlert({ to: admin.email, title, body, link: url });
    if (result?.sent) emailedTo.push(admin.email);
  }

  const back = await db.opsAlert.update({ where: { id: row.id }, data: { slackSent, emailedTo } });
  console.log(`alerts: urgent queue=${queueKey} alert=${back.id} slackSent=${back.slackSent} emailed=${back.emailedTo.length}/${recipients.length} via=${reason}`);
  return back;
}

async function sendDigest(db, deps) {
  const d = defaults(deps);
  const due = await db.opsAlert.findMany({ where: { severity: "digest", digestedAt: null }, orderBy: { createdAt: "asc" } });
  if (!due.length) return { sent: 0 };
  const lines = due.map((a) => `• *${a.title}*: ${a.body}${a.link ? ` ${fullLink(d, a.link)}` : ""}`);
  const slackSent = await postSlack(d, `*King Domain daily digest*\n${lines.join("\n")}`);
  const owners = await db.adminUser.findMany({ where: { role: "owner", status: "active" } });
  for (const o of owners) {
    await d.mailer.sendOpsAlert({ to: o.email, title: "Daily digest", body: due.map((a) => `${a.title}: ${a.body}`).join("\n"), link: fullLink(d, "/inbox") });
  }
  const marked = await db.opsAlert.updateMany({ where: { id: { in: due.map((a) => a.id) }, digestedAt: null }, data: { digestedAt: d.now } });
  console.log(`alerts: digest items=${due.length} marked=${marked.count} slackSent=${slackSent} owners=${owners.length}`);
  return { sent: marked.count };
}

/** One digest alert per queue per day while the queue has overdue items. */
async function sweepOverdue(db, now = new Date()) {
  const owner = { role: "owner", capabilities: [] }; // sees every queue
  const queues = await inboxFor(db, owner, now);
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  let raised = 0;
  for (const q of queues.filter((q) => q.overdue > 0)) {
    const already = await db.opsAlert.findFirst({ where: { queueKey: q.key, severity: "digest", createdAt: { gte: dayStart } } });
    if (already) continue;
    await raiseAlert(db, {
      severity: "digest",
      queueKey: q.key,
      title: `${q.overdue} in ${q.label} past target`,
      body: `Oldest has waited ${Math.round(q.oldestWaitingMinutes / 60)} h; target ${Math.round(q.targetMinutes / 60)} h.`,
      link: q.path,
    });
    raised++;
  }
  return raised;
}

function lagosHour(date) {
  return (date.getUTCHours() + 1) % 24;
}

/** Every interval: sweep overdue queues; once a day at 08:00 Lagos, send the digest. */
function startOpsScheduler({ intervalMs = 15 * 60 * 1000 } = {}) {
  if (process.env.OPS_SCHEDULER === "off") {
    console.log("alerts: ops scheduler off");
    return null;
  }
  const tick = async () => {
    try {
      await sweepOverdue(defaultDb);
      await require("./skillNotices").sweepWaiting(defaultDb);
      if (lagosHour(new Date()) === DIGEST_HOUR_LAGOS) await sendDigest(defaultDb);
    } catch (err) {
      console.error("alerts: ops tick failed:", err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`alerts: ops scheduler running every ${Math.round(intervalMs / 60000)} min; queues=${QUEUES.map((q) => q.key).join(",")}`);
  return timer;
}

module.exports = { SEVERITIES, onCallNow, raiseAlert, sendDigest, sweepOverdue, startOpsScheduler, lagosHour };
