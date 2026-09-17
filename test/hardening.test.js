import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION } from '../src/ledger.js';
import { RollbackConflictError, Tracker } from '../src/tracker.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = path.join(projectRoot, 'fixtures', 'vault-template');
const tempRoot = path.join(projectRoot, 'test', '.tmp');
const trackerModuleUrl = pathToFileURL(path.join(projectRoot, 'src', 'tracker.js')).href;

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

function closeInChildProcess(cwd, stateDir, runId) {
  const source = `
    import { Tracker } from ${JSON.stringify(trackerModuleUrl)};
    const tracker = new Tracker({ stateDir: process.env.ATLAS_TEST_STATE_DIR });
    try {
      console.log(JSON.stringify(tracker.close(process.env.ATLAS_TEST_RUN_ID)));
    } finally {
      tracker.dispose();
    }
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ATLAS_TEST_STATE_DIR: stateDir,
        ATLAS_TEST_RUN_ID: runId,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('rejecting a state directory inside the target root does not mutate the root', () => {
  const { vault } = setup('state-inside-root');
  const stateDir = path.join(vault, '.atlas');
  const tracker = new Tracker({ stateDir });
  try {
    assert.throws(
      () => tracker.begin({ root: vault, allow: ['allowed-a.md'] }),
      /state directory must be outside/i,
    );
    assert.equal(fs.existsSync(stateDir), false);
  } finally {
    tracker.dispose();
  }
});

test('abort closes an unchanged open run and is idempotent', (t) => {
  const { vault, stateDir } = setup('abort-unchanged');
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });

  const first = tracker.abort(run.run_id, { reason: 'caller stopped' });
  const second = tracker.abort(run.run_id, { reason: 'caller stopped' });

  assert.equal(first.status, 'aborted');
  assert.equal(first.reason, 'caller stopped');
  assert.deepEqual(second, first);
  assert.equal(tracker.show(run.run_id).run.status, 'aborted');
  assert.equal(
    tracker.show(run.run_id).events.filter((event) => event.type === 'abort_completed').length,
    1,
  );
});

test('abort refuses to hide file changes and leaves the run open', (t) => {
  const { vault, stateDir } = setup('abort-with-change');
  const tracker = openTracker(t, stateDir);
  const filePath = path.join(vault, 'allowed-a.md');
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  fs.appendFileSync(filePath, 'changed before abort\n', 'utf8');
  const current = fs.readFileSync(filePath, 'utf8');

  assert.throws(() => tracker.abort(run.run_id), /close the run/i);
  assert.equal(fs.readFileSync(filePath, 'utf8'), current);
  assert.equal(tracker.show(run.run_id).run.status, 'open');
});

test('rollback validates every recovery blob before modifying any file', (t) => {
  const { vault, stateDir } = setup('corrupt-rollback-material');
  const tracker = openTracker(t, stateDir);
  const aPath = path.join(vault, 'allowed-a.md');
  const bPath = path.join(vault, 'allowed-b.md');
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md', 'allowed-b.md'] });
  fs.appendFileSync(aPath, 'end-a\n', 'utf8');
  fs.appendFileSync(bPath, 'end-b\n', 'utf8');
  tracker.close(run.run_id);
  const endA = fs.readFileSync(aPath, 'utf8');
  const endB = fs.readFileSync(bPath, 'utf8');
  const changes = tracker.show(run.run_id).changes;
  fs.writeFileSync(changes[1].beforeBlobPath, 'corrupt material\n', 'utf8');

  assert.throws(() => tracker.rollback(run.run_id), /recovery material/i);
  assert.equal(fs.readFileSync(aPath, 'utf8'), endA);
  assert.equal(fs.readFileSync(bPath, 'utf8'), endB);
  assert.equal(tracker.show(run.run_id).run.status, 'closed');
});

test('diff explains a change that only removes the final newline', (t) => {
  const { vault, stateDir } = setup('final-newline-diff');
  const tracker = openTracker(t, stateDir);
  const filePath = path.join(vault, 'allowed-a.md');
  fs.writeFileSync(filePath, 'same line\n', 'utf8');
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  fs.writeFileSync(filePath, 'same line', 'utf8');

  tracker.close(run.run_id);
  assert.match(tracker.show(run.run_id).change_set.diff_text, /No newline at end of file/);
});

test('Ledger exposes a current schema version and migration history', () => {
  const { stateDir } = setup('schema-version');
  const tracker = new Tracker({ stateDir });
  tracker.status();
  tracker.dispose();

  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 2);
    const migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    assert.ok(migrations.length >= 2);
  } finally {
    db.close();
  }
});

test('a fresh Ledger does not create removed Task or Task Context selection storage', () => {
  const { stateDir } = setup('schema-without-task-contract');
  const tracker = new Tracker({ stateDir });
  tracker.status();
  tracker.dispose();

  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    assert.equal(names.has('task_contracts'), false);
    assert.equal(names.has('task_inputs'), false);
    assert.equal(names.has('task_fulfillment_claims'), false);
    assert.equal(names.has('context_candidate_sets'), false);
    assert.equal(names.has('context_candidate_items'), false);
    assert.equal(names.has('source_sets'), false);
    assert.equal(names.has('source_set_items'), false);
  } finally {
    db.close();
  }
});

test('an upgrade removes historical Task Context selection storage from the Ledger and migration backups', () => {
  const { stateDir } = setup('schema-removes-historical-task-context-selection');
  const initialized = new Tracker({ stateDir });
  initialized.status();
  initialized.dispose();

  const databasePath = path.join(stateDir, 'ledger.sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      INSERT OR IGNORE INTO projects(
        id, name, current_path, status, parent_project_id, lineage_json, created_at, updated_at
      ) VALUES (
        'PRJ-LEGACY', 'Legacy Context Project', NULL, 'active', NULL, '{}',
        '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z'
      );
      CREATE TABLE IF NOT EXISTS context_candidate_sets (
        id TEXT PRIMARY KEY,
        target_project_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        terms_json TEXT NOT NULL,
        context_link_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS context_candidate_items (
        candidate_set_id TEXT NOT NULL REFERENCES context_candidate_sets(id),
        ordinal INTEGER NOT NULL,
        catalog_entry_id TEXT NOT NULL,
        context_link_id TEXT NOT NULL,
        source_project_id TEXT NOT NULL,
        source_root_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        score REAL,
        snippet TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(candidate_set_id, catalog_entry_id)
      );
      CREATE TABLE IF NOT EXISTS source_sets (
        id TEXT PRIMARY KEY,
        candidate_set_id TEXT NOT NULL REFERENCES context_candidate_sets(id),
        target_project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_set_items (
        source_set_id TEXT NOT NULL REFERENCES source_sets(id),
        ordinal INTEGER NOT NULL,
        catalog_entry_id TEXT NOT NULL,
        source_project_id TEXT NOT NULL,
        source_root_id TEXT NOT NULL,
        source_root_path TEXT NOT NULL,
        source_relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(source_set_id, catalog_entry_id)
      );
      INSERT INTO context_candidate_sets(
        id, target_project_id, purpose, terms_json, context_link_ids_json,
        status, created_at, expires_at
      ) VALUES (
        'CCS-LEGACY', 'PRJ-LEGACY', 'task_context', '[]', '[]',
        'prepared', '2026-09-16T00:00:00.000Z', NULL
      );
      INSERT INTO source_sets(id, candidate_set_id, target_project_id, status, created_at)
      VALUES (
        'SRCSET-LEGACY', 'CCS-LEGACY', 'PRJ-LEGACY', 'accepted',
        '2026-09-16T00:00:00.000Z'
      );
      CREATE TABLE legacy_context_keep (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO legacy_context_keep(id, value)
      VALUES (1, 'retain current Project and Catalog foundations');
      PRAGMA user_version = 22;
    `);
  } finally {
    legacy.close();
  }
  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(databasePath, path.join(backupDir, 'ledger-pre-migration-v21-to-v22.sqlite'));

  const upgraded = new Tracker({ stateDir });
  upgraded.status();
  upgraded.dispose();

  const retiredTables = [
    'context_candidate_sets', 'context_candidate_items', 'source_sets', 'source_set_items',
  ];
  const verify = (database, name) => {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of retiredTables) assert.equal(tables.has(table), false, `${name}: ${table}`);
    assert.equal(tables.has('project_context_links'), true, `${name}: project_context_links`);
    assert.equal(tables.has('catalog_entries'), true, `${name}: catalog_entries`);
    assert.equal(tables.has('resources'), true, `${name}: resources`);
    assert.equal(
      database.prepare('SELECT value FROM legacy_context_keep WHERE id = 1').get().value,
      'retain current Project and Catalog foundations',
      name,
    );
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', name);
  };

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(verified.prepare('PRAGMA user_version').get().user_version, LATEST_SCHEMA_VERSION);
    verify(verified, 'main');
  } finally {
    verified.close();
  }

  const backups = fs.readdirSync(backupDir).filter((name) => name.endsWith('.sqlite'));
  assert.ok(backups.length >= 2);
  for (const name of backups) {
    const backup = new DatabaseSync(path.join(backupDir, name), { readOnly: true });
    try {
      verify(backup, name);
    } finally {
      backup.close();
    }
  }
});

