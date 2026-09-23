import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BoardRepository } from '../src/storage/repositories/board-repository.js';
import { Registry } from '../src/registry.js';
import { RoundRecovery } from '../src/round-recovery.js';

const caller = (id) => ({ actor: 'agent', tool: 'test', client_run_id: id });

function filesUnder(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

function fixture(t, id = 'round-recovery') {
  const tempRoot = path.resolve('test', '.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, `atlas-${id}-`));
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'Project A');
  const foreignRoot = path.join(workspace, 'Project B');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(foreignRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'doc.md'), '# one\n');
  fs.writeFileSync(path.join(projectRoot, 'rows.csv'), 'name,value\nA,1\n');
  fs.writeFileSync(path.join(projectRoot, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(foreignRoot, 'foreign.txt'), 'foreign\n');
  const stateDir = path.join(root, 'state');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Project A', currentPath: 'Project A' });
  const foreignProject = registry.create({ name: 'Project B', currentPath: 'Project B' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Project A', reason: 'Round recovery fixture.' });
  registry.attachRoot(foreignProject.project_id, { rootId: adopted.root_id, relativePath: 'Project B', reason: 'Round recovery boundary fixture.' });
  const boardRepository = new BoardRepository({ db: registry.ledger.db, transaction: (callback) => registry.ledger.transaction(callback) });
  const board = boardRepository.create({ projectId: project.project_id, title: 'Study board', at: new Date().toISOString() });
  const foreignBoard = boardRepository.create({ projectId: foreignProject.project_id, title: 'Foreign board', at: new Date().toISOString() });
  const recovery = new RoundRecovery({ stateDir, registry });
  t.after(() => {
    recovery?.dispose();
    registry?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, projectRoot, stateDir, registry, adopted, project, foreignProject, board, foreignBoard, boardRepository, recovery };
}

test('protect/checkpoint/restore round-trips markdown, CSV, binary, new file, and Board', (t) => {
  const f = fixture(t);
  const id = f.project.project_id;
  const initial = f.recovery.protect({ projectId: id, paths: ['doc.md', 'rows.csv', 'image.bin', 'new.txt'], boardIds: [f.board.board_id], label: 'initial', requestKey: 'protect-1', caller: caller('round-1') });
  assert.equal(initial.revision, 1);
  assert.equal(initial.nodes.length, 1);
  fs.writeFileSync(path.join(f.projectRoot, 'doc.md'), '# two\n');
  fs.writeFileSync(path.join(f.projectRoot, 'rows.csv'), 'name,value\nB,2\n');
  fs.writeFileSync(path.join(f.projectRoot, 'image.bin'), Buffer.from([9, 8, 7]));
  fs.writeFileSync(path.join(f.projectRoot, 'new.txt'), 'new-file-changed\n');
  const changedBoard = f.boardRepository.save({ projectId: id, boardId: f.board.board_id, title: 'Changed board', blocks: [{ type: 'text', text: 'changed' }], baseRevision: 1, at: new Date().toISOString() });
  const beforeCheckpoint = f.recovery.show({ projectId: id, roundId: initial.round_id });
  const checkpoint = f.recovery.checkpoint({ projectId: id, roundId: initial.round_id, baseRevision: beforeCheckpoint.revision, expectedDigest: beforeCheckpoint.current_digest, label: 'checkpoint', requestKey: 'checkpoint-1', caller: caller('round-1') });
  assert.equal(checkpoint.revision, 2);
  assert.ok(checkpoint.nodes.length >= 2);
  assert.equal(changedBoard.revision, 2);
  fs.writeFileSync(path.join(f.projectRoot, 'doc.md'), '# unsaved after checkpoint\n');
  const current = f.recovery.show({ projectId: id, roundId: initial.round_id });
  const restored = f.recovery.restore({ projectId: id, roundId: initial.round_id, nodeId: initial.head_node_id, baseRevision: current.revision, expectedDigest: current.current_digest, requestKey: 'restore-1', caller: caller('round-1') });
  assert.ok(restored.restore_id);
  assert.ok(restored.return_node_id);
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'doc.md'), 'utf8'), '# one\n');
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'rows.csv'), 'utf8'), 'name,value\nA,1\n');
  assert.deepEqual(fs.readFileSync(path.join(f.projectRoot, 'image.bin')), Buffer.from([0, 1, 2, 3]));
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'new.txt')), false);
  assert.equal(f.boardRepository.byId(f.board.board_id).revision, 3);
  assert.deepEqual(f.boardRepository.byId(f.board.board_id).blocks, []);
  const afterRestore = f.recovery.show({ projectId: id, roundId: initial.round_id });
  assert.equal(afterRestore.pending_restore, null);
  assert.ok(afterRestore.nodes.some((node) => node.node_id === restored.return_node_id));
  const returned = f.recovery.returnToLatest({ projectId: id, roundId: initial.round_id, restoreId: restored.restore_id, baseRevision: afterRestore.revision, expectedDigest: afterRestore.current_digest, requestKey: 'return-1', caller: caller('round-1') });
  assert.ok(returned.revision > restored.revision);
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'doc.md'), 'utf8'), '# unsaved after checkpoint\n');
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'rows.csv'), 'utf8'), 'name,value\nB,2\n');
  assert.deepEqual(fs.readFileSync(path.join(f.projectRoot, 'image.bin')), Buffer.from([9, 8, 7]));
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'new.txt')), true);
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'new.txt'), 'utf8'), 'new-file-changed\n');
  assert.equal(f.boardRepository.byId(f.board.board_id).revision, 4);
  assert.deepEqual(f.boardRepository.byId(f.board.board_id).blocks, [{ type: 'text', text: 'changed' }]);
});

