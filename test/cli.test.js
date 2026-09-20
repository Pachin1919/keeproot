import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Bootstrap } from '../src/bootstrap.js';
import { Registry } from '../src/registry.js';
import { Tracker } from '../src/tracker.js';
import { createResourceControl } from '../src/resource-control.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = process.env.ATLAS_TEST_CLI_PATH
  ? path.resolve(process.env.ATLAS_TEST_CLI_PATH)
  : path.join(projectRoot, 'bin', 'atlas.js');
const templateRoot = path.join(projectRoot, 'fixtures', 'vault-template');
const tempRoot = process.env.ATLAS_TEST_TMP_ROOT
  ? path.resolve(process.env.ATLAS_TEST_TMP_ROOT)
  : path.join(projectRoot, 'test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const vault = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(caseRoot, { recursive: true });
  fs.cpSync(templateRoot, vault, { recursive: true });
  return { caseRoot, vault, stateDir };
}

function cli(stateDir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, ATLAS_STATE_DIR: stateDir, ...extraEnv },
  });
}

test('CLI lists verified Ledger backups and restores only with the current canonical hash', () => {
  const { stateDir } = setup('cli-ledger-maintenance');
  const tracker = new Tracker({ stateDir });
  tracker.status();
  tracker.dispose();
  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(path.join(stateDir, 'ledger.sqlite'), path.join(backupDir, 'manual.sqlite'));

  const listedResult = cli(stateDir, ['ledger', 'backups', '--json']);
  assert.equal(listedResult.status, 0, listedResult.stderr);
  const listed = JSON.parse(listedResult.stdout).data;
  assert.match(listed.current_hash, /^[a-f0-9]{64}$/);
  assert.equal(listed.backups[0].name, 'manual.sqlite');
  assert.equal(listed.backups[0].integrity, 'ok');

  const stale = cli(stateDir, [
    'ledger', 'restore', '--backup', 'manual.sqlite', '--expect-current-hash', '0'.repeat(64), '--json',
  ]);
  assert.notEqual(stale.status, 0);
  assert.equal(JSON.parse(stale.stdout).error.code, 'ATLAS_STATE_CONFLICT');

  const restoredResult = cli(stateDir, [
    'ledger', 'restore', '--backup', 'manual.sqlite', '--expect-current-hash', listed.current_hash, '--json',
  ]);
  assert.equal(restoredResult.status, 0, restoredResult.stderr);
  const restored = JSON.parse(restoredResult.stdout).data;
  assert.equal(restored.status, 'restored');
  assert.equal(restored.restored_from, 'manual.sqlite');
  assert.ok(restored.safety_backup);
  assert.equal(cli(stateDir, ['doctor', '--json']).status, 0);
});

test('CLI rejects removed Task and Analytics namespaces without creating state', () => {
  const { stateDir } = setup('cli-removed-namespaces');
  for (const command of [['task', 'show', 'TSK-old'], ['analytics', 'export']]) {
    const result = cli(stateDir, [...command, '--json']);
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, 'ATLAS_INVALID_ARGUMENT');
    assert.match(envelope.error.message, /Unknown command/u);
  }
});

test('installed product help and capabilities hide direct internal write engines', () => {
  const { caseRoot, stateDir } = setup('cli-installed-product-boundary');
  const installedEnv = { ATLAS_HOME: path.join(caseRoot, 'installed-atlas') };

  const helpResult = cli(stateDir, ['--json'], installedEnv);
  assert.equal(helpResult.status, 0, helpResult.stderr);
  const help = JSON.parse(helpResult.stdout).data.usage;
  assert.match(help, /atlas save prepare/u);
  assert.doesNotMatch(help, /atlas (guarded|derive|intake) /u);

  const capabilityResult = cli(stateDir, ['capabilities', '--json'], installedEnv);
  assert.equal(capabilityResult.status, 0, capabilityResult.stderr);
  const capabilities = JSON.parse(capabilityResult.stdout).data;
  assert.match(help, /atlas table-work start/u);
  assert.deepEqual(capabilities.workflows.table_work, ['start', 'show', 'add-source', 'remove-source', 'prepare', 'sheet', 'align', 'recipe', 'preview', 'save', 'list']);
  assert.deepEqual(capabilities.workflows.resource_views, ['list', 'evaluate', 'files', 'candidates-submit', 'properties', 'candidates-show', 'save']);
  assert.deepEqual(capabilities.workflows.resource_facts, ['show']);
  assert.deepEqual(capabilities.resource_views, {
    modes: ['files', 'table', 'cards'],
    host_access: 'read_write_views_and_submit_bounded_candidates',
    evaluation_completeness: ['complete', 'partial', 'unknown'],
    semantic_property_write: 'candidate_preview_with_user_decision',
    property_candidate_limit: 10,
    property_kinds: ['text', 'single', 'multi'],
    list_files_scope: 'explicit_required',
  });
  assert.equal(Object.hasOwn(capabilities.workflows, 'guarded'), false);
  assert.equal(Object.hasOwn(capabilities.workflows, 'derived'), false);
  assert.equal(Object.hasOwn(capabilities.workflows, 'intake'), false);
  assert.deepEqual(capabilities.product_entrypoints.internal_foundation.commands, [
    'bootstrap', 'tracked_direct', 'evolution',
  ]);

  for (const command of [['guarded', 'preview', 'GRD-old'], ['derive', 'preview', 'DRV-old'], ['intake', 'show', 'INT-old']]) {
    const result = cli(stateDir, [...command, '--json'], installedEnv);
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, 'ATLAS_INVALID_ARGUMENT');
    assert.match(envelope.error.message, /does not expose/u);
  }
});

