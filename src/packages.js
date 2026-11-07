// Ready-made packages (PRD §4.6; D4). A verified talent publishes up to three tiers per skill, using the skill's standard
// fields so packages compare. A client buys one, fills in the rest of the skill's brief, and the talent has 48 hours to
// accept. Accepting awards the job, and from there it is an ordinary job: pay within 24 hours, start proof, delivery,
// review. Nothing about a package gets around the rules of a job.
const { prisma: realPrisma } = require("./db");
const { CATEGORIES, skillByKey } = require("./skills");
const briefs = require("./briefs");
const safety = require("./safety");
const featureFlags = require("./featureFlags");
const { HOUR } = require("./contractCore");

const TIERS = ["basic", "standard", "premium"];
const ANSWER_MS = 48 * HOUR;
const LIMITS = { title: [3, 80], summary: [10, 400], included: [10, 600], price: [1000, 10_000_000], days: [1, 60], revisions: [0, 2] };

const fail = (status, code, error, field) => ({ ok: false, status, code, error, ...(field ? { field } : {}) });
const categoryLabelOf = (skill) => CATEGORIES.find((c) => c.key === skill.category)?.label ?? skill.category;

async function notify(userId, message) {
  if (!userId) return;
  try {
    await require("./discovery").notify(userId, message);
  } catch {
    // A push is a courtesy.
  }
}

function between(v, [min, max]) {
  return Number.isFinite(v) && v >= min && v <= max;
}

/**
 * Checks what a talent typed into a package: the shared parts, and the skill's own fields (pages and features for a
 * website, platforms and posts for social media). Contact details and outside payment are caught as everywhere before
 * award (D18).
 */
function validatePackage(skillKey, input) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const title = str(input?.title);
  const summary = str(input?.summary);
  const included = str(input?.included);
  const price = Number(input?.price);
  const deliveryDays = Number(input?.deliveryDays);
  const revisions = Number(input?.revisions);
  if (!between(title.length, LIMITS.title)) return fail(400, "invalid", `Give it a title of ${LIMITS.title[0]} to ${LIMITS.title[1]} characters.`, "title");
  if (!between(summary.length, LIMITS.summary)) return fail(400, "invalid", `Say what it is in ${LIMITS.summary[0]} to ${LIMITS.summary[1]} characters.`, "summary");
  if (!between(included.length, LIMITS.included)) return fail(400, "invalid", `List what is included in ${LIMITS.included[0]} to ${LIMITS.included[1]} characters.`, "included");
  if (!between(price, LIMITS.price)) return fail(400, "invalid", `The price is between ₦${LIMITS.price[0].toLocaleString("en-NG")} and ₦${LIMITS.price[1].toLocaleString("en-NG")}.`, "price");
  if (!Number.isInteger(deliveryDays) || !between(deliveryDays, LIMITS.days)) return fail(400, "invalid", "Delivery is 1 to 60 days.", "deliveryDays");
  if (!Number.isInteger(revisions) || !between(revisions, LIMITS.revisions)) return fail(400, "invalid", "Rounds of changes included: 0, 1 or 2.", "revisions");
  const scope = briefs.validatePackageScope(skillKey, input?.scope);
  if (!scope.ok) return fail(400, "invalid", scope.error, scope.field);
  const flags = safety.detectRisk([title, summary, included].join("\n"));
  if (flags.length) return fail(400, "flagged", `Packages can't include contact details, links or payment outside King Domain (${flags.map((f) => f.label.toLowerCase()).join(", ")}).`);
  return { ok: true, value: { title, summary, included, price, deliveryDays, revisions, scope: scope.scope } };
}

/** A package saved before the skill's own fields existed: kept for its talent, hidden from clients until updated. */
const needsUpdate = (p) => !p.scope || typeof p.scope !== "object" || Array.isArray(p.scope);

