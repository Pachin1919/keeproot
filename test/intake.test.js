import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Bootstrap } from '../src/bootstrap.js';
import { Intake } from '../src/intake.js';
import { Registry } from '../src/registry.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = path.join(projectRoot, 'fixtures', 'bootstrap-vault');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const vault = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(caseRoot, { recursive: true });
  fs.cpSync(templateRoot, vault, { recursive: true });
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Sources'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Working'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Outputs'), { recursive: true });

  const bootstrap = new Bootstrap({ stateDir });
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  const contract = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id,
    profileId: 'project-work',
    reason: 'Intake fixture Contract.',
  });
  bootstrap.dispose();

  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' });
  registry.dispose();
  return { caseRoot, vault, stateDir, projectId: project.project_id };
}

function candidate(caseRoot, name, content) {
  const file = path.join(caseRoot, 'incoming', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('Intake classifies and routes an Agent demo, executes without a second placement review, and rolls back', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('intake-agent-demo');
  const source = candidate(caseRoot, 'animation-demo.html', '<main>demo</main>\n');
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());

  const prepared = intake.prepare({
    root: vault,
    candidateFile: source,
    origin: 'agent_generated',
    kind: 'demo',
    projectId,
    intent: 'Keep a generated animation demo out of website source code.',
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.classification.origin, 'agent_generated');
  assert.equal(prepared.classification.kind, 'demo');
  assert.equal(prepared.classification.role, 'intermediate');
  assert.equal(prepared.target, 'Projects/Atlas/Working/animation-demo.html');
  assert.equal(prepared.confidence >= 0.9, true);
  assert.equal(prepared.auto_execute, true);
  assert.deepEqual(prepared.questions, []);

  const preview = intake.show(prepared.run_id);
  assert.equal(preview.placement.policy.intake.origin, 'agent_generated');
  assert.equal(preview.placement.policy.intake.kind, 'demo');
  assert.equal(preview.inputs.length, 0);
  const executed = intake.execute(prepared.run_id, {
    reason: 'The user authorized organizing this generated demo.',
  });
  assert.equal(executed.status, 'executed');
  assert.equal(executed.intake.origin, 'agent_generated');
  assert.equal(fs.readFileSync(path.join(vault, prepared.target), 'utf8'), '<main>demo</main>\n');

  const repeated = intake.execute(prepared.run_id, {
    reason: 'The user authorized organizing this generated demo.',
  });
  assert.deepEqual(repeated, executed);
  const rolledBack = intake.rollback(prepared.run_id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(vault, prepared.target)), false);
  assert.equal(fs.existsSync(source), true);
});

test('Intake accepts one Agent-proposed target without forcing a whole-library Contract', (t) => {
  const caseRoot = path.join(tempRoot, 'intake-explicit-target');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const vault = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  const chatDirectory = path.join(vault, '08 AI聊天记录');
  fs.mkdirSync(chatDirectory, { recursive: true });
  const source = candidate(caseRoot, 'chat-export.md', '# Chat export\n');

  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'AI聊天记录', currentPath: '08 AI聊天记录' });
  registry.dispose();

  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  const target = '08 AI聊天记录/ChatGPT聊天记录 感情反转分析（2026-07）.md';
  const prepared = intake.prepare({
    root: vault,
    candidateFile: source,
    origin: 'download',
    kind: 'source',
    projectId: project.project_id,
    target,
    intent: 'Save one classified ChatGPT export.',
  });

  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.target, target);
  assert.equal(prepared.auto_execute, true);
  assert.equal(prepared.placement_policy.intake.route_source, 'agent_explicit_target');
  assert.equal(prepared.placement_policy.configured, false);

  const executed = intake.execute(prepared.run_id, {
    reason: 'The user authorized this exact classified destination.',
  });
  assert.equal(executed.status, 'executed');
  assert.equal(fs.readFileSync(path.join(vault, target), 'utf8'), '# Chat export\n');

  const rolledBack = intake.rollback(prepared.run_id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(vault, target)), false);

  assert.throws(() => intake.prepare({
    root: vault,
    candidateFile: source,
    origin: 'download',
    kind: 'source',
    projectId: project.project_id,
    target: '../escape.md',
  }), /escapes the root/i);
});

