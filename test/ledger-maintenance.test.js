import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION } from '../src/ledger.js';
import { listLedgerBackups, ledgerFileHash, restoreLedgerBackup } from '../src/ledger-maintenance.js';
import { Tracker } from '../src/tracker.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function freshCase(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  fs.mkdirSync(caseRoot, { recursive: true });
  return caseRoot;
}

function createVersionOneLedger(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const databasePath = path.join(stateDir, 'ledger.sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE rule_versions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
        definition_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL,
        root_path TEXT NOT NULL, intent TEXT,
        rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
        started_at TEXT NOT NULL, closed_at TEXT, rolled_back_at TEXT,
        receipt_json TEXT, rollback_receipt_json TEXT
      );
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE labels (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        name TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO rule_versions VALUES (
        'RULE-LEGACY', 'Legacy rule', '1.0.0', '{}', '2026-07-17T00:00:00.000Z'
      );
      INSERT INTO runs VALUES (
        'RUN-LEGACY', 'tracked_direct', 'open', 'F:\\fixture', NULL,
        'RULE-LEGACY', '2026-07-17T00:00:00.000Z', NULL, NULL, NULL, NULL
      );
      PRAGMA user_version = 1;
    `);
  } finally {
    legacy.close();
  }
}

test('Ledger maintenance lists a verified migration backup and restores it with a current-hash gate', () => {
  const caseRoot = freshCase('ledger-maintenance-restore');
  const stateDir = path.join(caseRoot, '.atlas');
  createVersionOneLedger(stateDir);

  const migrated = new Tracker({ stateDir });
  migrated.status();
  migrated.dispose();

  const backups = listLedgerBackups(stateDir);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].schema_version, 1);
  assert.equal(backups[0].integrity, 'ok');

  const expectedCurrentHash = ledgerFileHash(stateDir);
  assert.throws(
    () => restoreLedgerBackup({
      stateDir,
      backupName: backups[0].name,
      expectedCurrentHash: '0'.repeat(64),
    }),
    /current Ledger changed/i,
  );
  assert.equal(ledgerFileHash(stateDir), expectedCurrentHash);

  const receipt = restoreLedgerBackup({
    stateDir,
    backupName: backups[0].name,
    expectedCurrentHash,
  });
  assert.equal(receipt.restored_schema_version, 1);
  assert.equal(receipt.restored_from, backups[0].name);
  assert.equal(receipt.previous_hash, expectedCurrentHash);
  assert.ok(fs.existsSync(path.join(stateDir, 'backups', receipt.safety_backup)));

  const reopened = new Tracker({ stateDir });
  try {
    assert.equal(reopened.status()[0].id, 'RUN-LEGACY');
    assert.equal(reopened.ledger.diagnostics().schema_version, LATEST_SCHEMA_VERSION);
  } finally {
    reopened.dispose();
  }
});

test('Ledger maintenance rejects a corrupt or escaping backup before replacing the current Ledger', () => {
  const caseRoot = freshCase('ledger-maintenance-corrupt');
  const stateDir = path.join(caseRoot, '.atlas');
  const tracker = new Tracker({ stateDir });
  tracker.status();
  tracker.dispose();
  const beforeHash = ledgerFileHash(stateDir);

  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'corrupt.sqlite'), 'not sqlite', 'utf8');

  assert.throws(
    () => restoreLedgerBackup({ stateDir, backupName: 'corrupt.sqlite', expectedCurrentHash: beforeHash }),
    /valid SQLite|integrity/i,
  );
  assert.throws(
    () => restoreLedgerBackup({ stateDir, backupName: '..\\ledger.sqlite', expectedCurrentHash: beforeHash }),
    /backup name/i,
  );
  assert.equal(ledgerFileHash(stateDir), beforeHash);
});

for (const legacyVersion of [8, 10, 11, 18]) {
  test(`Ledger schema ${legacyVersion} reopens through a verified backup and converges to the current schema`, () => {
    const caseRoot = freshCase(`ledger-migration-v${legacyVersion}`);
    const stateDir = path.join(caseRoot, '.atlas');
    const initialized = new Tracker({ stateDir });
    initialized.status();
    initialized.dispose();

    const databasePath = path.join(stateDir, 'ledger.sqlite');
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP TABLE catalog_fts;
        DROP TABLE source_set_items;
        DROP TABLE source_sets;
        DROP TABLE context_candidate_items;
        DROP TABLE context_candidate_sets;
        DROP TABLE catalog_entries;
        DROP TABLE catalog_generations;
        DROP TABLE project_context_links;
        DROP TABLE project_locations;
      `);
      if (legacyVersion < 11) legacy.exec('DROP TABLE evolution_operations;');
      if (legacyVersion < 12) {
        legacy.exec('DROP TABLE task_inputs; DROP TABLE task_contracts;');
      }
      legacy.exec(`PRAGMA user_version = ${legacyVersion};`);
    } finally {
      legacy.close();
    }

    const reopened = new Tracker({ stateDir });
    try {
      assert.equal(reopened.ledger.diagnostics().schema_version, LATEST_SCHEMA_VERSION);
    } finally {
      reopened.dispose();
    }
    const backups = listLedgerBackups(stateDir);
    const migration = backups.find((item) => item.name.includes(`v${legacyVersion}-to-v${LATEST_SCHEMA_VERSION}`));
    assert.ok(migration);
    assert.equal(migration.schema_version, legacyVersion);
    assert.equal(migration.integrity, 'ok');
  });
}
