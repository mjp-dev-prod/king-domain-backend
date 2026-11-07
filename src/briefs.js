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

const opt = (o) => ({ ...(o.hint ? { hint: o.hint } : {}), ...(o.scope ? { scope: true } : {}) });
const text = (key, label, { required = true, max = LIMITS.text, ...o } = {}) => ({ key, label, kind: "text", required, max, ...opt(o) });
const int = (key, label, { required = true, min = 1, max = 100000, ...o } = {}) => ({ key, label, kind: "int", required, min, max, ...opt(o) });
const choice = (key, label, options, { required = true, ...o } = {}) => ({ key, label, kind: "choice", required, options, ...opt(o) });
/** Pick any number of the options; `required` means at least one. */
const choices = (key, label, options, { required = true, ...o } = {}) => ({ key, label, kind: "choices", required, options, ...opt(o) });
/** A yes or no that must be answered either way, so the brief never leaves it unsaid. */
const yesno = (key, label, o = {}) => ({ key, label, kind: "yesno", required: true, ...opt(o) });
/** A fixed term of the job, shown on the form and written into the brief as it stands (not a question). */
const note = (key, label, value) => ({ key, label, kind: "note", required: false, text: value });

// The brief used to open with seven questions for every skill, written for a designer: "How many", "Formats or sizes"
// and ad-campaign usage rights meant nothing for a website (Victor, 2026-11-07). Only these four hold for every skill;
// everything else belongs to the skill, modelled on how each trade scopes its own work (job-briefs research).
//
// `scope: true` marks what a ready-made package answers itself (what is in it); the client fills in the rest.

/** Asked first, whatever the skill. */
const OPENING = [text("deliverables", "What you want done", { hint: "In a sentence or two: what should exist when the job is done." })];

/** Asked last, whatever the skill. Rounds of changes are capped at 2 by the payment rules. */
const CLOSING = [
  int("revisionsIncluded", "Rounds of changes included", { min: 0, max: 2 }),
  text("clientFiles", "Files, logins or material you will provide", { required: false }),
  text("references", "Examples you like", { required: false }),
];