test('Intake defaults origins to clear roles and routes them through the accepted Contract', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('intake-origin-defaults');
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  const cases = [
    ['human_submitted', 'raw_input', 'Sources'],
    ['human_written', 'note', 'Working'],
    ['agent_generated', 'intermediate', 'Working'],
    ['download', 'source', 'Sources'],
  ];
  for (const [origin, role, directory] of cases) {
    const source = candidate(caseRoot, `${origin}.md`, `# ${origin}\n`);
    const prepared = intake.prepare({ root: vault, candidateFile: source, origin, projectId });
    assert.equal(prepared.classification.role, role);
    assert.equal(prepared.target, `Projects/Atlas/${directory}/${origin}.md`);
    assert.equal(prepared.auto_execute, true);
  }
});

test('Intake returns bounded questions for an unknown kind or unresolved Project instead of guessing', (t) => {
  const { caseRoot, vault, stateDir } = setup('intake-needs-input');
  const source = candidate(caseRoot, 'mystery.bin', 'unknown');
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());

  const unknown = intake.prepare({
    root: vault,
    candidateFile: source,
    origin: 'human_submitted',
    kind: 'financial_model',
  });
  assert.equal(unknown.status, 'needs_input');
  assert.equal(unknown.run_id, null);
  assert.ok(unknown.questions.length >= 1 && unknown.questions.length <= 3);
  assert.equal(fs.existsSync(path.join(vault, 'mystery.bin')), false);

  const registry = new Registry({ stateDir });
  registry.create({ name: 'Second', currentPath: 'Projects/Second' });
  registry.dispose();
  const noProject = intake.prepare({
    root: vault,
    candidateFile: source,
    origin: 'download',
  });
  assert.equal(noProject.status, 'needs_input');
  assert.equal(noProject.run_id, null);
  assert.ok(noProject.questions.some((question) => question.field === 'project_id'));
});

test('Intake refuses a Candidate inside the governed root and never overwrites a routed target', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('intake-boundaries');
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  assert.throws(() => intake.prepare({
    root: vault,
    candidateFile: path.join(vault, 'Projects', 'Atlas', 'Overview.md'),
    origin: 'human_written',
    projectId,
  }), /outside the governed root/i);

  const source = candidate(caseRoot, 'Overview.md', '# collision\n');
  fs.writeFileSync(path.join(vault, 'Projects', 'Atlas', 'Outputs', 'Overview.md'), '# existing\n', 'utf8');
  const blocked = intake.prepare({
    root: vault,
    candidateFile: source,
    origin: 'human_written',
    kind: 'report',
    filename: 'Overview.md',
    projectId,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.run_id, null);
  assert.match(blocked.reason, /already exists/i);
});

test('Intake execution stops when the external Candidate or stable Project changed after prepare', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('intake-stale-context');
  const source = candidate(caseRoot, 'draft.md', '# original\n');
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  const prepared = intake.prepare({
    root: vault,
    candidateFile: source,
    origin: 'human_written',
    kind: 'draft',
    projectId,
  });
  fs.writeFileSync(source, '# changed after prepare\n', 'utf8');
  assert.throws(() => intake.execute(prepared.run_id, { reason: 'Authorized Intake.' }), /changed after prepare/i);
  assert.equal(fs.existsSync(path.join(vault, prepared.target)), false);

  fs.writeFileSync(source, '# original\n', 'utf8');
  const registry = new Registry({ stateDir });
  registry.update(projectId, { currentPath: 'Projects/Atlas-Renamed', reason: 'Fixture evolution' });
  registry.dispose();
  assert.throws(() => intake.execute(prepared.run_id, { reason: 'Authorized Intake.' }), /Project changed/i);
  assert.equal(intake.show(prepared.run_id).run.status, 'prepared');
});

