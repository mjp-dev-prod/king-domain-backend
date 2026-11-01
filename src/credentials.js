// Portable credentials (PRD §4.8; Open Badges 3.0, 1EdTech): a completed job, a verified skill and a Proven level, as
// OpenBadgeCredential documents signed as VC-JWTs (RS256) so they leave with the person and can be checked without us.
//
// Signing needs a key we hold: CREDENTIAL_SIGNING_KEY (an RSA private key, PEM) and PUBLIC_API_URL for the ids. Without
// both, credentials are still recorded when earned but cannot be shared yet: nothing is faked or left unsigned-and-shown.
const crypto = require("node:crypto");
const { prisma: realPrisma } = require("./db");
const rep = require("./reputation");
const { skillByKey } = require("./skills");

const CONTEXT = [
  "https://www.w3.org/ns/credentials/v2",
  "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json",
  "https://purl.imsglobal.org/spec/ob/v3p0/extensions.json",
];

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const apiBase = () => (process.env.PUBLIC_API_URL ?? "").replace(/\/$/, "");

function signingKey() {
  const pem = process.env.CREDENTIAL_SIGNING_KEY;
  if (!pem || !apiBase()) return null;
  try {
    const privateKey = crypto.createPrivateKey(pem.replace(/\\n/g, "\n"));
    if (privateKey.asymmetricKeyType !== "rsa") return null;
    const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
    const kid = b64url(crypto.createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest()).slice(0, 16);
    return { privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" }, kid };
  } catch (err) {
    console.error(`credentials: the signing key could not be read: ${err.message}`);
    return null;
  }
}

const configured = () => signingKey() !== null;

const issuerId = () => `${apiBase()}/credentials/issuer`;

/** The issuer's profile, with the public key people use to check a credential. */
function issuerProfile() {
  const key = signingKey();
  if (!key) return null;
  return {
    "@context": CONTEXT,
    id: issuerId(),
    type: ["Profile"],
    name: "King Domain",
    url: apiBase(),
    // Open Badges 3.0 asks for the issuer's public key on its profile.
    publicKeyJwk: key.jwk,
  };
}

function build(row, user) {
  const subjectId = `urn:uuid:${row.userId}`;
  const salt = row.id;
  const identityHash = `sha256$${crypto.createHash("sha256").update(`${user.email}${salt}`).digest("hex")}`;
  return {
    "@context": CONTEXT,
    id: `${apiBase()}/credentials/${row.id}`,
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuer: { id: issuerId(), type: ["Profile"], name: "King Domain", url: apiBase() },
    validFrom: row.issuedAt.toISOString(),
    name: row.title,
    credentialSubject: {
      id: subjectId,
      type: ["AchievementSubject"],
      identifier: [{ type: "IdentifierEntry", identifier: identityHash, identifierType: "emailAddress" }],
      achievement: {
        id: `${apiBase()}/credentials/achievements/${row.kind}${row.skillKey ? `/${row.skillKey}` : ""}`,
        type: ["Achievement"],
        name: row.title,
        description: row.description,
        achievementType: row.kind === "job_completed" ? "Assessment" : "Badge",
        criteria: { narrative: criteriaFor(row) },
      },
    },
  };
}

function criteriaFor(row) {
  if (row.kind === "proven") return `Awarded for ${rep.PROVEN_JOBS} completed jobs in this skill on King Domain, none lost in a dispute, all delivered on time, and every client saying they would recommend the work.`;
  if (row.kind === "skill_verified") return "Awarded after the person's real work in this skill passed an authenticity check and was scored against the skill's rubric by two reviewers who practise it.";
  return "Awarded when a job was delivered, approved by the client and paid out through King Domain.";
}

/** Compact JWS (VC-JWT): header {alg, typ, kid, jwk}; payload is the credential plus iss, jti, sub, nbf. */
function sign(credential) {
  const key = signingKey();
  if (!key) return null;
  const header = { alg: "RS256", typ: "JWT", kid: key.kid, jwk: key.jwk };
  const payload = { ...credential, iss: credential.issuer.id, jti: credential.id, sub: credential.credentialSubject.id, nbf: Math.floor(new Date(credential.validFrom).getTime() / 1000) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), key.privateKey);
  return `${input}.${b64url(signature)}`;
}

