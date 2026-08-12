import crypto from 'node:crypto';

const TASK_RULE_VERSION_ID = 'RULE-TASK-CONTRACT-1';
export const TASK_SCOPED_ENVIRONMENT_RULE_VERSION_ID = 'RULE-TASK-SCOPED-EXPLICIT-1';

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

export class TaskRepository {
  constructor({ db, transaction, getRun, insertEvent, storeBlobPath }) {
    this.db = db;
    this.transaction = transaction;
    this.getRun = getRun;
    this.insertEvent = insertEvent;
    this.storeBlobPath = storeBlobPath;
  }

  listPendingByProject(projectId, { limit = 10 } = {}) {
    return this.db.prepare(`
      SELECT tc.run_id, tc.contract_id, tc.underlying_run_id, tc.source_set_id, tc.contract_json,
             r.status AS task_status, r.intent, r.started_at,
             wr.mode AS write_mode, wr.status AS write_status
      FROM task_contracts tc
      JOIN runs r ON r.id = tc.run_id
      LEFT JOIN runs wr ON wr.id = tc.underlying_run_id
      WHERE tc.project_id = ?
        AND r.status NOT IN ('completed', 'rolled_back', 'rejected', 'cancelled', 'blocked')
      ORDER BY r.started_at DESC, r.rowid DESC
      LIMIT ?
    `).all(projectId, limit).map((row) => {
      const contract = parseJson(row.contract_json, {});
      return {
        task_id: row.run_id,
        contract_id: row.contract_id,
        task_status: row.task_status,
        intent: row.intent,
        target: contract.write?.target ?? null,
        strategy: contract.write?.strategy ?? null,
        source_set_id: row.source_set_id,
        underlying_run_id: row.underlying_run_id,
        write_mode: row.write_mode,
        write_status: row.write_status,
        started_at: row.started_at,
      };
    });
  }

  listForUiByProject(projectId, { limit = 20 } = {}) {
    return this.db.prepare(`
      SELECT tc.run_id, tc.contract_id, tc.underlying_run_id, tc.source_set_id, tc.contract_json,
             r.status AS task_status, r.intent, r.started_at, r.closed_at, r.rolled_back_at,
             wr.mode AS write_mode, wr.status AS write_status,
             (SELECT ti.path FROM task_inputs ti
              WHERE ti.run_id = tc.run_id AND ti.selected = 1
              ORDER BY ti.ordinal LIMIT 1) AS primary_source,
             (SELECT COUNT(*) FROM task_inputs ti
              WHERE ti.run_id = tc.run_id AND ti.selected = 1) AS selected_source_count
      FROM task_contracts tc
      JOIN runs r ON r.id = tc.run_id
      LEFT JOIN runs wr ON wr.id = tc.underlying_run_id
      WHERE tc.project_id = ?
      ORDER BY COALESCE(r.closed_at, r.rolled_back_at, r.started_at) DESC, r.rowid DESC
      LIMIT ?
    `).all(projectId, limit).map((row) => {
      const contract = parseJson(row.contract_json, {});
      return {
        task_id: row.run_id,
        contract_id: row.contract_id,
        task_status: row.task_status,
        intent: row.intent,
        target: contract.write?.target ?? null,
        strategy: contract.write?.strategy ?? null,
        source_set_id: row.source_set_id,
        underlying_run_id: row.underlying_run_id,
        write_mode: row.write_mode,
        write_status: row.write_status,
        started_at: row.started_at,
        closed_at: row.closed_at,
        rolled_back_at: row.rolled_back_at,
        primary_source: row.primary_source,
        selected_source_count: row.selected_source_count,
      };
    });
  }

  findByContractId(contractId) {
    const row = this.db.prepare(`
      SELECT run_id FROM task_contracts WHERE contract_id = ?
    `).get(contractId);
    return row ? this.getDetail(row.run_id) : null;
  }

