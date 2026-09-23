// Isolated installed-state acceptance for Save recovery.
// Round operations intentionally go through a fresh atlas.cmd --json process.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(repo, 'test', '.tmp');
const install = path.resolve(process.argv[2] ?? '');
assert.ok(install.startsWith(`${tempRoot}${path.sep}`), 'Use an isolated install inside test/.tmp.');
for (let entry = install; entry !== repo; entry = path.dirname(entry)) assert.equal(fs.lstatSync(entry).isSymbolicLink(), false);
const wrapper = path.join(install, 'atlas.cmd');
assert.ok(fs.existsSync(wrapper), `Missing installed atlas.cmd: ${wrapper}`);

const fixture = fs.mkdtempSync(path.join(tempRoot, 'r19-new-save-'));
const workspace = path.join(fixture, 'workspace');
const projectRelative = 'SaveRecovery';
const projectRoot = path.join(workspace, projectRelative);
const stateDir = path.join(install, 'state');
fs.mkdirSync(projectRoot, { recursive: true });
const sourcePath = path.join(projectRoot, 'source.csv');
const resultPath = path.join(projectRoot, 'result.csv');
const sourceBytes = Buffer.from('item,amount\nroom,100\n');
const resultBytes = Buffer.from('item,amount\nroom,100\n');
fs.writeFileSync(sourcePath, sourceBytes);

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const calls = [];
function cli(args, expectedOk = true) {
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `& ${quote(wrapper)} ${[...args, '--json'].map(quote).join(' ')}`], {
    cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ok(child.stdout, child.stderr || child.error?.message);
  const envelope = JSON.parse(child.stdout.replace(/^\uFEFF/u, ''));
  assert.equal(envelope.protocol_version, 'atlas-cli.v1');
  assert.equal(envelope.ok, expectedOk, child.stdout + child.stderr);
  assert.equal(child.status === 0, expectedOk, child.stdout + child.stderr);
  calls.push({ action: args.slice(0, 2).join(' '), ok: envelope.ok, error: envelope.error?.code ?? null });
  return envelope.data;
}

const caller = { actor: 'agent', tool: 'r19-new-save-acceptance', client_run_id: path.basename(fixture) };
const request = (action, data) => {
  const file = path.join(fixture, `request-${action}-${calls.length}.json`);
  fs.writeFileSync(file, JSON.stringify({ projectId, caller, requestKey: `${action}-${calls.length}`, ...data }));
  return cli(['round', action, '--request-file', file]);
};

const { Registry } = await import(pathToFileURL(path.join(install, 'runtime/src/registry.js')));
const { createResourceControl } = await import(pathToFileURL(path.join(install, 'runtime/src/resource-control.js')));
const { SaveService } = await import(pathToFileURL(path.join(install, 'runtime/src/save-service.js')));
const { BoardService } = await import(pathToFileURL(path.join(install, 'runtime/src/board-service.js')));

let projectId;
let sourceResourceId;
let workId;
let board;
let saved;
const setupRegistry = new Registry({ stateDir });
const setupControl = createResourceControl({ stateDir, ledger: setupRegistry.ledger });
const setupSave = new SaveService({ stateDir, resourceControl: setupControl });
const setupBoards = new BoardService({ stateDir, registry: setupRegistry, resourceControl: setupControl, saveService: setupSave });
try {
  const root = setupRegistry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  projectId = setupRegistry.create({ name: 'Save recovery fixture', currentPath: projectRelative }).project_id;
  setupRegistry.attachRoot(projectId, { rootId: root.root_id, relativePath: projectRelative, reason: 'Installed Save recovery acceptance.' });
  const source = setupControl.identify({ filePath: sourcePath, project: { id: projectId } });
  sourceResourceId = source.resource_id;
  const work = setupRegistry.ledger.workSessions.create({ projectId, resourceIds: [sourceResourceId], intent: 'Save recovery', returnState: {}, caller, at: new Date().toISOString() });
  workId = work.session_id;
  board = setupBoards.createBoard({ projectId, title: 'Save delivery' });
} finally {
  setupBoards.dispose(); setupSave.dispose(); setupControl.dispose(); setupRegistry.dispose();
}

const start = request('protect', {
  paths: ['source.csv', 'result.csv'],
  saveTargets: ['result.csv'],
  resourceIds: [sourceResourceId],
  workIds: [workId],
  boardIds: [board.board_id],
  label: 'Before Save delivery',
});
const receiptPath = path.join(stateDir, 'ui', 'saved-work.json');
const candidatePath = path.join(fixture, 'candidate.csv');
fs.writeFileSync(candidatePath, resultBytes);