test('CLI Save creates, verifies, undoes, and redoes one Host target', () => {
  const { caseRoot, vault, stateDir } = setup('cli-save-host-target');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true });
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' });
  registry.dispose();
  const candidateFile = path.join(caseRoot, 'chat-export.md');
  fs.writeFileSync(candidateFile, '# Chat export\n', 'utf8');
  const target = 'Projects/Atlas/result.md';

  const preparedResult = cli(stateDir, [
    'save', 'prepare', '--root', vault, '--candidate-file', candidateFile,
    '--origin', 'download', '--kind', 'source', '--project', project.project_id,
    '--target', target, '--channel', 'host', '--request-key', 'cli-save-host',
    '--tool', 'atlas-cli-test', '--client-run-id', 'cli-save-host-run', '--intent', 'Save one classified chat export.', '--json',
  ]);
  assert.equal(preparedResult.status, 0, preparedResult.stderr);
  const prepared = JSON.parse(preparedResult.stdout).data;
  assert.equal(prepared.schema, 'atlas.save-result.v1');
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.run_id, prepared.save_id);
  assert.equal(prepared.resources_href, `/projects/${project.project_id}/resources?path=result.md`);

  const executedResult = cli(stateDir, [
    'save', 'execute', prepared.save_id,
    '--reason', 'The user authorized this exact destination.', '--json',
  ]);
  assert.equal(executedResult.status, 0, executedResult.stderr);
  const executed = JSON.parse(executedResult.stdout).data;
  assert.equal(executed.save_id, prepared.save_id);
  assert.equal(executed.run_id, prepared.run_id);
  assert.equal(executed.verified, true);
  assert.equal(fs.readFileSync(path.join(vault, target), 'utf8'), '# Chat export\n');
  const shownResult = cli(stateDir, ['save', 'show', prepared.save_id, '--json']);
  assert.equal(shownResult.status, 0, shownResult.stderr);
  const shown = JSON.parse(shownResult.stdout).data;
  assert.equal(shown.save_id, prepared.save_id); assert.equal(shown.target.path, executed.target.path); assert.equal(shown.resources_href, executed.resources_href);

  const rolledBack = cli(stateDir, ['save', 'undo', prepared.save_id, '--json']);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(fs.existsSync(path.join(vault, target)), false);
  const undone = JSON.parse(rolledBack.stdout).data;
  assert.equal(undone.status, 'undone');
  assert.equal(undone.redo_available, true);

  const redoneResult = cli(stateDir, ['save', 'redo', prepared.save_id, '--json']);
  assert.equal(redoneResult.status, 0, redoneResult.stderr);
  const redone = JSON.parse(redoneResult.stdout).data;
  assert.equal(redone.save_id, prepared.save_id);
  assert.equal(redone.status, 'executed');
  assert.equal(redone.undo_available, true);
  assert.equal(redone.redo_available, false);
  assert.equal(redone.resource_id, executed.resource_id);
  assert.equal(fs.readFileSync(path.join(vault, target), 'utf8'), '# Chat export\n');
});

test('CLI Host content inspection returns the persisted Recent Work Resource ID', (t) => {
  const { caseRoot, stateDir } = setup('cli-content-resource-id');
  const python = process.env.ATLAS_TEST_PYTHON ?? path.join(process.env.LOCALAPPDATA ?? '', 'Atlas', 'python', 'venv', 'Scripts', 'python.exe');
  if (!python || !fs.existsSync(python)) { t.skip('Managed Atlas Python is unavailable for the CLI inspection fixture.'); return; }
  const filePath = path.join(caseRoot, 'incoming.md'); fs.writeFileSync(filePath, '# Inspect me\n', 'utf8');
  const result = cli(stateDir, ['content', 'inspect', '--file', filePath, '--purpose', 'content', '--tool', 'atlas-cli-test', '--client-run-id', 'inspect-resource-id', '--json'], { ATLAS_PYTHON: python });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const data = JSON.parse(result.stdout).data;
  assert.match(data.coordination.resource_id, /^RES-/u);
  const recent = JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'recent-work.json'), 'utf8')).items;
  assert.equal(recent.length, 1);
  assert.equal(recent[0].resource_id, data.coordination.resource_id);
});