test('Intake corrections apply at artifact, Project, and global scope through distinct RuleVersions', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('intake-correction-scopes');
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  const one = candidate(caseRoot, 'one-demo.html', '<main>one</main>\n');
  const two = candidate(caseRoot, 'two-demo.html', '<main>two</main>\n');

  const artifactRule = intake.correct({
    root: vault,
    scope: 'artifact',
    candidateFile: one,
    origin: 'agent_generated',
    kind: 'demo',
    role: 'source',
    targetSubdirectory: 'Sources',
    reason: 'This specific demo is reusable source material.',
  });
  assert.match(artifactRule.rule_version_id, /^RULE-ROUTE-/);
  assert.equal(intake.plan({
    root: vault, candidateFile: one, origin: 'agent_generated', kind: 'demo', projectId,
  }).target, 'Projects/Atlas/Sources/one-demo.html');
  assert.equal(intake.plan({
    root: vault, candidateFile: two, origin: 'agent_generated', kind: 'demo', projectId,
  }).target, 'Projects/Atlas/Working/two-demo.html');

  const projectRule = intake.correct({
    root: vault,
    scope: 'project',
    projectId,
    origin: 'agent_generated',
    kind: 'analysis_bundle',
    role: 'report',
    targetSubdirectory: 'Outputs',
    reason: 'Analysis bundles in this Project are reviewable reports.',
  });
  const projectPlan = intake.plan({
    root: vault,
    candidateFile: candidate(caseRoot, 'analysis.md', '# Analysis\n'),
    origin: 'agent_generated',
    kind: 'analysis_bundle',
    projectId,
  });
  assert.equal(projectPlan.classification.basis, 'routing_correction');
  assert.equal(projectPlan.classification.role, 'report');
  assert.equal(projectPlan.target, 'Projects/Atlas/Outputs/analysis.md');

  const globalRule = intake.correct({
    root: vault,
    scope: 'global',
    origin: 'download',
    kind: 'web_capture',
    role: 'source',
    targetSubdirectory: 'Sources',
    reason: 'Web captures are sources in every Project under this Contract.',
  });
  const globalPlan = intake.plan({
    root: vault,
    candidateFile: candidate(caseRoot, 'capture.md', '# Capture\n'),
    origin: 'download',
    kind: 'web_capture',
    projectId,
  });
  assert.equal(globalPlan.target, 'Projects/Atlas/Sources/capture.md');
  assert.equal(globalPlan.correction.scope, 'global');
  assert.notEqual(globalRule.rule_version_id, projectRule.rule_version_id);
  assert.notEqual(projectRule.rule_version_id, artifactRule.rule_version_id);

  intake.dispose();
  const database = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE mode = 'rule_correction'").get().count, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM predictions WHERE kind = 'routing_rule_correction'").get().count, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels WHERE name = 'routing_rule_correction'").get().count, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM policy_decisions WHERE decision = 'allow' AND reason LIKE 'Reviewed routing correction%'").get().count, 3);
  } finally {
    database.close();
  }
});

test('Intake batch planning summarizes ready and unresolved items without creating one run per question', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('intake-batch-plan');
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  const result = intake.batchPlan({
    root: vault,
    items: [
      { candidateFile: candidate(caseRoot, 'note.md', '# Note\n'), origin: 'human_written', projectId },
      { candidateFile: candidate(caseRoot, 'asset.png', 'asset'), origin: 'download', kind: 'asset', projectId },
      { candidateFile: candidate(caseRoot, 'unknown.bin', 'unknown'), origin: 'human_submitted', kind: 'new_binary', projectId },
    ],
  });
  assert.deepEqual(result.summary, { total: 3, ready: 2, unresolved: 1, blocked: 0 });
  assert.equal(result.questions.length, 1);
  assert.equal(result.items.filter((item) => item.status === 'ready').length, 2);
  assert.equal(intake.derived.ledger.listRuns().filter((run) => run.mode === 'derived').length, 0);
});