test('restore preserves old-node branches and insurance for unsaved current changes', (t) => {
  const f = fixture(t, 'branches'); const id = f.project.project_id;
  const first = f.recovery.protect({ projectId: id, paths: ['doc.md'], boardIds: [], label: 'first', requestKey: 'branch-protect', caller: caller('branches') });
  fs.writeFileSync(path.join(f.projectRoot, 'doc.md'), '# two\n');
  const beforeSecond = f.recovery.show({ projectId: id, roundId: first.round_id });
  const second = f.recovery.checkpoint({ projectId: id, roundId: first.round_id, baseRevision: beforeSecond.revision, expectedDigest: beforeSecond.current_digest, label: 'second', requestKey: 'branch-second', caller: caller('branches') });
  fs.writeFileSync(path.join(f.projectRoot, 'doc.md'), '# unsaved\n');
  const beforeRestore = f.recovery.show({ projectId: id, roundId: first.round_id });
  const restored = f.recovery.restore({ projectId: id, roundId: first.round_id, nodeId: first.head_node_id, baseRevision: beforeRestore.revision, expectedDigest: beforeRestore.current_digest, requestKey: 'branch-restore', caller: caller('branches') });
  const shown = f.recovery.show({ projectId: id, roundId: first.round_id });
  assert.ok(shown.nodes.some((node) => node.node_id === second.head_node_id));
  assert.ok(shown.nodes.some((node) => node.node_id === restored.return_node_id));
  assert.equal(shown.pending_restore, null);
  const returned = f.recovery.returnToLatest({ projectId: id, roundId: first.round_id, restoreId: restored.restore_id, baseRevision: shown.revision, expectedDigest: shown.current_digest, requestKey: 'branch-return', caller: caller('branches') });
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'doc.md'), 'utf8'), '# unsaved\n');
  assert.ok(returned.revision > shown.revision);
  const afterReturn = f.recovery.show({ projectId: id, roundId: first.round_id });
  fs.writeFileSync(path.join(f.projectRoot, 'doc.md'), '# branched\n');
  const beforeBranch = f.recovery.show({ projectId: id, roundId: first.round_id });
  const branched = f.recovery.checkpoint({ projectId: id, roundId: first.round_id, baseRevision: beforeBranch.revision, expectedDigest: beforeBranch.current_digest, label: 'new branch', requestKey: 'branch-third', caller: caller('branches') });
  assert.ok(branched.nodes.some((node) => node.node_id === first.head_node_id));
  assert.ok(branched.nodes.some((node) => node.node_id === restored.return_node_id));
  const branchNode = branched.nodes.find((node) => node.node_id === branched.head_node_id);
  assert.equal(branchNode.parent_node_id, afterReturn.head_node_id);
  assert.notEqual(branchNode.node_id, first.head_node_id);
});

