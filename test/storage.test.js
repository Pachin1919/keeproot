import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RuntimeStorage } from '../src/runtime-storage.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(caseRoot, { recursive: true });
  return { caseRoot, stateDir };
}

test('managed work keeps uncaptured Agent files and only plans captured work for cleanup', () => {
  const { caseRoot, stateDir } = setup('managed-work-lifecycle');
  const source = path.join(caseRoot, 'candidate.md');
  fs.writeFileSync(source, '# Candidate\n', 'utf8');
  const storage = new RuntimeStorage({ stateDir });

  const staged = storage.stage({ source, kind: 'candidate', ttlHours: 24 });
  assert.equal(staged.status, 'staged');
  assert.equal(fs.readFileSync(staged.payload_path, 'utf8'), '# Candidate\n');
  assert.equal(storage.plan({ minAgeMs: 0 }).work_items.length, 0);

  const captured = storage.markCaptured(staged.payload_path, 'DRV-test');
  assert.equal(captured.status, 'captured');
  const plan = storage.plan({ minAgeMs: 0 });
  assert.deepEqual(plan.work_items.map((item) => item.work_id), [staged.work_id]);
  assert.equal(fs.existsSync(staged.payload_path), true);

  const executed = storage.execute({ minAgeMs: 0 });
  assert.equal(executed.deleted_work_items, 1);
  assert.equal(fs.existsSync(path.dirname(staged.payload_path)), false);
});

test('managed work explains how to stage a candidate placed in an unregistered work directory', () => {
  const { stateDir } = setup('managed-work-unstaged-path-guidance');
  const storage = new RuntimeStorage({ stateDir });
  const unmanagedDir = path.join(stateDir, 'work', 'r4-candidates');
  const candidate = path.join(unmanagedDir, 'candidate.md');
  fs.mkdirSync(unmanagedDir, { recursive: true });
  fs.writeFileSync(candidate, '# Candidate\n', 'utf8');

  assert.throws(
    () => storage.markCaptured(candidate, 'GRD-test'),
    (error) => (
      error.message.includes('atlas work stage')
      && error.message.includes('payload_path')
    ),
  );
});

test('storage status classifies temp, work, blobs and protected backups without deleting on status or plan', () => {
  const { stateDir } = setup('storage-classification');
  const storage = new RuntimeStorage({ stateDir });
  const tempDir = path.join(stateDir, 'tmp');
  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  const tempFile = path.join(tempDir, 'stale.tmp');
  fs.writeFileSync(tempFile, 'temporary', 'utf8');
  fs.writeFileSync(path.join(backupDir, 'ledger.sqlite'), 'backup', 'utf8');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(tempFile, old, old);

  const before = storage.status();
  assert.equal(before.technical_temp.files, 1);
  assert.equal(before.protected_backups.files, 1);
  const plan = storage.plan({ minAgeMs: 60 * 60 * 1000 });
  assert.equal(plan.temp_files.length, 1);
  assert.equal(fs.existsSync(tempFile), true);
  assert.equal(fs.existsSync(path.join(backupDir, 'ledger.sqlite')), true);

  const executed = storage.execute({ minAgeMs: 60 * 60 * 1000 });
  assert.equal(executed.deleted_temp_files, 1);
  assert.equal(fs.existsSync(tempFile), false);
  assert.equal(fs.existsSync(path.join(backupDir, 'ledger.sqlite')), true);
});
