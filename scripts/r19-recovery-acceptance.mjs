// Isolated developer fixture. Host edits below are not credited as Atlas editing.
// Every recovery action goes through the installed atlas.cmd JSON protocol.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = path.join(repo, 'test/.tmp');
const install = path.resolve(process.argv[2] ?? '');
const materialBoard = process.argv.includes('--material-board');
const saveBoard = process.argv.includes('--save-board');
assert.ok(install.startsWith(`${temp}${path.sep}`), 'Use a fresh isolated install inside test/.tmp.');
for (let entry = install; entry !== repo; entry = path.dirname(entry)) assert.equal(fs.lstatSync(entry).isSymbolicLink(), false);
const wrapper = path.join(install, 'atlas.cmd');
assert.ok(fs.existsSync(wrapper));
const fixture = fs.mkdtempSync(path.join(temp, 'r19-recovery-scenario-'));
const workspace = path.join(fixture, 'workspace');
const projectRelative = `Workshop-${path.basename(fixture)}`;
const projectRoot = path.join(workspace, projectRelative);
fs.mkdirSync(projectRoot, { recursive: true });
const stateDir = path.join(install, 'state');
const { Registry } = await import(pathToFileURL(path.join(install, 'runtime/src/registry.js')));
const registry = new Registry({ stateDir });
let projectId;
try {
  const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  projectId = registry.create({ name: 'Workshop recovery demonstration', currentPath: projectRelative }).project_id;
  registry.attachRoot(projectId, { rootId: root.root_id, relativePath: projectRelative, reason: 'Isolated round recovery acceptance.' });
} finally { registry.dispose(); }

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
let counter = 0;
const caller = { actor: 'agent', tool: 'r19-installed-acceptance', client_run_id: path.basename(fixture) };
function request(action, data) {
  const file = path.join(fixture, `request-${++counter}.json`);
  fs.writeFileSync(file, JSON.stringify({ projectId, caller, requestKey: `request-${counter}`, ...data }));
  return cli(['round', action, '--request-file', file]);
}
const capabilities = cli(['capabilities']);
assert.equal(capabilities.round_recovery.status, 'experimental');
assert.equal(capabilities.round_recovery.ui_available, true);
let board = cli(['board', 'create', '--project', projectId, '--title', 'Workshop plan']);
const original = {
  'plan.md': Buffer.from('# Workshop\nBudget: 100\n'),
  'budget.csv': Buffer.from('item,amount\nroom,100\n'),
  'cover.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64'),
};
for (const [name, bytes] of Object.entries(original)) fs.writeFileSync(path.join(projectRoot, name), bytes);
fs.writeFileSync(path.join(projectRoot, 'unrelated.txt'), 'leave this alone');
const resourceIds = [];
const saveIds = [];
const workIds = [];
if (materialBoard) {
  const { createResourceControl } = await import(pathToFileURL(path.join(install, 'runtime/src/resource-control.js')));
  const control = createResourceControl({ stateDir });
  try { resourceIds.push(control.identify({ filePath: path.join(projectRoot, 'plan.md'), project: { id: projectId } }).resource_id); }
  finally { control.dispose(); }
  const initialBoardFile = path.join(fixture, 'initial-board.json');
  fs.writeFileSync(initialBoardFile, JSON.stringify({ title: board.title, blocks: [{ type: 'material_reference', resource_id: resourceIds[0], version_policy: 'pinned_version' }, { type: 'text', text: 'Before workshop revision' }] }));
  board = cli(['board', 'save', board.board_id, '--project', projectId, '--base-revision', String(board.revision), '--request-file', initialBoardFile]);
}
if (saveBoard) {
  const { createResourceControl } = await import(pathToFileURL(path.join(install, 'runtime/src/resource-control.js')));
  const { SaveService } = await import(pathToFileURL(path.join(install, 'runtime/src/save-service.js')));
  const selectedRegistry = new Registry({ stateDir });
  const control = createResourceControl({ stateDir, ledger: selectedRegistry.ledger });
  const service = new SaveService({ stateDir, resourceControl: control });
  try {
    const source = control.identify({ filePath: path.join(projectRoot, 'budget.csv'), project: { id: projectId } });
    resourceIds.push(source.resource_id);
    const work = selectedRegistry.ledger.workSessions.create({ projectId, resourceIds: [source.resource_id], intent: 'Workshop budget', returnState: {}, caller, at: new Date().toISOString() });
    workIds.push(work.session_id);
    const candidate = path.join(fixture, 'delivery.csv');
    fs.writeFileSync(candidate, original['budget.csv']);
    const prepared = service.prepare({ root: workspace, projectId, target: `${projectRelative}/delivery.csv`, candidateFile: candidate,
      origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'initial-delivery', caller,
      inputs: [path.join(projectRoot, 'budget.csv')], source: { path: path.join(projectRoot, 'budget.csv'), resource_id: source.resource_id }, parameters: { work_session_id: work.session_id } });
    const saved = service.execute(prepared.save_id, { reason: 'Isolated acceptance delivery' });
    saveIds.push(saved.save_id); resourceIds.push(saved.resource_id);
    selectedRegistry.ledger.workSessions.setLatestSave(work.session_id, saved.save_id, new Date().toISOString());
    original['delivery.csv'] = Buffer.from(original['budget.csv']);
  } finally { service.dispose(); control.dispose(); selectedRegistry.dispose(); }
  const initialBoardFile = path.join(fixture, 'initial-save-board.json');
  fs.writeFileSync(initialBoardFile, JSON.stringify({ title: board.title, blocks: [{ type: 'result_preview', save_id: saveIds[0], version_policy: 'pinned_version' }] }));
  board = cli(['board', 'save', board.board_id, '--project', projectId, '--base-revision', String(board.revision), '--request-file', initialBoardFile]);
}
const receiptBefore = saveBoard ? fs.readFileSync(path.join(stateDir, 'ui/saved-work.json')) : null;
const initialBlocks = structuredClone(board.blocks);
// `board show` adds live preview/freshness facts; compare every stored field,
// not the additional derived read model returned by the show command.
const assertStoredBlocks = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  for (const [index, block] of expected.entries()) {
    for (const [key, value] of Object.entries(block)) assert.deepEqual(actual[index][key], value);
  }
};
const initialRevision = board.revision;
const start = request('protect', { paths: [...Object.keys(original), 'notes.txt'], resourceIds, workIds, saveIds, boardIds: [board.board_id], label: 'Before workshop revision' });
const read = () => cli(['round', 'show', start.round_id, '--project', projectId]);
const basis = (value = read()) => ({ roundId: start.round_id, baseRevision: value.revision, expectedDigest: value.current_digest });

