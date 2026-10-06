import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Registry } from './registry.js';
import { EvolutionRepository } from './storage/repositories/evolution-repository.js';
import { ProjectContextRepository } from './storage/repositories/project-context-repository.js';
import { withStateLock } from './state-lock.js';
import { assertRecoveryWritable, assertDocumentUpdatesSettled, assertReferenceRepairsUndone } from './storage/recovery-write-guard.js';
import { projectMoveWrite } from './project-move-writer.js';
import { verifyUndoneReferenceRepairs, verifyFrozenReferenceRepairs } from './reference-repair-roundtrip.js';

const now = () => new Date().toISOString();
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (message) => Object.assign(new Error(message), { code: 'ATLAS_STATE_CONFLICT' });
const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
const inside = (root, value) => { const relative = path.relative(root, value); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); };
const stable = (value) => JSON.parse(JSON.stringify(value));
function relative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw invalid('Choose a relative target inside the registered Root.');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/u.test(part) || /[ .]$/u.test(part))) throw invalid('Target path contains unsupported segments.');
  return parts.join('/');
}
function regularAncestors(value, allowMissingLast = false) {
  let cursor = path.parse(value).root;
  const parts = value.slice(cursor.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (allowMissingLast && i === parts.length - 1 && error.code === 'ENOENT') return; throw conflict('Project path ancestor is unavailable.'); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict('Project path must use real directories without links.');
  }
}
function projectPaths(value, from, to) {
  if (Array.isArray(value)) return value.map((item) => projectPaths(item, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['path', 'file_path', 'source_path', 'target_path', 'result_path', 'project_root'].includes(key) && typeof item === 'string' && path.isAbsolute(item) && inside(from, item)
      ? path.join(to, path.relative(from, item)) : projectPaths(item, from, to)]));
  return value;
}

