import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Bootstrap } from '../src/bootstrap.js';
import { Registry } from '../src/registry.js';
import { Tracker } from '../src/tracker.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'bin', 'atlas.js');
const templateRoot = path.join(projectRoot, 'fixtures', 'vault-template');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

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

test('CLI exposes the bounded Task Contract create and rollback flow', () => {
  const { caseRoot, vault, stateDir } = setup('cli-task-contract');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Sources'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Outputs'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Projects', 'Atlas', 'Sources', 'source.md'), 'bounded source\n', 'utf8');
  const bootstrap = new Bootstrap({ stateDir });
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  const contract = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id, profileId: 'project-work', reason: 'CLI Task fixture.',
  });
  bootstrap.dispose();
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' });
  registry.dispose();
  const discoveredResult = cli(stateDir, [
    'task', 'discover', '--root', vault, '--project', project.project_id,
    '--role', 'source', '--extension', '.md', '--max-candidates', '5', '--json',
  ]);
  assert.equal(discoveredResult.status, 0, discoveredResult.stderr);
  const discovered = JSON.parse(discoveredResult.stdout).data;
  assert.deepEqual(discovered.candidates.map((item) => item.path), ['Projects/Atlas/Sources/source.md']);
  assert.equal(discovered.content_files_read, 0);
  const requestFile = path.join(caseRoot, 'task-request.json');
  fs.writeFileSync(requestFile, JSON.stringify({
    intent: 'Create one governed report.',
    project_id: project.project_id,
    inputs: [{ path: 'Projects/Atlas/Sources/source.md', required: true }],
    output: {
      target: 'Projects/Atlas/Outputs/report.md', role: 'report',
      data_class: 'generated_output', action: 'auto',
    },
  }), 'utf8');
  const preparedResult = cli(stateDir, ['task', 'prepare', '--root', vault, '--request-file', requestFile, '--json']);
  assert.equal(preparedResult.status, 0, preparedResult.stderr);
  const prepared = JSON.parse(preparedResult.stdout).data;
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.read.selected.length, 1);
  const candidateFile = path.join(caseRoot, 'candidate.md');
  fs.writeFileSync(candidateFile, '# Governed report\n', 'utf8');
  const fulfilledResult = cli(stateDir, [
    'task', 'fulfill', prepared.task_id, '--candidate-file', candidateFile,
    '--reason', 'Exact Task authorization.', '--json',
  ]);
  assert.equal(fulfilledResult.status, 0, fulfilledResult.stderr);
  const fulfilled = JSON.parse(fulfilledResult.stdout).data;
  assert.equal(fulfilled.status, 'completed');
  assert.equal(fulfilled.write_run.mode, 'derived');
  const shown = cli(stateDir, ['task', 'show', prepared.task_id, '--json']);
  assert.equal(JSON.parse(shown.stdout).data.run.status, 'completed');
  const compactShown = cli(stateDir, ['show', fulfilled.write_run.run_id, '--compact', '--json']);
  assert.equal(compactShown.status, 0, compactShown.stderr);
  const compactRun = JSON.parse(compactShown.stdout).data;
  assert.equal(compactRun.compact, true);
  assert.equal(compactRun.changes.length, 1);
  assert.equal(Object.hasOwn(compactRun, 'events'), false);
  assert.equal(Object.hasOwn(compactRun.change_set, 'diff_text'), false);
  assert.equal(cli(stateDir, ['task', 'rollback', prepared.task_id, '--json']).status, 0);
  assert.equal(fs.existsSync(path.join(vault, 'Projects', 'Atlas', 'Outputs', 'report.md')), false);

  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Archive'), { recursive: true });
  const archiveRequest = path.join(caseRoot, 'archive-request.json');
  fs.writeFileSync(archiveRequest, JSON.stringify({
    intent: 'Retain and archive the source.',
    project_id: project.project_id,
    inputs: [{ path: 'Projects/Atlas/Sources/source.md' }],
    output: {
      target: 'Projects/Atlas/Archive/source.md',
      base_input: 'Projects/Atlas/Sources/source.md',
      role: 'archive', data_class: 'human_writing', action: 'archive',
    },
  }), 'utf8');
  const archiveTaskResult = cli(stateDir, [
    'task', 'prepare', '--root', vault, '--request-file', archiveRequest, '--json',
  ]);
  assert.equal(archiveTaskResult.status, 0, archiveTaskResult.stderr);
  const archiveTask = JSON.parse(archiveTaskResult.stdout).data;
  const archivePlanResult = cli(stateDir, ['task', 'archive-plan', archiveTask.task_id, '--json']);
  assert.equal(archivePlanResult.status, 0, archivePlanResult.stderr);
  assert.equal(JSON.parse(archivePlanResult.stdout).data.status, 'prepared');
  assert.equal(fs.existsSync(path.join(vault, 'Projects', 'Atlas', 'Sources', 'source.md')), true);
});

