import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';
import { BoardService } from '../src/board-service.js';
import { RoundRecovery } from '../src/round-recovery.js';

test('explicit Save, source, Work and Result Board recover together without rewriting original Save receipt', (t) => {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('test/.tmp/round-save-'));
  const root = path.join(temp, 'workspace'); const projectRoot = path.join(root, 'Project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const stateDir = path.join(temp, 'state'); const registry = new Registry({ stateDir });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const save = new SaveService({ stateDir, resourceControl: control });
  const boards = new BoardService({ stateDir, registry, resourceControl: control, saveService: save });
  const recovery = new RoundRecovery({ stateDir, registry });
  t.after(() => { recovery.dispose(); boards.dispose(); save.dispose(); control.dispose(); registry.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const adopted = registry.adoptRoot({ rootPath: root, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const projectId = registry.create({ name: 'Project', currentPath: 'Project' }).project_id;
  registry.attachRoot(projectId, { rootId: adopted.root_id, relativePath: 'Project', reason: 'Save recovery fixture' });
  const caller = { actor: 'agent', tool: 'test', client_run_id: 'round-save' };
  const sourcePath = path.join(projectRoot, 'source.csv'); fs.writeFileSync(sourcePath, 'amount\n10\n');
  const source = control.identify({ filePath: sourcePath, project: { id: projectId } });
  const work = registry.ledger.workSessions.create({ projectId, resourceIds: [source.resource_id], intent: 'Budget', returnState: {}, caller, at: new Date().toISOString() });
  const candidate = path.join(temp, 'result.csv'); fs.writeFileSync(candidate, 'amount\n10\n');
  const prepared = save.prepare({ root, projectId, target: 'Project/result.csv', candidateFile: candidate,
    origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'save', caller,
    inputs: [sourcePath], source: { path: sourcePath, resource_id: source.resource_id }, parameters: { work_session_id: work.session_id } });
  const saved = save.execute(prepared.save_id, { reason: 'Test review' });
  registry.ledger.workSessions.setLatestSave(work.session_id, saved.save_id, new Date().toISOString());
  let board = boards.createBoard({ projectId, title: 'Delivery' });
  board = boards.saveBoard({ projectId, boardId: board.board_id, title: board.title, baseRevision: board.revision,
    blocks: [{ type: 'result_preview', save_id: saved.save_id, version_policy: 'pinned_version' }] });
  const initialBlocks = structuredClone(board.blocks);
  const journalPath = path.join(stateDir, 'ui/saved-work.json'); const originalReceipt = fs.readFileSync(journalPath);
  const scope = { projectId, paths: ['source.csv', 'result.csv'], resourceIds: [source.resource_id, saved.resource_id],
    workIds: [work.session_id], boardIds: [board.board_id], saveIds: [saved.save_id], caller, label: 'Before budget change' };
  assert.throws(() => recovery.protect({ ...scope, saveIds: [], requestKey: 'missing-save' }), /Save|Result/u);
  assert.throws(() => recovery.protect({ ...scope, boardIds: [], requestKey: 'missing-board' }), /Board/u);
  const before = recovery.protect({ ...scope, requestKey: 'protect' });
  fs.writeFileSync(sourcePath, 'amount\n25\n'); fs.writeFileSync(path.join(projectRoot, 'result.csv'), 'amount\n25\n');
  board = boards.saveBoard({ projectId, boardId: board.board_id, title: 'Later delivery', baseRevision: board.revision,
    blocks: [{ ...board.blocks[0], version_policy: 'follow_latest' }, { type: 'text', text: 'Revised' }] });
  const laterBlocks = structuredClone(board.blocks);
  const basis = () => { const r = recovery.show({ projectId, roundId: before.round_id }); return { projectId, roundId: r.round_id, baseRevision: r.revision, expectedDigest: r.current_digest, caller }; };
  const restored = recovery.restore({ ...basis(), nodeId: before.head_node_id, requestKey: 'restore' });
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'amount\n10\n');
  assert.equal(fs.readFileSync(path.join(projectRoot, 'result.csv'), 'utf8'), 'amount\n10\n');
  assert.deepEqual(registry.ledger.boards.byId(board.board_id).blocks, initialBlocks);
  assert.equal(registry.ledger.workSessions.byId(work.session_id).latest_save_id, saved.save_id);
  recovery.returnToLatest({ ...basis(), restoreId: restored.restore_id, requestKey: 'return' });
  assert.equal(fs.readFileSync(path.join(projectRoot, 'result.csv'), 'utf8'), 'amount\n25\n');
  assert.deepEqual(registry.ledger.boards.byId(board.board_id).blocks, laterBlocks);
  assert.deepEqual(fs.readFileSync(journalPath), originalReceipt);
  assert.equal(registry.ledger.boards.byId(board.board_id).revision, 5);
  assert.equal(registry.ledger.workSessions.byId(work.session_id).preview, null);
  const altered = JSON.parse(originalReceipt);
  altered.items.find((item) => item.save_id === saved.save_id).intent = 'Receipt changed outside recovery';
  fs.writeFileSync(journalPath, JSON.stringify(altered));
  assert.throws(() => recovery.restore({ ...basis(), nodeId: before.head_node_id, requestKey: 'changed-receipt' }), /receipt changed/u);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'result.csv'), 'utf8'), 'amount\n25\n');
  assert.deepEqual(registry.ledger.boards.byId(board.board_id).blocks, laterBlocks);
});

