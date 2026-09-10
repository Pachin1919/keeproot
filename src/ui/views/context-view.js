import {
  escapeHtml, renderFacts, renderNav, renderStatus, renderUiClientScript,
} from '../components.js';
import { uiStyles } from '../styles.js';

function routeText(rule) {
  const condition = [
    rule.condition?.origin,
    rule.condition?.kind,
    rule.condition?.extension,
    rule.condition?.data_class,
  ].filter(Boolean).join(' / ');
  const target = rule.value?.target_subdirectory
    ?? rule.value?.directory
    ?? rule.value?.role
    ?? rule.value?.strategy
    ?? 'no target';
  return `${rule.kind}${condition ? ` / ${condition}` : ''} -> ${target}`;
}

function taskList(tasks, options) {
  if (!tasks.length) return '<p class="muted">No pending Task.</p>';
  return `<ul class="path-list">${tasks.map((task) => `<li class="path-item">
    <strong class="mono">${options.taskBasePath
    ? `<a class="text-link" href="${escapeHtml(`${options.taskBasePath}${encodeURIComponent(task.task_id)}`)}">${escapeHtml(task.task_id)}</a>`
    : escapeHtml(task.task_id)}</strong> ${renderStatus(task.task_status)}<br>
    <span>${escapeHtml(task.intent)}</span><br>
    <span class="muted mono">${escapeHtml(task.target ?? 'No write target')}</span><br>
    <span class="muted">Source freshness: ${escapeHtml(task.source_freshness.status)}</span>
  </li>`).join('')}</ul>`;
}

function ruleHistory(history) {
  if (!history.recent.length) return '<p class="muted">No applicable RuleVersion history.</p>';
  return `${renderFacts([
    ['Active', history.active_count],
    ['Superseded', history.superseded_count],
  ])}<ul class="path-list">${history.recent.slice(0, 5).map((rule) => `<li class="path-item">
    <strong>${escapeHtml(rule.kind)}</strong> ${renderStatus(rule.status)}<br>
    <span class="mono">${escapeHtml(rule.rule_id)}</span><br>
    <span class="muted">${escapeHtml(rule.changed_value_fields.length
    ? `Changed: ${rule.changed_value_fields.join(', ')}`
    : 'Initial or unchanged value')}</span>
  </li>`).join('')}</ul>${history.truncated ? '<p class="muted">Only recent rules are shown.</p>' : ''}`;
}

function projectCards(projects, options) {
  if (!projects.length) return '<section class="surface"><p class="muted">No Project candidate is available.</p></section>';
  return projects.map((entry) => `
    <article class="surface project-card">
      <div class="card-heading"><div><span class="label">${escapeHtml(entry.relationship)}</span>
      <h2>${options.projectBasePath
    ? `<a class="text-link" href="${escapeHtml(`${options.projectBasePath}${encodeURIComponent(entry.project.id)}`)}">${escapeHtml(entry.project.name)}</a>`
    : escapeHtml(entry.project.name)}</h2></div>${renderStatus(entry.pending_tasks.length ? 'awaiting_review' : 'ready', entry.pending_tasks.length ? `${entry.pending_tasks.length} open` : 'quiet')}</div>
      ${renderFacts([
    ['Location', entry.location.relative_path, true],
    ['Project ID', entry.project.id, true],
  ])}
      <div class="surface-flat">
        <h3>Where work goes</h3>
        ${entry.routes.length
    ? `<ul class="path-list compact-list">${entry.routes.slice(0, options.projectDetail ? 8 : 3).map((route) => `<li class="path-item">${escapeHtml(routeText(route))}</li>`).join('')}</ul>`
    : '<p class="muted">No reusable route has been confirmed.</p>'}
      </div>
      <div class="surface-flat" id="tasks"><h3>Tasks</h3>${taskList(entry.tasks ?? entry.pending_tasks, options)}</div>
      ${options.projectDetail || !options.interactive ? `<div class="surface-flat"><h3>Rule history</h3>${ruleHistory(entry.rule_history)}</div>` : ''}
    </article>`).join('');
}