const shape = (p) => ({
  id: p.id,
  skillKey: p.skillKey,
  skillLabel: skillByKey(p.skillKey)?.label ?? p.skillKey,
  tier: p.tier,
  title: p.title,
  summary: p.summary,
  price: Number(p.price),
  currency: p.currency,
  deliveryDays: p.deliveryDays,
  revisions: p.revisions,
  included: p.included,
  scope: needsUpdate(p) ? {} : p.scope,
  // What the package states, in words, in the order the skill asks it.
  scopeLines: briefs.describe(p.skillKey, "oneDelivery", needsUpdate(p) ? { quantity: p.quantity ?? undefined, formats: p.formats ?? undefined } : p.scope),
  needsUpdate: needsUpdate(p),
  status: p.status,
});

/** A talent's own packages, and the skills they may publish in (those they are verified in). */
async function mine(userId, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const [rows, verified] = await Promise.all([
    prisma.package.findMany({ where: { talentId: userId }, orderBy: [{ skillKey: "asc" }, { createdAt: "asc" }] }),
    prisma.skillSubmission.findMany({ where: { userId, status: "verified" }, select: { skillKey: true } }),
  ]);
  const skills = [...new Set(verified.map((v) => v.skillKey))].filter((k) => skillByKey(k));
  return {
    packages: rows.map(shape),
    skills: skills.map((k) => ({ skillKey: k, label: skillByKey(k).label, fields: briefs.packageFields(k) })),
    tiers: TIERS,
    maxPerSkill: TIERS.length,
  };
}

async function save({ userId, skillKey, tier, input }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  if (!TIERS.includes(tier)) return fail(400, "invalid", "Choose basic, standard or premium.");
  if (!skillByKey(skillKey)) return fail(400, "invalid", "Choose a skill from the list.");
  const verified = await prisma.skillSubmission.findFirst({ where: { userId, skillKey, status: "verified" } });
  if (!verified) return fail(403, "not_verified", "You can publish a package in a skill once you are verified in it.");
  const checked = validatePackage(skillKey, input);
  if (!checked.ok) return checked;
  const row = await prisma.package.upsert({
    where: { talentId_skillKey_tier: { talentId: userId, skillKey, tier } },
    // Saving answers the skill's own fields, so the old "how many" and "formats" are cleared.
    update: { ...checked.value, quantity: null, formats: null },
    create: { talentId: userId, skillKey, tier, ...checked.value },
  });
  console.log(`packages: saved package=${row.id} talent=${userId} skill=${skillKey} tier=${tier} readBack.price=${row.price} readBack.scopeKeys=${Object.keys(row.scope ?? {}).join(",")}`);
  return { ok: true, package: shape(row) };
}

async function setStatus({ userId, id, status }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  if (!["active", "paused"].includes(status)) return fail(400, "invalid", "Active or paused.");
  const done = await prisma.package.updateMany({ where: { id, talentId: userId }, data: { status } });
  return done.count === 1 ? { ok: true } : fail(404, "not_found", "Package not found.");
}

async function remove({ userId, id }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const open = await prisma.packageOrder.count({ where: { packageId: id, status: "requested" } });
  if (open) return fail(409, "has_orders", "Someone has ordered this and is waiting for your answer. Answer them first.");
  const done = await prisma.package.deleteMany({ where: { id, talentId: userId } });
  return done.count === 1 ? { ok: true } : fail(404, "not_found", "Package not found.");
}

const lastActiveBucket = (at, now) => {
  const d = now - new Date(at).getTime();
  return d < 86_400_000 ? "today" : d < 7 * 86_400_000 ? "this_week" : d < 30 * 86_400_000 ? "this_month" : "earlier";
};

