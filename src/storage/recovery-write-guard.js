// Existing product mutations must not build on a partially restored Project.
export function assertRecoveryWritable(db, { projectId = null, workId = null, resourceId = null, locationId = null } = {}) {
  if (locationId) resourceId = db.prepare('SELECT resource_id FROM resource_locations WHERE id=?').get(locationId)?.resource_id ?? resourceId;
  if (workId) projectId = db.prepare('SELECT project_id FROM work_sessions WHERE id=?').get(workId)?.project_id ?? projectId;
  const pending = db.prepare(`SELECT id,project_id,state_json FROM recovery_rounds WHERE json_extract(state_json,'$.pending_restore') IS NOT NULL`).all();
  const match = pending.find((row) => row.project_id === projectId || resourceId && (JSON.parse(row.state_json).resource_ids ?? []).includes(resourceId));
  if (match) {
    const error = new Error('Project recovery is incomplete. Resume recovery before editing Work, Resource or Save state.');
    error.code = 'ATLAS_RECOVERY_INCOMPLETE'; error.details = { round_id: match.id }; throw error;
  }
}
