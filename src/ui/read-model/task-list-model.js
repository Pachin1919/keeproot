const TERMINAL_STATUSES = new Set(['completed', 'rolled_back', 'rejected', 'cancelled']);

function normalizedText(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function updatedAt(task) {
  return task.closed_at ?? task.rolled_back_at ?? task.started_at ?? '';
}

function matchesStatus(task, status) {
  if (status === 'all') return true;
  if (status === 'active') return !TERMINAL_STATUSES.has(task.task_status) && task.task_status !== 'blocked';
  if (status === 'action_required') return task.task_status === 'blocked' || !TERMINAL_STATUSES.has(task.task_status);
  return task.task_status === status;
}

function compareTasks(left, right, sort) {
  if (sort === 'oldest') return updatedAt(left).localeCompare(updatedAt(right));
  if (sort === 'project') {
    return left.project_name.localeCompare(right.project_name)
      || updatedAt(right).localeCompare(updatedAt(left));
  }
  if (sort === 'status') {
    return left.task_status.localeCompare(right.task_status)
      || updatedAt(right).localeCompare(updatedAt(left));
  }
  return updatedAt(right).localeCompare(updatedAt(left));
}

export function buildTaskListModel(context, filters = {}) {
  const query = String(filters.q ?? '').trim();
  const projectId = String(filters.project ?? 'all');
  const status = String(filters.status ?? 'all');
  const sort = ['newest', 'oldest', 'project', 'status'].includes(filters.sort) ? filters.sort : 'newest';
  const pageSize = 25;
  const flattened = context.projects.flatMap((entry) => (entry.tasks ?? []).map((task) => ({
    ...task,
    project_id: entry.project.id,
    project_name: entry.project.name,
    updated_at: updatedAt(task),
  })));
  const needle = normalizedText(query);
  const filtered = flattened.filter((task) => {
    if (projectId !== 'all' && task.project_id !== projectId) return false;
    if (!matchesStatus(task, status)) return false;
    if (!needle) return true;
    return [task.task_id, task.intent, task.target, task.project_name]
      .some((value) => normalizedText(value).includes(needle));
  }).sort((left, right) => compareTasks(left, right, sort));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requestedPage = Number.parseInt(filters.page, 10);
  const page = Math.min(Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1), pageCount);
  return {
    schema: 'atlas-ui-task-list-model.v1',
    tasks: filtered.slice((page - 1) * pageSize, page * pageSize),
    total_count: flattened.length,
    filtered_count: filtered.length,
    page,
    page_count: pageCount,
    page_size: pageSize,
    filters: { q: query, project: projectId, status, sort },
    projects: context.projects.map((entry) => ({ id: entry.project.id, name: entry.project.name })),
    history_truncated: context.projects.some((entry) => entry.task_history_truncated),
    runtime: context.runtime,
  };
}
