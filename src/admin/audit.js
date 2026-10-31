// The audit log (PRD §4.11, decision D43): who did what, when, why, with which evidence.
// Rows are only ever inserted. Pass a Prisma transaction client as `db` so the action and its
// audit event commit together.

function actorRoleOf(admin) {
  const caps = Array.isArray(admin.capabilities) ? [...admin.capabilities].sort() : [];
  return caps.length ? `${admin.role}:${caps.join(",")}` : admin.role;
}

async function recordAudit(db, admin, { action, subjectType, subjectId, reasonCode = null, note = null, details = null }) {
  if (!action || !subjectType || !subjectId) {
    throw new Error("recordAudit needs action, subjectType and subjectId.");
  }
  const event = await db.adminAuditEvent.create({
    data: { actorId: admin.id, actorRole: actorRoleOf(admin), action, subjectType, subjectId, reasonCode, note, details },
  });
  console.log(`audit: ${action} ${subjectType}=${subjectId} by admin=${admin.id} role=${event.actorRole} event=${event.id}`);
  return event;
}

module.exports = { actorRoleOf, recordAudit };
