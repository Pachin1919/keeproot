import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RISK_RULE_VERSION_ID } from './risk.js';
import {
  applyProjectContextMigration,
  PROJECT_CONTEXT_SCHEMA_VERSION,
} from './storage/migrations/v19-project-context.js';

const RULE_VERSION_ID = 'RULE-TRACKED-DIRECT-1';
const BOOTSTRAP_RULE_VERSION_ID = 'RULE-BOOTSTRAP-2';
const EVOLUTION_RULE_VERSION_ID = 'RULE-EVOLUTION-6';
const ORGANIZATION_PLAN_RULE_VERSION_ID = 'RULE-EVOLUTION-PLAN-1';
const TASK_RULE_VERSION_ID = 'RULE-TASK-CONTRACT-1';
export const TASK_SCOPED_ENVIRONMENT_RULE_VERSION_ID = 'RULE-TASK-SCOPED-EXPLICIT-1';
const PORTFOLIO_RULE_VERSION_ID = 'RULE-PORTFOLIO-1';
export const LATEST_SCHEMA_VERSION = PROJECT_CONTEXT_SCHEMA_VERSION;

function json(value) {
  return JSON.stringify(value);
}
function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

function now() {
  return new Date().toISOString();
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function assertWritableLedgerState(stateDir, databasePath) {
  let descriptor = null;
  let probePath = null;
  try {
    if (fs.existsSync(databasePath)) {
      descriptor = fs.openSync(databasePath, 'r+');
    } else {
      probePath = path.join(stateDir, `.ledger-write-probe-${crypto.randomUUID()}`);
      descriptor = fs.openSync(probePath, 'wx');
    }
  } catch (error) {
    const wrapped = new Error(`Atlas Ledger state is not writable: ${error.message}`);
    wrapped.code = error.code ?? 'ATLAS_LEDGER_READ_ONLY';
    throw wrapped;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    if (probePath) fs.rmSync(probePath, { force: true });
  }
}

export class Ledger {
  constructor(stateDir) {
    this.stateDir = path.resolve(stateDir);
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.dbPath = path.join(this.stateDir, 'ledger.sqlite');
    assertWritableLedgerState(this.stateDir, this.dbPath);
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

      CREATE TABLE IF NOT EXISTS portfolio_inventories (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        fingerprint TEXT NOT NULL,
        depth INTEGER NOT NULL,
        excluded_json TEXT NOT NULL,
        expanded_json TEXT NOT NULL,
        summary_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_portfolio_inventories_fingerprint
        ON portfolio_inventories(fingerprint);

      CREATE TABLE IF NOT EXISTS portfolio_roots (
        id TEXT PRIMARY KEY,
        current_path TEXT NOT NULL COLLATE NOCASE UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_root_path_history (
        id INTEGER PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES portfolio_roots(id),
        path TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS portfolio_inventory_roots (
        inventory_run_id TEXT NOT NULL REFERENCES runs(id),
        root_id TEXT NOT NULL REFERENCES portfolio_roots(id),
        relative_path TEXT NOT NULL,
        observation_json TEXT NOT NULL,
        type_prediction_id TEXT NOT NULL UNIQUE REFERENCES predictions(id),
        relation_prediction_id TEXT NOT NULL UNIQUE REFERENCES predictions(id),
        PRIMARY KEY(inventory_run_id, root_id)
      );

      CREATE TABLE IF NOT EXISTS portfolio_plans (
        id TEXT PRIMARY KEY,
        inventory_run_id TEXT NOT NULL REFERENCES runs(id),
        target_root TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(inventory_run_id, target_root, plan_hash)
      );

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

      CREATE TABLE IF NOT EXISTS evolution_operations (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        operation_type TEXT NOT NULL,
        source_path TEXT,
        target_path TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id),
        prediction_id TEXT NOT NULL REFERENCES predictions(id),
        plan_hash TEXT NOT NULL,
        baseline_json TEXT NOT NULL,
        approved_plan_hash TEXT,
        approval_receipt_json TEXT,
        rejection_receipt_json TEXT,
        execution_receipt_json TEXT,
        executed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_contracts (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        contract_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        project_path TEXT NOT NULL,
        environment_rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
        contract_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        underlying_run_id TEXT REFERENCES runs(id),
        completion_receipt_json TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_inputs (
        run_id TEXT NOT NULL REFERENCES runs(id),
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        artifact_id TEXT REFERENCES artifacts(id),
        material_id TEXT REFERENCES materials(id),
        prepared_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        selected INTEGER NOT NULL,
        selection_reason TEXT,
        series_id TEXT,
        temporal_mode TEXT,
        coverage_start TEXT,
        coverage_end TEXT,
        required INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        PRIMARY KEY(run_id, ordinal),
        UNIQUE(run_id, path)
      );

      CREATE TABLE IF NOT EXISTS task_fulfillment_claims (
        task_run_id TEXT PRIMARY KEY REFERENCES task_contracts(run_id),
        claim_token TEXT NOT NULL UNIQUE,
        process_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        planned_write_run_id TEXT,
        write_run_id TEXT REFERENCES runs(id),
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS routing_corrections (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        root_path TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        origin TEXT NOT NULL,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        target_subdirectory TEXT NOT NULL,
        rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_routing_corrections_lookup
        ON routing_corrections(root_path, origin, kind, status, scope_type, scope_key);

      CREATE TABLE IF NOT EXISTS preference_rules (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        root_path TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        condition_hash TEXT NOT NULL,
        condition_json TEXT NOT NULL,
        value_json TEXT NOT NULL,
        priority INTEGER NOT NULL,
        rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        basis TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_preference_rules_lookup
        ON preference_rules(root_path, status, kind, scope_type, scope_key, priority);

      CREATE TABLE IF NOT EXISTS rule_change_proposals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        root_path TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        condition_hash TEXT NOT NULL,
        condition_json TEXT NOT NULL,
        value_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        basis TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        base_rule_id TEXT REFERENCES preference_rules(id),
        impact_json TEXT NOT NULL,
        activated_rule_id TEXT REFERENCES preference_rules(id),
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_rule_change_proposals_hash
        ON rule_change_proposals(root_path, proposal_hash, status);

      CREATE TABLE IF NOT EXISTS organization_plans (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        plan_hash TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        approved_plan_hash TEXT,
        approval_receipt_json TEXT,
        execution_receipt_json TEXT,
        rollback_receipt_json TEXT
      );

      CREATE TABLE IF NOT EXISTS organization_plan_items (
        plan_run_id TEXT NOT NULL REFERENCES organization_plans(run_id),
        ordinal INTEGER NOT NULL,
        child_run_id TEXT REFERENCES runs(id),
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plan_run_id, ordinal)
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
      this.#ensureColumn('task_fulfillment_claims', 'planned_write_run_id', 'TEXT');
      this.#ensureColumn('portfolio_inventories', 'expanded_json', "TEXT NOT NULL DEFAULT '[]'");
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
      insertMigration.run(11, 'guarded_filesystem_evolution_changesets', appliedAt);
      insertMigration.run(12, 'bounded_task_contracts_and_temporal_read_policy', appliedAt);
      insertMigration.run(13, 'scoped_intake_routing_corrections', appliedAt);
      insertMigration.run(14, 'immutable_multi_step_organization_plans', appliedAt);
      insertMigration.run(15, 'exclusive_task_fulfillment_claims', appliedAt);
      insertMigration.run(16, 'crash_resumable_task_fulfillment_claims', appliedAt);
      insertMigration.run(17, 'multi_root_portfolio_inventory_review_and_plan', appliedAt);
      insertMigration.run(18, 'scoped_effective_preference_rules', appliedAt);
      applyProjectContextMigration(this.db, appliedAt);
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
    if (!blobPath) return null;
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
        VALUES (?, ?, ?, ?, ?)
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
        let materialId = null;
        insertArtifact.run(artifactId, runId, entry.kind, entry.path, startedAt);
        if (entry.kind === 'file') {
          materialId = `MAT-${crypto.randomUUID()}`;
          insertMaterial.run(
            materialId,
            artifactId,
            entry.contentHash,
            entry.byteSize,
            this.#storeBlobPath(entry.blobPath),
            startedAt,
          );
        }
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
             cm.blob_path AS candidate_blob_path, cm.artifact_id AS artifact_id
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
        artifact_id: operation.artifact_id,
        material_id: operation.candidate_material_id,
      },
      baseline: {
        material_id: operation.before_material_id,
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
      this.#insertRollbackOutcome(runId, {
        outcome: 'completed',
        reasonCode: 'restored_and_verified',
        details: { restored_files: receipt.restored_files ?? null },
      }, rolledBackAt);
      return receipt;
    });
  }

  createEvolutionRun({
    runId,
    root,
    operation,
    sourcePath,
    targetPath,
    projectId,
    intent,
    baseline,
    plan,
    planHash,
    diffText,
    diffHash,
    caller = {},
    startedAt,
  }) {
    const candidateChangeSetId = `CAN-${crypto.randomUUID()}`;
    const actualChangeSetId = `CHG-${crypto.randomUUID()}`;
    const predictionId = `PRD-${crypto.randomUUID()}`;
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Guarded filesystem evolution', '6.0.0', ?, ?)
      `).run(EVOLUTION_RULE_VERSION_ID, json({
        operations: [
          'create_directory',
          'move_file',
          'migrate_project',
          'migrate_directory',
          'remove_empty_directory',
        ],
        review_required: true,
        stale_plan_denied: true,
        rollback_conflict_denied: true,
      }), startedAt);
      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at
        ) VALUES (?, 'evolution', 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, root, intent ?? null, caller.actor ?? 'unknown', caller.agent ?? null,
        caller.model ?? null, caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        EVOLUTION_RULE_VERSION_ID, startedAt,
      );
      this.db.prepare(`
        INSERT INTO change_sets(id, run_id, status, created_at)
        VALUES (?, ?, 'awaiting_execution', ?)
      `).run(actualChangeSetId, runId, startedAt);
      this.db.prepare(`
        INSERT INTO candidate_change_sets(
          id, run_id, version, operation, target_path, status, content_hash,
          diff_text, diff_hash, summary_json, created_at
        ) VALUES (?, ?, 1, ?, ?, 'prepared', ?, ?, ?, ?, ?)
      `).run(
        candidateChangeSetId, runId, operation, targetPath, planHash,
        diffText, diffHash, json(plan), startedAt,
      );
      const prediction = {
        kind: 'evolution_changeset_candidate',
        summary: plan.summary,
        confidence: 1,
        risk: 'high',
        affected_paths: plan.source_changes.map((change) => change.path),
        evidence: { plan, plan_hash: planHash },
        proposed_action: 'Execute only after explicit review of this exact filesystem ChangeSet.',
        requires_review: true,
        source: 'atlas-deterministic',
      };
      this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'evolution_changeset_candidate', ?, ?)
      `).run(predictionId, runId, json(prediction), startedAt);
      this.db.prepare(`
        INSERT INTO evolution_operations(
          run_id, operation_type, source_path, target_path, project_id,
          prediction_id, plan_hash, baseline_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, operation, sourcePath ?? null, targetPath, projectId ?? null,
        predictionId, planHash, json(baseline),
      );
      this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'evolution_baseline_captured', ?, ?)
      `).run(`OBS-${crypto.randomUUID()}`, runId, json({
        operation, source_path: sourcePath ?? null, target_path: targetPath,
        source_manifest_hash: baseline.source_manifest_hash ?? null,
        source_entries: baseline.source_entries?.length ?? 0,
        target_state: baseline.target_state,
      }), startedAt);
      this.db.prepare(`
        INSERT INTO policy_decisions(id, run_id, rule_version_id, decision, reason, details_json, created_at)
        VALUES (?, ?, ?, 'guarded', ?, ?, ?)
      `).run(
        `DEC-${crypto.randomUUID()}`,
        runId,
        EVOLUTION_RULE_VERSION_ID,
        'Filesystem structure changes require explicit approval and exact-state verification.',
        json({ operation, paths: prediction.affected_paths, recovery_available: true }),
        startedAt,
      );
      this.#insertEvent(runId, 'evolution_prepared', {
        candidate_change_set_id: candidateChangeSetId,
        prediction_id: predictionId,
        operation,
        plan_hash: planHash,
      }, startedAt);
    });
    return { candidateChangeSetId, actualChangeSetId, predictionId };
  }

  getEvolutionOperation(runId) {
    const run = this.getRun(runId);
    if (run.mode !== 'evolution') throw new Error(`Run is not Evolution: ${runId}`);
    const row = this.db.prepare(`SELECT * FROM evolution_operations WHERE run_id = ?`).get(runId);
    if (!row) throw new Error(`Evolution run is incomplete: ${runId}`);
    return {
      ...row,
      baseline: parseJson(row.baseline_json, {}),
      approval_receipt: parseJson(row.approval_receipt_json),
      rejection_receipt: parseJson(row.rejection_receipt_json),
      execution_receipt: parseJson(row.execution_receipt_json),
      baseline_json: undefined,
      approval_receipt_json: undefined,
      rejection_receipt_json: undefined,
      execution_receipt_json: undefined,
    };
  }

  getEvolutionDetail(runId) {
    const run = this.getRun(runId);
    const operation = this.getEvolutionOperation(runId);
    const candidate = this.db.prepare(`SELECT * FROM candidate_change_sets WHERE run_id = ?`).get(runId);
    const predictionRow = this.db.prepare(`
      SELECT id, kind, payload_json, created_at FROM predictions WHERE id = ?
    `).get(operation.prediction_id);
    const labelRow = this.db.prepare(`
      SELECT id, value, source, details_json, created_at
      FROM labels WHERE subject_prediction_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(operation.prediction_id);
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
          actor: run.actor, agent: run.agent, model: run.model,
          tool: run.tool, client_run_id: run.client_run_id,
        },
        rule_version_id: run.rule_version_id,
        started_at: run.started_at,
        rolled_back_at: run.rolled_back_at,
      },
      operation: {
        type: operation.operation_type,
        source: operation.source_path,
        target: operation.target_path,
        project_id: operation.project_id,
        plan_hash: operation.plan_hash,
      },
      plan: parseJson(candidate.summary_json, {}),
      candidate_change_set: {
        id: candidate.id,
        status: candidate.status,
        diff_text: candidate.diff_text,
        diff_hash: candidate.diff_hash,
        created_at: candidate.created_at,
      },
      prediction: {
        id: predictionRow.id,
        kind: predictionRow.kind,
        ...parseJson(predictionRow.payload_json, {}),
        created_at: predictionRow.created_at,
        review: labelRow ? {
          id: labelRow.id,
          decision: labelRow.value,
          source: labelRow.source,
          reason: parseJson(labelRow.details_json, {}).reason ?? null,
          reviewed_at: labelRow.created_at,
        } : null,
      },
      approved_plan_hash: operation.approved_plan_hash,
      events,
      approval_receipt: operation.approval_receipt,
      rejection_receipt: operation.rejection_receipt,
      execution_receipt: operation.execution_receipt,
      rollback_receipt: parseJson(run.rollback_receipt_json),
    };
  }

  reviewEvolution(runId, { decision, reason, reviewedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.mode !== 'evolution') throw new Error(`Run is not Evolution: ${runId}`);
      const operation = this.db.prepare(`SELECT * FROM evolution_operations WHERE run_id = ?`).get(runId);
      const existing = decision === 'accepted'
        ? parseJson(operation.approval_receipt_json)
        : parseJson(operation.rejection_receipt_json);
      if (existing) return existing;
      if (run.status !== 'prepared') {
        throw new Error(`Evolution review requires prepared status; current status is ${run.status}.`);
      }
      const status = decision === 'accepted' ? 'approved' : 'rejected';
      const receipt = {
        run_id: runId,
        prediction_id: operation.prediction_id,
        plan_hash: operation.plan_hash,
        decision,
        reason,
        status,
        reviewed_at: reviewedAt,
      };
      this.db.prepare(`
        INSERT INTO labels(id, run_id, subject_prediction_id, name, value, source, details_json, created_at)
        VALUES (?, ?, ?, 'evolution_review', ?, 'user', ?, ?)
      `).run(
        `LBL-${crypto.randomUUID()}`, runId, operation.prediction_id,
        decision, json({ reason }), reviewedAt,
      );
      this.db.prepare(`UPDATE runs SET status = ? WHERE id = ?`).run(status, runId);
      this.db.prepare(`UPDATE candidate_change_sets SET status = ? WHERE run_id = ?`).run(status, runId);
      if (decision === 'accepted') {
        this.db.prepare(`
          UPDATE evolution_operations
          SET approved_plan_hash = ?, approval_receipt_json = ? WHERE run_id = ?
        `).run(operation.plan_hash, json(receipt), runId);
      } else {
        this.db.prepare(`
          UPDATE evolution_operations SET rejection_receipt_json = ? WHERE run_id = ?
        `).run(json(receipt), runId);
      }
      this.#insertEvent(runId, `evolution_${status}`, receipt, reviewedAt);
      return receipt;
    });
  }

  markEvolutionStale(runId, payload, occurredAt) {
    this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status === 'stale') return;
      if (run.status !== 'approved') {
        throw new Error(`Only an approved Evolution run can become stale; current status is ${run.status}.`);
      }
      this.db.prepare(`UPDATE runs SET status = 'stale' WHERE id = ?`).run(runId);
      this.db.prepare(`UPDATE candidate_change_sets SET status = 'stale' WHERE run_id = ?`).run(runId);
      this.#insertEvent(runId, 'evolution_approval_invalidated', payload, occurredAt);
    });
  }

  startEvolutionExecution(runId, occurredAt) {
    const detail = this.getEvolutionDetail(runId);
    if (detail.events.some((event) => event.type === 'evolution_execution_started')) return;
    if (detail.run.status !== 'approved') {
      throw new Error(`Evolution execution requires approval; current status is ${detail.run.status}.`);
    }
    this.recordEvent(runId, 'evolution_execution_started', {
      plan_hash: detail.operation.plan_hash,
    }, occurredAt);
  }

  finishEvolutionExecution(runId, { receipt, executedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      const operation = this.db.prepare(`SELECT * FROM evolution_operations WHERE run_id = ?`).get(runId);
      const existing = parseJson(operation.execution_receipt_json);
      if (existing) return existing;
      if (run.status !== 'approved' || operation.approved_plan_hash !== operation.plan_hash) {
        throw new Error('Evolution execution no longer matches its approved ChangeSet.');
      }
      const changeSet = this.db.prepare(`SELECT id FROM change_sets WHERE run_id = ?`).get(runId);
      const insert = this.db.prepare(`
        INSERT INTO changes(
          id, change_set_id, path, change_type, allowed,
          before_kind, before_hash, after_kind, after_hash
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      `);
      if (operation.operation_type === 'create_directory') {
        insert.run(
          `DIF-${crypto.randomUUID()}`, changeSet.id, operation.target_path, 'added',
          null, null, 'directory', receipt.after_manifest_hash,
        );
      } else if (operation.operation_type === 'remove_empty_directory') {
        const baseline = parseJson(operation.baseline_json, {});
        insert.run(
          `DIF-${crypto.randomUUID()}`, changeSet.id, operation.source_path, 'deleted',
          'directory', baseline.source_manifest_hash, null, null,
        );
      } else {
        const kind = operation.operation_type === 'move_file' ? 'file' : 'directory';
        insert.run(
          `DIF-${crypto.randomUUID()}`, changeSet.id, operation.source_path, 'deleted',
          kind, receipt.after_manifest_hash, null, null,
        );
        insert.run(
          `DIF-${crypto.randomUUID()}`, changeSet.id, operation.target_path, 'added',
          null, null, kind, receipt.after_manifest_hash,
        );
      }
      const candidate = this.db.prepare(`SELECT * FROM candidate_change_sets WHERE run_id = ?`).get(runId);
      this.db.prepare(`
        UPDATE change_sets SET status = 'executed', diff_text = ?, diff_hash = ?,
          summary_json = ?, closed_at = ? WHERE run_id = ?
      `).run(candidate.diff_text, candidate.diff_hash, candidate.summary_json, executedAt, runId);
      this.db.prepare(`UPDATE candidate_change_sets SET status = 'executed' WHERE run_id = ?`).run(runId);
      this.db.prepare(`
        UPDATE evolution_operations SET execution_receipt_json = ?, executed_at = ? WHERE run_id = ?
      `).run(json(receipt), executedAt, runId);
      this.db.prepare(`
        UPDATE runs SET status = 'executed', closed_at = ?, receipt_json = ? WHERE id = ?
      `).run(executedAt, json(receipt), runId);
      this.#insertEvent(runId, 'evolution_executed_and_verified', receipt, executedAt);
      return receipt;
    });
  }

  finishEvolutionRollback(runId, receipt, rolledBackAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.rollback_receipt_json) return parseJson(run.rollback_receipt_json);
      if (run.status !== 'executed') {
        throw new Error(`Only an executed Evolution run can be rolled back; current status is ${run.status}.`);
      }
      this.db.prepare(`
        UPDATE runs SET status = 'rolled_back', rolled_back_at = ?, rollback_receipt_json = ? WHERE id = ?
      `).run(rolledBackAt, json(receipt), runId);
      this.db.prepare(`UPDATE change_sets SET status = 'rolled_back' WHERE run_id = ?`).run(runId);
      this.#insertEvent(runId, 'evolution_rollback_completed', receipt, rolledBackAt);
      this.#insertRollbackOutcome(runId, {
        outcome: 'completed',
        reasonCode: 'restored_and_verified',
        details: { operation: receipt.operation ?? null },
      }, rolledBackAt);
      return receipt;
    });
  }

  createOrganizationPlan({ runId, root, intent, operations, planHash, caller = {}, createdAt }) {
    const predictionId = `PRD-${crypto.randomUUID()}`;
    const receipt = {
      run_id: runId,
      status: 'prepared',
      plan_hash: planHash,
      operations,
      user_decisions_required: 1,
      source_changes: operations.map((item) => ({
        operation: item.operation,
        source: item.source ?? null,
        target: item.target,
      })),
    };
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Immutable organization plan policy', '1.0.0', ?, ?)
      `).run(ORGANIZATION_PLAN_RULE_VERSION_ID, json({
        approval: 'one approval for the immutable total plan',
        execution: 'sequential verified Evolution child runs',
        recovery: 'reverse child rollback with conflict protection',
      }), createdAt);
      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at, receipt_json
        ) VALUES (?, 'organization_plan', 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, path.resolve(root), intent ?? null,
        caller.actor ?? 'unknown', caller.agent ?? null, caller.model ?? null,
        caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        ORGANIZATION_PLAN_RULE_VERSION_ID, createdAt, json(receipt),
      );
      this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'organization_plan', ?, ?)
      `).run(predictionId, runId, json({ plan_hash: planHash, operations }), createdAt);
      this.db.prepare(`
        INSERT INTO policy_decisions(
          id, run_id, rule_version_id, decision, reason, details_json, created_at
        ) VALUES (?, ?, ?, 'warn', 'Organization plan requires one explicit total-plan approval.', ?, ?)
      `).run(`POL-${crypto.randomUUID()}`, runId, ORGANIZATION_PLAN_RULE_VERSION_ID, json({ plan_hash: planHash }), createdAt);
      this.db.prepare(`
        INSERT INTO organization_plans(run_id, plan_hash, operations_json)
        VALUES (?, ?, ?)
      `).run(runId, planHash, json(operations));
      const insertItem = this.db.prepare(`
        INSERT INTO organization_plan_items(plan_run_id, ordinal, child_run_id, status, updated_at)
        VALUES (?, ?, NULL, 'pending', ?)
      `);
      operations.forEach((operation, ordinal) => insertItem.run(runId, ordinal, createdAt));
      this.#insertEvent(runId, 'organization_plan_prepared', {
        plan_hash: planHash, operation_count: operations.length,
      }, createdAt);
    });
    return receipt;
  }

  getOrganizationPlan(runId) {
    const run = this.getRun(runId);
    if (run.mode !== 'organization_plan') throw new Error(`Run is not an organization plan: ${runId}`);
    const plan = this.db.prepare('SELECT * FROM organization_plans WHERE run_id = ?').get(runId);
    const prediction = this.db.prepare(`
      SELECT id, payload_json FROM predictions WHERE run_id = ? AND kind = 'organization_plan'
    `).get(runId);
    const label = this.db.prepare(`
      SELECT value, details_json, created_at FROM labels
      WHERE run_id = ? AND name = 'organization_plan_review'
      ORDER BY rowid DESC LIMIT 1
    `).get(runId);
    const items = this.db.prepare(`
      SELECT ordinal, child_run_id, status, updated_at
      FROM organization_plan_items WHERE plan_run_id = ? ORDER BY ordinal
    `).all(runId);
    return {
      run,
      status: run.status,
      plan_hash: plan.plan_hash,
      operations: parseJson(plan.operations_json, []),
      approved_plan_hash: plan.approved_plan_hash,
      approval: label ? { value: label.value, ...parseJson(label.details_json, {}), created_at: label.created_at } : null,
      items,
      user_decisions_required: label ? 0 : 1,
      receipt: parseJson(run.receipt_json, {}),
      execution_receipt: parseJson(plan.execution_receipt_json),
      rollback_receipt: parseJson(plan.rollback_receipt_json),
      events: this.db.prepare(`
        SELECT event_type AS type, payload_json, occurred_at
        FROM operation_events WHERE run_id = ? ORDER BY occurred_at, rowid
      `).all(runId).map((event) => ({
        type: event.type, payload: parseJson(event.payload_json, {}), occurred_at: event.occurred_at,
      })),
      prediction_id: prediction?.id ?? null,
    };
  }

  reviewOrganizationPlan(runId, { reason, reviewedAt }) {
    return this.transaction(() => {
      const detail = this.getOrganizationPlan(runId);
      if (detail.run.status === 'approved') return detail.receipt;
      if (detail.run.status !== 'prepared') throw new Error(`Organization plan cannot be approved from ${detail.run.status}.`);
      const receipt = {
        ...detail.receipt,
        status: 'approved',
        approval_reason: reason,
        approved_at: reviewedAt,
      };
      this.db.prepare(`
        INSERT INTO labels(
          id, run_id, subject_prediction_id, name, value, source, details_json, created_at
        ) VALUES (?, ?, ?, 'organization_plan_review', 'accepted', 'user', ?, ?)
      `).run(
        `LBL-${crypto.randomUUID()}`, runId, detail.prediction_id,
        json({ reason, plan_hash: detail.plan_hash }), reviewedAt,
      );
      this.db.prepare(`
        INSERT INTO policy_decisions(
          id, run_id, rule_version_id, decision, reason, details_json, created_at
        ) VALUES (?, ?, ?, 'allow', ?, ?, ?)
      `).run(
        `POL-${crypto.randomUUID()}`, runId, ORGANIZATION_PLAN_RULE_VERSION_ID,
        `Approved immutable organization plan: ${reason}`, json({ plan_hash: detail.plan_hash }), reviewedAt,
      );
      this.db.prepare("UPDATE runs SET status = 'approved', receipt_json = ? WHERE id = ?")
        .run(json(receipt), runId);
      this.db.prepare(`
        UPDATE organization_plans
        SET approved_plan_hash = ?, approval_receipt_json = ? WHERE run_id = ?
      `).run(detail.plan_hash, json(receipt), runId);
      this.#insertEvent(runId, 'organization_plan_approved', { plan_hash: detail.plan_hash, reason }, reviewedAt);
      return receipt;
    });
  }

  rejectOrganizationPlan(runId, { reason, reviewedAt }) {
    return this.transaction(() => {
      const detail = this.getOrganizationPlan(runId);
      if (detail.run.status === 'rejected') return detail.receipt;
      if (detail.run.status !== 'prepared') {
        throw new Error(`Organization plan cannot be rejected from ${detail.run.status}.`);
      }
      const receipt = {
        ...detail.receipt,
        status: 'rejected',
        rejection_reason: reason,
        rejected_at: reviewedAt,
      };
      this.db.prepare(`
        INSERT INTO labels(
          id, run_id, subject_prediction_id, name, value, source, details_json, created_at
        ) VALUES (?, ?, ?, 'organization_plan_review', 'rejected', 'user', ?, ?)
      `).run(
        `LBL-${crypto.randomUUID()}`, runId, detail.prediction_id,
        json({ reason, plan_hash: detail.plan_hash }), reviewedAt,
      );
      this.db.prepare(`
        INSERT INTO policy_decisions(
          id, run_id, rule_version_id, decision, reason, details_json, created_at
        ) VALUES (?, ?, ?, 'deny', ?, ?, ?)
      `).run(
        `POL-${crypto.randomUUID()}`, runId, ORGANIZATION_PLAN_RULE_VERSION_ID,
        `Rejected immutable organization plan: ${reason}`, json({ plan_hash: detail.plan_hash }), reviewedAt,
      );
      this.db.prepare("UPDATE runs SET status = 'rejected', receipt_json = ? WHERE id = ?")
        .run(json(receipt), runId);
      this.#insertEvent(runId, 'organization_plan_rejected', { plan_hash: detail.plan_hash, reason }, reviewedAt);
      return receipt;
    });
  }

  markOrganizationPlanStale(runId, conflicts, occurredAt) {
    return this.transaction(() => {
      const detail = this.getOrganizationPlan(runId);
      if (detail.run.status === 'stale') return detail.receipt;
      const receipt = { ...detail.receipt, status: 'stale', conflicts };
      this.db.prepare("UPDATE runs SET status = 'stale', receipt_json = ? WHERE id = ?")
        .run(json(receipt), runId);
      this.#insertEvent(runId, 'organization_plan_stale', { conflicts }, occurredAt);
      return receipt;
    });
  }

  recordOrganizationPlanItem(runId, ordinal, { childRunId = null, status, occurredAt }) {
    return this.transaction(() => {
      const current = this.db.prepare(`
        SELECT child_run_id, status FROM organization_plan_items
        WHERE plan_run_id = ? AND ordinal = ?
      `).get(runId, ordinal);
      if (!current) throw new Error(`Organization plan item not found: ${runId}#${ordinal}`);
      if (current.child_run_id && childRunId && current.child_run_id !== childRunId) {
        throw new Error(`Organization plan item already belongs to ${current.child_run_id}.`);
      }
      this.db.prepare(`
        UPDATE organization_plan_items
        SET child_run_id = COALESCE(child_run_id, ?), status = ?, updated_at = ?
        WHERE plan_run_id = ? AND ordinal = ?
      `).run(childRunId, status, occurredAt, runId, ordinal);
      if (status !== 'rolled_back') {
        this.db.prepare("UPDATE runs SET status = 'partially_executed' WHERE id = ? AND status = 'approved'")
          .run(runId);
      }
      this.#insertEvent(runId, 'organization_plan_item_updated', {
        ordinal, child_run_id: childRunId ?? current.child_run_id, status,
      }, occurredAt);
    });
  }

  finishOrganizationPlanExecution(runId, receipt, occurredAt) {
    return this.transaction(() => {
      this.db.prepare("UPDATE runs SET status = 'executed', closed_at = ?, receipt_json = ? WHERE id = ?")
        .run(occurredAt, json(receipt), runId);
      this.db.prepare('UPDATE organization_plans SET execution_receipt_json = ? WHERE run_id = ?')
        .run(json(receipt), runId);
      this.#insertEvent(runId, 'organization_plan_executed', receipt, occurredAt);
      return receipt;
    });
  }

  finishOrganizationPlanRollback(runId, receipt, occurredAt) {
    return this.transaction(() => {
      this.db.prepare("UPDATE runs SET status = 'rolled_back', rolled_back_at = ?, rollback_receipt_json = ? WHERE id = ?")
        .run(occurredAt, json(receipt), runId);
      this.db.prepare('UPDATE organization_plans SET rollback_receipt_json = ? WHERE run_id = ?')
        .run(json(receipt), runId);
      this.#insertEvent(runId, 'organization_plan_rolled_back', receipt, occurredAt);
      return receipt;
    });
  }

  findTaskContract(contractId) {
    const row = this.db.prepare(`
      SELECT run_id FROM task_contracts WHERE contract_id = ?
    `).get(contractId);
    return row ? this.getTaskDetail(row.run_id) : null;
  }

  createTaskContract({
    runId,
    contractId,
    root,
    request,
    contract,
    contractHash,
    project,
    environmentRuleVersionId,
    inputs,
    caller = {},
    candidateSetId = null,
    sourceSetId = null,
    writeRootId = null,
    startedAt,
  }) {
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Bounded Task Contract policy', '1.0.0', ?, ?)
      `).run(TASK_RULE_VERSION_ID, json({
        input_scope: 'selected_paths_only',
        output_scope: 'exact_target_only',
        strategies: ['create', 'append', 'delta', 'new_version', 'supersede', 'archive', 'deny'],
        stale_input_denied: true,
        delete_execution: 'deny',
        archive_execution: 'reviewed_organization_plan',
      }), startedAt);
      if (environmentRuleVersionId === TASK_SCOPED_ENVIRONMENT_RULE_VERSION_ID) {
        this.db.prepare(`
          INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
          VALUES (?, 'Task-scoped explicit environment policy', '1.0.0', ?, ?)
        `).run(TASK_SCOPED_ENVIRONMENT_RULE_VERSION_ID, json({
          mode: 'task_scoped_explicit',
          prerequisites: ['registered_active_project', 'explicit_existing_inputs', 'exact_new_target'],
          discovery: 'deny',
          routing_inference: 'deny',
          read_scope: 'explicit_selected_paths_only',
          write_scope: 'exact_target_only',
        }), startedAt);
      }
      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at
        ) VALUES (?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        contract.status,
        root,
        request.intent,
        caller.actor ?? 'unknown',
        caller.agent ?? null,
        caller.model ?? null,
        caller.tool ?? 'atlas-cli',
        caller.client_run_id ?? null,
        TASK_RULE_VERSION_ID,
        startedAt,
      );
      this.db.prepare(`
        INSERT INTO task_contracts(
          run_id, contract_id, project_id, project_path, environment_rule_version_id,
          contract_hash, request_json, contract_json,
          candidate_set_id, source_set_id, write_root_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        contractId,
        project.id,
        project.current_path,
        environmentRuleVersionId,
        contractHash,
        json(request),
        json(contract),
        candidateSetId,
        sourceSetId,
        writeRootId,
      );

      const findArtifact = this.db.prepare(`
        SELECT id FROM artifacts
        WHERE root_path = ? AND current_path = ? AND status = 'active'
        ORDER BY updated_at DESC, rowid DESC LIMIT 1
      `);
      const insertArtifact = this.db.prepare(`
        INSERT INTO artifacts(
          id, origin_run_id, project_id, kind, current_path, root_path, role, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'file', ?, ?, 'source', 'active', ?, ?)
      `);
      const findMaterial = this.db.prepare(`
        SELECT id FROM materials WHERE artifact_id = ? AND content_hash = ?
        ORDER BY rowid DESC LIMIT 1
      `);
      const insertMaterial = this.db.prepare(`
        INSERT INTO materials(id, artifact_id, stage, content_hash, byte_size, blob_path, created_at)
        VALUES (?, ?, 'task_input', ?, ?, ?, ?)
      `);
      const insertInput = this.db.prepare(`
        INSERT INTO task_inputs(
          run_id, ordinal, path, artifact_id, material_id, prepared_hash, byte_size,
          selected, selection_reason, series_id, temporal_mode, coverage_start,
          coverage_end, required, priority, source_root_id, source_project_id,
          source_root_path, source_relative_path, catalog_entry_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertObservation = this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, subject_artifact_id, payload_json, created_at)
        VALUES (?, ?, 'task_input_observed', ?, ?, ?)
      `);
      for (const input of inputs) {
        const inputRoot = input.source_root_path ?? root;
        const inputPath = input.source_relative_path ?? input.path;
        let artifactId = null;
        let materialId = null;
        if (input.selected) {
          let artifact = findArtifact.get(inputRoot, inputPath);
          if (!artifact) {
            artifact = { id: `ART-${crypto.randomUUID()}` };
            insertArtifact.run(
              artifact.id,
              runId,
              input.source_project_id ?? null,
              inputPath,
              inputRoot,
              startedAt,
              startedAt,
            );
          }
          artifactId = artifact.id;
          let material = findMaterial.get(artifactId, input.content_hash);
          if (!material) {
            material = { id: `MAT-${crypto.randomUUID()}` };
            insertMaterial.run(
              material.id,
              artifactId,
              input.content_hash,
              input.byte_size,
              this.#storeBlobPath(input.capture.blobPath),
              startedAt,
            );
          }
          materialId = material.id;
        }
        insertInput.run(
          runId,
          input.ordinal,
          input.path,
          artifactId,
          materialId,
          input.content_hash,
          input.byte_size,
          input.selected ? 1 : 0,
          input.selection_reason ?? null,
          input.series ?? null,
          input.temporal_mode ?? null,
          input.coverage?.start ?? null,
          input.coverage?.end ?? null,
          input.required ? 1 : 0,
          input.priority,
          input.source_root_id ?? null,
          input.source_project_id ?? null,
          input.source_root_path ?? null,
          input.source_relative_path ?? null,
          input.catalog_entry_id ?? null,
        );
        insertObservation.run(
          `OBS-${crypto.randomUUID()}`,
          runId,
          artifactId,
          json({
            path: input.path,
            source_root_id: input.source_root_id ?? null,
            source_project_id: input.source_project_id ?? null,
            source_relative_path: input.source_relative_path ?? null,
            content_hash: input.content_hash,
            byte_size: input.byte_size,
            selected: input.selected,
            selection_reason: input.selection_reason ?? null,
            series: input.series ?? null,
            temporal_mode: input.temporal_mode ?? null,
            coverage: input.coverage ?? null,
          }),
          startedAt,
        );
      }

      const temporalPredictionId = `PRD-${crypto.randomUUID()}`;
      const writePredictionId = `PRD-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'task_temporal_relations', ?, ?)
      `).run(temporalPredictionId, runId, json({
        kind: 'task_temporal_relations',
        summary: `${contract.temporal_relations.length} temporal or duplicate relation(s) evaluated.`,
        confidence: contract.temporal_relations.length
          ? Math.min(...contract.temporal_relations.map((relation) => relation.confidence))
          : 1,
        risk: 'low',
        affected_paths: inputs.map((input) => input.path),
        evidence: { relations: contract.temporal_relations },
        proposed_action: 'Read only the selected bounded input set.',
        requires_review: contract.status === 'needs_input',
        source: 'atlas-deterministic',
      }), startedAt);
      this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'task_write_strategy', ?, ?)
      `).run(writePredictionId, runId, json({
        kind: 'task_write_strategy',
        summary: `${contract.write.strategy} ${contract.write.target}.`,
        confidence: contract.write.decision === 'deny' ? 1 : 0.95,
        risk: contract.write.executor === 'guarded_update' ? 'medium' : 'low',
        affected_paths: [contract.write.target],
        evidence: { write: contract.write, read_budget: contract.read.budget },
        proposed_action: contract.write.executor === 'none'
          ? 'Do not execute this unsupported or destructive write.'
          : `Use ${contract.write.executor} under this exact Task Contract.`,
        requires_review: contract.write.executor === 'guarded_update',
        source: 'atlas-deterministic',
      }), startedAt);
      const policyDecision = contract.status === 'blocked'
        ? 'deny'
        : contract.status === 'needs_input' || contract.write.executor === 'guarded_update'
          ? 'warn'
          : 'allow';
      this.db.prepare(`
        INSERT INTO policy_decisions(id, run_id, rule_version_id, decision, reason, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `DEC-${crypto.randomUUID()}`,
        runId,
        TASK_RULE_VERSION_ID,
        policyDecision,
        contract.write.reason,
        json({
          status: contract.status,
          read_scope: contract.read.scope,
          write_scope: contract.write.scope,
          environment_rule_version_id: environmentRuleVersionId,
          questions: contract.questions,
        }),
        startedAt,
      );
      this.#insertEvent(runId, 'task_contract_prepared', {
        contract_id: contractId,
        contract_hash: contractHash,
        selected_inputs: contract.read.selected.length,
        excluded_inputs: contract.read.excluded.length,
        write_strategy: contract.write.strategy,
        executor: contract.write.executor,
      }, startedAt);
      const eligibleRules = contract.attention?.eligible_rules ?? [];
      const appliedRules = contract.attention?.applied_rules ?? [];
      this.#insertEvent(runId, 'task_rule_evaluated', {
        task_id: runId,
        eligible_rule_ids: eligibleRules.map((rule) => rule.rule_id),
        applied_rule_ids: appliedRules.map((rule) => rule.rule_id),
        rule_version_ids: [...new Set(eligibleRules.map((rule) => rule.rule_version_id))].sort(),
        evaluated_at: startedAt,
      }, startedAt);
    });
    return this.getTaskDetail(runId);
  }

  getTaskDetail(runId) {
    const run = this.getRun(runId);
    if (run.mode !== 'task') throw new Error(`Run is not a Task Contract: ${runId}`);
    const row = this.db.prepare(`SELECT * FROM task_contracts WHERE run_id = ?`).get(runId);
    if (!row) throw new Error(`Task Contract run is incomplete: ${runId}`);
    const inputs = this.db.prepare(`
      SELECT ordinal, path, artifact_id, material_id, prepared_hash AS content_hash,
             byte_size, selected, selection_reason, series_id AS series,
             temporal_mode, coverage_start, coverage_end, required, priority,
             source_root_id, source_project_id, source_root_path,
             source_relative_path, catalog_entry_id
      FROM task_inputs WHERE run_id = ? ORDER BY ordinal
    `).all(runId).map((input) => ({
      ...input,
      selected: Boolean(input.selected),
      required: Boolean(input.required),
      coverage: input.coverage_start || input.coverage_end
        ? { start: input.coverage_start, end: input.coverage_end }
        : null,
      coverage_start: undefined,
      coverage_end: undefined,
    }));
    const predictions = this.db.prepare(`
      SELECT id, kind, payload_json, created_at FROM predictions
      WHERE run_id = ? ORDER BY rowid
    `).all(runId).map((prediction) => ({
      id: prediction.id,
      kind: prediction.kind,
      ...parseJson(prediction.payload_json, {}),
      created_at: prediction.created_at,
    }));
    const decisions = this.db.prepare(`
      SELECT id, rule_version_id, decision, reason, details_json, created_at
      FROM policy_decisions WHERE run_id = ? ORDER BY rowid
    `).all(runId).map((decision) => ({
      id: decision.id,
      rule_version_id: decision.rule_version_id,
      decision: decision.decision,
      reason: decision.reason,
      details: parseJson(decision.details_json, {}),
      created_at: decision.created_at,
    }));
    const events = this.db.prepare(`
      SELECT event_type, payload_json, occurred_at FROM operation_events
      WHERE run_id = ? ORDER BY occurred_at, rowid
    `).all(runId).map((event) => ({
      type: event.event_type,
      payload: parseJson(event.payload_json, {}),
      occurred_at: event.occurred_at,
    }));
    const ruleApplicationReviews = this.db.prepare(`
      SELECT id, value, details_json, created_at
      FROM labels
      WHERE run_id = ? AND name = 'task_rule_application_review'
      ORDER BY created_at, rowid
    `).all(runId).map((label) => ({
      label_id: label.id,
      decision: label.value,
      ...parseJson(label.details_json, {}),
      reviewed_at: label.created_at,
    }));
    const completionReceipt = parseJson(row.completion_receipt_json);
    const lineage = completionReceipt?.output_material_id ? this.db.prepare(`
      SELECT md.output_material_id, md.input_material_id, md.run_id,
             md.relation_type, md.ordinal, ti.path AS input_path, md.created_at
      FROM material_derivations md
      JOIN task_inputs ti ON ti.run_id = ? AND ti.material_id = md.input_material_id
      WHERE md.output_material_id = ? ORDER BY md.ordinal
    `).all(runId, completionReceipt.output_material_id) : [];
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
        rolled_back_at: run.rolled_back_at,
      },
      contract_id: row.contract_id,
      contract_hash: row.contract_hash,
      project_id: row.project_id,
      project_path: row.project_path,
      environment_rule_version_id: row.environment_rule_version_id,
      candidate_set_id: row.candidate_set_id,
      source_set_id: row.source_set_id,
      write_root_id: row.write_root_id,
      request: parseJson(row.request_json, {}),
      contract: parseJson(row.contract_json, {}),
      inputs,
      predictions,
      policy_decisions: decisions,
      underlying_run_id: row.underlying_run_id,
      completion_receipt: completionReceipt,
      rollback_receipt: parseJson(run.rollback_receipt_json),
      output: completionReceipt ? { receipt: completionReceipt, lineage } : null,
      rule_application_reviews: ruleApplicationReviews,
      events,
    };
  }

  reviewTaskRuleApplication(runId, { ruleId, decision, reason }) {
    if (!['accepted', 'corrected'].includes(decision)) {
      throw new Error('Task rule review decision must be accepted or corrected.');
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error('Task rule review requires a reason.');
    }
    const detail = this.getTaskDetail(runId);
    const eligibleRules = detail.contract.attention?.eligible_rules ?? [];
    const rule = eligibleRules.find((item) => item.rule_id === ruleId);
    if (!rule) throw new Error(`Rule was not eligible for Task ${runId}: ${ruleId}`);
    const applied = (detail.contract.attention?.applied_rules ?? [])
      .some((item) => item.rule_id === ruleId);
    const existing = detail.rule_application_reviews.find((item) => (
      item.rule_id === ruleId
      && item.decision === decision
      && item.reason === reason.trim()
    ));
    if (existing) return {
      task_id: runId,
      label_id: existing.label_id,
      rule_id: ruleId,
      rule_version_id: rule.rule_version_id,
      eligible: true,
      applied,
      decision,
      reason: reason.trim(),
      reviewed_at: existing.reviewed_at,
      idempotent: true,
    };
    const reviewedAt = now();
    const labelId = `LBL-${crypto.randomUUID()}`;
    const receipt = {
      task_id: runId,
      label_id: labelId,
      rule_id: ruleId,
      rule_version_id: rule.rule_version_id,
      eligible: true,
      applied,
      decision,
      reason: reason.trim(),
      reviewed_at: reviewedAt,
      idempotent: false,
    };
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO labels(
          id, run_id, subject_prediction_id, name, value, source, details_json, created_at
        ) VALUES (?, ?, NULL, 'task_rule_application_review', ?, 'user', ?, ?)
      `).run(labelId, runId, decision, json(receipt), reviewedAt);
      this.#insertEvent(runId, 'task_rule_review_recorded', receipt, reviewedAt);
      return receipt;
    });
  }

  claimTaskFulfillment(runId, claimToken, processId, occurredAt, plannedWriteRunId = null) {
    return this.transaction(() => {
      const task = this.db.prepare(`SELECT underlying_run_id FROM task_contracts WHERE run_id = ?`).get(runId);
      if (!task) throw new Error(`Task Contract not found: ${runId}`);
      if (task.underlying_run_id) return { status: 'staged', write_run_id: task.underlying_run_id };
      const existing = this.db.prepare(`
        SELECT claim_token, process_id, status, planned_write_run_id, write_run_id
        FROM task_fulfillment_claims WHERE task_run_id = ?
      `).get(runId);
      if (existing) {
        if (existing.write_run_id) return { status: 'staged', write_run_id: existing.write_run_id };
        if (existing.planned_write_run_id && this.db.prepare('SELECT id FROM runs WHERE id = ?').get(existing.planned_write_run_id)) {
          this.db.prepare(`UPDATE task_contracts SET underlying_run_id = ? WHERE run_id = ?`)
            .run(existing.planned_write_run_id, runId);
          this.db.prepare(`
            UPDATE task_fulfillment_claims SET status = 'staged', write_run_id = ?, updated_at = ?
            WHERE task_run_id = ?
          `).run(existing.planned_write_run_id, occurredAt, runId);
          this.#insertEvent(runId, 'task_write_reconciled_from_claim', {
            write_run_id: existing.planned_write_run_id,
          }, occurredAt);
          return { status: 'staged', write_run_id: existing.planned_write_run_id };
        }
        if (existing.claim_token === claimToken && existing.status === 'active') {
          return { status: 'acquired', planned_write_run_id: existing.planned_write_run_id };
        }
        if (existing.status === 'active' && !isProcessAlive(existing.process_id)) {
          const resumedPlan = existing.planned_write_run_id ?? plannedWriteRunId;
          this.db.prepare(`
            UPDATE task_fulfillment_claims
            SET claim_token = ?, process_id = ?, status = 'active', planned_write_run_id = ?, updated_at = ?
            WHERE task_run_id = ?
          `).run(claimToken, processId, resumedPlan, occurredAt, runId);
          this.#insertEvent(runId, 'task_fulfillment_claim_reclaimed', {
            abandoned_claim_token: existing.claim_token,
            abandoned_process_id: existing.process_id,
            replacement_claim_token: claimToken,
            planned_write_run_id: resumedPlan,
          }, occurredAt);
          return { status: 'acquired', planned_write_run_id: resumedPlan };
        } else {
          const error = new Error(`Task Contract is already being fulfilled by process ${existing.process_id}.`);
          error.code = 'ATLAS_STATE_CONFLICT';
          throw error;
        }
      }
      this.db.prepare(`
        INSERT INTO task_fulfillment_claims(
          task_run_id, claim_token, process_id, status, planned_write_run_id, claimed_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(runId, claimToken, processId, plannedWriteRunId, occurredAt, occurredAt);
      this.#insertEvent(runId, 'task_fulfillment_claimed', {
        claim_token: claimToken, process_id: processId, planned_write_run_id: plannedWriteRunId,
      }, occurredAt);
      return { status: 'acquired', planned_write_run_id: plannedWriteRunId };
    });
  }

  releaseTaskFulfillmentClaim(runId, claimToken, occurredAt) {
    return this.transaction(() => {
      const claim = this.db.prepare(`
        SELECT claim_token, write_run_id FROM task_fulfillment_claims WHERE task_run_id = ?
      `).get(runId);
      if (!claim || claim.claim_token !== claimToken || claim.write_run_id) return false;
      this.db.prepare(`DELETE FROM task_fulfillment_claims WHERE task_run_id = ?`).run(runId);
      this.#insertEvent(runId, 'task_fulfillment_claim_released', { claim_token: claimToken }, occurredAt);
      return true;
    });
  }

  recordTaskUnderlyingRun(runId, writeRunId, occurredAt, claimToken = null) {
    return this.transaction(() => {
      const task = this.db.prepare(`SELECT underlying_run_id FROM task_contracts WHERE run_id = ?`).get(runId);
      if (!task) throw new Error(`Task Contract not found: ${runId}`);
      if (task.underlying_run_id && task.underlying_run_id !== writeRunId) {
        const error = new Error(`Task Contract already staged another write run: ${task.underlying_run_id}`);
        error.code = 'ATLAS_STATE_CONFLICT';
        throw error;
      }
      if (!task.underlying_run_id) {
        if (claimToken != null) {
          const claim = this.db.prepare(`
            SELECT claim_token, status, planned_write_run_id FROM task_fulfillment_claims WHERE task_run_id = ?
          `).get(runId);
          if (!claim || claim.claim_token !== claimToken || claim.status !== 'active') {
            const error = new Error('Task fulfillment claim is missing or owned by another process.');
            error.code = 'ATLAS_STATE_CONFLICT';
            throw error;
          }
          if (claim.planned_write_run_id && claim.planned_write_run_id !== writeRunId) {
            const error = new Error('Task fulfillment produced a write run different from its claimed run.');
            error.code = 'ATLAS_STATE_CONFLICT';
            throw error;
          }
        }
        this.db.prepare(`UPDATE task_contracts SET underlying_run_id = ? WHERE run_id = ?`)
          .run(writeRunId, runId);
        if (claimToken != null) {
          this.db.prepare(`
            UPDATE task_fulfillment_claims
            SET status = 'staged', write_run_id = ?, updated_at = ?
            WHERE task_run_id = ? AND claim_token = ?
          `).run(writeRunId, occurredAt, runId, claimToken);
        }
        this.#insertEvent(runId, 'task_write_staged', { write_run_id: writeRunId }, occurredAt);
      }
      return this.getTaskDetail(runId);
    });
  }

  getActiveArtifactContext(rootPath, currentPath) {
    const artifact = this.db.prepare(`
      SELECT id, project_id, role, status, created_at, updated_at
      FROM artifacts
      WHERE root_path = ? AND current_path = ? AND status = 'active'
      ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get(rootPath, currentPath);
    if (!artifact) return null;
    const material = this.db.prepare(`
      SELECT id, content_hash, byte_size, stage, created_at
      FROM materials WHERE artifact_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(artifact.id);
    const lineage = material ? this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM material_derivations WHERE input_material_id = ?) AS downstream_count,
        (SELECT COUNT(*) FROM material_derivations WHERE output_material_id = ?) AS input_count
    `).get(material.id, material.id) : { downstream_count: 0, input_count: 0 };
    return {
      artifact_id: artifact.id,
      project_id: artifact.project_id,
      role: artifact.role,
      material: material ? {
        material_id: material.id,
        content_hash: material.content_hash,
        byte_size: material.byte_size,
        stage: material.stage,
        created_at: material.created_at,
      } : null,
      lineage,
    };
  }

  markTaskStale(runId, payload, occurredAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status === 'stale') return this.getTaskDetail(runId);
      if (run.status !== 'ready') {
        throw new Error(`Only a ready Task Contract can become stale; current status is ${run.status}.`);
      }
      this.db.prepare(`UPDATE runs SET status = 'stale' WHERE id = ?`).run(runId);
      this.#insertEvent(runId, 'task_contract_invalidated', payload, occurredAt);
      return this.getTaskDetail(runId);
    });
  }

  completeTaskContract(runId, {
    writeRunId,
    outputArtifactId,
    outputMaterialId,
    targetPath,
    relationType,
    writeMode,
    completedAt,
  }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      const task = this.db.prepare(`SELECT * FROM task_contracts WHERE run_id = ?`).get(runId);
      const existing = parseJson(task.completion_receipt_json);
      if (existing) return existing;
      if (run.status !== 'ready') {
        throw new Error(`Task completion requires ready status; current status is ${run.status}.`);
      }
      if (task.underlying_run_id && task.underlying_run_id !== writeRunId) {
        const error = new Error(`Task Contract write run mismatch: ${task.underlying_run_id}`);
        error.code = 'ATLAS_STATE_CONFLICT';
        throw error;
      }
      const inputs = this.db.prepare(`
        SELECT material_id, ordinal FROM task_inputs
        WHERE run_id = ? AND selected = 1 ORDER BY ordinal
      `).all(runId);
      const insertDerivation = this.db.prepare(`
        INSERT OR IGNORE INTO material_derivations(
          output_material_id, input_material_id, run_id, relation_type, ordinal, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const input of inputs) {
        insertDerivation.run(
          outputMaterialId,
          input.material_id,
          writeRunId,
          relationType,
          input.ordinal,
          completedAt,
        );
      }
      const receipt = {
        task_id: runId,
        contract_id: task.contract_id,
        status: 'completed',
        write_run_id: writeRunId,
        write_mode: writeMode,
        target: targetPath,
        output_artifact_id: outputArtifactId,
        output_material_id: outputMaterialId,
        relation_type: relationType,
        selected_inputs: inputs.length,
        verified: true,
        rollback_ready: true,
        completed_at: completedAt,
      };
      this.db.prepare(`
        UPDATE task_contracts
        SET underlying_run_id = ?, completion_receipt_json = ?, completed_at = ?
        WHERE run_id = ?
      `).run(writeRunId, json(receipt), completedAt, runId);
      this.db.prepare(`
        UPDATE runs SET status = 'completed', closed_at = ?, receipt_json = ? WHERE id = ?
      `).run(completedAt, json(receipt), runId);
      this.#insertEvent(runId, 'task_completed_and_verified', receipt, completedAt);
      return receipt;
    });
  }

  finishTaskRollback(runId, receipt, rolledBackAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.rollback_receipt_json) return parseJson(run.rollback_receipt_json);
      if (run.status !== 'completed') {
        throw new Error(`Only a completed Task Contract can be rolled back; current status is ${run.status}.`);
      }
      this.db.prepare(`
        UPDATE runs SET status = 'rolled_back', rolled_back_at = ?, rollback_receipt_json = ?
        WHERE id = ?
      `).run(rolledBackAt, json(receipt), runId);
      this.#insertEvent(runId, 'task_rollback_completed', receipt, rolledBackAt);
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
      const effectiveRuleVersionId = placementPolicy?.routing_rule_version_id
        ?? placementPolicy?.rule_version_id
        ?? RISK_RULE_VERSION_ID;
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
          run_id, ordinal, path, artifact_id, material_id, prepared_hash,
          source_root_id, source_project_id, source_root_path, source_relative_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertObservation = this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, subject_artifact_id, payload_json, created_at)
        VALUES (?, ?, 'derived_input_captured', ?, ?, ?)
      `);
      const inputRecords = [];
      inputs.forEach((input, ordinal) => {
        const inputRoot = input.sourceRootPath ?? root;
        const inputPath = input.sourceRelativePath ?? input.path;
        let artifact = findArtifact.get(inputRoot, inputPath);
        if (!artifact) {
          artifact = { id: `ART-${crypto.randomUUID()}` };
          insertArtifact.run(artifact.id, runId, inputPath, inputRoot, startedAt, startedAt);
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
        insertInput.run(
          runId,
          ordinal,
          input.path,
          artifact.id,
          material.id,
          input.contentHash,
          input.sourceRootId ?? null,
          input.sourceProjectId ?? null,
          input.sourceRootPath ?? null,
          input.sourceRelativePath ?? null,
        );
        insertObservation.run(
          `OBS-${crypto.randomUUID()}`,
          runId,
          artifact.id,
          json({
            path: input.path,
            source_root_id: input.sourceRootId ?? null,
            source_project_id: input.sourceProjectId ?? null,
            source_relative_path: input.sourceRelativePath ?? null,
            content_hash: input.contentHash,
            material_id: material.id,
          }),
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
             a.role AS artifact_role, di.source_root_id, di.source_project_id,
             di.source_root_path, di.source_relative_path
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
      this.#insertRollbackOutcome(runId, {
        outcome: 'completed',
        reasonCode: 'restored_and_verified',
        details: { removed_files: receipt.removed_files ?? null },
      }, rolledBackAt);
      return receipt;
    });
  }

  findPortfolioInventory(root, fingerprint) {
    return this.db.prepare(`
      SELECT r.id, r.receipt_json
      FROM runs r
      JOIN portfolio_inventories p ON p.run_id = r.id
      WHERE r.mode = 'portfolio' AND r.root_path = ? AND p.fingerprint = ?
      ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
    `).get(root, fingerprint) ?? null;
  }

  createPortfolioInventory({ runId, root, fingerprint, depth, excluded, expanded, roots, summary, receipt, caller = {}, startedAt }) {
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        PORTFOLIO_RULE_VERSION_ID,
        'Portfolio root classification and planning policy',
        '1.0.0',
        json({
          structure_only: true,
          uncertain_roots_never_move: true,
          installed_software_never_moves: true,
          review_required_before_related_mapping: true,
        }),
        startedAt,
      );
      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at, receipt_json
        ) VALUES (?, 'portfolio', 'inventoried', ?, 'Inventory multiple filesystem roots', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, root, caller.actor ?? 'unknown', caller.agent ?? null, caller.model ?? null,
        caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        PORTFOLIO_RULE_VERSION_ID, startedAt, json(receipt),
      );
      this.db.prepare(`
        INSERT INTO portfolio_inventories(run_id, fingerprint, depth, excluded_json, expanded_json, summary_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(runId, fingerprint, depth, json(excluded), json(expanded), json(summary));

      const findRoot = this.db.prepare(`
        SELECT id FROM portfolio_roots WHERE current_path = ? COLLATE NOCASE
      `);
      const insertRoot = this.db.prepare(`
        INSERT INTO portfolio_roots(id, current_path, status, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?)
      `);
      const insertHistory = this.db.prepare(`
        INSERT INTO portfolio_root_path_history(root_id, path, valid_from, reason)
        VALUES (?, ?, ?, 'portfolio_inventory')
      `);
      const insertObservation = this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'portfolio_root_observed', ?, ?)
      `);
      const insertPrediction = this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertInventoryRoot = this.db.prepare(`
        INSERT INTO portfolio_inventory_roots(
          inventory_run_id, root_id, relative_path, observation_json,
          type_prediction_id, relation_prediction_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const item of roots) {
        let rootId = findRoot.get(item.current_path)?.id ?? null;
        if (!rootId) {
          rootId = `ROOT-${crypto.randomUUID()}`;
          insertRoot.run(rootId, item.current_path, startedAt, startedAt);
          insertHistory.run(rootId, item.current_path, startedAt);
        }
        const observation = { ...item, root_id: rootId };
        const typePredictionId = `PRD-${crypto.randomUUID()}`;
        const relationPredictionId = `PRD-${crypto.randomUUID()}`;
        insertObservation.run(`OBS-${crypto.randomUUID()}`, runId, json(observation), startedAt);
        insertPrediction.run(typePredictionId, runId, 'portfolio_root_type', json({
          root_id: rootId,
          current_path: item.current_path,
          predicted_type: item.predicted_type,
          confidence: item.type_confidence,
          candidate_types: item.candidate_types,
          evidence: item.evidence,
        }), startedAt);
        insertPrediction.run(relationPredictionId, runId, 'portfolio_root_relation', json({
          root_id: rootId,
          current_path: item.current_path,
          predicted_relation: item.predicted_relation,
          confidence: item.relation_confidence,
          evidence: item.evidence,
        }), startedAt);
        insertInventoryRoot.run(
          runId, rootId, item.relative_path, json(observation),
          typePredictionId, relationPredictionId,
        );
      }
      this.#insertEvent(runId, 'portfolio_inventory_completed', receipt, startedAt);
    });
  }

  getPortfolioDetail(runId) {
    const run = this.getRun(runId);
    if (run.mode !== 'portfolio') throw new Error(`Run is not a Portfolio inventory: ${runId}`);
    const inventory = this.db.prepare(`
      SELECT fingerprint, depth, excluded_json, expanded_json, summary_json
      FROM portfolio_inventories WHERE run_id = ?
    `).get(runId);
    if (!inventory) throw new Error(`Portfolio inventory not found: ${runId}`);
    const labels = this.db.prepare(`
      SELECT subject_prediction_id, value, details_json, created_at
      FROM labels WHERE run_id = ? AND subject_prediction_id IS NOT NULL
      ORDER BY rowid
    `).all(runId);
    const latestLabels = new Map(labels.map((row) => [row.subject_prediction_id, row]));
    const roots = this.db.prepare(`
      SELECT pir.root_id, pir.relative_path, pir.observation_json,
             pir.type_prediction_id, tp.payload_json AS type_prediction_json,
             pir.relation_prediction_id, rp.payload_json AS relation_prediction_json
      FROM portfolio_inventory_roots pir
      JOIN predictions tp ON tp.id = pir.type_prediction_id
      JOIN predictions rp ON rp.id = pir.relation_prediction_id
      WHERE pir.inventory_run_id = ?
      ORDER BY pir.relative_path COLLATE NOCASE
    `).all(runId).map((row) => {
      const observation = parseJson(row.observation_json, {});
      const typePrediction = parseJson(row.type_prediction_json, {});
      const relationPrediction = parseJson(row.relation_prediction_json, {});
      const typeLabel = latestLabels.get(row.type_prediction_id);
      const relationLabel = latestLabels.get(row.relation_prediction_id);
      return {
        ...observation,
        root_id: row.root_id,
        predicted_type: typePrediction.predicted_type,
        type_confidence: typePrediction.confidence,
        candidate_types: typePrediction.candidate_types ?? [],
        predicted_relation: relationPrediction.predicted_relation,
        relation_confidence: relationPrediction.confidence,
        prediction_ids: {
          root_type: row.type_prediction_id,
          relation: row.relation_prediction_id,
        },
        review: typeLabel || relationLabel ? {
          root_type: typeLabel?.value ?? null,
          relation: relationLabel?.value ?? null,
          reason: parseJson(typeLabel?.details_json ?? relationLabel?.details_json, {}).reason ?? null,
          reviewed_at: typeLabel?.created_at ?? relationLabel?.created_at ?? null,
        } : null,
      };
    });
    const plans = this.db.prepare(`
      SELECT id, target_root, plan_hash, plan_json, created_at
      FROM portfolio_plans WHERE inventory_run_id = ? ORDER BY created_at, rowid
    `).all(runId).map((row) => ({
      id: row.id,
      target_root: row.target_root,
      plan_hash: row.plan_hash,
      plan: parseJson(row.plan_json, {}),
      created_at: row.created_at,
    }));
    return {
      inventory: {
        id: run.id,
        status: run.status,
        root_path: run.root_path,
        fingerprint: inventory.fingerprint,
        depth: Number(inventory.depth),
        excluded: parseJson(inventory.excluded_json, []),
        expanded: parseJson(inventory.expanded_json, []),
        started_at: run.started_at,
        caller: {
          actor: run.actor, agent: run.agent, model: run.model,
          tool: run.tool, client_run_id: run.client_run_id,
        },
      },
      summary: parseJson(inventory.summary_json, {}),
      roots,
      plans,
      receipt: parseJson(run.receipt_json, {}),
    };
  }

  reviewPortfolioRoot(runId, { rootId, rootType, relation, reason, reviewedAt }) {
    return this.transaction(() => {
      const entry = this.db.prepare(`
        SELECT type_prediction_id, relation_prediction_id
        FROM portfolio_inventory_roots
        WHERE inventory_run_id = ? AND root_id = ?
      `).get(runId, rootId);
      if (!entry) throw new Error(`Portfolio root not found in inventory ${runId}: ${rootId}`);
      const insert = this.db.prepare(`
        INSERT INTO labels(
          id, run_id, subject_prediction_id, name, value, source, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?)
      `);
      const typeLabelId = `LBL-${crypto.randomUUID()}`;
      const relationLabelId = `LBL-${crypto.randomUUID()}`;
      insert.run(
        typeLabelId, runId, entry.type_prediction_id, 'portfolio_root_type_review',
        rootType, json({ reason, root_id: rootId }), reviewedAt,
      );
      insert.run(
        relationLabelId, runId, entry.relation_prediction_id, 'portfolio_root_relation_review',
        relation, json({ reason, root_id: rootId }), reviewedAt,
      );
      const receipt = {
        inventory_id: runId,
        root_id: rootId,
        status: 'reviewed',
        root_type: rootType,
        relation,
        reason,
        label_ids: [typeLabelId, relationLabelId],
        reviewed_at: reviewedAt,
      };
      this.#insertEvent(runId, 'portfolio_root_reviewed', receipt, reviewedAt);
      return receipt;
    });
  }

  savePortfolioPlan(runId, { targetRoot, planHash, plan, createdAt }) {
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT id, plan_json, created_at FROM portfolio_plans
        WHERE inventory_run_id = ? AND target_root = ? COLLATE NOCASE AND plan_hash = ?
      `).get(runId, targetRoot, planHash);
      if (existing) return {
        ...parseJson(existing.plan_json, {}),
        plan_id: existing.id,
        reused: true,
        created_at: existing.created_at,
      };
      const run = this.getRun(runId);
      if (run.mode !== 'portfolio') throw new Error(`Run is not a Portfolio inventory: ${runId}`);
      const planId = `PPL-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO portfolio_plans(id, inventory_run_id, target_root, plan_hash, plan_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(planId, runId, targetRoot, planHash, json(plan), createdAt);
      this.db.prepare(`
        INSERT INTO policy_decisions(
          id, run_id, rule_version_id, decision, reason, details_json, created_at
        ) VALUES (?, ?, ?, 'warn', ?, ?, ?)
      `).run(
        `POL-${crypto.randomUUID()}`, runId, PORTFOLIO_RULE_VERSION_ID,
        'Portfolio plan is read-only and does not authorize source movement.',
        json({ plan_id: planId, target_root: targetRoot, plan_hash: planHash }), createdAt,
      );
      this.#insertEvent(runId, 'portfolio_plan_created', {
        plan_id: planId, target_root: targetRoot, plan_hash: planHash,
      }, createdAt);
      return { ...plan, plan_id: planId, reused: false, created_at: createdAt };
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
      library_contract: policy.library_contract ?? null,
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
      library_contract: policy.library_contract ?? null,
      policy,
      policy_json: undefined,
    };
  }

  createRoutingCorrection({
    root, scopeType, scopeKey, origin, kind, role, targetSubdirectory,
    reason, caller = {}, createdAt = now(),
  }) {
    const definition = {
      schema: 'atlas-routing-correction.v1',
      root_path: path.resolve(root),
      scope: scopeType,
      scope_key: scopeKey,
      origin,
      kind,
      role,
      target_subdirectory: targetSubdirectory,
    };
    const definitionJson = json(definition);
    const definitionHash = crypto.createHash('sha256').update(definitionJson).digest('hex');
    const ruleVersionId = `RULE-ROUTE-${definitionHash.slice(0, 16).toUpperCase()}`;
    const existing = this.db.prepare(`
      SELECT * FROM routing_corrections
      WHERE root_path = ? AND scope_type = ? AND scope_key = ?
        AND origin = ? AND kind = ? AND status = 'active'
    `).get(definition.root_path, scopeType, scopeKey, origin, kind);
    if (existing && existing.rule_version_id === ruleVersionId) {
      return {
        correction_id: existing.id,
        run_id: existing.run_id,
        rule_version_id: existing.rule_version_id,
        scope: existing.scope_type,
        scope_key: existing.scope_key,
        origin: existing.origin,
        kind: existing.kind,
        role: existing.role,
        target_subdirectory: existing.target_subdirectory,
        status: existing.status,
        reused: true,
      };
    }
    const runId = `RUL-${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    const correctionId = `COR-${crypto.randomUUID()}`;
    const predictionId = `PRD-${crypto.randomUUID()}`;
    const receipt = {
      correction_id: correctionId,
      run_id: runId,
      rule_version_id: ruleVersionId,
      scope: scopeType,
      scope_key: scopeKey,
      origin,
      kind,
      role,
      target_subdirectory: targetSubdirectory,
      status: 'active',
      reused: false,
    };
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Reviewed Intake routing correction', '1.0.0', ?, ?)
      `).run(ruleVersionId, definitionJson, createdAt);
      this.db.prepare(`
        UPDATE routing_corrections SET status = 'superseded', superseded_at = ?
        WHERE root_path = ? AND scope_type = ? AND scope_key = ?
          AND origin = ? AND kind = ? AND status = 'active'
      `).run(createdAt, definition.root_path, scopeType, scopeKey, origin, kind);
      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at, closed_at, receipt_json
        ) VALUES (?, 'rule_correction', 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, definition.root_path, reason,
        caller.actor ?? 'unknown', caller.agent ?? null, caller.model ?? null,
        caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        ruleVersionId, createdAt, createdAt, json(receipt),
      );
      this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'routing_rule_correction', ?, ?)
      `).run(predictionId, runId, definitionJson, createdAt);
      this.db.prepare(`
        INSERT INTO labels(
          id, run_id, subject_prediction_id, name, value, source, details_json, created_at
        ) VALUES (?, ?, ?, 'routing_rule_correction', 'corrected', 'user', ?, ?)
      `).run(`LBL-${crypto.randomUUID()}`, runId, predictionId, json({ reason, scope: scopeType }), createdAt);
      this.db.prepare(`
        INSERT INTO policy_decisions(
          id, run_id, rule_version_id, decision, reason, details_json, created_at
        ) VALUES (?, ?, ?, 'allow', ?, ?, ?)
      `).run(
        `POL-${crypto.randomUUID()}`, runId, ruleVersionId,
        `Reviewed routing correction: ${reason}`, json({ scope: scopeType, scope_key: scopeKey }), createdAt,
      );
      this.db.prepare(`
        INSERT INTO routing_corrections(
          id, run_id, root_path, scope_type, scope_key, origin, kind, role,
          target_subdirectory, rule_version_id, status, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        correctionId, runId, definition.root_path, scopeType, scopeKey, origin, kind,
        role, targetSubdirectory, ruleVersionId, reason, createdAt,
      );
      this.#insertEvent(runId, 'routing_correction_activated', receipt, createdAt);
    });
    return receipt;
  }

  findRoutingCorrection({ root, origin, kind, candidateHash = null, projectId = null }) {
    const rows = this.db.prepare(`
      SELECT * FROM routing_corrections
      WHERE root_path = ? AND origin = ? AND kind = ? AND status = 'active'
      ORDER BY created_at DESC, rowid DESC
    `).all(path.resolve(root), origin, kind);
    const selected = rows.find((row) => row.scope_type === 'artifact' && row.scope_key === `sha256:${candidateHash}`)
      ?? rows.find((row) => row.scope_type === 'project' && row.scope_key === projectId)
      ?? rows.find((row) => row.scope_type === 'global' && row.scope_key === '*')
      ?? null;
    if (!selected) return null;
    return {
      correction_id: selected.id,
      run_id: selected.run_id,
      rule_version_id: selected.rule_version_id,
      scope: selected.scope_type,
      scope_key: selected.scope_key,
      origin: selected.origin,
      kind: selected.kind,
      role: selected.role,
      target_subdirectory: selected.target_subdirectory,
      status: selected.status,
      reason: selected.reason,
    };
  }

  listRoutingCorrections(root) {
    return this.db.prepare(`
      SELECT id AS correction_id, run_id, rule_version_id, scope_type AS scope,
             scope_key, origin, kind, role, target_subdirectory, status, reason, created_at, superseded_at
      FROM routing_corrections WHERE root_path = ? ORDER BY created_at, rowid
    `).all(path.resolve(root));
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
        VALUES (?, ?, ?, ?, ?)
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
          insertArtifact.run(artifactId, runId, entry.kind, entry.path, closedAt);
          artifact = { id: artifactId };
        }

        let materialId = null;
        const changed = changedByPath.get(entry.path);
        if (changed && entry.kind === 'file') {
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
      this.#insertRollbackOutcome(runId, {
        outcome: 'completed',
        reasonCode: 'restored_and_verified',
        details: { restored_files: receipt.restored_files ?? null },
      }, rolledBackAt);
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

  recordRollbackError(runId, error) {
    const conflict = error?.code === 'ATLAS_ROLLBACK_CONFLICT'
      || error?.code === 'ATLAS_STATE_CONFLICT';
    let reasonCode = 'rollback_execution_error';
    if (error?.code === 'ATLAS_STATE_CONFLICT') reasonCode = 'state_changed_after_execution';
    else if (error?.code === 'ATLAS_ROLLBACK_CONFLICT') {
      reasonCode = error.conflicts?.some((item) => item.kind === 'downstream_dependency')
        ? 'downstream_dependency'
        : 'later_file_state_conflict';
    } else if (typeof error?.code === 'string' && error.code) {
      reasonCode = error.code.toLowerCase();
    }
    return this.recordRollbackOutcome(runId, {
      outcome: conflict ? 'conflict_safe_stop' : 'failed',
      reasonCode,
      details: {
        error_code: error?.code ?? null,
        message: error?.message ?? String(error),
        conflicts: Array.isArray(error?.conflicts) ? error.conflicts : [],
      },
    });
  }

  recordRollbackOutcome(runId, {
    outcome,
    reasonCode,
    details = {},
  }, occurredAt = now()) {
    return this.transaction(() => this.#insertRollbackOutcome(
      runId,
      { outcome, reasonCode, details },
      occurredAt,
    ));
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

  #insertRollbackOutcome(runId, { outcome, reasonCode, details }, occurredAt) {
    const allowed = new Set(['completed', 'conflict_safe_stop', 'failed', 'cancelled']);
    if (!allowed.has(outcome)) throw new Error(`Unsupported rollback outcome: ${outcome}`);
    if (typeof reasonCode !== 'string' || !reasonCode.trim()) {
      throw new Error('Rollback outcome requires reason_code.');
    }
    this.getRun(runId);
    const attemptId = `RBK-${crypto.createHash('sha256').update(runId).digest('hex').slice(0, 20).toUpperCase()}`;
    const eventId = `EVT-RBK-${crypto.createHash('sha256')
      .update(`${attemptId}:${outcome}:${reasonCode}`)
      .digest('hex')
      .slice(0, 24)
      .toUpperCase()}`;
    const payload = {
      operation: 'rollback',
      outcome,
      reason_code: reasonCode,
      run_id: runId,
      attempt_id: attemptId,
      details,
    };
    this.db.prepare(`
      INSERT OR IGNORE INTO operation_events(id, run_id, event_type, payload_json, occurred_at)
      VALUES (?, ?, 'rollback_outcome_recorded', ?, ?)
    `).run(eventId, runId, json(payload), occurredAt);
    return payload;
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

  listRuns({ limit = null } = {}) {
    const query = `
      SELECT id, mode, status, root_path, actor, agent, model, tool, client_run_id,
             started_at, closed_at, aborted_at, rolled_back_at
      FROM runs ORDER BY started_at DESC
    `;
    if (limit === null) return this.db.prepare(query).all();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Run list limit must be an integer from 1 to 100.');
    }
    return this.db.prepare(`${query} LIMIT ?`).all(limit);
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

  readAnalyticsSource() {
    this.db.exec('BEGIN;');
    try {
      const source = {
        ledgerSchema: this.db.prepare('PRAGMA user_version').get().user_version,
        runs: this.db.prepare(`
          SELECT id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
                 rule_version_id, started_at, closed_at, aborted_at, rolled_back_at,
                 receipt_json, abort_receipt_json, rollback_receipt_json
          FROM runs ORDER BY started_at, id
        `).all(),
        predictions: this.db.prepare(`
          SELECT id, run_id, kind, payload_json, created_at
          FROM predictions ORDER BY created_at, id
        `).all(),
        labels: this.db.prepare(`
          SELECT id, run_id, subject_prediction_id, name, value, source, details_json, created_at
          FROM labels ORDER BY created_at, id
        `).all(),
        policyDecisions: this.db.prepare(`
          SELECT id, run_id, rule_version_id, decision, reason, details_json, created_at
          FROM policy_decisions ORDER BY created_at, id
        `).all(),
        operationEvents: this.db.prepare(`
          SELECT id, run_id, event_type, payload_json, occurred_at
          FROM operation_events ORDER BY occurred_at, id
        `).all(),
        ruleVersions: this.db.prepare(`
          SELECT id, name, version, definition_json, created_at
          FROM rule_versions ORDER BY created_at, id
        `).all(),
        preferenceRules: this.db.prepare(`
          SELECT id, run_id, scope_type, scope_key, kind, condition_hash, condition_json,
                 value_json, priority, rule_version_id, status, summary, basis,
                 evidence_json, created_at, superseded_at
          FROM preference_rules ORDER BY created_at, id
        `).all(),
        taskContracts: this.db.prepare(`
          SELECT tc.run_id, r.started_at, tc.contract_id, tc.project_id, tc.environment_rule_version_id,
                 tc.contract_hash, tc.request_json, tc.contract_json, tc.underlying_run_id,
                 tc.completion_receipt_json, tc.completed_at,
                 COUNT(ti.ordinal) AS input_count,
                 COALESCE(SUM(CASE WHEN ti.selected = 1 THEN 1 ELSE 0 END), 0) AS selected_count,
                 COALESCE(SUM(CASE WHEN ti.selected = 0 THEN 1 ELSE 0 END), 0) AS excluded_count,
                 COALESCE(SUM(ti.byte_size), 0) AS input_bytes,
                 COALESCE(SUM(CASE WHEN ti.selected = 1 THEN ti.byte_size ELSE 0 END), 0) AS selected_bytes
          FROM task_contracts tc
          JOIN runs r ON r.id = tc.run_id
          LEFT JOIN task_inputs ti ON ti.run_id = tc.run_id
          GROUP BY tc.run_id
          ORDER BY tc.run_id
        `).all(),
        changes: this.db.prepare(`
          SELECT c.id, cs.run_id, r.started_at, c.path, c.change_type, c.allowed,
                 c.before_kind, c.before_hash, c.after_kind, c.after_hash
          FROM changes c
          JOIN change_sets cs ON cs.id = c.change_set_id
          JOIN runs r ON r.id = cs.run_id
          ORDER BY cs.run_id, c.path
        `).all(),
        materialDerivations: this.db.prepare(`
          SELECT output_material_id, input_material_id, run_id, relation_type, ordinal, created_at
          FROM material_derivations ORDER BY created_at, run_id, ordinal
        `).all(),
      };
      this.db.exec('COMMIT;');
      return source;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
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
