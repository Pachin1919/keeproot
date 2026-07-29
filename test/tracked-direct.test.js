import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { RollbackConflictError, Tracker } from '../src/tracker.js';

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

function openTracker(t, stateDir) {
  const tracker = new Tracker({ stateDir });
  t.after(() => tracker.dispose());
  return tracker;
}

function append(filePath, text) {
  fs.appendFileSync(filePath, text, 'utf8');
}

test('normal modification of one allowed file is tracked with a complete diff', (t) => {
  const { vault, stateDir } = setup('normal-one-file');
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'], intent: 'normal edit' });

  append(path.join(vault, 'allowed-a.md'), 'changed-a\n');
  const receipt = tracker.close();
  const detail = tracker.show(run.run_id);

  assert.equal(receipt.policy, 'pass');
  assert.equal(receipt.changed_files, 1);
  assert.deepEqual(receipt.scope_violations, []);
  assert.equal(detail.changes[0].path, 'allowed-a.md');
  assert.match(detail.change_set.diff_text, /\+changed-a/);
  assert.equal(detail.run.status, 'closed');
});
test('close records a no-op when no files changed', (t) => {
  const { vault, stateDir } = setup('no-change');
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });

  const receipt = tracker.close();
  const detail = tracker.show(run.run_id);

  assert.equal(receipt.changed_files, 0);
  assert.equal(receipt.policy, 'pass');
  assert.equal(detail.change_set.diff_text, '');
});

test('close identifies a file changed outside the allowed scope', (t) => {
  const { vault, stateDir } = setup('scope-violation');
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });

  append(path.join(vault, 'outside.md'), 'unauthorized\n');
  const receipt = tracker.close(run.run_id);

  assert.equal(receipt.policy, 'violation');
  assert.deepEqual(receipt.scope_violations, ['outside.md']);
  assert.equal(tracker.show(run.run_id).decisions.at(-1).decision, 'violation');
});

test('an unrelated junction inside the tracked root is recorded without being followed or blocking allowed work', (t) => {
  const { caseRoot, vault, stateDir } = setup('unrelated-junction');
  const tracker = openTracker(t, stateDir);
  const external = path.join(caseRoot, 'external-dependency');
  const junction = path.join(vault, 'node_modules-link');
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(external, 'outside.txt'), 'must not be tracked\n', 'utf8');
  try {
    fs.symlinkSync(external, junction, 'junction');
  } catch (error) {
    t.skip(`Junction creation is unavailable: ${error.message}`);
    return;
  }

  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  append(path.join(vault, 'allowed-a.md'), 'allowed change\n');
  const receipt = tracker.close(run.run_id);
  const detail = tracker.show(run.run_id);

  assert.equal(receipt.policy, 'pass');
  assert.equal(receipt.changed_files, 1);
  assert.equal(detail.changes.some((change) => change.path.includes('outside.txt')), false);
});

test('multiple explicitly allowed files can change together', (t) => {
  const { vault, stateDir } = setup('multiple-allowed');
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md', 'allowed-b.md'] });

  append(path.join(vault, 'allowed-a.md'), 'a2\n');
  append(path.join(vault, 'allowed-b.md'), 'b2\n');
  const receipt = tracker.close(run.run_id);

  assert.equal(receipt.policy, 'pass');
  assert.equal(receipt.changed_files, 2);
  assert.equal(receipt.allowed_changes, 2);
});

test('repeating close is idempotent and does not add another close event', (t) => {
  const { vault, stateDir } = setup('idempotent-close');
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  append(path.join(vault, 'allowed-a.md'), 'once\n');

  const first = tracker.close(run.run_id);
  const second = tracker.close(run.run_id);
  const closeEvents = tracker.show(run.run_id).events.filter((event) => event.type === 'close_completed');

  assert.deepEqual(second, first);
  assert.equal(closeEvents.length, 1);
});

test('an interrupted task remains visible as an open run', () => {
  const { vault, stateDir } = setup('interrupted');
  const firstProcess = new Tracker({ stateDir });
  const run = firstProcess.begin({ root: vault, allow: ['allowed-a.md'] });
  firstProcess.dispose();

  const nextProcess = new Tracker({ stateDir });
  try {
    const visible = nextProcess.status().find((item) => item.id === run.run_id);
    assert.equal(visible.status, 'open');
  } finally {
    nextProcess.dispose();
  }
});

test('rollback restores a normal modification and is idempotent', (t) => {
  const { vault, stateDir } = setup('normal-rollback');
  const tracker = openTracker(t, stateDir);
  const filePath = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(filePath, 'utf8');
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  append(filePath, 'temporary\n');
  tracker.close(run.run_id);

  const first = tracker.rollback(run.run_id);
  const second = tracker.rollback(run.run_id);

  assert.equal(fs.readFileSync(filePath, 'utf8'), baseline);
  assert.deepEqual(second, first);
  assert.equal(tracker.show(run.run_id).run.status, 'rolled_back');
});

test('rollback refuses to overwrite an external change made after close', (t) => {
  const { vault, stateDir } = setup('rollback-conflict');
  const tracker = openTracker(t, stateDir);
  const filePath = path.join(vault, 'allowed-a.md');
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  append(filePath, 'tracked-change\n');
  tracker.close(run.run_id);
  append(filePath, 'later-legal-change\n');
  const current = fs.readFileSync(filePath, 'utf8');

  assert.throws(
    () => tracker.rollback(run.run_id),
    (error) => error instanceof RollbackConflictError && error.conflicts[0].path === 'allowed-a.md',
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), current);
  assert.equal(tracker.show(run.run_id).run.status, 'closed');
});

test('begin rejects an allowed path that escapes the target root', (t) => {
  const { caseRoot, vault, stateDir } = setup('path-escape');
  const tracker = openTracker(t, stateDir);
  fs.writeFileSync(path.join(caseRoot, 'escape.md'), 'outside target root\n', 'utf8');

  assert.throws(
    () => tracker.begin({ root: vault, allow: ['../escape.md'] }),
    /escapes target root/,
  );
  assert.equal(tracker.status().length, 0);
});

test('Foundation concepts remain separate Ledger tables', () => {
  const { stateDir } = setup('foundation-boundaries');
  const tracker = new Tracker({ stateDir });
  tracker.status();
  tracker.dispose();
  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    const tables = new Set(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => row.name));
    for (const table of [
      'artifacts',
      'materials',
      'projects',
      'observations',
      'predictions',
      'labels',
      'policy_decisions',
      'change_sets',
      'operation_events',
      'rule_versions',
    ]) {
      assert.ok(tables.has(table), `missing Foundation table: ${table}`);
    }
  } finally {
    db.close();
  }
});
