import path from 'node:path';
import { atomicWrite, atomicWriteJson } from './ui/files.js';
import { buildOperationModel } from './ui/read-model/operation-model.js';
import { renderTaskReviewView } from './ui/views/task-review-view.js';

export { buildOperationModel } from './ui/read-model/operation-model.js';

export function createOperationSnapshot({
  stateDir,
  taskId,
  task,
  guarded,
  derived,
  refreshSources = false,
}) {
  if (!stateDir) throw new Error('Atlas UI operation requires stateDir.');
  const sourceFreshness = refreshSources
    ? task.sourceStatus(taskId, { caller: { actor: 'system', tool: 'atlas-ui' } })
    : null;
  const model = buildOperationModel({ taskId, task, guarded, derived, sourceFreshness });
  const base = path.join(path.resolve(stateDir), 'ui', `operation-${taskId}`);
  const operationPath = `${base}.json`;
  const viewPath = `${base}.html`;
  atomicWriteJson(operationPath, model);
  atomicWrite(viewPath, renderTaskReviewView(model));
  return {
    schema: 'atlas-ui-operation-receipt.v1',
    status: model.task.status,
    ui_state: model.ui_state.state,
    task_id: model.task.id,
    operation_path: operationPath,
    view_path: viewPath,
    project_id: model.project.id,
    write_mode: model.write?.mode ?? null,
    write_status: model.write?.status ?? null,
    next_action: model.next_action,
    allowed_actions: model.ui_state.allowed_actions,
    rollback: {
      status: model.rollback.status,
      available: model.rollback.available,
    },
    selected_source_count: model.sources.selected.length,
    source_freshness: {
      status: model.sources.freshness.status,
      counts: model.sources.freshness.counts ?? null,
      reason_code: model.sources.freshness.reason_code ?? null,
    },
    policy_decision: model.policy.latest?.decision ?? null,
    network_used: false,
    model_visible_body_bytes: 0,
    source_changes: [],
  };
}
