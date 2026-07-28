import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Guarded } from '../src/guarded.js';

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
  return { caseRoot, vault, stateDir };
}

function openGuarded(t, stateDir) {
  const guarded = new Guarded({ stateDir });
  t.after(() => guarded.dispose());
  return guarded;
}

test('Guarded prepare creates a preview but cannot execute without approval', (t) => {
  const { vault, stateDir } = setup('guarded-preview');
  const guarded = openGuarded(t, stateDir);
  const target = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(target, 'utf8');
  const prepared = guarded.prepare({
    root: vault,
    target: 'allowed-a.md',
    candidateContent: `${baseline}guarded candidate\n`,
    intent: 'Protected update',
  });
  const preview = guarded.preview(prepared.run_id);

  assert.equal(prepared.status, 'prepared');
  assert.equal(preview.run.status, 'prepared');
  assert.equal(preview.risk.mode, 'guarded');
  assert.match(preview.candidate.diff_text, /\+guarded candidate/);
  assert.equal(fs.readFileSync(target, 'utf8'), baseline);
  assert.throws(() => guarded.execute(prepared.run_id), /approval/i);
});

test('Guarded approval becomes stale when the target changes after preview', (t) => {
  const { vault, stateDir } = setup('guarded-stale-approval');
  const guarded = openGuarded(t, stateDir);
  const target = path.join(vault, 'allowed-a.md');
  const prepared = guarded.prepare({
    root: vault,
    target: 'allowed-a.md',
    candidateContent: 'approved candidate\n',
  });
  guarded.approve(prepared.run_id, { reason: 'looks good' });
  fs.appendFileSync(target, 'external change\n', 'utf8');
  const externalState = fs.readFileSync(target, 'utf8');

  assert.throws(() => guarded.execute(prepared.run_id), /changed after preview/i);
  assert.equal(fs.readFileSync(target, 'utf8'), externalState);
  assert.equal(guarded.preview(prepared.run_id).run.status, 'stale');
});

test('Guarded executes exactly the approved candidate and rolls it back safely', (t) => {
  const { vault, stateDir } = setup('guarded-execute-rollback');
  const guarded = openGuarded(t, stateDir);
  const target = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(target, 'utf8');
  const candidate = '# Approved result\n';
  const prepared = guarded.prepare({ root: vault, target: 'allowed-a.md', candidateContent: candidate });

  const firstApproval = guarded.approve(prepared.run_id, { reason: 'approved' });
  const secondApproval = guarded.approve(prepared.run_id, { reason: 'approved' });
  assert.deepEqual(secondApproval, firstApproval);
  const firstExecution = guarded.execute(prepared.run_id);
  const secondExecution = guarded.execute(prepared.run_id);
  assert.deepEqual(secondExecution, firstExecution);
  assert.equal(fs.readFileSync(target, 'utf8'), candidate);

  const firstRollback = guarded.rollback(prepared.run_id);
  const secondRollback = guarded.rollback(prepared.run_id);
  assert.deepEqual(secondRollback, firstRollback);
  assert.equal(fs.readFileSync(target, 'utf8'), baseline);
});

test('Guarded applyApproved records one approval and executes idempotently', (t) => {
  const { vault, stateDir } = setup('guarded-apply-approved');
  const guarded = openGuarded(t, stateDir);
  const target = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(target, 'utf8');
  const candidate = '# One-step approved result\n';
  const prepared = guarded.prepare({
    root: vault,
    target: 'allowed-a.md',
    candidateContent: candidate,
  });

  const first = guarded.applyApproved(prepared.run_id, { reason: 'User approved the reviewed Candidate.' });
  const second = guarded.applyApproved(prepared.run_id, { reason: 'User approved the reviewed Candidate.' });

  assert.deepEqual(second, first);
  assert.equal(first.status, 'executed');
  assert.equal(first.verified, true);
  assert.equal(first.rollback_ready, true);
  assert.equal(fs.readFileSync(target, 'utf8'), candidate);
  assert.equal(guarded.preview(prepared.run_id).run.status, 'executed');

  guarded.rollback(prepared.run_id);
  assert.equal(fs.readFileSync(target, 'utf8'), baseline);
  assert.throws(
    () => guarded.applyApproved(prepared.run_id, { reason: 'Do not replay a rolled-back run.' }),
    /rolled-back/i,
  );
});

test('Guarded applyApproved stops when the reviewed target changed', (t) => {
  const { vault, stateDir } = setup('guarded-apply-approved-stale');
  const guarded = openGuarded(t, stateDir);
  const target = path.join(vault, 'allowed-a.md');
  const prepared = guarded.prepare({
    root: vault,
    target: 'allowed-a.md',
    candidateContent: '# Approved candidate\n',
  });
  fs.appendFileSync(target, 'later external change\n', 'utf8');
  const externalState = fs.readFileSync(target, 'utf8');

  assert.throws(
    () => guarded.applyApproved(prepared.run_id, { reason: 'User approved the reviewed Candidate.' }),
    /changed after preview/i,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), externalState);
  assert.equal(guarded.preview(prepared.run_id).run.status, 'stale');
});

