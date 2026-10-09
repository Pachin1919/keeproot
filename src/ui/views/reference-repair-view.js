import { UI_DISPLAY_NAME } from '../brand.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

const sourceFields = ['source_kind', 'operation_id', 'source_project_id', 'source_revision', 'source_digest'];
function skippedItem(item) {
  if (typeof item === 'string') return escapeHtml(item);
  const location = item.bounded_location == null ? '' : typeof item.bounded_location === 'string' ? item.bounded_location : JSON.stringify(item.bounded_location);
  return `<strong>${escapeHtml(item.reason)}</strong>${location ? ` · <small>${escapeHtml(location)}</small>` : ''}`;
}

export function referenceRepairHref(projectId, kind, receipt, sourceProjectId) {
  const query = new URLSearchParams({ source_kind: kind, operation_id: receipt.move_id ?? receipt.operation_id,
    source_project_id: sourceProjectId, source_revision: String(receipt.revision), source_digest: receipt.digest });
  return `/projects/${encodeURIComponent(projectId)}/document-updates/repair?${query}`;
}

function shell(model, options, body) {
  const h = value => escapeHtml(value ?? '');
  const t = key => translateUi(options.locale, `repair.${key}`, options.languageCatalog);
  const base = `/projects/${encodeURIComponent(model.project.id)}`;
  const step = model.update?.execution || model.update?.pending || model.update?.decision?.kind === 'accept-suggestion' ? 2 : model.update || model.results ? 1 : 0;
  const steps = `<ol class="document-review-steps" aria-label="${h(t('title'))}">${['repair_select_step', 'repair_review_step', 'repair_apply_step'].map((key, index) => `<li${index === step ? ' aria-current="step"' : ''}><span>${index + 1}</span>${h(translateUi(options.locale, `workspace.${key}`, options.languageCatalog))}</li>`).join('')}</ol>`;
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${h(t('title'))} · ${UI_DISPLAY_NAME}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="product-workspace-body"><div class="app-shell" style="${h(options.railStyle)}">${renderNav('Projects', { ...options, project: model.project, interactive: true, workspaceHref: '/projects', resourcesHref: `${base}/resources`, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('title'), project: model.project, locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page reference-repair"><div class="page-intro"><h1>${h(t('title'))}</h1><a class="text-link" href="${h(`${base}/resources`)}">${h(t('resources'))}</a></div>${steps}${model.notice ? `<p class="callout warn" role="alert">${h(model.notice)}</p>` : ''}${body}</main></div></div></body></html>`;
}

export function renderReferenceRepairView(model, options = {}) {
  const h = value => escapeHtml(value ?? '');
  const t = key => translateUi(options.locale, `repair.${key}`, options.languageCatalog);
  const base = `/projects/${encodeURIComponent(model.project.id)}`;
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${h(value)}">`;
  const source = model.source ?? {};
  const displayPath = value => model.basis?.root_path ? path.relative(model.basis.root_path, value).replaceAll('\\', '/') || '.' : value;
  const receiptHref = source.source_kind === 'project_move'
    ? `/projects/${encodeURIComponent(source.source_project_id)}/move/${encodeURIComponent(source.operation_id)}`
    : `/projects/${encodeURIComponent(source.source_project_id)}/membership/${encodeURIComponent(source.operation_id)}`;
  const sourceInfo = `<section class="surface"><h2>${h(t('source'))}</h2><a href="${h(receiptHref)}">${h(t(source.source_kind))}</a>${model.basis ? `<p>${h(displayPath(model.basis.from_path))} → ${h(displayPath(model.basis.to_path))}</p>` : ''}<p>${h(t('scope'))}</p><details><summary>${h(t('technical'))}</summary><dl>${sourceFields.map(key => `<dt>${h(key)}</dt><dd>${h(source[key])}</dd>`).join('')}</dl></details></section>`;
  const projects = (model.projects ?? []).length ? `<nav class="surface" aria-label="${h(t('project_switch'))}"><h2>${h(t('project_switch'))}</h2><p>${h(t('separate_projects'))}</p><div class="inline-actions">${model.projects.map(item => `<a href="${h(item.href)}"${item.id === model.project.id ? ' aria-current="page"' : ''}>${h(item.name)}</a>`).join('')}</div></nav>` : '';
  const results = model.results ? `<section class="surface"><h2>${h(t('results'))}</h2><p>${h(t('results_help'))}</p><ul class="repair-results">${model.results.map(item => `<li><strong>${h(item.relative_path)}</strong>${item.update_id ? `<a class="text-link" href="${h(`${base}/document-updates/${encodeURIComponent(item.update_id)}`)}">${h(t('review'))}</a>` : `<p>${h(t(item.status === 'no_change' ? 'no_change' : 'blocked'))}${item.notice ? ` · ${h(item.notice)}` : ''}</p>`}${item.skipped?.length ? `<details><summary>${h(t('skipped'))} (${h(item.skipped.length)})</summary><ul>${item.skipped.map(value => `<li>${skippedItem(value)}</li>`).join('')}</ul></details>` : ''}</li>`).join('')}</ul><a class="action-button action-button-secondary" href="${h(`${base}/document-update-batches/new`)}">${h(t('batch'))}</a><p class="muted">${h(t('separate_projects'))}</p></section>` : '';
  const selection = model.basis ? `<section class="surface"><h2>${h(t('select'))}</h2><p>${h(t('selection_help'))}</p><form method="post" action="${h(`${base}/document-updates/repair`)}">${hidden('csrf', options.csrfToken)}${hidden('request_key', `UI-REPAIR-${crypto.randomUUID()}`)}${sourceFields.map(key => hidden(key, source[key])).join('')}${(model.resources ?? []).map(resource => `<label class="repair-resource-choice"><input type="checkbox" name="resource_id" value="${h(resource.resource_id)}"${(model.selected ?? []).includes(resource.resource_id) ? ' checked' : ''}><span>${h(resource.relative_path)}</span></label>`).join('')}${!(model.resources ?? []).length ? `<p>${h(t('empty'))}</p>` : `<button class="action-button" type="submit">${h(t('preview'))}</button>`}</form></section>` : '';
  return shell(model, options, `${projects}${results}<div class="repair-selection-layout">${selection}<aside>${sourceInfo}</aside></div>`);
}

export function renderDocumentReferenceRepairView(model, options = {}) {
  const h = value => escapeHtml(value ?? '');
  const t = key => translateUi(options.locale, `repair.${key}`, options.languageCatalog);
  const w = key => h(translateUi(options.locale, `workspace.${key}`, options.languageCatalog));
  const update = model.update; const source = update.source;
  const base = `/projects/${encodeURIComponent(model.project.id)}`;
  const updatePath = `${base}/document-updates/${encodeURIComponent(update.update_id)}`;
  const currentSource = update.source_status === 'current' && !update.source_conflict;
  const edits = update.change?.edits ?? [];
  const skipped = update.change?.skipped ?? [];
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${h(value)}">`;
  const binding = () => hidden('csrf', options.csrfToken) + hidden('expected_revision', update.revision)
    + hidden('expected_current_sha256', update.current?.sha256) + hidden('request_key', `UI-REPAIR-${crypto.randomUUID()}`);
  const sourceHref = `/projects/${encodeURIComponent(source.source_project_id ?? update.project_id)}/${source.kind === 'project_move' ? 'move' : 'membership'}/${encodeURIComponent(source.operation_id)}`;
  const sourceConflict = update.source_conflict ? typeof update.source_conflict === 'string' ? update.source_conflict : update.source_conflict.reason ?? JSON.stringify(update.source_conflict) : null;
  const action = update.pending ? 'recover' : update.execution && update.status !== 'undone' ? 'undo'
    : currentSource && !update.conflict && update.decision?.kind === 'accept-suggestion' && update.status === 'preview_ready' ? 'execute' : null;
  const operation = action ? `<form method="post" action="${h(`${updatePath}/${action}`)}">${binding()}<button class="action-button${action === 'undo' ? ' action-button-secondary' : ''}" type="submit">${h(translateUi(options.locale, `document_update.${action}`, options.languageCatalog))}</button></form>` : '';
  const decision = !update.pending && !update.execution ? `<form method="post" action="${h(`${updatePath}/decide`)}">${binding()}<label>${h(t('decision'))}<select name="decision"><option value="keep-current"${update.decision?.kind === 'keep-current' ? ' selected' : ''}>${h(t('keep'))}</option><option value="accept-suggestion"${update.decision?.kind === 'accept-suggestion' ? ' selected' : ''}${!currentSource || update.conflict ? ' disabled' : ''}>${h(t('accept'))}</option></select></label><button class="action-button" type="submit">${h(t('confirm_decision'))}</button></form>` : '';
  const returnTo = `${base}/resources?resource_id=${encodeURIComponent(update.resource_id)}`;
  const readHref = `${base}/resources/read?${new URLSearchParams({resource_id: update.resource_id, return_to: returnTo})}`;
  const contents = `<section class="repair-status"><h2>${h(update.resource.relative_path)}</h2><p>${h(translateUi(options.locale, `document_update.${update.status}`, options.languageCatalog))}</p><p class="muted">${h(t('scope'))}</p><a class="text-link" href="${h(sourceHref)}">${h(t(source.kind))}</a>${!currentSource ? `<p class="callout warn" role="alert">${h(sourceConflict ?? t('source_stale'))}</p>` : ''}${update.conflict ? `<p class="callout warn" role="alert">${h(update.conflict.reason)}</p>` : ''}</section><div class="document-review-grid"><section class="surface repair-change" data-repair-edits><h2>${w('repair_change')} (${h(edits.length)})</h2><ol class="repair-edit-list">${edits.map(edit => `<li><div><span>${w('review_before')}</span><code>${h(edit.old_text)}</code></div><div><span>${w('review_after')}</span><code>${h(edit.new_text)}</code></div></li>`).join('')}</ol>${skipped.length ? `<details class="document-request"><summary>${h(t('skipped'))} (${h(skipped.length)})</summary><ul>${skipped.map(item => `<li>${skippedItem(item)}</li>`).join('')}</ul></details>` : ''}</section><section class="surface document-review-action"><h2>${h(t('decision'))}</h2><p>${w('repair_decide_help')}</p>${operation}${decision}<div class="inline-actions"><a class="${update.status === 'applied' ? 'action-button' : 'text-link'}" href="${h(readHref)}">${h(t('read'))}</a><a class="text-link" href="${h(`${base}/document-update-batches/new`)}">${h(t('batch'))}</a></div><p class="muted">${h(t('recovery_limits'))}</p></section></div><details class="surface repair-fulltext"><summary>${h(t('fulltext'))}</summary><div class="document-version-grid">${['baseline', 'proposed', 'current', 'candidate'].filter(key => update[key]).map(key => `<section class="document-text-panel"><h3>${h(translateUi(options.locale, `document_update.${key}`, options.languageCatalog))}</h3><pre>${h(update[key].text)}</pre></section>`).join('')}</div></details><details class="surface repair-technical"><summary>${h(t('technical'))}</summary><dl><dt>Update ID</dt><dd>${h(update.update_id)}</dd><dt>Resource ID</dt><dd>${h(update.resource_id)}</dd><dt>Revision</dt><dd>${h(update.revision)}</dd><dt>SHA-256</dt><dd>${h(update.current?.sha256)}</dd><dt>${h(t('source'))}</dt><dd>${h(source.operation_id)} · ${h(source.revision)} · ${h(source.digest)}</dd></dl></details>`;
  return shell(model, options, contents);
}
