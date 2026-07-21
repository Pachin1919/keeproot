import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bootstrap } from '../src/bootstrap.js';
import { Derived } from '../src/derived.js';
import { Guarded } from '../src/guarded.js';
import { Registry } from '../src/registry.js';
import { TaskContract } from '../src/task-contract.js';
import { Tracker } from '../src/tracker.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = path.join(projectRoot, '.atlas', 'v1-demo');
const stateDir = path.join(demoRoot, 'state');
const bootstrapVault = path.join(demoRoot, 'bootstrap-vault');
const changeVault = path.join(demoRoot, 'change-vault');

fs.rmSync(demoRoot, { recursive: true, force: true });
fs.mkdirSync(demoRoot, { recursive: true });
fs.cpSync(path.join(projectRoot, 'fixtures', 'bootstrap-vault'), bootstrapVault, { recursive: true });
fs.cpSync(path.join(projectRoot, 'fixtures', 'demo-vault'), changeVault, { recursive: true });

console.log('=== 1. Bootstrap: scan -> default Profile + Agent proposal -> review -> initialize -> rescan ===');
const bootstrap = new Bootstrap({ stateDir });
try {
  const scan = bootstrap.scan({ root: bootstrapVault, scanMode: 'structure' });
  const context = bootstrap.context(scan.scan_id, { maxSamples: 3 });
  assert.equal(context.content_included, false);
  const profile = bootstrap.recommend(scan.scan_id, { profileId: 'project-work' });
  const proposal = bootstrap.propose(scan.scan_id, {
    caller: {
      actor: 'agent', agent: 'Codex', model: 'fixture-model', tool: 'v1-demo', client_run_id: 'v1-demo',
    },
    predictions: [{
      kind: 'project_candidate',
      summary: 'Projects/Atlas is a stable Atlas Project.',
      confidence: 0.95,
      risk: 'low',
      affected_paths: ['Projects/Atlas'],
      evidence: { directory: 'Projects/Atlas', basis: ['observed project folder', 'overview note'] },
      proposed_action: 'Register Projects/Atlas and route reviewed Atlas outputs there.',
    }, {
      kind: 'routing_rule_candidate',
      summary: 'Generated Atlas reports should be placed under Projects/Atlas.',
      confidence: 0.9,
      risk: 'low',
      affected_paths: ['Projects/Atlas'],
      evidence: { role: 'report', target_directory: 'Projects/Atlas' },
      proposed_action: 'Use this route for reviewed report outputs.',
    }],
  });
  const detail = bootstrap.show(scan.scan_id);
  for (const prediction of detail.predictions) {
    bootstrap.review(prediction.id, { decision: 'accepted', reason: 'V1 fixture demo' });
  }
  const initialized = bootstrap.initialize(scan.scan_id);
  const rescan = bootstrap.scan({ root: bootstrapVault, scanMode: 'structure' });
  assert.equal(rescan.scan_id, scan.scan_id);
  console.log(`Initialized ${scan.scan_id}: Profile=${profile.profile_id}, RuleVersion=${initialized.active_rule_version_id}, ${proposal.prediction_ids.length} Agent proposal(s), ${initialized.registered_projects} Project(s).`);
} finally {
  bootstrap.dispose();
}

console.log('\n=== 2. Derived: inputs -> classified candidate -> placement review -> create -> lineage -> rollback ===');
const registryForDerived = new Registry({ stateDir });
const derivedProject = registryForDerived.list().find((project) => project.current_path === 'Projects/Atlas');
registryForDerived.dispose();
assert.ok(derivedProject);
const derivedTarget = path.join(bootstrapVault, 'Projects', 'Atlas', 'Generated Report.md');
const derived = new Derived({ stateDir });
try {
  const route = derived.recommend({
    root: bootstrapVault,
    inputs: ['Projects/Atlas/Overview.md'],
    role: 'report',
    filename: 'Generated Report.md',
  });
  assert.equal(route.target, 'Projects/Atlas/Generated Report.md');
  const prepared = derived.prepare({
    root: bootstrapVault,
    inputs: ['Projects/Atlas/Overview.md'],
    target: 'Projects/Atlas/Generated Report.md',
    candidateContent: '# Generated Report\n\nDerived from the Atlas overview.\n',
    projectId: derivedProject.id,
    role: 'report',
    relationType: 'summarizes',
    intent: 'V1 classified derived output demo',
  });
  derived.approve(prepared.run_id, { reason: 'V1 fixture placement approval' });
  const executed = derived.execute(prepared.run_id);
  const shown = derived.preview(prepared.run_id);
  assert.equal(shown.output.role, 'report');
  assert.equal(shown.lineage[0].relation_type, 'summarizes');
  derived.promote(prepared.run_id, { role: 'canonical', reason: 'V1 demo accepts the report' });
  assert.equal(derived.preview(prepared.run_id).output.role, 'canonical');
  derived.rollback(prepared.run_id);
  assert.equal(fs.existsSync(derivedTarget), false);
  console.log(`Created ${executed.run_id}: recommended route, lineage=summarizes, report→canonical; rollback verified.`);
} finally {
  derived.dispose();
}