function runtimePanel(runtime) {
  if (!runtime) return '';
  return `<details class="surface technical-id">
    <summary>Runtime diagnostics</summary>
    ${renderFacts([
    ['Atlas', runtime.atlas_version, true],
    ['Node', runtime.node_version, true],
    ['Ledger', runtime.ledger?.integrity],
    ['Schema', runtime.ledger?.schema_version, true],
    ['Python', runtime.python?.status],
  ])}
    <div class="surface-flat">
      <h3>Local processors</h3>
      <ul class="path-list">${(runtime.processors ?? []).map((processor) => `<li class="path-item">
        <strong>${escapeHtml(processor.id)}</strong> ${renderStatus(processor.status)}<br>
        <span class="muted">${escapeHtml(processor.runtime ?? 'Not installed')} / network ${processor.network_used ? 'used' : 'not used'}</span>
      </li>`).join('')}</ul>
    </div>
  </details>`;
}

const TERMINAL_TASKS = new Set(['completed', 'rolled_back', 'rejected', 'cancelled']);

function latestTasks(projects, { projectId = null, attentionOnly = false, limit = 8 } = {}) {
  return projects
    .filter((entry) => !projectId || entry.project.id === projectId)
    .flatMap((entry) => (entry.tasks ?? []).map((task) => ({
      ...task, project_id: entry.project.id, project_name: entry.project.name,
      updated_at: task.closed_at ?? task.rolled_back_at ?? task.started_at ?? '',
    })))
    .filter((task) => !attentionOnly || !TERMINAL_TASKS.has(task.task_status))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, limit);
}

function attentionCount(entry) {
  return (entry.tasks ?? []).filter((task) => !TERMINAL_TASKS.has(task.task_status)).length;
}

function projectActivity(entry) {
  const recentWorkTime = (entry.recent_work ?? []).reduce((latest, item) => {
    const value = [item.inspected_at, item.last_continued_at].filter(Boolean).sort().at(-1) ?? '';
    return value.localeCompare(latest) > 0 ? value : latest;
  }, '');
  const savedWorkTime = String(entry.resources?.last_saved_at ?? '');
  const compatibilityActivity = String(latestTasks([entry], { limit: 1 })[0]?.updated_at ?? '');
  return [recentWorkTime, savedWorkTime, compatibilityActivity].sort().at(-1) ?? '';
}

function selectProject(model) {
  if (model.selected_project_id) {
    return model.projects.find((entry) => entry.project.id === model.selected_project_id) ?? model.projects[0] ?? null;
  }
  return [...model.projects].sort((left, right) => (
    projectActivity(right).localeCompare(projectActivity(left))
    || attentionCount(right) - attentionCount(left)
  ))[0] ?? null;
}

function projectRail(projects, selected, options) {
  if (!projects.length) return '<div class="studio-empty">No managed Project.</div>';
  return projects.map((entry) => {
    const isSelected = entry.project.id === selected?.project.id;
    const recentCount = entry.recent_work?.length ?? 0;
    return `<section class="project-tree-group">
      <a class="project-tree-parent${isSelected ? ' is-selected' : ''}" href="${escapeHtml(`${options.projectBasePath}${encodeURIComponent(entry.project.id)}`)}">
        <span>${escapeHtml(entry.project.name)}</span>${recentCount ? `<span class="count-badge" title="Recent file work">${escapeHtml(recentCount)}</span>` : ''}
      </a>
    </section>`;
  }).join('');
}

