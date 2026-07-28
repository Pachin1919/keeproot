import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Bootstrap } from '../src/bootstrap.js';
import { Evolution } from '../src/evolution.js';
import { Guarded } from '../src/guarded.js';
import { Intake } from '../src/intake.js';
import { Registry } from '../src/registry.js';
import { TaskContract } from '../src/task-contract.js';

const tempRoot = path.resolve('test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'library');
  const stateDir = path.join(caseRoot, 'state');
  for (const directory of ['Source', 'Sources', 'Working', 'Outputs']) {
    fs.mkdirSync(path.join(root, 'Projects', 'Website', directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'Projects', 'Website', 'Sources', 'brief.md'), '# Website brief\n', 'utf8');
  fs.writeFileSync(path.join(root, 'Projects', 'Website', 'Source', 'animation-demo.html'), '<main>misplaced demo</main>\n', 'utf8');

  const bootstrap = new Bootstrap({ stateDir });
  const scan = bootstrap.scan({ root, scanMode: 'structure' });
  const contract = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id,
    profileId: 'project-work',
    reason: 'Adopt the reviewed project-work structure for qualification.',
  });
  bootstrap.dispose();

  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Website', currentPath: 'Projects/Website' });
  registry.dispose();
  return { caseRoot, root, stateDir, projectId: project.project_id };
}

