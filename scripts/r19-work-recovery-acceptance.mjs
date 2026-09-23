// Isolated developer fixture. Host CSV edits below are not credited as Atlas edits.
// Protect, checkpoint, restore, and return all use the installed atlas.cmd JSON protocol.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = path.join(repo, 'test/.tmp');
const install = path.resolve(process.argv[2] ?? '');
assert.ok(install.startsWith(`${temp}${path.sep}`), 'Use a fresh isolated install inside test/.tmp.');
for (let entry = install; entry !== repo; entry = path.dirname(entry)) assert.equal(fs.lstatSync(entry).isSymbolicLink(), false);
const wrapper = path.join(install, 'atlas.cmd');
assert.ok(fs.existsSync(wrapper), 'The isolated install must contain atlas.cmd.');

const fixture = fs.mkdtempSync(path.join(temp, 'r19-work-recovery-'));
const workspace = path.join(fixture, 'workspace');
const projectPath = `Workshop-${path.basename(fixture)}`;
const projectRoot = path.join(workspace, projectPath);
fs.mkdirSync(projectRoot, { recursive: true });
const stateDir = path.join(install, 'state');
const { Registry } = await import(pathToFileURL(path.join(install, 'runtime/src/registry.js')));
const registry = new Registry({ stateDir });
let projectId;
try {
  const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  projectId = registry.create({ name: 'Work recovery acceptance', currentPath: projectPath }).project_id;
  registry.attachRoot(projectId, { rootId: root.root_id, relativePath: projectPath, reason: 'Isolated Work recovery acceptance.' });
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

let requestNumber = 0;
const caller = { actor: 'agent', tool: 'r19-work-recovery-acceptance', client_run_id: path.basename(fixture) };
function writeRequest(prefix, value) {
  const requestPath = path.join(fixture, `${prefix}-${++requestNumber}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(value));
  return requestPath;
}
function roundRequest(action, value) {
  return cli(['round', action, '--request-file', writeRequest(`round-${action}`, {
    projectId, caller, requestKey: `round-${action}-${requestNumber}`, ...value,
  })]);
}
function roundBasis(roundId, value = cli(['round', 'show', roundId, '--project', projectId])) {
  return { roundId, baseRevision: value.revision, expectedDigest: value.current_digest };
}
function showWork(sessionId) { return cli(['table-work', 'show', sessionId]); }
function updateRecipe(sessionId, recipe) {
  const work = showWork(sessionId);
  return cli(['table-work', 'recipe', sessionId, '--base-revision', String(work.revision), '--request-file', writeRequest('recipe', recipe)]);
}

const originalCsv = Buffer.from('item,amount\nroom,100\n', 'utf8');
const checkpointCsv = Buffer.from('item,amount\nroom,240\nsnacks,40\n', 'utf8');
const uncheckpointedCsv = Buffer.from('item,amount\nroom,260\nsnacks,55\n', 'utf8');
fs.writeFileSync(path.join(projectRoot, 'budget.csv'), originalCsv);

const capabilities = cli(['capabilities']);
assert.equal(capabilities.round_recovery.status, 'experimental');
const started = cli([
  'table-work', 'start', '--project', projectId, '--source', 'budget.csv', '--intent', 'Recover one prepared budget Work',
  '--tool', caller.tool, '--client-run-id', caller.client_run_id,
]);
const sessionId = started.session_id;
const resourceId = started.sources[0].resource_id;
assert.ok(resourceId, 'table-work start must identify its Source Resource through installed CLI.');

let work = showWork(sessionId);
work = cli(['table-work', 'prepare', sessionId, '--base-revision', String(work.revision)]);
const source = work.sources[0];
assert.equal(source.status, 'ready', source.error_message ?? 'The installed local Python component did not prepare this Source.');
assert.ok(source.profile?.profile && Array.isArray(source.profile.profile.fields), 'The installed local Python component did not return the prepared Source profile.');
const mapping = source.profile.profile.fields.map((field) => ({ source_key: source.source_key, column: field.name, canonical: field.name }));
work = cli(['table-work', 'align', sessionId, '--base-revision', String(work.revision), '--request-file', writeRequest('mapping', { mapping })]);
work = updateRecipe(sessionId, { source_column: true, source_column_name: '__source' });
work = cli(['table-work', 'preview', sessionId, '--base-revision', String(work.revision)]);
assert.ok(work.preview, 'Fixture must have a Preview before recovery clears it.');
const protectedRecipe = structuredClone(work.recipe);
const protectedSources = structuredClone(work.sources);

const protectedRound = roundRequest('protect', {
  paths: ['budget.csv'], resourceIds: [resourceId], workIds: [sessionId], boardIds: [], label: 'Before budget Work revision',
});
assert.deepEqual(protectedRound.resource_ids, [resourceId]);
assert.deepEqual(protectedRound.work_ids, [sessionId]);

// Simulated Host edit; recovery remains an installed CLI operation.
fs.writeFileSync(path.join(projectRoot, 'budget.csv'), checkpointCsv);
const checkpointRecipe = updateRecipe(sessionId, { sort_column: 'item', sort_direction: 'desc' }).recipe;
const checkpoint = roundRequest('checkpoint', { ...roundBasis(protectedRound.round_id), label: 'Budget recipe and CSV updated' });

// A later uncheckpointed state must become the specific restore operation's return target.
fs.writeFileSync(path.join(projectRoot, 'budget.csv'), uncheckpointedCsv);
const beforeRestoreWork = updateRecipe(sessionId, { filter_column: 'item', filter_operator: 'contains', filter_value: 'room' });
const beforeRestoreRecipe = structuredClone(beforeRestoreWork.recipe);
const beforeRestoreRevision = beforeRestoreWork.revision;

const restored = roundRequest('restore', { ...roundBasis(protectedRound.round_id), nodeId: protectedRound.head_node_id });
assert.deepEqual(fs.readFileSync(path.join(projectRoot, 'budget.csv')), originalCsv);
const restoredWork = showWork(sessionId);
assert.deepEqual(restoredWork.sources.map((item) => item.resource_id), protectedSources.map((item) => item.resource_id));
assert.deepEqual(restoredWork.recipe, protectedRecipe);
assert.ok(restoredWork.revision > beforeRestoreRevision, 'Work revision must advance when recovery applies its baseline.');
assert.equal(restoredWork.preview, null, 'Recovery must clear Work Preview.');

const returned = roundRequest('return', { ...roundBasis(protectedRound.round_id), restoreId: restored.restore_id });
assert.deepEqual(fs.readFileSync(path.join(projectRoot, 'budget.csv')), uncheckpointedCsv);
const returnedWork = showWork(sessionId);
assert.deepEqual(returnedWork.sources.map((item) => item.resource_id), protectedSources.map((item) => item.resource_id));
assert.deepEqual(returnedWork.recipe, beforeRestoreRecipe);
assert.ok(returnedWork.revision > restoredWork.revision, 'Returning to insurance state must advance Work revision again.');
assert.equal(returnedWork.preview, null, 'Return must also clear Work Preview.');
assert.equal(returned.pending_restore, null);
assert.ok(cli(['round', 'show', protectedRound.round_id, '--project', projectId]).nodes.some((node) => node.node_id === checkpoint.head_node_id));

const record = {
  evidence_type: 'isolated_installed_cli_work_round_recovery_no_ui', created_at: new Date().toISOString(),
  install, fixture, project_id: projectId, round_id: protectedRound.round_id, session_id: sessionId, resource_id: resourceId,
  start_node_id: protectedRound.head_node_id, checkpoint_node_id: checkpoint.head_node_id,
  restore_id: restored.restore_id, return_node_id: restored.return_node_id,
  work_revisions: { before_restore: beforeRestoreRevision, restored: restoredWork.revision, returned: returnedWork.revision },
  final_csv_sha256: crypto.createHash('sha256').update(uncheckpointedCsv).digest('hex'),
  fixture_preparation: 'Registry API creates only the isolated Project. table-work start identifies the Resource through installed CLI; no unexposed Resource accept-current command is invented.',
  verified: ['installed_cli_table_work_start_prepare_align_recipe_preview', 'round_protect_with_paths_resourceIds_workIds', 'csv_restore_and_return', 'resource_identity_preserved', 'work_recipe_restore_and_return', 'work_revision_advances', 'preview_cleared_on_restore_and_return', 'uncheckpointed_insurance_state_returned'],
  not_verified: ['native_desktop', 'Save_joint_recovery', 'Save_output_or_Save_related_source_recovery', 'cross_project_or_multi_location_resource_recovery', 'real_user_project', 'subjective_acceptance'],
  calls,
};
const receipt = path.join(fixture, 'acceptance.json');
fs.writeFileSync(receipt, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ status: 'passed', receipt, round_id: protectedRound.round_id, session_id: sessionId, resource_id: resourceId }, null, 2));