test('CLI Host completes one persistent multi-source Table Work through the shared Work store', (t) => {
  const python = process.env.ATLAS_TEST_PYTHON ?? path.join(process.env.LOCALAPPDATA ?? '', 'Atlas', 'python', 'venv', 'Scripts', 'python.exe');
  if (!python || !fs.existsSync(python)) { t.skip('Managed Atlas Python is unavailable for the Host Table Work fixture.'); return; }
  const { caseRoot, stateDir } = setup('cli-host-table-work');
  const workspace = path.join(caseRoot, 'workspace'); const projectRootPath = path.join(workspace, 'Project');
  const data = path.join(projectRootPath, 'Data'); const results = path.join(projectRootPath, 'Results');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(results, { recursive: true });
  const first = path.join(data, 'first.csv'); const second = path.join(data, 'second.csv');
  fs.writeFileSync(first, 'id,name\n1,One\n2,Two\n', 'utf8');
  fs.writeFileSync(second, 'Identifier,name\n3,Three\n2,Two\n', 'utf8');
  const registry = new Registry({ stateDir });
  const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Project', currentPath: 'Project' });
  registry.attachRoot(project.project_id, { rootId: root.root_id, relativePath: 'Project', reason: 'Bind Host Table Work fixture.' });
  registry.dispose();
  const env = { ATLAS_PYTHON: python };
  const host = ['--actor', 'agent', '--agent', 'Codex', '--model', 'test', '--tool', 'atlas-cli-test', '--client-run-id', 'host-table-work'];
  const invoke = (args) => {
    const result = cli(stateDir, [...args, ...host, '--json'], env);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout).data;
  };

  const started = invoke(['table-work', 'start', '--project', project.project_id, '--source', first, '--source', second]);
  assert.match(started.session_id, /^DWT-/u); assert.equal(started.sources.length, 2);
  const prepared = invoke(['table-work', 'prepare', started.session_id, '--base-revision', String(started.revision)]);
  assert.deepEqual(prepared.sources.map((item) => item.status), ['ready', 'ready']);
  const mappingFile = path.join(caseRoot, 'mapping.json');
  fs.writeFileSync(mappingFile, JSON.stringify({ mapping: [
    { source_key: prepared.sources[0].source_key, column: 'id', canonical: 'id' },
    { source_key: prepared.sources[0].source_key, column: 'name', canonical: 'name' },
    { source_key: prepared.sources[1].source_key, column: 'Identifier', canonical: 'id' },
    { source_key: prepared.sources[1].source_key, column: 'name', canonical: 'name' },
  ] }), 'utf8');
  const aligned = invoke(['table-work', 'align', started.session_id, '--request-file', mappingFile, '--base-revision', String(prepared.revision)]);
  assert.equal(aligned.mapping_complete, true);
  const recipeFile = path.join(caseRoot, 'recipe.json');
  fs.writeFileSync(recipeFile, JSON.stringify({ combine: 'concatenate', source_column: true, source_column_name: 'origin', deduplicate_columns: 'id', sort_column: 'id', sort_direction: 'asc' }), 'utf8');
  const recipe = invoke(['table-work', 'recipe', started.session_id, '--request-file', recipeFile, '--base-revision', String(aligned.revision)]);
  assert.equal(recipe.recipe.steps.some((item) => item.operation === 'source-column'), true);
  const previewed = invoke(['table-work', 'preview', started.session_id, '--base-revision', String(recipe.revision)]);
  assert.equal(previewed.preview.result_summary.rows, 3); assert.equal(previewed.preview_revision, previewed.revision);
  const currentRevision = previewed.revision;
  const saved = invoke(['table-work', 'save', started.session_id, '--base-revision', String(currentRevision), '--folder', 'Results', '--file-name', 'merged.csv', '--format', 'csv', '--request-key', 'host-table-work-save', '--reason', 'The user authorized this exact reviewed Preview and destination.']);
  assert.equal(saved.status, 'executed'); assert.match(saved.verification.sha256, /^[a-f0-9]{64}$/u); assert.equal(saved.channel, 'host'); assert.equal(saved.source.sources.length, 2);
  assert.equal(fs.existsSync(path.join(results, 'merged.csv')), true);
  const replayed = invoke(['table-work', 'save', started.session_id, '--base-revision', String(currentRevision), '--folder', 'Results', '--file-name', 'merged.csv', '--format', 'csv', '--request-key', 'host-table-work-save', '--reason', 'The user authorized this exact reviewed Preview and destination.']);
  assert.equal(replayed.save_id, saved.save_id); assert.equal(replayed.status, 'executed');
  const conflicting = cli(stateDir, ['table-work', 'save', started.session_id, '--base-revision', String(currentRevision), '--folder', 'Results', '--file-name', 'merged.csv', '--format', 'csv', '--request-key', 'different-host-save', '--reason', 'Try a different request against the occupied target.', ...host, '--json'], env);
  assert.notEqual(conflicting.status, 0); assert.equal(JSON.parse(conflicting.stdout).error.code, 'ATLAS_STATE_CONFLICT');
  const shown = invoke(['table-work', 'show', started.session_id]);
  assert.equal(shown.latest_save_id, saved.save_id); assert.equal(shown.session_id, started.session_id);
  const reopened = new Registry({ stateDir }); const sharedSession = reopened.ledger.workSessions.latestOpenForProject(project.project_id);
  assert.equal(sharedSession.session_id, started.session_id); assert.deepEqual(sharedSession.recipe, shown.recipe); reopened.dispose();
  const control = createResourceControl({ stateDir });
  for (const source of saved.source.sources) assert.equal(control.relationships(source.resource_id).some((item) => item.type === 'used_by' && item.target_id === project.project_id), true);
  control.dispose();
  const undone = cli(stateDir, ['save', 'undo', saved.save_id, '--json'], env); assert.equal(undone.status, 0, undone.stderr); assert.equal(fs.existsSync(path.join(results, 'merged.csv')), false);
  const redone = cli(stateDir, ['save', 'redo', saved.save_id, '--json'], env); assert.equal(redone.status, 0, redone.stderr); assert.equal(fs.existsSync(path.join(results, 'merged.csv')), true);
  fs.appendFileSync(first, '4,Four\n', 'utf8');
  const stale = cli(stateDir, ['table-work', 'preview', started.session_id, '--base-revision', String(shown.revision), ...host, '--json'], env);
  assert.notEqual(stale.status, 0); assert.equal(JSON.parse(stale.stdout).error.code, 'ATLAS_STATE_CONFLICT');
});