test('CLI Intake creates one Agent-proposed target without a Library Contract', () => {
  const { caseRoot, vault, stateDir } = setup('cli-intake-explicit-target');
  fs.mkdirSync(path.join(vault, '08 AI聊天记录'), { recursive: true });
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'AI聊天记录', currentPath: '08 AI聊天记录' });
  registry.dispose();
  const candidateFile = path.join(caseRoot, 'chat-export.md');
  fs.writeFileSync(candidateFile, '# Chat export\n', 'utf8');
  const target = '08 AI聊天记录/ChatGPT聊天记录 感情反转分析（2026-07）.md';

  const preparedResult = cli(stateDir, [
    'intake', 'prepare', '--root', vault, '--candidate-file', candidateFile,
    '--origin', 'download', '--kind', 'source', '--project', project.project_id,
    '--target', target, '--intent', 'Save one classified chat export.', '--json',
  ]);
  assert.equal(preparedResult.status, 0, preparedResult.stderr);
  const prepared = JSON.parse(preparedResult.stdout).data;
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.target, target);
  assert.equal(prepared.placement_policy.intake.route_source, 'agent_explicit_target');

  const executedResult = cli(stateDir, [
    'intake', 'execute', prepared.run_id,
    '--reason', 'The user authorized this exact destination.', '--json',
  ]);
  assert.equal(executedResult.status, 0, executedResult.stderr);
  assert.equal(JSON.parse(executedResult.stdout).data.verified, true);
  assert.equal(fs.readFileSync(path.join(vault, target), 'utf8'), '# Chat export\n');

  const rolledBack = cli(stateDir, ['intake', 'rollback', prepared.run_id, '--json']);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(fs.existsSync(path.join(vault, target)), false);
});

test('CLI Intake imports multiple authorized attachments in one Runtime process', () => {
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

  const result = cli(stateDir, [
    'intake', 'batch-execute', '--root', vault, '--request-file', requestFile,
    '--reason', 'The user submitted these three reports for the exact targets.',
    '--actor', 'agent', '--agent', 'Codex', '--model', 'test', '--tool', 'codex',
    '--client-run-id', 'attachment-batch-test', '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout).data;
  assert.equal(receipt.status, 'executed');
  assert.equal(receipt.summary.total, 3);
  assert.equal(receipt.summary.executed, 3);
  assert.equal(receipt.runtime_processes, 1);
  assert.equal(receipt.local_input_bytes, items.reduce(
    (total, item) => total + fs.statSync(item.candidateFile).size,
    0,
  ));
  assert.equal(receipt.content_body_reads, 0);
  assert.equal(receipt.model_visible_body_bytes, 0);
  assert.equal(receipt.items.every((item) => item.verified && item.rollback_ready), true);
  for (const item of items) {
    assert.equal(fs.existsSync(path.join(vault, item.target)), true);
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
  }

  const doctor = JSON.parse(cli(stateDir, ['doctor', '--json']).stdout);
  assert.equal(doctor.data.status, 'ok');
  assert.equal(doctor.data.ledger.integrity, 'ok');
  assert.equal(doctor.data.ledger.schema_version, doctor.data.ledger.supported_schema_version);

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