test('a Save created inside predeclared output scope becomes absent on rewind and returns with the same receipt and Resource', (t) => {
  const temp = fs.mkdtempSync(path.resolve('test/.tmp/round-new-save-'));
  const root = path.join(temp, 'workspace'); const projectRoot = path.join(root, 'P'); fs.mkdirSync(projectRoot, { recursive: true });
  const stateDir = path.join(temp, 'state'); const registry = new Registry({ stateDir });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const save = new SaveService({ stateDir, resourceControl: control });
  const boards = new BoardService({ stateDir, registry, resourceControl: control, saveService: save });
  const recovery = new RoundRecovery({ stateDir, registry });
  t.after(() => { recovery.dispose(); boards.dispose(); save.dispose(); control.dispose(); registry.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const adopted = registry.adoptRoot({ rootPath: root, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const projectId = registry.create({ name: 'P', currentPath: 'P' }).project_id;
  registry.attachRoot(projectId, { rootId: adopted.root_id, relativePath: 'P', reason: 'New Save fixture' });
  const sourcePath = path.join(projectRoot, 'source.csv'); fs.writeFileSync(sourcePath, 'amount\n10\n');
  const source = control.identify({ filePath: sourcePath, project: { id: projectId } });
  const caller = { actor: 'agent', tool: 'test', client_run_id: 'new-save' };
  const work = registry.ledger.workSessions.create({ projectId, resourceIds: [source.resource_id], intent: 'Create budget', returnState: {}, caller, at: new Date().toISOString() });
  let board = boards.createBoard({ projectId, title: 'Delivery' });
  const scope = { projectId, paths: ['source.csv', 'result.csv'], saveTargets: ['result.csv'], resourceIds: [source.resource_id], workIds: [work.session_id], boardIds: [board.board_id], caller, label: 'Before new result' };
  assert.throws(() => recovery.protect({ ...scope, saveTargets: ['source.csv'], requestKey: 'existing-slot' }), /absent/u);
  assert.throws(() => recovery.protect({ ...scope, saveTargets: ['outside.csv'], requestKey: 'omitted-slot' }), /declared/u);
  const before = recovery.protect({ ...scope, requestKey: 'protect' });
  const candidate = path.join(temp, 'candidate.csv'); fs.writeFileSync(candidate, 'amount\n10\n');
  const prepared = save.prepare({ root, projectId, target: 'P/result.csv', candidateFile: candidate, origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'new-save', caller, inputs: [sourcePath], source: { path: sourcePath, resource_id: source.resource_id }, parameters: { work_session_id: work.session_id } });
  assert.throws(() => recovery.show({ projectId, roundId: before.round_id }), /Save|executed/u);
  const saved = save.execute(prepared.save_id, { reason: 'Create result in protected scope' });
  registry.ledger.workSessions.setLatestSave(work.session_id, saved.save_id, new Date().toISOString());
  board = boards.saveBoard({ projectId, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [{ type: 'result_preview', save_id: saved.save_id, version_policy: 'pinned_version' }] });
  const journalPath = path.join(stateDir, 'ui/saved-work.json'); const receipt = fs.readFileSync(journalPath);
  const basis = () => { const r = recovery.show({ projectId, roundId: before.round_id }); return { projectId, roundId: r.round_id, baseRevision: r.revision, expectedDigest: r.current_digest, caller }; };
  recovery.checkpoint({ ...basis(), label: 'Result created', requestKey: 'checkpoint' });
  const restored = recovery.restore({ ...basis(), nodeId: before.head_node_id, requestKey: 'restore' });
  assert.equal(fs.existsSync(path.join(projectRoot, 'result.csv')), false);
  assert.equal(registry.ledger.resources.byId(saved.resource_id).status, 'missing');
  assert.equal(registry.ledger.workSessions.byId(work.session_id).latest_save_id, null);
  assert.equal(registry.ledger.boards.byId(board.board_id).blocks.length, 0);
  assert.equal(save.show(saved.save_id).verified, false);
  assert.equal(save.show(saved.save_id).undo_available, false);
  assert.throws(() => save.undo(saved.save_id), /not available/u);
  recovery.returnToLatest({ ...basis(), restoreId: restored.restore_id, requestKey: 'return' });
  assert.equal(fs.readFileSync(path.join(projectRoot, 'result.csv'), 'utf8'), 'amount\n10\n');
  assert.equal(registry.ledger.resources.byId(saved.resource_id).status, 'active');
  assert.equal(registry.ledger.workSessions.byId(work.session_id).latest_save_id, saved.save_id);
  assert.equal(registry.ledger.boards.byId(board.board_id).blocks[0].save_id, saved.save_id);
  assert.equal(save.show(saved.save_id).verified, true);
  assert.deepEqual(fs.readFileSync(journalPath), receipt);
  // Interrupt after removing the generated result but before restoring its Source.
  fs.writeFileSync(sourcePath, 'amount\n30\n');
  const rename = fs.renameSync;
  const injected = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).includes('.atlas-restore-') && to === sourcePath) throw new Error('Injected Source replacement failure');
    return rename(from, to);
  });
  assert.throws(() => recovery.restore({ ...basis(), nodeId: before.head_node_id, requestKey: 'interrupted' }), /Injected/u);
  injected.mock.restore();
  const pending = recovery.show({ projectId, roundId: before.round_id });
  assert.ok(pending.pending_restore);
  assert.equal(fs.existsSync(path.join(projectRoot, 'result.csv')), false);
  assert.throws(() => save.undo(saved.save_id), /pending|incomplete|recovery/u);
  const reopened = new RoundRecovery({ stateDir });
  try { reopened.resume({ projectId, roundId: before.round_id, restoreId: pending.pending_restore, caller }); }
  finally { reopened.dispose(); }
  recovery.returnToLatest({ ...basis(), restoreId: pending.pending_restore, requestKey: 'return-interrupted' });
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'amount\n30\n');
  assert.equal(fs.readFileSync(path.join(projectRoot, 'result.csv'), 'utf8'), 'amount\n10\n');
  assert.deepEqual(fs.readFileSync(journalPath), receipt);
});