const saveRegistry = new Registry({ stateDir });
const saveControl = createResourceControl({ stateDir, ledger: saveRegistry.ledger });
const saveService = new SaveService({ stateDir, resourceControl: saveControl });
try {
  const prepared = saveService.prepare({
    root: workspace, projectId, target: `${projectRelative}/result.csv`, candidateFile: candidatePath,
    origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'initial-save', caller,
    inputs: [sourcePath], source: { path: sourcePath, resource_id: sourceResourceId }, parameters: { work_session_id: workId },
  });
  saved = saveService.execute(prepared.save_id, { reason: 'Installed Save recovery acceptance' });
  saveRegistry.ledger.workSessions.setLatestSave(workId, saved.save_id, new Date().toISOString());
} finally {
  saveService.dispose(); saveControl.dispose(); saveRegistry.dispose();
}

const boardFile = path.join(fixture, 'result-board.json');
fs.writeFileSync(boardFile, JSON.stringify({ title: board.title, blocks: [{ type: 'result_preview', save_id: saved.save_id, version_policy: 'pinned_version' }] }));
board = cli(['board', 'save', board.board_id, '--project', projectId, '--base-revision', String(board.revision), '--request-file', boardFile]);
const receiptBefore = fs.readFileSync(receiptPath);
const savedResourceId = saved.resource_id;
const initialBoardBlocks = structuredClone(board.blocks);

const read = () => cli(['round', 'show', start.round_id, '--project', projectId]);
const basis = (value = read()) => ({ roundId: start.round_id, baseRevision: value.revision, expectedDigest: value.current_digest });
const checkpoint = request('checkpoint', { ...basis(), label: 'Save created' });
assert.ok(checkpoint.revision > start.revision);

const restored = request('restore', { ...basis(), nodeId: start.head_node_id });
assert.equal(fs.existsSync(resultPath), false);
const afterRestore = cli(['round', 'show', start.round_id, '--project', projectId]);
assert.equal(afterRestore.pending_restore, null);
const restoreRegistry = new Registry({ stateDir });
try {
  assert.equal(restoreRegistry.ledger.workSessions.byId(workId).latest_save_id, null);
  assert.deepEqual(restoreRegistry.ledger.boards.byId(board.board_id).blocks, []);
} finally { restoreRegistry.dispose(); }
const restoredSave = cli(['save', 'show', saved.save_id]);
assert.equal(restoredSave.verified, false);

const returned = request('return', { ...basis(), restoreId: restored.restore_id });
assert.equal(returned.pending_restore, null);
assert.deepEqual(fs.readFileSync(resultPath), resultBytes);
const finalRegistry = new Registry({ stateDir });
try {
  const finalWork = finalRegistry.ledger.workSessions.byId(workId);
  const finalBoard = finalRegistry.ledger.boards.byId(board.board_id);
  assert.equal(finalWork.latest_save_id, saved.save_id);
  assert.equal(finalBoard.blocks[0].save_id, saved.save_id);
} finally { finalRegistry.dispose(); }
const returnedSave = cli(['save', 'show', saved.save_id]);
assert.equal(returnedSave.verified, true);
assert.equal(returnedSave.resource_id, savedResourceId);
assert.deepEqual(fs.readFileSync(receiptPath), receiptBefore);
assert.deepEqual(fs.readFileSync(resultPath), resultBytes);

const receipt = path.join(fixture, 'acceptance.json');
const record = {
  evidence_type: 'isolated_installed_cli_new_save', created_at: new Date().toISOString(), install, fixture,
  project_id: projectId, round_id: start.round_id, save_id: saved.save_id, resource_id: savedResourceId,
  restore_id: restored.restore_id, round_revision: returned.revision,
  final_hash: crypto.createHash('sha256').update(resultBytes).digest('hex'),
  verified: ['save_prepare_execute', 'checkpoint', 'restore_removes_result', 'restore_clears_work_latest', 'restore_clears_board', 'restore_save_unverified', 'new_process_return', 'return_restores_result_bytes', 'resource_id_preserved', 'work_points_to_save', 'board_points_to_save', 'save_verified', 'save_journal_unchanged'],
  not_verified: ['timeline_ui', 'native_desktop', 'real_user_project', 'subjective_acceptance'], calls,
};
fs.writeFileSync(receipt, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ status: 'passed', receipt, round_id: start.round_id, save_id: saved.save_id, revision: returned.revision }, null, 2));