test('round state survives close and reopen', (t) => {
  const f = fixture(t, 'reopen'); const id = f.project.project_id;
  const created = f.recovery.protect({ projectId: id, paths: ['doc.md'], boardIds: [f.board.board_id], label: 'persist', requestKey: 'persist-1', caller: caller('reopen') });
  f.recovery.dispose(); f.registry.dispose(); f.recovery = null; f.registry = null;
  const reopenedRegistry = new Registry({ stateDir: f.stateDir }); const reopened = new RoundRecovery({ stateDir: f.stateDir, registry: reopenedRegistry });
  try {
    assert.equal(reopened.show({ projectId: id, roundId: created.round_id }).round_id, created.round_id);
  } finally {
    reopened.dispose();
    reopenedRegistry.dispose();
  }
});

test('stale revision or digest refuses writes', (t) => {
  const f = fixture(t, 'stale'); const id = f.project.project_id;
  const created = f.recovery.protect({ projectId: id, paths: ['doc.md'], boardIds: [], label: 'stale', requestKey: 'stale-1', caller: caller('stale') });
  fs.writeFileSync(path.join(f.projectRoot, 'doc.md'), '# changed\n');
  const current = f.recovery.show({ projectId: id, roundId: created.round_id });
  assert.throws(() => f.recovery.checkpoint({ projectId: id, roundId: created.round_id, baseRevision: 0, expectedDigest: current.current_digest, label: 'bad revision', requestKey: 'stale-2', caller: caller('stale') }));
  assert.throws(() => f.recovery.checkpoint({ projectId: id, roundId: created.round_id, baseRevision: 1, expectedDigest: created.current_digest, label: 'old digest', requestKey: 'stale-3', caller: caller('stale') }));
  assert.equal(f.recovery.show({ projectId: id, roundId: created.round_id }).revision, 1);
});

test('scope extension protects newly admitted files without rewriting old nodes; return retains both paths', (t) => {
  const f = fixture(t, 'extend'); const projectId = f.project.project_id;
  const first = f.recovery.protect({ projectId, paths: ['doc.md'], label: 'First stage', requestKey: 'start', caller: caller('extend') });
  const beforeJson = f.registry.ledger.db.prepare('SELECT state_json FROM recovery_rounds WHERE id=?').get(first.round_id).state_json;
  const basis = () => { const r = f.recovery.show({ projectId, roundId: first.round_id }); return { projectId, roundId: r.round_id, baseRevision: r.revision, expectedDigest: r.current_digest, caller: caller('extend') }; };
  fs.writeFileSync(path.join(f.projectRoot, 'doc.md'), '# later\n');
  fs.writeFileSync(path.join(f.projectRoot, 'rows.csv'), 'value\n20\n');
  const extensionRequest = { ...basis(), paths: ['rows.csv', 'new.txt'], saveTargets: ['new.txt'], label: 'Before budgeting', requestKey: 'extend' };
  assert.equal(typeof f.recovery.extend, 'function');
  const extended = f.recovery.extend(extensionRequest);
  assert.deepEqual(JSON.parse(f.registry.ledger.db.prepare('SELECT state_json FROM recovery_rounds WHERE id=?').get(first.round_id).state_json).nodes[0], JSON.parse(beforeJson).nodes[0]);
  assert.equal(f.recovery.extend(extensionRequest).replayed, true);
  assert.throws(() => f.recovery.extend({ ...extensionRequest, requestKey: 'stale' }), /revision/u);
  fs.writeFileSync(path.join(f.projectRoot, 'rows.csv'), 'value\n50\n');
  fs.writeFileSync(path.join(f.projectRoot, 'new.txt'), 'later');
  const restored = f.recovery.restore({ ...basis(), nodeId: first.head_node_id, requestKey: 'restore' });
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'doc.md'), 'utf8'), '# one\n');
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'rows.csv'), 'utf8'), 'value\n20\n');
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'new.txt')), false);
  f.recovery.returnToLatest({ ...basis(), restoreId: restored.restore_id, requestKey: 'return' });
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'rows.csv'), 'utf8'), 'value\n50\n');
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'new.txt'), 'utf8'), 'later');
  assert.ok(extended.scope_extensions[0].paths.includes('rows.csv'));
  const stable = basis();
  assert.throws(() => f.recovery.extend({ ...stable, paths: ['../foreign.txt'], label: 'bad', requestKey: 'bad' }), /escaping/u);
  assert.equal(basis().baseRevision, stable.baseRevision);
});

