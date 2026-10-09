import { UI_DISPLAY_NAME } from '../brand.js';
import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

function fileName(filePath) {
  return String(filePath ?? '').split(/[\\/]/u).pop() || 'Resource';
}

function time(value, t, locale) {
  if (!value) return t('not_available');
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? t('not_available') : date.toLocaleString(normalizeUiLocale(locale));
}

function initiatorLabel(item, t) {
  if (item.initiated_by?.channel === 'host') return item.initiated_by.agent || t('host');
  if (item.initiated_by?.channel === 'desktop') return 'Atlas Desktop';
  return 'Atlas';
}

function statusInfo(item, current, t) {
  const raw = String(item.status ?? (current ? 'running' : 'completed')).toLowerCase();
  if (raw === 'waiting') return { key: 'waiting', label: t('waiting') };
  if (['failed', 'interrupted'].includes(raw)) return { key: 'failed', label: t(raw === 'interrupted' ? 'interrupted' : 'failed') };
  if (['running', 'in progress', 'in_progress'].includes(raw)) return { key: 'running', label: t('running') };
  return { key: 'completed', label: t('done') };
}

function resourceName(item) {
  return item.resource_name || item.file_name || fileName(item.file_path);
}

function detailContent(item, current, csrfToken, t) {
  const purpose = item.purpose ? `<p><strong>${escapeHtml(t('purpose'))}</strong>${escapeHtml(item.purpose)}</p>` : '';
  const result = item.result_summary?.label ?? item.result_label ?? item.result;
  const resultLine = result ? `<p><strong>${escapeHtml(t('result'))}</strong>${escapeHtml(result)}</p>` : '';
  const error = item.error_message ?? item.error;
  const errorLine = error ? `<p class="activity-manager-error"><strong>${escapeHtml(t('reason'))}</strong>${escapeHtml(error)}</p>` : '';
  const recovery = item.recovery_href
    ? `<a class="action-button action-button-secondary" href="${escapeHtml(item.recovery_href)}">${escapeHtml(item.recovery_label ?? t('choose'))}</a>`
    : '';
  const dismiss = current && ['failed', 'interrupted'].includes(String(item.status ?? '').toLowerCase())
    ? `<form method="post" action="/activity/dismiss"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="activity_id" value="${escapeHtml(item.activity_id ?? '')}"><button class="action-button action-button-secondary" type="submit">${escapeHtml(t('dismiss'))}</button></form>`
    : '';
  const facts = purpose || resultLine || errorLine ? `${purpose}${resultLine}${errorLine}` : `<p>${escapeHtml(t('no_details'))}</p>`;
  return `<div class="activity-manager-detail"><div>${facts}</div>${recovery}${dismiss}</div>`;
}

function renderRow(item, { current = false, csrfToken, selectedActivityKey = null, t, locale } = {}) {
  const status = statusInfo(item, current, t);
  const name = resourceName(item);
  const resource = item.resource_href
    ? `<a href="${escapeHtml(item.resource_href)}">${escapeHtml(name)}</a>`
    : `<strong>${escapeHtml(name)}</strong>`;
  const updatedValue = item.updated_at ?? item.last_continued_at ?? item.inspected_at;
  const key = String(item.activity_id ?? item.work_id ?? item.file_path ?? name);
  const selected = selectedActivityKey === key;
  return `<details class="activity-manager-row is-${status.key}${selected ? ' is-selected' : ''}" data-activity-key="${escapeHtml(key)}"${selected ? ' open' : ''}><summary><span class="activity-manager-mark" aria-hidden="true"></span><span class="activity-manager-resource">${resource}<small>${escapeHtml(item.project?.name ?? t('no_project'))}</small></span><span class="activity-manager-status">${escapeHtml(status.label)}</span><span class="activity-manager-initiator">${escapeHtml(initiatorLabel(item, t))}</span><time datetime="${escapeHtml(updatedValue ?? '')}">${escapeHtml(time(updatedValue, t, locale))}</time></summary>${detailContent(item, current, csrfToken, t)}</details>`;
}

function currentSection(items, csrfToken, selectedActivityKey, t, locale) {
  if (items.length) return `<section class="activity-manager-section"><div class="activity-manager-section-heading"><div><h2>${escapeHtml(t('active'))}</h2><p>${escapeHtml(t('active_detail'))}</p></div></div><div class="activity-manager-list">${items.map((item) => renderRow(item, { current: true, csrfToken, selectedActivityKey, t, locale })).join('')}</div></section>`;
  return `<section class="activity-manager-section activity-manager-empty"><h2>${escapeHtml(t('no_active'))}</h2><p>${escapeHtml(t('no_active_detail'))}</p></section>`;
}

function recentSection(items, csrfToken, selectedActivityKey, t, locale) {
  if (!items.length) return '';
  return `<section class="activity-manager-section"><div class="activity-manager-section-heading"><div><h2>${escapeHtml(t('completed'))}</h2><p>${escapeHtml(t('completed_detail'))}</p></div></div><div class="activity-manager-list">${items.map((item) => renderRow(item, { csrfToken, selectedActivityKey, t, locale })).join('')}</div></section>`;
}

export function renderActivityFragment(model, options = {}) {
  const t = (key) => translateUi(options.locale, `activity.${key}`, options.languageCatalog);
  const current = model.current_activity ?? [];
  const recent = model.recent_work ?? [];
  return `<section class="activity-manager" data-activity-live data-events-href="/activity/events" data-fragment-href="/activity/fragment" data-connection-lost="${escapeHtml(t('connection_lost'))}" data-connection-live="${escapeHtml(t('connection_live'))}" data-connection-poll="${escapeHtml(t('connection_poll'))}"${model.selected_activity_key ? ` data-selected-activity="${escapeHtml(model.selected_activity_key)}"` : ''}${model.import_status_href ? ` data-import-status-href="${escapeHtml(model.import_status_href)}"` : ''}><p class="activity-manager-connection" aria-live="polite">${escapeHtml(t('connection'))}</p>${model.current_activity_error ? `<p class="callout warn">${escapeHtml(t('current_error'))}</p>` : ''}${currentSection(current, options.csrfToken, model.selected_activity_key, t, options.locale)}${model.recent_work_error ? `<p class="callout warn">${escapeHtml(t('recent_error'))}</p>` : ''}${recentSection(recent, options.csrfToken, model.selected_activity_key, t, options.locale)}</section>`;
}

export function renderActivityView(model, options = {}) {
  const t = (key) => translateUi(options.locale, `activity.${key}`, options.languageCatalog);
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${UI_DISPLAY_NAME} ${escapeHtml(t('title'))}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Activity', { ...options, project: options.project, interactive: true, workspaceHref: options.workspaceHref, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('title'), locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('eyebrow'))}</span><h1>${escapeHtml(t('title'))}</h1><p class="lede">${escapeHtml(t('lede'))}</p></div></div>${renderActivityFragment(model, options)}</main></div></div></body></html>`;
}
