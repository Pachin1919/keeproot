// Typed state for the existing round recovery journal. No independent save store.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { activeSavedResourcePath, currentSavedResourceLocation } from './save-service.js';

function stop(message) { const error = new Error(message); error.code = 'ATLAS_RECOVERY_CONFLICT'; throw error; }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const productState = (state) => ({ resources: state.resources ?? [], works: state.works ?? [], saves: state.saves ?? [] });

// Only exact absent output slots authorized before Save creation may acquire identities.
// This reads the existing Save journal; it neither creates nor rewinds receipts.
export function expandSaveScope(round, stateDir) {
  const slots = round.save_targets ?? [];
  const expanded = { ...round, resource_ids: [...(round.resource_ids ?? [])], save_ids: [...(round.save_ids ?? [])], created_save_ids: [], created_resource_ids: [] };
  const journal = path.join(stateDir, 'ui/saved-work.json');
  if (!slots.length || !fs.existsSync(journal)) return expanded;
  for (const entry of [path.dirname(journal), journal]) if (fs.lstatSync(entry).isSymbolicLink()) stop('Save journal cannot traverse a link.');
  const rows = JSON.parse(fs.readFileSync(journal, 'utf8')).items;
  if (!Array.isArray(rows)) stop('Save journal is invalid.');
  const claimed = new Set();
  for (const row of rows) {
    const target = row.target?.path ?? (row.prepare_request?.root && row.prepare_request?.target ? path.resolve(row.prepare_request.root, row.prepare_request.target) : null);
    const slot = target && slots.find((name) => path.resolve(round.root, name).toLowerCase() === path.resolve(target).toLowerCase());
    if (!slot) continue;
    if (claimed.has(slot)) stop('More than one Save claims the protected output slot.');
    claimed.add(slot);
    if (row.project?.id !== round.project_id || row.status !== 'executed' || !row.resource_id) stop('Protected output slot requires a fully executed same-Project Save. Finish the Save before recovery.');
    expanded.save_ids.push(row.save_id); expanded.resource_ids.push(row.resource_id);
    expanded.created_save_ids.push(row.save_id); expanded.created_resource_ids.push(row.resource_id);
  }
  expanded.save_ids = [...new Set(expanded.save_ids)].sort(); expanded.resource_ids = [...new Set(expanded.resource_ids)].sort();
  if (expanded.save_ids.length > 64 || expanded.resource_ids.length > 64) stop('Save output scope exceeds the recovery object budget.');
  return expanded;
}

