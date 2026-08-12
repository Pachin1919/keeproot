import { escapeHtml, renderNav, renderStatus, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function queryString(filters, page) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.project !== 'all') params.set('project', filters.project);
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.sort !== 'newest') params.set('sort', filters.sort);
  if (page > 1) params.set('page', String(page));
  const value = params.toString();
  return value ? `?${value}` : '';
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function taskRows(tasks) {
  if (!tasks.length) return '<div class="empty-state"><strong>No matching tasks</strong><p>Clear a filter or use a broader search.</p></div>';
  return `<div class="task-table" role="table" aria-label="Atlas tasks">
    <div class="task-row task-row-head" role="row"><span>Status</span><span>Task</span><span>Project</span><span>Updated</span></div>
    ${tasks.map((task) => `<a class="task-row" role="row" href="/tasks/${encodeURIComponent(task.task_id)}">
      <span>${renderStatus(task.task_status)}</span>
      <span><strong>${escapeHtml(task.intent || task.task_id)}</strong><small class="mono technical-id">${escapeHtml(task.task_id)}</small><small>${escapeHtml(task.target ?? 'No write target')}</small></span>
      <span>${escapeHtml(task.project_name)}</span>
      <span class="mono">${escapeHtml(task.updated_at ? task.updated_at.slice(0, 10) : 'Unknown')}</span>
    </a>`).join('')}
  </div>`;
}

function pagination(model) {
  if (model.page_count <= 1) return '';
  return `<nav class="pagination" aria-label="Task pages">
    ${model.page > 1 ? `<a href="/tasks${escapeHtml(queryString(model.filters, model.page - 1))}">Previous</a>` : '<span></span>'}
    <span>Page ${model.page} of ${model.page_count}</span>
    ${model.page < model.page_count ? `<a href="/tasks${escapeHtml(queryString(model.filters, model.page + 1))}">Next</a>` : '<span></span>'}
  </nav>`;
}

export function renderTasksView(model, options = {}) {
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas Tasks</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head>
  <body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Tasks', { interactive: true, workspaceHref: options.workspaceHref ?? '/', settingsHref: options.settingsHref })}
  <div class="workspace"><header class="topbar"><div><span class="label">Atlas Desktop</span><strong>Task queue</strong></div>${renderStatus(model.runtime?.ledger?.integrity ?? 'local')}</header>
  <main class="page"><div class="page-intro"><div><span class="eyebrow">WORK QUEUE</span><h1>Tasks</h1><p class="lede">Find current work without opening every Project.</p></div></div>
  <section class="surface filter-surface"><form class="filters" method="get" action="/tasks">
    <label class="filter-search"><span>Search</span><input name="q" type="search" value="${escapeHtml(model.filters.q)}" placeholder="Task, target or Project"></label>
    <label><span>Project</span><select name="project">${option('all', 'All projects', model.filters.project)}${model.projects.map((project) => option(project.id, project.name, model.filters.project)).join('')}</select></label>
    <label><span>Status</span><select name="status">${option('all', 'All statuses', model.filters.status)}${option('action_required', 'Needs attention', model.filters.status)}${option('active', 'Active', model.filters.status)}${option('completed', 'Completed', model.filters.status)}${option('blocked', 'Blocked', model.filters.status)}${option('rolled_back', 'Rolled back', model.filters.status)}</select></label>
    <label><span>Sort</span><select name="sort">${option('newest', 'Newest first', model.filters.sort)}${option('oldest', 'Oldest first', model.filters.sort)}${option('project', 'Project', model.filters.sort)}${option('status', 'Status', model.filters.sort)}</select></label>
    <div class="filter-actions"><button class="action-button" type="submit">Apply</button><a class="action-button action-button-secondary" href="/tasks">Clear</a></div>
  </form></section>
  <div class="results-heading"><strong>${model.filtered_count} task${model.filtered_count === 1 ? '' : 's'}</strong><span class="muted">${model.total_count} available in this workspace${model.history_truncated ? ' · latest 500 per Project' : ''}</span></div>
  <section class="surface table-surface">${taskRows(model.tasks)}${pagination(model)}</section>
  </main></div></div></body></html>`;
}
