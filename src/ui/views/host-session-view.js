import { UI_DISPLAY_NAME } from '../brand.js';
import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';
import { uiStyles } from '../styles.js';

export const HOST_SESSION_STATUSES = ['starting', 'ready', 'running', 'cancelling', 'awaiting_permission', 'completed', 'failed', 'interrupted', 'disconnected', 'outcome_unknown'];
const stopped = new Set(['completed', 'failed', 'interrupted', 'disconnected', 'outcome_unknown']);

export function renderHostSessionError(model, options = {}) {
  const t = key => translateUi(options.locale, `workspace.${key}`, options.languageCatalog);
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(t('host_title'))} · ${UI_DISPLAY_NAME}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="product-workspace-body"><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { ...options, project: model.project, interactive: true })}<div class="workspace">${renderTopbar({ section: t('host_title'), ...options, project: model.project })}<main class="page"><section class="surface"><h1>${escapeHtml(t('host_title'))}</h1><p class="callout warn" role="alert">${escapeHtml(model.notice)}</p>${model.disabled ? `<p>${escapeHtml(t('host_access'))}</p><p>${escapeHtml(t('host_enable_help'))}</p>` : ''}<p>${escapeHtml(t('host_output_notice'))}</p><a class="action-button action-button-secondary" href="${escapeHtml(model.backHref ?? '/projects')}">${escapeHtml(t(model.backHref?.includes('/handoffs/') ? 'host_back' : model.project ? 'project_home' : 'choose_project'))}</a></section></main></div></div></body></html>`;
}

export function renderHostSessionStart(model, options = {}) {
  const t = key => translateUi(options.locale, `workspace.${key}`, options.languageCatalog);
  const h = key => escapeHtml(t(key));
  const handoff = model.handoff;
  const availability = model.host_availability ?? { enabled: false };
  const enabled = availability.enabled === true && handoff.status === 'current';
  const diagnostic = availability.reason && !['disabled', 'actual_access_and_account_authorization_required'].includes(availability.reason)
    ? `<details><summary>${h('host_details')}</summary><p>${escapeHtml(availability.reason)}</p></details>` : '';
  const form = enabled ? `<form method="post" action="${escapeHtml(`${model.base}/host-sessions`)}" class="host-session-start"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><input type="hidden" name="handoff_id" value="${escapeHtml(handoff.handoff_id)}"><input type="hidden" name="expected_digest" value="${escapeHtml(handoff.digest)}"><input type="hidden" name="expected_work_revision" value="${escapeHtml(handoff.work_revision)}"><input type="hidden" name="request_key" value="${escapeHtml(model.host_request_key)}"><label>${h('host_prompt')}<textarea name="prompt" maxlength="16000" rows="4" required></textarea></label><button class="action-button" type="submit">${h('host_start')}</button></form>` : `<p class="callout">${h(handoff.status === 'current' ? 'host_disabled' : 'host_stale')}</p>${diagnostic}<p>${h('host_enable_help')}</p><p>${h('host_external')}</p>`;
  return `<section class="surface host-session-entry"><h2>${h('host_title')}</h2><p>${h('host_intro')}</p><p class="host-access-notice">${h('host_access')}</p>${form}<p class="muted">${h('host_output_notice')}</p></section>`;
}

export function renderHostSessionView(model, options = {}) {
  const locale = normalizeUiLocale(options.locale);
  const t = key => translateUi(locale, `workspace.${key}`, options.languageCatalog);
  const h = key => escapeHtml(t(key));
  const session = model.session;
  const project = model.project;
  const base = `/projects/${encodeURIComponent(project.id)}/host-sessions/${encodeURIComponent(session.session_id)}`;
  const messages = Object.fromEntries(HOST_SESSION_STATUSES.map(status => [status, t(`host_state_${status}`)]));
  messages.poll_failed = t('host_poll_failed'); messages.result = t('host_result'); messages.result_pending = t('host_result_pending');
  const hidden = value => value ? '' : ' hidden';
  const identity = `<input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><input type="hidden" name="expected_revision" value="${escapeHtml(session.revision)}" data-host-revision>`;
  const pending = session.pending_permission;
  const groups = new Map();
  for (const event of model.events ?? []) if (event.kind === 'message') {
    const key = event.item_id ?? String(event.sequence);
    const previous = groups.get(key);
    groups.set(key, { ...event, item_id: key, text: (previous?.text ?? '') + (event.text ?? '') });
  }
  const row = event => `<li data-host-sequence="${escapeHtml(event.sequence)}" data-host-event-kind="${escapeHtml(event.kind)}"${event.kind === 'message' ? ` data-host-message-item="${escapeHtml(event.item_id)}"` : ''}><pre>${escapeHtml(event.text ?? '')}</pre></li>`;
  const events = [...groups.values()].map(row).join('');
  const technicalEvents = (model.events ?? []).filter(event => event.kind !== 'message').map(row).join('');
  const statusLabel = messages[session.status] ?? session.status;
  return `<!doctype html><html lang="${locale}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h('host_title')} · ${UI_DISPLAY_NAME}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="product-workspace-body"><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { ...options, project, interactive: true })}<div class="workspace">${renderTopbar({ section: t('host_title'), project, locale, languageCatalog: options.languageCatalog })}<main class="page host-session-page" data-host-session="${escapeHtml(session.session_id)}" data-host-project="${escapeHtml(project.id)}" data-host-events-url="${escapeHtml(`${base}/events`)}" data-host-sequence="${escapeHtml(model.last_sequence ?? session.last_sequence ?? 0)}" data-host-last-sequence="${escapeHtml(session.last_sequence ?? 0)}" data-host-status="${escapeHtml(session.status)}" data-host-messages="${escapeHtml(JSON.stringify(messages))}"><div class="page-intro"><div><span class="eyebrow">${h('host_title')}</span><h1>${escapeHtml(project.name)}</h1><p class="lede">${h('host_output_notice')}</p></div><a class="action-button action-button-secondary" href="/projects/${encodeURIComponent(project.id)}/handoffs/${encodeURIComponent(session.handoff_id)}">${h('host_back')}</a></div>${model.notice ? `<p class="callout warn" role="alert">${escapeHtml(model.notice)}</p>` : ''}<section class="surface host-session-state"><h2>${h('host_status')}</h2><p data-host-status-label role="status">${escapeHtml(statusLabel)}</p><p data-host-result-label>${h(session.result_available ? 'host_result' : 'host_result_pending')}</p><p class="callout warn" data-host-error${hidden(session.error)}>${escapeHtml(session.error?.message ?? '')}</p><p class="muted" data-host-connection>${h('host_live')}</p><div class="inline-actions"><form method="post" action="${base}/cancel" data-host-cancel${hidden(!stopped.has(session.status) && session.status !== 'cancelling')}>${identity}<button class="action-button action-button-secondary" type="submit">${h('host_cancel')}</button></form><form method="post" action="${base}/reconnect" data-host-reconnect${hidden(session.status === 'disconnected')}>${identity}<button class="action-button" type="submit">${h('host_reconnect')}</button></form><a class="text-link" href="${base}">${h('host_refresh')}</a></div><p class="muted" data-host-reconnect-help${hidden(session.status === 'disconnected')}>${h('host_reconnect_help')}</p></section><section class="surface host-session-permission" data-host-permission${hidden(pending)}><h2>${h('host_permission')}</h2><p data-host-permission-description>${escapeHtml(pending?.description ?? '')}</p><p>${h('host_expires')}: <time data-host-permission-expires datetime="${escapeHtml(pending?.expires_at ?? '')}">${escapeHtml(pending?.expires_at ?? '')}</time></p><p>${h('host_permission_help')}</p><form method="post" action="${base}/deny">${identity}<input type="hidden" name="request_id" value="${escapeHtml(pending?.request_id ?? '')}" data-host-request><button class="action-button action-button-secondary" type="submit">${h('host_deny')}</button></form></section><section class="surface host-session-response"><h2>${h('host_events')}</h2><p data-host-empty${hidden(!events)}>${h('host_empty')}</p><ol class="host-session-events" data-host-events>${events}</ol></section><details class="surface host-session-identity"><summary>${h('host_details')}</summary><dl><dt>${h('host_identity_session')}</dt><dd>${escapeHtml(session.session_id)}</dd><dt>${h('host_identity_project')}</dt><dd>${escapeHtml(session.project_id)}</dd><dt>${h('host_identity_handoff')}</dt><dd>${escapeHtml(session.handoff_id)}</dd><dt>${h('host_identity_thread')}</dt><dd>${escapeHtml(session.thread_id ?? '')}</dd><dt>${h('host_identity_turn')}</dt><dd>${escapeHtml(session.turn_id ?? '')}</dd></dl><ol class="host-session-events" data-host-technical-events>${technicalEvents}</ol></details></main></div></div></body></html>`;
}
