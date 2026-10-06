import fs from 'node:fs';
import path from 'node:path';

export function assertProjectMovesSettled(stateDir, projectId) {
  assertProjectMembershipSettled(stateDir, projectId);
  const reject = (message, details = {}) => { throw Object.assign(new Error(message), { code: 'ATLAS_STATE_CONFLICT', details }); };
  const directory = path.join(path.resolve(stateDir), 'project-moves');
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat; try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) reject('Project Move journal path is linked or invalid.');
  }
  const files = fs.readdirSync(directory); if (files.length > 10000) reject('Project Move journal exceeds its inspection budget.');
  let bytes = 0;
  for (const name of files) {
    if (name.endsWith('.tmp')) continue;
    if (!/^RUN-[a-f0-9-]{36}\.json$/u.test(name)) reject('Project Move journal contains an invalid record.');
    const file = path.join(directory, name); const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024) reject('Project Move journal exceeds its bounded record budget.');
    let row; try { row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { reject('Project Move journal is unreadable.'); }
    if (row.schema !== 'atlas.project-move.v1' || row.move_id !== name.slice(0, -5) || typeof row.project_id !== 'string' || !Number.isInteger(row.revision) || row.revision < 1
      || !['prepared', 'applied', 'undone', 'needs_recovery', 'conflict'].includes(row.status) || Boolean(row.pending) !== (row.status === 'needs_recovery')
      || !row.source?.path || !row.target?.path || !row.manifest || !row.database || row.pending && (!row.pending.before || !row.pending.after || !['execute', 'undo'].includes(row.pending.action))) reject('Project Move journal identity or state is invalid.');
    if (row.project_id === projectId && row.pending) reject('Recover the pending Project Move before changing this Project.', { move_id: row.move_id });
  }
}

export function assertProjectMembershipSettled(stateDir, projectId) {
  const reject = (message, details = {}) => { throw Object.assign(new Error(message), { code: 'ATLAS_STATE_CONFLICT', details }); };
  const directory = path.join(path.resolve(stateDir), 'project-memberships');
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) reject('Project membership journal path is linked or invalid.');
  }
  const files = fs.readdirSync(directory); if (files.length > 10000) reject('Project membership journal exceeds its record budget.');
  let bytes = 0;
  for (const name of files) {
    if (name.endsWith('.tmp')) continue;
    if (!/^MEM-[a-f0-9-]{36}\.json$/u.test(name)) reject('Project membership journal contains an invalid record.');
    const file = path.join(directory, name); const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024) reject('Project membership journal exceeds its bounded byte budget.');
    let row; try { row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { reject('Project membership journal is unreadable.'); }
    if (row.schema !== 'atlas.project-membership.v1' || row.operation_id !== name.slice(0,-5) || !['split','merge'].includes(row.operation)
      || typeof row.source_project_id !== 'string' || typeof row.target_project_id !== 'string' || !Number.isInteger(row.revision) || row.revision < 1
      || !['prepared','applied','undone','needs_recovery','conflict'].includes(row.status) || Boolean(row.pending) !== (row.status === 'needs_recovery')
      || !row.database || !row.manifest || !row.members || !row.source?.path || !row.target?.path
      || ![undefined,'move_tree','partition_existing'].includes(row.mode)
      || row.mode==='partition_existing' && (row.operation!=='split'||row.source.path!==row.target.path||!row.boundary_before?.source_project||!row.boundary_after?.source_project||!row.boundary_after?.new_project)
      || row.pending && (!row.pending.before || !row.pending.after || !['execute','undo'].includes(row.pending.action))) reject('Project membership journal identity or state is invalid.');
    if ([row.source_project_id,row.target_project_id].includes(projectId) && row.pending) reject('Recover the pending Project membership operation before changing either Project.', { operation_id: row.operation_id });
  }
}

