import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createProjectMoveService } from '../src/project-move-service.js';
import { createResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createBoardService } from '../src/board-service.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { RoundRecovery } from '../src/round-recovery.js';
import { Evolution } from '../src/evolution.js';
import { projectMoveWrite } from '../src/project-move-writer.js';
import { spawnSync } from 'node:child_process';

const caller = { actor: 'agent', tool: 'test', client_run_id: 'project-move' };
function fixture(t, hooks = {}) {
  fs.mkdirSync(path.resolve('test/.tmp'), { recursive: true });
  const base = fs.mkdtempSync(path.resolve('test/.tmp/project-move-chain-'));
  const stateDir = path.join(base, 'state'); const workspace = path.join(base, 'workspace'); const source = path.join(workspace, 'A');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(source, 'empty'));
  fs.writeFileSync(path.join(source, 'nested', 'note.csv'), 'category,value\nA,10\nB,20\n');
  fs.writeFileSync(path.join(source, '.hidden'), 'hidden bytes');
  const registry = new Registry({ stateDir });
  const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: root.root_id, relativePath: 'A', reason: 'Fixture.' });
  const resourceControl = createResourceControl({ stateDir, registry, ledger: registry.ledger });
  const resource = resourceControl.identify({ filePath: path.join(source, 'nested', 'note.csv'), project: { id: project.project_id } });
  const work = registry.ledger.workSessions.create({ projectId: project.project_id, resourceIds: [resource.resource_id], at: new Date().toISOString() });
  registry.ledger.workSessions.updateSource(work.session_id, work.sources[0].source_key, { fingerprint: { file_path: path.join(source, 'nested', 'note.csv'), sha256: resource.evidence.sha256 }, status: 'ready' }, new Date().toISOString());
  const saveService = createSaveService({ stateDir, resourceControl });
  const candidate = path.join(stateDir, 'candidate.csv'); fs.writeFileSync(candidate, 'category,value\nA,10\nB,20\n');
  const prepared = saveService.prepare({ root: workspace, projectId: project.project_id, candidateFile: candidate, target: 'A/nested/result.csv', inputs: [path.join(source, 'nested', 'note.csv')], origin: 'agent_generated', kind: 'intermediate', channel: 'host', requestKey: 'save', caller,
    source: { path: path.join(source, 'nested', 'note.csv'), resource_id: resource.resource_id, fingerprint: { file_path: path.join(source, 'nested', 'note.csv'), sha256: resource.evidence.sha256 } } });
  const review = saveService.review(prepared.save_id);
  const saved = saveService.execute(prepared.save_id, { reason: 'Fixture.', expectedPreviewRevision: review.preview_revision });
  registry.ledger.workSessions.setLatestSave(work.session_id, saved.save_id, new Date().toISOString());
  const boardService = createBoardService({ stateDir, registry, resourceControl, saveService });
  const board = boardService.createBoard({ projectId: project.project_id, title: 'Fixture Board' });
  boardService.saveBoard({ projectId: project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [
    { type: 'material_reference', resource_id: resource.resource_id }, { type: 'text', text: 'Fixture note' }, { type: 'result_preview', save_id: saved.save_id },
  ] });
  const service = createProjectMoveService({ stateDir, registry, resourceControl, ...hooks });
  t.after(() => { service.dispose(); boardService.dispose(); saveService.dispose(); resourceControl.dispose(); registry.dispose(); fs.rmSync(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 20 }); });
  const prepare = (key = 'move') => service.prepare({ projectId: project.project_id, targetRelativePath: 'B', requestKey: key, caller });
  const options = (row, key) => ({ projectId: project.project_id, expectedRevision: row.revision, expectedDigest: row.digest, requestKey: key, caller });
  return { base, stateDir, workspace, source, registry, project, resource, work, saved, board, resourceControl, saveService, boardService, service, prepare, options };
}

