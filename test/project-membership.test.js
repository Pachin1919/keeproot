import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createBoardService } from '../src/board-service.js';
import { createProjectMembershipService } from '../src/project-membership-service.js';

const caller = { actor: 'agent', tool: 'test', client_run_id: 'membership' };
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t, hooks = {}) {
  const base = fs.mkdtempSync(path.resolve('test/.tmp/membership-')); const stateDir = path.join(base, 'state'); const root = path.join(base, 'workspace');
  fs.mkdirSync(path.join(root, 'A/part/empty'), { recursive: true }); fs.mkdirSync(path.join(root, 'B'));
  fs.writeFileSync(path.join(root, 'A/part/.hidden'), 'hidden'); fs.writeFileSync(path.join(root, 'A/part/source.csv'), 'kind,value\nA,1\n'); fs.writeFileSync(path.join(root, 'A/stay.md'), 'stay');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: root, rootType: 'project_workspace' });
  const source = registry.create({ name: 'A', currentPath: 'A' }); const target = registry.create({ name: 'B', currentPath: 'B' });
  for (const p of [source, target]) registry.attachRoot(p.project_id, { rootId: adopted.root_id, relativePath: p.project_id === source.project_id ? 'A' : 'B', reason: 'Membership fixture.' });
  const control = createResourceControl({ stateDir, registry });
  const resource = control.identify({ filePath: path.join(root, 'A/part/source.csv'), project: { id: source.project_id } });
  const work = registry.ledger.workSessions.create({ projectId: source.project_id, resourceIds: [resource.resource_id], at: new Date().toISOString() });
  registry.ledger.workSessions.updateSource(work.session_id, work.sources[0].source_key, { fingerprint: { file_path: path.join(root, 'A/part/source.csv'), sha256: resource.evidence.sha256 }, status: 'ready' }, new Date().toISOString());
  const save = createSaveService({ stateDir, resourceControl: control }); const candidate = path.join(stateDir, 'candidate.csv'); fs.writeFileSync(candidate, 'kind,value\nA,2\n');
  const pending = save.prepare({ root, projectId: source.project_id, candidateFile: candidate, target: 'A/part/result.csv', inputs: [path.join(root, 'A/part/source.csv')], origin: 'agent_generated', kind: 'intermediate', channel: 'host', requestKey: 'save', caller,
    source: { path: path.join(root, 'A/part/source.csv'), resource_id: resource.resource_id, fingerprint: { file_path: path.join(root, 'A/part/source.csv'), sha256: resource.evidence.sha256 } } });
  const saved = save.execute(pending.save_id, { reason: 'Fixture.' }); registry.ledger.workSessions.setLatestSave(work.session_id, saved.save_id, new Date().toISOString());
  registry.ledger.resources.createLinkedRelationship({sourceResourceId:resource.resource_id,targetResourceId:saved.resource_id,submitter:caller,evidence:{project_id:source.project_id},at:new Date().toISOString()});
  const boards = createBoardService({ stateDir, registry, resourceControl: control, saveService: save }); const b = boards.createBoard({ projectId: source.project_id, title: 'Whole Board' });
  const board = boards.saveBoard({ projectId: source.project_id, boardId: b.board_id, title: b.title, baseRevision: b.revision, blocks: [{ type: 'material_reference', resource_id: resource.resource_id }, { type: 'text', text: 'Keep this text' }, { type: 'result_preview', save_id: saved.save_id }] });
  const service = createProjectMembershipService({ stateDir, registry, resourceControl: control, ...hooks });
  const prepare = (operation = 'split', key = operation) => service.prepare({ operation, sourceProjectId: source.project_id, sourceRelativePath: operation === 'split' ? 'part' : undefined,
    newProjectName: operation === 'split' ? 'Part' : undefined, targetProjectId: operation === 'merge' ? target.project_id : undefined, targetRelativePath: operation === 'split' ? 'Part' : 'incoming', requestKey: key, caller });
  const options = (row, requestKey) => ({ sourceProjectId: source.project_id, expectedRevision: row.revision, expectedDigest: row.digest, requestKey, caller });
  t.after(() => { service.dispose(); boards.dispose(); save.dispose(); control.dispose(); registry.dispose(); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { base, stateDir, root, registry, source, target, resource, work, saved, board, control, save, boards, service, prepare, options };
}

for (const operation of ['split', 'merge']) test(`${operation} moves the closed graph, preserves IDs hashes receipts and inversely restores ownership`, (t) => {
  const f = fixture(t); const receipt = fs.readFileSync(path.join(f.stateDir, 'ui/saved-work.json')); const bytes = fs.readFileSync(path.join(f.root, 'A/part/source.csv'));
  const preview = f.prepare(operation); assert.equal(preview.can_execute, true); assert.equal(preview.summary.resources, 2); assert.equal(preview.summary.works, 1); assert.equal(preview.summary.boards, 1); assert.equal(preview.summary.saves, 1);
  assert.equal(fs.existsSync(preview.target.path), false);
  if (operation === 'split') assert.equal(f.registry.ledger.db.prepare('SELECT id FROM projects WHERE id=?').get(preview.new_project.id), undefined);
  assert.deepEqual(f.prepare(operation), preview);
  assert.throws(() => f.service.execute(preview.operation_id, { ...f.options(preview, 'bad'), expectedDigest: 'stale' }), { code: 'ATLAS_STATE_CONFLICT' });
  const request = f.options(preview, 'execute'); const applied = f.service.execute(preview.operation_id, request); assert.equal(applied.status, 'applied'); assert.deepEqual(f.service.execute(preview.operation_id, request), applied);
  const currentProject = applied.target_project_id; const currentPath = path.join(preview.target.path, operation === 'merge' ? 'part/source.csv' : 'source.csv');
  assert.equal(digest(fs.readFileSync(currentPath)), digest(bytes)); assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'ui/saved-work.json')), receipt);
  assert.equal(f.registry.ledger.workSessions.byId(f.work.session_id).project_id, currentProject);
  assert.equal(f.registry.ledger.workSessions.byId(f.work.session_id).preview, null);
  const board = f.boards.showBoard(currentProject, f.board.board_id); assert.deepEqual(board.blocks.map(b => b.block_id), f.board.blocks.map(b => b.block_id)); assert.equal(board.blocks[1].text, 'Keep this text'); assert.equal(board.blocks[2].status, 'fresh');
  assert.equal(f.save.show(f.saved.save_id).project.id, currentProject); assert.equal(f.save.show(f.saved.save_id).origin_project.id, f.source.project_id); assert.equal(f.save.show(f.saved.save_id).current_output, 'verified');
  assert.equal(f.control.describe(f.resource.resource_id).relationships.find(r=>r.type==='linked_to').evidence.project_id,currentProject);
  assert.throws(() => f.save.undo(f.saved.save_id), { code: 'ATLAS_STATE_CONFLICT' }); assert.throws(() => f.save.execute(f.saved.save_id, { reason: 'Old location.' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(f.control.projectResources(f.source.project_id).some(r => r.resource_id === f.resource.resource_id), false);
  const undone = f.service.undo(preview.operation_id, f.options(applied, 'undo')); assert.equal(undone.status, 'undone');
  assert.equal(f.registry.ledger.workSessions.byId(f.work.session_id).project_id, f.source.project_id); assert.equal(f.boards.showBoard(f.source.project_id, f.board.board_id).blocks[2].status, 'fresh');
  assert.equal(f.registry.ledger.getProject(f.source.project_id).status, 'active');
  if (operation === 'split') { assert.notEqual(f.registry.ledger.getProject(currentProject).status, 'active'); assert.equal(f.registry.projectContext.getActiveLocation(currentProject), null); }
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'ui/saved-work.json')), receipt);
  if (operation === 'split') {
    const next = f.prepare('merge', 'after-split-undo');
    const moved = f.service.execute(next.operation_id, f.options(next, 'next-execute'));
    assert.equal(f.service.undo(next.operation_id, f.options(moved, 'next-undo')).status, 'undone');
    assert.equal(f.save.show(f.saved.save_id).current_output, 'verified');
    assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'ui/saved-work.json')), receipt);
  }
});

