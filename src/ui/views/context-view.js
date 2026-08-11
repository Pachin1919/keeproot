import { escapeHtml, renderFacts, renderNav, renderStatus } from '../components.js';
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

function taskList(tasks) {
  if (!tasks.length) return '<p class="muted">No pending Task.</p>';
  return `<ul class="path-list">${tasks.map((task) => `<li class="path-item">
    <strong class="mono">${escapeHtml(task.task_id)}</strong> ${renderStatus(task.task_status)}<br>
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

function projectCards(projects) {
  if (!projects.length) return '<section class="surface"><p class="muted">No Project candidate is available.</p></section>';
  return projects.map((entry) => `
    <article class="surface">
      <span class="label">${escapeHtml(entry.relationship)}</span>
      <h2>${escapeHtml(entry.project.name)}</h2>
      ${renderFacts([
    ['Project ID', entry.project.id, true],
    ['Location', entry.location.relative_path, true],
    ['Task', entry.task_status, true],
  ])}
      <div class="surface-flat">
        <h3>Effective routes</h3>
        ${entry.routes.length
    ? `<ul class="path-list">${entry.routes.map((route) => `<li class="path-item">${escapeHtml(routeText(route))}</li>`).join('')}</ul>`
    : '<p class="muted">No active route.</p>'}
      </div>
      <div class="surface-flat"><h3>Pending Tasks</h3>${taskList(entry.pending_tasks)}</div>
      <div class="surface-flat"><h3>Rule history</h3>${ruleHistory(entry.rule_history)}</div>
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

export function renderContextView(model) {
  const displayStatus = model.resolution_status === 'resolved'
    ? 'ready'
    : (model.projects.length ? 'selection_required' : 'setup_required');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atlas Workspace</title>
  <style>${uiStyles()}</style>
</head>
<body>
  <div class="app-shell">
    ${renderNav('Workspace')}
    <div class="workspace">
      <header class="topbar">
        <div><span class="label">Local workspace</span><strong>${escapeHtml(model.root?.id ?? 'Root not adopted')}</strong></div>
        ${renderStatus(displayStatus)}
      </header>
      <main class="page">
        <h1>Current context</h1>
        <p class="muted">${escapeHtml(model.status_label)}</p>
        <div class="page-grid">
          <div class="main-column"><section class="project-grid">${projectCards(model.projects)}</section></div>
          <aside class="side-column">
            ${runtimePanel(model.runtime)}
            <section class="callout"><strong>Responsibility boundary</strong><br>Atlas shows local identity, active routes and Task state. The Agent interprets the request and selects a Project.</section>
          </aside>
        </div>
      </main>
    </div>
  </div>
</body>
</html>`;
}
