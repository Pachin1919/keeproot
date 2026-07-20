import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RISK_RULE_VERSION_ID } from './risk.js';

const RULE_VERSION_ID = 'RULE-TRACKED-DIRECT-1';
const BOOTSTRAP_RULE_VERSION_ID = 'RULE-BOOTSTRAP-2';
export const LATEST_SCHEMA_VERSION = 10;

function json(value) {
  return JSON.stringify(value);
}
function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

function now() {
  return new Date().toISOString();
}

export class Ledger {
  constructor(stateDir) {
    this.stateDir = path.resolve(stateDir);
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.dbPath = path.join(this.stateDir, 'ledger.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    try {
      // Configure lock waiting before the first schema read. Another Atlas process may
      // still be closing its connection just after releasing the filesystem state lock.
      this.db.exec('PRAGMA busy_timeout = 5000;');
      const currentVersion = this.db.prepare('PRAGMA user_version').get().user_version;
      if (currentVersion > LATEST_SCHEMA_VERSION) {
        throw new Error(
          `Ledger schema ${currentVersion} is newer than this Atlas build supports (${LATEST_SCHEMA_VERSION}).`,
        );
      }
      if (currentVersion > 0 && currentVersion < LATEST_SCHEMA_VERSION) {
        this.#backupBeforeMigration(currentVersion);
      }
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.#initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  #initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rule_versions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        current_path TEXT,
        status TEXT NOT NULL,
        parent_project_id TEXT REFERENCES projects(id),
        lineage_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS project_aliases (
        project_id TEXT NOT NULL REFERENCES projects(id),
        alias TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, alias)
      );

      CREATE TABLE IF NOT EXISTS project_path_history (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        path TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS project_relations (
        id TEXT PRIMARY KEY,
        source_project_id TEXT NOT NULL REFERENCES projects(id),
        relation_type TEXT NOT NULL,
        target_project_id TEXT NOT NULL REFERENCES projects(id),
        effective_at TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(source_project_id, relation_type, target_project_id)
      );

      CREATE TABLE IF NOT EXISTS project_sources (
        project_id TEXT NOT NULL REFERENCES projects(id),
        prediction_id TEXT NOT NULL UNIQUE REFERENCES predictions(id),
        scan_run_id TEXT NOT NULL REFERENCES runs(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, prediction_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        root_path TEXT NOT NULL,
        intent TEXT,
        actor TEXT NOT NULL DEFAULT 'unknown',
        agent TEXT,
        model TEXT,
        tool TEXT NOT NULL DEFAULT 'atlas-cli',
        client_run_id TEXT,
        rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
        started_at TEXT NOT NULL,
        closed_at TEXT,
        aborted_at TEXT,
        rolled_back_at TEXT,
        receipt_json TEXT,
        abort_receipt_json TEXT,
        rollback_receipt_json TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        origin_run_id TEXT NOT NULL REFERENCES runs(id),
        project_id TEXT REFERENCES projects(id),
        kind TEXT NOT NULL,
        current_path TEXT NOT NULL,
        root_path TEXT,
        role TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_run_path
        ON artifacts(origin_run_id, current_path);

      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        stage TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        blob_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        subject_artifact_id TEXT REFERENCES artifacts(id),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS predictions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        subject_prediction_id TEXT REFERENCES predictions(id),
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS policy_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS change_sets (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        status TEXT NOT NULL,
        diff_text TEXT,
        diff_hash TEXT,
        summary_json TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS operation_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_run_time
        ON operation_events(run_id, occurred_at);

      CREATE TABLE IF NOT EXISTS run_scopes (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        scope_path TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        UNIQUE(run_id, scope_path, scope_kind)
      );

      CREATE TABLE IF NOT EXISTS run_file_states (
        run_id TEXT NOT NULL REFERENCES runs(id),
        path TEXT NOT NULL,
        stage TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        material_id TEXT REFERENCES materials(id),
        PRIMARY KEY(run_id, path, stage)
      );

      CREATE TABLE IF NOT EXISTS changes (
        id TEXT PRIMARY KEY,
        change_set_id TEXT NOT NULL REFERENCES change_sets(id),
        path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        before_kind TEXT,
        before_hash TEXT,
        before_material_id TEXT REFERENCES materials(id),
        after_kind TEXT,
        after_hash TEXT,
        after_material_id TEXT REFERENCES materials(id),
        UNIQUE(change_set_id, path)
      );

      CREATE TABLE IF NOT EXISTS environment_scans (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        fingerprint TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        output_dir TEXT,
        initialized_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_environment_scans_fingerprint
        ON environment_scans(fingerprint);

      CREATE TABLE IF NOT EXISTS environment_entries (
        run_id TEXT NOT NULL REFERENCES runs(id),
        path TEXT NOT NULL,
        entry_kind TEXT NOT NULL,
        extension TEXT,
        byte_size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        content_hash TEXT,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY(run_id, path)
      );

      CREATE TABLE IF NOT EXISTS environment_policies (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        scan_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
        policy_json TEXT NOT NULL,
        status TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        deactivated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_environment_policies_root_status
        ON environment_policies(root_path, status, activated_at);

      CREATE TABLE IF NOT EXISTS bootstrap_proposals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        source_hash TEXT NOT NULL,
        actor TEXT NOT NULL,
        agent TEXT,
        model TEXT,
        tool TEXT NOT NULL,
        client_run_id TEXT,
        prediction_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, source_hash)
      );

      CREATE TABLE IF NOT EXISTS bootstrap_proposal_predictions (
        proposal_id TEXT NOT NULL REFERENCES bootstrap_proposals(id),
        prediction_id TEXT NOT NULL UNIQUE REFERENCES predictions(id),
        ordinal INTEGER NOT NULL,
        PRIMARY KEY(proposal_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS candidate_change_sets (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        version INTEGER NOT NULL,
        operation TEXT NOT NULL,
        target_path TEXT NOT NULL,
        status TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        diff_text TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS guarded_operations (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        target_path TEXT NOT NULL,
        before_material_id TEXT NOT NULL REFERENCES materials(id),
        candidate_material_id TEXT NOT NULL REFERENCES materials(id),
        approved_candidate_hash TEXT,
        approval_receipt_json TEXT,
        rejection_receipt_json TEXT,
        execution_receipt_json TEXT,
        revised_from_run_id TEXT REFERENCES runs(id),
        executed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS rollback_progress (
        run_id TEXT NOT NULL REFERENCES runs(id),
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, path)
      );

      CREATE TABLE IF NOT EXISTS derived_operations (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        target_path TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        role TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        output_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        candidate_material_id TEXT NOT NULL REFERENCES materials(id),
        output_material_id TEXT REFERENCES materials(id),
        placement_prediction_id TEXT NOT NULL REFERENCES predictions(id),
        approved_candidate_hash TEXT,
        approval_receipt_json TEXT,
        rejection_receipt_json TEXT,
        execution_receipt_json TEXT,
        revised_from_run_id TEXT REFERENCES runs(id),
        executed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS derived_inputs (
        run_id TEXT NOT NULL REFERENCES runs(id),
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        material_id TEXT NOT NULL REFERENCES materials(id),
        prepared_hash TEXT NOT NULL,
        PRIMARY KEY(run_id, ordinal),
        UNIQUE(run_id, path)
      );

      CREATE TABLE IF NOT EXISTS material_derivations (
        output_material_id TEXT NOT NULL REFERENCES materials(id),
        input_material_id TEXT NOT NULL REFERENCES materials(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        relation_type TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(output_material_id, input_material_id, relation_type)
      );
    `);

    this.transaction(() => {
      this.#ensureColumn('runs', 'aborted_at', 'TEXT');
      this.#ensureColumn('runs', 'abort_receipt_json', 'TEXT');
      this.#ensureColumn('labels', 'subject_prediction_id', 'TEXT REFERENCES predictions(id)');
      this.#ensureColumn('labels', 'details_json', "TEXT NOT NULL DEFAULT '{}'");
      this.#ensureColumn('projects', 'updated_at', 'TEXT');
      this.#ensureColumn('runs', 'actor', "TEXT NOT NULL DEFAULT 'unknown'");
      this.#ensureColumn('runs', 'agent', 'TEXT');
      this.#ensureColumn('runs', 'model', 'TEXT');
      this.#ensureColumn('runs', 'tool', "TEXT NOT NULL DEFAULT 'atlas-cli'");
      this.#ensureColumn('runs', 'client_run_id', 'TEXT');
      this.#ensureColumn('artifacts', 'root_path', 'TEXT');
      this.#ensureColumn('artifacts', 'role', 'TEXT');
      this.#ensureColumn('artifacts', 'status', "TEXT NOT NULL DEFAULT 'active'");
      this.#ensureColumn('artifacts', 'updated_at', 'TEXT');
      this.#ensureColumn('derived_operations', 'revised_from_run_id', 'TEXT REFERENCES runs(id)');
      this.db.exec(`
        UPDATE artifacts
        SET root_path = (
          SELECT root_path FROM runs WHERE runs.id = artifacts.origin_run_id
        )
        WHERE root_path IS NULL;
        UPDATE artifacts SET updated_at = created_at WHERE updated_at IS NULL;
      `);
      const insertMigration = this.db.prepare(`
        INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)
      `);
      const appliedAt = now();
      insertMigration.run(1, 'initial_tracked_direct_schema', appliedAt);
      insertMigration.run(2, 'abort_lifecycle_and_schema_versioning', appliedAt);
      insertMigration.run(3, 'bootstrap_environment_observations_and_reviews', appliedAt);
      insertMigration.run(4, 'stable_project_registry_history_and_lineage', appliedAt);
      insertMigration.run(5, 'guarded_candidate_approval_and_execution', appliedAt);
      insertMigration.run(6, 'agent_caller_traceability', appliedAt);
      insertMigration.run(7, 'migration_backup_and_resumable_rollback', appliedAt);
      insertMigration.run(8, 'agent_environment_inference_and_derived_material_lineage', appliedAt);
      insertMigration.run(9, 'versioned_environment_profiles_and_active_routing_policy', appliedAt);
      insertMigration.run(10, 'derived_revision_and_artifact_role_evolution', appliedAt);
      this.db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION};`);
    });
  }

  #backupBeforeMigration(currentVersion) {
    const backupDir = path.join(this.stateDir, 'backups');
    const backupPath = path.join(
      backupDir,
      `ledger-pre-migration-v${currentVersion}-to-v${LATEST_SCHEMA_VERSION}.sqlite`,
    );
    if (fs.existsSync(backupPath)) return backupPath;
    fs.mkdirSync(backupDir, { recursive: true });
    const tempPath = path.join(backupDir, `${crypto.randomUUID()}.backup.tmp`);
    try {
      fs.writeFileSync(tempPath, Buffer.from(this.db.serialize()), { flag: 'wx' });
      fs.renameSync(tempPath, backupPath);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
    return backupPath;
  }

  #ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  #storeBlobPath(blobPath) {
    const absolute = path.resolve(blobPath);
    const relative = path.relative(this.stateDir, absolute);
    if (relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      return relative;
    }
    return absolute;
  }

  #resolveBlobPath(storedPath, contentHash) {
    if (!storedPath) return null;
    if (!path.isAbsolute(storedPath)) return path.resolve(this.stateDir, storedPath);
    if (fs.existsSync(storedPath)) return storedPath;
    return path.join(this.stateDir, 'blobs', 'sha256', contentHash);
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = callback();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  createRun({ runId, root, intent, caller = {}, scopes, baseline, risk, startedAt }) {
    const changeSetId = `CHG-${crypto.randomUUID()}`;
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        RULE_VERSION_ID,
        'Tracked Direct scope policy',
        '1.0.0',
        json({ allow: 'exact files and descendants of allowed directories', deny: 'all other changed paths' }),
        startedAt,
      );
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Deterministic V1 risk routing', '1.0.0', ?, ?)
      `).run(RISK_RULE_VERSION_ID, json({ outputs: ['tracked_direct', 'guarded', 'deny'] }), startedAt);

      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at
        ) VALUES (?, 'tracked_direct', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, root, intent ?? null, caller.actor ?? 'unknown', caller.agent ?? null,
        caller.model ?? null, caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        RULE_VERSION_ID, startedAt,
      );

      this.db.prepare(`
        INSERT INTO change_sets(id, run_id, status, created_at)
        VALUES (?, ?, 'open', ?)
      `).run(changeSetId, runId, startedAt);

      const insertScope = this.db.prepare(`
        INSERT INTO run_scopes(run_id, scope_path, scope_kind) VALUES (?, ?, ?)
      `);
      for (const scope of scopes) {
        insertScope.run(runId, scope.path, scope.kind);
      }

      const insertArtifact = this.db.prepare(`
        INSERT INTO artifacts(id, origin_run_id, kind, current_path, created_at)
        VALUES (?, ?, 'file', ?, ?)
      `);
      const insertMaterial = this.db.prepare(`
        INSERT INTO materials(id, artifact_id, stage, content_hash, byte_size, blob_path, created_at)
        VALUES (?, ?, 'before', ?, ?, ?, ?)
      `);
      const insertState = this.db.prepare(`
        INSERT INTO run_file_states(run_id, path, stage, kind, content_hash, byte_size, material_id)
        VALUES (?, ?, 'before', ?, ?, ?, ?)
      `);
      for (const entry of baseline) {
        const artifactId = `ART-${crypto.randomUUID()}`;
        const materialId = `MAT-${crypto.randomUUID()}`;
        insertArtifact.run(artifactId, runId, entry.path, startedAt);
        insertMaterial.run(
          materialId,
          artifactId,
          entry.contentHash,
          entry.byteSize,
          this.#storeBlobPath(entry.blobPath),
          startedAt,
        );
        insertState.run(
          runId,
          entry.path,
          entry.kind,
          entry.contentHash,
          entry.byteSize,
          materialId,
        );
      }

      this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'baseline_captured', ?, ?)
      `).run(`OBS-${crypto.randomUUID()}`, runId, json({ file_count: baseline.length }), startedAt);

      this.db.prepare(`
        INSERT INTO policy_decisions(id, run_id, rule_version_id, decision, reason, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `DEC-${crypto.randomUUID()}`,
        runId,
        RISK_RULE_VERSION_ID,
        risk.mode,
        risk.reasons.join(' '),
        json(risk),
        startedAt,
      );

      this.#insertEvent(runId, 'begin_completed', {
        root,
        scopes,
        baseline_file_count: baseline.length,
      }, startedAt);
    });

    return changeSetId;
  }

  createGuardedRun({
    runId,
    root,
    targetPath,
    intent,
    baseline,
    candidate,
    diffText,
    diffHash,
    risk,
    caller = {},
    revisedFromRunId,
    startedAt,
  }) {
    const candidateChangeSetId = `CAN-${crypto.randomUUID()}`;
    const actualChangeSetId = `CHG-${crypto.randomUUID()}`;
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Deterministic V1 risk routing', '1.0.0', ?, ?)
      `).run(RISK_RULE_VERSION_ID, json({ outputs: ['tracked_direct', 'guarded', 'deny'] }), startedAt);
      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at
        ) VALUES (?, 'guarded', 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, root, intent ?? null, caller.actor ?? 'unknown', caller.agent ?? null,
        caller.model ?? null, caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        RISK_RULE_VERSION_ID, startedAt,
      );
      this.db.prepare(`
        INSERT INTO change_sets(id, run_id, status, created_at)
        VALUES (?, ?, 'awaiting_execution', ?)
      `).run(actualChangeSetId, runId, startedAt);

      const artifactId = `ART-${crypto.randomUUID()}`;
      const beforeMaterialId = `MAT-${crypto.randomUUID()}`;
      const candidateMaterialId = `MAT-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO artifacts(id, origin_run_id, kind, current_path, created_at)
        VALUES (?, ?, 'file', ?, ?)
      `).run(artifactId, runId, targetPath, startedAt);
      const insertMaterial = this.db.prepare(`
        INSERT INTO materials(id, artifact_id, stage, content_hash, byte_size, blob_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertMaterial.run(
        beforeMaterialId,
        artifactId,
        'before',
        baseline.contentHash,
        baseline.byteSize,
        this.#storeBlobPath(baseline.blobPath),
        startedAt,
      );
      insertMaterial.run(
        candidateMaterialId,
        artifactId,
        'candidate',
        candidate.contentHash,
        candidate.byteSize,
        this.#storeBlobPath(candidate.blobPath),
        startedAt,
      );
      this.db.prepare(`
        INSERT INTO candidate_change_sets(
          id, run_id, version, operation, target_path, status, content_hash,
          diff_text, diff_hash, summary_json, created_at
        ) VALUES (?, ?, 1, 'update', ?, 'prepared', ?, ?, ?, ?, ?)
      `).run(
        candidateChangeSetId,
        runId,
        targetPath,
        candidate.contentHash,
        diffText,
        diffHash,
        json({ changed_files: 1, operation: 'update', target_path: targetPath }),
        startedAt,
      );
      this.db.prepare(`
        INSERT INTO guarded_operations(
          run_id, target_path, before_material_id, candidate_material_id, revised_from_run_id
        ) VALUES (?, ?, ?, ?, ?)
      `).run(runId, targetPath, beforeMaterialId, candidateMaterialId, revisedFromRunId ?? null);
      this.db.prepare(`
        INSERT INTO policy_decisions(id, run_id, rule_version_id, decision, reason, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `DEC-${crypto.randomUUID()}`,
        runId,
        RISK_RULE_VERSION_ID,
        risk.mode,
        risk.reasons.join(' '),
        json(risk),
        startedAt,
      );
      this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, subject_artifact_id, payload_json, created_at)
        VALUES (?, ?, 'guarded_target_baseline', ?, ?, ?)
      `).run(
        `OBS-${crypto.randomUUID()}`,
        runId,
        artifactId,
        json({ path: targetPath, content_hash: baseline.contentHash }),
        startedAt,
      );
      this.#insertEvent(runId, 'guarded_prepared', {
        candidate_change_set_id: candidateChangeSetId,
        target_path: targetPath,
        candidate_hash: candidate.contentHash,
        risk_mode: risk.mode,
      }, startedAt);
    });
    return { candidateChangeSetId, actualChangeSetId };
  }

  getGuardedDetail(runId) {
    const run = this.getRun(runId);
    if (run.mode !== 'guarded') throw new Error(`Run is not Guarded: ${runId}`);
    const candidate = this.db.prepare(`
      SELECT * FROM candidate_change_sets WHERE run_id = ?
    `).get(runId);
    const operation = this.db.prepare(`
      SELECT g.*, bm.content_hash AS before_hash, bm.byte_size AS before_byte_size,
             bm.blob_path AS before_blob_path,
             cm.content_hash AS candidate_hash, cm.byte_size AS candidate_byte_size,
             cm.blob_path AS candidate_blob_path
      FROM guarded_operations g
      JOIN materials bm ON bm.id = g.before_material_id
      JOIN materials cm ON cm.id = g.candidate_material_id
      WHERE g.run_id = ?
    `).get(runId);
    if (!candidate || !operation) throw new Error(`Guarded run is incomplete: ${runId}`);
    const decision = this.db.prepare(`
      SELECT decision, reason, details_json, created_at
      FROM policy_decisions WHERE run_id = ? ORDER BY rowid LIMIT 1
    `).get(runId);
    const policyDecisions = this.db.prepare(`
      SELECT id, rule_version_id, decision, reason, details_json, created_at
      FROM policy_decisions WHERE run_id = ? ORDER BY rowid
    `).all(runId).map((row) => ({
      id: row.id,
      rule_version_id: row.rule_version_id,
      decision: row.decision,
      reason: row.reason,
      details: parseJson(row.details_json, {}),
      created_at: row.created_at,
    }));
    const labels = this.db.prepare(`
      SELECT id, name, value, source, details_json, created_at
      FROM labels WHERE run_id = ? ORDER BY rowid
    `).all(runId).map((row) => ({
      ...row,
      details: parseJson(row.details_json, {}),
      details_json: undefined,
    }));
    const events = this.db.prepare(`
      SELECT event_type, payload_json, occurred_at
      FROM operation_events WHERE run_id = ? ORDER BY occurred_at, rowid
    `).all(runId).map((row) => ({
      type: row.event_type,
      payload: parseJson(row.payload_json, {}),
      occurred_at: row.occurred_at,
    }));
    return {
      run: {
        id: run.id,
        mode: run.mode,
        status: run.status,
        root_path: run.root_path,
        intent: run.intent,
        caller: {
          actor: run.actor,
          agent: run.agent,
          model: run.model,
          tool: run.tool,
          client_run_id: run.client_run_id,
        },
        rule_version_id: run.rule_version_id,
        started_at: run.started_at,
        rolled_back_at: run.rolled_back_at,
      },
      candidate: {
        id: candidate.id,
        version: candidate.version,
        operation: candidate.operation,
        target_path: candidate.target_path,
        status: candidate.status,
        content_hash: candidate.content_hash,
        byte_size: operation.candidate_byte_size,
        blob_path: this.#resolveBlobPath(operation.candidate_blob_path, operation.candidate_hash),
        diff_text: candidate.diff_text,
        diff_hash: candidate.diff_hash,
        summary: parseJson(candidate.summary_json, {}),
        created_at: candidate.created_at,
      },
      baseline: {
        content_hash: operation.before_hash,
        byte_size: operation.before_byte_size,
        blob_path: this.#resolveBlobPath(operation.before_blob_path, operation.before_hash),
      },
      risk: {
        mode: decision.decision,
        reason: decision.reason,
        ...parseJson(decision.details_json, {}),
        rule_version: this.getRuleVersion(run.rule_version_id),
        decided_at: decision.created_at,
      },
      policy_decisions: policyDecisions,
      approved_candidate_hash: operation.approved_candidate_hash,
      revised_from_run_id: operation.revised_from_run_id,
      labels,
      events,
      approval_receipt: parseJson(operation.approval_receipt_json),
      rejection_receipt: parseJson(operation.rejection_receipt_json),
      execution_receipt: parseJson(operation.execution_receipt_json),
      rollback_receipt: parseJson(run.rollback_receipt_json),
    };
  }

  reviewGuarded(runId, { decision, reason, reviewedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.mode !== 'guarded') throw new Error(`Run is not Guarded: ${runId}`);
      const operation = this.db.prepare(`
        SELECT approved_candidate_hash, approval_receipt_json, rejection_receipt_json
        FROM guarded_operations WHERE run_id = ?
      `).get(runId);
      const existing = decision === 'accepted'
        ? parseJson(operation.approval_receipt_json)
        : parseJson(operation.rejection_receipt_json);
      if (existing) return existing;
      if (run.status !== 'prepared') {
        throw new Error(`Guarded review requires prepared status; current status is ${run.status}.`);
      }
      const candidate = this.db.prepare(`
        SELECT id, content_hash FROM candidate_change_sets WHERE run_id = ?
      `).get(runId);
      const labelId = `LBL-${crypto.randomUUID()}`;
      const status = decision === 'accepted' ? 'approved' : 'rejected';
      const receipt = {
        run_id: runId,
        candidate_change_set_id: candidate.id,
        decision,
        reason,
        status,
        reviewed_at: reviewedAt,
      };
      this.db.prepare(`
        INSERT INTO labels(id, run_id, name, value, source, details_json, created_at)
        VALUES (?, ?, 'guarded_review', ?, 'user', ?, ?)
      `).run(labelId, runId, decision, json({ reason }), reviewedAt);
      this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId);
      this.db.prepare('UPDATE candidate_change_sets SET status = ? WHERE run_id = ?').run(status, runId);
      if (decision === 'accepted') {
        this.db.prepare(`
          UPDATE guarded_operations
          SET approved_candidate_hash = ?, approval_receipt_json = ? WHERE run_id = ?
        `).run(candidate.content_hash, json(receipt), runId);
      } else {
        this.db.prepare(`
          UPDATE guarded_operations SET rejection_receipt_json = ? WHERE run_id = ?
        `).run(json(receipt), runId);
      }
      this.#insertEvent(runId, `guarded_${status}`, receipt, reviewedAt);
      return receipt;
    });
  }

  markGuardedStale(runId, payload, occurredAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status === 'stale') return;
      if (run.status !== 'approved') {
        throw new Error(`Only an approved Guarded run can become stale; current status is ${run.status}.`);
      }
      this.db.prepare("UPDATE runs SET status = 'stale' WHERE id = ?").run(runId);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'stale' WHERE run_id = ?").run(runId);
      this.#insertEvent(runId, 'guarded_approval_invalidated', payload, occurredAt);
    });
  }

  finishGuardedExecution(runId, { receipt, executedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      const operation = this.db.prepare(`
        SELECT g.*, bm.content_hash AS before_hash, cm.content_hash AS candidate_hash
        FROM guarded_operations g
        JOIN materials bm ON bm.id = g.before_material_id
        JOIN materials cm ON cm.id = g.candidate_material_id
        WHERE g.run_id = ?
      `).get(runId);
      const existing = parseJson(operation.execution_receipt_json);
      if (existing) return existing;
      if (run.status !== 'approved') {
        throw new Error(`Guarded execution requires approval; current status is ${run.status}.`);
      }
      if (operation.approved_candidate_hash !== operation.candidate_hash) {
        throw new Error('Guarded approval no longer matches the Candidate ChangeSet.');
      }
      const candidate = this.db.prepare(`
        SELECT * FROM candidate_change_sets WHERE run_id = ?
      `).get(runId);
      const actual = this.db.prepare('SELECT id FROM change_sets WHERE run_id = ?').get(runId);
      this.db.prepare(`
        INSERT INTO changes(
          id, change_set_id, path, change_type, allowed,
          before_kind, before_hash, before_material_id,
          after_kind, after_hash, after_material_id
        ) VALUES (?, ?, ?, 'modified', 1, 'file', ?, ?, 'file', ?, ?)
      `).run(
        `DIF-${crypto.randomUUID()}`,
        actual.id,
        operation.target_path,
        operation.before_hash,
        operation.before_material_id,
        operation.candidate_hash,
        operation.candidate_material_id,
      );
      this.db.prepare(`
        UPDATE change_sets
        SET status = 'executed', diff_text = ?, diff_hash = ?, summary_json = ?, closed_at = ?
        WHERE id = ?
      `).run(candidate.diff_text, candidate.diff_hash, candidate.summary_json, executedAt, actual.id);
      this.db.prepare(`
        UPDATE candidate_change_sets SET status = 'executed' WHERE run_id = ?
      `).run(runId);
      this.db.prepare(`
        UPDATE guarded_operations
        SET execution_receipt_json = ?, executed_at = ? WHERE run_id = ?
      `).run(json(receipt), executedAt, runId);
      this.db.prepare(`
        UPDATE runs SET status = 'executed', closed_at = ?, receipt_json = ? WHERE id = ?
      `).run(executedAt, json(receipt), runId);
      this.#insertEvent(runId, 'guarded_executed_and_verified', receipt, executedAt);
      return receipt;
    });
  }

  markGuardedRevised(runId, revisedRunId, reason, revisedAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (!['prepared', 'approved'].includes(run.status)) {
        throw new Error(`Only a prepared or approved Guarded run can be revised; current status is ${run.status}.`);
      }
      const existing = this.db.prepare(`
        SELECT details_json FROM labels
        WHERE run_id = ? AND name = 'guarded_revision' ORDER BY rowid DESC LIMIT 1
      `).get(runId);
      if (existing) return parseJson(existing.details_json, {}).revised_run_id;
      this.db.prepare(`
        INSERT INTO labels(id, run_id, name, value, source, details_json, created_at)
        VALUES (?, ?, 'guarded_revision', 'corrected', 'user', ?, ?)
      `).run(
        `LBL-${crypto.randomUUID()}`,
        runId,
        json({ reason, revised_run_id: revisedRunId }),
        revisedAt,
      );
      this.db.prepare("UPDATE runs SET status = 'revised' WHERE id = ?").run(runId);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'revised' WHERE run_id = ?").run(runId);
      this.#insertEvent(runId, 'guarded_revised', { reason, revised_run_id: revisedRunId }, revisedAt);
      return revisedRunId;
    });
  }

  finishGuardedRollback(runId, receipt, rolledBackAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.rollback_receipt_json) return parseJson(run.rollback_receipt_json);
      if (run.status !== 'executed') {
        throw new Error(`Only an executed Guarded run can be rolled back; current status is ${run.status}.`);
      }
      this.db.prepare(`
        UPDATE runs
        SET status = 'rolled_back', rolled_back_at = ?, rollback_receipt_json = ? WHERE id = ?
      `).run(rolledBackAt, json(receipt), runId);
      this.db.prepare("UPDATE change_sets SET status = 'rolled_back' WHERE run_id = ?").run(runId);
      this.#insertEvent(runId, 'guarded_rollback_completed', receipt, rolledBackAt);
      return receipt;
    });
  }

  createDerivedRun({
    runId,
    root,
    targetPath,
    intent,
    inputs,
    candidate,
    project,
    role,
    relationType,
    predictionConfidence,
    diffText,
    diffHash,
    risk,
    placementPolicy,
    revisedFromRunId = null,
    caller = {},
    startedAt,
  }) {
    const candidateChangeSetId = `CAN-${crypto.randomUUID()}`;
    const actualChangeSetId = `CHG-${crypto.randomUUID()}`;
    const outputArtifactId = `ART-${crypto.randomUUID()}`;
    const candidateMaterialId = `MAT-${crypto.randomUUID()}`;
    const placementPredictionId = `PRD-${crypto.randomUUID()}`;
    this.transaction(() => {
      const effectiveRuleVersionId = placementPolicy?.rule_version_id ?? RISK_RULE_VERSION_ID;
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Deterministic V1 risk routing', '1.0.0', ?, ?)
      `).run(RISK_RULE_VERSION_ID, json({ outputs: ['tracked_direct', 'guarded', 'deny'] }), startedAt);
      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at
        ) VALUES (?, 'derived', 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, root, intent ?? null, caller.actor ?? 'unknown', caller.agent ?? null,
        caller.model ?? null, caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        effectiveRuleVersionId, startedAt,
      );
      this.db.prepare(`
        INSERT INTO change_sets(id, run_id, status, created_at)
        VALUES (?, ?, 'awaiting_execution', ?)
      `).run(actualChangeSetId, runId, startedAt);
      this.db.prepare(`
        INSERT INTO artifacts(
          id, origin_run_id, project_id, kind, current_path, root_path, role, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'file', ?, ?, ?, 'candidate', ?, ?)
      `).run(
        outputArtifactId, runId, project.id, targetPath, root, role, startedAt, startedAt,
      );
      this.db.prepare(`
        INSERT INTO materials(id, artifact_id, stage, content_hash, byte_size, blob_path, created_at)
        VALUES (?, ?, 'candidate', ?, ?, ?, ?)
      `).run(
        candidateMaterialId,
        outputArtifactId,
        candidate.contentHash,
        candidate.byteSize,
        this.#storeBlobPath(candidate.blobPath),
        startedAt,
      );
      this.db.prepare(`
        INSERT INTO candidate_change_sets(
          id, run_id, version, operation, target_path, status, content_hash,
          diff_text, diff_hash, summary_json, created_at
        ) VALUES (?, ?, 1, 'create', ?, 'prepared', ?, ?, ?, ?, ?)
      `).run(
        candidateChangeSetId,
        runId,
        targetPath,
        candidate.contentHash,
        diffText,
        diffHash,
        json({
          changed_files: 1,
          operation: 'create',
          target_path: targetPath,
          project_id: project.id,
          role,
          input_count: inputs.length,
          relation_type: relationType,
        }),
        startedAt,
      );

      const findArtifact = this.db.prepare(`
        SELECT id FROM artifacts
        WHERE root_path = ? AND current_path = ? AND status = 'active'
        ORDER BY CASE WHEN role IS NULL THEN 1 ELSE 0 END, updated_at DESC, rowid DESC
        LIMIT 1
      `);
      const insertArtifact = this.db.prepare(`
        INSERT INTO artifacts(
          id, origin_run_id, kind, current_path, root_path, role, status, created_at, updated_at
        ) VALUES (?, ?, 'file', ?, ?, 'source', 'active', ?, ?)
      `);
      const findMaterial = this.db.prepare(`
        SELECT id FROM materials WHERE artifact_id = ? AND content_hash = ?
        ORDER BY CASE stage WHEN 'output' THEN 0 WHEN 'input' THEN 1 ELSE 2 END, rowid DESC
        LIMIT 1
      `);
      const insertMaterial = this.db.prepare(`
        INSERT INTO materials(id, artifact_id, stage, content_hash, byte_size, blob_path, created_at)
        VALUES (?, ?, 'input', ?, ?, ?, ?)
      `);
      const insertInput = this.db.prepare(`
        INSERT INTO derived_inputs(
          run_id, ordinal, path, artifact_id, material_id, prepared_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertObservation = this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, subject_artifact_id, payload_json, created_at)
        VALUES (?, ?, 'derived_input_captured', ?, ?, ?)
      `);
      const inputRecords = [];
      inputs.forEach((input, ordinal) => {
        let artifact = findArtifact.get(root, input.path);
        if (!artifact) {
          artifact = { id: `ART-${crypto.randomUUID()}` };
          insertArtifact.run(artifact.id, runId, input.path, root, startedAt, startedAt);
        }
        let material = findMaterial.get(artifact.id, input.contentHash);
        if (!material) {
          material = { id: `MAT-${crypto.randomUUID()}` };
          insertMaterial.run(
            material.id,
            artifact.id,
            input.contentHash,
            input.byteSize,
            this.#storeBlobPath(input.blobPath),
            startedAt,
          );
        }
        insertInput.run(runId, ordinal, input.path, artifact.id, material.id, input.contentHash);
        insertObservation.run(
          `OBS-${crypto.randomUUID()}`,
          runId,
          artifact.id,
          json({ path: input.path, content_hash: input.contentHash, material_id: material.id }),
          startedAt,
        );
        inputRecords.push({ path: input.path, artifact_id: artifact.id, material_id: material.id });
      });

      const placementPrediction = {
        kind: 'placement_candidate',
        summary: `Create ${targetPath} as a ${role} Artifact in Project ${project.id}.`,
        confidence: predictionConfidence,
        risk: risk.risk === 'low' ? 'low' : 'medium',
        affected_paths: [...inputs.map((input) => input.path), targetPath],
        evidence: {
          project_id: project.id,
          project_name: project.name,
          project_path: project.current_path,
          target_path: targetPath,
          role,
          input_paths: inputs.map((input) => input.path),
          relation_type: relationType,
          policy: placementPolicy,
        },
        proposed_action: 'Create exactly the reviewed Candidate and register its input-to-output lineage.',
        requires_review: true,
        source: 'agent',
        proposed_by: {
          actor: caller.actor ?? 'unknown',
          agent: caller.agent ?? null,
          model: caller.model ?? null,
          tool: caller.tool ?? 'atlas-cli',
          client_run_id: caller.client_run_id ?? null,
        },
      };
      this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'placement_candidate', ?, ?)
      `).run(placementPredictionId, runId, json(placementPrediction), startedAt);
      this.db.prepare(`
        INSERT INTO derived_operations(
          run_id, target_path, project_id, role, relation_type,
          output_artifact_id, candidate_material_id, placement_prediction_id, revised_from_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        targetPath,
        project.id,
        role,
        relationType,
        outputArtifactId,
        candidateMaterialId,
        placementPredictionId,
        revisedFromRunId,
      );
      this.db.prepare(`
        INSERT INTO policy_decisions(id, run_id, rule_version_id, decision, reason, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `DEC-${crypto.randomUUID()}`,
        runId,
        effectiveRuleVersionId,
        risk.mode,
        placementPolicy?.decision === 'warn'
          ? `${risk.reasons.join(' ')} Placement warning: ${placementPolicy.reason}`
          : risk.reasons.join(' '),
        json({ ...risk, placement_policy: placementPolicy, risk_rule_version_id: RISK_RULE_VERSION_ID }),
        startedAt,
      );
      this.#insertEvent(runId, 'derived_prepared', {
        candidate_change_set_id: candidateChangeSetId,
        placement_prediction_id: placementPredictionId,
        target_path: targetPath,
        project_id: project.id,
        role,
        relation_type: relationType,
        inputs: inputRecords,
        candidate_hash: candidate.contentHash,
      }, startedAt);
    });
    return {
      candidateChangeSetId,
      actualChangeSetId,
      outputArtifactId,
      candidateMaterialId,
      placementPredictionId,
    };
  }

  getDerivedDetail(runId) {
    const run = this.getRun(runId);
    if (run.mode !== 'derived') throw new Error(`Run is not Derived: ${runId}`);
    const candidate = this.db.prepare(`
      SELECT * FROM candidate_change_sets WHERE run_id = ?
    `).get(runId);
    const operation = this.db.prepare(`
      SELECT d.*, p.name AS project_name, p.current_path AS project_path,
             cm.content_hash AS candidate_hash, cm.byte_size AS candidate_byte_size,
             cm.blob_path AS candidate_blob_path,
             om.content_hash AS output_hash, om.byte_size AS output_byte_size,
             om.blob_path AS output_blob_path,
             oa.role AS output_current_role, oa.status AS output_artifact_status
      FROM derived_operations d
      JOIN projects p ON p.id = d.project_id
      JOIN artifacts oa ON oa.id = d.output_artifact_id
      JOIN materials cm ON cm.id = d.candidate_material_id
      LEFT JOIN materials om ON om.id = d.output_material_id
      WHERE d.run_id = ?
    `).get(runId);
    if (!candidate || !operation) throw new Error(`Derived run is incomplete: ${runId}`);
    const inputs = this.db.prepare(`
      SELECT di.ordinal, di.path, di.artifact_id, di.material_id,
             di.prepared_hash AS content_hash, m.byte_size, m.blob_path,
             a.role AS artifact_role
      FROM derived_inputs di
      JOIN materials m ON m.id = di.material_id
      JOIN artifacts a ON a.id = di.artifact_id
      WHERE di.run_id = ? ORDER BY di.ordinal
    `).all(runId).map((item) => ({
      ...item,
      blob_path: this.#resolveBlobPath(item.blob_path, item.content_hash),
    }));
    const predictionRow = this.db.prepare(`
      SELECT id, kind, payload_json, created_at FROM predictions WHERE id = ?
    `).get(operation.placement_prediction_id);
    const reviewRow = this.db.prepare(`
      SELECT id, value, source, details_json, created_at
      FROM labels WHERE subject_prediction_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(operation.placement_prediction_id);
    const placementPrediction = {
      id: predictionRow.id,
      kind: predictionRow.kind,
      ...parseJson(predictionRow.payload_json, {}),
      created_at: predictionRow.created_at,
      review: reviewRow ? {
        id: reviewRow.id,
        decision: reviewRow.value,
        source: reviewRow.source,
        reason: parseJson(reviewRow.details_json, {}).reason ?? null,
        reviewed_at: reviewRow.created_at,
      } : null,
    };
    const decision = this.db.prepare(`
      SELECT decision, reason, details_json, created_at
      FROM policy_decisions WHERE run_id = ? ORDER BY rowid LIMIT 1
    `).get(runId);
    const derivedPolicyDecisions = this.db.prepare(`
      SELECT id, rule_version_id, decision, reason, details_json, created_at
      FROM policy_decisions WHERE run_id = ? ORDER BY rowid
    `).all(runId).map((row) => ({
      id: row.id,
      rule_version_id: row.rule_version_id,
      decision: row.decision,
      reason: row.reason,
      details: parseJson(row.details_json, {}),
      created_at: row.created_at,
    }));
    const events = this.db.prepare(`
      SELECT event_type, payload_json, occurred_at
      FROM operation_events WHERE run_id = ? ORDER BY occurred_at, rowid
    `).all(runId).map((row) => ({
      type: row.event_type,
      payload: parseJson(row.payload_json, {}),
      occurred_at: row.occurred_at,
    }));
    const lineage = operation.output_material_id ? this.db.prepare(`
      SELECT output_material_id, input_material_id, run_id, relation_type, ordinal, created_at
      FROM material_derivations WHERE output_material_id = ? ORDER BY ordinal
    `).all(operation.output_material_id) : [];
    return {
      run: {
        id: run.id,
        mode: run.mode,
        status: run.status,
        root_path: run.root_path,
        intent: run.intent,
        caller: {
          actor: run.actor,
          agent: run.agent,
          model: run.model,
          tool: run.tool,
          client_run_id: run.client_run_id,
        },
        rule_version_id: run.rule_version_id,
        started_at: run.started_at,
        rolled_back_at: run.rolled_back_at,
      },
      placement: {
        project_id: operation.project_id,
        project_name: operation.project_name,
        project_path: operation.project_path,
        target_path: operation.target_path,
        role: operation.role,
        relation_type: operation.relation_type,
        policy: placementPrediction.evidence?.policy ?? null,
        revised_from_run_id: operation.revised_from_run_id,
      },
      placement_prediction: placementPrediction,
      candidate: {
        id: candidate.id,
        version: candidate.version,
        operation: candidate.operation,
        target_path: candidate.target_path,
        status: candidate.status,
        content_hash: operation.candidate_hash,
        byte_size: operation.candidate_byte_size,
        blob_path: this.#resolveBlobPath(operation.candidate_blob_path, operation.candidate_hash),
        diff_text: candidate.diff_text,
        diff_hash: candidate.diff_hash,
        summary: parseJson(candidate.summary_json, {}),
        created_at: candidate.created_at,
      },
      inputs,
      output: operation.output_material_id ? {
        artifact_id: operation.output_artifact_id,
        material_id: operation.output_material_id,
        project_id: operation.project_id,
        role: operation.output_current_role,
        original_role: operation.role,
        artifact_status: operation.output_artifact_status,
        target_path: operation.target_path,
        content_hash: operation.output_hash,
        byte_size: operation.output_byte_size,
        blob_path: this.#resolveBlobPath(operation.output_blob_path, operation.output_hash),
      } : null,
      lineage,
      risk: {
        mode: decision.decision,
        reason: decision.reason,
        ...parseJson(decision.details_json, {}),
        rule_version: this.getRuleVersion(run.rule_version_id),
        decided_at: decision.created_at,
      },
      policy_decisions: derivedPolicyDecisions,
      approved_candidate_hash: operation.approved_candidate_hash,
      events,
      approval_receipt: parseJson(operation.approval_receipt_json),
      rejection_receipt: parseJson(operation.rejection_receipt_json),
      execution_receipt: parseJson(operation.execution_receipt_json),
      rollback_receipt: parseJson(run.rollback_receipt_json),
    };
  }

  reviewDerived(runId, { decision, reason, reviewedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.mode !== 'derived') throw new Error(`Run is not Derived: ${runId}`);
      const operation = this.db.prepare(`
        SELECT placement_prediction_id, approved_candidate_hash,
               approval_receipt_json, rejection_receipt_json
        FROM derived_operations WHERE run_id = ?
      `).get(runId);
      const existing = decision === 'accepted'
        ? parseJson(operation.approval_receipt_json)
        : parseJson(operation.rejection_receipt_json);
      if (existing) return existing;
      if (run.status !== 'prepared') {
        throw new Error(`Derived review requires prepared status; current status is ${run.status}.`);
      }
      const candidate = this.db.prepare(`
        SELECT id, content_hash FROM candidate_change_sets WHERE run_id = ?
      `).get(runId);
      const status = decision === 'accepted' ? 'approved' : 'rejected';
      const receipt = {
        run_id: runId,
        candidate_change_set_id: candidate.id,
        placement_prediction_id: operation.placement_prediction_id,
        decision,
        reason,
        status,
        reviewed_at: reviewedAt,
      };
      this.db.prepare(`
        INSERT INTO labels(
          id, run_id, subject_prediction_id, name, value, source, details_json, created_at
        ) VALUES (?, ?, ?, 'derived_placement_review', ?, 'user', ?, ?)
      `).run(
        `LBL-${crypto.randomUUID()}`,
        runId,
        operation.placement_prediction_id,
        decision,
        json({ reason }),
        reviewedAt,
      );
      this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId);
      this.db.prepare('UPDATE candidate_change_sets SET status = ? WHERE run_id = ?').run(status, runId);
      if (decision === 'accepted') {
        this.db.prepare(`
          UPDATE derived_operations
          SET approved_candidate_hash = ?, approval_receipt_json = ? WHERE run_id = ?
        `).run(candidate.content_hash, json(receipt), runId);
      } else {
        this.db.prepare(`
          UPDATE derived_operations SET rejection_receipt_json = ? WHERE run_id = ?
        `).run(json(receipt), runId);
      }
      this.#insertEvent(runId, `derived_${status}`, receipt, reviewedAt);
      return receipt;
    });
  }

  markDerivedRevised(runId, revisedRunId, reason, revisedAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (!['prepared', 'approved', 'rejected', 'stale'].includes(run.status)) {
        throw new Error(`Derived run cannot be revised from status ${run.status}.`);
      }
      const existing = this.db.prepare(`
        SELECT details_json FROM labels
        WHERE run_id = ? AND name = 'derived_revision' ORDER BY rowid DESC LIMIT 1
      `).get(runId);
      if (existing) return parseJson(existing.details_json, {}).revised_run_id;
      this.db.prepare(`
        INSERT INTO labels(id, run_id, name, value, source, details_json, created_at)
        VALUES (?, ?, 'derived_revision', 'corrected', 'user', ?, ?)
      `).run(
        `LBL-${crypto.randomUUID()}`,
        runId,
        json({ reason, revised_run_id: revisedRunId }),
        revisedAt,
      );
      this.db.prepare("UPDATE runs SET status = 'revised' WHERE id = ?").run(runId);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'revised' WHERE run_id = ?").run(runId);
      this.#insertEvent(runId, 'derived_revised', { reason, revised_run_id: revisedRunId }, revisedAt);
      return revisedRunId;
    });
  }

  promoteDerivedArtifact(runId, { fromRole, toRole, reason, promotedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'executed') {
        throw new Error(`Derived role promotion requires executed status; current status is ${run.status}.`);
      }
      const operation = this.db.prepare(`
        SELECT d.output_artifact_id, d.output_material_id, a.role AS current_role, a.current_path
        FROM derived_operations d JOIN artifacts a ON a.id = d.output_artifact_id
        WHERE d.run_id = ?
      `).get(runId);
      if (!operation?.output_material_id) throw new Error(`Derived output is incomplete: ${runId}`);
      if (operation.current_role === toRole) {
        const existing = this.db.prepare(`
          SELECT payload_json FROM operation_events
          WHERE run_id = ? AND event_type = 'derived_role_promoted'
          ORDER BY rowid DESC LIMIT 1
        `).get(runId);
        if (existing) return parseJson(existing.payload_json, {});
        return {
          run_id: runId,
          artifact_id: operation.output_artifact_id,
          material_id: operation.output_material_id,
          path: operation.current_path,
          from_role: fromRole,
          to_role: toRole,
          status: 'unchanged',
          content_changed: false,
          reason,
        };
      }
      if (operation.current_role !== fromRole) {
        throw new Error(`Derived Artifact role changed from ${fromRole} to ${operation.current_role}; review current state.`);
      }
      const predictionId = `PRD-${crypto.randomUUID()}`;
      const labelId = `LBL-${crypto.randomUUID()}`;
      const decisionId = `DEC-${crypto.randomUUID()}`;
      const prediction = {
        kind: 'role_transition_candidate',
        summary: `Promote ${operation.current_path} from ${fromRole} to ${toRole}.`,
        confidence: 1,
        risk: 'low',
        affected_paths: [operation.current_path],
        evidence: {
          artifact_id: operation.output_artifact_id,
          material_id: operation.output_material_id,
          from_role: fromRole,
          to_role: toRole,
          content_changed: false,
        },
        proposed_action: 'Change only the Artifact role while preserving its path, Material, and lineage.',
        requires_review: true,
        source: 'user_command',
      };
      this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'role_transition_candidate', ?, ?)
      `).run(predictionId, runId, json(prediction), promotedAt);
      this.db.prepare(`
        INSERT INTO labels(id, run_id, subject_prediction_id, name, value, source, details_json, created_at)
        VALUES (?, ?, ?, 'derived_role_review', 'accepted', 'user', ?, ?)
      `).run(labelId, runId, predictionId, json({ reason }), promotedAt);
      this.db.prepare(`
        INSERT INTO policy_decisions(id, run_id, rule_version_id, decision, reason, details_json, created_at)
        VALUES (?, ?, ?, 'allow', ?, ?, ?)
      `).run(
        decisionId,
        runId,
        run.rule_version_id,
        `The requested role transition ${fromRole} → ${toRole} is allowed by the V1 role ontology.`,
        json({ from_role: fromRole, to_role: toRole, content_changed: false }),
        promotedAt,
      );
      this.db.prepare(`
        UPDATE artifacts SET role = ?, updated_at = ? WHERE id = ?
      `).run(toRole, promotedAt, operation.output_artifact_id);
      const receipt = {
        run_id: runId,
        artifact_id: operation.output_artifact_id,
        material_id: operation.output_material_id,
        path: operation.current_path,
        from_role: fromRole,
        to_role: toRole,
        content_changed: false,
        prediction_id: predictionId,
        label_id: labelId,
        policy_decision_id: decisionId,
        reason,
        promoted_at: promotedAt,
      };
      this.#insertEvent(runId, 'derived_role_promoted', receipt, promotedAt);
      return receipt;
    });
  }

  getDerivedConsumers(runId) {
    const operation = this.db.prepare(`
      SELECT output_material_id FROM derived_operations WHERE run_id = ?
    `).get(runId);
    if (!operation?.output_material_id) return [];
    return this.db.prepare(`
      SELECT DISTINCT di.run_id, r.status, r.started_at
      FROM derived_inputs di JOIN runs r ON r.id = di.run_id
      WHERE di.material_id = ? AND di.run_id <> ?
        AND r.status NOT IN ('rolled_back', 'rejected', 'revised')
      ORDER BY r.started_at, di.run_id
    `).all(operation.output_material_id, runId);
  }

  markDerivedStale(runId, payload, occurredAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status === 'stale') return;
      if (run.status !== 'approved') {
        throw new Error(`Only an approved Derived run can become stale; current status is ${run.status}.`);
      }
      this.db.prepare("UPDATE runs SET status = 'stale' WHERE id = ?").run(runId);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'stale' WHERE run_id = ?").run(runId);
      this.#insertEvent(runId, 'derived_approval_invalidated', payload, occurredAt);
    });
  }

  startDerivedExecution(runId, occurredAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'approved') {
        throw new Error(`Derived execution requires approval; current status is ${run.status}.`);
      }
      const existing = this.db.prepare(`
        SELECT occurred_at FROM operation_events
        WHERE run_id = ? AND event_type = 'derived_execution_started'
        ORDER BY rowid DESC LIMIT 1
      `).get(runId);
      if (existing) return { run_id: runId, status: 'execution_started', started_at: existing.occurred_at };
      const receipt = { run_id: runId, status: 'execution_started', started_at: occurredAt };
      this.#insertEvent(runId, 'derived_execution_started', receipt, occurredAt);
      return receipt;
    });
  }

  finishDerivedExecution(runId, { receipt, executedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      const operation = this.db.prepare(`
        SELECT d.*, cm.content_hash AS candidate_hash, cm.byte_size AS candidate_byte_size,
               cm.blob_path AS candidate_blob_path
        FROM derived_operations d
        JOIN materials cm ON cm.id = d.candidate_material_id
        WHERE d.run_id = ?
      `).get(runId);
      const existing = parseJson(operation.execution_receipt_json);
      if (existing) return existing;
      if (run.status !== 'approved') {
        throw new Error(`Derived execution requires approval; current status is ${run.status}.`);
      }
      if (operation.approved_candidate_hash !== operation.candidate_hash) {
        throw new Error('Derived approval no longer matches the Candidate ChangeSet.');
      }
      const candidate = this.db.prepare(`
        SELECT * FROM candidate_change_sets WHERE run_id = ?
      `).get(runId);
      const actual = this.db.prepare('SELECT id FROM change_sets WHERE run_id = ?').get(runId);
      const outputMaterialId = `MAT-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO materials(id, artifact_id, stage, content_hash, byte_size, blob_path, created_at)
        VALUES (?, ?, 'output', ?, ?, ?, ?)
      `).run(
        outputMaterialId,
        operation.output_artifact_id,
        operation.candidate_hash,
        operation.candidate_byte_size,
        operation.candidate_blob_path,
        executedAt,
      );
      const inputs = this.db.prepare(`
        SELECT material_id, ordinal FROM derived_inputs WHERE run_id = ? ORDER BY ordinal
      `).all(runId);
      const insertDerivation = this.db.prepare(`
        INSERT INTO material_derivations(
          output_material_id, input_material_id, run_id, relation_type, ordinal, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const input of inputs) {
        insertDerivation.run(
          outputMaterialId,
          input.material_id,
          runId,
          operation.relation_type,
          input.ordinal,
          executedAt,
        );
      }
      this.db.prepare(`
        INSERT INTO changes(
          id, change_set_id, path, change_type, allowed,
          before_kind, before_hash, before_material_id,
          after_kind, after_hash, after_material_id
        ) VALUES (?, ?, ?, 'added', 1, NULL, NULL, NULL, 'file', ?, ?)
      `).run(
        `DIF-${crypto.randomUUID()}`,
        actual.id,
        operation.target_path,
        operation.candidate_hash,
        outputMaterialId,
      );
      this.db.prepare(`
        UPDATE change_sets
        SET status = 'executed', diff_text = ?, diff_hash = ?, summary_json = ?, closed_at = ?
        WHERE id = ?
      `).run(candidate.diff_text, candidate.diff_hash, candidate.summary_json, executedAt, actual.id);
      this.db.prepare(`
        UPDATE candidate_change_sets SET status = 'executed' WHERE run_id = ?
      `).run(runId);
      const finalReceipt = {
        ...receipt,
        artifact_id: operation.output_artifact_id,
        material_id: outputMaterialId,
      };
      this.db.prepare(`
        UPDATE derived_operations
        SET output_material_id = ?, execution_receipt_json = ?, executed_at = ? WHERE run_id = ?
      `).run(outputMaterialId, json(finalReceipt), executedAt, runId);
      this.db.prepare(`
        UPDATE artifacts SET status = 'active', updated_at = ? WHERE id = ?
      `).run(executedAt, operation.output_artifact_id);
      this.db.prepare(`
        UPDATE runs SET status = 'executed', closed_at = ?, receipt_json = ? WHERE id = ?
      `).run(executedAt, json(finalReceipt), runId);
      this.#insertEvent(runId, 'derived_created_and_verified', finalReceipt, executedAt);
      return finalReceipt;
    });
  }

  startDerivedRollback(runId, occurredAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'executed') {
        throw new Error(`Only an executed Derived run can be rolled back; current status is ${run.status}.`);
      }
      const existing = this.db.prepare(`
        SELECT occurred_at FROM operation_events
        WHERE run_id = ? AND event_type = 'derived_rollback_started'
        ORDER BY rowid DESC LIMIT 1
      `).get(runId);
      if (existing) return { run_id: runId, status: 'rollback_started', started_at: existing.occurred_at };
      const receipt = { run_id: runId, status: 'rollback_started', started_at: occurredAt };
      this.#insertEvent(runId, 'derived_rollback_started', receipt, occurredAt);
      return receipt;
    });
  }

  finishDerivedRollback(runId, receipt, rolledBackAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.rollback_receipt_json) return parseJson(run.rollback_receipt_json);
      if (run.status !== 'executed') {
        throw new Error(`Only an executed Derived run can be rolled back; current status is ${run.status}.`);
      }
      const operation = this.db.prepare(`
        SELECT output_artifact_id FROM derived_operations WHERE run_id = ?
      `).get(runId);
      this.db.prepare(`
        UPDATE runs
        SET status = 'rolled_back', rolled_back_at = ?, rollback_receipt_json = ? WHERE id = ?
      `).run(rolledBackAt, json(receipt), runId);
      this.db.prepare("UPDATE change_sets SET status = 'rolled_back' WHERE run_id = ?").run(runId);
      this.db.prepare(`
        UPDATE artifacts SET status = 'rolled_back', updated_at = ? WHERE id = ?
      `).run(rolledBackAt, operation.output_artifact_id);
      this.#insertEvent(runId, 'derived_rollback_completed', receipt, rolledBackAt);
      return receipt;
    });
  }

  createBootstrapScan({ runId, root, fingerprint, entries, predictions, summary, receipt, caller = {}, startedAt }) {
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        BOOTSTRAP_RULE_VERSION_ID,
        'Bootstrap environment inference policy',
        '2.0.0',
        json({
          sources: ['deterministic_scan', 'reviewed_agent_prediction'],
          review_required: true,
          source_changes_forbidden_during_initialize: true,
        }),
        startedAt,
      );
      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at, receipt_json
        ) VALUES (?, 'bootstrap', 'scanned', ?, 'Recognize the existing environment', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, root, caller.actor ?? 'unknown', caller.agent ?? null, caller.model ?? null,
        caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        BOOTSTRAP_RULE_VERSION_ID, startedAt, json(receipt),
      );
      this.db.prepare(`
        INSERT INTO environment_scans(run_id, fingerprint, summary_json)
        VALUES (?, ?, ?)
      `).run(runId, fingerprint, json(summary));

      const insertEntry = this.db.prepare(`
        INSERT INTO environment_entries(
          run_id, path, entry_kind, extension, byte_size, modified_at, content_hash, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertObservation = this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        insertEntry.run(
          runId,
          entry.path,
          entry.kind,
          entry.extension ?? null,
          entry.byteSize,
          entry.modifiedAt,
          entry.contentHash ?? null,
          json(entry.metadata ?? {}),
        );
        insertObservation.run(
          `OBS-${crypto.randomUUID()}`,
          runId,
          'environment_entry_observed',
          json(entry),
          startedAt,
        );
      }
      insertObservation.run(
        `OBS-${crypto.randomUUID()}`,
        runId,
        'environment_scan_completed',
        json(summary),
        startedAt,
      );

      const insertPrediction = this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const prediction of predictions) {
        insertPrediction.run(
          `PRD-${crypto.randomUUID()}`,
          runId,
          prediction.kind,
          json(prediction),
          startedAt,
        );
      }
      this.#insertEvent(runId, 'bootstrap_scan_completed', receipt, startedAt);
    });
  }

  addBootstrapProposal({ runId, sourceHash, predictions, caller = {}, createdAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.mode !== 'bootstrap') throw new Error(`Run is not a Bootstrap scan: ${runId}`);
      if (run.status === 'initialized') {
        throw new Error('Bootstrap Predictions cannot be added after Initialize; create a new scan first.');
      }
      const existing = this.db.prepare(`
        SELECT id, prediction_count, created_at
        FROM bootstrap_proposals WHERE run_id = ? AND source_hash = ?
      `).get(runId, sourceHash);
      if (existing) {
        const predictionIds = this.db.prepare(`
          SELECT prediction_id FROM bootstrap_proposal_predictions
          WHERE proposal_id = ? ORDER BY ordinal
        `).all(existing.id).map((row) => row.prediction_id);
        return {
          proposal_id: existing.id,
          scan_id: runId,
          prediction_ids: predictionIds,
          predictions: Number(existing.prediction_count),
          reused: true,
          proposed_at: existing.created_at,
        };
      }

      const proposalId = `BPR-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO bootstrap_proposals(
          id, run_id, source_hash, actor, agent, model, tool, client_run_id,
          prediction_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        proposalId,
        runId,
        sourceHash,
        caller.actor ?? 'agent',
        caller.agent ?? null,
        caller.model ?? null,
        caller.tool ?? 'atlas-cli',
        caller.client_run_id ?? null,
        predictions.length,
        createdAt,
      );
      const insertPrediction = this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const linkPrediction = this.db.prepare(`
        INSERT INTO bootstrap_proposal_predictions(proposal_id, prediction_id, ordinal)
        VALUES (?, ?, ?)
      `);
      const predictionIds = [];
      predictions.forEach((prediction, ordinal) => {
        const predictionId = `PRD-${crypto.randomUUID()}`;
        predictionIds.push(predictionId);
        insertPrediction.run(
          predictionId,
          runId,
          prediction.kind,
          json({ ...prediction, proposal_id: proposalId }),
          createdAt,
        );
        linkPrediction.run(proposalId, predictionId, ordinal);
      });

      const scan = this.db.prepare(`
        SELECT summary_json FROM environment_scans WHERE run_id = ?
      `).get(runId);
      const summary = parseJson(scan.summary_json, {});
      const predictionCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM predictions WHERE run_id = ?
      `).get(runId).count;
      summary.predictions = Number(predictionCount);
      summary.agent_predictions = Number(
        this.db.prepare(`
          SELECT COUNT(*) AS count FROM bootstrap_proposal_predictions bpp
          JOIN predictions p ON p.id = bpp.prediction_id
          WHERE p.run_id = ? AND json_extract(p.payload_json, '$.source') = 'agent'
        `).get(runId).count,
      );
      this.db.prepare(`
        UPDATE environment_scans SET summary_json = ? WHERE run_id = ?
      `).run(json(summary), runId);
      const previousReceipt = parseJson(run.receipt_json, {});
      this.db.prepare(`
        UPDATE runs SET status = 'scanned', receipt_json = ? WHERE id = ?
      `).run(json({ ...previousReceipt, predictions: Number(predictionCount) }), runId);

      const receipt = {
        proposal_id: proposalId,
        scan_id: runId,
        prediction_ids: predictionIds,
        predictions: predictions.length,
        reused: false,
        proposed_at: createdAt,
      };
      this.#insertEvent(
        runId,
        caller.actor === 'atlas' ? 'bootstrap_default_profile_predictions_added' : 'bootstrap_agent_predictions_added',
        {
          proposal_id: proposalId,
          source_hash: sourceHash,
          prediction_count: predictions.length,
          proposed_by: {
            actor: caller.actor ?? 'agent',
            agent: caller.agent ?? null,
            model: caller.model ?? null,
            tool: caller.tool ?? 'atlas-cli',
            client_run_id: caller.client_run_id ?? null,
          },
        },
        createdAt,
      );
      return receipt;
    });
  }

  createProject({ projectId, name, currentPath, aliases, status, parentProjectId, splitFrom, createdAt }) {
    return this.transaction(() => {
      if (this.db.prepare(`
        SELECT id FROM projects WHERE current_path = ? AND status = 'active'
      `).get(currentPath)) {
        throw new Error(`An active Project already uses path: ${currentPath}`);
      }
      if (parentProjectId) this.getProject(parentProjectId);
      for (const sourceId of splitFrom) this.getProject(sourceId);
      this.db.prepare(`
        INSERT INTO projects(
          id, name, current_path, status, parent_project_id, lineage_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        name,
        currentPath,
        status,
        parentProjectId ?? null,
        json({ split_from: splitFrom }),
        createdAt,
        createdAt,
      );
      this.db.prepare(`
        INSERT INTO project_path_history(project_id, path, valid_from) VALUES (?, ?, ?)
      `).run(projectId, currentPath, createdAt);
      const insertAlias = this.db.prepare(`
        INSERT OR IGNORE INTO project_aliases(project_id, alias, created_at) VALUES (?, ?, ?)
      `);
      for (const alias of aliases) insertAlias.run(projectId, alias, createdAt);
      if (parentProjectId) {
        this.#insertProjectRelation(projectId, 'parent', parentProjectId, createdAt, {});
      }
      for (const sourceId of splitFrom) {
        this.#insertProjectRelation(projectId, 'split_from', sourceId, createdAt, {});
      }
      return this.getProjectDetail(projectId);
    });
  }

  updateProject(projectId, { name, currentPath, aliases, status, reason, updatedAt }) {
    return this.transaction(() => {
      const project = this.getProject(projectId);
      if (currentPath !== project.current_path) {
        const collision = this.db.prepare(`
          SELECT id FROM projects WHERE current_path = ? AND status = 'active' AND id <> ?
        `).get(currentPath, projectId);
        if (collision) throw new Error(`An active Project already uses path: ${currentPath}`);
        this.db.prepare(`
          UPDATE project_path_history SET valid_to = ?, reason = ?
          WHERE project_id = ? AND valid_to IS NULL
        `).run(updatedAt, reason ?? null, projectId);
        this.db.prepare(`
          INSERT INTO project_path_history(project_id, path, valid_from, reason)
          VALUES (?, ?, ?, ?)
        `).run(projectId, currentPath, updatedAt, reason ?? null);
      }
      this.db.prepare(`
        UPDATE projects
        SET name = ?, current_path = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(name, currentPath, status, updatedAt, projectId);
      const insertAlias = this.db.prepare(`
        INSERT OR IGNORE INTO project_aliases(project_id, alias, created_at) VALUES (?, ?, ?)
      `);
      for (const alias of aliases) insertAlias.run(projectId, alias, updatedAt);
      return this.getProjectDetail(projectId);
    });
  }

  mergeProjects(sourceIds, targetId, effectiveAt) {
    return this.transaction(() => {
      this.getProject(targetId);
      for (const sourceId of sourceIds) {
        if (sourceId === targetId) throw new Error('A Project cannot be merged into itself.');
        this.getProject(sourceId);
        this.db.prepare(`
          UPDATE projects SET status = 'merged', updated_at = ? WHERE id = ?
        `).run(effectiveAt, sourceId);
        this.#insertProjectRelation(sourceId, 'merged_into', targetId, effectiveAt, {});
      }
      return sourceIds.map((sourceId) => this.getProjectDetail(sourceId));
    });
  }

  #insertProjectRelation(sourceId, relationType, targetId, effectiveAt, details) {
    this.db.prepare(`
      INSERT OR IGNORE INTO project_relations(
        id, source_project_id, relation_type, target_project_id, effective_at, details_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `REL-${crypto.randomUUID()}`,
      sourceId,
      relationType,
      targetId,
      effectiveAt,
      json(details),
    );
  }

  getProject(projectId) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  getProjectDetail(projectId) {
    const project = this.getProject(projectId);
    const aliases = this.db.prepare(`
      SELECT alias FROM project_aliases WHERE project_id = ? ORDER BY rowid
    `).all(projectId).map((row) => row.alias);
    const paths = this.db.prepare(`
      SELECT path, valid_from, valid_to, reason
      FROM project_path_history WHERE project_id = ? ORDER BY id
    `).all(projectId);
    const relations = this.db.prepare(`
      SELECT relation_type, target_project_id, effective_at, details_json
      FROM project_relations WHERE source_project_id = ? ORDER BY rowid
    `).all(projectId).map((row) => ({
      ...row,
      details: parseJson(row.details_json, {}),
      details_json: undefined,
    }));
    return { project, aliases, paths, relations };
  }

  listProjects() {
    return this.db.prepare(`
      SELECT id, name, current_path, status, parent_project_id, created_at, updated_at
      FROM projects ORDER BY created_at, id
    `).all();
  }

  ensureProjectFromBootstrapPrediction(predictionId, createdAt) {
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT project_id FROM project_sources WHERE prediction_id = ?
      `).get(predictionId);
      if (existing) return this.getProjectDetail(existing.project_id);
      const prediction = this.db.prepare(`
        SELECT id, run_id, kind, payload_json FROM predictions WHERE id = ?
      `).get(predictionId);
      if (!prediction || prediction.kind !== 'project_candidate') {
        throw new Error(`Bootstrap Project Prediction not found: ${predictionId}`);
      }
      const review = this.db.prepare(`
        SELECT value FROM labels
        WHERE subject_prediction_id = ? ORDER BY rowid DESC LIMIT 1
      `).get(predictionId);
      if (review?.value !== 'accepted') {
        throw new Error(`Project Prediction must be accepted before Registry initialization: ${predictionId}`);
      }
      const payload = parseJson(prediction.payload_json, {});
      const currentPath = payload.evidence?.directory;
      if (!currentPath) throw new Error(`Project Prediction has no directory evidence: ${predictionId}`);
      let project = this.db.prepare(`
        SELECT id FROM projects WHERE current_path = ? AND status = 'active'
      `).get(currentPath);
      if (!project) {
        const id = `PRJ-${crypto.randomUUID()}`;
        this.db.prepare(`
          INSERT INTO projects(
            id, name, current_path, status, lineage_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, ?, ?)
        `).run(id, path.posix.basename(currentPath), currentPath, json({ bootstrap_prediction_id: predictionId }), createdAt, createdAt);
        this.db.prepare(`
          INSERT INTO project_path_history(project_id, path, valid_from, reason)
          VALUES (?, ?, ?, 'Accepted Bootstrap Prediction')
        `).run(id, currentPath, createdAt);
        project = { id };
      }
      this.db.prepare(`
        INSERT INTO project_sources(project_id, prediction_id, scan_run_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(project.id, predictionId, prediction.run_id, createdAt);
      return this.getProjectDetail(project.id);
    });
  }

  findBootstrapScan(root, fingerprint) {
    return this.db.prepare(`
      SELECT r.id
      FROM runs r
      JOIN environment_scans e ON e.run_id = r.id
      WHERE r.mode = 'bootstrap' AND r.root_path = ? AND e.fingerprint = ?
      ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
    `).get(root, fingerprint) ?? null;
  }

  activateEnvironmentPolicy({ runId, root, policy, activatedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.mode !== 'bootstrap') throw new Error(`Run is not a Bootstrap scan: ${runId}`);
      const existing = this.db.prepare(`
        SELECT id, root_path, scan_run_id, rule_version_id, policy_json, status, activated_at, deactivated_at
        FROM environment_policies WHERE scan_run_id = ?
      `).get(runId);
      if (existing) {
        const existingPolicy = parseJson(existing.policy_json, {});
        return {
          ...existing,
          profile_id: existingPolicy.profile_id ?? null,
          profile_version: existingPolicy.profile_version ?? null,
          policy: existingPolicy,
          policy_json: undefined,
        };
      }
      const normalizedRoot = path.resolve(root);
      if (normalizedRoot !== path.resolve(run.root_path)) {
        throw new Error('Environment policy root must match its Bootstrap scan root.');
      }
      const definition = structuredClone(policy);
      const definitionJson = json(definition);
      const ruleVersionId = `RULE-ENV-${crypto.createHash('sha256').update(definitionJson).digest('hex').slice(0, 16).toUpperCase()}`;
      const policyId = `POL-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        ruleVersionId,
        `Environment routing policy: ${definition.profile_id ?? 'reviewed-bootstrap'}`,
        definition.profile_version ?? '1.0.0',
        definitionJson,
        activatedAt,
      );
      this.db.prepare(`
        UPDATE environment_policies
        SET status = 'superseded', deactivated_at = ?
        WHERE root_path = ? AND status = 'active'
      `).run(activatedAt, normalizedRoot);
      this.db.prepare(`
        INSERT INTO environment_policies(
          id, root_path, scan_run_id, rule_version_id, policy_json, status, activated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?)
      `).run(policyId, normalizedRoot, runId, ruleVersionId, definitionJson, activatedAt);
      const receipt = {
        id: policyId,
        root_path: normalizedRoot,
        scan_run_id: runId,
        rule_version_id: ruleVersionId,
        profile_id: definition.profile_id ?? null,
        profile_version: definition.profile_version ?? null,
        policy: definition,
        status: 'active',
        activated_at: activatedAt,
        deactivated_at: null,
      };
      this.#insertEvent(runId, 'environment_policy_activated', {
        policy_id: policyId,
        rule_version_id: ruleVersionId,
        profile_id: definition.profile_id ?? null,
        profile_version: definition.profile_version ?? null,
      }, activatedAt);
      return receipt;
    });
  }

  getActiveEnvironmentPolicy(root) {
    const row = this.db.prepare(`
      SELECT id, root_path, scan_run_id, rule_version_id, policy_json, status, activated_at, deactivated_at
      FROM environment_policies
      WHERE root_path = ? AND status = 'active'
      ORDER BY activated_at DESC, rowid DESC LIMIT 1
    `).get(path.resolve(root));
    if (!row) return null;
    const policy = parseJson(row.policy_json, {});
    return {
      ...row,
      profile_id: policy.profile_id ?? null,
      profile_version: policy.profile_version ?? null,
      policy,
      policy_json: undefined,
    };
  }

  getEnvironmentPolicyForScan(runId) {
    const row = this.db.prepare(`
      SELECT id, root_path, scan_run_id, rule_version_id, policy_json, status, activated_at, deactivated_at
      FROM environment_policies WHERE scan_run_id = ?
    `).get(runId);
    if (!row) return null;
    const policy = parseJson(row.policy_json, {});
    return {
      ...row,
      profile_id: policy.profile_id ?? null,
      profile_version: policy.profile_version ?? null,
      policy,
      policy_json: undefined,
    };
  }

  findLatestBootstrapScanForRoot(root) {
    return this.db.prepare(`
      SELECT r.id
      FROM runs r JOIN environment_scans e ON e.run_id = r.id
      WHERE r.mode = 'bootstrap' AND r.root_path = ?
      ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
    `).get(root) ?? null;
  }

  listBootstrapRuns() {
    return this.db.prepare(`
      SELECT r.id, r.status, r.root_path, r.started_at,
             e.fingerprint, e.initialized_at, e.output_dir
      FROM runs r
      JOIN environment_scans e ON e.run_id = r.id
      WHERE r.mode = 'bootstrap'
      ORDER BY r.started_at DESC
    `).all();
  }

  getBootstrapDetail(runId) {
    const run = this.getRun(runId);
    if (run.mode !== 'bootstrap') throw new Error(`Run is not a Bootstrap scan: ${runId}`);
    const scan = this.db.prepare(`
      SELECT fingerprint, summary_json, output_dir, initialized_at
      FROM environment_scans WHERE run_id = ?
    `).get(runId);
    const entries = this.db.prepare(`
      SELECT path, entry_kind AS kind, extension, byte_size AS byteSize,
             modified_at AS modifiedAt, content_hash AS contentHash, metadata_json
      FROM environment_entries WHERE run_id = ? ORDER BY path
    `).all(runId).map((entry) => ({
      ...entry,
      metadata: parseJson(entry.metadata_json, {}),
      metadata_json: undefined,
    }));
    const reviews = new Map();
    for (const row of this.db.prepare(`
      SELECT id, subject_prediction_id, value, source, details_json, created_at
      FROM labels
      WHERE run_id = ? AND subject_prediction_id IS NOT NULL
      ORDER BY rowid
    `).all(runId)) {
      reviews.set(row.subject_prediction_id, {
        id: row.id,
        decision: row.value,
        source: row.source,
        reason: parseJson(row.details_json, {}).reason ?? null,
        reviewed_at: row.created_at,
      });
    }
    const predictions = this.db.prepare(`
      SELECT id, kind, payload_json, created_at
      FROM predictions WHERE run_id = ? ORDER BY rowid
    `).all(runId).map((row) => ({
      id: row.id,
      kind: row.kind,
      ...parseJson(row.payload_json, {}),
      created_at: row.created_at,
      review: reviews.get(row.id) ?? null,
    }));
    const events = this.db.prepare(`
      SELECT event_type, payload_json, occurred_at
      FROM operation_events WHERE run_id = ? ORDER BY occurred_at, rowid
    `).all(runId).map((row) => ({
      type: row.event_type,
      payload: parseJson(row.payload_json, {}),
      occurred_at: row.occurred_at,
    }));
    return {
      scan: {
        id: run.id,
        status: run.status,
        root_path: run.root_path,
        caller: {
          actor: run.actor,
          agent: run.agent,
          model: run.model,
          tool: run.tool,
          client_run_id: run.client_run_id,
        },
        fingerprint: scan.fingerprint,
        started_at: run.started_at,
        initialized_at: scan.initialized_at,
        output_dir: scan.output_dir,
      },
      rule_version: this.getRuleVersion(run.rule_version_id),
      summary: parseJson(scan.summary_json, {}),
      entries,
      predictions,
      events,
      active_policy: this.getEnvironmentPolicyForScan(runId),
      receipt: parseJson(run.receipt_json, {}),
    };
  }

  reviewBootstrapPrediction(predictionId, { decision, reason, reviewedAt }) {
    return this.transaction(() => {
      const prediction = this.db.prepare(`
        SELECT p.id, p.run_id, r.status AS run_status
        FROM predictions p JOIN runs r ON r.id = p.run_id
        WHERE p.id = ? AND r.mode = 'bootstrap'
      `).get(predictionId);
      if (!prediction) throw new Error(`Bootstrap Prediction not found: ${predictionId}`);
      if (prediction.run_status === 'initialized') {
        throw new Error('Bootstrap review cannot change an initialized scan; create a new scan and RuleVersion.');
      }
      const latest = this.db.prepare(`
        SELECT id, value, details_json, created_at
        FROM labels WHERE subject_prediction_id = ? ORDER BY rowid DESC LIMIT 1
      `).get(predictionId);
      const latestReason = latest ? parseJson(latest.details_json, {}).reason ?? null : null;
      if (latest && latest.value === decision && latestReason === reason) {
        return {
          label_id: latest.id,
          prediction_id: predictionId,
          scan_id: prediction.run_id,
          decision,
          reason,
          reviewed_at: latest.created_at,
        };
      }

      const labelId = `LBL-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO labels(
          id, run_id, subject_prediction_id, name, value, source, details_json, created_at
        ) VALUES (?, ?, ?, 'bootstrap_review', ?, 'user', ?, ?)
      `).run(labelId, prediction.run_id, predictionId, decision, json({ reason }), reviewedAt);
      const total = this.db.prepare(`
        SELECT COUNT(*) AS count FROM predictions WHERE run_id = ?
      `).get(prediction.run_id).count;
      const reviewed = this.db.prepare(`
        SELECT COUNT(DISTINCT subject_prediction_id) AS count
        FROM labels WHERE run_id = ? AND subject_prediction_id IS NOT NULL
      `).get(prediction.run_id).count;
      if (reviewed === total) {
        this.db.prepare(`
          UPDATE runs SET status = 'reviewed' WHERE id = ? AND status = 'scanned'
        `).run(prediction.run_id);
      }
      const receipt = {
        label_id: labelId,
        prediction_id: predictionId,
        scan_id: prediction.run_id,
        decision,
        reason,
        reviewed_at: reviewedAt,
      };
      this.#insertEvent(prediction.run_id, 'bootstrap_prediction_reviewed', receipt, reviewedAt);
      return receipt;
    });
  }

  finishBootstrapInitialize(runId, receipt, initializedAt) {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE environment_scans SET output_dir = ?, initialized_at = ? WHERE run_id = ?
      `).run(receipt.output_dir, initializedAt, runId);
      this.db.prepare(`
        UPDATE runs SET status = 'initialized', receipt_json = ? WHERE id = ?
      `).run(json(receipt), runId);
      this.#insertEvent(runId, 'bootstrap_initialized', receipt, initializedAt);
    });
  }

  finalizeClose({ runId, afterStates, changes, decision, diffText, diffHash, receipt, closedAt }) {
    return this.transaction(() => {
      const run = this.db.prepare(`
        SELECT status, receipt_json FROM runs WHERE id = ?
      `).get(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (run.receipt_json) return parseJson(run.receipt_json);
      if (run.status !== 'open') {
        throw new Error(`Run cannot be closed from status ${run.status}: ${runId}`);
      }
      const changeSet = this.db.prepare('SELECT id FROM change_sets WHERE run_id = ?').get(runId);
      if (!changeSet) throw new Error(`Missing ChangeSet for run: ${runId}`);

      const artifactForPath = this.db.prepare(`
        SELECT id FROM artifacts WHERE origin_run_id = ? AND current_path = ? LIMIT 1
      `);
      const insertArtifact = this.db.prepare(`
        INSERT INTO artifacts(id, origin_run_id, kind, current_path, created_at)
        VALUES (?, ?, 'file', ?, ?)
      `);
      const insertMaterial = this.db.prepare(`
        INSERT INTO materials(id, artifact_id, stage, content_hash, byte_size, blob_path, created_at)
        VALUES (?, ?, 'after', ?, ?, ?, ?)
      `);
      const insertState = this.db.prepare(`
        INSERT INTO run_file_states(run_id, path, stage, kind, content_hash, byte_size, material_id)
        VALUES (?, ?, 'after', ?, ?, ?, ?)
      `);

      const changedByPath = new Map(changes.map((change) => [change.path, change]));
      const afterMaterialByPath = new Map();
      for (const entry of afterStates) {
        let artifact = artifactForPath.get(runId, entry.path);
        if (!artifact) {
          const artifactId = `ART-${crypto.randomUUID()}`;
          insertArtifact.run(artifactId, runId, entry.path, closedAt);
          artifact = { id: artifactId };
        }

        let materialId = null;
        const changed = changedByPath.get(entry.path);
        if (changed) {
          materialId = `MAT-${crypto.randomUUID()}`;
          insertMaterial.run(
            materialId,
            artifact.id,
            entry.contentHash,
            entry.byteSize,
            this.#storeBlobPath(changed.after.blobPath),
            closedAt,
          );
          afterMaterialByPath.set(entry.path, materialId);
        }
        insertState.run(runId, entry.path, entry.kind, entry.contentHash, entry.byteSize, materialId);
      }

      const beforeMaterial = this.db.prepare(`
        SELECT material_id FROM run_file_states
        WHERE run_id = ? AND path = ? AND stage = 'before'
      `);
      const insertChange = this.db.prepare(`
        INSERT INTO changes(
          id, change_set_id, path, change_type, allowed,
          before_kind, before_hash, before_material_id,
          after_kind, after_hash, after_material_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const change of changes) {
        insertChange.run(
          `DIF-${crypto.randomUUID()}`,
          changeSet.id,
          change.path,
          change.changeType,
          change.allowed ? 1 : 0,
          change.before?.kind ?? null,
          change.before?.contentHash ?? null,
          beforeMaterial.get(runId, change.path)?.material_id ?? null,
          change.after?.kind ?? null,
          change.after?.contentHash ?? null,
          afterMaterialByPath.get(change.path) ?? null,
        );
      }

      this.db.prepare(`
        INSERT INTO policy_decisions(id, run_id, rule_version_id, decision, reason, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `DEC-${crypto.randomUUID()}`,
        runId,
        decision.ruleVersionId ?? RULE_VERSION_ID,
        decision.status,
        decision.reason,
        json(decision.details),
        closedAt,
      );

      this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'actual_diff_observed', ?, ?)
      `).run(
        `OBS-${crypto.randomUUID()}`,
        runId,
        json({ changed_files: changes.length, diff_hash: diffHash }),
        closedAt,
      );

      this.db.prepare(`
        UPDATE change_sets
        SET status = ?, diff_text = ?, diff_hash = ?, summary_json = ?, closed_at = ?
        WHERE id = ?
      `).run(
        decision.status === 'pass' ? 'closed' : 'scope_violation',
        diffText,
        diffHash,
        json(receipt),
        closedAt,
        changeSet.id,
      );

      this.db.prepare(`
        UPDATE runs SET status = 'closed', closed_at = ?, receipt_json = ? WHERE id = ?
      `).run(closedAt, json(receipt), runId);

      this.#insertEvent(runId, 'close_completed', receipt, closedAt);
      return receipt;
    });
  }

  finishRollback(runId, receipt, rolledBackAt) {
    return this.transaction(() => {
      const run = this.db.prepare(`
        SELECT status, rollback_receipt_json FROM runs WHERE id = ?
      `).get(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (run.rollback_receipt_json) return parseJson(run.rollback_receipt_json);
      if (run.status !== 'closed') {
        throw new Error(`Only a closed run can be rolled back; current status is ${run.status}.`);
      }
      this.db.prepare(`
        UPDATE runs
        SET status = 'rolled_back', rolled_back_at = ?, rollback_receipt_json = ?
        WHERE id = ?
      `).run(rolledBackAt, json(receipt), runId);
      this.db.prepare(`
        UPDATE change_sets SET status = 'rolled_back' WHERE run_id = ?
      `).run(runId);
      this.#insertEvent(runId, 'rollback_completed', receipt, rolledBackAt);
      return receipt;
    });
  }

  finishAbort(runId, receipt, abortedAt) {
    return this.transaction(() => {
      const run = this.db.prepare(`
        SELECT status, abort_receipt_json FROM runs WHERE id = ?
      `).get(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (run.abort_receipt_json) return parseJson(run.abort_receipt_json);
      if (run.status !== 'open') {
        throw new Error(`Only an open run can be aborted; current status is ${run.status}.`);
      }
      this.db.prepare(`
        UPDATE run_file_states SET material_id = NULL WHERE run_id = ?
      `).run(runId);
      const released = this.db.prepare(`
        DELETE FROM materials
        WHERE artifact_id IN (SELECT id FROM artifacts WHERE origin_run_id = ?)
      `).run(runId).changes;
      const finalReceipt = { ...receipt, released_materials: Number(released) };
      this.db.prepare(`
        UPDATE runs
        SET status = 'aborted', aborted_at = ?, abort_receipt_json = ?
        WHERE id = ?
      `).run(abortedAt, json(finalReceipt), runId);
      this.db.prepare(`
        UPDATE change_sets SET status = 'aborted' WHERE run_id = ?
      `).run(runId);
      this.#insertEvent(runId, 'abort_completed', finalReceipt, abortedAt);
      return finalReceipt;
    });
  }

  recordEvent(runId, eventType, payload) {
    this.#insertEvent(runId, eventType, payload, now());
  }

  recordRollbackPath(runId, pathValue, details, occurredAt) {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO rollback_progress(run_id, path, status, details_json, updated_at)
        VALUES (?, ?, 'restored', ?, ?)
        ON CONFLICT(run_id, path) DO UPDATE SET
          status = excluded.status,
          details_json = excluded.details_json,
          updated_at = excluded.updated_at
      `).run(runId, pathValue, json(details), occurredAt);
      this.#insertEvent(runId, 'rollback_path_restored', { path: pathValue, ...details }, occurredAt);
    });
  }

  getRollbackProgress(runId) {
    return this.db.prepare(`
      SELECT path, status, details_json, updated_at
      FROM rollback_progress WHERE run_id = ? ORDER BY path
    `).all(runId).map((row) => ({
      path: row.path,
      status: row.status,
      details: parseJson(row.details_json, {}),
      updated_at: row.updated_at,
    }));
  }

  #insertEvent(runId, eventType, payload, occurredAt) {
    this.db.prepare(`
      INSERT INTO operation_events(id, run_id, event_type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(`EVT-${crypto.randomUUID()}`, runId, eventType, json(payload), occurredAt);
  }

  getRun(runId) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!row) throw new Error(`Run not found: ${runId}`);
    return row;
  }

  getRuleVersion(ruleVersionId) {
    const row = this.db.prepare(`
      SELECT id, name, version, definition_json, created_at
      FROM rule_versions WHERE id = ?
    `).get(ruleVersionId);
    if (!row) throw new Error(`RuleVersion not found: ${ruleVersionId}`);
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      definition: parseJson(row.definition_json, {}),
      created_at: row.created_at,
    };
  }

  listRuleVersions() {
    return this.db.prepare(`
      SELECT id, name, version, definition_json, created_at
      FROM rule_versions ORDER BY name, version, id
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      definition: parseJson(row.definition_json, {}),
      created_at: row.created_at,
    }));
  }

  findLatestOpenRun() {
    return this.db.prepare(`
      SELECT * FROM runs WHERE status = 'open' ORDER BY started_at DESC LIMIT 1
    `).get() ?? null;
  }

  listRuns() {
    return this.db.prepare(`
      SELECT id, mode, status, root_path, actor, agent, model, tool, client_run_id,
             started_at, closed_at, aborted_at, rolled_back_at
      FROM runs ORDER BY started_at DESC
    `).all();
  }

  getScopes(runId) {
    return this.db.prepare(`
      SELECT scope_path AS path, scope_kind AS kind
      FROM run_scopes WHERE run_id = ? ORDER BY scope_path
    `).all(runId);
  }

  getStates(runId, stage) {
    return this.db.prepare(`
      SELECT s.path, s.kind, s.content_hash AS contentHash,
             s.byte_size AS byteSize, m.blob_path AS blobPath
      FROM run_file_states s
      LEFT JOIN materials m ON m.id = s.material_id
      WHERE s.run_id = ? AND s.stage = ?
      ORDER BY s.path
    `).all(runId, stage).map((row) => ({
      ...row,
      blobPath: this.#resolveBlobPath(row.blobPath, row.contentHash),
    }));
  }

  getChanges(runId) {
    return this.db.prepare(`
      SELECT c.path, c.change_type AS changeType, c.allowed,
             c.before_kind AS beforeKind, c.before_hash AS beforeHash,
             bm.blob_path AS beforeBlobPath,
             c.after_kind AS afterKind, c.after_hash AS afterHash,
             am.blob_path AS afterBlobPath
      FROM changes c
      JOIN change_sets cs ON cs.id = c.change_set_id
      LEFT JOIN materials bm ON bm.id = c.before_material_id
      LEFT JOIN materials am ON am.id = c.after_material_id
      WHERE cs.run_id = ? ORDER BY c.path
    `).all(runId).map((row) => ({
      ...row,
      beforeBlobPath: this.#resolveBlobPath(row.beforeBlobPath, row.beforeHash),
      afterBlobPath: this.#resolveBlobPath(row.afterBlobPath, row.afterHash),
    }));
  }

  showRun(runId) {
    const run = this.getRun(runId);
    const changeSet = this.db.prepare(`
      SELECT id, status, diff_text, diff_hash, summary_json, created_at, closed_at
      FROM change_sets WHERE run_id = ?
    `).get(runId);
    const decisions = this.db.prepare(`
      SELECT id, rule_version_id, decision, reason, details_json, created_at
      FROM policy_decisions WHERE run_id = ? ORDER BY created_at
    `).all(runId).map((row) => ({
      ...row,
      details: parseJson(row.details_json, {}),
      rule_version: this.getRuleVersion(row.rule_version_id),
      details_json: undefined,
    }));
    const events = this.db.prepare(`
      SELECT event_type, payload_json, occurred_at
      FROM operation_events WHERE run_id = ? ORDER BY occurred_at, rowid
    `).all(runId).map((row) => ({
      type: row.event_type,
      payload: parseJson(row.payload_json, {}),
      occurred_at: row.occurred_at,
    }));

    return {
      run: {
        id: run.id,
        mode: run.mode,
        status: run.status,
        root_path: run.root_path,
        intent: run.intent,
        caller: {
          actor: run.actor,
          agent: run.agent,
          model: run.model,
          tool: run.tool,
          client_run_id: run.client_run_id,
        },
        rule_version_id: run.rule_version_id,
        started_at: run.started_at,
        closed_at: run.closed_at,
        aborted_at: run.aborted_at,
        rolled_back_at: run.rolled_back_at,
      },
      scopes: this.getScopes(runId),
      changes: this.getChanges(runId).map((change) => ({ ...change, allowed: Boolean(change.allowed) })),
      decisions,
      rule_version: this.getRuleVersion(run.rule_version_id),
      events,
      receipt: parseJson(run.receipt_json),
      abort_receipt: parseJson(run.abort_receipt_json),
      rollback_receipt: parseJson(run.rollback_receipt_json),
      rollback_progress: this.getRollbackProgress(runId),
      change_set: {
        id: changeSet.id,
        status: changeSet.status,
        diff_hash: changeSet.diff_hash,
        diff_text: changeSet.diff_text ?? '',
        summary: parseJson(changeSet.summary_json),
        created_at: changeSet.created_at,
        closed_at: changeSet.closed_at,
      },
    };
  }

  parseReceipt(run) {
    return parseJson(run.receipt_json);
  }

  parseRollbackReceipt(run) {
    return parseJson(run.rollback_receipt_json);
  }

  parseAbortReceipt(run) {
    return parseJson(run.abort_receipt_json);
  }

  getReferencedBlobPaths() {
    return this.db.prepare(`
      SELECT DISTINCT blob_path, content_hash FROM materials WHERE blob_path IS NOT NULL
    `).all().map((row) => this.#resolveBlobPath(row.blob_path, row.content_hash));
  }

  diagnostics() {
    const schemaVersion = this.db.prepare('PRAGMA user_version').get().user_version;
    const integrityRows = this.db.prepare('PRAGMA integrity_check').all();
    const integrityMessages = integrityRows.map((row) => row.integrity_check);
    const journalMode = this.db.prepare('PRAGMA journal_mode').get().journal_mode;
    const backupDir = path.join(this.stateDir, 'backups');
    const migrationBackups = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((name) => name.endsWith('.sqlite')).sort()
      : [];
    return {
      db_path: this.dbPath,
      schema_version: schemaVersion,
      supported_schema_version: LATEST_SCHEMA_VERSION,
      journal_mode: journalMode,
      integrity: integrityMessages.length === 1 && integrityMessages[0] === 'ok' ? 'ok' : 'failed',
      integrity_messages: integrityMessages,
      migration_backups: migrationBackups,
    };
  }

  close() {
    this.db.close();
  }
}