console.log('\n=== 3. Task Contract: bounded read -> governed create -> lineage -> rollback ===');
const taskCandidate = path.join(demoRoot, 'task-candidate.md');
fs.writeFileSync(taskCandidate, '# Task Report\n\nCreated from the bounded selected input.\n', 'utf8');
const task = new TaskContract({ stateDir });
try {
  const prepared = task.prepare({
    root: bootstrapVault,
    request: {
      intent: 'Create one report from an explicitly bounded source.',
      project_id: derivedProject.id,
      inputs: [{ path: 'Projects/Atlas/Overview.md', required: true }],
      budget: { max_files: 1, max_bytes: 65536 },
      output: {
        target: 'Projects/Atlas/Task Report.md', role: 'report',
        data_class: 'generated_output', action: 'auto',
      },
    },
    caller: { actor: 'agent', agent: 'Codex', tool: 'v1-demo', client_run_id: 'v1-demo-task' },
  });
  assert.equal(prepared.read.selected.length, 1);
  const completed = task.fulfill(prepared.task_id, {
    candidateFile: taskCandidate,
    reason: 'The fixture task authorizes this exact output.',
  });
  const shown = task.show(prepared.task_id);
  assert.equal(shown.output.lineage[0].relation_type, 'derived_from');
  task.rollback(prepared.task_id);
  assert.equal(fs.existsSync(path.join(bootstrapVault, prepared.write.target)), false);
  console.log(`Completed ${completed.task_id}: selected=1, strategy=${prepared.write.strategy}, lineage=derived_from; rollback verified.`);
} finally {
  task.dispose();
}

console.log('\n=== 4. Tracked Direct: begin -> external edit -> close -> show -> rollback ===');
const note = path.join(changeVault, 'note-a.md');
const trackedBaseline = fs.readFileSync(note, 'utf8');
const tracker = new Tracker({ stateDir });
try {
  const run = tracker.begin({ root: changeVault, allow: ['note-a.md'], intent: 'V1 demo edit' });
  fs.appendFileSync(note, 'tracked demo change\n', 'utf8');
  const closed = tracker.close(run.run_id);
  const shown = tracker.show(run.run_id);
  assert.equal(shown.changes.length, 1);
  tracker.rollback(run.run_id);
  assert.equal(fs.readFileSync(note, 'utf8'), trackedBaseline);
  console.log(`Closed ${run.run_id}: ${closed.changed_files} allowed change; rollback verified.`);
} finally {
  tracker.dispose();
}

console.log('\n=== 5. Guarded: prepare -> preview -> approve -> execute -> verify -> rollback ===');
const guardedBaseline = fs.readFileSync(note, 'utf8');
const guardedCandidate = `${guardedBaseline}guarded approved change\n`;
const guarded = new Guarded({ stateDir });
try {
  const prepared = guarded.prepare({
    root: changeVault,
    target: 'note-a.md',
    candidateContent: guardedCandidate,
    intent: 'V1 protected demo edit',
  });
  const preview = guarded.preview(prepared.run_id);
  assert.match(preview.candidate.diff_text, /guarded approved change/);
  guarded.approve(prepared.run_id, { reason: 'V1 fixture demo approval' });
  const executed = guarded.execute(prepared.run_id);
  assert.equal(fs.readFileSync(note, 'utf8'), guardedCandidate);
  guarded.rollback(prepared.run_id);
  assert.equal(fs.readFileSync(note, 'utf8'), guardedBaseline);
  console.log(`Executed ${prepared.run_id}: verified=${executed.verified}; rollback verified.`);
} finally {
  guarded.dispose();
}

const registry = new Registry({ stateDir });
try {
  console.log(`\nRegistry contains ${registry.list().length} stable Project record(s).`);
} finally {
  registry.dispose();
}

console.log('\nAtlas 0.1 foundation fixture demo completed without modifying any real Vault.');