// Simulated Host writes, outside Atlas: planning/content generation remains with Host.
fs.writeFileSync(path.join(projectRoot, 'plan.md'), '# Workshop\nBudget: 240\n');
fs.writeFileSync(path.join(projectRoot, 'budget.csv'), 'item,amount\nroom,200\nsnacks,40\n');
const revisedPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
fs.writeFileSync(path.join(projectRoot, 'cover.png'), revisedPng);
fs.writeFileSync(path.join(projectRoot, 'notes.txt'), 'New workshop notes');
if (saveBoard) fs.writeFileSync(path.join(projectRoot, 'delivery.csv'), 'item,amount\nroom,240\n');
const boardFile = path.join(fixture, 'board.json');
fs.writeFileSync(boardFile, JSON.stringify({ title: 'Revised workshop plan', blocks: [...(materialBoard || saveBoard ? [{ ...board.blocks[0], version_policy: 'follow_latest' }] : []), { type: 'text', text: 'Budget now 240.' }] }));
const revisedBoard = cli(['board', 'save', board.board_id, '--project', projectId, '--base-revision', String(initialRevision), '--request-file', boardFile]);
const stage = request('checkpoint', { ...basis(), label: 'Workshop revision ready' });
fs.writeFileSync(path.join(projectRoot, 'late.txt'), 'Before added scope');
request('extend', { ...basis(), paths: ['late.txt'], label: 'Before extra notes' });
fs.writeFileSync(path.join(projectRoot, 'late.txt'), 'After added scope');
fs.appendFileSync(path.join(projectRoot, 'plan.md'), 'Uncheckpointed final note.\n');
const beforeRestore = Object.fromEntries([...Object.keys(original), 'notes.txt', 'late.txt'].map((name) => [name, fs.readFileSync(path.join(projectRoot, name))]));
const restored = request('restore', { ...basis(), nodeId: start.head_node_id });
for (const [name, bytes] of Object.entries(original)) assert.deepEqual(fs.readFileSync(path.join(projectRoot, name)), bytes);
assert.equal(fs.existsSync(path.join(projectRoot, 'notes.txt')), false);
assert.equal(fs.readFileSync(path.join(projectRoot, 'late.txt'), 'utf8'), 'Before added scope');
const restoredBoard = cli(['board', 'show', board.board_id, '--project', projectId]);
assert.equal(restoredBoard.revision, initialRevision + 2);
assertStoredBlocks(restoredBoard.blocks, initialBlocks);
const returned = request('return', { ...basis(), restoreId: restored.restore_id });
for (const [name, bytes] of Object.entries(beforeRestore)) assert.deepEqual(fs.readFileSync(path.join(projectRoot, name)), bytes);
assert.equal(fs.readFileSync(path.join(projectRoot, 'unrelated.txt'), 'utf8'), 'leave this alone');
const boardAfter = cli(['board', 'show', board.board_id, '--project', projectId]);
assert.equal(boardAfter.revision, initialRevision + 3);
assertStoredBlocks(boardAfter.blocks, revisedBoard.blocks);
assert.equal(boardAfter.title, 'Revised workshop plan');
assert.equal(returned.pending_restore, null);
if (saveBoard) assert.deepEqual(fs.readFileSync(path.join(stateDir, 'ui/saved-work.json')), receiptBefore);
assert.ok(read().nodes.some((node) => node.node_id === stage.head_node_id));

