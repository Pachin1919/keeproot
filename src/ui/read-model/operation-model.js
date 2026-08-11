import { deriveOperationState } from '../operation-state.js';

function selectedSources(detail) {
  return detail.inputs.filter((input) => input.selected).map((input) => ({
    path: input.path,
    byte_size: input.byte_size,
    content_hash: input.content_hash,
    source_root_id: input.source_root_id ?? null,
    source_project_id: input.source_project_id ?? null,
    source_relative_path: input.source_relative_path ?? null,
  }));
}

function excludedSources(detail) {
  return detail.inputs.filter((input) => !input.selected).map((input) => ({
    path: input.path,
    reason: input.selection_reason ?? input.reason ?? 'not_selected',
  }));
}

function ruleId(rule) {
  return typeof rule === 'string' ? rule : (rule?.rule_id ?? rule?.id ?? null);
}

function taskAttention(detail) {
  const attention = detail.contract?.attention ?? null;
  if (!attention) return null;
  return {
    status: attention.status,
    context_hash: attention.context_hash,
    applied_rule_ids: (attention.applied_rules ?? []).map(ruleId).filter(Boolean),
    eligible_rule_ids: (attention.eligible_rules ?? []).map(ruleId).filter(Boolean),
    conflicts: attention.conflicts ?? [],
    gaps: attention.gaps ?? [],
  };
}

function guardedWrite(preview) {
  return {
    mode: 'guarded',
    run_id: preview.run.id,
    status: preview.run.status,
    candidate: {
      change_set_id: preview.candidate.id,
      operation: preview.candidate.operation,
      target: preview.candidate.target_path,
      byte_size: preview.candidate.byte_size,
      content_hash: preview.candidate.content_hash,
      diff_hash: preview.candidate.diff_hash,
      diff_text: preview.candidate.diff_text,
      review_path: preview.candidate.review_path,
    },
    baseline: {
      byte_size: preview.baseline.byte_size,
      content_hash: preview.baseline.content_hash,
    },
    risk: preview.risk,
    policy_decisions: preview.policy_decisions,
    review: preview.approval_receipt ?? preview.rejection_receipt ?? null,
    execution_receipt: preview.execution_receipt,
    rollback_receipt: preview.rollback_receipt,
  };
}

function derivedWrite(preview) {
  return {
    mode: 'derived',
    run_id: preview.run.id,
    status: preview.run.status,
    candidate: {
      change_set_id: preview.candidate.id,
      operation: preview.candidate.operation,
      target: preview.candidate.target_path,
      byte_size: preview.candidate.byte_size,
      content_hash: preview.candidate.content_hash,
      diff_hash: preview.candidate.diff_hash,
      diff_text: preview.candidate.diff_text,
      review_path: null,
    },
    placement: preview.placement,
    risk: preview.risk,
    policy_decisions: preview.policy_decisions,
    review: preview.approval_receipt ?? preview.rejection_receipt ?? null,
    execution_receipt: preview.execution_receipt,
    rollback_receipt: preview.rollback_receipt,
  };
}

function rollbackState(detail, write) {
  if (detail.rollback_receipt) {
    return { status: 'completed', available: false, receipt: detail.rollback_receipt };
  }
  if (!detail.completion_receipt || !write?.execution_receipt) {
    return { status: 'not_ready', available: false, receipt: null };
  }
  return {
    status: 'available',
    available: true,
    receipt: null,
    precondition: write.mode === 'guarded'
      ? 'The current target Hash must still match the executed candidate Hash or original baseline Hash.'
      : 'The current target Hash must match the executed output Hash and no active downstream lineage may depend on it.',
  };
}