/** Browse by skill, recently active first, like talents: no score, no paid place (D23, D38). */
async function browse({ skill, cursor, limit }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = (deps.now ?? new Date()).getTime();
  const take = Math.min(Math.max(Number(limit) || 20, 1), 40);
  const where = { status: "active", ...(skill && skillByKey(skill) ? { skillKey: skill } : {}) };
  const rows = await prisma.package.findMany({ where, take: 300 });
  const talentIds = [...new Set(rows.map((r) => r.talentId))];
  const talents = await prisma.user.findMany({ where: { id: { in: talentIds }, deletedAt: null, role: "talent" }, select: { id: true, fullName: true, photoPath: true, lastActiveAt: true } });
  const verified = await prisma.skillSubmission.findMany({ where: { userId: { in: talentIds }, status: "verified" }, select: { userId: true, skillKey: true } });
  const ok = new Set(verified.map((v) => `${v.userId}|${v.skillKey}`));
  const byId = new Map(talents.map((t) => [t.id, t]));
  const storage = require("./storage");
  const items = rows
    .filter((r) => byId.has(r.talentId) && ok.has(`${r.talentId}|${r.skillKey}`) && !needsUpdate(r))
    .sort((a, b) => new Date(byId.get(b.talentId).lastActiveAt ?? 0) - new Date(byId.get(a.talentId).lastActiveAt ?? 0) || a.id.localeCompare(b.id));
  const start = cursor ? Math.max(0, items.findIndex((i) => i.id === cursor) + 1) : 0;
  const page = items.slice(start, start + take);
  return {
    packages: page.map((r) => ({ ...shape(r), talent: { id: r.talentId, fullName: byId.get(r.talentId).fullName, photoUrl: storage.avatarPublicUrl(byId.get(r.talentId).photoPath), lastActive: lastActiveBucket(byId.get(r.talentId).lastActiveAt ?? 0, now) } })),
    nextCursor: start + take < items.length ? page[page.length - 1].id : null,
  };
}

async function detail({ id }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const row = await prisma.package.findUnique({ where: { id } });
  if (!row || row.status !== "active" || needsUpdate(row)) return null;
  const talent = await prisma.user.findFirst({ where: { id: row.talentId, deletedAt: null, role: "talent" }, select: { id: true, fullName: true, photoPath: true, lastActiveAt: true } });
  if (!talent) return null;
  const spec = briefs.briefSpec(row.skillKey, "oneDelivery");
  // The package already answers what is included, its rounds of changes and its skill's own fields: the client fills in the rest.
  const asked = new Set(["deliverables", "revisionsIncluded", ...briefs.packageFields(row.skillKey).map((f) => f.key)]);
  const reputation = await require("./reputation").talentReputation(talent.id, { prisma });
  return {
    package: shape(row),
    talent: { id: talent.id, fullName: talent.fullName, photoUrl: require("./storage").avatarPublicUrl(talent.photoPath), lastActive: lastActiveBucket(talent.lastActiveAt ?? 0, Date.now()) },
    formFields: (spec?.fields ?? []).filter((f) => !asked.has(f.key) && f.kind !== "milestones"),
    reputation,
    fee: Math.round(Number(row.price) * 0.1 * 100) / 100,
  };
}

