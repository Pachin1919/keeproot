import {
  escapeHtml, renderFacts, renderNav, renderStatus, renderStatusGuide, renderUiClientScript,
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
  return `<section class="surface">
    <h2>Runtime</h2>
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
  </section>`;
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

function ruleTarget(rule) {
  return rule.value?.target_subdirectory ?? rule.value?.directory ?? rule.value?.role ?? rule.kind;
}

function selectProject(model) {
  if (model.selected_project_id) {
    return model.projects.find((entry) => entry.project.id === model.selected_project_id) ?? model.projects[0] ?? null;
  }
  return [...model.projects].sort((left, right) => (
    attentionCount(right) - attentionCount(left)
    || String(latestTasks([right], { limit: 1 })[0]?.updated_at ?? '')
      .localeCompare(String(latestTasks([left], { limit: 1 })[0]?.updated_at ?? ''))
  ))[0] ?? null;
}

function projectRail(projects, selected, options) {
  if (!projects.length) return '<div class="studio-empty">No managed Project.</div>';
  return projects.map((entry) => {
    const isSelected = entry.project.id === selected?.project.id;
    const routes = entry.routes.slice(0, 3);
    return `<section class="project-tree-group">
      <a class="project-tree-parent${isSelected ? ' is-selected' : ''}" href="${escapeHtml(`${options.projectBasePath}${encodeURIComponent(entry.project.id)}`)}">
        <span>${escapeHtml(entry.project.name)}</span><span class="count-badge">${attentionCount(entry)}</span>
      </a>
      ${isSelected && routes.length ? `<div class="project-tree-children">${routes.map((route) => `<span>${escapeHtml(ruleTarget(route))}</span>`).join('')}</div>` : ''}
    </section>`;
  }).join('');
}

function activeTaskTable(entry) {
  const tasks = latestTasks([entry], { attentionOnly: true, limit: 7 });
  if (!tasks.length) return '<div class="studio-empty"><strong>No active task</strong><span>Completed work remains available from the Tasks page.</span></div>';
  return `<div class="studio-table" role="table" aria-label="Active tasks">
    <div class="studio-table-row studio-table-head" role="row"><span>Task</span><span>Source</span><span>Mode</span><span>Status</span><span>Updated</span></div>
    ${tasks.map((task) => `<a class="studio-table-row" role="row" href="/tasks/${encodeURIComponent(task.task_id)}">
      <span><strong>${escapeHtml(task.intent)}</strong><small class="mono technical-id">${escapeHtml(task.task_id)}</small></span>
      <span class="truncate-cell">${escapeHtml(task.primary_source ?? (task.selected_source_count ? `${task.selected_source_count} selected sources` : 'No Source Set'))}</span>
      <span>${escapeHtml(task.strategy ?? task.write_mode ?? 'inspect')}</span>
      <span>${renderStatus(task.task_status)}</span>
      <span class="mono">${escapeHtml(task.updated_at.slice(0, 10))}</span>
    </a>`).join('')}
  </div>`;
}

function recentSources(entry) {
  const sources = [];
  const seen = new Set();
  for (const task of latestTasks([entry], { limit: 20 })) {
    if (!task.primary_source || seen.has(task.primary_source)) continue;
    seen.add(task.primary_source);
    sources.push({ path: task.primary_source, date: task.updated_at.slice(0, 10), task_id: task.task_id });
    if (sources.length === 6) break;
  }
  if (!sources.length) return '<div class="studio-empty">No selected source path is available in recent Tasks.</div>';
  return `<div class="source-grid">${sources.map((source) => `<a href="/tasks/${encodeURIComponent(source.task_id)}"><strong>${escapeHtml(source.path)}</strong><small>Used ${escapeHtml(source.date)}</small></a>`).join('')}</div>`;
}

function latestVerifiedOutput(entry) {
  const task = latestTasks([entry], { limit: 50 }).find((item) => item.task_status === 'completed' && item.target);
  if (!task) return '<div class="studio-empty">No completed output is recorded for this Project.</div>';
  return `<a class="verified-output" href="/tasks/${encodeURIComponent(task.task_id)}">
    <span class="output-mark">OK</span><span><strong>${escapeHtml(task.target)}</strong><small>Verified Task ${escapeHtml(task.task_id)} · ${escapeHtml(task.updated_at.slice(0, 10))}</small></span><span>${renderStatus('verified')}</span>
  </a>`;
}

function decisionInbox(projects) {
  const priority = new Map([['blocked', 0], ['needs_input', 1], ['awaiting_review', 2], ['ready', 3]]);
  const tasks = latestTasks(projects, { attentionOnly: true, limit: 40 })
    .sort((left, right) => (priority.get(left.task_status) ?? 9) - (priority.get(right.task_status) ?? 9) || right.updated_at.localeCompare(left.updated_at))
    .slice(0, 3);
  const explanation = {
    blocked: 'Atlas stopped this Task. Inspect the conflict before continuing.',
    needs_input: 'A user decision is required before work can continue.',
    awaiting_review: 'The proposed change is waiting for review.',
    ready: 'The next controlled action is ready to inspect.',
  };
  if (!tasks.length) return '<div class="studio-empty">No decision is waiting.</div>';
  return tasks.map((task) => `<a class="decision-item" href="/tasks/${encodeURIComponent(task.task_id)}">
    <span class="decision-meta">${renderStatus(task.task_status)}<time>${escapeHtml(task.updated_at.slice(5, 10))}</time></span>
    <strong>${escapeHtml(task.intent)}</strong><small>${escapeHtml(task.project_name)}</small><p>${escapeHtml(explanation[task.task_status] ?? 'Open this Task to inspect its current state.')}</p>
  </a>`).join('');
}

function runtimeFooter(runtime, options) {
  if (!runtime) return '';
  const ledgerIntegrity = runtime.ledger?.integrity ?? 'unavailable';
  return `<footer class="studio-runtime"><span>Ledger health ${renderStatus(ledgerIntegrity)}</span><span>Atlas ${escapeHtml(runtime.atlas_version)}</span><span>Python tools ${renderStatus(runtime.python?.status ?? 'unavailable')}</span><span>Ledger schema v${escapeHtml(runtime.ledger?.schema_version ?? 'n/a')}</span>${renderStatusGuide()}<span class="runtime-local">Atlas state is stored locally</span>${options.stopEndpoint ? `<form method="post" action="${escapeHtml(options.stopEndpoint)}"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><button type="submit">Stop</button></form>` : ''}</footer>`;
}

function renderInteractiveContext(model, options) {
  const selected = selectProject(model);
  const displayStatus = ['resolved', 'overview'].includes(model.resolution_status) ? 'ready' : (model.projects.length ? 'selection_required' : 'setup_required');
  if (!selected) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas Project Studio</title><style>${uiStyles()}</style></head><body><main class="page"><h1>Project setup required</h1><p>${escapeHtml(model.status_label)}</p></main></body></html>`;
  }
  const projectHref = `${options.projectBasePath}${encodeURIComponent(selected.project.id)}`;
  const latestActivity = latestTasks([selected], { limit: 1 })[0]?.updated_at?.slice(0, 10) ?? 'No activity';
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(selected.project.name)} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head>
  <body class="studio-body"><div class="studio-shell" style="${escapeHtml(options.railStyle ?? '')}">
    <header class="studio-header"><a class="studio-brand" href="/"><span class="brand-mark">A</span><span><strong>Atlas</strong><small>Local governance</small></span></a><strong class="studio-title">Project Studio</strong>
      <form class="global-search" method="get" action="/tasks"><label class="sr-only" for="global-q">Search Atlas</label><input id="global-q" type="search" name="q" placeholder="Search projects, sources, tasks, rules..."><button class="search-submit" type="submit">Search</button></form>
      <div class="studio-header-state">${renderStatus(displayStatus)}<a href="/tasks">All tasks</a><a href="/settings">Settings</a></div>
    </header>
    <aside class="project-rail" id="atlas-project-rail"><form class="rail-search" method="get" action="/tasks"><label class="sr-only" for="rail-q">Search projects and tasks</label><input id="rail-q" type="search" name="q" placeholder="Search projects..."><button class="search-submit" type="submit">Search</button></form><nav aria-label="Projects">${projectRail(model.projects, selected, options)}</nav></aside>
    <div class="rail-resizer project-rail-resizer" role="separator" aria-label="Resize Project navigation" aria-orientation="vertical" aria-valuemin="220" aria-valuemax="420" tabindex="0" data-rail="project"></div>
    <main class="studio-main">
      <nav class="breadcrumbs"><a href="/">Projects</a><span>/</span><strong>${escapeHtml(selected.project.name)}</strong></nav>
      <section class="project-hero"><div><h1>${escapeHtml(selected.project.name)}</h1><p><span>Governed scope</span> ${escapeHtml(selected.routes.length)} confirmed routes and ${escapeHtml(selected.tasks.length)} recorded Tasks.</p><p><span>Current boundary</span> ${escapeHtml(selected.location.relative_path ?? selected.location.root_path ?? 'Location unavailable')}</p><div class="project-meta"><span><strong>Relationship</strong>${escapeHtml(selected.relationship)}</span><span class="technical-id"><strong>Project ID</strong><span class="mono">${escapeHtml(selected.project.id)}</span></span><span><strong>Last activity</strong>${escapeHtml(latestActivity)}</span></div></div></section>
      <nav class="studio-tabs" aria-label="Project sections"><a class="is-current" href="${escapeHtml(projectHref)}">Overview</a><a href="/tasks?project=${encodeURIComponent(selected.project.id)}&status=active">Active tasks <span>${attentionCount(selected)}</span></a><a href="#sources">Sources</a><a href="#output">Output</a><a href="#rules">Rules</a></nav>
      <section class="studio-section"><div class="studio-section-heading"><h2>Active tasks</h2><div><a href="/tasks?project=${encodeURIComponent(selected.project.id)}">Filter</a><a href="/tasks?project=${encodeURIComponent(selected.project.id)}&sort=newest">Sort: Updated</a></div></div>${activeTaskTable(selected)}</section>
      <section class="studio-section" id="sources"><div class="studio-section-heading"><h2>Recent sources</h2><a href="/tasks?project=${encodeURIComponent(selected.project.id)}">View all</a></div>${recentSources(selected)}</section>
      <section class="studio-section" id="output"><div class="studio-section-heading"><h2>Latest verified output</h2></div>${latestVerifiedOutput(selected)}</section>
      <section class="studio-section studio-rules" id="rules"><details><summary>Project rules and technical identity</summary><div class="rules-grid"><div><h3>Confirmed routes</h3>${selected.routes.length ? `<ul>${selected.routes.map((rule) => `<li>${escapeHtml(routeText(rule))}</li>`).join('')}</ul>` : '<p>No confirmed routes.</p>'}</div><div><h3>Rule history</h3>${ruleHistory(selected.rule_history)}</div><div><h3>Identity</h3>${renderFacts([['Project ID', selected.project.id, true], ['Relationship', selected.relationship]])}</div></div></details></section>
    </main>
    <aside class="decision-rail"><div class="decision-heading"><div><h2>Decision inbox</h2><p>Approvals and conflicts across Projects.</p></div><span class="count-badge">${model.projects.reduce((sum, entry) => sum + attentionCount(entry), 0)}</span></div>${decisionInbox(model.projects)}<a class="decision-all" href="/tasks?status=action_required">View full inbox</a></aside>
    ${runtimeFooter(model.runtime, options)}
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
    ${renderNav('Workspace', { interactive: Boolean(options.interactive), workspaceHref: options.workspaceHref ?? '/', settingsHref: options.settingsHref })}
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
