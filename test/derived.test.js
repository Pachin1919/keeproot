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

test('Derived refuses an interrupted same-hash target without its ownership temporary file', (t) => {
  const { vault, stateDir, projectId } = setup('derived-interrupted-external-same-hash');
  const derived = openDerived(t, stateDir);
  const target = path.join(vault, 'Projects', 'Atlas', 'result.md');
  const prepared = derived.prepare({
    root: vault, inputs: ['allowed-a.md'], target: 'Projects/Atlas/result.md',
    candidateContent: 'same candidate\\n', projectId, role: 'report',
  });
  derived.approve(prepared.run_id, { reason: 'test interrupted ownership' });
  derived.ledger.startDerivedExecution(prepared.run_id, new Date().toISOString());
  fs.writeFileSync(target, 'same candidate\\n', 'utf8');

  assert.throws(() => derived.execute(prepared.run_id), /claimed|ownership|stale/i);
  assert.equal(derived.preview(prepared.run_id).run.status, 'stale');
  assert.throws(() => derived.rollback(prepared.run_id), /executed/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'same candidate\\n');
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

test('Derived redo recreates a rolled back target without overwriting an external claim', (t) => {
  const { vault, stateDir, projectId } = setup('derived-redo');
  const derived = openDerived(t, stateDir);
  const prepared = derived.prepare({
    root: vault, inputs: ['allowed-a.md'], target: 'Projects/Atlas/redone.md',
    candidateContent: 'generated again\n', projectId, role: 'report',
  });
  derived.approve(prepared.run_id);
  derived.execute(prepared.run_id);
  derived.rollback(prepared.run_id);
  const target = path.join(vault, 'Projects', 'Atlas', 'redone.md');
  fs.writeFileSync(target, 'external claim\n', 'utf8');
  assert.throws(() => derived.redo(prepared.run_id), /empty target path/u);
  assert.equal(fs.readFileSync(target, 'utf8'), 'external claim\n');
  fs.rmSync(target);
  const receipt = derived.redo(prepared.run_id);
  assert.equal(receipt.verified, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'generated again\n');
  assert.equal(derived.preview(prepared.run_id).run.status, 'executed');
});

test('Derived redo rejects changed inputs before recreating a target', (t) => {
  const { vault, stateDir, projectId } = setup('derived-redo-input'); const derived=openDerived(t,stateDir);
  const prepared=derived.prepare({root:vault,inputs:['allowed-a.md'],target:'Projects/Atlas/redone-input.md',candidateContent:'generated\n',projectId,role:'report'});derived.approve(prepared.run_id);derived.execute(prepared.run_id);derived.rollback(prepared.run_id);fs.writeFileSync(path.join(vault,'allowed-a.md'),'changed\n');assert.throws(()=>derived.redo(prepared.run_id),/input changed/u);assert.equal(fs.existsSync(path.join(vault,'Projects','Atlas','redone-input.md')),false);
});

test('Derived redo rejects a missing Candidate blob', (t) => {
  const { vault, stateDir, projectId }=setup('derived-redo-blob');const derived=openDerived(t,stateDir);const prepared=derived.prepare({root:vault,inputs:['allowed-a.md'],target:'Projects/Atlas/blob.md',candidateContent:'unique redo blob\n',projectId,role:'report'});derived.approve(prepared.run_id);derived.execute(prepared.run_id);derived.rollback(prepared.run_id);const detail=derived.preview(prepared.run_id);fs.rmSync(detail.candidate.blob_path);assert.throws(()=>derived.redo(prepared.run_id),/Candidate/u);assert.equal(fs.existsSync(path.join(vault,'Projects','Atlas','blob.md')),false);assert.equal(derived.preview(prepared.run_id).run.status,'rolled_back');
});

test('Derived redo recovers after receipt commit failure without losing ownership', (t) => {
  const { vault,stateDir,projectId }=setup('derived-redo-receipt-failure');const derived=openDerived(t,stateDir);const prepared=derived.prepare({root:vault,inputs:['allowed-a.md'],target:'Projects/Atlas/retry.md',candidateContent:'retry candidate\n',projectId,role:'report'});derived.approve(prepared.run_id);derived.execute(prepared.run_id);derived.rollback(prepared.run_id);const original=derived.ledger.derived.finishDerivedRedo.bind(derived.ledger.derived);let failed=false;derived.ledger.derived.finishDerivedRedo=(...args)=>{if(!failed){failed=true;throw new Error('receipt unavailable');}return original(...args);};assert.throws(()=>derived.redo(prepared.run_id),/receipt unavailable/u);const target=path.join(vault,'Projects','Atlas','retry.md');const detail=derived.preview(prepared.run_id);const started=detail.events.filter(e=>e.type==='derived_redo_started').at(-1).payload;assert.equal(detail.run.status,'rolled_back');assert.equal(fs.readFileSync(target,'utf8'),'retry candidate\n');assert.equal(fs.statSync(target).ino,fs.statSync(started.ownership.temp_path).ino);derived.ledger.derived.finishDerivedRedo=original;const receipt=derived.redo(prepared.run_id);assert.ok(receipt.redone_at);assert.equal(fs.existsSync(started.ownership.temp_path),false);assert.equal(derived.preview(prepared.run_id).run.status,'executed');derived.rollback(prepared.run_id);assert.equal(fs.existsSync(target),false);
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

  const target = path.join(vault, 'Projects', 'Atlas', 'resume.md');
  const temporary = path.join(path.dirname(target), '.atlas-derived-owned.publish.tmp');
  derived.ledger.startDerivedExecution(prepared.run_id, new Date().toISOString(), { publish_token: 'owned', temp_path: temporary });
  fs.copyFileSync(derived.preview(prepared.run_id).candidate.blob_path, temporary, fs.constants.COPYFILE_EXCL);
  fs.linkSync(temporary, target);
  assert.equal(derived.execute(prepared.run_id).status, 'executed');
  fs.linkSync(target, temporary);
  assert.equal(derived.execute(prepared.run_id).status, 'executed');
  assert.equal(fs.existsSync(temporary), false);

  derived.ledger.startDerivedRollback(prepared.run_id, new Date().toISOString());
  fs.rmSync(target);
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

test('Derived refuses an execute after the recorded target parent becomes a junction', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('derived-parent-replaced-execute');
  const derived = openDerived(t, stateDir);
  const prepared = derived.prepare({ root: vault, inputs: ['allowed-a.md'], target: 'Projects/Atlas/result.md', candidateContent: 'candidate\n', projectId, role: 'draft' });
  derived.approve(prepared.run_id);
  const parent = path.join(vault, 'Projects', 'Atlas'); const backup = path.join(caseRoot, 'atlas-backup'); const external = path.join(caseRoot, 'external');
  fs.renameSync(parent, backup); fs.mkdirSync(external);
  try { fs.symlinkSync(external, parent, 'junction'); } catch (error) { t.skip(`junction unavailable: ${error.code ?? error.message}`); return; }
  assert.throws(() => derived.execute(prepared.run_id), /parent.*real directory|outside/u);
  assert.equal(fs.existsSync(path.join(external, 'result.md')), false);
});

test('Derived refuses rollback after the recorded target parent becomes a junction', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('derived-parent-replaced-rollback');
  const derived = openDerived(t, stateDir);
  const prepared = derived.prepare({ root: vault, inputs: ['allowed-a.md'], target: 'Projects/Atlas/result.md', candidateContent: 'candidate\n', projectId, role: 'draft' });
  derived.approve(prepared.run_id); derived.execute(prepared.run_id);
  const parent = path.join(vault, 'Projects', 'Atlas'); const backup = path.join(caseRoot, 'atlas-backup'); const external = path.join(caseRoot, 'external');
  fs.renameSync(parent, backup); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'result.md'), 'candidate\n');
  try { fs.symlinkSync(external, parent, 'junction'); } catch (error) { t.skip(`junction unavailable: ${error.code ?? error.message}`); return; }
  assert.throws(() => derived.rollback(prepared.run_id), /parent.*real directory|outside/u);
  assert.equal(fs.readFileSync(path.join(external, 'result.md'), 'utf8'), 'candidate\n');
});