test('real Resource Work Save and three Board blocks keep identities and paths across move and Undo; old Round is refused', (t) => {
  const f = fixture(t); const projectId = f.project.project_id;
  const roundService = new RoundRecovery({ stateDir: f.stateDir, registry: f.registry });
  const round = roundService.protect({ projectId, paths: ['nested/note.csv', 'nested/result.csv'], resourceIds: [f.resource.resource_id, f.saved.resource_id], workIds: [f.work.session_id], saveIds: [f.saved.save_id], boardIds: [f.board.board_id], label: 'Before move', requestKey: 'round', caller });
  const roundRecord = f.registry.ledger.db.prepare('SELECT state_json FROM recovery_rounds WHERE id=?').get(round.round_id).state_json;
  const savedBefore = fs.readFileSync(path.join(f.stateDir, 'ui/saved-work.json'));
  const preview = f.prepare(); assert.equal(preview.summary.files, 3); assert.equal(preview.summary.works, 1); assert.equal(preview.summary.boards, 1);
  const applied = f.service.execute(preview.move_id, f.options(preview, 'execute'));
  assert.equal(applied.status, 'applied');
  assert.equal(f.registry.ledger.workSessions.byId(f.work.session_id).latest_save_id, f.saved.save_id);
  assert.equal(f.registry.ledger.workSessions.byId(f.work.session_id).preview, null);
  assert.equal(f.registry.ledger.workSessions.byId(f.work.session_id).sources[0].fingerprint.file_path, path.join(f.workspace, 'B/nested/note.csv'));
  const shown = f.saveService.show(f.saved.save_id); assert.equal(shown.current_output, 'verified'); assert.equal(shown.target.path, path.join(f.workspace, 'B/nested/result.csv'));
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'ui/saved-work.json')), savedBefore);
  const board = f.boardService.showBoard(projectId, f.board.board_id);
  assert.equal(board.blocks[0].path, path.join(f.workspace, 'B/nested/note.csv'));
  assert.equal(board.blocks[1].text, 'Fixture note'); assert.equal(board.blocks[2].path, path.join(f.workspace, 'B/nested/result.csv'));
  assert.throws(() => roundService.show({ projectId, roundId: round.round_id }), /root|location|changed/iu);
  assert.equal(f.registry.ledger.db.prepare('SELECT state_json FROM recovery_rounds WHERE id=?').get(round.round_id).state_json, roundRecord);
  const movedRound = roundService.protect({ projectId, paths: ['nested/note.csv', 'nested/result.csv'],
    resourceIds: [f.resource.resource_id, f.saved.resource_id], workIds: [f.work.session_id], saveIds: [f.saved.save_id],
    boardIds: [f.board.board_id], label: 'At moved location', requestKey: 'moved-round', caller });
  assert.equal(roundService.show({ projectId, roundId: movedRound.round_id }).save_ids[0], f.saved.save_id);
  const dataWork = createDataWorkService({ stateDir: f.stateDir, resourceControl: f.resourceControl });
  assert.equal(dataWork.session(f.work.session_id).sources[0].file_path, path.join(f.workspace, 'B/nested/note.csv'));
  // Work continuation preserves identity and may create a new Preview after relocation.
  f.registry.ledger.workSessions.updateReturnState(f.work.session_id, { page: 'continued' }, new Date().toISOString());
  const fresh = f.service.prepare({ projectId, targetRelativePath: 'C', requestKey: 'after-work', caller });
  assert.equal(fresh.summary.works, 1);
  assert.throws(() => f.service.undo(preview.move_id, f.options(applied, 'undo-stale-work')), { code: 'ATLAS_STATE_CONFLICT' });
});

test('inverse Undo preserves original Save receipts and old Round remains readable at its original directory identity', (t) => {
  const f = fixture(t); const roundService = new RoundRecovery({ stateDir: f.stateDir, registry: f.registry });
  const round = roundService.protect({ projectId: f.project.project_id, paths: ['nested/note.csv', 'nested/result.csv'], resourceIds: [f.resource.resource_id, f.saved.resource_id], workIds: [f.work.session_id], saveIds: [f.saved.save_id], boardIds: [f.board.board_id], label: 'Before move', requestKey: 'round', caller });
  const receipt = fs.readFileSync(path.join(f.stateDir, 'ui/saved-work.json'));
  const preview = f.prepare(); const applied = f.service.execute(preview.move_id, f.options(preview, 'execute'));
  const changes = f.registry.ledger.db.prepare('SELECT c.change_type,c.path FROM changes c JOIN change_sets s ON s.id=c.change_set_id WHERE s.run_id=? ORDER BY c.change_type').all(preview.move_id);
  assert.deepEqual(changes.map(item => [item.change_type, item.path]), [['added', 'B'], ['deleted', 'A']]);
  const undoOptions = f.options(applied, 'undo'); const undone = f.service.undo(preview.move_id, undoOptions);
  assert.equal(undone.status, 'undone'); assert.equal(f.service.undo(preview.move_id, undoOptions).status, 'undone');
  assert.equal(f.registry.ledger.db.prepare("SELECT count(*) AS n FROM operation_events WHERE run_id=? AND event_type='rollback_outcome_recorded'").get(preview.move_id).n, 1);
  assert.equal(f.registry.projectContext.getActiveLocation(f.project.project_id).relative_path, 'A');
  const currentRound = roundService.show({ projectId: f.project.project_id, roundId: round.round_id });
  assert.equal(currentRound.round_id, round.round_id);
  assert.throws(() => roundService.preview({ projectId: f.project.project_id, roundId: round.round_id,
    baseRevision: currentRound.revision, expectedDigest: currentRound.current_digest, action: 'restore', nodeId: currentRound.nodes[0].node_id }), /location.*changed/iu);
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'ui/saved-work.json')), receipt);
});

