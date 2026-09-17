import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RISK_RULE_VERSION_ID } from './risk.js';
import {
  initializeLedgerSchema,
  LATEST_SCHEMA_VERSION,
} from './storage/ledger-schema.js';
import { ProjectRepository } from './storage/repositories/project-repository.js';
import { PolicyRepository } from './storage/repositories/policy-repository.js';
import { DerivedRepository } from './storage/repositories/derived-repository.js';
import { GuardedRepository } from './storage/repositories/guarded-repository.js';
import { EvolutionRepository } from './storage/repositories/evolution-repository.js';
import { ResourceRepository } from './storage/repositories/resource-repository.js';
import {
  LEGACY_TASK_REMOVAL_SCHEMA_VERSION,
  removeLegacyTaskStorage,
} from './storage/migrations/v22-remove-legacy-task-storage.js';
import {
  LEGACY_CONTEXT_SELECTION_REMOVAL_SCHEMA_VERSION,
  removeLegacyContextSelectionStorage,
} from './storage/migrations/v23-retire-legacy-context-selection.js';

const RULE_VERSION_ID = 'RULE-TRACKED-DIRECT-1';
const BOOTSTRAP_RULE_VERSION_ID = 'RULE-BOOTSTRAP-2';
const ORGANIZATION_PLAN_RULE_VERSION_ID = 'RULE-EVOLUTION-PLAN-1';
const PORTFOLIO_RULE_VERSION_ID = 'RULE-PORTFOLIO-1';
export { LATEST_SCHEMA_VERSION } from './storage/ledger-schema.js';

function json(value) {
  return JSON.stringify(value);
}
function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

