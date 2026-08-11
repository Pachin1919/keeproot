import crypto from 'node:crypto';
import { RISK_RULE_VERSION_ID } from '../../risk.js';

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

export class GuardedRepository {
  constructor({
    db,
    transaction,
    getRun,
    getRuleVersion,
    insertEvent,
    insertRollbackOutcome,
    storeBlobPath,
    resolveBlobPath,
  }) {
    this.db = db;
    this.transaction = transaction;
    this.getRun = getRun;
    this.getRuleVersion = getRuleVersion;
    this.insertEvent = insertEvent;
    this.insertRollbackOutcome = insertRollbackOutcome;
    this.storeBlobPath = storeBlobPath;
    this.resolveBlobPath = resolveBlobPath;
  }

  create({
    runId, root, targetPath, intent, baseline, candidate, diffText, diffHash,
    risk, caller = {}, revisedFromRunId, startedAt,
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
        beforeMaterialId, artifactId, 'before', baseline.contentHash, baseline.byteSize,
        this.storeBlobPath(baseline.blobPath), startedAt,
      );
      insertMaterial.run(
        candidateMaterialId, artifactId, 'candidate', candidate.contentHash, candidate.byteSize,
        this.storeBlobPath(candidate.blobPath), startedAt,
      );
      this.db.prepare(`
        INSERT INTO candidate_change_sets(
          id, run_id, version, operation, target_path, status, content_hash,
          diff_text, diff_hash, summary_json, created_at
        ) VALUES (?, ?, 1, 'update', ?, 'prepared', ?, ?, ?, ?, ?)
      `).run(
        candidateChangeSetId, runId, targetPath, candidate.contentHash, diffText, diffHash,
        json({ changed_files: 1, operation: 'update', target_path: targetPath }), startedAt,
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
        `DEC-${crypto.randomUUID()}`, runId, RISK_RULE_VERSION_ID, risk.mode,
        risk.reasons.join(' '), json(risk), startedAt,
      );
      this.db.prepare(`
        INSERT INTO observations(id, run_id, kind, subject_artifact_id, payload_json, created_at)
        VALUES (?, ?, 'guarded_target_baseline', ?, ?, ?)
      `).run(
        `OBS-${crypto.randomUUID()}`, runId, artifactId,
        json({ path: targetPath, content_hash: baseline.contentHash }), startedAt,
      );
      this.insertEvent(runId, 'guarded_prepared', {
        candidate_change_set_id: candidateChangeSetId,
        target_path: targetPath,
        candidate_hash: candidate.contentHash,
        risk_mode: risk.mode,
      }, startedAt);
    });
    return { candidateChangeSetId, actualChangeSetId };
  }

  getDetail(runId) {
    const run = this.getRun(runId);
    if (run.mode !== 'guarded') throw new Error(`Run is not Guarded: ${runId}`);
    const candidate = this.db.prepare('SELECT * FROM candidate_change_sets WHERE run_id = ?').get(runId);
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
        blob_path: this.resolveBlobPath(operation.candidate_blob_path, operation.candidate_hash),
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
        blob_path: this.resolveBlobPath(operation.before_blob_path, operation.before_hash),
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

  review(runId, { decision, reason, reviewedAt }) {
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
      `).run(`LBL-${crypto.randomUUID()}`, runId, decision, json({ reason }), reviewedAt);
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
      this.insertEvent(runId, `guarded_${status}`, receipt, reviewedAt);
      return receipt;
    });
  }

  markStale(runId, payload, occurredAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status === 'stale') return;
      if (run.status !== 'approved') {
        throw new Error(`Only an approved Guarded run can become stale; current status is ${run.status}.`);
      }
      this.db.prepare("UPDATE runs SET status = 'stale' WHERE id = ?").run(runId);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'stale' WHERE run_id = ?").run(runId);
      this.insertEvent(runId, 'guarded_approval_invalidated', payload, occurredAt);
    });
  }

  finishExecution(runId, { receipt, executedAt }) {
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
      const candidate = this.db.prepare('SELECT * FROM candidate_change_sets WHERE run_id = ?').get(runId);
      const actual = this.db.prepare('SELECT id FROM change_sets WHERE run_id = ?').get(runId);
      this.db.prepare(`
        INSERT INTO changes(
          id, change_set_id, path, change_type, allowed,
          before_kind, before_hash, before_material_id,
          after_kind, after_hash, after_material_id
        ) VALUES (?, ?, ?, 'modified', 1, 'file', ?, ?, 'file', ?, ?)
      `).run(
        `DIF-${crypto.randomUUID()}`, actual.id, operation.target_path,
        operation.before_hash, operation.before_material_id,
        operation.candidate_hash, operation.candidate_material_id,
      );
      this.db.prepare(`
        UPDATE change_sets
        SET status = 'executed', diff_text = ?, diff_hash = ?, summary_json = ?, closed_at = ?
        WHERE id = ?
      `).run(candidate.diff_text, candidate.diff_hash, candidate.summary_json, executedAt, actual.id);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'executed' WHERE run_id = ?").run(runId);
      this.db.prepare(`
        UPDATE guarded_operations
        SET execution_receipt_json = ?, executed_at = ? WHERE run_id = ?
      `).run(json(receipt), executedAt, runId);
      this.db.prepare(`
        UPDATE runs SET status = 'executed', closed_at = ?, receipt_json = ? WHERE id = ?
      `).run(executedAt, json(receipt), runId);
      this.insertEvent(runId, 'guarded_executed_and_verified', receipt, executedAt);
      return receipt;
    });
  }

  markRevised(runId, revisedRunId, reason, revisedAt) {
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
        `LBL-${crypto.randomUUID()}`, runId, json({ reason, revised_run_id: revisedRunId }), revisedAt,
      );
      this.db.prepare("UPDATE runs SET status = 'revised' WHERE id = ?").run(runId);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'revised' WHERE run_id = ?").run(runId);
      this.insertEvent(runId, 'guarded_revised', { reason, revised_run_id: revisedRunId }, revisedAt);
      return revisedRunId;
    });
  }

  finishRollback(runId, receipt, rolledBackAt) {
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
      this.insertEvent(runId, 'guarded_rollback_completed', receipt, rolledBackAt);
      this.insertRollbackOutcome(runId, {
        outcome: 'completed',
        reasonCode: 'restored_and_verified',
        details: { restored_files: receipt.restored_files ?? null },
      }, rolledBackAt);
      return receipt;
    });
  }
}