// Read only: recovery history never snapshots or rewinds this operation journal.
export function assertDocumentUpdatesSettled(stateDir, projectId) {
  assertProjectMovesSettled(stateDir, projectId);
  const reject = (message, details = {}) => { const error = new Error(message); error.code = 'ATLAS_DOCUMENT_UPDATE_INCOMPLETE'; error.details = details; throw error; };
  const directory = path.join(path.resolve(stateDir), 'document-updates');
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) reject('Document Update journal path is linked or invalid.');
  }
  const files = fs.readdirSync(directory);
  if (files.length > 10000) reject('Document Update journal exceeds the recovery inspection budget.');
  let totalBytes = 0;
  for (const name of files) {
    if (!/^UPD-[a-f0-9]{32}\.json$/u.test(name)) {
      if (name.endsWith('.tmp')) continue;
      reject('Document Update journal contains an unknown record.');
    }
    const file = path.join(directory, name); const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024) reject('Document Update journal is not a bounded regular record.');
    totalBytes += stat.size;
    if (totalBytes > 32 * 1024 * 1024) reject('Document Update journal exceeds the total recovery inspection byte budget.');
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { reject('Document Update journal is unreadable.'); }
    if (record.schema !== 'atlas.document-update.v1' || record.update_id !== name.slice(0, -5) || typeof record.project_id !== 'string'
      || !Number.isInteger(record.revision) || record.revision < 1
      || !['preview_ready', 'pending_recovery', 'applied', 'undone'].includes(record.status)
      || Boolean(record.pending) !== (record.status === 'pending_recovery')) reject('Document Update journal identity or state is invalid.');
    if ((record.project_id === projectId || record.source?.affected_project_ids?.includes(projectId)) && (record.pending || record.status === 'pending_recovery')) reject('Recover the pending text update before changing Project recovery history.', { update_id: record.update_id });
  }
}

// Applied repairs are dependencies of the movement receipt, including inbound
// links in another Project. Preview-only candidates are not write dependencies.
export function assertReferenceRepairsUndone(stateDir, sourceKind, operationId) {
  const reject=message=>{throw Object.assign(new Error(message),{code:'ATLAS_STATE_CONFLICT'});};
  const directory=path.join(path.resolve(stateDir),'document-updates');let cursor=path.parse(directory).root;
  for(const p of directory.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,p);let s;try{s=fs.lstatSync(cursor);}catch(e){if(e.code==='ENOENT')return;throw e;}if(s.isSymbolicLink()||!s.isDirectory())reject('Reference repair journal path is linked or invalid.');}
  const files=fs.readdirSync(directory);if(files.length>10000)reject('Reference repair journal exceeds its record budget.');let bytes=0;
  for(const name of files){if(name.endsWith('.tmp'))continue;if(!/^UPD-[a-f0-9]{32}\.json$/u.test(name))reject('Reference repair journal contains an invalid record.');const file=path.join(directory,name);const s=fs.lstatSync(file);if(s.isSymbolicLink()||!s.isFile()||s.size>2*1024*1024||(bytes+=s.size)>32*1024*1024)reject('Reference repair journal exceeds its bounded byte budget.');let row;try{row=JSON.parse(fs.readFileSync(file,'utf8'));}catch{reject('Reference repair journal is unreadable.');}if(row.schema!=='atlas.document-update.v1'||row.update_id!==name.slice(0,-5)||!['preview_ready','pending_recovery','applied','undone'].includes(row.status)||Boolean(row.pending)!==(row.status==='pending_recovery'))reject('Reference repair journal state is invalid.');
    if(row.source?.kind===sourceKind&&row.source.operation_id===operationId&&(row.status==='applied'||row.pending))reject('Undo or recover the related reference repair before undoing this movement.');
  }
}

// Existing product mutations must not build on a partially restored Project.
export function assertRecoveryWritable(db, { projectId = null, workId = null, resourceId = null, locationId = null } = {}) {
  if (locationId) resourceId = db.prepare('SELECT resource_id FROM resource_locations WHERE id=?').get(locationId)?.resource_id ?? resourceId;
  if (workId) projectId = db.prepare('SELECT project_id FROM work_sessions WHERE id=?').get(workId)?.project_id ?? projectId;
  const databasePath = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
  if (databasePath) {
    const projectIds = new Set([projectId].filter(Boolean));
    if (resourceId) for (const row of db.prepare("SELECT project_id FROM resource_locations WHERE resource_id=? AND status='active'").all(resourceId)) if (row.project_id) projectIds.add(row.project_id);
    for (const id of projectIds) assertProjectMovesSettled(path.dirname(databasePath), id);
  }
  const pending = db.prepare(`SELECT id,project_id,state_json FROM recovery_rounds WHERE json_extract(state_json,'$.pending_restore') IS NOT NULL`).all();
  const match = pending.find((row) => row.project_id === projectId || resourceId && (JSON.parse(row.state_json).resource_ids ?? []).includes(resourceId));
  if (match) {
    const error = new Error('Project recovery is incomplete. Resume recovery before editing Work, Resource or Save state.');
    error.code = 'ATLAS_RECOVERY_INCOMPLETE'; error.details = { round_id: match.id }; throw error;
  }
}