const BY_SKILL = {
  "graphic-design": [
    choice("designKind", "What kind of design", ["Logo or brand identity", "Flyer or poster", "Social media graphics", "Packaging or label", "Something else"], { scope: true }),
    int("quantity", "How many designs", { max: 100, scope: true }),
    text("dimensions", "Size, or where it will be used", { max: LIMITS.short, hint: "For example: A4 flyer, Instagram post, a shop sign." }),
    int("concepts", "First ideas to choose from", { required: false, max: 5, scope: true, hint: "For a logo, usually 2 or 3." }),
    choices("files", "Files you get", ["Print-ready PDF", "Transparent PNG", "JPG", "Editable source file"], { scope: true }),
    text("brandNotes", "Brand colours, fonts, tone", { required: false }),
    choice("usageRights", "What the design may be used for", USAGE_RIGHTS),
  ],
  "short-form-video": [
    int("quantity", "How many videos", { max: 100, scope: true }),
    int("durationSeconds", "Length of each video (seconds)", { max: 600, scope: true }),
    choice("aspectRatio", "Shape", ["9:16", "1:1", "16:9", "4:5"]),
    text("rawFootage", "Where the footage is", { max: LIMITS.short }),
    choices("extras", "Included", ["Captions", "Music", "Colour grading", "Text and motion graphics", "Sound clean-up"], { required: false, scope: true }),
    yesno("projectFile", "Editable project file included", { scope: true }),
    choice("usageRights", "What the videos may be used for", USAGE_RIGHTS),
  ],
  "social-media": [
    choices("platforms", "Platforms", ["Instagram", "TikTok", "Facebook", "X", "LinkedIn", "YouTube"], { scope: true }),
    int("postsPerWeek", "Posts per week", { max: 50, scope: true }),
    choice("contentBy", "Who makes the posts", ["The talent designs and writes them", "I send the content, the talent posts it", "A mix of both"], { scope: true }),
    yesno("postsForYou", "The talent posts for you (they will need access to the accounts)", { scope: true }),
    yesno("replies", "Replying to comments and messages", { scope: true }),
    yesno("report", "A report at the end of each month", { scope: true }),
    text("brandVoice", "How the brand sounds", { required: false }),
  ],
  writing: [
    choice("writingKind", "What kind of writing", ["Blog post or article", "Website copy", "Product descriptions", "Script", "Something else"], { scope: true }),
    int("quantity", "How many pieces", { max: 200, scope: true }),
    int("wordCount", "Words per piece", { max: 50000, scope: true }),
    text("tone", "Tone and reader", { max: LIMITS.short }),
    text("keywords", "Keywords to include", { required: false, max: LIMITS.short }),
    text("sources", "Research or sources to use", { required: false }),
    choice("byline", "Whose name goes on it", ["Mine: written for me, no credit to the talent", "The talent's name"]),
    choice("deliveredAs", "Delivered as", ["Google Doc", "Word file", "Put straight into my website"]),
  ],
  "web-development": [
    choice("siteKind", "What you need", ["A new website", "Changes to a website I have", "A landing page", "An online shop", "A web app"], { scope: true }),
    int("pages", "How many pages or screens", { max: 200, scope: true }),
    text("pageList", "Which pages, if you know", { required: false, max: LIMITS.short, hint: "For example: Home, About, Services, Contact." }),
    choices("features", "Features", ["Contact form", "Booking", "Online payments", "Shop", "Blog", "Logins for users", "WhatsApp button"], { required: false, scope: true }),
    int("products", "Products to add, for a shop", { required: false, max: 10000, scope: true }),
    choice("builtWith", "Built with", ["WordPress", "Wix", "Shopify", "Custom code", "The talent recommends"], { scope: true }),
    choice("contentBy", "Who supplies the words and pictures", ["I do", "The talent writes them", "A mix"]),
    choice("hosting", "Domain and hosting", ["I have them", "Set them up in my name", "Not needed yet"]),
    text("designFiles", "Design files or a site you like", { required: false }),
    note("handover", "At the end you get", "The admin login, the code and every account (domain, hosting) in your name."),
  ],
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
  return { skillKey, jobType, fields: [...OPENING, ...(BY_SKILL[skillKey] ?? []), ...CLOSING, ...perType] };
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
  if (f.kind === "choices") {
    const list = v === undefined || v === null ? [] : v;
    if (!Array.isArray(list) || list.some((x) => !f.options.includes(x))) return { error: `${f.label}: choose from the list.` };
    const picked = f.options.filter((o) => list.includes(o));
    if (!picked.length && f.required) return { error: `${f.label}: choose at least one.` };
    return { value: picked };
  }
  if (f.kind === "yesno") {
    if (typeof v !== "boolean") return { error: `${f.label}: answer yes or no.` };
    return { value: v };
  }
  if (f.kind === "note") return { value: f.text };
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

/** Words for the usage-rights codes, the same the app shows. */
const USAGE_RIGHTS_LABELS = {
  none: "No use beyond me looking at it",
  organic: "Posting on my own pages",
  paid30: "Paid ads for 30 days",
  paid90: "Paid ads for 90 days",
  fullOnPayment: "Everything, once I have paid in full",
};

// Keys from briefs written before 2026-11-07, so an old job still reads in words.
const OLD_LABELS = { quantity: "How many", formats: "Formats or sizes", usageRights: "What the work may be used for", stack: "Technology", platforms: "Platforms", clientFiles: "Files or material provided", deliverables: "What was wanted" };

function wordsFor(key, v) {
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (key === "usageRights") return USAGE_RIGHTS_LABELS[v] ?? String(v);
  return String(v);
}

/**
 * A brief as labelled lines, in the order the form asked, for anyone reading it (the team's queues, disputes).
 * Milestones are left out: they are money and dates, shown on their own.
 */
function describe(skillKey, jobType, brief) {
  const b = brief && typeof brief === "object" ? brief : {};
  const spec = briefSpec(skillKey, jobType) ?? briefSpec(skillKey, "oneDelivery");
  const lines = [];
  const seen = new Set(["milestones"]);
  const empty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  for (const f of spec?.fields ?? []) {
    seen.add(f.key);
    if (f.kind === "milestones" || empty(b[f.key])) continue;
    lines.push({ key: f.key, label: f.label, value: wordsFor(f.key, b[f.key]) });
  }
  for (const [k, v] of Object.entries(b)) {
    if (seen.has(k) || empty(v) || (typeof v === "object" && !Array.isArray(v))) continue;
    lines.push({ key: k, label: OLD_LABELS[k] ?? k, value: wordsFor(k, v) });
  }
  return lines;
}

/** What a ready-made package in this skill states about itself (the rest is the client's to fill in). */
function packageFields(skillKey) {
  return (BY_SKILL[skillKey] ?? []).filter((f) => f.scope);
}

/** Checks a package's own answers against its skill. Returns { ok, scope } or { ok:false, error, field }. */
function validatePackageScope(skillKey, raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const f of packageFields(skillKey)) {
    const c = cleanField(f, r[f.key]);
    if (c.error) return { ok: false, error: c.error, field: f.key };
    out[f.key] = c.value;
  }
  return { ok: true, scope: out };
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

module.exports = { JOB_TYPES, CURRENCIES, USAGE_RIGHTS, USAGE_RIGHTS_LABELS, VISIBILITY, LIMITS, briefSpec, validateBrief, validateScreeningQuestions, describe, packageFields, validatePackageScope };