// Each launcher call is a new process. Verify stale writes and unsupported fields
// remain refused through installed envelopes rather than trusting service tests.
const staleFile = path.join(fixture, 'stale.json');
fs.writeFileSync(staleFile, JSON.stringify({ projectId, caller, requestKey: 'stale', ...basis(start), nodeId: start.head_node_id }));
cli(['round', 'restore', '--request-file', staleFile], false);
cli(['round', 'show', start.round_id, '--project', projectId, '--force'], false);
const record = {
  evidence_type: 'isolated_installed_cli_no_ui', created_at: new Date().toISOString(),
  install, fixture, project_id: projectId, round_id: start.round_id,
  start_node_id: start.head_node_id, checkpoint_node_id: stage.head_node_id,
  restore_id: restored.restore_id, return_node_id: restored.return_node_id,
  round_revision: returned.revision, board_revision: boardAfter.revision,
  final_hashes: Object.fromEntries(Object.entries(beforeRestore).map(([name, bytes]) => [name, crypto.createHash('sha256').update(bytes).digest('hex')])),
  verified: ['before/edit/checkpoint/restore/return', 'uncheckpointed_note_retained', 'new_file_absence_restored', 'unrelated_file_unchanged', `board_revision_${initialRevision}_${initialRevision + 1}_${initialRevision + 2}_${initialRevision + 3}`, 'board_blocks_and_policy_return', 'fresh_process_readback', 'stale_request_refused', ...(materialBoard ? ['explicit_material_reference_board_joint_recovery'] : [])],
  not_verified: ['timeline_ui', 'native_desktop', ...(saveBoard ? [] : ['work_save_recovery']), 'real_user_project', 'subjective_acceptance'], calls,
};
const receipt = path.join(fixture, 'acceptance.json');
fs.writeFileSync(receipt, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ status: 'passed', receipt, round_id: start.round_id, round_revision: returned.revision, board_revision: boardAfter.revision }, null, 2));