test('all four origins and every V1 role have a deterministic Project route or one reviewed structure need', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('intake-origin-role-matrix');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Archive'), { recursive: true });
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  const origins = ['human_submitted', 'human_written', 'agent_generated', 'download'];
  const roles = [
    'unclassified', 'raw_input', 'source', 'note', 'journal', 'draft',
    'intermediate', 'report', 'canonical', 'index', 'template', 'archive',
  ];
  const expectedDirectory = {
    unclassified: 'Sources', raw_input: 'Sources', source: 'Sources',
    note: 'Working', journal: 'Working', draft: 'Working', intermediate: 'Working', template: 'Working',
    report: 'Outputs', canonical: 'Outputs', index: 'Outputs', archive: 'Archive',
  };
  for (const origin of origins) {
    for (const role of roles) {
      const filename = `${origin}-${role}.md`;
      const plan = intake.plan({
        root: vault,
        candidateFile: candidate(caseRoot, filename, `# ${origin} ${role}\n`),
        origin,
        kind: role,
        projectId,
      });
      assert.equal(plan.status, 'ready', `${origin}:${role}:${plan.reason}`);
      assert.equal(plan.classification.role, role, `${origin}:${role}`);
      assert.equal(plan.target, `Projects/Atlas/${expectedDirectory[role]}/${filename}`);
      assert.deepEqual(plan.questions, []);
    }
  }
});

test('same content from different origins keeps distinct source facts while sharing content-addressed Blob storage', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('intake-origin-material-dedup');
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  const content = '# Shared bytes\n';
  const human = intake.prepare({
    root: vault,
    candidateFile: candidate(caseRoot, 'human.md', content),
    origin: 'human_submitted', kind: 'source', projectId,
  });
  const download = intake.prepare({
    root: vault,
    candidateFile: candidate(caseRoot, 'download.md', content),
    origin: 'download', kind: 'source', projectId,
  });
  intake.execute(human.run_id, { reason: 'Capture the human source fact.' });
  intake.execute(download.run_id, { reason: 'Capture the download source fact.' });
  assert.equal(intake.show(human.run_id).placement.policy.intake.origin, 'human_submitted');
  assert.equal(intake.show(download.run_id).placement.policy.intake.origin, 'download');

  intake.dispose();
  const database = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT a.origin_run_id, a.current_path, m.content_hash, m.blob_path
      FROM artifacts a JOIN materials m ON m.artifact_id = a.id
      WHERE a.origin_run_id IN (?, ?) AND m.stage = 'output'
      ORDER BY a.origin_run_id
    `).all(human.run_id, download.run_id);
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.origin_run_id)).size, 2);
    assert.equal(new Set(rows.map((row) => row.current_path)).size, 2);
    assert.equal(new Set(rows.map((row) => row.content_hash)).size, 1);
    assert.equal(new Set(rows.map((row) => row.blob_path)).size, 1);
  } finally {
    database.close();
  }
});

test('a reviewed routing correction is reused by later same-type Intake without another question', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('intake-correction-reuse');
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  const correction = intake.correct({
    root: vault,
    scope: 'project',
    projectId,
    origin: 'agent_generated',
    kind: 'animation_prototype',
    role: 'intermediate',
    targetSubdirectory: 'Working',
    reason: 'Animation prototypes are working artifacts in this Project.',
  });
  for (const filename of ['prototype-a.html', 'prototype-b.html']) {
    const plan = intake.plan({
      root: vault,
      candidateFile: candidate(caseRoot, filename, '<main>prototype</main>\n'),
      origin: 'agent_generated', kind: 'animation_prototype', projectId,
    });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.auto_execute, true);
    assert.deepEqual(plan.questions, []);
    assert.equal(plan.correction.rule_version_id, correction.rule_version_id);
  }
});
