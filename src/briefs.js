// The structured brief and the four job types (PRD §4.1; decision D1). The brief is part of the protection:
// a review and a dispute are later judged against what it says (job-types research §5).
//
// What `budget` means on a Job, per type (so S5 can fund each unit):
//   oneDelivery : the whole price.
//   milestones  : the sum of the milestone amounts.
//   monthly     : the price of ONE month (the brief says how many months).
//   hourly      : the weekly cap, hourlyRate x weeklyCapHours (the brief holds both).

const { skillByKey } = require("./skills");

const JOB_TYPES = ["oneDelivery", "milestones", "monthly", "hourly"];
const CURRENCIES = ["NGN", "USD"];
const USAGE_RIGHTS = ["none", "organic", "paid30", "paid90", "fullOnPayment"];
const VISIBILITY = ["public", "invite"];

const LIMITS = { milestones: { min: 2, max: 5 }, months: { min: 1, max: 6 }, weeks: { min: 1, max: 12 }, weeklyHours: { min: 1, max: 40 }, screeningQuestions: 3, text: 600, short: 120 };

const text = (key, label, { required = true, max = LIMITS.text } = {}) => ({ key, label, kind: "text", required, max });
const int = (key, label, { required = true, min = 1, max = 100000 } = {}) => ({ key, label, kind: "int", required, min, max });
const choice = (key, label, options, { required = true } = {}) => ({ key, label, kind: "choice", required, options });

/** The fields every brief has, whatever the skill. */
const COMMON = [
  text("deliverables", "What you want delivered"),
  int("quantity", "How many", { max: 1000 }),
  text("formats", "Formats or sizes", { max: LIMITS.short }),
  int("revisionsIncluded", "Rounds of changes included", { min: 0, max: 2 }),
  choice("usageRights", "What the talent's work may be used for", USAGE_RIGHTS),
  text("clientFiles", "Files or material you will provide", { required: false }),
  text("references", "Examples you like", { required: false }),
];

/** The fields that belong to one skill (PRD §4.1). */
const BY_SKILL = {
  "graphic-design": [text("dimensions", "Dimensions", { max: LIMITS.short }), text("brandNotes", "Brand colours, fonts, tone", { required: false })],
  "short-form-video": [
    int("durationSeconds", "Length of each video (seconds)", { max: 600 }),
    choice("aspectRatio", "Shape", ["9:16", "1:1", "16:9", "4:5"]),
    text("rawFootage", "Where the footage is", { max: LIMITS.short }),
  ],
  "social-media": [
    text("platforms", "Platforms", { max: LIMITS.short }),
    int("postsPerWeek", "Posts per week", { max: 50 }),
    text("brandVoice", "How the brand sounds", { required: false }),
  ],
  writing: [int("wordCount", "Words per piece", { max: 50000 }), text("tone", "Tone and reader", { max: LIMITS.short }), text("sources", "Research or sources to use", { required: false })],
  "web-development": [int("pages", "Number of pages or screens", { max: 200 }), text("stack", "Technology, if you care", { required: false, max: LIMITS.short }), text("designFiles", "Design files or a reference site", { required: false })],
};

/** What this skill and type ask the client, for the post-a-job screen. */
function briefSpec(skillKey, jobType) {
  const skill = skillByKey(skillKey);
  if (!skill || !JOB_TYPES.includes(jobType)) return null;
  const perType = {
    oneDelivery: [],
    milestones: [{ key: "milestones", label: "The milestones", kind: "milestones", required: true, ...LIMITS.milestones }],
    monthly: [int("months", "How many months", { min: LIMITS.months.min, max: LIMITS.months.max }), text("monthlyScope", "What is delivered each month")],
    hourly: [
      int("hourlyRate", "Rate per hour", { max: 10_000_000 }),
      int("weeklyCapHours", "Most hours per week", { min: LIMITS.weeklyHours.min, max: LIMITS.weeklyHours.max }),
      int("weeks", "How many weeks", { min: LIMITS.weeks.min, max: LIMITS.weeks.max }),
    ],
  }[jobType];
  return { skillKey, jobType, fields: [...COMMON, ...(BY_SKILL[skillKey] ?? []), ...perType] };
}

