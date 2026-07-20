import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Derived } from '../src/derived.js';
import { Registry } from '../src/registry.js';
import { RollbackConflictError } from '../src/tracker.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = path.join(projectRoot, 'fixtures', 'vault-template');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const vault = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(caseRoot, { recursive: true });
  fs.cpSync(templateRoot, vault, { recursive: true });
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true });
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' });
  registry.dispose();
  return { caseRoot, vault, stateDir, projectId: project.project_id };
}

function openDerived(t, stateDir) {
  const derived = new Derived({ stateDir });
  t.after(() => derived.dispose());
  return derived;
}

test('Derived creates a classified output with reviewed placement and immutable input lineage', (t) => {
  const { vault, stateDir, projectId } = setup('derived-create-lineage');
  const derived = openDerived(t, stateDir);
  const outputPath = path.join(vault, 'Projects', 'Atlas', 'Generated Report.md');
  const prepared = derived.prepare({
    root: vault,
    inputs: ['allowed-a.md', 'allowed-b.md'],
    target: 'Projects/Atlas/Generated Report.md',
    candidateContent: '# Generated Report\n',
    projectId,
    role: 'report',
    relationType: 'merges',
    intent: 'Generate one report from two source notes',
    predictionConfidence: 0.91,
    caller: {
      actor: 'agent', agent: 'Codex', model: 'gpt-5', tool: 'codex-desktop', client_run_id: 'derive-1',
    },
  });
  const preview = derived.preview(prepared.run_id);

  assert.equal(prepared.status, 'prepared');
  assert.equal(preview.run.mode, 'derived');
  assert.equal(preview.candidate.operation, 'create');
  assert.equal(preview.placement.project_id, projectId);
  assert.equal(preview.placement.role, 'report');
  assert.equal(preview.placement.relation_type, 'merges');
  assert.equal(preview.inputs.length, 2);
  assert.equal(preview.placement_prediction.kind, 'placement_candidate');
  assert.equal(preview.placement_prediction.review, null);
  assert.match(preview.candidate.diff_text, /\+\# Generated Report/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.throws(() => derived.execute(prepared.run_id), /approval/i);

  const approval = derived.approve(prepared.run_id, { reason: 'Project, role, sources, and path are correct' });
  assert.equal(approval.decision, 'accepted');
  assert.equal(derived.preview(prepared.run_id).placement_prediction.review.decision, 'accepted');
  const firstExecution = derived.execute(prepared.run_id);
  const secondExecution = derived.execute(prepared.run_id);
  assert.deepEqual(secondExecution, firstExecution);
  assert.equal(firstExecution.verified, true);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), '# Generated Report\n');

  const executed = derived.preview(prepared.run_id);
  assert.ok(executed.output.artifact_id);
  assert.ok(executed.output.material_id);
  assert.equal(executed.output.role, 'report');
  assert.equal(executed.lineage.length, 2);
  assert.ok(executed.lineage.every((edge) => edge.output_material_id === executed.output.material_id));

  const firstRollback = derived.rollback(prepared.run_id);
  const secondRollback = derived.rollback(prepared.run_id);
  assert.deepEqual(secondRollback, firstRollback);
  assert.equal(fs.existsSync(outputPath), false);

  derived.dispose();
  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM material_derivations').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM predictions WHERE kind = ?').get('placement_candidate').count, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM labels WHERE subject_prediction_id IS NOT NULL
    `).get().count, 1);
    const artifact = db.prepare(`
      SELECT project_id, role, status FROM artifacts WHERE id = ?
    `).get(executed.output.artifact_id);
    assert.deepEqual(
      { ...artifact },
      { project_id: projectId, role: 'report', status: 'rolled_back' },
    );
  } finally {
    db.close();
  }
});

test('Derived rejects path escape, existing targets, and output paths outside the selected Project', (t) => {
  const { vault, stateDir, projectId } = setup('derived-path-policy');
  const derived = openDerived(t, stateDir);
  const common = {
    root: vault,
    inputs: ['allowed-a.md'],
    candidateContent: 'candidate\n',
    projectId,
    role: 'draft',
  };

  assert.throws(() => derived.prepare({ ...common, target: '../escape.md' }), /escape/i);
  assert.throws(() => derived.prepare({ ...common, target: 'outside.md' }), /Project/i);
  assert.throws(() => derived.prepare({ ...common, target: 'Projects/Atlas', }), /file path|directory|target/i);
  fs.writeFileSync(path.join(vault, 'Projects', 'Atlas', 'exists.md'), 'existing\n', 'utf8');
  assert.throws(() => derived.prepare({ ...common, target: 'Projects/Atlas/exists.md' }), /already exists/i);
  assert.throws(() => derived.prepare({
    ...common,
    inputs: ['../outside-input.md'],
    target: 'Projects/Atlas/output.md',
  }), /input.*escape/i);
});

test('Derived invalidates approval if an input changes or another writer claims the target', (t) => {
  const { vault, stateDir, projectId } = setup('derived-stale');
  const derived = openDerived(t, stateDir);
  const first = derived.prepare({
    root: vault,
    inputs: ['allowed-a.md'],
    target: 'Projects/Atlas/from-input.md',
    candidateContent: 'candidate one\n',
    projectId,
    role: 'draft',
  });
  derived.approve(first.run_id);
  fs.appendFileSync(path.join(vault, 'allowed-a.md'), 'later input change\n', 'utf8');
  assert.throws(() => derived.execute(first.run_id), /input.*changed/i);
  assert.equal(derived.preview(first.run_id).run.status, 'stale');
  assert.equal(fs.existsSync(path.join(vault, 'Projects', 'Atlas', 'from-input.md')), false);

  const second = derived.prepare({
    root: vault,
    inputs: ['allowed-b.md'],
    target: 'Projects/Atlas/claimed.md',
    candidateContent: 'candidate two\n',
    projectId,
    role: 'draft',
  });
  derived.approve(second.run_id);
  const claimed = path.join(vault, 'Projects', 'Atlas', 'claimed.md');
  fs.writeFileSync(claimed, 'external owner\n', 'utf8');
  assert.throws(() => derived.execute(second.run_id), /target.*exists|claimed|stale/i);
  assert.equal(fs.readFileSync(claimed, 'utf8'), 'external owner\n');
  assert.equal(derived.preview(second.run_id).run.status, 'stale');

  const third = derived.prepare({
    root: vault,
    inputs: ['allowed-b.md'],
    target: 'Projects/Atlas/claimed-same-content.md',
    candidateContent: 'same bytes\n',
    projectId,
    role: 'draft',
  });
  derived.approve(third.run_id);
  const sameContentClaim = path.join(vault, 'Projects', 'Atlas', 'claimed-same-content.md');
  fs.writeFileSync(sameContentClaim, 'same bytes\n', 'utf8');
  assert.throws(() => derived.execute(third.run_id), /target.*exists|claimed|stale/i);
  assert.equal(derived.preview(third.run_id).run.status, 'stale');
});

test('A derived output can become the stable input of a later derived run', (t) => {
  const { vault, stateDir, projectId } = setup('derived-chain');
  const derived = openDerived(t, stateDir);
  const first = derived.prepare({
    root: vault,
    inputs: ['allowed-a.md'],
    target: 'Projects/Atlas/Stage One.md',
    candidateContent: '# Stage One\n',
    projectId,
    role: 'intermediate',
  });
  derived.approve(first.run_id);
  derived.execute(first.run_id);
  const firstDetail = derived.preview(first.run_id);

  const second = derived.prepare({
    root: vault,
    inputs: ['Projects/Atlas/Stage One.md'],
    target: 'Projects/Atlas/Stage Two.md',
    candidateContent: '# Stage Two\n',
    projectId,
    role: 'canonical',
    relationType: 'transforms',
  });
  const secondDetail = derived.preview(second.run_id);
  assert.equal(secondDetail.inputs[0].artifact_id, firstDetail.output.artifact_id);
  assert.equal(secondDetail.inputs[0].material_id, firstDetail.output.material_id);
  derived.approve(second.run_id);
  derived.execute(second.run_id);
  assert.equal(derived.preview(second.run_id).lineage[0].input_material_id, firstDetail.output.material_id);
});

test('Derived rollback refuses to delete a later external revision', (t) => {
  const { vault, stateDir, projectId } = setup('derived-rollback-conflict');
  const derived = openDerived(t, stateDir);
  const prepared = derived.prepare({
    root: vault,
    inputs: ['allowed-a.md'],
    target: 'Projects/Atlas/conflict.md',
    candidateContent: 'generated\n',
    projectId,
    role: 'report',
  });
  derived.approve(prepared.run_id);
  derived.execute(prepared.run_id);
  const target = path.join(vault, 'Projects', 'Atlas', 'conflict.md');
  fs.writeFileSync(target, 'later legitimate revision\n', 'utf8');

  assert.throws(() => derived.rollback(prepared.run_id), RollbackConflictError);
  assert.equal(fs.readFileSync(target, 'utf8'), 'later legitimate revision\n');
  assert.equal(derived.preview(prepared.run_id).run.status, 'executed');
});

test('Derived rollback treats an external deletion as a conflict', (t) => {
  const { vault, stateDir, projectId } = setup('derived-rollback-deletion-conflict');
  const derived = openDerived(t, stateDir);
  const prepared = derived.prepare({
    root: vault,
    inputs: ['allowed-a.md'],
    target: 'Projects/Atlas/deleted-externally.md',
    candidateContent: 'generated\n',
    projectId,
    role: 'report',
  });
  derived.approve(prepared.run_id);
  derived.execute(prepared.run_id);
  fs.rmSync(path.join(vault, 'Projects', 'Atlas', 'deleted-externally.md'));

  assert.throws(() => derived.rollback(prepared.run_id), RollbackConflictError);
  assert.equal(derived.preview(prepared.run_id).run.status, 'executed');
});

test('Derived execute and rollback resume only after Atlas recorded operation intent', (t) => {
  const { vault, stateDir, projectId } = setup('derived-crash-resume');
  const derived = openDerived(t, stateDir);
  const prepared = derived.prepare({
    root: vault,
    inputs: ['allowed-a.md'],
    target: 'Projects/Atlas/resume.md',
    candidateContent: 'generated\n',
    projectId,
    role: 'report',
  });
  derived.approve(prepared.run_id);

  derived.ledger.startDerivedExecution(prepared.run_id, new Date().toISOString());
  fs.writeFileSync(path.join(vault, 'Projects', 'Atlas', 'resume.md'), 'generated\n', 'utf8');
  assert.equal(derived.execute(prepared.run_id).status, 'executed');

  derived.ledger.startDerivedRollback(prepared.run_id, new Date().toISOString());
  fs.rmSync(path.join(vault, 'Projects', 'Atlas', 'resume.md'));
  assert.equal(derived.rollback(prepared.run_id).status, 'rolled_back');
});

test('Derived revision preserves a rejected Candidate and requires a new placement review', (t) => {
  const { vault, stateDir, projectId } = setup('derived-revision');
  const derived = openDerived(t, stateDir);
  const original = derived.prepare({
    root: vault,
    inputs: ['allowed-a.md'],
    target: 'Projects/Atlas/original.md',
    candidateContent: 'original candidate\n',
    projectId,
    role: 'draft',
  });
  derived.reject(original.run_id, { reason: 'Wrong role and target' });
  const revised = derived.revise(original.run_id, {
    target: 'Projects/Atlas/revised.md',
    role: 'report',
    candidateContent: 'revised candidate\n',
    reason: 'Apply placement feedback',
  });

  assert.equal(derived.preview(original.run_id).run.status, 'revised');
  const detail = derived.preview(revised.run_id);
  assert.equal(detail.run.status, 'prepared');
  assert.equal(detail.placement.revised_from_run_id, original.run_id);
  assert.equal(detail.placement.role, 'report');
  assert.equal(detail.candidate.target_path, 'Projects/Atlas/revised.md');
  assert.equal(detail.placement_prediction.review, null);
  assert.throws(() => derived.execute(revised.run_id), /approval/i);
});

test('Derived promotes an executed Artifact role without changing its Material or path', (t) => {
  const { vault, stateDir, projectId } = setup('derived-role-promotion');
  const derived = openDerived(t, stateDir);
  const prepared = derived.prepare({
    root: vault,
    inputs: ['allowed-a.md'],
    target: 'Projects/Atlas/promoted.md',
    candidateContent: 'reviewed draft\n',
    projectId,
    role: 'draft',
  });
  derived.approve(prepared.run_id);
  const executed = derived.execute(prepared.run_id);
  const promoted = derived.promote(prepared.run_id, { role: 'canonical', reason: 'Accepted as final' });
  const repeated = derived.promote(prepared.run_id, { role: 'canonical', reason: 'Accepted as final' });
  const detail = derived.preview(prepared.run_id);

  assert.equal(promoted.to_role, 'canonical');
  assert.deepEqual(repeated, promoted);
  assert.equal(detail.output.role, 'canonical');
  assert.equal(detail.output.original_role, 'draft');
  assert.equal(detail.output.material_id, executed.material_id);
  assert.equal(detail.output.target_path, 'Projects/Atlas/promoted.md');
  assert.ok(detail.policy_decisions.some((decision) => decision.details.to_role === 'canonical'));
  assert.throws(() => derived.promote(prepared.run_id, { role: 'draft' }), /not allowed/i);
});

test('Derived rollback stops when its output is an active downstream input', (t) => {
  const { vault, stateDir, projectId } = setup('derived-downstream-rollback');
  const derived = openDerived(t, stateDir);
  const first = derived.prepare({
    root: vault,
    inputs: ['allowed-a.md'],
    target: 'Projects/Atlas/first-output.md',
    candidateContent: 'first output\n',
    projectId,
    role: 'intermediate',
  });
  derived.approve(first.run_id);
  derived.execute(first.run_id);
  const second = derived.prepare({
    root: vault,
    inputs: ['Projects/Atlas/first-output.md'],
    target: 'Projects/Atlas/second-output.md',
    candidateContent: 'second output\n',
    projectId,
    role: 'report',
  });
  derived.approve(second.run_id);
  derived.execute(second.run_id);

  assert.throws(
    () => derived.rollback(first.run_id),
    (error) => error instanceof RollbackConflictError
      && error.conflicts[0].kind === 'downstream_dependency'
      && error.conflicts[0].downstream_runs[0].run_id === second.run_id,
  );
  assert.equal(fs.existsSync(path.join(vault, 'Projects', 'Atlas', 'first-output.md')), true);
});