  create({
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
              this.storeBlobPath(input.capture.blobPath),
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
      this.insertEvent(runId, 'task_contract_prepared', {
        contract_id: contractId,
        contract_hash: contractHash,
        selected_inputs: contract.read.selected.length,
        excluded_inputs: contract.read.excluded.length,
        write_strategy: contract.write.strategy,
        executor: contract.write.executor,
      }, startedAt);
      const eligibleRules = contract.attention?.eligible_rules ?? [];
      const appliedRules = contract.attention?.applied_rules ?? [];
      this.insertEvent(runId, 'task_rule_evaluated', {
        task_id: runId,
        eligible_rule_ids: eligibleRules.map((rule) => rule.rule_id),
        applied_rule_ids: appliedRules.map((rule) => rule.rule_id),
        rule_version_ids: [...new Set(eligibleRules.map((rule) => rule.rule_version_id))].sort(),
        evaluated_at: startedAt,
      }, startedAt);
    });
    return this.getDetail(runId);
  }

  getDetail(runId) {
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

  reviewRuleApplication(runId, { ruleId, decision, reason }) {
    if (!['accepted', 'corrected'].includes(decision)) {
      throw new Error('Task rule review decision must be accepted or corrected.');
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error('Task rule review requires a reason.');
    }
    const detail = this.getDetail(runId);
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
      this.insertEvent(runId, 'task_rule_review_recorded', receipt, reviewedAt);
      return receipt;
    });
  }

  claimFulfillment(runId, claimToken, processId, occurredAt, plannedWriteRunId = null) {
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
          this.insertEvent(runId, 'task_write_reconciled_from_claim', {
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
          this.insertEvent(runId, 'task_fulfillment_claim_reclaimed', {
            abandoned_claim_token: existing.claim_token,
            abandoned_process_id: existing.process_id,
            replacement_claim_token: claimToken,
            planned_write_run_id: resumedPlan,
          }, occurredAt);
          return { status: 'acquired', planned_write_run_id: resumedPlan };
        }
        const error = new Error(`Task Contract is already being fulfilled by process ${existing.process_id}.`);
        error.code = 'ATLAS_STATE_CONFLICT';
        throw error;
      }
      this.db.prepare(`
        INSERT INTO task_fulfillment_claims(
          task_run_id, claim_token, process_id, status, planned_write_run_id, claimed_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(runId, claimToken, processId, plannedWriteRunId, occurredAt, occurredAt);
      this.insertEvent(runId, 'task_fulfillment_claimed', {
        claim_token: claimToken, process_id: processId, planned_write_run_id: plannedWriteRunId,
      }, occurredAt);
      return { status: 'acquired', planned_write_run_id: plannedWriteRunId };
    });
  }

  releaseFulfillmentClaim(runId, claimToken, occurredAt) {
    return this.transaction(() => {
      const claim = this.db.prepare(`
        SELECT claim_token, write_run_id FROM task_fulfillment_claims WHERE task_run_id = ?
      `).get(runId);
      if (!claim || claim.claim_token !== claimToken || claim.write_run_id) return false;
      this.db.prepare(`DELETE FROM task_fulfillment_claims WHERE task_run_id = ?`).run(runId);
      this.insertEvent(runId, 'task_fulfillment_claim_released', { claim_token: claimToken }, occurredAt);
      return true;
    });
  }

  recordUnderlyingRun(runId, writeRunId, occurredAt, claimToken = null) {
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
        this.insertEvent(runId, 'task_write_staged', { write_run_id: writeRunId }, occurredAt);
      }
      return this.getDetail(runId);
    });
  }

  markStale(runId, payload, occurredAt) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.status === 'stale') return this.getDetail(runId);
      if (run.status !== 'ready') {
        throw new Error(`Only a ready Task Contract can become stale; current status is ${run.status}.`);
      }
      this.db.prepare(`UPDATE runs SET status = 'stale' WHERE id = ?`).run(runId);
      this.insertEvent(runId, 'task_contract_invalidated', payload, occurredAt);
      return this.getDetail(runId);
    });
  }

  complete(runId, {
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
      this.insertEvent(runId, 'task_completed_and_verified', receipt, completedAt);
      return receipt;
    });
  }

  finishRollback(runId, receipt, rolledBackAt) {
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
      this.insertEvent(runId, 'task_rollback_completed', receipt, rolledBackAt);
      return receipt;
    });
  }
}