function cleanField(f, raw) {
  const v = raw;
  if (f.kind === "text") {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return f.required ? { error: `${f.label}: fill this in.` } : { value: "" };
    if (s.length > f.max) return { error: `${f.label}: keep it under ${f.max} characters.` };
    return { value: s };
  }
  if (f.kind === "int") {
    if (v === undefined || v === null || v === "") return f.required ? { error: `${f.label}: fill this in.` } : { value: null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < f.min || n > f.max) return { error: `${f.label}: a whole number from ${f.min} to ${f.max}.` };
    return { value: n };
  }
  if (f.kind === "choice") {
    if (!f.options.includes(v)) return f.required ? { error: `${f.label}: choose one.` } : { value: null };
    return { value: v };
  }
  return { error: `${f.label}: not understood.` };
}

/**
 * Checks a brief against its spec. Returns { ok, brief, budget } with the price the type implies, or { ok:false, error, field }.
 * `price` is what the client typed for oneDelivery and monthly (the monthly price); milestones and hourly derive it.
 */
function validateBrief({ skillKey, jobType, brief, price }) {
  const spec = briefSpec(skillKey, jobType);
  if (!spec) return { ok: false, error: "Choose a skill and a job type from the lists." };
  const raw = brief && typeof brief === "object" ? brief : {};
  const out = {};
  for (const f of spec.fields) {
    if (f.kind === "milestones") continue;
    const r = cleanField(f, raw[f.key]);
    if (r.error) return { ok: false, error: r.error, field: f.key };
    out[f.key] = r.value;
  }

  let budget;
  if (jobType === "milestones") {
    const list = Array.isArray(raw.milestones) ? raw.milestones : [];
    if (list.length < LIMITS.milestones.min || list.length > LIMITS.milestones.max) return { ok: false, error: `A milestone job has ${LIMITS.milestones.min} to ${LIMITS.milestones.max} milestones.`, field: "milestones" };
    const clean = [];
    for (const m of list) {
      const title = typeof m?.title === "string" ? m.title.trim() : "";
      const amount = Number(m?.amount);
      const days = Number(m?.days);
      if (!title || title.length > LIMITS.short) return { ok: false, error: "Each milestone needs a title.", field: "milestones" };
      if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: `Milestone "${title}": the amount must be more than zero.`, field: "milestones" };
      if (!Number.isInteger(days) || days < 1 || days > 60) return { ok: false, error: `Milestone "${title}": delivery is 1 to 60 days.`, field: "milestones" };
      clean.push({ title, amount, days });
    }
    out.milestones = clean;
    budget = clean.reduce((sum, m) => sum + m.amount, 0);
  } else if (jobType === "hourly") {
    budget = out.hourlyRate * out.weeklyCapHours;
  } else {
    budget = Number(price);
    if (!Number.isFinite(budget) || budget <= 0) return { ok: false, error: "The price must be more than zero.", field: "price" };
  }
  return { ok: true, brief: out, budget };
}

/** Up to three short questions the client wants every applicant to answer. */
function validateScreeningQuestions(list) {
  if (list === undefined || list === null) return { ok: true, questions: [] };
  if (!Array.isArray(list) || list.length > LIMITS.screeningQuestions) return { ok: false, error: `At most ${LIMITS.screeningQuestions} screening questions.` };
  const questions = [];
  for (const q of list) {
    const s = typeof q === "string" ? q.trim() : "";
    if (s.length < 5 || s.length > 200) return { ok: false, error: "Each screening question is 5 to 200 characters." };
    questions.push(s);
  }
  return { ok: true, questions };
}

module.exports = { JOB_TYPES, CURRENCIES, USAGE_RIGHTS, VISIBILITY, LIMITS, briefSpec, validateBrief, validateScreeningQuestions };