export function captureProductState({ round, ledger, stateDir, resolvePath }) {
  const db = ledger.db;
  const resourceIds = round.resource_ids ?? [];
  const workIds = round.work_ids ?? [];
  const saveIds = round.save_ids ?? [];
  const absolutePaths = round.paths.map((name) => resolvePath(name).absolute);
  const resources = resourceIds.map((resourceId) => {
    const detail = ledger.resources.describe(resourceId);
    const created = (round.created_resource_ids ?? []).includes(resourceId);
    const locations = detail?.locations.filter((location) => (created ? ['active', 'missing'] : ['active']).includes(location.status)) ?? [];
    if (!detail || !(created ? ['active', 'missing'] : ['active']).includes(detail.resource.status) || locations.length !== 1) stop('Recovery requires an active single-location Resource.');
    const location = locations[0];
    if (!(created ? ['active', 'missing'] : ['active']).includes(location.status) || location.project_id !== round.project_id || !absolutePaths.includes(path.resolve(location.path))) stop('Declare the same-Project Resource file in paths. Moved/missing Resources are unsupported.');
    const relative = round.paths[absolutePaths.indexOf(path.resolve(location.path))];
    if (!created && !resolvePath(relative).stat) stop('Missing Resource files are not supported by this recovery slice.');
    if (db.prepare('SELECT save_id FROM resource_save_links WHERE resource_id=?').all(resourceId).some((link) => !saveIds.includes(link.save_id))) stop('Declare the Save output dependency explicitly.');
    if (detail.relationships.some((relation) => relation.status === 'active' && (relation.evidence?.save_id && !saveIds.includes(relation.evidence.save_id)
      || !(relation.target_kind === 'project' && relation.target_id === round.project_id
        || relation.target_kind === 'resource' && relation.type === 'linked_to' && resourceIds.includes(relation.target_id) && relation.evidence?.project_id === round.project_id)))) stop('Resource has an uncovered Save or cross-Project relationship.');
    const consumers = db.prepare('SELECT session_id FROM work_session_sources WHERE resource_id=?').all(resourceId);
    if (consumers.some((item) => !workIds.includes(item.session_id))) stop('Resource is used by an uncovered Work. Include every affected Work explicitly.');
    const boards = db.prepare('SELECT id,project_id,blocks_json FROM project_boards').all();
    if (boards.some((board) => JSON.parse(board.blocks_json).some((block) => block.resource_id === resourceId)
        && (board.project_id !== round.project_id || !round.board_ids.includes(board.id)))) stop('Resource is referenced by an uncovered Board. Include every affected Board explicitly.');
    return { resource_id: resourceId, location, relationships: detail.relationships, ...(created ? { created_in_round: true } : {}) };
  });
  const works = workIds.map((workId) => {
    const work = ledger.workSessions.byId(workId);
    if (!work || work.project_id !== round.project_id || work.status !== 'open') stop('Recovery requires an existing open Work in the same Project.');
    if (work.sources.some((source) => !resourceIds.includes(source.resource_id))) stop('Declare all Work Source Resources before protecting Work.');
    if (work.latest_save_id && !saveIds.includes(work.latest_save_id)) stop('Work has an uncovered Save dependency.');
    return work;
  });
  // Even a prepared Save or an unregistered target must not be silently rewound.
  const journal = path.join(stateDir, 'ui/saved-work.json');
  const saves = [];
  if (fs.existsSync(journal)) {
    for (const entry of [path.dirname(journal), journal]) if (fs.lstatSync(entry).isSymbolicLink()) stop('Save journal cannot traverse a link.');
    const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (!Array.isArray(saved.items)) stop('Save journal is invalid.');
    const includesPath = (value) => typeof value === 'string' && absolutePaths.some((item) => item.toLowerCase() === path.resolve(value).toLowerCase());
    for (const item of saved.items) {
      const linkedResource = item.resource_id ?? db.prepare('SELECT resource_id FROM resource_save_links WHERE save_id=?').get(item.save_id)?.resource_id;
      const currentProjectId = currentSavedResourceLocation(db, linkedResource)?.project_id ?? item.project?.id;
      const activePath = (resourceId, oldPath) => activeSavedResourcePath(db, currentProjectId, resourceId, oldPath);
      const targetPath = activePath(item.resource_id, item.target?.path);
      const sourceItems = [item.source, ...(item.source?.sources ?? [])].filter(Boolean).map((source) => ({ ...source, path: activePath(source.resource_id, source.path) }));
      const inputPaths = (item.inputs ?? item.prepare_request?.inputs ?? []).map((input) => item.prepare_request?.root && input.relative_path ? activePath(null, path.resolve(item.prepare_request.root, input.relative_path)) : null);
      const reservedTarget = item.prepare_request?.root && item.prepare_request?.target
        ? path.resolve(item.prepare_request.root, item.prepare_request.target) : null;
      if (saveIds.includes(item.save_id)) {
        if (currentProjectId !== round.project_id || item.status !== 'executed' || !item.resource_id
            || !resourceIds.includes(item.resource_id) || !includesPath(targetPath)) stop('Selected Save requires an executed same-Project result with its Resource and file declared.');
        if (item.parameters?.work_session_id && !workIds.includes(item.parameters.work_session_id)) stop('Declare the selected Save Work dependency.');
        if (sourceItems.some((source) => source.path && !includesPath(source.path) || source.resource_id && !resourceIds.includes(source.resource_id))
            || inputPaths.some((input) => !includesPath(input))) stop('Declare every selected Save input file and Source Resource.');
        const boards = db.prepare('SELECT id,project_id,blocks_json FROM project_boards').all();
        if (boards.some((board) => JSON.parse(board.blocks_json).some((block) => block.save_id === item.save_id)
          && (board.project_id !== round.project_id || !round.board_ids.includes(board.id)))) stop('Save is referenced by an uncovered Board.');
        saves.push({ save_id: item.save_id, receipt_sha256: crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex'), ...((round.created_save_ids ?? []).includes(item.save_id) ? { created_in_round: true } : {}) });
        continue;
      }
      if (workIds.includes(item.parameters?.work_session_id) || resourceIds.includes(item.resource_id)
          || includesPath(targetPath) || includesPath(reservedTarget) || sourceItems.some((source) => resourceIds.includes(source.resource_id) || includesPath(source.path)) || inputPaths.some(includesPath)) stop('Protected scope has a Save dependency; its receipt and files have not been changed.');
    }
  }
  if (saves.length !== saveIds.length) stop('Selected Save is unavailable.');
  return { resources, works, saves: saves.sort((a, b) => a.save_id.localeCompare(b.save_id)) };
}

export function validateProductTransition(target, before) {
  const left = productState(target); const right = productState(before);
  if (!same(left.saves, right.saves)) stop('Save receipt changed; recovery will not rewrite Save history.');
  if (!same(left.resources.map((r) => r.resource_id), right.resources.map((r) => r.resource_id))
      || !same(left.works.map((w) => w.session_id), right.works.map((w) => w.session_id))) stop('Recovery object scope changed.');
  for (const resource of left.resources) {
    const current = right.resources.find((r) => r.resource_id === resource.resource_id);
    const createdSaves = new Set(right.saves.filter((save) => save.created_in_round).map((save) => save.save_id));
    const relationshipsMatch = resource.relationships.every((relation) => current.relationships.some((value) => same(value, relation)))
      && current.relationships.every((relation) => resource.relationships.some((value) => same(value, relation)) || createdSaves.has(relation.evidence?.save_id));
    if (resource.location.id !== current.location.id || resource.location.path !== current.location.path
        || !relationshipsMatch) stop('Resource location or relationships changed; this recovery does not rewrite them.');
  }
}

// Called inside the round's final SQLite transaction only, after all bytes verify.
export function restoreProductState({ target, before, ledger, restoreId, caller, at }) {
  validateProductTransition(target, before);
  const db = ledger.db;
  for (const resource of target.resources ?? []) {
    const location = resource.location;
    db.prepare('UPDATE resource_locations SET content_hash=?,bytes=?,modified_at=?,evidence_json=? WHERE id=?')
      .run(location.content_hash, location.bytes, location.modified_at, location.evidence_json, location.id);
    if (resource.created_in_round) {
      db.prepare('UPDATE resource_locations SET status=?,valid_to=? WHERE id=?').run(location.status, location.status === 'missing' ? at : null, location.id);
      db.prepare('UPDATE resources SET status=?,updated_at=? WHERE id=?').run(location.status, at, resource.resource_id);
    }
    // Restore the recorded accepted baseline, not a fabricated fresh observation.
    db.prepare("INSERT INTO resource_actions(id,resource_id,action_type,details_json,created_at,status) VALUES(?,?,'round_restore',?,?,'completed')")
      .run(`RACT-${crypto.randomUUID()}`, resource.resource_id, JSON.stringify({ restore_id: restoreId, baseline_sha256: location.content_hash, caller }), at);
  }
  for (const work of target.works ?? []) {
    const expected = before.works.find((w) => w.session_id === work.session_id);
    const changed = db.prepare(`UPDATE work_sessions SET intent=?,return_state_json=?,mapping_json=?,recipe_json=?,latest_save_id=?,
      revision=revision+1,preview_json=NULL,preview_revision=NULL,updated_at=? WHERE id=? AND project_id=? AND revision=?`)
      .run(work.intent, JSON.stringify(work.return_state), JSON.stringify(work.mapping), JSON.stringify(work.recipe), work.latest_save_id, at, work.session_id, work.project_id, expected.revision).changes;
    if (changed !== 1) stop('Work revision changed before recovery.');
    db.prepare('DELETE FROM work_session_sources WHERE session_id=?').run(work.session_id);
    const insert = db.prepare(`INSERT INTO work_session_sources(session_id,source_key,ordinal,resource_id,sheet,fingerprint_json,profile_json,profile_processor_version,version_policy,status,error_message,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const source of work.sources) insert.run(work.session_id, source.source_key, source.ordinal, source.resource_id, source.sheet,
      source.fingerprint == null ? null : JSON.stringify(source.fingerprint), source.profile == null ? null : JSON.stringify(source.profile),
      source.profile_processor_version, source.version_policy, source.status, source.error_message, at);
  }
}