for (const stage of ['afterPhysicalMove', 'afterDatabaseMove']) test(`real ${stage} interruption recovers exact IDs and projection once; pending blocks Project writes`, (t) => {
  const f = fixture(t, { [stage]: () => { throw new Error('Injected interruption after the real operation.'); } });
  const preview = f.prepare(); assert.throws(() => f.service.execute(preview.move_id, f.options(preview, 'execute')), /Injected interruption/u);
  const pending = f.service.show(preview.move_id, { projectId: f.project.project_id }); assert.equal(pending.status, 'needs_recovery');
  const rename = f.registry.previewRename(f.project.project_id, 'Should remain blocked');
  assert.throws(() => f.registry.renameProject(f.project.project_id, { newName: rename.new_name,
    expectedName: rename.old_name, expectedUpdatedAt: rename.expected_updated_at, previewRevision: rename.preview_revision }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.registry.ledger.workSessions.updateReturnState(f.work.session_id, { page: 'blocked' }, new Date().toISOString()), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.boardService.createBoard({ projectId: f.project.project_id, title: 'Blocked' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.saveService.undo(f.saved.save_id), { code: 'ATLAS_STATE_CONFLICT' });
  fs.mkdirSync(path.join(f.workspace, 'Other'));
  const other = f.registry.create({ name: 'Other', currentPath: 'Other' });
  f.registry.attachRoot(other.project_id, { rootId: f.registry.projectContext.getActiveLocation(f.project.project_id).root_id, relativePath: 'Other', reason: 'Unrelated pending guard fixture.' });
  assert.equal(f.registry.ledger.workSessions.create({ projectId: other.project_id, at: new Date().toISOString() }).project_id, other.project_id);
  assert.throws(() => f.registry.merge([f.project.project_id], other.project_id), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.registry.merge([other.project_id], f.project.project_id), { code: 'ATLAS_STATE_CONFLICT' });
  const request = f.options(pending, 'recover'); const recovered = f.service.recover(preview.move_id, request);
  assert.equal(recovered.status, 'applied'); assert.equal(f.service.recover(preview.move_id, request).status, 'applied');
  assert.throws(() => f.service.recover(preview.move_id, { ...request, expectedDigest: 'different' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(f.saveService.show(f.saved.save_id).current_output, 'verified');
  assert.equal(f.registry.ledger.resources.bySave(f.saved.save_id).id, f.saved.resource_id);
});

test('occupied, escaped, linked, hardlinked and overlapping Projects are refused; prepare-to-confirm overlap is rechecked', (t) => {
  const f = fixture(t); const prepare = (target, key) => f.service.prepare({ projectId: f.project.project_id, targetRelativePath: target, requestKey: key, caller });
  fs.mkdirSync(path.join(f.workspace, 'occupied'));
  assert.throws(() => prepare('occupied', 'occupied'), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => prepare('../outside', 'outside'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => prepare('A/nested/new', 'nested'), { code: 'ATLAS_STATE_CONFLICT' });
  const linked = path.join(f.workspace, 'linked'); fs.symlinkSync(f.source, linked, 'junction');
  assert.throws(() => prepare('linked/new', 'linked'), { code: 'ATLAS_STATE_CONFLICT' });
  fs.linkSync(path.join(f.source, 'nested/note.csv'), path.join(f.source, 'hard.csv'));
  assert.throws(() => prepare('B', 'hardlink'), { code: 'ATLAS_STATE_CONFLICT' }); fs.unlinkSync(path.join(f.source, 'hard.csv'));
  const preview = f.prepare();
  const nested = f.registry.create({ name: 'Nested', currentPath: 'A/nested' });
  f.registry.attachRoot(nested.project_id, { rootId: f.registry.projectContext.getActiveLocation(f.project.project_id).root_id, relativePath: 'A/nested', reason: 'Concurrent Project.' });
  assert.throws(() => f.service.execute(preview.move_id, f.options(preview, 'execute')), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.existsSync(f.source), true);
  const evolution = new Evolution({ stateDir: f.stateDir, registry: f.registry });
  try { assert.throws(() => evolution.execute(preview.move_id), /Project Move/u); } finally { evolution.dispose(); }
  const crossVolume = projectMoveWrite;
  assert.throws(() => crossVolume({ mode: 'move', root: f.workspace, source: f.source, target: 'Z:\\unavailable\\project', expectedManifest: {} }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('changed ancestor identity and a same-bytes replacement directory cannot be claimed during recovery', (t) => {
  const f = fixture(t, { afterPhysicalMove: () => { throw new Error('Interrupted'); } });
  const preview = f.prepare(); assert.throws(() => f.service.execute(preview.move_id, f.options(preview, 'execute')), /Interrupted/u);
  const pending = f.service.show(preview.move_id, { projectId: f.project.project_id });
  fs.renameSync(path.join(f.workspace, 'B'), path.join(f.workspace, 'B-original'));
  fs.cpSync(path.join(f.workspace, 'B-original'), path.join(f.workspace, 'B'), { recursive: true });
  assert.throws(() => f.service.recover(preview.move_id, f.options(pending, 'recover')), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(f.service.show(preview.move_id, { projectId: f.project.project_id }).status, 'needs_recovery');
  assert.equal(fs.existsSync(path.join(f.workspace, 'B-original/nested/note.csv')), true);
});

test('Project Move CLI uses the same synchronous service and structured request protocol', (t) => {
  const f = fixture(t); const requestFile = path.join(f.stateDir, 'move-request.json');
  fs.writeFileSync(requestFile, JSON.stringify({ projectId: f.project.project_id, targetRelativePath: 'B', requestKey: 'cli', caller }));
  const run = spawnSync(process.execPath, ['bin/atlas.js', 'project', 'move', 'prepare', '--request-file', requestFile, '--json'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, timeout: 15000 });
  assert.equal(run.status, 0, run.stderr); const result = JSON.parse(run.stdout); assert.equal(result.ok, true);
  assert.match(run.stdout, /atlas.project-move.v1/u);
});

test('source containing Runtime state and replaced Root ancestors are refused before any move', (t) => {
  const f = fixture(t); const rootId = f.registry.projectContext.getActiveLocation(f.project.project_id).root_id;
  const preview = f.prepare();
  fs.renameSync(f.workspace, path.join(f.base, 'original-workspace'));
  fs.cpSync(path.join(f.base, 'original-workspace'), f.workspace, { recursive: true });
  assert.throws(() => f.service.execute(preview.move_id, f.options(preview, 'execute')), { code: 'ATLAS_STATE_CONFLICT' });
  f.registry.ledger.db.prepare('UPDATE portfolio_roots SET current_path=? WHERE id=?').run(f.base, rootId);
  f.registry.ledger.db.prepare("UPDATE project_locations SET relative_path='state' WHERE project_id=? AND status='active'").run(f.project.project_id);
  f.registry.ledger.db.prepare("UPDATE projects SET current_path='state' WHERE id=?").run(f.project.project_id);
  assert.throws(() => f.service.prepare({ projectId: f.project.project_id, targetRelativePath: 'destination', requestKey: 'state-overlap', caller }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.existsSync(path.join(f.stateDir, 'ledger.sqlite')), true);
});

test('nonempty Project move keeps identity, refuses later edits and supports inverse Undo', (t) => {
  fs.mkdirSync(path.resolve('test/.tmp'), { recursive: true });
  const base = fs.mkdtempSync(path.resolve('test/.tmp/project-move-'));
  const stateDir = path.join(base, 'state'); const workspace = path.join(base, 'workspace');
  fs.mkdirSync(path.join(workspace, 'A', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'A', 'nested', 'note.md'), 'original bytes');
  const registry = new Registry({ stateDir });
  const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: root.root_id, relativePath: 'A', reason: 'Fixture.' });
  const service = createProjectMoveService({ stateDir, registry });
  t.after(() => { service.dispose(); registry.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  const input = { projectId: project.project_id, targetRelativePath: 'B', requestKey: 'prepare', caller: { tool: 'test' } };
  const preview = service.prepare(input);
  assert.equal(preview.summary.files, 1);
  assert.equal(service.prepare(input).move_id, preview.move_id);
  assert.throws(() => service.prepare({ ...input, targetRelativePath: 'C' }), { code: 'ATLAS_STATE_CONFLICT' });
  const execute = { projectId: project.project_id, expectedRevision: preview.revision, expectedDigest: preview.digest, requestKey: 'execute', caller: { tool: 'test' } };
  const result = service.execute(preview.move_id, execute);
  assert.equal(result.status, 'applied');
  assert.equal(registry.projectContext.getActiveLocation(project.project_id).relative_path, 'B');
  assert.equal(fs.existsSync(path.join(workspace, 'A')), false);
  assert.equal(fs.readFileSync(path.join(workspace, 'B', 'nested', 'note.md'), 'utf8'), 'original bytes');
  assert.equal(service.execute(preview.move_id, execute).status, 'applied');
  const undo = { ...execute, expectedRevision: result.revision, expectedDigest: result.digest, requestKey: 'undo' };
  fs.writeFileSync(path.join(workspace, 'B', 'nested', 'note.md'), 'later bytes');
  assert.throws(() => service.undo(preview.move_id, undo), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(workspace, 'B', 'nested', 'note.md'), 'utf8'), 'later bytes');
});
