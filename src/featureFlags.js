// What can be paid for today. A job type or a currency whose money flow is not built yet is refused when it is
// posted and when it is awarded, so no money is ever handled by rules written for something else.
// (Milestones, monthly and hourly work each fund and release per unit; dollar jobs need card funding in dollars
// and payouts at the day's rate. Both are named in the S5 handoff as not built.)

const ALL_TYPES = ["oneDelivery", "milestones", "monthly", "hourly"];

function enabledJobTypes() {
  const raw = process.env.JOB_TYPES_ENABLED;
  if (!raw) return ["oneDelivery"];
  return raw.split(",").map((t) => t.trim()).filter((t) => ALL_TYPES.includes(t));
}

const usdEnabled = () => process.env.USD_JOBS_ENABLED === "true";

/** The reason a job can't be posted or awarded yet, or null when its money flow exists. */
function unavailableReason({ jobType, currency }) {
  if (!enabledJobTypes().includes(jobType ?? "oneDelivery")) {
    return { code: "type_not_available", error: "This kind of job can't be paid for yet: we're still building how each milestone, month or week is held and released. Post it as one delivery for now." };
  }
  if ((currency ?? "NGN") === "USD" && !usdEnabled()) {
    return { code: "usd_not_available", error: "Dollar jobs can't be paid for yet: paying by card in dollars and paying talents in naira at the day's rate aren't switched on. Price it in naira for now." };
  }
  return null;
}

function availability() {
  return { jobTypes: Object.fromEntries(ALL_TYPES.map((t) => [t, enabledJobTypes().includes(t)])), usd: usdEnabled() };
}

module.exports = { ALL_TYPES, enabledJobTypes, usdEnabled, unavailableReason, availability };