/** The client orders. A private job is made for this talent alone, and they have 48 hours to take it. */
async function order({ packageId, clientId, brief, note }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const pkg = await prisma.package.findUnique({ where: { id: packageId } });
  if (!pkg || pkg.status !== "active" || needsUpdate(pkg)) return fail(404, "not_found", "This package isn't available.");
  if (pkg.talentId === clientId) return fail(400, "own_package", "That's your own package.");
  const unavailable = featureFlags.unavailableReason({ jobType: "oneDelivery", currency: pkg.currency });
  if (unavailable) return fail(400, unavailable.code, unavailable.error);
  const stillVerified = await prisma.skillSubmission.findFirst({ where: { userId: pkg.talentId, skillKey: pkg.skillKey, status: "verified" } });
  const talent = await prisma.user.findFirst({ where: { id: pkg.talentId, deletedAt: null } });
  if (!stillVerified || !talent) return fail(404, "not_found", "This package isn't available.");
  const open = await prisma.packageOrder.count({ where: { packageId, clientId, status: "requested" } });
  if (open) return fail(409, "already_ordered", "You already ordered this and are waiting for their answer.");

  const typed = brief && typeof brief === "object" ? brief : {};
  // The package's own answers win over anything typed for the same field: the client is buying what it states.
  const full = { ...typed, ...pkg.scope, deliverables: pkg.included, revisionsIncluded: pkg.revisions };
  const checked = briefs.validateBrief({ skillKey: pkg.skillKey, jobType: "oneDelivery", brief: full, price: Number(pkg.price) });
  if (!checked.ok) return fail(400, "invalid", checked.error, checked.field);
  const noteText = typeof note === "string" ? note.trim().slice(0, 500) : "";
  const flags = safety.detectRisk([noteText, ...Object.values(typed).filter((v) => typeof v === "string")].join("\n"));
  if (flags.length) return fail(400, "flagged", `Keep it inside King Domain: no contact details, links or payment outside (${flags.map((f) => f.label.toLowerCase()).join(", ")}).`);

  const skill = skillByKey(pkg.skillKey);
  const snapshot = shape(pkg);
  const created = await prisma.$transaction(async (trx) => {
    const job = await trx.job.create({
      data: {
        clientId,
        title: pkg.title,
        category: categoryLabelOf(skill),
        description: `${pkg.summary}\n\nIncluded: ${pkg.included}`,
        budget: pkg.price,
        deliveryDays: pkg.deliveryDays,
        jobType: "oneDelivery",
        skillKey: pkg.skillKey,
        brief: checked.brief,
        currency: pkg.currency,
        visibility: "invite",
        postStatus: "live",
        liveAt: now,
      },
    });
    const app = await trx.application.create({ data: { jobId: job.id, talentId: pkg.talentId, status: "pending", answer: `Package order: ${pkg.title}` } });
    const row = await trx.packageOrder.create({
      data: { packageId, clientId, talentId: pkg.talentId, brief: checked.brief, note: noteText, snapshot, jobId: job.id, applicationId: app.id, answerDueAt: new Date(now.getTime() + ANSWER_MS) },
    });
    return { job, order: row };
  });
  await notify(pkg.talentId, { title: "Someone ordered your package", body: `${pkg.title}: answer within 48 hours.`, data: { type: "package_order", jobId: created.job.id } });
  console.log(`packages: ordered order=${created.order.id} package=${packageId} client=${clientId} job=${created.job.id} answerDueAt=${created.order.answerDueAt.toISOString()}`);
  return { ok: true, order: created.order, jobId: created.job.id };
}

async function closeOrderJob(prisma, order, status, at) {
  await prisma.packageOrder.update({ where: { id: order.id }, data: { status, answeredAt: at } });
  if (order.jobId) {
    await prisma.job.update({ where: { id: order.jobId }, data: { closedAt: at } }).catch(() => {});
    if (order.applicationId) await prisma.application.update({ where: { id: order.applicationId }, data: { status: "declined", declinedAt: at } }).catch(() => {});
  }
}

