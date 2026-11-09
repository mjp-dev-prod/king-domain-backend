// Who is told, and when, as a skill submission moves through the two team steps (first check, then two reviewers).
// Until 2026-11-09 nobody was: sending a submission raised no alert, and a verified or "not yet" result reached the
// talent by email only. Now:
//   - the team is emailed the moment work lands in a step (the checkers for the first check; the reviewers who hold
//     the skill for the review), with Slack through the same alert;
//   - a step that sits past its target reminds the team again, once at the target and once at twice the target, so
//     it never nags more than twice;
//   - the talent gets a push when the first check passes, and when a result is in.
// Every function here swallows its own failures: telling someone must never undo or block the work it follows.

const { prisma: realPrisma } = require("./db");
const alerts = require("./alerts");
const { targetFor, QUEUES } = require("./admin/inbox");
const { skillByKey } = require("./skills");

const STEPS = {
  authenticity: { queueKey: "authenticity", status: "authenticity", path: "/authenticity", since: "submittedAt" },
  review: { queueKey: "skill-review", status: "review", path: "/skill-reviews", since: "authenticityAt" },
};
const MAX_REMINDERS = 2;
const HOUR = 3_600_000;

const label = (skillKey) => skillByKey(skillKey)?.label ?? skillKey;

/** Active admins who may do the first check: the owners, and anyone with the checker capability. */
function checkers(db) {
  return db.adminUser.findMany({ where: { status: "active", OR: [{ role: "owner" }, { capabilities: { has: "checker" } }] } });
}

/** Active admins who may review this skill: the owners, and reviewers who hold it. */
function reviewers(db, skillKey) {
  return db.adminUser.findMany({ where: { status: "active", OR: [{ role: "owner" }, { capabilities: { has: "reviewer" }, reviewerSkills: { has: skillKey } }] } });
}

/** Someone from the team to tell, or nobody: never throws. */
async function raise(db, args, deps) {
  try {
    return await alerts.raiseAlert(db, args, deps);
  } catch (err) {
    console.error(`skill-notices: alert "${args.title}" failed: ${err.message}`);
    return null;
  }
}

/** Work just landed at the first check. Email and Slack the people who can do it. */
async function submissionSent({ submission, person }, { db = realPrisma, ...deps } = {}) {
  const to = await checkers(db).catch(() => []);
  const name = person?.fullName ?? "Someone";
  const target = Math.round((await targetFor(db, QUEUES.find((q) => q.key === "authenticity")).catch(() => ({ targetMinutes: 1440 }))).targetMinutes / 60);
  return raise(
    db,
    {
      severity: "urgent",
      queueKey: "authenticity",
      title: `New ${label(submission.skillKey)} work to check`,
      body: `${name} sent ${label(submission.skillKey)} work for the first check. Please look at it within ${target} hours.`,
      link: `${STEPS.authenticity.path}/${submission.id}`,
      to: to.length ? to : null,
    },
    deps,
  );
}

/** Work passed the first check and now waits for two reviewers. Email the ones who hold the skill. */
async function readyForReview({ submission }, { db = realPrisma, ...deps } = {}) {
  const to = await reviewers(db, submission.skillKey).catch(() => []);
  return raise(
    db,
    {
      severity: "urgent",
      queueKey: "skill-review",
      title: `${label(submission.skillKey)} work ready to review`,
      body: `The first check is done. Two reviewers who hold ${label(submission.skillKey)} are needed.`,
      link: `${STEPS.review.path}/${submission.id}`,
      to: to.length ? to : null,
    },
    deps,
  );
}

