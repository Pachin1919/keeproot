import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function fileName(filePath) {
  return String(filePath ?? '').split(/[\\/]/u).pop() || 'Resource';
}

function time(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Not available' : date.toLocaleString();
}

function initiatorLabel(item) {
  if (item.initiated_by?.channel === 'host') return item.initiated_by.agent || 'Execution Host';
  if (item.initiated_by?.channel === 'desktop') return 'Atlas Desktop';
  return 'Atlas';
}

function statusInfo(item, current) {
  const raw = String(item.status ?? (current ? 'running' : 'completed')).toLowerCase();
  if (raw === 'waiting') return { key: 'waiting', label: 'Waiting' };
  if (['failed', 'interrupted'].includes(raw)) return { key: 'failed', label: raw === 'interrupted' ? 'Interrupted' : 'Failed' };
  if (['running', 'in progress', 'in_progress'].includes(raw)) return { key: 'running', label: 'In progress' };
  return { key: 'completed', label: 'Completed' };
}

function resourceName(item) {
  return item.resource_name || item.file_name || fileName(item.file_path);
}

function detailContent(item, current, csrfToken) {
  const purpose = item.purpose ? `<p><strong>Purpose</strong>${escapeHtml(item.purpose)}</p>` : '';
  const result = item.result_summary?.label ?? item.result_label ?? item.result;
  const resultLine = result ? `<p><strong>Result</strong>${escapeHtml(result)}</p>` : '';
  const error = item.error_message ?? item.error;
  const errorLine = error ? `<p class="activity-manager-error"><strong>Reason</strong>${escapeHtml(error)}</p>` : '';
  const recovery = item.recovery_href
    ? `<a class="action-button action-button-secondary" href="${escapeHtml(item.recovery_href)}">${escapeHtml(item.recovery_label ?? 'Choose how to continue')}</a>`
    : '';
  const dismiss = current && ['failed', 'interrupted'].includes(String(item.status ?? '').toLowerCase())
    ? `<form method="post" action="/activity/dismiss"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="activity_id" value="${escapeHtml(item.activity_id ?? '')}"><button class="action-button action-button-secondary" type="submit">Dismiss</button></form>`
    : '';
  const facts = purpose || resultLine || errorLine ? `${purpose}${resultLine}${errorLine}` : '<p>Atlas has no additional recorded detail for this work.</p>';
  return `<div class="activity-manager-detail"><div>${facts}</div>${recovery}${dismiss}</div>`;
}

function renderRow(item, { current = false, csrfToken, selectedActivityKey = null } = {}) {
  const status = statusInfo(item, current);
  const name = resourceName(item);
  const resource = item.resource_href
    ? `<a href="${escapeHtml(item.resource_href)}">${escapeHtml(name)}</a>`
    : `<strong>${escapeHtml(name)}</strong>`;
  const updatedValue = item.updated_at ?? item.last_continued_at ?? item.inspected_at;
  const key = String(item.activity_id ?? item.work_id ?? item.file_path ?? name);
  const selected = selectedActivityKey === key;
  return `<details class="activity-manager-row is-${status.key}${selected ? ' is-selected' : ''}" data-activity-key="${escapeHtml(key)}"${selected ? ' open' : ''}><summary><span class="activity-manager-mark" aria-hidden="true"></span><span class="activity-manager-resource">${resource}<small>${escapeHtml(item.project?.name ?? 'No Project')}</small></span><span class="activity-manager-status">${escapeHtml(status.label)}</span><span class="activity-manager-initiator">${escapeHtml(initiatorLabel(item))}</span><time datetime="${escapeHtml(updatedValue ?? '')}">${escapeHtml(time(updatedValue))}</time></summary>${detailContent(item, current, csrfToken)}</details>`;
}

function currentSection(items, csrfToken, selectedActivityKey) {
  if (items.length) return `<section class="activity-manager-section"><div class="activity-manager-section-heading"><div><h2>Active work</h2><p>Local work that may need your attention.</p></div></div><div class="activity-manager-list">${items.map((item) => renderRow(item, { current: true, csrfToken, selectedActivityKey })).join('')}</div></section>`;
  return '<section class="activity-manager-section activity-manager-empty"><h2>No active work</h2><p>Completed local work appears below only if present.</p></section>';
}

function recentSection(items, csrfToken, selectedActivityKey) {
  if (!items.length) return '';
  return `<section class="activity-manager-section"><div class="activity-manager-section-heading"><div><h2>Completed local work</h2><p>Recent local results available to inspect.</p></div></div><div class="activity-manager-list">${items.map((item) => renderRow(item, { csrfToken, selectedActivityKey })).join('')}</div></section>`;
}

export function renderActivityFragment(model, options = {}) {
  const current = model.current_activity ?? [];
  const recent = model.recent_work ?? [];
  return `<section class="activity-manager" data-activity-live data-events-href="/activity/events" data-fragment-href="/activity/fragment"${model.selected_activity_key ? ` data-selected-activity="${escapeHtml(model.selected_activity_key)}"` : ''}${model.import_status_href ? ` data-import-status-href="${escapeHtml(model.import_status_href)}"` : ''}><p class="activity-manager-connection" aria-live="polite">Checking local activity connection.</p>${model.current_activity_error ? '<p class="callout warn">Current activity could not be loaded. Existing local state was left unchanged.</p>' : ''}${currentSection(current, options.csrfToken, model.selected_activity_key)}${model.recent_work_error ? '<p class="callout warn">Completed local work could not be loaded. Existing local state was left unchanged.</p>' : ''}${recentSection(recent, options.csrfToken, model.selected_activity_key)}</section>`;
}

export function renderActivityView(model, options = {}) {
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas Activity</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Activity', { interactive: true, workspaceHref: options.workspaceHref, settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Activity' })}<main class="page"><div class="page-intro"><div><span class="eyebrow">LOCAL ACTIVITY</span><h1>Activity</h1><p class="lede">See active and completed local work in one place.</p></div></div>${renderActivityFragment(model, options)}</main></div></div></body></html>`;
}