function projectContinue(entry, options) {
  const items = entry.recent_work ?? [];
  if (!items.length) {
    return '<div class="studio-empty"><strong>No recent file work</strong><span>Files added or inspected for this Project will appear here.</span></div>';
  }
  return `<div class="studio-table" role="table" aria-label="Recent Project files">
    <div class="studio-table-row studio-table-head" role="row"><span>File</span><span>Result</span><span>Last used</span><span>Action</span></div>
    ${items.map((item) => `<div class="studio-table-row" role="row"><span><strong>${escapeHtml(item.file_name)}</strong><small class="mono">${escapeHtml(item.file_path)}</small>${item.sheet ? `<small>Sheet: ${escapeHtml(item.sheet)}</small>` : ''}</span><span>${escapeHtml(item.result_status === 'check_on_continue' ? 'Previous result checked when you continue' : 'Not checked')}</span><span>${escapeHtml((item.last_continued_at ?? item.inspected_at ?? '').slice(0, 10) || 'Unknown')}</span><span><form method="post" action="/files/continue"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(item.work_id)}"><input type="hidden" name="return_to" value="/projects/${encodeURIComponent(entry.project.id)}"><button class="action-button action-button-continue" type="submit">Continue</button></form></span></div>`).join('')}
  </div>`;
}

function attentionItems(projects) {
  const priority = new Map([['blocked', 0], ['needs_input', 1], ['awaiting_review', 2], ['ready', 3]]);
  const tasks = latestTasks(projects, { attentionOnly: true, limit: 40 })
    .sort((left, right) => (priority.get(left.task_status) ?? 9) - (priority.get(right.task_status) ?? 9) || right.updated_at.localeCompare(left.updated_at))
    .slice(0, 3);
  const explanation = {
    blocked: 'Atlas stopped because a source or destination needs attention.',
    needs_input: 'Atlas needs your choice before it can continue.',
    awaiting_review: 'Changes are ready for review.',
    ready: 'A saved operation is ready to continue.',
  };
  if (!tasks.length) return '<div class="studio-empty">Nothing needs your attention.</div>';
  return tasks.map((task) => `<a class="decision-item" href="/tasks/${encodeURIComponent(task.task_id)}">
    <span class="decision-meta">${renderStatus(task.task_status)}<time>${escapeHtml(task.updated_at.slice(5, 10))}</time></span>
    <strong>${escapeHtml(task.intent)}</strong><small>${escapeHtml(task.project_name)}</small><p>${escapeHtml(explanation[task.task_status] ?? 'Open this item to see what Atlas needs.')}</p>
  </a>`).join('');
}

function sessionFooter(options) {
  return `<footer class="studio-runtime"><span class="runtime-local">Files stay on this device</span>${options.stopEndpoint ? `<form method="post" action="${escapeHtml(options.stopEndpoint)}"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><button type="submit">Stop Atlas</button></form>` : ''}</footer>`;
}

function renderInteractiveContext(model, options) {
  const selected = selectProject(model);
  const displayStatus = ['resolved', 'overview'].includes(model.resolution_status) ? 'ready' : (model.projects.length ? 'selection_required' : 'setup_required');
  if (!selected) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas Project Studio</title><style>${uiStyles()}</style></head><body><main class="page"><h1>Project setup required</h1><p>${escapeHtml(model.status_label)}</p></main></body></html>`;
  }
  const projectHref = `${options.projectBasePath}${encodeURIComponent(selected.project.id)}`;
  const latestActivity = projectActivity(selected).slice(0, 10) || 'No recent work';
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(selected.project.name)} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head>
  <body class="studio-body"><div class="studio-shell" style="${escapeHtml(options.railStyle ?? '')}">
    <header class="studio-header"><a class="studio-brand" href="${escapeHtml(options.workspaceHref ?? '/projects')}"><span class="brand-mark">A</span><span><strong>Atlas</strong><small>Local workspace</small></span></a><strong class="studio-title">Project</strong>
      <form class="global-search" method="get" action="${projectHref}/search"><label class="sr-only" for="global-q">Search Project files</label><input id="global-q" type="search" name="q" placeholder="Search this Project..."><button class="search-submit" type="submit">Search</button></form>
      <div class="studio-header-state">${renderStatus(displayStatus)}<a href="/projects">Projects</a><a href="/files">Files</a><a href="/settings">Settings</a></div>
    </header>
    <aside class="project-rail" id="atlas-project-rail"><div class="rail-search"><strong>Projects</strong><a class="text-link" href="/projects">View all</a></div><nav aria-label="Projects">${projectRail(model.projects, selected, options)}</nav></aside>
    <div class="rail-resizer project-rail-resizer" role="separator" aria-label="Resize Project navigation" aria-orientation="vertical" aria-valuemin="220" aria-valuemax="420" tabindex="0" data-rail="project"></div>
    <main class="studio-main">
      <nav class="breadcrumbs"><a href="${escapeHtml(options.workspaceHref ?? '/projects')}">Projects</a><span>/</span><strong>${escapeHtml(selected.project.name)}</strong></nav>
      <section class="project-hero"><div><h1>${escapeHtml(selected.project.name)}</h1><p><span>Continue from</span> ${escapeHtml(selected.recent_work.length)} recent file${selected.recent_work.length === 1 ? '' : 's'}.</p><div class="project-meta"><span><strong>Last used</strong>${escapeHtml(latestActivity)}</span></div></div><div class="inline-actions"><a class="action-button" href="${projectHref}/files">Browse</a><a class="action-button action-button-secondary" href="${projectHref}/search">Search</a><a class="action-button action-button-secondary" href="${projectHref}/compare">Compare</a></div></section>
      <nav class="studio-tabs" aria-label="Project sections"><a class="is-current" href="${escapeHtml(projectHref)}">Overview</a><a href="${projectHref}/resources">Resources</a></nav>
      <section class="studio-section"><div class="studio-section-heading"><h2>Continue</h2><a href="${projectHref}/files">Browse files</a></div>${projectContinue(selected, options)}</section>
      <section class="studio-section"><div class="studio-section-heading"><div><h2>Resources</h2><p class="muted">Atlas keeps the existing folder structure and only groups work identities it can confirm.</p></div><div><a href="${projectHref}/resources">Open Resources</a><a href="${projectHref}/files">Browse</a><a href="${projectHref}/search">Search</a><a href="${projectHref}/compare">Compare</a></div></div>${selected.resources ? `${selected.resources.saved_work_error ? '<p class="callout warn">Created results could not be loaded. Project files remain available.</p>' : ''}${renderFacts([['Known Sources', selected.resources.known_sources], ['Created Work', selected.resources.saved_work_error ? 'Unavailable' : selected.resources.created_work], ['Current Output', selected.resources.current_output ? 'Selected' : 'No current output selected'], [selected.resources.truncated ? 'Other Files shown' : 'Other Files', selected.resources.other_files]])}${selected.resources.truncated ? '<p class="muted">The resource summary is limited to the files Atlas could list locally. Browse shows the filesystem directly.</p>' : ''}` : '<p class="muted">Resources are unavailable until Atlas can read the Project folder.</p>'}</section>
    </main>
    <aside class="decision-rail"><div class="decision-heading"><div><h2>Needs your attention</h2><p>Reviews and conflicts for this Project.</p></div><span class="count-badge">${attentionCount(selected)}</span></div>${attentionItems([selected])}</aside>
    ${sessionFooter(options)}
  </div></body></html>`;
}

export function renderContextView(model, options = {}) {
  if (options.interactive) return renderInteractiveContext(model, options);
  const pageTitle = options.interactive ? 'Atlas Workspace' : 'Atlas Workspace Snapshot';
  const displayStatus = ['resolved', 'overview'].includes(model.resolution_status)
    ? 'ready'
    : (model.projects.length ? 'selection_required' : 'setup_required');
  const openTasks = model.projects.reduce((count, entry) => count + entry.pending_tasks.length, 0);
  const activeRoutes = model.projects.reduce((count, entry) => count + entry.routes.length, 0);
  return `<!doctype html>
