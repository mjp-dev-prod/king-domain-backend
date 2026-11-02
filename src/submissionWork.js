// "What you sent": the person's own submission laid out so they can see everything the checker and reviewers will see, with
// links they can open (private, short-lived), what each requirement was for, and plain advice on anything that looks thin.
// Read-only: a sent submission can't be changed (PRD §4.3), so this is for looking, not editing.
const storage = require("./storage");

const WHY = {
  pieces: "Two or three pieces show your work is consistent, not one lucky result.",
  details: "The brief is what reviewers judge each piece against, so they need to know what was asked, your part in it and when.",
  outputs: "Reviewers have to see the finished work itself. A live link counts, a file is safer: a site can go down.",
  howMade: "This is how the checker knows you made it, and didn't copy it. One piece is enough.",
  walkthrough: "You explain the work on camera in 2 to 3 minutes. It's the strongest proof that it's yours.",
  declaration: "You confirm the work is yours, and say if you used AI, so nobody is misled.",
  terms: "After a 'Not yet', sending work again means accepting the terms about resending.",
};

function kindOf(contentType) {
  const t = String(contentType ?? "").toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "application/pdf") return "pdf";
  return "other";
}

async function linked(f) {
  return {
    id: f.id,
    role: f.role,
    name: f.name,
    contentType: f.contentType,
    sizeBytes: f.sizeBytes,
    kind: kindOf(f.contentType),
    // An hour: long enough to watch a video through and seek around in it.
    url: f.status === "ready" && storage.privateUploadsConfigured ? await storage.presignPrivateGet(f.objectKey, 3600) : null,
  };
}

/** Advice on one piece. Never blocks: the work is already sent. "ok" is shown as a tick, "advice" as a gentle note. */
function checksFor(p, { hasFinishedFile, hasHowMade, otherPieceShowsHowMade }) {
  const checks = [];
  const missing = [];
  if (!p.title?.trim()) missing.push("a title");
  if (!p.brief?.trim()) missing.push("the brief");
  if (!p.role?.trim()) missing.push("your role");
  if (!p.madeOn?.trim()) missing.push("when it was made");
  checks.push(
    missing.length
      ? { key: "details", state: "missing", label: "Details", detail: `Missing: ${missing.join(", ")}. Reviewers use these to judge the work.` }
      : { key: "details", state: "ok", label: "Details", detail: "Title, brief, your role and the date are all there." },
  );
  const briefLen = p.brief?.trim().length ?? 0;
  if (briefLen > 0 && briefLen < 40) {
    checks.push({ key: "brief", state: "advice", label: "The brief is short", detail: "Reviewers judge the work against it. Saying what was asked, for whom and what you were told to deliver helps them score fairly." });
  }
  if (hasFinishedFile) checks.push({ key: "finished", state: "ok", label: "Finished work", detail: "The finished work is attached." });
  else if (p.liveLink?.trim()) checks.push({ key: "finished", state: "advice", label: "Finished work is a link only", detail: "If that site goes down or goes private, reviewers can't see the work. A file or a screen recording is safer." });
  else checks.push({ key: "finished", state: "missing", label: "Finished work", detail: "Neither a file nor a live link was added." });
  if (hasHowMade) checks.push({ key: "howMade", state: "ok", label: "How it was made", detail: "This piece shows how it was made." });
  else if (otherPieceShowsHowMade) checks.push({ key: "howMade", state: "ok", label: "How it was made", detail: "Another piece shows how it was made, which is all that is needed." });
  else checks.push({ key: "howMade", state: "missing", label: "How it was made", detail: "Nothing on any piece shows how it was made." });
  return checks;
}

/** The whole view. `ser` is serialiseSubmission's output (readiness, pieces, declaration); `s` is the row with its files. */
async function buildWork(s, ser) {
  const fileRows = s.files.filter((f) => f.status === "ready");
  const byPiece = new Map();
  for (const f of fileRows) {
    if (!f.pieceId) continue;
    const list = byPiece.get(f.pieceId) ?? [];
    list.push(f);
    byPiece.set(f.pieceId, list);
  }
  const showsHowMade = (p, files) => Boolean(p.processLink?.trim()) || files.some((f) => f.role === "working" || f.role === "draft");
  const anyHowMade = s.pieces.some((p) => showsHowMade(p, byPiece.get(p.id) ?? []));

  const pieces = [];
  for (const p of s.pieces) {
    const files = byPiece.get(p.id) ?? [];
    const outputs = await Promise.all(files.filter((f) => f.role === "output").map(linked));
    const howMade = await Promise.all(files.filter((f) => f.role === "working" || f.role === "draft").map(linked));
    pieces.push({
      id: p.id,
      position: p.position,
      title: p.title,
      brief: p.brief,
      role: p.role,
      madeOn: p.madeOn,
      liveLink: p.liveLink,
      processLink: p.processLink ?? "",
      finished: outputs,
      howMade,
      checks: checksFor(p, { hasFinishedFile: outputs.length > 0, hasHowMade: showsHowMade(p, files), otherPieceShowsHowMade: anyHowMade }),
    });
  }

  const walkthrough = await Promise.all(fileRows.filter((f) => !f.pieceId && f.role === "walkthrough").map(linked));
  const requirements = ser.readiness.items.map((i) => ({ key: i.key, label: i.label, done: i.done, why: WHY[i.key] ?? null }));
  const gaps = requirements.filter((r) => !r.done).length;
  const advice = pieces.reduce((n, p) => n + p.checks.filter((c) => c.state === "advice").length, 0);

  return {
    id: s.id,
    skillKey: s.skillKey,
    skillLabel: ser.skillLabel,
    status: s.status,
    submittedAt: s.submittedAt,
    howMade: ser.howMade,
    summary: {
      verdict: gaps ? "gaps" : advice ? "complete_with_advice" : "complete",
      headline: gaps ? `${gaps} thing${gaps === 1 ? " is" : "s are"} missing` : advice ? "Everything needed is here, with a few things worth knowing" : "Everything needed is here",
      detail: gaps
        ? "Sending is blocked until the checklist is complete, so a sent submission should not have gaps. If you see one, tell us."
        : "This is exactly what is looked at. The checker sees who you are; the two reviewers do not, and score the work without knowing.",
    },
    requirements,
    pieces,
    walkthrough,
    declaration: { ownWork: s.declaredOwnWork, aiUsed: s.aiUsed, aiNote: s.aiNote },
  };
}

module.exports = { buildWork, kindOf, WHY };
