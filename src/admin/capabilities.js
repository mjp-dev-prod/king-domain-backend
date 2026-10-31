// What each admin may do (PRD §2, decision D43). The owner role may do everything;
// everyone else needs the capability. Read access to the dashboard itself still only
// needs a signed-in admin (requireAdmin).

const CAPABILITIES = ["reviewer", "checker", "safety", "disputes", "finance", "support", "shareholder"];

function hasCapability(admin, capability) {
  if (!admin) return false;
  if (admin.role === "owner") return true;
  return Array.isArray(admin.capabilities) && admin.capabilities.includes(capability);
}

/** Express middleware: passes if the admin has ANY of the listed capabilities. Use after requireAdmin. */
function requireCapability(...capabilities) {
  return (req, res, next) => {
    if (capabilities.some((c) => hasCapability(req.admin, c))) return next();
    return res.status(403).json({ error: "You don't have access to this." });
  };
}

/** Proof in a skill is reviewed only by an owner or a reviewer holding that skill. */
function canReviewSkill(admin, skillKey) {
  if (!admin) return false;
  if (admin.role === "owner") return true;
  return hasCapability(admin, "reviewer") && Array.isArray(admin.reviewerSkills) && admin.reviewerSkills.includes(skillKey);
}

module.exports = { CAPABILITIES, hasCapability, requireCapability, canReviewSkill };