async function accept({ orderId, talentId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const order = await prisma.packageOrder.findUnique({ where: { id: orderId } });
  if (!order || order.talentId !== talentId) return fail(404, "not_found", "Order not found.");
  if (order.status !== "requested") return fail(409, "not_open", "This order was already answered.");
  if (order.answerDueAt <= now) return fail(409, "expired", "The 48 hours to answer have passed.");
  const profile = await prisma.talentProfile.findUnique({ where: { userId: talentId } });
  if (!profile?.paystackRecipientCode) return fail(400, "no_payout_account", "Add the bank account you are paid into before you accept.");
  const awarded = await (deps.awardJob ?? require("./jobs").awardJob)({ jobId: order.jobId, clientId: order.clientId, applicationId: order.applicationId });
  if (awarded?.ok === false) return fail(awarded.status ?? 409, awarded.code ?? "award_failed", awarded.error ?? "Couldn't accept this order.");
  const done = await prisma.packageOrder.updateMany({ where: { id: orderId, status: "requested" }, data: { status: "accepted", answeredAt: now } });
  console.log(`packages: accepted order=${orderId} readBack.status=${(await prisma.packageOrder.findUnique({ where: { id: orderId } })).status} claimed=${done.count}`);
  await notify(order.clientId, { title: "They accepted your order", body: `${order.snapshot?.title ?? "Your package"}: pay within 24 hours to start.`, data: { type: "awarded", jobId: order.jobId } });
  return { ok: true, jobId: order.jobId };
}

async function decline({ orderId, talentId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const order = await prisma.packageOrder.findUnique({ where: { id: orderId } });
  if (!order || order.talentId !== talentId) return fail(404, "not_found", "Order not found.");
  if (order.status !== "requested") return fail(409, "not_open", "This order was already answered.");
  await closeOrderJob(prisma, order, "declined", new Date());
  await notify(order.clientId, { title: "They can't take this one", body: `${order.snapshot?.title ?? "Your order"}: you can look at other packages or post the job.`, data: { type: "package_order", jobId: order.jobId } });
  return { ok: true };
}

async function cancel({ orderId, clientId }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const order = await prisma.packageOrder.findUnique({ where: { id: orderId } });
  if (!order || order.clientId !== clientId) return fail(404, "not_found", "Order not found.");
  if (order.status !== "requested") return fail(409, "not_open", "It's already been answered.");
  await closeOrderJob(prisma, order, "cancelled", new Date());
  await notify(order.talentId, { title: "An order was cancelled", body: order.snapshot?.title ?? "A package order", data: { type: "package_order", jobId: order.jobId } });
  return { ok: true };
}

/** Silence for 48 hours: the order lapses and the client is told, so they can try someone else. */
async function sweepOrders(deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const at = (deps.now ?? (() => new Date()))();
  const due = await prisma.packageOrder.findMany({ where: { status: "requested", answerDueAt: { lte: at } } });
  let expired = 0;
  for (const o of due) {
    const claimed = await prisma.packageOrder.updateMany({ where: { id: o.id, status: "requested" }, data: { status: "expired", answeredAt: at } });
    if (claimed.count !== 1) continue;
    await closeOrderJob(prisma, { ...o }, "expired", at);
    await notify(o.clientId, { title: "No answer in 48 hours", body: `${o.snapshot?.title ?? "Your order"} lapsed. Nothing was charged. Try another package.`, data: { type: "package_order", jobId: o.jobId } });
    await notify(o.talentId, { title: "An order lapsed", body: `${o.snapshot?.title ?? "A package order"} wasn't answered in 48 hours.`, data: { type: "package_order", jobId: o.jobId } });
    expired++;
  }
  return { packageOrdersExpired: expired };
}

/** Orders for the signed-in person, newest first, from their side. */
async function ordersFor({ userId, role }, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const rows = await prisma.packageOrder.findMany({ where: role === "client" ? { clientId: userId } : { talentId: userId }, orderBy: { createdAt: "desc" }, take: 100 });
  const ids = [...new Set(rows.map((r) => (role === "client" ? r.talentId : r.clientId)))];
  const people = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
  const name = new Map(people.map((p) => [p.id, p.fullName]));
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    title: r.snapshot?.title ?? "Package",
    price: Number(r.snapshot?.price ?? 0),
    currency: r.snapshot?.currency ?? "NGN",
    deliveryDays: r.snapshot?.deliveryDays ?? null,
    skillLabel: r.snapshot?.skillLabel ?? null,
    other: name.get(role === "client" ? r.talentId : r.clientId) ?? "Someone",
    jobId: r.jobId,
    note: r.note,
    answerDueAt: r.answerDueAt,
    createdAt: r.createdAt,
  }));
}

module.exports = { TIERS, LIMITS, ANSWER_MS, validatePackage, mine, save, setStatus, remove, browse, detail, order, accept, decline, cancel, sweepOrders, ordersFor };
