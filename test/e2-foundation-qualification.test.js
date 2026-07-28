import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION, Ledger } from '../src/ledger.js';
import { Tracker } from '../src/tracker.js';

const tempRoot = path.resolve('test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'note.md'), 'baseline\n', 'utf8');
  return { caseRoot, root, stateDir };
}

test('Ledger refuses a non-writable existing database before any governed source operation starts', () => {
  const { root, stateDir } = setup('ledger-read-only-preflight');
  const initialized = new Tracker({ stateDir });
  initialized.status();
  initialized.dispose();
  const databasePath = path.join(stateDir, 'ledger.sqlite');
  const sourceBefore = fs.readFileSync(path.join(root, 'note.md'), 'utf8');
  const originalOpen = fs.openSync;
  fs.openSync = function denyLedgerWrite(filePath, flags, ...rest) {
    if (path.resolve(String(filePath)) === path.resolve(databasePath) && flags === 'r+') {
      const error = new Error('fixture read-only Ledger');
      error.code = 'EACCES';
      throw error;
    }
    return originalOpen.call(this, filePath, flags, ...rest);
  };
  try {
    assert.throws(() => new Ledger(stateDir), /writable|read-only|EACCES/i);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(fs.readFileSync(path.join(root, 'note.md'), 'utf8'), sourceBefore);
});

test('Ledger migrations preserve uncheckpointed WAL data in the verified migration backup', () => {
  const { stateDir } = setup('ledger-wal-migration');
  fs.mkdirSync(stateDir, { recursive: true });
  const databasePath = path.join(stateDir, 'ledger.sqlite');
  const writer = new DatabaseSync(databasePath);
  writer.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE legacy_fact(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO legacy_fact(value) VALUES ('preserve-from-wal');
    PRAGMA user_version = 11;
  `);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  reader.exec('BEGIN;');
  reader.prepare('SELECT COUNT(*) AS count FROM legacy_fact').get();
  writer.exec("INSERT INTO legacy_fact(value) VALUES ('preserve-from-wal-2');");
  writer.close();
  assert.equal(fs.existsSync(`${databasePath}-wal`), true);

  const ledger = new Ledger(stateDir);
  ledger.close();
  reader.exec('ROLLBACK;');
  reader.close();

  const backups = fs.readdirSync(path.join(stateDir, 'backups'))
    .filter((name) => name.includes(`v11-to-v${LATEST_SCHEMA_VERSION}`) && name.endsWith('.sqlite'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(stateDir, 'backups', backups[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT value FROM legacy_fact').get().value, 'preserve-from-wal');
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM legacy_fact').get().count, 2);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    backup.close();
  }
});

test('idempotent close and rollback do not duplicate terminal operation events', () => {
  const { root, stateDir } = setup('ledger-terminal-event-idempotency');
  const tracker = new Tracker({ stateDir });
  const begun = tracker.begin({ root, allow: ['note.md'], intent: 'event qualification' });
  fs.writeFileSync(path.join(root, 'note.md'), 'changed\n', 'utf8');
  tracker.close(begun.run_id);
  tracker.close(begun.run_id);
  tracker.rollback(begun.run_id);
  tracker.rollback(begun.run_id);
  tracker.dispose();

  const database = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM operation_events WHERE run_id = ? AND event_type = 'close_completed'").get(begun.run_id).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM operation_events WHERE run_id = ? AND event_type = 'rollback_completed'").get(begun.run_id).count, 1);
  } finally {
    database.close();
  }
});
