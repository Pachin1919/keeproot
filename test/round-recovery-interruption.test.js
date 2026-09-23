import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { RoundRecovery } from '../src/round-recovery.js';

test('incomplete recovery blocks Board writes and resumes after reopen without losing insurance', (t) => {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('test/.tmp/round-interruption-'));
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'P');
  fs.mkdirSync(projectRoot, { recursive: true });
  const stateDir = path.join(root, 'state');
  let registry = new Registry({ stateDir });
  let service = new RoundRecovery({ stateDir, registry });
  t.after(() => { service.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const projectId = registry.create({ name: 'P', currentPath: 'P' }).project_id;
  registry.attachRoot(projectId, { rootId: adopted.root_id, relativePath: 'P', reason: 'Interruption fixture.' });
  for (const name of ['a.md', 'b.csv']) fs.writeFileSync(path.join(projectRoot, name), `before ${name}`);
  const board = registry.ledger.boards.create({ projectId, title: 'Before', at: new Date().toISOString() });
  const caller = { actor: 'agent', tool: 'test', client_run_id: 'interruption' };
  const first = service.protect({ projectId, paths: ['a.md', 'b.csv'], boardIds: [board.board_id], label: 'before', requestKey: 'start', caller });
  for (const name of ['a.md', 'b.csv']) fs.writeFileSync(path.join(projectRoot, name), `after ${name}`);
  registry.ledger.boards.save({ projectId, boardId: board.board_id, title: 'After', blocks: [], baseRevision: 1, at: new Date().toISOString() });
  const current = service.show({ projectId, roundId: first.round_id });
  const originalRename = fs.renameSync;
  const rename = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).includes('.atlas-restore-') && to === path.join(projectRoot, 'b.csv')) throw new Error('Injected file replacement failure');
    return originalRename(from, to);
  });
  assert.throws(() => service.restore({ projectId, roundId: first.round_id, nodeId: first.head_node_id,
    baseRevision: current.revision, expectedDigest: current.current_digest, requestKey: 'restore', caller }), /Injected/);
  rename.mock.restore();
  assert.equal(fs.readFileSync(path.join(projectRoot, 'a.md'), 'utf8'), 'before a.md');
  assert.equal(fs.readFileSync(path.join(projectRoot, 'b.csv'), 'utf8'), 'after b.csv');
  const pending = service.show({ projectId, roundId: first.round_id });
  assert.ok(pending.pending_restore);
  assert.throws(() => registry.ledger.boards.save({ projectId, boardId: board.board_id, title: 'Must not write', blocks: [], baseRevision: 2, at: new Date().toISOString() }), /recovery|recover|恢复/i);
  service.dispose(); registry.dispose();
  registry = new Registry({ stateDir }); service = new RoundRecovery({ stateDir, registry });
  const resumed = service.resume({ projectId, roundId: first.round_id, restoreId: pending.pending_restore, caller });
  assert.equal(resumed.pending_restore, null);
  assert.equal(registry.ledger.boards.byId(board.board_id).title, 'Before');
  assert.equal(registry.ledger.boards.byId(board.board_id).revision, 3);
  const returned = service.returnToLatest({ projectId, roundId: first.round_id, restoreId: resumed.restore_id,
    baseRevision: resumed.revision, expectedDigest: resumed.current_digest, requestKey: 'return', caller });
  assert.equal(returned.pending_restore, null);
  for (const name of ['a.md', 'b.csv']) assert.equal(fs.readFileSync(path.join(projectRoot, name), 'utf8'), `after ${name}`);
  assert.equal(registry.ledger.boards.byId(board.board_id).title, 'After');
});