// What the talent is told. Short, plain, about one skill; the type lets the app refresh the right screen.
// `icon` names one of the app's own small icons (push.ICONS): a clock for waiting, a check for good news, an arrow for
// "fix it and send again". No emoji: the brand uses line icons, and an emoji looks different on every phone.
const TALENT = {
  checked: (skill) => ({ title: "It passed the first check", body: `Your ${skill} work is now with two reviewers. We'll tell you when they've decided.`, icon: "ic_stat_clock" }),
  needs_change: (skill) => ({ title: "One thing to fix", body: `We couldn't pass your ${skill} work on the first check. Open it to see why.`, icon: "ic_stat_retry" }),
  verified: (skill) => ({ title: `You're verified in ${skill}`, body: "Clients can see it on your profile, and you can apply to jobs in it now.", icon: "ic_stat_check" }),
  not_yet: (skill) => ({ title: `Not yet in ${skill}`, body: "The reviewers left notes on what to fix. Open it to read them.", icon: "ic_stat_retry" }),
};

/** Pushes the talent's phone. `kind` is one of the keys above. Never throws. */
async function tellTalent(userId, kind, skillKey, { push = require("./push") } = {}) {
  try {
    const make = TALENT[kind];
    if (!make || !userId) return null;
    const { title, body, icon } = make(label(skillKey));
    return await push.notifyUser(userId, { title, body, icon, data: { type: `skill_${kind}`, skillKey } });
  } catch (err) {
    console.error(`skill-notices: push ${kind} to user=${userId} failed: ${err.message}`);
    return null;
  }
}

/**
 * Reminds the team about work waiting past its step's target: once when it passes the target and once at twice the
 * target (never less than a target after the first), and then stops. Each reminder is an alert row whose link names the submission, so a restart, a second
 * server or an overlapping run never sends the same reminder twice. A reviewer who already reviewed it is not nagged.
 */
async function sweepWaiting(db = realPrisma, now = new Date(), deps = {}) {
  let sent = 0;
  for (const step of Object.values(STEPS)) {
    const queue = QUEUES.find((q) => q.key === step.queueKey);
    const { targetMinutes } = await targetFor(db, queue);
    const rows = await db.skillSubmission.findMany({ where: { status: step.status, [step.since]: { not: null } }, include: { reviews: { select: { reviewerId: true } }, user: { select: { fullName: true } } } });
    for (const s of rows) {
      const waited = now.getTime() - new Date(s[step.since]).getTime();
      const link = `${step.path}/${s.id}`;
      const sent_ = await db.opsAlert.findMany({ where: { queueKey: step.queueKey, link, title: { startsWith: "Reminder" } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      const before = sent_.length;
      if (before >= MAX_REMINDERS || waited <= targetMinutes * 60_000 * (before + 1)) continue;
      // Reminders are a target apart: work that is already far past its target gets one now and the next a full target
      // later, not two in a row on consecutive sweeps (it did, the first time this ran on old work).
      if (before > 0 && now.getTime() - new Date(sent_[0].createdAt).getTime() < targetMinutes * 60_000) continue;
      const pool = step.status === "review" ? await reviewers(db, s.skillKey) : await checkers(db);
      const done = new Set(s.reviews.map((r) => r.reviewerId));
      const to = pool.filter((a) => !done.has(a.id));
      const hours = Math.round(waited / HOUR);
      const row = await raise(
        db,
        {
          severity: "urgent",
          queueKey: step.queueKey,
          title: `Reminder: ${label(s.skillKey)} work waiting ${hours} h`,
          body: `${s.user?.fullName ?? "Someone"}'s ${label(s.skillKey)} work has waited ${hours} hours. The target is ${Math.round(targetMinutes / 60)}.`,
          link,
          to: to.length ? to : null,
        },
        { ...deps, now },
      );
      if (row) sent++;
    }
  }
  if (sent) console.log(`skill-notices: reminders sent=${sent}`);
  return sent;
}

/** Whatever goes wrong inside, the caller carries on: telling someone is never worth undoing the work. */
const safe = (name, fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    console.error(`skill-notices: ${name} failed: ${err.message}`);
    return null;
  }
};

module.exports = {
  submissionSent: safe("submissionSent", submissionSent),
  readyForReview: safe("readyForReview", readyForReview),
  tellTalent,
  sweepWaiting,
  checkers,
  reviewers,
  TALENT,
  MAX_REMINDERS,
};
