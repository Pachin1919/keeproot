import crypto from 'node:crypto';

const EVOLUTION_RULE_VERSION_ID = 'RULE-EVOLUTION-7';

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

export class EvolutionRepository {
  constructor({ db, transaction, getRun, insertEvent, insertRollbackOutcome }) {
    this.db = db;
    this.transaction = transaction;
    this.getRun = getRun;
    this.insertEvent = insertEvent;
    this.insertRollbackOutcome = insertRollbackOutcome;
  }

  create({
    runId, root, operation, sourcePath, targetPath, projectId, intent,
    baseline, plan, planHash, diffText, diffHash, caller = {}, startedAt,
  }) {
    const candidateChangeSetId = `CAN-${crypto.randomUUID()}`;
    const actualChangeSetId = `CHG-${crypto.randomUUID()}`;
    const predictionId = `PRD-${crypto.randomUUID()}`;
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Guarded filesystem evolution', '7.0.0', ?, ?)
      `).run(EVOLUTION_RULE_VERSION_ID, json({
        operations: [
          'create_directory',
          'move_file',
          'migrate_project',
          'migrate_directory',
          'migrate_cross_root',
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
        operation,
        source_path: sourcePath ?? null,
        target_path: targetPath,
        source_manifest_hash: baseline.source_manifest_hash ?? null,
        source_entries: baseline.source_entries?.length ?? 0,
        target_state: baseline.target_state,
      }), startedAt);
      this.db.prepare(`
        INSERT INTO policy_decisions(id, run_id, rule_version_id, decision, reason, details_json, created_at)
        VALUES (?, ?, ?, 'guarded', ?, ?, ?)
      `).run(
        `DEC-${crypto.randomUUID()}`, runId, EVOLUTION_RULE_VERSION_ID,
        'Filesystem structure changes require explicit approval and exact-state verification.',
        json({ operation, paths: prediction.affected_paths, recovery_available: true }), startedAt,
      );
      this.insertEvent(runId, 'evolution_prepared', {
        candidate_change_set_id: candidateChangeSetId,
        prediction_id: predictionId,
        operation,
        plan_hash: planHash,
      }, startedAt);
    });
    return { candidateChangeSetId, actualChangeSetId, predictionId };
  }

  getOperation(runId) {
    const run = this.getRun(runId);
    if (run.mode !== 'evolution') throw new Error(`Run is not Evolution: ${runId}`);
    const row = this.db.prepare('SELECT * FROM evolution_operations WHERE run_id = ?').get(runId);
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

  getDetail(runId) {
    const run = this.getRun(runId);
    const operation = this.getOperation(runId);
    const candidate = this.db.prepare('SELECT * FROM candidate_change_sets WHERE run_id = ?').get(runId);
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

  review(runId, { decision, reason, reviewedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.mode !== 'evolution') throw new Error(`Run is not Evolution: ${runId}`);
      const operation = this.db.prepare('SELECT * FROM evolution_operations WHERE run_id = ?').get(runId);
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
      this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId);
      this.db.prepare('UPDATE candidate_change_sets SET status = ? WHERE run_id = ?').run(status, runId);
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
      this.insertEvent(runId, `evolution_${status}`, receipt, reviewedAt);
      return receipt;
    });
  }

  markStale(runId, payload, occurredAt) {
    this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status === 'stale') return;
      if (run.status !== 'approved') {
        throw new Error(`Only an approved Evolution run can become stale; current status is ${run.status}.`);
      }
      this.db.prepare("UPDATE runs SET status = 'stale' WHERE id = ?").run(runId);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'stale' WHERE run_id = ?").run(runId);
      this.insertEvent(runId, 'evolution_approval_invalidated', payload, occurredAt);
    });
  }

  startExecution(runId, occurredAt) {
    const detail = this.getDetail(runId);
    if (detail.events.some((event) => event.type === 'evolution_execution_started')) return;
    if (detail.run.status !== 'approved') {
      throw new Error(`Evolution execution requires approval; current status is ${detail.run.status}.`);
    }
    this.insertEvent(runId, 'evolution_execution_started', {
      plan_hash: detail.operation.plan_hash,
    }, occurredAt);
  }

  finishExecution(runId, { receipt, executedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      const operation = this.db.prepare('SELECT * FROM evolution_operations WHERE run_id = ?').get(runId);
      const existing = parseJson(operation.execution_receipt_json);
      if (existing) return existing;
      if (run.status !== 'approved' || operation.approved_plan_hash !== operation.plan_hash) {
        throw new Error('Evolution execution no longer matches its approved ChangeSet.');
      }
      const changeSet = this.db.prepare('SELECT id FROM change_sets WHERE run_id = ?').get(runId);
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
        const baseline = parseJson(operation.baseline_json, {});
        const kind = operation.operation_type === 'move_file' ? 'file'
          : operation.operation_type === 'migrate_cross_root' ? baseline.source_kind : 'directory';
        const sourcePath = operation.operation_type === 'migrate_cross_root'
          ? `${baseline.source_root_path}::${operation.source_path}` : operation.source_path;
        const targetPath = operation.operation_type === 'migrate_cross_root'
          ? `${baseline.target_root_path}::${operation.target_path}` : operation.target_path;
        insert.run(
          `DIF-${crypto.randomUUID()}`, changeSet.id, sourcePath, 'deleted',
          kind, receipt.after_manifest_hash, null, null,
        );
        insert.run(
          `DIF-${crypto.randomUUID()}`, changeSet.id, targetPath, 'added',
          null, null, kind, receipt.after_manifest_hash,
        );
      }
      const candidate = this.db.prepare('SELECT * FROM candidate_change_sets WHERE run_id = ?').get(runId);
      this.db.prepare(`
        UPDATE change_sets SET status = 'executed', diff_text = ?, diff_hash = ?,
          summary_json = ?, closed_at = ? WHERE run_id = ?
      `).run(candidate.diff_text, candidate.diff_hash, candidate.summary_json, executedAt, runId);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'executed' WHERE run_id = ?").run(runId);
      this.db.prepare(`
        UPDATE evolution_operations SET execution_receipt_json = ?, executed_at = ? WHERE run_id = ?
      `).run(json(receipt), executedAt, runId);
      this.db.prepare(`
        UPDATE runs SET status = 'executed', closed_at = ?, receipt_json = ? WHERE id = ?
      `).run(executedAt, json(receipt), runId);
      this.insertEvent(runId, 'evolution_executed_and_verified', receipt, executedAt);
      return receipt;
    });
  }

  finishRollback(runId, receipt, rolledBackAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.rollback_receipt_json) return parseJson(run.rollback_receipt_json);
      if (run.status !== 'executed') {
        throw new Error(`Only an executed Evolution run can be rolled back; current status is ${run.status}.`);
      }
      this.db.prepare(`
        UPDATE runs SET status = 'rolled_back', rolled_back_at = ?, rollback_receipt_json = ? WHERE id = ?
      `).run(rolledBackAt, json(receipt), runId);
      this.db.prepare("UPDATE change_sets SET status = 'rolled_back' WHERE run_id = ?").run(runId);
      this.insertEvent(runId, 'evolution_rollback_completed', receipt, rolledBackAt);
      this.insertRollbackOutcome(runId, {
        outcome: 'completed',
        reasonCode: 'restored_and_verified',
        details: { operation: receipt.operation ?? null },
      }, rolledBackAt);
      return receipt;
    });
  }
}