test('CLI Host Table Work rejects a Source outside the selected Project without creating a Session', () => {
  const { caseRoot, stateDir } = setup('cli-host-table-work-boundary');
  const workspace = path.join(caseRoot, 'workspace'); const firstRoot = path.join(workspace, 'First'); const secondRoot = path.join(workspace, 'Second');
  fs.mkdirSync(firstRoot, { recursive: true }); fs.mkdirSync(secondRoot, { recursive: true });
  const foreign = path.join(secondRoot, 'foreign.csv'); fs.writeFileSync(foreign, 'id\n1\n', 'utf8');
  const registry = new Registry({ stateDir });
  const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const first = registry.create({ name: 'First', currentPath: 'First' }); const second = registry.create({ name: 'Second', currentPath: 'Second' });
  registry.attachRoot(first.project_id, { rootId: root.root_id, relativePath: 'First', reason: 'Bind first boundary fixture.' });
  registry.attachRoot(second.project_id, { rootId: root.root_id, relativePath: 'Second', reason: 'Bind second boundary fixture.' }); registry.dispose();
  const result = cli(stateDir, ['table-work', 'start', '--project', first.project_id, '--source', foreign, '--tool', 'atlas-cli-test', '--client-run-id', 'boundary', '--json']);
  assert.notEqual(result.status, 0); assert.match(JSON.parse(result.stdout).error.message, /inside the selected Project/u);
  const reopened = new Registry({ stateDir }); assert.equal(reopened.ledger.workSessions.latestOpenForProject(first.project_id), null); reopened.dispose();
});

test('CLI resource relationships submit persists a structured Host batch', () => {
  const { caseRoot, stateDir } = setup('cli-resource-relationships'); const external = path.join(caseRoot, 'external.md'); fs.writeFileSync(external, 'external');
  const registry = new Registry({ stateDir }); const a = registry.create({ name: 'A', currentPath: 'A' }); const b = registry.create({ name: 'B', currentPath: 'B' }); const control = createResourceControl({ stateDir, ledger: registry.ledger }); const resource = control.identify({ filePath: external }); control.dispose(); registry.dispose();
  const requestFile = path.join(caseRoot, 'relationships.json'); fs.writeFileSync(requestFile, JSON.stringify({ candidates: [{ source_resource_id: resource.resource_id, target: { kind: 'project', id: a.project_id }, type: 'used_by', evidence: { reason: 'Host review' } }, { source_resource_id: resource.resource_id, target: { kind: 'project', id: b.project_id }, type: 'used_by', evidence: { reason: 'Host review' } }] }));
  const result = cli(stateDir, ['resource', 'relationships', 'submit', '--request-file', requestFile, '--tool', 'cli-test', '--client-run-id', 'relationships-run', '--json']); assert.equal(result.status, 0, result.stderr); const envelope = JSON.parse(result.stdout); const data = envelope.data; assert.equal(envelope.command, 'resource.relationships.submit'); assert.equal(data.relationships.length, 2); assert.ok(data.relationships.every((item) => item.source_resource_id === resource.resource_id && item.status === 'active' && item.evidence.reason === 'Host review' && item.effective_at));
  const reopened = createResourceControl({ stateDir }); assert.equal(reopened.relationships(resource.resource_id).length, 2); reopened.dispose();
});

test('CLI resource relationships rejects an invalid batch without writes', () => {
  const { caseRoot, stateDir } = setup('cli-resource-relationships-invalid'); const external = path.join(caseRoot, 'external.md'); fs.writeFileSync(external, 'external'); const registry = new Registry({ stateDir }); const project = registry.create({ name: 'A', currentPath: 'A' }); const control = createResourceControl({ stateDir, ledger: registry.ledger }); const resource = control.identify({ filePath: external }); control.dispose(); registry.dispose(); const requestFile = path.join(caseRoot, 'invalid.json'); fs.writeFileSync(requestFile, JSON.stringify({ candidates: [{ source_resource_id: resource.resource_id, target: { kind: 'project', id: project.project_id }, type: 'used_by', evidence: { reason: 'valid' } }, { source_resource_id: 'RES-missing', target: { kind: 'project', id: project.project_id }, type: 'used_by', evidence: { reason: 'invalid' } }] })); const result = cli(stateDir, ['resource', 'relationships', 'submit', '--request-file', requestFile, '--tool', 'cli-test', '--client-run-id', 'relationships-invalid', '--json']); assert.notEqual(result.status, 0); assert.equal(JSON.parse(result.stdout).ok, false); const reopened = createResourceControl({ stateDir }); assert.equal(reopened.relationships(resource.resource_id).length, 0); reopened.dispose();
});

test('legacy Intake execute routes are blocked without writing targets', () => {
  const { caseRoot, vault, stateDir } = setup('cli-intake-attachment-batch');
  fs.mkdirSync(path.join(vault, 'Reports'), { recursive: true });
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'JMC', currentPath: 'Reports' });
  registry.dispose();
  const items = ['April', 'May', 'June'].map((month) => {
    const candidateFile = path.join(caseRoot, `${month}.pdf`);
    fs.writeFileSync(candidateFile, `${month} report fixture\n`, 'utf8');
    return {
      candidateFile,
      origin: 'human_submitted',
      kind: 'report',
      projectId: project.project_id,
      target: `Reports/${month}.pdf`,
      intent: `Import ${month} report.`,
    };
  });
  const requestFile = path.join(caseRoot, 'batch.json');
  fs.writeFileSync(requestFile, JSON.stringify({ items }), 'utf8');

  const commands = [
    ['intake', 'execute', 'DRV-not-a-save', '--json'],
    ['intake', 'rollback', 'DRV-not-a-save', '--json'],
    ['intake', 'batch-execute', '--root', vault, '--request-file', requestFile,
    '--reason', 'The user submitted these three reports for the exact targets.',
    '--actor', 'agent', '--agent', 'Codex', '--model', 'test', '--tool', 'codex',
    '--client-run-id', 'attachment-batch-test', '--json'],
  ];
  for (const command of commands) {
    const result = cli(stateDir, command);
    assert.notEqual(result.status, 0);
    assert.match(JSON.parse(result.stdout).error.message, /Use atlas save/u);
  }
  for (const item of items) {
    assert.equal(fs.existsSync(path.join(vault, item.target)), false);
  }
});

