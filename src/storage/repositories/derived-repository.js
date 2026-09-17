import crypto from 'node:crypto';
import { RISK_RULE_VERSION_ID } from '../../risk.js';

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

export class DerivedRepository {
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
        this.storeBlobPath(candidate.blobPath),
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
            this.storeBlobPath(input.blobPath),
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
      this.insertEvent(runId, 'derived_prepared', {
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
      blob_path: this.resolveBlobPath(item.blob_path, item.content_hash),
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
        blob_path: this.resolveBlobPath(operation.candidate_blob_path, operation.candidate_hash),
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
        blob_path: this.resolveBlobPath(operation.output_blob_path, operation.output_hash),
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
      this.insertEvent(runId, `derived_${status}`, receipt, reviewedAt);
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
      this.insertEvent(runId, 'derived_revised', { reason, revised_run_id: revisedRunId }, revisedAt);
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
      this.insertEvent(runId, 'derived_role_promoted', receipt, promotedAt);
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
      this.insertEvent(runId, 'derived_approval_invalidated', payload, occurredAt);
    });
  }

  startDerivedExecution(runId, occurredAt, ownership = null) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'approved') {
        throw new Error(`Derived execution requires approval; current status is ${run.status}.`);
      }
      const existing = this.db.prepare(`
        SELECT occurred_at, payload_json FROM operation_events
        WHERE run_id = ? AND event_type = 'derived_execution_started'
        ORDER BY rowid DESC LIMIT 1
      `).get(runId);
      if (existing) return parseJson(existing.payload_json);
      const receipt = { run_id: runId, status: 'execution_started', started_at: occurredAt, ownership };
      this.insertEvent(runId, 'derived_execution_started', receipt, occurredAt);
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
      this.insertEvent(runId, 'derived_created_and_verified', finalReceipt, executedAt);
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
      this.insertEvent(runId, 'derived_rollback_started', receipt, occurredAt);
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
      this.insertEvent(runId, 'derived_rollback_completed', receipt, rolledBackAt);
      this.insertRollbackOutcome(runId, {
        outcome: 'completed',
        reasonCode: 'restored_and_verified',
        details: { removed_files: receipt.removed_files ?? null },
      }, rolledBackAt);
      return receipt;
    });
  }

  startDerivedRedo(runId, occurredAt, ownership = null) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'rolled_back') throw new Error(`Derived redo requires a rolled back run; current status is ${run.status}.`);
      const existing = this.db.prepare(`
        SELECT payload_json FROM operation_events
        WHERE run_id = ? AND event_type = 'derived_redo_started'
        ORDER BY rowid DESC LIMIT 1
      `).get(runId);
      if (existing) return parseJson(existing.payload_json);
      const receipt = { run_id: runId, status: 'redo_started', started_at: occurredAt, ownership };
      this.insertEvent(runId, 'derived_redo_started', receipt, occurredAt);
      return receipt;
    });
  }

  finishDerivedRedo(runId, receipt, redoneAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'rolled_back') throw new Error(`Only a rolled back Derived run can be redone; current status is ${run.status}.`);
      const operation = this.db.prepare('SELECT output_artifact_id FROM derived_operations WHERE run_id = ?').get(runId);
      this.db.prepare("UPDATE runs SET status = 'executed', closed_at = ?, rolled_back_at = NULL, rollback_receipt_json = NULL, receipt_json = ? WHERE id = ?").run(redoneAt, json(receipt), runId);
      this.db.prepare('UPDATE derived_operations SET execution_receipt_json = ? WHERE run_id = ?').run(json(receipt), runId);
      this.db.prepare("UPDATE change_sets SET status = 'executed' WHERE run_id = ?").run(runId);
      this.db.prepare("UPDATE candidate_change_sets SET status = 'executed' WHERE run_id = ?").run(runId);
      this.db.prepare("UPDATE artifacts SET status = 'active', updated_at = ? WHERE id = ?").run(redoneAt, operation.output_artifact_id);
      this.insertEvent(runId, 'derived_redone_and_verified', receipt, redoneAt);
      return receipt;
    });
  }

}