export function createProjectMoveService({ stateDir, registry = null, resourceControl = null, writer = projectMoveWrite, afterPhysicalMove = null, afterDatabaseMove = null } = {}) {
  stateDir = path.resolve(stateDir);
  const ownsRegistry = !registry; registry ??= new Registry({ stateDir });
  if (path.resolve(registry.stateDir) !== stateDir) throw invalid('Project Move and Registry must use the same Runtime state.');
  const ledger = registry.ledger; const db = ledger.db; const directory = path.join(stateDir, 'project-moves');
  const journalPath = (id) => { if (!/^RUN-[a-f0-9-]{36}$/u.test(id ?? '')) throw invalid('Invalid Project Move ID.'); return path.join(directory, `${id}.json`); };
  const write = (row) => {
    const body=JSON.stringify(row);if(Buffer.byteLength(body)>8*1024*1024)throw conflict('Project Move journal exceeds its bounded record budget.');
    regularAncestors(stateDir); fs.mkdirSync(directory, { recursive: true }); regularAncestors(directory);
    const target = journalPath(row.move_id); if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw conflict('Project Move journal is linked.');
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, body, { flag: 'wx' });
    const fd = fs.openSync(temporary, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
  };
  const read = (id, projectId) => {
    regularAncestors(directory); const file = journalPath(id); const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) throw conflict('Project Move journal is invalid.');
    let row; try { row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw conflict('Project Move journal is unreadable.'); }
    if (row.schema !== 'atlas.project-move.v1' || row.move_id !== id || row.project_id !== projectId || !row.manifest || !Number.isInteger(row.revision)) throw conflict('Project Move identity does not match this Project.');
    return row;
  };
  const rows = () => {
    if (!fs.existsSync(directory)) return [];
    regularAncestors(directory); const names = fs.readdirSync(directory).filter((name) => !name.endsWith('.tmp'));
    if (names.length > 10000) throw conflict('Project Move journal exceeds its record limit.');
    return names.map((name) => { if (!/^RUN-[a-f0-9-]{36}\.json$/u.test(name)) throw conflict('Project Move journal contains an invalid record.'); const file = path.join(directory, name); const s = fs.lstatSync(file); if (s.isSymbolicLink() || !s.isFile() || s.size > 8 * 1024 * 1024) throw conflict('Project Move journal is invalid.'); return JSON.parse(fs.readFileSync(file, 'utf8')); });
  };
  const snapshot = (projectId) => {
    const bounded=(sql,...args)=>{const rows=db.prepare(`${sql} LIMIT 10001`).all(...args);if(rows.length>10000)throw conflict('Project Move database baseline exceeds its row budget.');return rows;};
    const scope="SELECT resource_id FROM resource_locations WHERE project_id=? AND status='active'";
    const locations=bounded("SELECT * FROM resource_locations WHERE project_id=? AND status='active' ORDER BY id",projectId);
    const links=bounded(`SELECT * FROM resource_save_links WHERE resource_id IN (${scope}) ORDER BY save_id,resource_id`,projectId);
    const paths=new Set(bounded(`SELECT path FROM resource_locations WHERE resource_id IN (${scope})`,projectId).map(r=>path.resolve(r.path).toLowerCase()));
    const saveFile=path.join(stateDir,'ui/saved-work.json');let saves=[];
    if(fs.existsSync(saveFile)){regularAncestors(path.dirname(saveFile));const stat=fs.lstatSync(saveFile);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>16*1024*1024)throw conflict('Project Move Save journal exceeds its bounded record budget.');const items=JSON.parse(fs.readFileSync(saveFile,'utf8')).items;if(!Array.isArray(items)||items.length>10000)throw conflict('Project Move Save journal is invalid.');const saveIds=new Set(links.map(l=>l.save_id));saves=items.filter(s=>s.project?.id===projectId||saveIds.has(s.save_id)||(s.inputs??s.prepare_request?.inputs??[]).some(i=>{const p=typeof i==='string'?path.resolve(s.prepare_request?.root??'.',i):i.path??(i.relative_path&&s.prepare_request?.root?path.resolve(s.prepare_request.root,i.relative_path):null);return p&&paths.has(path.resolve(p).toLowerCase());}));}
    return stable({
    project: db.prepare('SELECT * FROM projects WHERE id=?').get(projectId),
    location: db.prepare("SELECT * FROM project_locations WHERE project_id=? AND status='active' ORDER BY id").all(projectId),
    resources: locations,
    resource_facts:bounded(`SELECT * FROM resources WHERE id IN (${scope}) ORDER BY id`,projectId),
    resource_actions:bounded(`SELECT * FROM resource_actions WHERE resource_id IN (${scope}) ORDER BY id`,projectId),
    save_links:links,saves,
    works: db.prepare('SELECT * FROM work_sessions WHERE project_id=? ORDER BY id').all(projectId),
    sources: db.prepare('SELECT s.* FROM work_session_sources s JOIN work_sessions w ON w.id=s.session_id WHERE w.project_id=? ORDER BY s.session_id,s.source_key').all(projectId),
    boards: db.prepare('SELECT * FROM project_boards WHERE project_id=? ORDER BY id').all(projectId),
  });};
  const snapshotFor=(row)=>{const value=snapshot(row.project_id);if(row.reference_roundtrip_baseline_version!==1)for(const key of ['resource_facts','resource_actions','save_links','saves'])delete value[key];return value;};
  const publicRow = (row) => ({ schema: row.schema, move_id: row.move_id, project_id: row.project_id, revision: row.revision, digest: row.digest,
    status: row.status, source: row.source, target: row.target, summary: row.summary, warnings: row.warnings, conflicts: row.conflicts,
    can_execute: row.status === 'prepared', can_undo: row.status === 'applied', can_recover: row.status === 'needs_recovery' });
  const inspect = (row, which) => {
    const value = row[which].path;
    try { fs.lstatSync(value); } catch (error) { if (error.code === 'ENOENT') { regularAncestors(value, true); return null; } throw error; }
    return writer({ mode: 'inspect', root: row.root_path, source: value, target: row[which === 'source' ? 'target' : 'source'].path, expectedAncestors: row.ancestors }).manifest;
  };
  const bind = (row, options) => {
    if (options.expectedRevision !== row.revision || options.expectedDigest !== row.digest) throw conflict('Project Move preview changed. Refresh before confirming.');
    if (typeof options.requestKey !== 'string' || !options.requestKey.trim()) throw invalid('Project Move requires a request key.');
  };
  const key = (action, options) => hash({ action, projectId: options.projectId, expectedRevision: options.expectedRevision, expectedDigest: options.expectedDigest, requestKey: options.requestKey, caller: options.caller ?? {} });
  const replay = (row, action, options) => {
    const existing = row.requests?.find((item) => item.action === action && item.key === options.requestKey);
    if (!existing) return null;
    if (existing.hash !== key(action, options)) throw conflict('Project Move request key already identifies different facts.');
    return existing.result ?? null;
  };
  const finish = (row) => {
    const pending = row.pending;
    row.status = pending.action === 'undo' ? 'undone' : 'applied'; row.revision += 1;
    if(pending.accepted_reference_roundtrips)row.accepted_reference_roundtrips=pending.accepted_reference_roundtrips;
    row.database = snapshotFor(row); row.pending = null; row.digest = hash({ move: row.move_id, revision: row.revision, status: row.status, manifest: row.manifest, database: row.database });
    const result = publicRow(row); row.requests.find((item) => item.hash === pending.request_hash).result = result;
    for (const request of row.requests) if (request.action === 'recover' && !request.result) request.result = result;
    write(row); return result;
  };
  const projectDatabase = (row) => {
    const pending = row.pending;
    const current = snapshotFor(row);
    if (hash(current) === hash(pending.after)) return;
    if (hash(current) !== hash(pending.before)) throw conflict('Project state differs from both recorded move states.');
    ledger.transaction(() => {
      const context = new ProjectContextRepository({ db, transaction: (callback) => callback() });
      context.attachLocation({ projectId: row.project_id, rootId: row.root_id, relativePath: pending.to.relative_path, reason: `Project Move ${row.move_id}`, attachedAt: pending.at });
      // The exact location ID is persisted before touching the filesystem.
      db.prepare("UPDATE project_locations SET id=? WHERE project_id=? AND status='active'").run(pending.after.location[0].id, row.project_id);
      db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(pending.after.project.updated_at, row.project_id);
      for (const resource of pending.before.resources) db.prepare("UPDATE resource_locations SET status='historical',valid_to=? WHERE id=? AND status='active'").run(pending.at, resource.id);
      for (const resource of pending.after.resources) {
        const columns = Object.keys(resource); db.prepare(`INSERT INTO resource_locations(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map((column) => resource[column]));
      }
      for (const work of pending.after.works) {
        db.prepare('UPDATE work_sessions SET revision=?,return_state_json=?,mapping_json=?,recipe_json=?,preview_json=?,preview_revision=?,updated_at=? WHERE id=?').run(work.revision, work.return_state_json, work.mapping_json, work.recipe_json, work.preview_json, work.preview_revision, work.updated_at, work.id);
      }
      for (const source of pending.after.sources) db.prepare('UPDATE work_session_sources SET fingerprint_json=?,profile_json=?,updated_at=? WHERE session_id=? AND source_key=?').run(source.fingerprint_json, source.profile_json, source.updated_at, source.session_id, source.source_key);
      const receipt = { run_id: row.move_id, operation: 'migrate_project', project_id: row.project_id, source: pending.from.relative_path, target: pending.to.relative_path, verified: true, before_manifest_hash: hash(row.manifest), after_manifest_hash: hash(row.manifest), rollback_ready: pending.action !== 'undo', executed_at: pending.at };
      // Reuse the original changes, receipts and rollback outcome inside this transaction.
      const evolution = new EvolutionRepository({ ...ledger.evolution, transaction: (callback) => callback() });
      if (pending.action === 'undo') evolution.finishRollback(row.move_id, receipt, pending.at);
      else evolution.finishExecution(row.move_id, { receipt, executedAt: pending.at });
    });
    if (hash(snapshotFor(row)) !== hash(pending.after)) throw conflict('Project Move database projection verification failed.');
  };
  const prepare = (input) => withStateLock(stateDir, () => {
    const targetRelativePath = relative(input.targetRelativePath);
    if (!input.projectId || typeof input.requestKey !== 'string' || !input.requestKey.trim()) throw invalid('Project Move requires Project and request key.');
    const requestHash = hash({ projectId: input.projectId, targetRelativePath, caller: input.caller ?? {} });
    const previous = rows().find((row) => row.project_id === input.projectId && row.prepare_key === input.requestKey);
    if (previous) { if (previous.prepare_hash !== requestHash) throw conflict('Project Move request key already identifies different facts.'); return publicRow(previous); }
    assertRecoveryWritable(db, { projectId: input.projectId }); assertDocumentUpdatesSettled(stateDir, input.projectId);
    const location = registry.projectContext.getActiveLocation(input.projectId);
    const project = ledger.getProject(input.projectId);
    if (!location || project.status !== 'active') throw conflict('Project must have an active registered Root location.');
    const root = path.resolve(location.root_path); const sourcePath = path.resolve(root, ...location.relative_path.split('/')); const targetPath = path.resolve(root, ...targetRelativePath.split('/'));
    if (!inside(root, sourcePath) || !inside(root, targetPath) || sourcePath === root || targetPath === root || inside(sourcePath, targetPath) || inside(targetPath, sourcePath) || [sourcePath, targetPath].some((item) => inside(stateDir, item) || inside(item, stateDir))) throw conflict('Project Move paths overlap or escape the Root.');
    regularAncestors(sourcePath); regularAncestors(targetPath, true);
    if (fs.existsSync(targetPath)) throw conflict('Project Move target already exists.');
    for (const other of registry.projectContext.listActiveLocations()) {
      if (other.project_id === input.projectId) continue;
      const otherPath = path.resolve(other.root_path, ...other.relative_path.split('/'));
      if ([sourcePath, targetPath].some((item) => inside(item, otherPath) || inside(otherPath, item))) throw conflict('Project Move overlaps another active Project.');
    }
    const physical = writer({ mode: 'inspect', root, source: sourcePath, target: targetPath });
    if (Object.keys(physical.manifest).length < 2) throw conflict('Project Move requires a nonempty Project.');
    const database = snapshot(input.projectId);
    if (database.resources.some((item) => !inside(sourcePath, item.path))) throw conflict('Project contains an active Resource outside the move tree.');
    const moveId = `RUN-${crypto.randomUUID()}`;
    const row = { schema: 'atlas.project-move.v1', move_id: moveId, project_id: input.projectId, revision: 1, status: 'prepared', root_id: location.root_id, root_path: root,
      source: { relative_path: location.relative_path, path: sourcePath }, target: { relative_path: targetRelativePath, path: targetPath },
      manifest: physical.manifest, ancestors: physical.ancestors, database, reference_roundtrip_baseline_version:1, prepare_key: input.requestKey, prepare_hash: requestHash,
      summary: { files: Object.values(physical.manifest).filter((item) => item.kind === 'file').length, directories: Object.values(physical.manifest).filter((item) => item.kind === 'directory').length, bytes: physical.bytes, resources: database.resources.length, works: database.works.length, saves: Number(db.prepare('SELECT count(*) AS n FROM resource_save_links WHERE resource_id IN (SELECT resource_id FROM resource_locations WHERE project_id=?)').get(input.projectId).n), boards: database.boards.length },
      warnings: ['References in file contents are not rewritten.'], conflicts: [], requests: [], pending: null };
    row.digest = hash({ move: moveId, manifest: row.manifest, database, target: row.target });
    const plan = { summary: row.summary, blockers: [], source_changes: [{ path: row.source.relative_path }, { path: row.target.relative_path }] };
    ledger.createEvolutionRun({ runId: moveId, root, operation: 'migrate_project', sourcePath: row.source.relative_path, targetPath: targetRelativePath, projectId: input.projectId, intent: 'Move this entire Project inside its registered Root.', baseline: { project_move: true, source_manifest_hash: hash(row.manifest), source_entries: Object.entries(row.manifest), target_state: 'absent' }, plan, planHash: row.digest, diffText: `${row.source.relative_path} → ${targetRelativePath}`, diffHash: row.digest, caller: input.caller ?? {}, startedAt: now() });
    write(row); return publicRow(row);
  });
  const transition = (id, options, action) => withStateLock(stateDir, () => {
    const row = read(id, options.projectId); const old = replay(row, action, options); if (old) return old;
    bind(row, options);
    if (row.status !== (action === 'undo' ? 'applied' : 'prepared')) throw conflict('Project Move is not ready for this action.');
    if (action === 'undo') assertReferenceRepairsUndone(stateDir, 'project_move', id);
    assertRecoveryWritable(db, { projectId: row.project_id }); assertDocumentUpdatesSettled(stateDir, row.project_id);
    const activeRoot = registry.projectContext.getRoot(row.root_id).root;
    if (activeRoot.governance_status !== 'adopted' || path.resolve(activeRoot.current_path) !== row.root_path) throw conflict('Registered Root changed after preview.');
    for (const other of registry.projectContext.listActiveLocations()) {
      if (other.project_id === row.project_id) continue;
      const otherPath = path.resolve(other.root_path, ...other.relative_path.split('/'));
      if ([row.source.path, row.target.path].some((item) => inside(item, otherPath) || inside(otherPath, item))) throw conflict('Another Project now overlaps this move.');
    }
    const before=snapshotFor(row);let accepted=[];
    if(action==='undo'){
      accepted=verifyUndoneReferenceRepairs({stateDir,db,sourceKind:'project_move',operationId:id,sourceProjectId:row.project_id,rootId:row.root_id,revision:row.revision,digest:row.digest,baseline:row.database,current:before,rootPath:row.root_path,allowLegacyExactSnapshot:row.reference_roundtrip_baseline_version!==1});
    }else if(hash(before)!==hash(row.database))throw conflict('Project state changed after this preview.');
    const from = action === 'undo' ? row.target : row.source; const to = action === 'undo' ? row.source : row.target;
    const observed = inspect(row, action === 'undo' ? 'target' : 'source');
    if (hash(observed) !== hash(row.manifest) || inspect(row, action === 'undo' ? 'source' : 'target') !== null) throw conflict('Project tree changed or destination is occupied.');
    const at = now(); const after = stable(before);
    after.project.current_path = to.relative_path; after.project.updated_at = at;
    after.location = [{ ...after.location[0], id: `LOC-${crypto.randomUUID()}`, relative_path: to.relative_path, valid_from: at, valid_to: null, reason: `Project Move ${row.move_id}` }];
    after.resources = after.resources.map((item) => ({ ...item, id: `RLOC-${crypto.randomUUID()}`, path: path.join(to.path, path.relative(from.path, item.path)), evidence_json: JSON.stringify(projectPaths(JSON.parse(item.evidence_json), from.path, to.path)), valid_from: at, valid_to: null }));
    after.resources.sort((a, b) => a.id.localeCompare(b.id));
    for (const work of after.works) {
      for (const field of ['return_state_json', 'mapping_json', 'recipe_json']) work[field] = JSON.stringify(projectPaths(JSON.parse(work[field]), from.path, to.path));
      work.revision += 1; work.preview_json = null; work.preview_revision = null; work.updated_at = at;
    }
    for (const source of after.sources) {
      for (const field of ['fingerprint_json', 'profile_json']) if (source[field]) source[field] = JSON.stringify(projectPaths(JSON.parse(source[field]), from.path, to.path));
      source.updated_at = at;
    }
    const requestHash = key(action, options);
    row.requests.push({ action, key: options.requestKey, hash: requestHash, result: null });
    if (action === 'execute') { ledger.reviewEvolution(id, { decision: 'accepted', reason: 'Confirmed exact Project Move preview.', reviewedAt: at }); ledger.startEvolutionExecution(id, at); }
    row.pending = { action, from, to, before, after, at, request_hash: requestHash, ...(action==='undo'?{accepted_reference_roundtrips:accepted}:{}) }; row.status = 'needs_recovery'; write(row);
    writer({ mode: 'move', root: row.root_path, source: from.path, target: to.path, expectedManifest: row.manifest, expectedAncestors: row.ancestors });
    afterPhysicalMove?.(publicRow(row)); projectDatabase(row); afterDatabaseMove?.(publicRow(row)); return finish(row);
  });
  const recover = (id, options) => withStateLock(stateDir, () => {
    const row = read(id, options.projectId); const old = replay(row, 'recover', options); if (old) return old;
    bind(row, options); if (!row.pending || row.status !== 'needs_recovery') throw conflict('Project Move has no pending operation to recover.');
    const pending = row.pending;
    const activeRoot = registry.projectContext.getRoot(row.root_id).root;
    if (activeRoot.governance_status !== 'adopted' || path.resolve(activeRoot.current_path) !== row.root_path) throw conflict('Registered Root changed during Project Move recovery.');
    for (const other of registry.projectContext.listActiveLocations()) {
      if (other.project_id === row.project_id) continue;
      const otherPath = path.resolve(other.root_path, ...other.relative_path.split('/'));
      if ([row.source.path, row.target.path].some((item) => inside(item, otherPath) || inside(otherPath, item))) throw conflict('Another Project overlaps the pending move.');
    }
    row.requests.push({ action: 'recover', key: options.requestKey, hash: key('recover', options), result: null }); write(row);
    const fromWhich = pending.action === 'undo' ? 'target' : 'source'; const toWhich = pending.action === 'undo' ? 'source' : 'target';
    const before = inspect(row, fromWhich); const after = inspect(row, toWhich);
    const beforeMatches = hash(before) === hash(row.manifest) && after === null;
    const afterMatches = before === null && hash(after) === hash(row.manifest);
    if (!beforeMatches && !afterMatches) throw conflict('Project Move filesystem differs from both recorded identities.');
    if(pending.accepted_reference_roundtrips)verifyFrozenReferenceRepairs({stateDir,db,sourceKind:'project_move',operationId:id,accepted:pending.accepted_reference_roundtrips,rootPath:row.root_path,fromPath:pending.from.path,toPath:pending.to.path,physicalAfter:afterMatches});
    if (beforeMatches) {
      if (hash(snapshotFor(row)) !== hash(pending.before)) throw conflict('Project Move filesystem and database disagree.');
      // An interrupted move can resume only this exact approved pending tree.
      writer({ mode: 'move', root: row.root_path, source: pending.from.path, target: pending.to.path, expectedManifest: row.manifest, expectedAncestors: row.ancestors });
    }
    projectDatabase(row); return finish(row);
  });
  const referenceBasis = (id, { sourceProjectId, expectedRevision, expectedDigest }) => {
    const row=read(id,sourceProjectId);
    if(row.status!=='applied'||row.pending||row.revision!==expectedRevision||row.digest!==expectedDigest)throw conflict('Project Move reference basis changed. Reopen the applied receipt.');
    const root=registry.projectContext.getRoot(row.root_id).root; const location=registry.projectContext.getActiveLocation(row.project_id);
    if(root.governance_status!=='adopted'||path.resolve(root.current_path)!==row.root_path||!location||location.root_id!==row.root_id||path.resolve(location.root_path,location.relative_path)!==row.target.path||ledger.getProject(row.project_id).status!=='active')throw conflict('Project Move current location or Root changed.');
    regularAncestors(row.target.path);
    const mappings=Object.entries(row.manifest).filter(([,v])=>v.kind==='file').map(([p])=>({from_path:path.resolve(row.source.path,p),to_path:path.resolve(row.target.path,p)}));
    if(mappings.some(m=>!inside(row.source.path,m.from_path)||!inside(row.target.path,m.to_path)))throw conflict('Project Move manifest mapping escapes its tree.');
    return {kind:'project_move',operation_id:id,revision:row.revision,digest:row.digest,root_id:row.root_id,root_path:row.root_path,from_path:row.source.path,to_path:row.target.path,affected_project_ids:[row.project_id],mappings};
  };
  return { prepare, referenceBasis, show: (id, { projectId }) => publicRow(read(id, projectId)), execute: (id, options) => transition(id, options, 'execute'), undo: (id, options) => transition(id, options, 'undo'), recover,
    dispose: () => { if (ownsRegistry) registry.dispose(); } };
}