<html lang="en" ${options.htmlAttributes ?? ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <style>${uiStyles()}</style>
  ${renderUiClientScript(Boolean(options.interactive))}
</head>
<body>
  <div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">
    ${renderNav('Projects', { interactive: Boolean(options.interactive), workspaceHref: options.workspaceHref ?? '/projects', settingsHref: options.settingsHref })}
    <div class="workspace">
      <header class="topbar">
        <div><span class="label">Atlas Desktop</span><strong>${escapeHtml(options.projectDetail ? model.projects[0]?.project.name : 'Local workspace')}</strong></div>
        ${renderStatus(displayStatus)}
      </header>
      <main class="page">
        <div class="page-intro"><div><span class="eyebrow">CONTROL PLANE / LOCAL</span><h1>${options.projectDetail ? escapeHtml(model.projects[0]?.project.name ?? 'Project') : (options.interactive ? 'Workspace' : 'Workspace snapshot')}</h1>
        <p class="lede">${escapeHtml(model.status_label)}</p></div></div>
        <section class="summary-strip" aria-label="Workspace summary">
          <div><span>Projects</span><strong>${escapeHtml(model.projects.length)}</strong></div>
          <div><span>Open tasks</span><strong>${escapeHtml(openTasks)}</strong></div>
          <div><span>Active routes</span><strong>${escapeHtml(activeRoutes)}</strong></div>
          <div><span>Ledger</span><strong>${escapeHtml(model.runtime?.ledger?.integrity ?? 'local')}</strong></div>
        </section>
        <div class="page-grid">
          <div class="main-column"><section class="project-grid">${projectCards(model.projects, options)}</section></div>
          <aside class="side-column">
            ${runtimePanel(model.runtime)}
            <section class="callout"><strong>What Atlas is doing</strong><br>Showing local identity, confirmed routes and exact Task state. Your Agent still interprets meaning and drafts content.</section>
            ${options.stopEndpoint ? `<section class="surface"><h2>Session</h2><p class="muted">Atlas is available only on this computer.</p><form method="post" action="${escapeHtml(options.stopEndpoint)}"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><button class="action-button action-button-secondary" type="submit">Stop Atlas</button></form></section>` : ''}
          </aside>
        </div>
      </main>
    </div>
  </div>
</body>
</html>`;
}
