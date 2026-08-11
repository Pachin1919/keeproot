import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from './paths.js';
import { buildOperationModel } from './ui/read-model/operation-model.js';

function stateConflict(message) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  return error;
}

function loadSnapshot(stateDir, snapshotPath) {
  const uiRoot = path.join(path.resolve(stateDir), 'ui');
  const absolute = path.resolve(snapshotPath);
  if (!isPathInside(uiRoot, absolute) || !fs.existsSync(absolute)) {
    throw new Error('Atlas UI action snapshot must be an existing file under Atlas state/ui.');
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Atlas UI action snapshot must be a regular non-symbolic-link file.');
  }
  const snapshot = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (snapshot.schema !== 'atlas-ui-operation.v1' || snapshot.action_binding?.schema !== 'atlas-ui-action-binding.v1') {
    throw new Error('Atlas UI action snapshot has an unsupported schema.');
  }
  return snapshot;
}

function bindingFields(binding) {
  return {
    task_id: binding.task_id,
    expected_task_status: binding.expected_task_status,
    write_run_id: binding.write_run_id,
    expected_write_status: binding.expected_write_status,
    candidate_change_set_id: binding.candidate_change_set_id,
    candidate_hash: binding.candidate_hash,
    diff_hash: binding.diff_hash,
    review_decision: binding.review_decision,
    reviewed_at: binding.reviewed_at,
    allowed_actions: [...binding.allowed_actions].sort(),
  };
}

function verifyBinding(snapshot, current, taskId, action) {
  if (snapshot.task.id !== taskId || snapshot.action_binding.task_id !== taskId) {
    throw stateConflict('The UI snapshot is bound to a different Task.');
  }
  const saved = JSON.stringify(bindingFields(snapshot.action_binding));
  const observed = JSON.stringify(bindingFields(current.action_binding));
  if (saved !== observed) {
    throw stateConflict('The UI snapshot is stale because the Task or Candidate changed. Refresh before acting.');
  }
  if (!current.action_binding.allowed_actions.includes(action)) {
    throw stateConflict(`Action ${action} is not allowed in UI state ${current.ui_state.state}.`);
  }
}

export function applyUiAction({
  stateDir,
  taskId,
  action,
  snapshotPath,
  reason = null,
  approvalToken = null,
  task,
  guarded,
  derived,
  lifecycle,
}) {
  if (!['approve', 'reject', 'execute', 'rollback'].includes(action)) {
    throw new Error(`Unsupported Atlas UI action: ${action}`);
  }
  if (!task || !guarded || !derived || !lifecycle) {
    throw new Error('Atlas UI action requires Task, Guarded, Derived and AgentLifecycle services.');
  }
  const snapshot = loadSnapshot(stateDir, snapshotPath);
  const current = buildOperationModel({ taskId, task, guarded, derived });
  verifyBinding(snapshot, current, taskId, action);

  let result;
  if (action === 'approve') {
    if (!reason?.trim()) throw new Error('UI approval requires a reason.');
    result = lifecycle.approve(taskId, { reason });
  } else if (action === 'reject') {
    if (!reason?.trim()) throw new Error('UI rejection requires a reason.');
    if (!current.write?.run_id || current.write.mode !== 'guarded') {
      throw stateConflict('Only a staged Guarded Candidate can be rejected through this bridge.');
    }
    result = guarded.reject(current.write.run_id, { reason });
  } else if (action === 'execute') {
    const token = approvalToken ?? lifecycle.approve(taskId, {
      reason: 'Resume the existing user-approved Candidate through Atlas UI.',
    }).approval_token;
    result = lifecycle.fulfill(taskId, { token });
  } else {
    result = lifecycle.rollback(taskId);
  }

  const after = buildOperationModel({ taskId, task, guarded, derived });
  return {
    schema: 'atlas-ui-action-result.v1',
    action,
    task_id: taskId,
    status: result.status,
    ui_state: after.ui_state.state,
    allowed_actions: after.ui_state.allowed_actions,
    approval_token: result.approval_token ?? null,
    result,
    refresh_required: true,
    network_used: false,
    source_changes: result.source_changes ?? [],
  };
}
