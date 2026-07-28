import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installRuntime } from '../src/runtime-install.js';
import { InstalledSkillDriver } from '../test-support/installed-skill-driver.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = path.join(projectRoot, 'fixtures', 'v1-products');
const tempRoot = path.join(projectRoot, 'test', '.tmp');
const caller = [
  '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
  '--tool', 'atlas-file-governance', '--client-run-id', 'product-fixture',
];

function setup(name) {
  const caseRoot = path.join(tempRoot, `product-${name}`);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  fs.mkdirSync(caseRoot, { recursive: true });
  const fixture = path.join(fixturesRoot, name);
  const scenario = JSON.parse(fs.readFileSync(path.join(fixture, 'scenario.json'), 'utf8'));
  const library = path.join(caseRoot, 'Library');
  fs.cpSync(path.join(fixture, 'Projects'), path.join(library, 'Projects'), { recursive: true });
  const installRoot = path.join(caseRoot, '用户 Atlas');
  const skillRoot = path.join(caseRoot, '用户 Codex', 'skills', 'atlas-file-governance');
  installRuntime({
    sourceRoot: projectRoot, installRoot, skillRoot, nodePath: process.execPath,
    libraryRoots: [library],
  });
  const driver = new InstalledSkillDriver({ installRoot });
  driver.acceptsScenario(scenario);
  return { caseRoot, library, installRoot, scenario, driver };
}

function adoptAndCreateProject(scope, name) {
  const scan = scope.driver.call([
    'bootstrap', 'scan', '--root', scope.library, '--scan-mode', 'structure', ...caller,
  ]);
  assert.equal(scan.content_files_read, 0);
  const contract = scope.driver.call([
    'bootstrap', 'contract', scan.scan_id, '--profile', scope.scenario.profile,
  ]);
  assert.equal(contract.questions.length, 0);
  scope.driver.call([
    'bootstrap', 'adopt', scan.scan_id, '--contract', contract.contract_id,
    '--profile', scope.scenario.profile, '--reason', scope.scenario.user_request,
  ]);
  return scope.driver.call(['project', 'create', '--name', name, '--path', `Projects/${name}`]);
}