/** Checks a compact JWS against this issuer's key. Used by the tests and by anyone verifying with us. */
function verify(jws) {
  const key = signingKey();
  if (!key) return false;
  const [h, p, s] = String(jws).split(".");
  if (!h || !p || !s) return false;
  return crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), crypto.createPublicKey(crypto.createPrivateKey(process.env.CREDENTIAL_SIGNING_KEY.replace(/\\n/g, "\n"))), Buffer.from(s, "base64url"));
}

/**
 * Brings a person's credentials up to date: one for each completed job and each verified skill, and a Proven level
 * for each skill that has earned it. A Proven level the signal has turned against is revoked, never deleted. Safe to
 * run any number of times.
 */
async function sync(userId, deps = {}) {
  const prisma = deps.prisma ?? realPrisma;
  const now = deps.now ?? new Date();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== "talent") return [];

  const upsert = async (dedupeKey, data) => {
    const row = await prisma.credential.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey } } });
    if (row) {
      if (row.revokedAt && data.reinstate) return prisma.credential.update({ where: { id: row.id }, data: { revokedAt: null, revokedReason: null, jws: null, issuedAt: now } });
      return row;
    }
    const { reinstate: _r, ...rest } = data;
    return prisma.credential.create({ data: { userId, dedupeKey, ...rest } });
  };

  const contracts = await prisma.contract.findMany({
    where: { job: { applications: { some: { talentId: userId, status: "selected" } } }, status: { in: ["approved", "resolved"] } },
    include: { job: true },
  });
  for (const c of contracts) {
    if (!rep.completedAt(c)) continue;
    await upsert(`job:${c.jobId}`, { kind: "job_completed", jobId: c.jobId, skillKey: c.job.skillKey, title: `Completed: ${c.job.title}`, description: `Delivered "${c.job.title}"${c.job.skillKey ? ` (${skillByKey(c.job.skillKey)?.label ?? c.job.skillKey})` : ""} for a client through King Domain, approved and paid.`, issuedAt: rep.completedAt(c) });
  }
  const verified = await prisma.skillSubmission.findMany({ where: { userId, status: "verified" }, select: { skillKey: true, decidedAt: true } });
  for (const v of verified) {
    const label = skillByKey(v.skillKey)?.label ?? v.skillKey;
    await upsert(`verified:${v.skillKey}`, { kind: "skill_verified", skillKey: v.skillKey, title: `Verified: ${label}`, description: `Real work in ${label} passed an authenticity check and was scored by two reviewers who practise it.`, issuedAt: v.decidedAt ?? now });
  }
  for (const skillKey of [...new Set(verified.map((v) => v.skillKey))]) {
    const state = await rep.provenState(userId, skillKey, { prisma, now });
    const label = state.skillLabel;
    const key = `proven:${skillKey}`;
    if (state.proven) {
      await upsert(key, { kind: "proven", skillKey, title: `Proven: ${label}`, description: `${state.completed} completed jobs in ${label} on King Domain, on time, with every client recommending.`, issuedAt: now, reinstate: true });
    } else {
      const existing = await prisma.credential.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey: key } } });
      if (existing && !existing.revokedAt) await prisma.credential.update({ where: { id: existing.id }, data: { revokedAt: now, revokedReason: state.unmet.join("; ") || "The signal turned" } });
    }
  }

  // Sign whatever is not signed yet, if we can.
  if (configured()) {
    const unsigned = await prisma.credential.findMany({ where: { userId, jws: null, revokedAt: null } });
    for (const row of unsigned) await prisma.credential.update({ where: { id: row.id }, data: { jws: sign(build(row, user)) } });
  }
  return prisma.credential.findMany({ where: { userId }, orderBy: { issuedAt: "desc" } });
}

const shape = (row) => ({
  id: row.id,
  kind: row.kind,
  skillKey: row.skillKey,
  title: row.title,
  description: row.description,
  issuedAt: row.issuedAt,
  signed: Boolean(row.jws),
  revoked: Boolean(row.revokedAt),
  revokedReason: row.revokedReason,
  url: row.jws && apiBase() ? `${apiBase()}/credentials/${row.id}` : null,
});

module.exports = { configured, issuerProfile, build, sign, verify, sync, shape, signingKey, CONTEXT };
