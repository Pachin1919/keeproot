import {
  applyProjectContextMigration,
} from './migrations/v19-project-context.js';
import {
  applyProjectIdentityMigration,
  PROJECT_IDENTITY_SCHEMA_VERSION,
} from './migrations/v20-project-identity.js';

export const LATEST_SCHEMA_VERSION = PROJECT_IDENTITY_SCHEMA_VERSION;

function now() {
  return new Date().toISOString();
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

export function initializeLedgerSchema(db, transaction) {
    db.exec(`
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

    transaction(() => {
      ensureColumn(db, 'runs', 'aborted_at', 'TEXT');
      ensureColumn(db, 'runs', 'abort_receipt_json', 'TEXT');
      ensureColumn(db, 'labels', 'subject_prediction_id', 'TEXT REFERENCES predictions(id)');
      ensureColumn(db, 'labels', 'details_json', "TEXT NOT NULL DEFAULT '{}'");
      ensureColumn(db, 'projects', 'updated_at', 'TEXT');
      ensureColumn(db, 'runs', 'actor', "TEXT NOT NULL DEFAULT 'unknown'");
      ensureColumn(db, 'runs', 'agent', 'TEXT');
      ensureColumn(db, 'runs', 'model', 'TEXT');
      ensureColumn(db, 'runs', 'tool', "TEXT NOT NULL DEFAULT 'atlas-cli'");
      ensureColumn(db, 'runs', 'client_run_id', 'TEXT');
      ensureColumn(db, 'artifacts', 'root_path', 'TEXT');
      ensureColumn(db, 'artifacts', 'role', 'TEXT');
      ensureColumn(db, 'artifacts', 'status', "TEXT NOT NULL DEFAULT 'active'");
      ensureColumn(db, 'artifacts', 'updated_at', 'TEXT');
      ensureColumn(db, 'derived_operations', 'revised_from_run_id', 'TEXT REFERENCES runs(id)');
      ensureColumn(db, 'task_fulfillment_claims', 'planned_write_run_id', 'TEXT');
      ensureColumn(db, 'portfolio_inventories', 'expanded_json', "TEXT NOT NULL DEFAULT '[]'");
      db.exec(`
        UPDATE artifacts
        SET root_path = (
          SELECT root_path FROM runs WHERE runs.id = artifacts.origin_run_id
        )
        WHERE root_path IS NULL;
        UPDATE artifacts SET updated_at = created_at WHERE updated_at IS NULL;
      `);
      const insertMigration = db.prepare(`
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
      applyProjectContextMigration(db, appliedAt);
      applyProjectIdentityMigration(db, appliedAt);
      db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION};`);
    });
}
