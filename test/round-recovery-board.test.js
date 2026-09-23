import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { RoundRecovery } from '../src/round-recovery.js';
import { BoardService } from '../src/board-service.js';
import { createResourceControl } from '../src/resource-control.js';

test('round restores selected Material Board references with their files and retains later insurance', (t) => {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('test/.tmp/round-material-board-'));
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'P');
  fs.mkdirSync(projectRoot, { recursive: true });
  const stateDir = path.join(root, 'state');
  const registry = new Registry({ stateDir });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const boards = new BoardService({ stateDir, registry, resourceControl });
  const recovery = new RoundRecovery({ stateDir, registry });
  t.after(() => { boards.dispose(); recovery.dispose(); resourceControl.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const projectId = registry.create({ name: 'P', currentPath: 'P' }).project_id;
  registry.attachRoot(projectId, { rootId: adopted.root_id, relativePath: 'P', reason: 'Material Board recovery fixture' });
  const file = path.join(projectRoot, 'plan.md'); fs.writeFileSync(file, 'before');
  const resourceId = resourceControl.identify({ filePath: file, project: { id: projectId } }).resource_id;
  let board = boards.createBoard({ projectId, title: 'Plan' });
  board = boards.saveBoard({ projectId, boardId: board.board_id, title: board.title, baseRevision: board.revision,
    blocks: [{ type: 'material_reference', resource_id: resourceId, version_policy: 'pinned_version' }, { type: 'text', text: 'Original plan' }] });
  const originalBlocks = structuredClone(board.blocks);
  const caller = { actor: 'agent', tool: 'test', client_run_id: 'material-board' };
  const scope = { projectId, paths: ['plan.md'], resourceIds: [resourceId], boardIds: [board.board_id], label: 'Plan before changes', caller };
  assert.throws(() => recovery.protect({ ...scope, boardIds: [], requestKey: 'omitted-board' }), /Board/u);
  assert.throws(() => recovery.protect({ ...scope, paths: [], resourceIds: [], requestKey: 'omitted-resource' }), /Resource|reference/u);
  const first = recovery.protect({ ...scope, requestKey: 'protect' });
  fs.writeFileSync(file, 'after');
  board = boards.saveBoard({ projectId, boardId: board.board_id, title: 'Revised plan', baseRevision: board.revision,
    blocks: [{ ...board.blocks[0], version_policy: 'follow_latest' }, { type: 'text', text: 'Later plan' }] });
  const laterBlocks = structuredClone(board.blocks);
  const basis = () => { const r = recovery.show({ projectId, roundId: first.round_id }); return { projectId, roundId: first.round_id, baseRevision: r.revision, expectedDigest: r.current_digest, caller }; };
  const restored = recovery.restore({ ...basis(), nodeId: first.head_node_id, requestKey: 'restore' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.deepEqual(registry.ledger.boards.byId(board.board_id).blocks, originalBlocks);
  assert.equal(registry.ledger.boards.byId(board.board_id).revision, 4);
  const returned = recovery.returnToLatest({ ...basis(), restoreId: restored.restore_id, requestKey: 'return' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  assert.deepEqual(registry.ledger.boards.byId(board.board_id).blocks, laterBlocks);
  assert.equal(registry.ledger.boards.byId(board.board_id).revision, 5);
  assert.equal(resourceControl.describe(resourceId).resource.id, resourceId);
  assert.equal(returned.pending_restore, null);
  // A later consumer outside the explicit Board set must block before bytes change.
  const other = boards.createBoard({ projectId, title: 'Another consumer' });
  boards.saveBoard({ projectId, boardId: other.board_id, title: other.title, baseRevision: other.revision,
    blocks: [{ type: 'material_reference', resource_id: resourceId }] });
  assert.throws(() => recovery.show({ projectId, roundId: first.round_id }), /Board/u);
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
});