test('an upgrade removes historical Task storage from the Ledger and migration backups', () => {
  const { stateDir } = setup('schema-removes-historical-task-storage');
  const initialized = new Tracker({ stateDir });
  initialized.status();
  initialized.dispose();

  const databasePath = path.join(stateDir, 'ledger.sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE task_contracts (
        run_id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        underlying_run_id TEXT
      );
      CREATE TABLE task_inputs (
        run_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY(run_id, ordinal)
      );
      CREATE TABLE task_fulfillment_claims (
        task_run_id TEXT PRIMARY KEY,
        claim_token TEXT NOT NULL
      );
      CREATE TABLE legacy_keep (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO task_contracts(run_id, contract_id, underlying_run_id)
      VALUES ('RUN-HISTORICAL-TASK', 'TSK-HISTORICAL', NULL);
      INSERT INTO task_inputs(run_id, ordinal, path)
      VALUES ('RUN-HISTORICAL-TASK', 0, 'Source/input.csv');
      INSERT INTO task_fulfillment_claims(task_run_id, claim_token)
      VALUES ('RUN-HISTORICAL-TASK', 'CLAIM-HISTORICAL');
      INSERT INTO legacy_keep(id, value)
      VALUES (1, 'retain unrelated data');
      PRAGMA user_version = 21;
    `);
  } finally {
    legacy.close();
  }
  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(databasePath, path.join(backupDir, 'ledger-pre-migration-v20-to-v21.sqlite'));

  const upgraded = new Tracker({ stateDir });
  upgraded.status();
  upgraded.dispose();

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = new Set(verified.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    assert.equal(tables.has('task_contracts'), false);
    assert.equal(tables.has('task_inputs'), false);
    assert.equal(tables.has('task_fulfillment_claims'), false);
    assert.equal(verified.prepare('SELECT value FROM legacy_keep WHERE id = 1').get().value, 'retain unrelated data');
    assert.equal(verified.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    verified.close();
  }

  const backups = fs.readdirSync(backupDir).filter((name) => name.endsWith('.sqlite'));
  assert.ok(backups.length >= 2);
  for (const name of backups) {
    const backup = new DatabaseSync(path.join(backupDir, name), { readOnly: true });
    try {
      const tables = new Set(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      assert.equal(tables.has('task_contracts'), false, name);
      assert.equal(tables.has('task_inputs'), false, name);
      assert.equal(tables.has('task_fulfillment_claims'), false, name);
      assert.equal(backup.prepare('SELECT value FROM legacy_keep WHERE id = 1').get().value, 'retain unrelated data');
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      backup.close();
    }
  }
});

test('historical runs expose the immutable RuleVersion definition they used', (t) => {
  const { vault, stateDir } = setup('rule-version-detail');
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  const detail = tracker.show(run.run_id);
  assert.equal(detail.rule_version.id, detail.run.rule_version_id);
  assert.equal(detail.rule_version.name, 'Tracked Direct scope policy');
  assert.equal(detail.rule_version.version, '1.0.0');
  assert.equal(detail.rule_version.definition.allow, 'exact files and descendants of allowed directories');
});

test('a version 1 Ledger is migrated in place without losing its existing run', () => {
  const { stateDir } = setup('schema-migration-v1');
  fs.mkdirSync(stateDir, { recursive: true });
  const databasePath = path.join(stateDir, 'ledger.sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE rule_versions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        root_path TEXT NOT NULL,
        intent TEXT,
        rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
        started_at TEXT NOT NULL,
        closed_at TEXT,
        rolled_back_at TEXT,
        receipt_json TEXT,
        rollback_receipt_json TEXT
      );
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE labels (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
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

  const tracker = new Tracker({ stateDir });
  try {
    assert.equal(tracker.status()[0].id, 'RUN-LEGACY');
  } finally {
    tracker.dispose();
  }

  const backups = fs.readdirSync(path.join(stateDir, 'backups'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(stateDir, 'backups', backups[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(backup.prepare('SELECT status FROM runs WHERE id = ?').get('RUN-LEGACY').status, 'open');
  } finally {
    backup.close();
  }

  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, LATEST_SCHEMA_VERSION);
    const runColumns = new Set(migrated.prepare('PRAGMA table_info(runs)').all().map((row) => row.name));
    const labelColumns = new Set(migrated.prepare('PRAGMA table_info(labels)').all().map((row) => row.name));
    const artifactColumns = new Set(migrated.prepare('PRAGMA table_info(artifacts)').all().map((row) => row.name));
    assert.ok(runColumns.has('aborted_at'));
    assert.ok(runColumns.has('abort_receipt_json'));
    assert.ok(runColumns.has('actor'));
    assert.ok(runColumns.has('agent'));
    assert.ok(runColumns.has('model'));
    assert.ok(runColumns.has('tool'));
    assert.ok(runColumns.has('client_run_id'));
    assert.ok(labelColumns.has('subject_prediction_id'));
    const migratedTables = new Set(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    assert.equal(migratedTables.has('task_contracts'), false);
    assert.equal(migratedTables.has('task_inputs'), false);
    assert.equal(migratedTables.has('task_fulfillment_claims'), false);
    assert.ok(labelColumns.has('details_json'));
    assert.ok(artifactColumns.has('root_path'));
    assert.ok(artifactColumns.has('role'));
    assert.ok(artifactColumns.has('status'));
    for (const table of [
      'bootstrap_proposals', 'bootstrap_proposal_predictions', 'derived_operations',
      'derived_inputs', 'material_derivations', 'evolution_operations',
    ]) {
      assert.equal(
        migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count,
        1,
      );
    }
    const migratedRun = migrated.prepare(`
      SELECT status, actor, tool FROM runs WHERE id = ?
    `).get('RUN-LEGACY');
    assert.equal(migratedRun.status, 'open');
    assert.equal(migratedRun.actor, 'unknown');
    assert.equal(migratedRun.tool, 'atlas-cli');
  } finally {
    migrated.close();
  }
});

test('multi-file rollback resumes after a failure without treating restored paths as conflicts', (t) => {
  const { vault, stateDir } = setup('rollback-resume');
  const tracker = openTracker(t, stateDir);
  const firstPath = path.join(vault, 'allowed-a.md');
  const secondPath = path.join(vault, 'allowed-b.md');
  const firstBaseline = fs.readFileSync(firstPath, 'utf8');
  const secondBaseline = fs.readFileSync(secondPath, 'utf8');
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md', 'allowed-b.md'] });
  fs.writeFileSync(firstPath, '# changed first\n', 'utf8');
  fs.writeFileSync(secondPath, '# changed second\n', 'utf8');
  tracker.close(run.run_id);

  const originalCopy = fs.copyFileSync;
  let restoreCopies = 0;
  fs.copyFileSync = function injectedCopyFailure(source, destination, ...rest) {
    if (String(source).includes(`${path.sep}blobs${path.sep}sha256${path.sep}`)
        && String(destination).startsWith(vault)) {
      restoreCopies += 1;
      if (restoreCopies === 2) throw new Error('injected second restore failure');
    }
    return originalCopy.call(this, source, destination, ...rest);
  };
  try {
    assert.throws(() => tracker.rollback(run.run_id), /injected second restore failure/);
  } finally {
    fs.copyFileSync = originalCopy;
  }

  assert.equal(fs.readFileSync(firstPath, 'utf8'), firstBaseline);
  assert.equal(fs.readFileSync(secondPath, 'utf8'), '# changed second\n');
  const receipt = tracker.rollback(run.run_id);
  assert.equal(receipt.status, 'rolled_back');
  assert.equal(fs.readFileSync(firstPath, 'utf8'), firstBaseline);
  assert.equal(fs.readFileSync(secondPath, 'utf8'), secondBaseline);
  const eventTypes = tracker.show(run.run_id).events.map((event) => event.type);
  assert.ok(eventTypes.includes('rollback_path_restored'));
  assert.ok(eventTypes.includes('rollback_failed'));
  assert.ok(eventTypes.includes('rollback_completed'));
});

test('resumed rollback still refuses a later external change on an unfinished path', (t) => {
  const { vault, stateDir } = setup('rollback-resume-conflict');
  const tracker = openTracker(t, stateDir);
  const firstPath = path.join(vault, 'allowed-a.md');
  const secondPath = path.join(vault, 'allowed-b.md');
  const firstBaseline = fs.readFileSync(firstPath, 'utf8');
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md', 'allowed-b.md'] });
  fs.writeFileSync(firstPath, '# changed first\n', 'utf8');
  fs.writeFileSync(secondPath, '# changed second\n', 'utf8');
  tracker.close(run.run_id);

  const originalCopy = fs.copyFileSync;
  let restoreCopies = 0;
  fs.copyFileSync = function injectedCopyFailure(source, destination, ...rest) {
    if (String(source).includes(`${path.sep}blobs${path.sep}sha256${path.sep}`)
        && String(destination).startsWith(vault)) {
      restoreCopies += 1;
      if (restoreCopies === 2) throw new Error('injected second restore failure');
    }
    return originalCopy.call(this, source, destination, ...rest);
  };
  try {
    assert.throws(() => tracker.rollback(run.run_id), /injected second restore failure/);
  } finally {
    fs.copyFileSync = originalCopy;
  }

  fs.writeFileSync(secondPath, '# later legitimate edit\n', 'utf8');
  assert.throws(() => tracker.rollback(run.run_id), RollbackConflictError);
  assert.equal(fs.readFileSync(firstPath, 'utf8'), firstBaseline);
  assert.equal(fs.readFileSync(secondPath, 'utf8'), '# later legitimate edit\n');
  const detail = tracker.show(run.run_id);
  assert.equal(detail.run.status, 'closed');
  assert.deepEqual(detail.rollback_progress.map((item) => item.path), ['allowed-a.md']);
});

test('a future Ledger schema is rejected without changing its journal mode', () => {
  const { stateDir } = setup('schema-future-version');
  fs.mkdirSync(stateDir, { recursive: true });
  const databasePath = path.join(stateDir, 'ledger.sqlite');
  const future = new DatabaseSync(databasePath);
  future.exec('PRAGMA user_version = 999;');
  future.close();

  const tracker = new Tracker({ stateDir });
  assert.throws(() => tracker.status(), /newer than this Atlas build supports/);
  tracker.dispose();

  const unchanged = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 999);
    assert.equal(unchanged.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(
      unchanged.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'schema_migrations'").get().count,
      0,
    );
  } finally {
    unchanged.close();
  }
});

test('abort releases snapshots and garbage collection removes unreferenced blobs', (t) => {
  const { vault, stateDir } = setup('snapshot-gc');
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  tracker.abort(run.run_id);

  const result = tracker.gc({ minAgeMs: 0 });
  assert.ok(result.deleted_blobs > 0);
  assert.equal(result.skipped_referenced, 0);
});

test('a new file inside an allowed directory can be closed and rolled back', (t) => {
  const { vault, stateDir } = setup('new-file-rollback');
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['.'] });
  const added = path.join(vault, 'new-note.md');
  fs.writeFileSync(added, '# New\n', 'utf8');

  const receipt = tracker.close(run.run_id);
  assert.equal(receipt.policy, 'pass');
  assert.equal(tracker.show(run.run_id).changes[0].changeType, 'added');
  tracker.rollback(run.run_id);
  assert.equal(fs.existsSync(added), false);
});

test('a deleted allowed file can be closed and restored', (t) => {
  const { vault, stateDir } = setup('deleted-file-rollback');
  const tracker = openTracker(t, stateDir);
  const filePath = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(filePath, 'utf8');
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  fs.rmSync(filePath);

  const closed = tracker.close(run.run_id);
  assert.equal(closed.policy, 'violation');
  assert.equal(closed.violation_kind, 'risk');
  assert.equal(closed.actual_risk_mode, 'guarded');
  tracker.rollback(run.run_id);
  assert.equal(fs.readFileSync(filePath, 'utf8'), baseline);
});

test('moving the Atlas state directory does not break stored recovery materials', () => {
  const { caseRoot, vault, stateDir } = setup('state-directory-move');
  const filePath = path.join(vault, 'allowed-a.md');
  const baseline = fs.readFileSync(filePath, 'utf8');
  const first = new Tracker({ stateDir });
  const run = first.begin({ root: vault, allow: ['allowed-a.md'] });
  fs.appendFileSync(filePath, 'change before state move\n', 'utf8');
  first.close(run.run_id);
  first.dispose();

  const movedState = path.join(caseRoot, 'moved-state');
  fs.renameSync(stateDir, movedState);
  const reopened = new Tracker({ stateDir: movedState });
  try {
    reopened.rollback(run.run_id);
    assert.equal(fs.readFileSync(filePath, 'utf8'), baseline);
  } finally {
    reopened.dispose();
  }
});

test('two processes closing the same run converge on one recorded result', async () => {
  const { caseRoot, vault } = setup('concurrent-close');
  const stateDir = path.join(caseRoot, '.atlas');
  const largePath = path.join(vault, 'large.bin');
  fs.writeFileSync(largePath, Buffer.alloc(16 * 1024 * 1024));
  const tracker = new Tracker({ stateDir });
  const run = tracker.begin({ root: vault, allow: ['large.bin'] });
  tracker.dispose();
  fs.appendFileSync(largePath, Buffer.from([1]));

  const results = await Promise.all([
    closeInChildProcess(caseRoot, stateDir, run.run_id),
    closeInChildProcess(caseRoot, stateDir, run.run_id),
  ]);
  assert.deepEqual(results.map((result) => result.code), [0, 0], JSON.stringify(results));

  const reopened = new Tracker({ stateDir });
  try {
    const detail = reopened.show(run.run_id);
    assert.equal(detail.events.filter((event) => event.type === 'close_completed').length, 1);
    assert.equal(detail.changes.length, 1);
  } finally {
    reopened.dispose();
  }
});

test('a lock left by a dead Atlas process is reclaimed', (t) => {
  const { vault, stateDir } = setup('dead-process-lock');
  const lockDirectory = path.join(stateDir, 'locks');
  fs.mkdirSync(lockDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(lockDirectory, 'runtime.lock'),
    JSON.stringify({ pid: 2147483647, token: 'dead-owner' }),
    'utf8',
  );
  const tracker = openTracker(t, stateDir);
  const run = tracker.begin({ root: vault, allow: ['allowed-a.md'] });
  assert.equal(run.status, 'open');
  assert.equal(fs.existsSync(path.join(lockDirectory, 'runtime.lock')), false);
});
