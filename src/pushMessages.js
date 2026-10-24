// What each push says. Pure functions: an event (or a reminder) in, who gets what out. Short, plain and
// about one job; no amounts and no nudging. Table of every message: docs/features/push-notifications.md.

const MAX_TITLE = 60;

const q = (title) => {
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  return `"${t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t}"`;
};

const note = (userId, type, jobId, title, body) => (userId ? [{ userId, title, body, data: { type, jobId } }] : []);

/**
 * The pushes for one ContractEvent. `ctx` is { job: {id, title}, clientId, talentId } (either person can be
 * missing, and then gets nothing). Event types that nobody needs on their phone return an empty list.
 */
function forEvent(event, { job, clientId, talentId }) {
  const t = q(job.title);
  const both = (type, forClient, forTalent) => [
    ...note(clientId, type, job.id, forClient[0], forClient[1]),
    ...note(talentId, type, job.id, forTalent[0], forTalent[1]),
  ];
  const type = event.type;
  switch (type) {
    case "awarded":
      return note(talentId, type, job.id, "You were picked", `The client picked you for ${t}. Work starts when they pay.`);
    case "funded":
      return note(talentId, type, job.id, "Payment received", `${t} is paid for. You can start work now.`);
    case "submitted":
      return note(clientId, type, job.id, "Work delivered", `${t} was delivered. Review it within 3 days.`);
    case "resubmitted":
      return note(clientId, type, job.id, "Work updated", `${t} was resubmitted. Take a look.`);
    case "changes_requested":
      return note(talentId, type, job.id, "Changes requested", `The client asked for changes to ${t}.`);
    case "extension_requested":
      return note(clientId, type, job.id, "More time requested", `The talent asked for more time on ${t}. Please answer within 48 hours.`);
    case "extension_granted":
      return note(talentId, type, job.id, "More time granted", `You have more time on ${t}.`);
    case "extension_declined":
      return note(talentId, type, job.id, "Extension declined", `The client said no to more time on ${t}.`);
    case "extension_auto_granted":
      return both(
        type,
        ["Extension granted automatically", `You didn't answer in time, so the talent got more time on ${t}.`],
        ["More time granted", `The client didn't answer in time, so you have more time on ${t}.`],
      );
    case "released": {
      const talent = note(talentId, type, job.id, "You've been paid", `Your payout for ${t} has been sent.`);
      const auto = event.meta?.trigger === "auto_release";
      return auto ? [...note(clientId, type, job.id, "Payment released", `The review window for ${t} passed, so payment was released.`), ...talent] : talent;
    }
    case "award_voided":
      return both(
        type,
        ["Award cancelled", `${t} was cancelled because payment wasn't made in time. You can pick someone again.`],
        ["Award cancelled", `${t} was cancelled because the client didn't pay in time.`],
      );
    case "overdue":
      return both(
        type,
        ["Delivery is late", `The delivery date for ${t} has passed and nothing has been delivered.`],
        ["Delivery is late", `${t} was due and nothing has been delivered yet.`],
      );
    case "escalated":
      return both(
        type,
        ["Sent to our team", `${t} has been passed to our team to resolve.`],
        ["Sent to our team", `${t} has been passed to our team to resolve.`],
      );
    default:
      return [];
  }
}

const REMINDERS = {
  extension: ["Answer an extension request", (t) => `A talent is waiting for your answer on ${t}.`],
  review: ["Review due soon", (t) => `Review ${t} before it is paid out automatically.`],
  change: ["Changes due soon", (t) => `Resubmit ${t} before the deadline.`],
  delivery: ["Delivery due soon", (t) => `${t} is due soon.`],
  deliveryPassed: ["Delivery date passed", (t) => `${t} was due. Deliver it, or ask for more time.`],
  deliveryMissedPassed: ["Delivery is late", (t) => `The delivery date for ${t} has passed and nothing has been delivered.`],
};

/** The push that goes with a clock reminder email (same kinds as mailer.sendClockReminder). */
function reminderMessage({ kind, jobTitle, jobId }) {
  const [title, body] = REMINDERS[kind];
  return { title, body: body(q(jobTitle)), data: { type: `reminder_${kind}`, jobId } };
}

module.exports = { forEvent, reminderMessage };