test('CLI exposes Risk, Project Registry, and the complete single-file Guarded flow', () => {
  const { caseRoot, vault, stateDir } = setup('cli-v1');
  const risk = cli(stateDir, [
    'risk', '--operation', 'update', '--path', 'AGENTS.md', '--rules', '--guarded',
  ]);
  assert.equal(risk.status, 0, risk.stderr);
  assert.equal(JSON.parse(risk.stdout).mode, 'guarded');

  const created = cli(stateDir, [
    'project', 'create', '--name', 'Atlas', '--path', 'Projects/Atlas', '--alias', 'Atlas V1',
  ]);
  assert.equal(created.status, 0, created.stderr);
  const projectId = created.stdout.match(/PRJ-[0-9a-f-]+/i)?.[0];
  assert.ok(projectId);
  const listed = cli(stateDir, ['project', 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(projectId));

  const target = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(target, 'utf8');
  const candidate = path.join(caseRoot, 'candidate.md');
  fs.writeFileSync(candidate, '# CLI approved candidate\n', 'utf8');
  const prepared = cli(stateDir, [
    'guarded', 'prepare', '--root', vault, '--target', 'allowed-a.md',
    '--candidate-file', candidate, '--intent', 'CLI integration test',
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const runId = prepared.stdout.match(/GRD-[0-9]+-[0-9a-f]+/i)?.[0];
  assert.ok(runId, prepared.stdout);

  const unapproved = cli(stateDir, ['guarded', 'execute', runId]);
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /approval/i);
  assert.equal(fs.readFileSync(target, 'utf8'), baseline);
  const executed = cli(stateDir, [
    'guarded', 'apply-approved', runId, '--reason', 'approved', '--json',
  ]);
  assert.equal(executed.status, 0, executed.stderr);
  const executionReceipt = JSON.parse(executed.stdout).data;
  assert.equal(executionReceipt.verified, true);
  assert.equal(executionReceipt.rollback_ready, true);
  assert.equal(executionReceipt.fast_path, true);
  assert.equal(typeof executionReceipt.elapsed_ms, 'number');
  assert.equal(executionReceipt.within_10_second_budget, true);
  assert.doesNotMatch(executed.stdout, /diff_text|CLI approved candidate/u);
  assert.equal(fs.readFileSync(target, 'utf8'), '# CLI approved candidate\n');
  const preview = cli(stateDir, ['guarded', 'preview', runId, '--json']);
  assert.equal(JSON.parse(preview.stdout).data.run.status, 'executed');
  const rolledBack = cli(stateDir, ['guarded', 'rollback', runId]);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), baseline);
});

test('CLI exposes the reviewed Evolution create and rollback flow', () => {
  const { vault, stateDir } = setup('cli-evolution');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true });
  const preparedResult = cli(stateDir, [
    'evolve', 'prepare', '--root', vault, '--operation', 'create_directory',
    '--target', 'Projects/Atlas/Working', '--intent', 'Create one accepted work area.', '--json',
  ]);
  assert.equal(preparedResult.status, 0, preparedResult.stderr);
  const prepared = JSON.parse(preparedResult.stdout).data;
  assert.equal(prepared.status, 'prepared');
  assert.equal(fs.existsSync(path.join(vault, prepared.target)), false);

  const preview = cli(stateDir, ['evolve', 'preview', prepared.run_id, '--json']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).data.plan.requires_approval, true);
  assert.equal(cli(stateDir, [
    'evolve', 'approve', prepared.run_id, '--reason', 'Create this directory.', '--json',
  ]).status, 0);
  const executed = cli(stateDir, ['evolve', 'execute', prepared.run_id, '--json']);
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).data.verified, true);
  assert.equal(fs.statSync(path.join(vault, prepared.target)).isDirectory(), true);

  const rolledBack = cli(stateDir, ['evolve', 'rollback', prepared.run_id, '--json']);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(JSON.parse(rolledBack.stdout).data.status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(vault, prepared.target)), false);
});

test('CLI refuses to place Atlas runtime state outside the project', () => {
  const outside = path.resolve(projectRoot, '..', 'atlas-outside-state');
  const result = cli(outside, ['status']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must remain inside the Atlas project/i);
  assert.equal(fs.existsSync(outside), false);
});