function now() {
  return new Date().toISOString();
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
      if (currentVersion > 0 && currentVersion < LEGACY_TASK_REMOVAL_SCHEMA_VERSION) {
        this.#removeLegacyTaskStorageFromBackups();
      }
      if (currentVersion > 0 && currentVersion < LEGACY_CONTEXT_SELECTION_REMOVAL_SCHEMA_VERSION) {
        this.#removeLegacyContextSelectionStorageFromBackups();
      }
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.#initializeSchema();
      if (currentVersion > 0 && currentVersion < LEGACY_TASK_REMOVAL_SCHEMA_VERSION) {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        this.db.exec('VACUUM;');
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      }
      this.projects = new ProjectRepository({
        db: this.db,
        transaction: (callback) => this.transaction(callback),
      });
      this.policies = new PolicyRepository({
        db: this.db,
        transaction: (callback) => this.transaction(callback),
        getRun: (runId) => this.getRun(runId),
        insertEvent: (runId, eventType, payload, occurredAt) => (
          this.#insertEvent(runId, eventType, payload, occurredAt)
        ),
      });
      this.derived = new DerivedRepository({
        db: this.db,
        transaction: (callback) => this.transaction(callback),
        getRun: (runId) => this.getRun(runId),
        getRuleVersion: (ruleVersionId) => this.getRuleVersion(ruleVersionId),
        insertEvent: (runId, eventType, payload, occurredAt) => (
          this.#insertEvent(runId, eventType, payload, occurredAt)
        ),
        insertRollbackOutcome: (runId, outcome, occurredAt) => (
          this.#insertRollbackOutcome(runId, outcome, occurredAt)
        ),
        storeBlobPath: (blobPath) => this.#storeBlobPath(blobPath),
        resolveBlobPath: (storedPath, contentHash) => this.#resolveBlobPath(storedPath, contentHash),
      });
      this.guarded = new GuardedRepository({
        db: this.db,
        transaction: (callback) => this.transaction(callback),
        getRun: (runId) => this.getRun(runId),
        getRuleVersion: (ruleVersionId) => this.getRuleVersion(ruleVersionId),
        insertEvent: (runId, eventType, payload, occurredAt) => (
          this.#insertEvent(runId, eventType, payload, occurredAt)
        ),
        insertRollbackOutcome: (runId, outcome, occurredAt) => (
          this.#insertRollbackOutcome(runId, outcome, occurredAt)
        ),
        storeBlobPath: (blobPath) => this.#storeBlobPath(blobPath),
        resolveBlobPath: (storedPath, contentHash) => this.#resolveBlobPath(storedPath, contentHash),
      });
      this.evolution = new EvolutionRepository({
        db: this.db,
        transaction: (callback) => this.transaction(callback),
        getRun: (runId) => this.getRun(runId),
        insertEvent: (runId, eventType, payload, occurredAt) => (
          this.#insertEvent(runId, eventType, payload, occurredAt)
        ),
        insertRollbackOutcome: (runId, outcome, occurredAt) => (
          this.#insertRollbackOutcome(runId, outcome, occurredAt)
        ),
      });
      this.resources = new ResourceRepository({ db: this.db, transaction: (callback) => this.transaction(callback) });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  #initializeSchema() {
    initializeLedgerSchema(this.db, (callback) => this.transaction(callback));
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

  #removeLegacyTaskStorageFromBackups() {
    const backupDir = path.join(this.stateDir, 'backups');
    if (!fs.existsSync(backupDir)) return;
    const resolvedStateDir = fs.realpathSync(this.stateDir);
    const entries = fs.readdirSync(backupDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.sqlite')) continue;
      const backupPath = path.join(backupDir, entry.name);
      const resolvedBackup = fs.realpathSync(backupPath);
      const relative = path.relative(resolvedStateDir, resolvedBackup);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Atlas refused to clean a Ledger backup outside state: ${backupPath}`);
      }
      const backup = new DatabaseSync(resolvedBackup);
      try {
        backup.exec('PRAGMA busy_timeout = 5000;');
        backup.exec('PRAGMA foreign_keys = ON;');
        backup.exec('BEGIN IMMEDIATE;');
        try {
          removeLegacyTaskStorage(backup);
          backup.exec('COMMIT;');
        } catch (error) {
          backup.exec('ROLLBACK;');
          throw error;
        }
        backup.exec('VACUUM;');
        const integrity = backup.prepare('PRAGMA integrity_check').get().integrity_check;
        if (integrity !== 'ok') {
          throw new Error(`Ledger backup failed integrity check after Task removal: ${entry.name}`);
        }
      } finally {
        backup.close();
      }
    }
  }

  #removeLegacyContextSelectionStorageFromBackups() {
    const backupDir = path.join(this.stateDir, 'backups');
    if (!fs.existsSync(backupDir)) return;
    const resolvedStateDir = fs.realpathSync(this.stateDir);
    const entries = fs.readdirSync(backupDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.sqlite')) continue;
      const backupPath = path.join(backupDir, entry.name);
      const resolvedBackup = fs.realpathSync(backupPath);
      const relative = path.relative(resolvedStateDir, resolvedBackup);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Atlas refused to clean a Ledger backup outside state: ${backupPath}`);
      }
      const backup = new DatabaseSync(resolvedBackup);
      try {
        backup.exec('PRAGMA busy_timeout = 5000;');
        backup.exec('PRAGMA foreign_keys = ON;');
        backup.exec('BEGIN IMMEDIATE;');
        try {
          removeLegacyContextSelectionStorage(backup);
          backup.exec('COMMIT;');
        } catch (error) {
          backup.exec('ROLLBACK;');
          throw error;
        }
        const integrity = backup.prepare('PRAGMA integrity_check').get().integrity_check;
        if (integrity !== 'ok') {
          throw new Error(`Ledger backup failed integrity check after Task Context selection removal: ${entry.name}`);
        }
      } finally {
        backup.close();
      }
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

  createGuardedRun(options) {
    return this.guarded.create(options);
  }

  getGuardedDetail(runId) {
    return this.guarded.getDetail(runId);
  }

  reviewGuarded(runId, options) {
    return this.guarded.review(runId, options);
  }

  markGuardedStale(runId, payload, occurredAt) {
    return this.guarded.markStale(runId, payload, occurredAt);
  }

  finishGuardedExecution(runId, options) {
    return this.guarded.finishExecution(runId, options);
  }

  markGuardedRevised(runId, revisedRunId, reason, revisedAt) {
    return this.guarded.markRevised(runId, revisedRunId, reason, revisedAt);
  }

  finishGuardedRollback(runId, receipt, rolledBackAt) {
    return this.guarded.finishRollback(runId, receipt, rolledBackAt);
  }

  createEvolutionRun(options) {
    return this.evolution.create(options);
  }

  getEvolutionOperation(runId) {
    return this.evolution.getOperation(runId);
  }

  getEvolutionDetail(runId) {
    return this.evolution.getDetail(runId);
  }

  reviewEvolution(runId, options) {
    return this.evolution.review(runId, options);
  }

  markEvolutionStale(runId, payload, occurredAt) {
    return this.evolution.markStale(runId, payload, occurredAt);
  }

  startEvolutionExecution(runId, occurredAt) {
    return this.evolution.startExecution(runId, occurredAt);
  }

  finishEvolutionExecution(runId, options) {
    return this.evolution.finishExecution(runId, options);
  }

  finishEvolutionRollback(runId, receipt, rolledBackAt) {
    return this.evolution.finishRollback(runId, receipt, rolledBackAt);
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

  createDerivedRun(options) {
    return this.derived.createDerivedRun(options);
  }

  getDerivedDetail(runId) {
    return this.derived.getDerivedDetail(runId);
  }

  reviewDerived(runId, review) {
    return this.derived.reviewDerived(runId, review);
  }

  markDerivedRevised(runId, revisedRunId, reason, revisedAt) {
    return this.derived.markDerivedRevised(runId, revisedRunId, reason, revisedAt);
  }

  promoteDerivedArtifact(runId, promotion) {
    return this.derived.promoteDerivedArtifact(runId, promotion);
  }

  getDerivedConsumers(runId) {
    return this.derived.getDerivedConsumers(runId);
  }

  markDerivedStale(runId, payload, occurredAt) {
    return this.derived.markDerivedStale(runId, payload, occurredAt);
  }

  startDerivedExecution(runId, occurredAt, ownership = null) {
    return this.derived.startDerivedExecution(runId, occurredAt, ownership);
  }

  finishDerivedExecution(runId, execution) {
    return this.derived.finishDerivedExecution(runId, execution);
  }

  startDerivedRollback(runId, occurredAt) {
    return this.derived.startDerivedRollback(runId, occurredAt);
  }

  finishDerivedRollback(runId, receipt, rolledBackAt) {
    return this.derived.finishDerivedRollback(runId, receipt, rolledBackAt);
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
    return this.projects.create({
      projectId, name, currentPath, aliases, status, parentProjectId, splitFrom, createdAt,
    });
  }

  updateProject(projectId, { name, currentPath, aliases, status, reason, updatedAt }) {
    return this.projects.update(projectId, {
      name, currentPath, aliases, status, reason, updatedAt,
    });
  }

  mergeProjects(sourceIds, targetId, effectiveAt) {
    return this.projects.merge(sourceIds, targetId, effectiveAt);
  }

  getProject(projectId) {
    return this.projects.get(projectId);
  }

  getProjectDetail(projectId) {
    return this.projects.getDetail(projectId);
  }

  listProjects() {
    return this.projects.list();
  }

  ensureProjectFromBootstrapPrediction(predictionId, createdAt) {
    return this.projects.ensureFromBootstrapPrediction(predictionId, createdAt);
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
    return this.policies.activateEnvironment({ runId, root, policy, activatedAt });
  }

  getActiveEnvironmentPolicy(root) {
    return this.policies.getActiveEnvironment(root);
  }

  getEnvironmentPolicyForScan(runId) {
    return this.policies.getEnvironmentForScan(runId);
  }

  createRoutingCorrection({
    root, scopeType, scopeKey, origin, kind, role, targetSubdirectory,
    reason, caller = {}, createdAt = now(),
  }) {
    return this.policies.createRoutingCorrection({
      root, scopeType, scopeKey, origin, kind, role, targetSubdirectory,
      reason, caller, createdAt,
    });
  }

  findRoutingCorrection({ root, origin, kind, candidateHash = null, projectId = null }) {
    return this.policies.findRoutingCorrection({ root, origin, kind, candidateHash, projectId });
  }

  listRoutingCorrections(root) {
    return this.policies.listRoutingCorrections(root);
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
