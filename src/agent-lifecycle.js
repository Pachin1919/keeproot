import crypto from 'node:crypto';

function approvalToken(receipt, candidateHash) {
  const payload = JSON.stringify({
    schema: 'atlas-agent-approval-token.v1',
    run_id: receipt.run_id,
    candidate_change_set_id: receipt.candidate_change_set_id,
    candidate_hash: candidateHash,
    decision: receipt.decision,
    reviewed_at: receipt.reviewed_at,
  });
  return `ATOK-${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

function tokenMatches(expected, received) {
  if (typeof received !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export class AgentLifecycle {
  constructor({ task, guarded, registry = null }) {
    if (!task || !guarded) throw new Error('AgentLifecycle requires Task and Guarded services.');
    this.task = task;
    this.guarded = guarded;
    this.registry = registry;
  }

  start(currentPath, { request, caller = {} }) {
    if (!this.registry) throw new Error('Agent start requires a Project Registry.');
    const resolution = this.registry.resolvePath(currentPath);
    if (resolution.status !== 'resolved') {
      return {
        schema: 'atlas-agent-operation.v1',
        status: 'setup_required',
        resolution,
        source_changes: [],
      };
    }
    if (request.project_id && request.project_id !== resolution.project.id) {
      throw new Error('Agent start request project_id does not match the current Project.');
    }
    const prepared = this.task.prepare({
      root: resolution.root.current_path,
      request: { ...request, project_id: resolution.project.id },
      caller,
    });
    return {
      schema: 'atlas-agent-operation.v1',
      status: prepared.status,
      task_id: prepared.task_id,
      contract_id: prepared.contract_id,
      project: { id: resolution.project.id, name: resolution.project.name },
      root: { id: resolution.root.id },
      attention: {
        status: prepared.attention?.status ?? null,
        applied_rule_ids: (prepared.attention?.applied_rules ?? []).map((rule) => rule.rule_id),
        gaps: (prepared.attention?.gaps ?? []).map((gap) => gap.kind ?? gap),
      },
      read: {
        selected_paths: (prepared.read?.selected ?? []).map((item) => item.path),
        excluded_count: prepared.read?.excluded?.length ?? 0,
        estimated_tokens: prepared.read?.estimated_tokens ?? 0,
        requires_local_extraction: prepared.read?.requires_local_extraction ?? [],
      },
      write: prepared.write,
      questions: prepared.questions ?? [],
      next_action: prepared.status === 'ready'
        ? { command: `agent prepare ${prepared.task_id} --candidate-file <path> --reason <authorization>` }
        : { command: `task show ${prepared.task_id} --compact` },
      source_changes: [],
    };
  }

  status(currentPath) {
    if (!this.registry) throw new Error('Agent status requires a Project Registry.');
    const resolution = this.registry.resolvePath(currentPath);
    if (resolution.status !== 'resolved') {
      return {
        schema: 'atlas-agent-status.v1',
        status: 'setup_required',
        resolution,
        pending: [],
        source_changes: [],
      };
    }
    const pending = this.task.listPendingTasks(resolution.project.id).map((item) => {
      let nextAction = 'prepare_candidate';
      if (item.task_status !== 'ready') nextAction = 'replace_or_resolve_task';
      else if (item.write_status === 'prepared') nextAction = 'review_and_approve';
      else if (['approved', 'executed'].includes(item.write_status)) nextAction = 'resume';
      return { ...item, next_action: nextAction };
    });
    return {
      schema: 'atlas-agent-status.v1',
      status: pending.length ? 'pending' : 'idle',
      project: { id: resolution.project.id, name: resolution.project.name },
      root: { id: resolution.root.id },
      pending,
      source_changes: [],
    };
  }

  resume(taskId) {
    const detail = this.task.show(taskId);
    if (detail.run.status === 'completed') {
      return {
        schema: 'atlas-agent-operation.v1', task_id: taskId, status: 'completed',
        completion: detail.completion_receipt, source_changes: [],
      };
    }
    if (detail.run.status === 'rolled_back') {
      return {
        schema: 'atlas-agent-operation.v1', task_id: taskId, status: 'rolled_back',
        rollback: detail.rollback_receipt, source_changes: [],
      };
    }
    if (detail.run.status !== 'ready') {
      return {
        schema: 'atlas-agent-operation.v1', task_id: taskId, status: detail.run.status,
        next_action: 'Prepare a replacement Task after resolving its questions or stale state.',
        source_changes: [],
      };
    }
    if (!detail.underlying_run_id) {
      return {
        schema: 'atlas-agent-operation.v1', task_id: taskId, status: 'needs_candidate',
        next_command: `agent prepare ${taskId} --candidate-file <path> --reason <authorization>`,
        source_changes: [],
      };
    }
    const preview = this.guarded.preview(detail.underlying_run_id);
    if (preview.run.status === 'prepared') {
      return {
        schema: 'atlas-agent-operation.v1', task_id: taskId, status: 'needs_approval',
        target: preview.run.target_path,
        approval: {
          run_id: preview.run.id,
          candidate_hash: preview.candidate.content_hash,
          diff_hash: preview.candidate.diff_hash,
          review_path: preview.candidate.review_path,
          next_command: `agent approve ${taskId} --reason <user_approval>`,
        },
        source_changes: [],
      };
    }
    if (preview.run.status === 'approved') {
      const approval = this.approve(taskId, { reason: 'Resume the existing user-approved Candidate.' });
      return this.fulfill(taskId, { token: approval.approval_token });
    }
    if (preview.run.status === 'executed') {
      const completion = this.task.complete(taskId, { runId: preview.run.id });
      return {
        schema: 'atlas-agent-operation.v1', task_id: taskId, status: 'completed',
        completion, source_changes: [],
      };
    }
    return {
      schema: 'atlas-agent-operation.v1', task_id: taskId, status: preview.run.status,
      next_action: 'Inspect the existing write run before replacing it.', source_changes: [],
    };
  }

  prepare(taskId, { candidateFile, reason = null }) {
    const result = this.task.fulfill(taskId, { candidateFile, reason });
    if (result.status === 'completed') {
      return {
        schema: 'atlas-agent-operation.v1',
        task_id: taskId,
        status: 'completed',
        approval: { required: false },
        completion: result,
        rollback: { available: true, command: `agent rollback ${taskId}` },
        source_changes: [{ path: result.target, change_type: 'created' }],
      };
    }
    if (result.status !== 'needs_approval' || result.write_run?.mode !== 'guarded') {
      throw new Error(`Agent prepare cannot adapt Task result: ${result.status}.`);
    }
    const preview = this.guarded.preview(result.write_run.run_id);
    return {
      schema: 'atlas-agent-operation.v1',
      task_id: taskId,
      contract_id: result.contract_id,
      status: 'needs_approval',
      target: result.target,
      approval: {
        required: true,
        run_id: preview.run.id,
        candidate_change_set_id: preview.candidate.id,
        candidate_hash: preview.candidate.content_hash,
        baseline_hash: preview.baseline.content_hash,
        diff_hash: preview.candidate.diff_hash,
        review_path: preview.candidate.review_path,
        next_command: `agent approve ${taskId} --reason <user_approval>`,
      },
      source_changes: [],
    };
  }

  approve(taskId, { reason }) {
    const detail = this.task.show(taskId);
    if (!detail.underlying_run_id) throw new Error('Agent approval requires a prepared Task write run.');
    const preview = this.guarded.preview(detail.underlying_run_id);
    if (!['prepared', 'approved'].includes(preview.run.status)) {
      throw new Error(`Agent approval requires a prepared Guarded run; current status is ${preview.run.status}.`);
    }
    const receipt = preview.approval_receipt ?? this.guarded.approve(preview.run.id, { reason });
    return {
      schema: 'atlas-agent-approval.v1',
      task_id: taskId,
      run_id: preview.run.id,
      status: 'approved',
      candidate_change_set_id: receipt.candidate_change_set_id,
      approval_token: approvalToken(receipt, preview.candidate.content_hash),
      next_command: `agent fulfill ${taskId} --approval-token <token>`,
      source_changes: [],
    };
  }

  fulfill(taskId, { token }) {
    const detail = this.task.show(taskId);
    if (!detail.underlying_run_id) throw new Error('Agent fulfill requires a prepared Task write run.');
    const preview = this.guarded.preview(detail.underlying_run_id);
    if (!preview.approval_receipt) throw new Error('Agent fulfill requires an approved Candidate and approval token.');
    const expected = approvalToken(preview.approval_receipt, preview.candidate.content_hash);
    if (!tokenMatches(expected, token)) {
      throw new Error('Agent approval token does not match the current approved Candidate.');
    }
    const execution = this.guarded.execute(preview.run.id);
    const completion = this.task.complete(taskId, { runId: preview.run.id });
    return {
      schema: 'atlas-agent-operation.v1',
      task_id: taskId,
      run_id: preview.run.id,
      status: 'completed',
      target: completion.target,
      verification: {
        verified: execution.verified === true,
        actual_hash: execution.actual_hash,
      },
      rollback: {
        available: execution.rollback_ready === true,
        command: `agent rollback ${taskId}`,
      },
      source_changes: [{ path: completion.target, change_type: 'modified' }],
    };
  }

  rollback(taskId) {
    const receipt = this.task.rollback(taskId);
    return {
      schema: 'atlas-agent-operation.v1',
      task_id: taskId,
      status: receipt.status,
      target: receipt.target,
      run_id: receipt.write_run?.run_id ?? null,
      source_changes: [{ path: receipt.target, change_type: 'restored' }],
    };
  }
}