test('CLI refuses an in-project state path redirected through a junction', (t) => {
  const { caseRoot } = setup('cli-state-junction');
  const target = path.join(caseRoot, 'redirect-target');
  const junction = path.join(caseRoot, 'redirect-state');
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.symlinkSync(target, junction, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = cli(junction, ['status', '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.error.code, 'ATLAS_PATH_BOUNDARY');
  assert.match(envelope.error.message, /symbolic link|junction|redirect/i);
  assert.equal(fs.existsSync(path.join(target, 'ledger.sqlite')), false);
});

test('Agent JSON protocol exposes version, capabilities, doctor, and structured errors', () => {
  const { stateDir } = setup('cli-agent-protocol');
  for (const [command, expected] of [
    [['version', '--json'], 'version'],
    [['capabilities', '--json'], 'capabilities'],
    [['doctor', '--json'], 'doctor'],
  ]) {
    const result = cli(stateDir, command);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.protocol_version, 'atlas-cli.v1');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, expected);
    assert.ok(envelope.data);
    if (expected === 'capabilities') {
      assert.deepEqual(envelope.data.product_entrypoints.current_product.commands, [
        'ui', 'ui install', 'ui doctor', 'ui remove',
        'save prepare', 'save show', 'save execute', 'save undo', 'save redo',
        'table-work start', 'table-work show', 'table-work add-source', 'table-work remove-source',
        'table-work prepare', 'table-work sheet', 'table-work align', 'table-work recipe', 'table-work preview', 'table-work save', 'table-work list',
        'view list', 'view evaluate', 'view files', 'view properties', 'view candidates submit', 'view candidates show', 'view save',
        'content localize-conversation',
        'resource show',
      ]);
      assert.equal(envelope.data.table_work.semantic_authority, 'user_or_host_proposal');
      assert.equal(envelope.data.product_entrypoints.internal_foundation.status, 'not_a_product_entrypoint');
      assert.equal(Object.hasOwn(envelope.data.product_entrypoints, 'legacy_compatibility'), false);
      assert.equal(Object.hasOwn(envelope.data.workflows, 'task'), false);
      assert.equal(Object.hasOwn(envelope.data.workflows, 'analytics'), false);
      assert.equal(Object.hasOwn(envelope.data.workflows, 'agent'), false);
      assert.deepEqual(envelope.data.workflows.resource_views, ['list', 'evaluate', 'files', 'candidates-submit', 'properties', 'candidates-show', 'save']);
      assert.deepEqual(envelope.data.workflows.resource_facts, ['show']);
      assert.deepEqual(envelope.data.resource_views, {
        modes: ['files', 'table', 'cards'],
        host_access: 'read_write_views_and_submit_bounded_candidates',
        evaluation_completeness: ['complete', 'partial', 'unknown'],
        semantic_property_write: 'candidate_preview_with_user_decision',
        property_candidate_limit: 10,
        property_kinds: ['text', 'single', 'multi'],
        list_files_scope: 'explicit_required',
      });
      assert.equal(Object.hasOwn(envelope.data.runtime_installation, 'codex_hook'), false);
      assert.equal(envelope.data.legacy_fallback, false);
    }
  }

  const doctor = JSON.parse(cli(stateDir, ['doctor', '--json']).stdout);
  assert.equal(doctor.data.status, 'ok');
  assert.equal(doctor.data.ledger.integrity, 'ok');
  assert.equal(doctor.data.ledger.schema_version, doctor.data.ledger.supported_schema_version);
  assert.equal(Object.hasOwn(doctor.data.capabilities, 'analytics_export'), false);
  assert.equal(Object.hasOwn(doctor.data.capabilities, 'analytics_python'), false);
  assert.ok(doctor.data.capabilities.content_python);

  const outside = path.resolve(projectRoot, '..', 'atlas-json-outside-state');
  const failed = cli(outside, ['status', '--json']);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, '');
  const errorEnvelope = JSON.parse(failed.stdout);
  assert.equal(errorEnvelope.protocol_version, 'atlas-cli.v1');
  assert.equal(errorEnvelope.ok, false);
  assert.equal(errorEnvelope.command, 'status');
  assert.equal(errorEnvelope.error.code, 'ATLAS_PATH_BOUNDARY');
  assert.equal(errorEnvelope.error.retryable, false);
  assert.equal(fs.existsSync(outside), false);
});

test('CLI status can return only the newest requested runs', () => {
  const { vault, stateDir } = setup('cli-bounded-status');
  const tracker = new Tracker({ stateDir });
  for (let index = 0; index < 3; index += 1) {
    const run = tracker.begin({
      root: vault,
      allow: ['allowed-a.md'],
      intent: `Bounded status ${index}`,
    });
    tracker.abort(run.run_id, { reason: 'status fixture' });
  }
  tracker.dispose();

  const result = cli(stateDir, ['status', '--limit', '2', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.command, 'status');
  assert.equal(envelope.data.length, 2);

  const invalid = cli(stateDir, ['status', '--limit', '0', '--json']);
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stdout).error.message, /limit/i);
});