test('open Work cross-tree source and third-party Board create specific blockers without moving or creating Project', (t) => {
  const f = fixture(t); const foreign = f.control.identify({ filePath: path.join(f.root, 'A/stay.md'), project: { id: f.source.project_id } });
  f.registry.ledger.workSessions.create({ projectId: f.source.project_id, resourceIds: [f.resource.resource_id, foreign.resource_id], at: new Date().toISOString() });
  const board=f.boards.createBoard({projectId:f.target.project_id,title:'Third-party consumer'});
  f.registry.ledger.db.prepare('UPDATE project_boards SET blocks_json=? WHERE id=?').run(JSON.stringify([{block_id:'foreign-block',type:'material_reference',resource_id:f.resource.resource_id}]),board.board_id);
  const preview = f.prepare(); assert.equal(preview.can_execute, false); assert.ok(preview.blockers.some(b => /Work.*outside|Work.*closed/iu.test(b)));
  assert.ok(preview.blockers.some(b=>/Board.*third-party/iu.test(b)));
  assert.throws(() => f.service.execute(preview.operation_id, f.options(preview, 'execute')), { code: 'ATLAS_STATE_CONFLICT' }); assert.equal(fs.existsSync(preview.target.path), false);
  assert.equal(f.registry.ledger.db.prepare('SELECT id FROM projects WHERE id=?').get(preview.new_project.id), undefined);
});

