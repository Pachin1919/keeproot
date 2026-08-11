import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWrite, atomicWriteJson } from './ui/files.js';
import { buildContextModel } from './ui/read-model/context-model.js';
import { renderContextView } from './ui/views/context-view.js';

export { buildContextModel } from './ui/read-model/context-model.js';

export function createContextView({ stateDir, currentPath, registry, rules, runtime = null }) {
  if (!stateDir) throw new Error('Atlas UI context requires stateDir.');
  const model = buildContextModel({ currentPath, registry, rules, runtime });
  const name = crypto.createHash('sha256').update(model.current_path.toLowerCase()).digest('hex').slice(0, 16);
  const viewPath = path.join(path.resolve(stateDir), 'ui', `context-${name}.html`);
  const contextPath = path.join(path.resolve(stateDir), 'ui', `context-${name}.json`);
  atomicWrite(viewPath, renderContextView(model));
  atomicWriteJson(contextPath, model);
  return {
    schema: 'atlas-ui-context.v1',
    status: model.resolution_status === 'resolved'
      ? 'ready'
      : (model.projects.length ? 'selection_required' : 'setup_required'),
    view_path: viewPath,
    context_path: contextPath,
    root_id: model.root?.id ?? null,
    project_count: model.projects.length,
    project_ids: model.projects.map((entry) => entry.project.id),
    active_route_count: model.projects.reduce((total, entry) => total + entry.routes.length, 0),
    pending_task_count: model.projects.reduce((total, entry) => total + entry.pending_tasks.length, 0),
    network_used: false,
    model_visible_body_bytes: 0,
    source_changes: [],
  };
}
