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
  return scope.driver.call(['project', 'create', '--name', name, '--path', `Projects/${name}`]);
}

function stateFile(scope, name, content) {
  const target = path.join(scope.installRoot, 'state', 'work', name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

test('Vault golden Fixture saves the Host-selected newer chat source, preserves both sources, and recovers', () => {
  const scope = setup('vault');
  const project = adoptAndCreateProject(scope, 'Personal');
  const candidate = stateFile(scope, 'chat-current.md', '# Current chat summary\n\nJanuary through July.\n');
  const prepared = scope.driver.call([
    'save', 'prepare', '--root', scope.library, '--candidate-file', candidate,
    '--origin', 'agent_generated', '--kind', 'report', '--project', project.project_id,
    '--target', 'Projects/Personal/Outputs/chat-current.md',
    '--input', 'Projects/Personal/Sources/chat-jan-jul.txt',
    '--channel', 'host', '--request-key', 'vault-current-summary',
    '--intent', scope.scenario.user_request, ...caller,
  ]);
  assert.equal(prepared.schema, 'atlas.save-result.v1');
  assert.deepEqual(prepared.inputs.map((item) => item.relative_path), [
    'Projects/Personal/Sources/chat-jan-jul.txt',
  ]);
  const completed = scope.driver.call(['save', 'execute', prepared.save_id, '--reason', scope.scenario.user_request]);
  assert.equal(completed.verified, true);
  assert.equal(fs.existsSync(path.join(scope.library, 'Projects', 'Personal', 'Sources', 'chat-jan-may.txt')), true);
  assert.equal(fs.existsSync(path.join(scope.library, 'Projects', 'Personal', 'Sources', 'chat-jan-jul.txt')), true);
  assert.equal(scope.driver.call(['save', 'undo', prepared.save_id]).status, 'undone');
  assert.equal(fs.existsSync(path.join(scope.library, 'Projects', 'Personal', 'Outputs', 'chat-current.md')), false);
  assert.equal(scope.driver.call(['save', 'redo', prepared.save_id]).status, 'executed');
  scope.driver.call(['save', 'undo', prepared.save_id]);
});

test('PPTgen golden Fixture retains download provenance, bounds content inputs, and separates output from templates', () => {
  const scope = setup('pptgen');
  const project = adoptAndCreateProject(scope, 'PPTgen');
  const downloaded = stateFile(scope, 'downloaded-chart.txt', 'Downloaded chart source.\n');
  const intake = scope.driver.call([
    'save', 'prepare', '--root', scope.library, '--candidate-file', downloaded,
    '--origin', 'download', '--kind', 'asset',
    '--project', project.project_id, '--target', 'Projects/PPTgen/Sources/downloaded-chart.txt',
    '--intent', scope.scenario.user_request,
    '--channel', 'host', '--request-key', 'pptgen-download', ...caller,
  ]);
  assert.equal(intake.target.relative_path, 'Projects/PPTgen/Sources/downloaded-chart.txt');
  scope.driver.call(['save', 'execute', intake.save_id, '--reason', scope.scenario.user_request]);
  const outline = stateFile(scope, 'deck-outline.md', '# Five-slide Atlas outline\n');
  const result = scope.driver.call([
    'save', 'prepare', '--root', scope.library, '--candidate-file', outline,
    '--origin', 'agent_generated', '--kind', 'report', '--project', project.project_id,
    '--target', 'Projects/PPTgen/Outputs/deck-outline.md',
    '--input', 'Projects/PPTgen/Templates/base-template.txt',
    '--input', 'Projects/PPTgen/Sources/brief.md',
    '--input', 'Projects/PPTgen/Sources/downloaded-chart.txt',
    '--channel', 'host', '--request-key', 'pptgen-outline',
    '--intent', scope.scenario.user_request, ...caller,
  ]);
  assert.equal(result.inputs.length, 3);
  assert.equal(scope.driver.call(['save', 'execute', result.save_id, '--reason', scope.scenario.user_request]).verified, true);
  assert.equal(fs.existsSync(path.join(scope.library, 'Projects', 'PPTgen', 'Templates', 'deck-outline.md')), false);
  scope.driver.call(['save', 'undo', result.save_id]);
  scope.driver.call(['save', 'undo', intake.save_id]);
});

test('Website golden Fixture uses explicit Project destinations, isolates demos, and safely recovers', () => {
  const scope = setup('website');
  const project = adoptAndCreateProject(scope, 'Website');
  const production = path.join(scope.library, 'Projects', 'Website', 'Source', 'app.js');
  const productionBefore = fs.readFileSync(production, 'utf8');

  const runs = [];
  for (const [filename, content] of [['hero-demo.html', '<main>hero demo</main>\n'], ['menu-demo.html', '<main>menu demo</main>\n']]) {
    const candidate = stateFile(scope, filename, content);
    const prepared = scope.driver.call([
      'save', 'prepare', '--root', scope.library, '--candidate-file', candidate,
      '--origin', 'agent_generated', '--kind', 'demo',
      '--project', project.project_id, '--target', `Projects/Website/Demos/${filename}`,
      '--intent', scope.scenario.user_request,
      '--channel', 'host', '--request-key', `website-${filename}`, ...caller,
    ]);
    assert.equal(prepared.target.relative_path, `Projects/Website/Demos/${filename}`);
    scope.driver.call(['save', 'execute', prepared.save_id, '--reason', scope.scenario.user_request]);
    runs.push(prepared.save_id);
  }
  assert.equal(fs.readFileSync(production, 'utf8'), productionBefore);
  assert.equal(fs.existsSync(path.join(scope.library, 'Projects', 'Website', 'Source', 'hero-demo.html')), false);
  for (const runId of runs.reverse()) scope.driver.call(['save', 'undo', runId]);
  assert.equal(fs.readFileSync(production, 'utf8'), productionBefore);
});