for (const hook of ['afterPhysicalMove', 'afterDatabaseMove']) test(`${hook} interruption locks both Projects and recovers the exact pending split once`, (t) => {
  const f = fixture(t, { [hook]: () => { throw new Error('Injected membership interruption'); } }); const preview = f.prepare('merge');
  assert.throws(() => f.service.execute(preview.operation_id, f.options(preview, 'execute')), /Injected membership/u);
  const pending = f.service.show(preview.operation_id, { sourceProjectId: f.source.project_id }); assert.equal(pending.status, 'needs_recovery');
  for (const project of [f.source, f.target]) assert.throws(() => f.registry.ledger.workSessions.create({ projectId: project.project_id, at: new Date().toISOString() }), { code: 'ATLAS_STATE_CONFLICT' });
  const options = f.options(pending, 'recover'); const recovered = f.service.recover(preview.operation_id, options); assert.equal(recovered.status, 'applied'); assert.deepEqual(f.service.recover(preview.operation_id, options), recovered);
});

test('occupied, linked, nested and cross-Root paths refuse, while later file or Work edits block Undo', (t) => {
  const f = fixture(t);
  const input = { operation: 'split', sourceProjectId: f.source.project_id, sourceRelativePath: 'part', newProjectName: 'Part', targetRelativePath: 'B', requestKey: 'occupied', caller };
  assert.throws(() => f.service.prepare(input), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.service.prepare({ ...input, targetRelativePath: '../escape', requestKey: 'escape' }));
  fs.symlinkSync(path.join(f.root, 'A/part'), path.join(f.root, 'A/linked'), 'junction'); assert.throws(() => f.service.prepare({ ...input, sourceRelativePath: 'linked', targetRelativePath: 'Part', requestKey: 'link' }));
  fs.unlinkSync(path.join(f.root, 'A/linked'));
  assert.throws(() => f.service.prepare({ ...input, targetRelativePath: 'A/part/nested', requestKey: 'nested' }));
  const otherRoot = path.join(f.base, 'other'); fs.mkdirSync(otherRoot); fs.mkdirSync(path.join(otherRoot, 'C')); const adopted = f.registry.adoptRoot({ rootPath: otherRoot, rootType: 'project_workspace' }); const other = f.registry.create({ name: 'C', currentPath: 'C' }); f.registry.attachRoot(other.project_id, { rootId: adopted.root_id, relativePath: 'C', reason: 'Cross Root.' });
  assert.throws(() => f.service.prepare({ operation: 'merge', sourceProjectId: f.source.project_id, targetProjectId: other.project_id, targetRelativePath: 'incoming', requestKey: 'cross', caller }), { code: 'ATLAS_STATE_CONFLICT' });
  const preview = f.prepare(); const applied = f.service.execute(preview.operation_id, f.options(preview, 'execute')); fs.writeFileSync(path.join(preview.target.path, 'later.md'), 'later');
  assert.throws(() => f.service.undo(preview.operation_id, f.options(applied, 'undo')), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(preview.target.path, 'later.md'), 'utf8'), 'later');
});