test('Derived refuses an in-root junction ancestor even when its target parent is ordinary', (t) => {
  const { vault, stateDir, projectId } = setup('derived-in-root-junction-ancestor');
  const derived = openDerived(t, stateDir);
  const project = path.join(vault, 'Projects', 'Atlas'); const actual = path.join(project, 'actual'); const linked = path.join(project, 'linked');
  fs.mkdirSync(path.join(actual, 'child'), { recursive: true });
  try { fs.symlinkSync(actual, linked, 'junction'); } catch (error) { t.skip(`junction unavailable: ${error.code ?? error.message}`); return; }
  assert.throws(
    () => derived.prepare({ root: vault, inputs: ['allowed-a.md'], target: 'Projects/Atlas/linked/child/result.md', candidateContent: 'candidate\n', projectId, role: 'draft' }),
    /parent.*real directory|linked/u,
  );
  assert.equal(fs.existsSync(path.join(actual, 'child', 'result.md')), false);
});

test('Derived refuses execute and rollback through an in-root junction ancestor', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('derived-in-root-junction-revalidation');
  const derived = openDerived(t, stateDir);
  const project = path.join(vault, 'Projects', 'Atlas'); const linked = path.join(project, 'linked'); const child = path.join(linked, 'child');
  fs.mkdirSync(child, { recursive: true });
  const prepared = derived.prepare({ root: vault, inputs: ['allowed-a.md'], target: 'Projects/Atlas/linked/child/result.md', candidateContent: 'candidate\n', projectId, role: 'draft' });
  derived.approve(prepared.run_id); derived.execute(prepared.run_id);
  const backup = path.join(caseRoot, 'linked-backup'); const actual = path.join(project, 'actual');
  fs.renameSync(linked, backup); fs.mkdirSync(path.join(actual, 'child'), { recursive: true }); fs.writeFileSync(path.join(actual, 'child', 'result.md'), 'candidate\n');
  try { fs.symlinkSync(actual, linked, 'junction'); } catch (error) { t.skip(`junction unavailable: ${error.code ?? error.message}`); return; }
  assert.throws(() => derived.execute(prepared.run_id), /parent.*real directory|linked/u);
  assert.throws(() => derived.rollback(prepared.run_id), /parent.*real directory|linked/u);
  assert.equal(fs.readFileSync(path.join(actual, 'child', 'result.md'), 'utf8'), 'candidate\n');
});

test('Derived redo refuses a target parent replaced by a junction', (t) => {
  const { caseRoot, vault, stateDir, projectId } = setup('derived-redo-junction'); const derived=openDerived(t,stateDir); const project=path.join(vault,'Projects','Atlas'); const parent=path.join(project,'redo-parent'); fs.mkdirSync(parent,{recursive:true}); const prepared=derived.prepare({root:vault,inputs:['allowed-a.md'],target:'Projects/Atlas/redo-parent/result.md',candidateContent:'redo candidate\n',projectId,role:'draft'});derived.approve(prepared.run_id);derived.execute(prepared.run_id);derived.rollback(prepared.run_id);const backup=path.join(caseRoot,'redo-backup');const external=path.join(caseRoot,'external');fs.renameSync(parent,backup);fs.mkdirSync(external,{recursive:true});try{fs.symlinkSync(external,parent,'junction');}catch(error){t.skip(`junction unavailable: ${error.code??error.message}`);return;}assert.throws(()=>derived.redo(prepared.run_id),/parent.*real directory|linked/u);assert.equal(fs.existsSync(path.join(external,'result.md')),false);assert.equal(derived.preview(prepared.run_id).run.status,'rolled_back');
});