test('rejects path escape, foreign Project Board, and symlink paths', (t) => {
  const f = fixture(t, 'boundaries'); const id = f.project.project_id;
  assert.throws(() => f.recovery.protect({ projectId: id, paths: ['../Project B/foreign.txt'], boardIds: [], label: 'escape', requestKey: 'boundary-1', caller: caller('boundaries') }));
  assert.throws(() => f.recovery.protect({ projectId: id, paths: [], boardIds: [f.foreignBoard.board_id], label: 'foreign board', requestKey: 'boundary-2', caller: caller('boundaries') }));
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  const link = path.join(f.projectRoot, 'linked');
  try { fs.symlinkSync(outside, link, 'junction'); } catch (error) { t.skip(`junction unavailable: ${error.code ?? error.message}`); return; }
  assert.throws(() => f.recovery.protect({ projectId: id, paths: ['linked/secret.txt'], boardIds: [], label: 'symlink', requestKey: 'boundary-3', caller: caller('boundaries') }));
});

test('requestKey is idempotent only for the same payload', (t) => {
  const f = fixture(t, 'idempotency'); const id = f.project.project_id;
  const args = { projectId: id, paths: ['doc.md'], boardIds: [], label: 'same', requestKey: 'same-key', caller: caller('idempotency') };
  const first = f.recovery.protect(args); const again = f.recovery.protect(args);
  assert.equal(again.round_id, first.round_id);
  assert.throws(() => f.recovery.protect({ ...args, paths: ['rows.csv'] }));
});

test('protect rejects unknown scope fields instead of silently ignoring them', (t) => {
  const f = fixture(t, 'unknown-scope');
  assert.throws(() => f.recovery.protect({ projectId: f.project.project_id, paths: ['doc.md'], boardIds: [], unsupportedIds: ['UNSUPPORTED-unknown'], label: 'unknown scope', requestKey: 'unknown-scope-1', caller: caller('unknown-scope') }));
});

test('parent Project recovery rejects files belonging to a registered nested child Project', (t) => {
  const f = fixture(t, 'nested-project');
  const childRoot = path.join(f.projectRoot, 'Child');
  fs.mkdirSync(childRoot, { recursive: true });
  fs.writeFileSync(path.join(childRoot, 'child.txt'), 'child\n');
  const child = f.registry.create({ name: 'Child', currentPath: 'Project A/Child' });
  f.registry.attachRoot(child.project_id, { rootId: f.adopted.root_id, relativePath: 'Project A/Child', reason: 'Nested Project boundary fixture.' });
  assert.throws(() => f.recovery.protect({ projectId: f.project.project_id, paths: ['Child/child.txt'], boardIds: [], label: 'nested child', requestKey: 'nested-child-1', caller: caller('nested-project') }));
});

test('corrupted snapshot blob rejects restore without partial writes', (t) => {
  const f = fixture(t, 'corrupt'); const id = f.project.project_id;
  const created = f.recovery.protect({ projectId: id, paths: ['doc.md'], boardIds: [], label: 'corrupt', requestKey: 'corrupt-1', caller: caller('corrupt') });
  const blobs = filesUnder(f.stateDir).filter((file) => !file.endsWith('ledger.sqlite') && !file.endsWith('-wal') && !file.endsWith('-shm'));
  assert.ok(blobs.length > 0, 'protect must create a recoverable blob');
  fs.writeFileSync(blobs[0], Buffer.from('corrupted snapshot'));
  const before = fs.readFileSync(path.join(f.projectRoot, 'doc.md'), 'utf8');
  assert.throws(() => f.recovery.restore({ projectId: id, roundId: created.round_id, nodeId: created.head_node_id, baseRevision: 1, expectedDigest: created.current_digest, requestKey: 'corrupt-restore', caller: caller('corrupt') }));
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'doc.md'), 'utf8'), before);
  assert.equal(f.recovery.show({ projectId: id, roundId: created.round_id }).revision, 1);
});