test('Agent JSON protocol traces caller metadata across Tracked Direct and Guarded runs', () => {
  const { caseRoot, vault, stateDir } = setup('cli-agent-trace');
  const callerArgs = [
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'codex-cli', '--client-run-id', 'task-123',
  ];
  const began = cli(stateDir, [
    'begin', '--root', vault, '--allow', 'allowed-a.md', '--intent', 'Agent trace test',
    ...callerArgs, '--json',
  ]);
  assert.equal(began.status, 0, began.stderr);
  const beganEnvelope = JSON.parse(began.stdout);
  assert.equal(beganEnvelope.command, 'begin');
  const runId = beganEnvelope.data.run_id;

  fs.appendFileSync(path.join(vault, 'allowed-a.md'), '\nAgent protocol edit.\n', 'utf8');
  const closed = cli(stateDir, ['close', runId, '--json']);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(JSON.parse(closed.stdout).data.run_id, runId);

  const status = cli(stateDir, ['status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(JSON.parse(status.stdout).data.some((run) => run.id === runId));
  const shown = JSON.parse(cli(stateDir, ['show', runId, '--json']).stdout);
  assert.deepEqual(shown.data.run.caller, {
    actor: 'agent',
    agent: 'Codex',
    model: 'gpt-5',
    tool: 'codex-cli',
    client_run_id: 'task-123',
  });

  const candidate = path.join(caseRoot, 'agent-candidate.md');
  fs.writeFileSync(candidate, '# Agent candidate\n', 'utf8');
  const prepared = cli(stateDir, [
    'guarded', 'prepare', '--root', vault, '--target', 'allowed-b.md',
    '--candidate-file', candidate, '--intent', 'Agent guarded trace', ...callerArgs, '--json',
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const guardedId = JSON.parse(prepared.stdout).data.run_id;
  const preview = JSON.parse(cli(stateDir, ['guarded', 'preview', guardedId, '--json']).stdout);
  assert.deepEqual(preview.data.run.caller, shown.data.run.caller);
});

test('all CLI namespaces provide JSON envelopes for representative commands', () => {
  const { vault, stateDir } = setup('cli-json-namespaces');
  const risk = JSON.parse(cli(stateDir, [
    'risk', '--operation', 'update', '--path', 'note.md', '--json',
  ]).stdout);
  assert.equal(risk.command, 'risk');
  assert.equal(risk.ok, true);

  const projects = JSON.parse(cli(stateDir, ['project', 'list', '--json']).stdout);
  assert.equal(projects.command, 'project.list');
  assert.deepEqual(projects.data, []);

  const scan = cli(stateDir, ['bootstrap', 'scan', '--root', vault, '--json']);
  assert.equal(scan.status, 0, scan.stderr);
  const scanEnvelope = JSON.parse(scan.stdout);
  assert.equal(scanEnvelope.command, 'bootstrap.scan');
  assert.ok(scanEnvelope.data.scan_id);

  const structureScan = cli(stateDir, [
    'bootstrap', 'scan', '--root', vault, '--scan-mode', 'structure', '--json',
  ]);
  assert.equal(structureScan.status, 0, structureScan.stderr);
  assert.equal(JSON.parse(structureScan.stdout).data.scan_mode, 'structure');

  const began = JSON.parse(cli(stateDir, [
    'begin', '--root', vault, '--allow', 'allowed-a.md', '--json',
  ]).stdout).data;
  const rules = JSON.parse(cli(stateDir, ['rule', 'list', '--json']).stdout);
  assert.equal(rules.command, 'rule.list');
  assert.ok(rules.data.some((rule) => rule.id === 'RULE-TRACKED-DIRECT-1'));
  const rule = JSON.parse(cli(stateDir, [
    'rule', 'show', 'RULE-TRACKED-DIRECT-1', '--json',
  ]).stdout);
  assert.equal(rule.command, 'rule.show');
  assert.equal(rule.data.definition.allow, 'exact files and descendants of allowed directories');
  cli(stateDir, ['abort', began.run_id, '--json']);
});

test('CLI exposes bounded Agent Bootstrap proposals and classified Derived creation', () => {
  const { caseRoot, vault, stateDir } = setup('cli-agent-bootstrap-derived');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true });

  const project = cli(stateDir, [
    'project', 'create', '--name', 'Atlas', '--path', 'Projects/Atlas', '--json',
  ]);
  assert.equal(project.status, 0, project.stderr);
  const projectId = JSON.parse(project.stdout).data.project_id;

  const scan = cli(stateDir, [
    'bootstrap', 'scan', '--root', vault, '--scan-mode', 'structure', '--json',
  ]);
  assert.equal(scan.status, 0, scan.stderr);
  const scanId = JSON.parse(scan.stdout).data.scan_id;
  const context = cli(stateDir, [
    'bootstrap', 'context', scanId, '--max-samples', '2', '--json',
  ]);
  assert.equal(context.status, 0, context.stderr);
  const contextData = JSON.parse(context.stdout).data;
  assert.equal(contextData.content_included, false);
  assert.ok(contextData.areas.every((area) => area.sample_paths.length <= 2));

  const proposalFile = path.join(caseRoot, 'bootstrap-proposal.json');
  fs.writeFileSync(proposalFile, JSON.stringify({ predictions: [{
    kind: 'routing_rule_candidate',
    summary: 'Route Atlas reports into the Atlas Project.',
    confidence: 0.9,
    risk: 'low',
    affected_paths: ['Projects/Atlas'],
    evidence: { role: 'report', target_directory: 'Projects/Atlas' },
    proposed_action: 'Use Projects/Atlas for reviewed Atlas reports.',
  }] }), 'utf8');
  const proposal = cli(stateDir, [
    'bootstrap', 'propose', scanId, '--proposal-file', proposalFile,
    '--actor', 'agent', '--agent', 'Codex', '--json',
  ]);
  assert.equal(proposal.status, 0, proposal.stderr);
  assert.equal(JSON.parse(proposal.stdout).data.prediction_ids.length, 1);

  const candidate = path.join(caseRoot, 'generated-report.md');
  fs.writeFileSync(candidate, '# Generated report\n', 'utf8');
  const prepared = cli(stateDir, [
    'derive', 'prepare', '--root', vault, '--input', 'allowed-a.md',
    '--target', 'Projects/Atlas/generated-report.md', '--candidate-file', candidate,
    '--project', projectId, '--role', 'report', '--relation', 'summarizes',
    '--actor', 'agent', '--agent', 'Codex', '--json',
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const runId = JSON.parse(prepared.stdout).data.run_id;
  assert.equal(cli(stateDir, ['derive', 'approve', runId, '--json']).status, 0);
  const executed = cli(stateDir, ['derive', 'execute', runId, '--json']);
  assert.equal(executed.status, 0, executed.stderr);
  const preview = JSON.parse(cli(stateDir, ['derive', 'preview', runId, '--json']).stdout).data;
  assert.equal(preview.run.status, 'executed');
  assert.equal(preview.output.role, 'report');
  assert.equal(preview.inputs.length, 1);
  assert.equal(preview.lineage[0].relation_type, 'summarizes');
  assert.equal(cli(stateDir, ['derive', 'rollback', runId, '--json']).status, 0);
  assert.equal(fs.existsSync(path.join(vault, 'Projects', 'Atlas', 'generated-report.md')), false);
});

test('JSON rollback conflict has a dedicated stable error code and no overwrite', () => {
  const { vault, stateDir } = setup('cli-json-rollback-conflict');
  const target = path.join(vault, 'allowed-a.md');
  const began = cli(stateDir, [
    'begin', '--root', vault, '--allow', 'allowed-a.md', '--json',
  ]);
  const runId = JSON.parse(began.stdout).data.run_id;
  fs.writeFileSync(target, '# run end\n', 'utf8');
  assert.equal(cli(stateDir, ['close', runId, '--json']).status, 0);
  fs.writeFileSync(target, '# later edit\n', 'utf8');

  const rollback = cli(stateDir, ['rollback', runId, '--json']);
  assert.equal(rollback.status, 3);
  assert.equal(rollback.stderr, '');
  const envelope = JSON.parse(rollback.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'ATLAS_ROLLBACK_CONFLICT');
  assert.equal(envelope.error.details.conflicts[0].path, 'allowed-a.md');
  assert.equal(fs.readFileSync(target, 'utf8'), '# later edit\n');
});

test('CLI connects default Profiles, Derived recommendations, managed Work, and planned storage cleanup', () => {
  const { caseRoot, vault, stateDir } = setup('cli-profile-work-storage');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Outputs'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Projects', 'Atlas', 'input.md'), '# Input\n', 'utf8');

  const profiles = cli(stateDir, ['bootstrap', 'profiles', '--json']);
  assert.equal(profiles.status, 0, profiles.stderr);
  assert.deepEqual(JSON.parse(profiles.stdout).data.profiles.map((profile) => profile.id), [
    'mixed-minimal', 'personal-knowledge', 'project-work', 'research-writing',
  ]);
  const project = cli(stateDir, [
    'project', 'create', '--name', 'Atlas', '--path', 'Projects/Atlas', '--json',
  ]);
  const projectId = JSON.parse(project.stdout).data.project_id;
  const scan = cli(stateDir, [
    'bootstrap', 'scan', '--root', vault, '--scan-mode', 'structure', '--json',
  ]);
  const scanId = JSON.parse(scan.stdout).data.scan_id;
  const recommended = cli(stateDir, [
    'bootstrap', 'recommend', scanId, '--profile', 'project-work', '--json',
  ]);
  assert.equal(recommended.status, 0, recommended.stderr);
  assert.equal(JSON.parse(recommended.stdout).data.structure_plan.source_changes.length, 0);

  const detail = JSON.parse(cli(stateDir, ['bootstrap', 'show', scanId, '--json']).stdout).data;
  for (const prediction of detail.predictions) {
    const flag = prediction.source === 'atlas-default' ? '--accept' : '--reject';
    const review = cli(stateDir, [
      'bootstrap', 'review', prediction.id, flag, '--reason', 'CLI Fixture review', '--json',
    ]);
    assert.equal(review.status, 0, review.stderr);
  }
  const initialized = cli(stateDir, ['bootstrap', 'initialize', scanId, '--json']);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(JSON.parse(initialized.stdout).data.active_rule_version_id, /^RULE-ENV-/u);

  const placement = cli(stateDir, [
    'derive', 'recommend', '--root', vault, '--input', 'Projects/Atlas/input.md',
    '--role', 'report', '--filename', 'result.md', '--json',
  ]);
  assert.equal(placement.status, 0, placement.stderr);
  assert.equal(JSON.parse(placement.stdout).data.target, 'Projects/Atlas/Outputs/result.md');

  const sourceCandidate = path.join(caseRoot, 'candidate.md');
  fs.writeFileSync(sourceCandidate, '# Result\n', 'utf8');
  const staged = cli(stateDir, [
    'work', 'stage', '--file', sourceCandidate, '--kind', 'candidate', '--ttl-hours', '24', '--json',
  ]);
  assert.equal(staged.status, 0, staged.stderr);
  const work = JSON.parse(staged.stdout).data;
  const prepared = cli(stateDir, [
    'derive', 'prepare', '--root', vault, '--input', 'Projects/Atlas/input.md',
    '--target', 'Projects/Atlas/Outputs/result.md', '--candidate-file', work.payload_path,
    '--project', projectId, '--role', 'report', '--json',
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const runId = JSON.parse(prepared.stdout).data.run_id;
  const workStatus = JSON.parse(cli(stateDir, ['work', 'status', work.work_id, '--json']).stdout).data;
  assert.equal(workStatus.status, 'captured');
  assert.equal(workStatus.captured_by_run_id, runId);

  const status = JSON.parse(cli(stateDir, ['storage', 'status', '--json']).stdout).data;
  assert.equal(status.policies.inbox_is_temp, false);
  const plan = JSON.parse(cli(stateDir, [
    'storage', 'plan', '--older-than-hours', '0', '--json',
  ]).stdout).data;
  assert.ok(plan.work_items.some((item) => item.work_id === work.work_id));
  assert.equal(fs.existsSync(work.payload_path), true);
  const cleanup = cli(stateDir, ['storage', 'execute', '--older-than-hours', '0', '--json']);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(fs.existsSync(path.dirname(work.payload_path)), false);
  assert.equal(cli(stateDir, ['derive', 'approve', runId, '--json']).status, 0);
  assert.equal(cli(stateDir, ['derive', 'execute', runId, '--json']).status, 0);
});
