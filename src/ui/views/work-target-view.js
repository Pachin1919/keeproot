import { UI_DISPLAY_NAME } from '../brand.js';
import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

function sourceCount(work) {
  return Array.isArray(work.sources) ? work.sources.length : work.sources ?? 0;
}

function selectedResources(selection, t) {
  const resources = selection.resources ?? [];
  return resources.length
    ? `<ul class="work-target-selection-list">${resources.map((resource) => `<li><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resource.relative_path)}</small></li>`).join('')}</ul>`
    : `<p class="callout warn">${escapeHtml(t('none_selected'))}</p>`;
}

function updateWorkForm(model, work, t) {
  return `<form method="post" action="${escapeHtml(model.commit_action)}"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><input type="hidden" name="target" value="existing"><input type="hidden" name="work_id" value="${escapeHtml(work.session_id)}"><input type="hidden" name="base_revision" value="${escapeHtml(work.revision)}"><p class="muted">${escapeHtml(t('update_detail'))}</p><button class="action-button" type="submit">${escapeHtml(t('update'))}</button></form>`;
}

function reuseWorkForm(model, work, selection, t) {
  const sources = Array.isArray(work.sources) ? work.sources : [];
  const selected = selection.resources ?? [];
  if (selected.length !== sources.length) return `<p class="muted">${escapeHtml(t('reuse_unavailable', { slots: sources.length, files: selected.length }))}</p>`;
  const options = selected.map((resource) => `<option value="${escapeHtml(resource.resource_id)}">${escapeHtml(resource.name)} · ${escapeHtml(resource.relative_path)}</option>`).join('');
  const slots = sources.map((source) => {
    const sourceLabel = source.name ?? source.file_name ?? source.path ?? source.source_key;
    return `<label><span>${escapeHtml(t('old_source', { name: sourceLabel, key: source.source_key }))}</span><select name="source_for_${escapeHtml(source.source_key)}" required><option value="">${escapeHtml(t('choose_resource'))}</option>${options}</select></label>`;
  }).join('');
  return `<form method="post" action="${escapeHtml(model.commit_action)}"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><input type="hidden" name="target" value="reuse"><input type="hidden" name="work_id" value="${escapeHtml(work.session_id)}"><input type="hidden" name="base_revision" value="${escapeHtml(work.revision)}"><p class="muted">${escapeHtml(t('reuse_detail'))}</p><div class="source-grid">${slots}</div><button class="action-button action-button-secondary" type="submit">${escapeHtml(t('reuse'))}</button></form>`;
}

function existingWorkCard(model, work, selection, t) {
  const label = typeof work.intent === 'string' && work.intent.trim() ? work.intent : work.session_id;
  const identity = label === work.session_id ? '' : `<p class="muted">${escapeHtml(t('work_id'))}: ${escapeHtml(work.session_id)}</p>`;
  if (model.module_paused) return `<article class="surface work-target-existing"><div><span class="eyebrow">${escapeHtml(t('existing'))}</span><h2>${escapeHtml(label)}</h2>${identity}<p class="muted">${escapeHtml(t('revision'))} ${escapeHtml(work.revision)} · ${escapeHtml(t('sources'))} ${escapeHtml(sourceCount(work))}</p></div><a class="action-button action-button-secondary" href="/work/${encodeURIComponent(work.session_id)}">${escapeHtml(t('open_existing'))}</a></article>`;
  return `<article class="surface work-target-existing"><div><span class="eyebrow">${escapeHtml(t('existing'))}</span><h2>${escapeHtml(label)}</h2>${identity}<dl><dt>${escapeHtml(t('revision'))}</dt><dd>${escapeHtml(work.revision)}</dd><dt>${escapeHtml(t('sources'))}</dt><dd>${escapeHtml(sourceCount(work))}</dd><dt>${escapeHtml(t('updated'))}</dt><dd>${escapeHtml(work.updated_at ?? t('unavailable'))}</dd>${work.return_state ? `<dt>${escapeHtml(t('return_state'))}</dt><dd>${escapeHtml(work.return_state)}</dd>` : ''}</dl></div><div class="inline-actions">${updateWorkForm(model, work, t)}</div><details><summary>${escapeHtml(t('reuse_summary', { count: (selection.resources ?? []).length }))}</summary>${reuseWorkForm(model, work, selection, t)}</details></article>`;
}

export function renderWorkTargetView(model, options = {}) {
  const t = (key, values = {}) => {
    let message = translateUi(options.locale, `worktarget.${key}`, options.languageCatalog);
    for (const [name, value] of Object.entries(values)) message = message.replaceAll(`{${name}}`, String(value));
    return message;
  };
  const selection = model.selection ?? { resources: [], count: 0 };
  const works = model.works ?? [];
  const startNew = model.module_paused ? '' : `<form method="post" action="${escapeHtml(model.commit_action)}" class="work-target-start"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><input type="hidden" name="target" value="new"><button class="action-button" type="submit">${escapeHtml(t('start'))}</button></form>`;
  const cancel = `<form method="post" action="${escapeHtml(model.cancel_action)}"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><button class="action-button action-button-secondary" type="submit">${escapeHtml(t('cancel'))}</button></form>`;
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(t('title'))} · ${UI_DISPLAY_NAME}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Resources', { ...options, project: model.project, interactive: true, workspaceHref: '/projects', resourcesHref: model.back_href, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('title'), project: model.project, locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page work-target-page"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('section'))}</span><h1>${escapeHtml(t('heading'))}</h1><p class="lede">${escapeHtml(t('lede'))}</p></div><a class="action-button action-button-secondary" href="${escapeHtml(model.back_href)}">${escapeHtml(t('back'))}</a></div>${model.notice ? `<p class="callout warn">${escapeHtml(model.notice)}</p>` : ''}${model.module_paused ? `<p class="callout warn module-paused">${escapeHtml(translateUi(options.locale, 'modules.table_paused_help', options.languageCatalog))} <a href="/modules">${escapeHtml(translateUi(options.locale, 'modules.open', options.languageCatalog))}</a></p>` : ''}<section class="surface work-target-selection"><div><span class="eyebrow">${escapeHtml(t('selected'))}</span><h2>${escapeHtml(t('files', { count: selection.count }))}</h2>${selection.origin_label ? `<p class="muted">${escapeHtml(t('from', { name: selection.origin_label }))}</p>` : ''}</div>${selectedResources(selection, t)}</section>${model.module_paused ? '' : `<section class="surface work-target-new"><div><span class="eyebrow">${escapeHtml(t('new'))}</span><h2>${escapeHtml(t('start_heading'))}</h2><p>${escapeHtml(t('start_detail'))}</p></div>${startNew}</section>`}<section class="work-target-existing-list" aria-labelledby="work-target-existing-title"><div class="section-heading"><div><span class="eyebrow">${escapeHtml(t('existing'))}</span><h2 id="work-target-existing-title">${escapeHtml(t('existing_heading'))}</h2><p class="muted">${escapeHtml(t('existing_detail'))}</p></div></div>${works.length ? works.map((work) => existingWorkCard(model, work, selection, t)).join('') : `<p class="surface muted">${escapeHtml(t('no_compatible'))}</p>`}</section><div class="inline-actions">${cancel}<a class="text-link" href="${escapeHtml(model.back_href)}">${escapeHtml(t('return'))}</a></div></main></div></div></body></html>`;
}