test('Guarded rejection and revision preserve the original Candidate ChangeSet', (t) => {
  const { vault, stateDir } = setup('guarded-reject-revise');
  const guarded = openGuarded(t, stateDir);
  const target = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(target, 'utf8');
  const original = guarded.prepare({ root: vault, target: 'allowed-a.md', candidateContent: 'candidate one\n' });
  const originalHash = guarded.preview(original.run_id).candidate.content_hash;
  const revised = guarded.revise(original.run_id, {
    candidateContent: 'candidate two\n',
    reason: 'Use the corrected wording',
  });

  assert.notEqual(revised.run_id, original.run_id);
  assert.equal(guarded.preview(original.run_id).candidate.content_hash, originalHash);
  assert.equal(guarded.preview(original.run_id).run.status, 'revised');
  guarded.reject(revised.run_id, { reason: 'cancelled' });
  assert.throws(() => guarded.execute(revised.run_id), /approval/i);
  assert.equal(fs.readFileSync(target, 'utf8'), baseline);
});

test('Guarded validates candidate material and path safety before writing', (t) => {
  const { caseRoot, vault, stateDir } = setup('guarded-material-path-safety');
  const guarded = openGuarded(t, stateDir);
  assert.throws(
    () => guarded.prepare({ root: vault, target: '../escape.md', candidateContent: 'escape\n' }),
    /escapes/i,
  );

  const target = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(target, 'utf8');
  const prepared = guarded.prepare({ root: vault, target: 'allowed-a.md', candidateContent: 'candidate\n' });
  guarded.approve(prepared.run_id);
  const candidateBlob = guarded.preview(prepared.run_id).candidate.blob_path;
  fs.writeFileSync(candidateBlob, 'corrupt\n', 'utf8');

  assert.throws(() => guarded.execute(prepared.run_id), /candidate material/i);
  assert.equal(fs.readFileSync(target, 'utf8'), baseline);
  assert.ok(!path.resolve(candidateBlob).startsWith(path.resolve(caseRoot, 'vault')));
});

test('Candidate and actual ChangeSets are stored separately', (t) => {
  const { vault, stateDir } = setup('guarded-foundation-separation');
  const guarded = openGuarded(t, stateDir);
  const prepared = guarded.prepare({ root: vault, target: 'allowed-a.md', candidateContent: 'candidate\n' });
  guarded.approve(prepared.run_id);
  guarded.execute(prepared.run_id);
  guarded.dispose();

  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_change_sets').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM change_sets').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM labels').get().count, 1);
  } finally {
    db.close();
  }
});

test('Guarded rollback refuses to overwrite a later external change', (t) => {
  const { vault, stateDir } = setup('guarded-rollback-conflict');
  const guarded = openGuarded(t, stateDir);
  const target = path.join(vault, 'allowed-a.md');
  const prepared = guarded.prepare({ root: vault, target: 'allowed-a.md', candidateContent: 'candidate\n' });
  guarded.approve(prepared.run_id);
  guarded.execute(prepared.run_id);
  fs.appendFileSync(target, 'later external change\n', 'utf8');
  const externalState = fs.readFileSync(target, 'utf8');

  assert.throws(() => guarded.rollback(prepared.run_id), /changed after execution/i);
  assert.equal(fs.readFileSync(target, 'utf8'), externalState);
  assert.equal(guarded.preview(prepared.run_id).run.status, 'executed');
});

test('Guarded resumes safely if a crash happened after the file write but before Ledger finalization', (t) => {
  const { vault, stateDir } = setup('guarded-crash-resume');
  const guarded = openGuarded(t, stateDir);
  const target = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(target, 'utf8');
  const prepared = guarded.prepare({ root: vault, target: 'allowed-a.md', candidateContent: 'candidate\n' });
  guarded.approve(prepared.run_id);
  const preview = guarded.preview(prepared.run_id);

  fs.copyFileSync(preview.candidate.blob_path, target);
  const execution = guarded.execute(prepared.run_id);
  assert.equal(execution.verified, true);
  assert.equal(guarded.preview(prepared.run_id).run.status, 'executed');

  fs.copyFileSync(preview.baseline.blob_path, target);
  guarded.rollback(prepared.run_id);
  assert.equal(fs.readFileSync(target, 'utf8'), baseline);
  assert.equal(guarded.preview(prepared.run_id).run.status, 'rolled_back');
});
