// The gate on paid actions: apply, post a job, award (PRD §3.1 step 4, §3.2 step 2; decisions D10, D12).
// Off unless IDENTITY_REQUIRED=true, so today's staging keeps working until Victor switches it on once
// the checker queue is staffed. When on: the person must be verified, and a minor needs the guardian.
const { prisma } = require("../db");
const identity = require("../identity");

function requireVerifiedIdentity() {
  return async (req, res, next) => {
    if (process.env.IDENTITY_REQUIRED !== "true") return next();
    const u = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { identityVerifiedAt: true, dateOfBirth: true, guardianConfirmedAt: true },
    });
    const state = identity.identityState({ ...u, latestCheckStatus: undefined });
    console.log(`identity-gate: user=${req.user.id} verified=${Boolean(u?.identityVerifiedAt)} guardianNeeded=${state.guardianNeeded} allow=${state.canTransact}`);
    if (state.canTransact) return next();
    if (state.guardianNeeded) {
      return res.status(403).json({ error: "Your parent or guardian needs to confirm before you can work.", code: "guardian_required" });
    }
    return res.status(403).json({ error: "Verify your identity first. It takes a few minutes in the app.", code: "identity_required" });
  };
}

module.exports = { requireVerifiedIdentity };
