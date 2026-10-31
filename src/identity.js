// Identity rules that need no database (PRD §4.4; decisions D10 to D15, D47).

const ADULT_AGE = 18;

/** An 11-digit NIN. Only the last four digits are ever stored (the document photo holds the rest). */
function isNin(value) {
  return typeof value === "string" && /^\d{11}$/.test(value.trim());
}

/** Whole years between a date of birth and a moment (UTC, so a birthday counts from 00:00 UTC). */
function ageOn(dateOfBirth, at = new Date()) {
  const dob = new Date(dateOfBirth);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    at.getUTCMonth() < dob.getUTCMonth() || (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function isMinor(dateOfBirth, at = new Date()) {
  if (!dateOfBirth) return false;
  return ageOn(dateOfBirth, at) < ADULT_AGE;
}

/** Lowercase, no accents or punctuation, single spaces. */
function normaliseName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether two people's names are the same person's. Order does not matter ("Ada Obi" and "Obi Ada"), a
 * missing middle name is fine, and initials count ("Ada C. Obi"). Each name needs at least two words
 * and every word of the shorter name must appear in the longer one. This is deliberately strict about
 * the surname: money only goes to the person who did the work.
 */
function namesMatch(a, b) {
  const x = normaliseName(a).split(" ").filter(Boolean);
  const y = normaliseName(b).split(" ").filter(Boolean);
  if (x.length < 2 || y.length < 2) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const used = new Set();
  return short.every((word) => {
    const at = long.findIndex((w, i) => !used.has(i) && (w === word || (word.length === 1 && w.startsWith(word)) || (w.length === 1 && word.startsWith(w))));
    if (at === -1) return false;
    used.add(at);
    return true;
  });
}

/** Where a person stands, for the app and for the paid-action gate. */
function identityState({ identityVerifiedAt, dateOfBirth, guardianConfirmedAt, latestCheckStatus }, at = new Date()) {
  if (!identityVerifiedAt) {
    return { status: latestCheckStatus === "pending" ? "inReview" : latestCheckStatus === "notYet" ? "notYet" : "notStarted", minor: false, guardianNeeded: false, canTransact: false };
  }
  const minor = isMinor(dateOfBirth, at);
  const guardianNeeded = minor && !guardianConfirmedAt;
  return { status: "verified", minor, guardianNeeded, canTransact: !guardianNeeded };
}

const NOT_YET_REASONS = [
  { code: "unreadable", label: "The photo is hard to read" },
  { code: "name_mismatch", label: "The name doesn't match the one you entered" },
  { code: "face_mismatch", label: "The face in the video doesn't match the document" },
  { code: "document_invalid", label: "The document looks invalid or expired" },
  { code: "video_problem", label: "The video is too short, too dark or cut off" },
  { code: "other", label: "Something else" },
];

module.exports = { ADULT_AGE, isNin, ageOn, isMinor, normaliseName, namesMatch, identityState, NOT_YET_REASONS };