function incoming(caseRoot, filename, content) {
  const target = path.join(caseRoot, 'incoming', filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

test('V1 qualification journey organizes generated files, produces governed outputs, preserves lineage, and recovers', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('v1-golden-journey');
  const intake = new Intake({ stateDir });
  const evolution = new Evolution({ stateDir });
  const task = new TaskContract({ stateDir });
  t.after(() => {
    task.dispose();
    evolution.dispose();
    intake.dispose();
  });

  const generatedDemo = incoming(caseRoot, 'new-demo.html', '<main>new demo</main>\n');
  const unknown = incoming(caseRoot, 'unknown.bin', 'unknown');
  const correction = intake.correct({
    root,
    scope: 'project',
    projectId,
    origin: 'agent_generated',
    kind: 'demo',
    role: 'intermediate',
    targetSubdirectory: 'Demos',
    reason: 'Website demos are retained working artifacts, not production source.',
  });
  assert.match(correction.rule_version_id, /^RULE-ROUTE-/);

  const batch = intake.batchPlan({
    root,
    items: [
      { candidateFile: generatedDemo, origin: 'agent_generated', kind: 'demo', projectId },
      { candidateFile: unknown, origin: 'human_submitted', kind: 'unrecognized_binary', projectId },
    ],
  });
  assert.deepEqual(batch.summary, { total: 2, ready: 0, unresolved: 2, blocked: 0 });
  assert.equal(batch.questions.length >= 1, true);
  assert.equal(batch.items[0].target, 'Projects/Website/Demos/new-demo.html');

  const organization = evolution.preparePlan({
    root,
    intent: 'Create a durable demo area and remove a generated demo from production source.',
    operations: [
      { operation: 'create_directory', target: 'Projects/Website/Demos' },
      {
        operation: 'move_file',
        source: 'Projects/Website/Source/animation-demo.html',
        target: 'Projects/Website/Demos/animation-demo.html',
      },
    ],
  });
  evolution.approvePlan(organization.run_id, { reason: 'Approve the exact two-step Website organization plan.' });
  assert.equal(evolution.executePlan(organization.run_id).completed_operations, 2);

  const organizedBatch = intake.batchPlan({
    root,
    items: [
      { candidateFile: generatedDemo, origin: 'agent_generated', kind: 'demo', projectId },
      { candidateFile: unknown, origin: 'human_submitted', kind: 'unrecognized_binary', projectId },
    ],
  });
  assert.deepEqual(organizedBatch.summary, { total: 2, ready: 1, unresolved: 1, blocked: 0 });
  assert.equal(organizedBatch.questions.length, 1);

  const intakeRun = intake.prepare({
    root,
    candidateFile: generatedDemo,
    origin: 'agent_generated',
    kind: 'demo',
    projectId,
    intent: 'Keep the new generated demo in the governed demo area.',
  });
  assert.equal(intakeRun.target, 'Projects/Website/Demos/new-demo.html');
  assert.equal(intake.execute(intakeRun.run_id, { reason: 'Execute the accepted Project routing correction.' }).status, 'executed');

  const discovered = task.discover({
    root, projectId, roles: ['source'], extensions: ['.md'], maxCandidates: 5,
  });
  assert.deepEqual(discovered.candidates.map((item) => item.path), ['Projects/Website/Sources/brief.md']);
  assert.equal(discovered.content_files_read, 0);

  const reportTask = task.prepare({
    root,
    request: {
      intent: 'Create a report from the bounded Website brief.',
      project_id: projectId,
      inputs: [],
      discovery: { roles: ['source'], extensions: ['.md'], max_candidates: 5 },
      output: {
        target: 'Projects/Website/Outputs/report.md', role: 'report',
        data_class: 'generated_output', action: 'create',
      },
    },
    caller: { actor: 'agent', agent: 'Codex', tool: 'qualification-test' },
  });
  const reportCandidate = incoming(caseRoot, 'report.md', '# Governed report\n');
  const report = task.fulfill(reportTask.task_id, { candidateFile: reportCandidate, reason: 'Exact Task authorization.' });
  assert.equal(report.status, 'completed');

  const canonicalTask = task.prepare({
    root,
    request: {
      intent: 'Reuse the governed report as the only input to a canonical summary.',
      project_id: projectId,
      inputs: [{ path: 'Projects/Website/Outputs/report.md' }],
      output: {
        target: 'Projects/Website/Outputs/canonical.md', role: 'canonical',
        data_class: 'generated_output', action: 'create',
      },
    },
  });
  const canonicalCandidate = incoming(caseRoot, 'canonical.md', '# Canonical result\n');
  assert.equal(task.fulfill(canonicalTask.task_id, {
    candidateFile: canonicalCandidate, reason: 'Authorize the canonical derivative.',
  }).status, 'completed');

  const reportDiscovery = task.discover({
    root, projectId, roles: ['report'], extensions: ['.md'], maxCandidates: 10,
  });
  const registeredReport = reportDiscovery.candidates.find((item) => item.path === 'Projects/Website/Outputs/report.md');
  assert.ok(registeredReport?.registered_artifact?.material?.material_id);
  assert.equal(registeredReport.registered_artifact.lineage.input_count, 1);
  assert.equal(registeredReport.registered_artifact.lineage.downstream_count, 1);

  const database = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE mode = 'rule_correction'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels WHERE name = 'routing_rule_correction'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM policy_decisions WHERE run_id = ?").get(correction.run_id).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM material_derivations WHERE relation_type = 'derived_from'").get().count >= 2, true);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT root_path, current_path FROM artifacts WHERE status = 'active'
        GROUP BY root_path, current_path HAVING COUNT(*) > 1
      )
    `).get().count, 0);
  } finally {
    database.close();
  }

  const changedScanRuntime = new Bootstrap({ stateDir });
  const changedScan = changedScanRuntime.scan({ root, scanMode: 'structure', forceNew: true });
  const changedPaths = changedScanRuntime.show(changedScan.scan_id).summary.changes;
  assert.ok(changedPaths.added.includes('Projects/Website/Demos/new-demo.html'));
  assert.ok(changedPaths.added.includes('Projects/Website/Outputs/report.md'));
  assert.ok(changedPaths.added.includes('Projects/Website/Outputs/canonical.md'));
  changedScanRuntime.dispose();

  assert.equal(task.rollback(canonicalTask.task_id).status, 'rolled_back');
  assert.equal(task.rollback(reportTask.task_id).status, 'rolled_back');
  assert.equal(intake.rollback(intakeRun.run_id).status, 'rolled_back');
  assert.equal(evolution.rollbackPlan(organization.run_id).status, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(root, 'Projects', 'Website', 'Source', 'animation-demo.html'), 'utf8'), '<main>misplaced demo</main>\n');
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Website', 'Demos')), false);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Website', 'Outputs', 'report.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Website', 'Outputs', 'canonical.md')), false);

  const recoveredScanRuntime = new Bootstrap({ stateDir });
  const recoveredScan = recoveredScanRuntime.scan({ root, scanMode: 'structure', forceNew: true });
  const recoveredPaths = recoveredScanRuntime.show(recoveredScan.scan_id).summary.changes;
  assert.ok(recoveredPaths.deleted.includes('Projects/Website/Demos/new-demo.html'));
  assert.ok(recoveredPaths.deleted.includes('Projects/Website/Outputs/report.md'));
  assert.ok(recoveredPaths.deleted.includes('Projects/Website/Outputs/canonical.md'));
  recoveredScanRuntime.dispose();
});

test('V1 qualification failure journey stops when the Project boundary changes after Task preparation', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('v1-stale-project-journey');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Prepare a report before the Project moves.',
      project_id: projectId,
      inputs: [{ path: 'Projects/Website/Sources/brief.md' }],
      output: {
        target: 'Projects/Website/Outputs/report.md', role: 'report',
        data_class: 'generated_output', action: 'create',
      },
    },
  });
  const registry = new Registry({ stateDir });
  registry.update(projectId, { currentPath: 'Projects/Website-Renamed', reason: 'Simulate a reviewed Project evolution.' });
  registry.dispose();

  assert.throws(() => task.fulfill(prepared.task_id, {
    candidateFile: incoming(caseRoot, 'stale-report.md', '# stale\n'),
    reason: 'This must be rejected after the Project changes.',
  }), /Project path changed|project_path_changed|changed/i);
  assert.equal(task.show(prepared.task_id).run.status, 'stale');
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Website', 'Outputs', 'report.md')), false);
});

test('V1 failure journey stops on a changed RuleVersion and on a changed selected path before any target write', (t) => {
  const first = setup('v1-stale-rule-journey');
  const taskForRule = new TaskContract({ stateDir: first.stateDir });
  t.after(() => taskForRule.dispose());
  const rulePrepared = taskForRule.prepare({
    root: first.root,
    request: {
      intent: 'Use exactly the reviewed environment rule.', project_id: first.projectId,
      inputs: [{ path: 'Projects/Website/Sources/brief.md' }],
      output: { target: 'Projects/Website/Outputs/rule-report.md', role: 'report', data_class: 'generated_output', action: 'create' },
    },
  });
  fs.mkdirSync(path.join(first.root, 'Archive'));
  const bootstrap = new Bootstrap({ stateDir: first.stateDir });
  const scan = bootstrap.scan({ root: first.root, scanMode: 'structure', forceNew: true });
  const contract = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id, profileId: 'project-work', reason: 'Activate a changed environment rule.',
  });
  bootstrap.dispose();
  assert.throws(() => taskForRule.fulfill(rulePrepared.task_id, {
    candidateFile: incoming(first.caseRoot, 'rule-report.md', '# stale rule\n'), reason: 'Must stop.',
  }), /stale|changed/i);
  assert.equal(fs.existsSync(path.join(first.root, rulePrepared.write.target)), false);

  const second = setup('v1-stale-input-path-journey');
  const taskForPath = new TaskContract({ stateDir: second.stateDir });
  t.after(() => taskForPath.dispose());
  const pathPrepared = taskForPath.prepare({
    root: second.root,
    request: {
      intent: 'Use one selected path without silent replacement.', project_id: second.projectId,
      inputs: [{ path: 'Projects/Website/Sources/brief.md' }],
      output: { target: 'Projects/Website/Outputs/path-report.md', role: 'report', data_class: 'generated_output', action: 'create' },
    },
  });
  fs.renameSync(
    path.join(second.root, 'Projects', 'Website', 'Sources', 'brief.md'),
    path.join(second.root, 'Projects', 'Website', 'Sources', 'brief-moved.md'),
  );
  assert.throws(() => taskForPath.fulfill(pathPrepared.task_id, {
    candidateFile: incoming(second.caseRoot, 'path-report.md', '# stale path\n'), reason: 'Must stop.',
  }), /stale|changed/i);
  assert.equal(fs.existsSync(path.join(second.root, pathPrepared.write.target)), false);
});

test('V1 Guarded journey reconciles an interrupted append from Ledger and restores exact bytes', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('v1-guarded-ledger-reconcile');
  const target = 'Projects/Website/Sources/metrics.csv';
  const baseline = 'date,value\r\n2026-01-01,1\r\n';
  fs.writeFileSync(path.join(root, ...target.split('/')), baseline, 'utf8');
  let task = new TaskContract({ stateDir });
  const guarded = new Guarded({ stateDir });
  t.after(() => {
    task.dispose();
    guarded.dispose();
  });
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Append one verified metric row.', project_id: projectId,
      inputs: [{ path: target }],
      output: { target, role: 'source', data_class: 'append_only_data', action: 'append' },
    },
  });
  const candidateFile = incoming(caseRoot, 'metrics.csv', `${baseline}2026-02-01,2\r\n`);
  const staged = task.fulfill(prepared.task_id, { candidateFile, reason: 'Stage exact append.' });
  guarded.approve(staged.write_run.run_id, { reason: 'Approve exact guarded append.' });
  guarded.execute(staged.write_run.run_id);
  task.dispose();

  task = new TaskContract({ stateDir });
  const reconciled = task.show(prepared.task_id);
  assert.equal(reconciled.run.status, 'ready');
  assert.equal(reconciled.underlying_run_id, staged.write_run.run_id);
  assert.equal(task.complete(prepared.task_id, { runId: reconciled.underlying_run_id }).status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, ...target.split('/')), 'utf8'), `${baseline}2026-02-01,2\r\n`);
  assert.equal(task.rollback(prepared.task_id).status, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(root, ...target.split('/')), 'utf8'), baseline);

  const database = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_contracts WHERE run_id = ? AND underlying_run_id = ?').get(
      prepared.task_id, staged.write_run.run_id,
    ).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM material_derivations WHERE relation_type = 'appends_to'").get().count, 1);
  } finally {
    database.close();
  }
});