function stateFile(scope, name, content) {
  const target = path.join(scope.installRoot, 'state', 'work', name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

test('Vault golden Fixture selects the verified newer chat snapshot, preserves both sources, and rolls back', () => {
  const scope = setup('vault');
  const project = adoptAndCreateProject(scope, 'Personal');
  const requestFile = stateFile(scope, 'vault-task.json', JSON.stringify({
    intent: scope.scenario.user_request,
    project_id: project.project_id,
    inputs: [
      {
        path: 'Projects/Personal/Sources/chat-jan-may.txt', series: 'chat-main',
        temporal_mode: 'snapshot', coverage: { start: '2026-01-01', end: '2026-05-31' }, required: true,
      },
      {
        path: 'Projects/Personal/Sources/chat-jan-jul.txt', series: 'chat-main',
        temporal_mode: 'snapshot', coverage: { start: '2026-01-01', end: '2026-07-31' }, required: true,
      },
    ],
    budget: { max_files: 3, max_bytes: 20_000 },
    output: {
      target: 'Projects/Personal/Outputs/chat-current.md', role: 'report',
      data_class: 'temporal_snapshot', action: 'auto',
    },
  }));
  const prepared = scope.driver.call([
    'task', 'prepare', '--root', scope.library, '--request-file', requestFile, ...caller,
  ]);
  assert.equal(prepared.status, 'ready');
  assert.deepEqual(prepared.read.selected.map((item) => item.path), [
    'Projects/Personal/Sources/chat-jan-jul.txt',
  ]);
  assert.equal(prepared.read.excluded[0].reason, 'superseded_by_verified_snapshot');
  assert.equal(prepared.temporal_relations[0].type, 'supersedes');
  const candidate = stateFile(scope, 'chat-current.md', '# Current chat summary\n\nJanuary through July.\n');
  const completed = scope.driver.call([
    'task', 'fulfill', prepared.task_id, '--candidate-file', candidate,
    '--reason', scope.scenario.user_request,
  ]);
  assert.equal(completed.status, 'completed');
  assert.equal(fs.existsSync(path.join(scope.library, 'Projects', 'Personal', 'Sources', 'chat-jan-may.txt')), true);
  assert.equal(scope.driver.call(['task', 'rollback', prepared.task_id]).status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(scope.library, 'Projects', 'Personal', 'Outputs', 'chat-current.md')), false);
});

test('PPTgen golden Fixture retains download provenance, bounds content inputs, and separates output from templates', () => {
  const scope = setup('pptgen');
  const project = adoptAndCreateProject(scope, 'PPTgen');
  const downloaded = stateFile(scope, 'downloaded-chart.txt', 'Downloaded chart source.\n');
  const intake = scope.driver.call([
    'intake', 'prepare', '--root', scope.library, '--candidate-file', downloaded,
    '--origin', 'download', '--kind', 'asset', '--filename', 'downloaded-chart.txt',
    '--project', project.project_id, '--intent', scope.scenario.user_request, ...caller,
  ]);
  assert.equal(intake.target, 'Projects/PPTgen/Sources/downloaded-chart.txt');
  scope.driver.call(['intake', 'execute', intake.run_id, '--reason', scope.scenario.user_request]);
  const intakeDetail = scope.driver.call(['intake', 'show', intake.run_id]);
  assert.equal(intakeDetail.placement.policy.intake.origin, 'download');
  assert.equal(intakeDetail.output.role, 'source');

  const requestFile = stateFile(scope, 'ppt-task.json', JSON.stringify({
    intent: scope.scenario.user_request,
    project_id: project.project_id,
    inputs: [
      { path: 'Projects/PPTgen/Templates/base-template.txt', required: true },
      { path: 'Projects/PPTgen/Sources/brief.md', required: true },
      { path: 'Projects/PPTgen/Sources/downloaded-chart.txt', required: true },
    ],
    budget: { max_files: 3, max_bytes: 20_000 },
    output: {
      target: 'Projects/PPTgen/Outputs/deck-outline.md', role: 'report',
      data_class: 'generated_output', action: 'create',
    },
  }));
  const task = scope.driver.call(['task', 'prepare', '--root', scope.library, '--request-file', requestFile, ...caller]);
  assert.equal(task.status, 'ready');
  assert.equal(task.read.selected.length, 3);
  const outline = stateFile(scope, 'deck-outline.md', '# Five-slide Atlas outline\n');
  assert.equal(scope.driver.call([
    'task', 'fulfill', task.task_id, '--candidate-file', outline, '--reason', scope.scenario.user_request,
  ]).status, 'completed');
  assert.equal(fs.existsSync(path.join(scope.library, 'Projects', 'PPTgen', 'Templates', 'deck-outline.md')), false);
  scope.driver.call(['task', 'rollback', task.task_id]);
  scope.driver.call(['intake', 'rollback', intake.run_id]);
});

test('Website golden Fixture learns one Project route, reuses it, isolates demos, and safely recovers', () => {
  const scope = setup('website');
  const project = adoptAndCreateProject(scope, 'Website');
  const production = path.join(scope.library, 'Projects', 'Website', 'Source', 'app.js');
  const productionBefore = fs.readFileSync(production, 'utf8');
  const correction = scope.driver.call([
    'intake', 'correct', '--root', scope.library, '--scope', 'project',
    '--origin', 'agent_generated', '--kind', 'demo', '--role', 'intermediate',
    '--target-subdirectory', 'Demos', '--reason', scope.scenario.user_request,
    '--project', project.project_id,
  ]);
  assert.match(correction.rule_version_id, /^RULE-ROUTE-/u);

  const runs = [];
  for (const [filename, content] of [['hero-demo.html', '<main>hero demo</main>\n'], ['menu-demo.html', '<main>menu demo</main>\n']]) {
    const candidate = stateFile(scope, filename, content);
    const prepared = scope.driver.call([
      'intake', 'prepare', '--root', scope.library, '--candidate-file', candidate,
      '--origin', 'agent_generated', '--kind', 'demo', '--filename', filename,
      '--project', project.project_id, '--intent', scope.scenario.user_request, ...caller,
    ]);
    assert.equal(prepared.questions.length, 0);
    assert.equal(prepared.target, `Projects/Website/Demos/${filename}`);
    scope.driver.call(['intake', 'execute', prepared.run_id, '--reason', scope.scenario.user_request]);
    runs.push(prepared.run_id);
  }
  assert.equal(fs.readFileSync(production, 'utf8'), productionBefore);
  assert.equal(fs.existsSync(path.join(scope.library, 'Projects', 'Website', 'Source', 'hero-demo.html')), false);
  for (const runId of runs.reverse()) scope.driver.call(['intake', 'rollback', runId]);
  assert.equal(fs.readFileSync(production, 'utf8'), productionBefore);
});