function nextAction(detail, write, state) {
  if (state.state === 'rolled_back') return { kind: 'none', reason: 'task_rolled_back' };
  if (state.state === 'completed') return { kind: 'rollback', command: `agent rollback ${detail.run.id}` };
  if (state.state === 'candidate_required') {
    return { kind: 'prepare_candidate', command: `agent prepare ${detail.run.id} --candidate-file <path> --reason <authorization>` };
  }
  if (state.state === 'awaiting_review') return { kind: 'approve_or_reject' };
  if (state.state === 'approved' || state.state === 'verifying') return { kind: 'execute', command: `agent resume ${detail.run.id}` };
  return { kind: 'inspect', reason: state.state };
}

function actionBinding(detail, write, state) {
  return {
    schema: 'atlas-ui-action-binding.v1',
    task_id: detail.run.id,
    expected_task_status: detail.run.status,
    write_run_id: write?.run_id ?? null,
    expected_write_status: write?.status ?? null,
    candidate_change_set_id: write?.candidate?.change_set_id ?? null,
    candidate_hash: write?.candidate?.content_hash ?? null,
    diff_hash: write?.candidate?.diff_hash ?? null,
    review_decision: write?.review?.decision ?? null,
    reviewed_at: write?.review?.reviewed_at ?? null,
    allowed_actions: state.allowed_actions,
  };
}

export function buildOperationModel({ taskId, task, guarded, derived, sourceFreshness = null }) {
  if (!taskId || !task || !guarded || !derived) {
    throw new Error('Atlas UI operation model requires taskId, Task, Guarded and Derived services.');
  }
  const detail = task.show(taskId);
  let write = null;
  if (detail.underlying_run_id) {
    if (detail.contract.write.executor === 'guarded_update') {
      write = guardedWrite(guarded.preview(detail.underlying_run_id));
    } else if (detail.contract.write.executor === 'derived_create') {
      write = derivedWrite(derived.preview(detail.underlying_run_id));
    }
  }
  const rollback = rollbackState(detail, write);
  const uiState = deriveOperationState({
    taskStatus: detail.run.status,
    writeStatus: write?.status ?? null,
    rollbackAvailable: rollback.available,
  });
  const latestPolicy = detail.policy_decisions.at(-1) ?? null;
  return {
    schema: 'atlas-ui-operation.v1',
    generated_at: new Date().toISOString(),
    ui_state: uiState,
    task: {
      id: detail.run.id,
      status: detail.run.status,
      intent: detail.run.intent,
      started_at: detail.run.started_at,
      closed_at: detail.run.closed_at,
      rolled_back_at: detail.run.rolled_back_at,
    },
    project: {
      id: detail.project_id,
      path: detail.project_path,
      root: detail.run.root_path,
      write_root_id: detail.write_root_id,
    },
    sources: {
      selected: selectedSources(detail),
      excluded: excludedSources(detail),
      candidate_set_id: detail.candidate_set_id,
      source_set_id: detail.source_set_id,
      freshness: sourceFreshness ?? (detail.source_set_id
        ? {
            schema: 'atlas-source-freshness.v1',
            task_id: detail.run.id,
            source_set_id: detail.source_set_id,
            status: 'not_checked',
            reason_code: 'explicit_refresh_required',
            items: [],
            attention: 'Source freshness has not been checked in this snapshot.',
          }
        : {
            schema: 'atlas-source-freshness.v1',
            task_id: detail.run.id,
            source_set_id: null,
            status: 'unavailable',
            reason_code: 'task_has_no_source_set',
            items: [],
            attention: 'This Task has no persistent cross-Project Source Set.',
          }),
    },
    attention: taskAttention(detail),
    proposal: {
      executor: detail.contract.write.executor,
      strategy: detail.contract.write.strategy,
      target: detail.contract.write.target,
      role: detail.contract.write.role,
      relation_type: detail.contract.write.relation_type,
      reason: detail.contract.write.reason,
    },
    policy: {
      latest: latestPolicy,
      decisions: detail.policy_decisions,
      questions: detail.contract.questions ?? [],
    },
    write,
    completion_receipt: detail.completion_receipt,
    rollback,
    next_action: nextAction(detail, write, uiState),
    action_binding: actionBinding(detail, write, uiState),
    source_changes: [],
  };
}
