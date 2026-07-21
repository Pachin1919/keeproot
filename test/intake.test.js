import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
