import { escapeHtml, renderFacts, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

function returnInputs(model) {
  return `${model.return_work_id ? `<input type="hidden" name="return_work_id" value="${escapeHtml(model.return_work_id)}">` : ''}${model.return_batch_id ? `<input type="hidden" name="return_batch_id" value="${escapeHtml(model.return_batch_id)}">` : ''}${model.return_data_work_id ? `<input type="hidden" name="return_data_work_id" value="${escapeHtml(model.return_data_work_id)}">` : ''}`;
}

function projectLetter(name) {
  return Array.from(String(name ?? '').trim())[0]?.toUpperCase() ?? '?';
}

function renderRecentProjectFacts(project, t) {
  const resourceName = project.recent_resource?.name;
  return `${resourceName ? `<div class="projects-home-recent"><span>${escapeHtml(t('recent_resource'))}</span><strong>${escapeHtml(resourceName)}</strong></div>` : ''}${project.recent_activity_text ? `<div class="projects-home-recent"><span>${escapeHtml(t('recent_activity'))}</span><strong>${escapeHtml(project.recent_activity_text)}</strong></div>` : ''}`;
}

function renderProjectRow(project, t) {
  const name = String(project.name ?? 'Untitled Project');
  const searchText = `${name} ${project.recent_resource?.name ?? ''} ${project.recent_activity_text ?? ''}`.trim();
  const issue = project.folder_issue ? `<small class="projects-home-issue">${escapeHtml(project.folder_issue)}</small>` : '';
  const unavailableDetails = !project.folder_available
    ? `<small class="projects-home-folder">${escapeHtml(project.folder_display ?? project.folder ?? '')}</small>${issue}<span class="inline-actions">${project.relink_href ? `<a class="text-link projects-home-relink" href="${escapeHtml(project.relink_href)}">${escapeHtml(t('relink'))}</a>` : ''}${project.remove_href ? `<a class="text-link" href="${escapeHtml(project.remove_href)}">${escapeHtml(t('remove'))}</a>` : ''}</span>`
    : '';
  const rowContent = `<span class="projects-home-badge" aria-hidden="true">${escapeHtml(projectLetter(name))}</span><span class="projects-home-row-copy"><strong>${escapeHtml(name)}</strong>${project.folder_available ? renderRecentProjectFacts(project, t) : unavailableDetails}</span><span class="projects-home-state ${project.folder_available ? 'is-available' : 'is-unavailable'}">${escapeHtml(t(project.folder_available ? 'available' : 'unavailable'))}</span>`;
  return project.folder_available
    ? `<a class="projects-home-row" data-project-search="${escapeHtml(searchText)}" href="/projects/${encodeURIComponent(String(project.id ?? ''))}">${rowContent}</a>`
    : `<article class="projects-home-row is-unavailable" data-project-search="${escapeHtml(searchText)}">${rowContent}</article>`;
}

function renderProjectsContent(model, projects, t) {
  if (model.loading) return `<section class="surface projects-home-state-panel" aria-busy="true"><strong>${escapeHtml(t('loading'))}</strong><p>${escapeHtml(t('loading_detail'))}</p></section>`;
  if (model.error) return `<section class="surface projects-home-state-panel" role="alert"><strong>${escapeHtml(t('error'))}</strong><p>${escapeHtml(model.error)}</p></section>`;
  if (!projects.length) return `<section class="surface projects-home-state-panel"><strong>${escapeHtml(t('empty'))}</strong><p>${escapeHtml(t('empty_detail'))}</p></section>`;
  const selected = projects.find((project) => project.id === model.selected_project_id) ?? projects.find((project) => project.folder_available) ?? projects[0];
  const selectedName = String(selected.name ?? 'Untitled Project');
  const selectedUnavailable = !selected.folder_available;
  return `<div class="projects-home-layout"><section class="projects-home-list-panel" aria-labelledby="projects-list-title"><div class="projects-home-list-heading"><div><h2 id="projects-list-title">${escapeHtml(t('list'))}</h2><p>${escapeHtml(t('choose'))}</p></div><label class="projects-home-filter-label">${escapeHtml(t('filter'))}<input type="search" data-project-filter placeholder="${escapeHtml(t('filter'))}" autocomplete="off"></label></div><div class="projects-home-list">${projects.map((project) => renderProjectRow(project, t)).join('')}</div></section><aside class="surface projects-home-summary" aria-labelledby="projects-summary-title"><span class="eyebrow">${escapeHtml(t('current'))}</span><h2 id="projects-summary-title">${escapeHtml(selectedName)}</h2><span class="projects-home-state ${selectedUnavailable ? 'is-unavailable' : 'is-available'}">${escapeHtml(t(selectedUnavailable ? 'unavailable' : 'available'))}</span>${selectedUnavailable ? `<p class="projects-home-summary-issue">${escapeHtml(selected.folder_issue ?? '')}</p><p class="projects-home-folder">${escapeHtml(selected.folder_display ?? selected.folder ?? '')}</p><div class="inline-actions">${selected.relink_href ? `<a class="text-link" href="${escapeHtml(selected.relink_href)}">${escapeHtml(t('relink_folder'))}</a>` : ''}${selected.remove_href ? `<a class="text-link" href="${escapeHtml(selected.remove_href)}">${escapeHtml(t('remove'))}</a>` : ''}</div>` : renderRecentProjectFacts(selected, t)}</aside></div>`;
}

export function renderProjectsHomeView(model, options = {}) {
  const t = (key) => translateUi(options.locale, `projects.${key}`, options.languageCatalog);
  const projects = model.projects ?? [];
  const actions = `<div class="inline-actions"><a class="action-button" href="/projects/new">${escapeHtml(t('new'))}</a><a class="action-button action-button-secondary" href="/projects/add-existing">${escapeHtml(t('add_existing'))}</a></div>`;
  const content = renderProjectsContent(model, projects, t);
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Atlas ${escapeHtml(t('title'))}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('title'), locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page projects-home"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('local'))}</span><h1>${escapeHtml(t('title'))}</h1><p class="lede">${escapeHtml(t('lede'))}</p></div>${!model.loading && !model.error ? actions : ''}</div>${model.notice ? `<section class="surface"><p class="callout warn">${escapeHtml(model.notice)}</p></section>` : ''}${content}</main></div></div></body></html>`;
}

export function renderProjectOnboardingView(model, options = {}) {
  const t = (key, values = {}) => {
    let value = translateUi(options.locale, `projects.${key}`, options.languageCatalog);
    for (const [name, replacement] of Object.entries(values)) value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  };
  const h = (key, values) => escapeHtml(t(key, values));
  const picker = options.desktop_picker_enabled ? ' data-requires-desktop-picker disabled' : ' disabled';
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken ?? '')}">`;
  const folderField = `<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id ?? '')}"><button type="button" class="action-button action-button-secondary" data-pick-folder${picker}>${h('choose_folder')}</button><span class="muted" data-folder-selection-name data-selected-label="${h('folder_selected')}">${escapeHtml(model.folder_name ?? '')}</span><p class="muted" data-folder-picker-notice data-picker-not-ready="${h('folder_picker_not_ready')}" data-register-failed="${h('folder_register_failed')}" aria-live="polite"></p>`;
  let body = '';
  if (model.mode === 'remove') {
    body = `<div class="page-intro"><div><span class="eyebrow">${h('record')}</span><h1>${h('remove_heading', { name: model.project_name ?? t('title') })}</h1><p class="lede">${h('remove_lede')}</p></div></div><section class="surface"><p class="callout warn">${h('preserve_history')}</p><form method="post" action="/projects/${encodeURIComponent(String(model.project_id ?? ''))}/remove/confirm" class="inline-actions">${csrf}<button class="action-button action-button-danger" type="submit">${h('remove')}</button><a class="action-button action-button-secondary" href="/projects">${h('cancel')}</a></form></section>`;
  } else if (model.mode === 'relink') {
    body = `<div class="page-intro"><div><span class="eyebrow">${h('recovery')}</span><h1>${h('relink_heading', { name: model.project_name ?? t('title') })}</h1><p class="lede">${h('relink_lede')}</p></div></div><section class="surface"><p class="callout warn">${h('recorded_folder')}: ${escapeHtml(model.previous_folder ?? t('unavailable'))}</p><form method="post" action="/projects/${encodeURIComponent(String(model.project_id ?? ''))}/relink/preview">${csrf}${folderField}<div class="inline-actions"><button class="action-button" type="submit">${h('review_folder')}</button><a class="action-button action-button-secondary" href="/projects">${h('cancel')}</a></div></form></section>`;
  } else if (model.mode === 'relink-preview') {
    body = `<div class="page-intro"><div><span class="eyebrow">${h('recovery')}</span><h1>${h('confirm_folder')}</h1><p class="lede">${h('confirm_folder_lede')}</p></div></div><section class="surface">${renderFacts([[t('title'), model.project_name], [t('recorded_folder'), model.previous_folder, true], [t('selected_folder'), model.folder, true]])}<form method="post" action="/projects/${encodeURIComponent(String(model.project_id ?? ''))}/relink/confirm" class="inline-actions">${csrf}<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id)}"><button class="action-button" type="submit">${h('relink_project')}</button><a class="action-button action-button-secondary" href="/projects">${h('cancel')}</a></form></section>`;
  } else if (model.mode === 'add-existing') {
    body = `<div class="page-intro"><div><span class="eyebrow">${h('title')}</span><h1>${h('add_existing')}</h1><p class="lede">${h('add_existing_lede')}</p></div></div><section class="surface"><form method="post" action="/projects/add-existing/preview">${csrf}${returnInputs(model)}${folderField}<div class="inline-actions"><button class="action-button" type="submit">${h('continue')}</button><a class="action-button action-button-secondary" href="/projects">${h('back')}</a></div></form></section>`;
  } else if (model.mode === 'new') {
    body = `<div class="page-intro"><div><span class="eyebrow">${h('title')}</span><h1>${h('new')}</h1><p class="lede">${h('new_lede')}</p></div></div><section class="surface"><form method="post" action="/projects/new/preview">${csrf}${returnInputs(model)}<label>${h('project_name')} <input name="name" value="${escapeHtml(model.name ?? '')}" required maxlength="120"></label><label>${h('location')}</label>${folderField}<div class="inline-actions"><button class="action-button" type="submit">${h('continue')}</button><a class="action-button action-button-secondary" href="/projects">${h('back')}</a></div></form></section>`;
  } else if (model.mode === 'existing-preview') {
    body = `<div class="page-intro"><div><span class="eyebrow">${h('title')}</span><h1>${h('add_project')}</h1><p class="lede">${h('add_lede')}</p></div></div><section class="surface">${renderFacts([[t('folder'), model.folder, true], [t('project_name'), model.name]])}<form method="post" action="/projects/add-existing/create" class="inline-actions">${csrf}${returnInputs(model)}<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id)}"><input type="hidden" name="name" value="${escapeHtml(model.name)}"><button class="action-button" type="submit">${h('add_project')}</button><a class="action-button action-button-secondary" href="/projects/add-existing">${h('back')}</a></form></section>`;
  } else if (model.mode === 'new-preview') {
    const facts = renderFacts([[t('parent_folder'), model.folder, true], [t('project_name'), model.name], [t('new_folder'), model.target, true]]);
    const existing = model.target_exists ? `<p class="callout warn">${h('exists')}</p><form method="post" action="/projects/new/use-existing" class="inline-actions">${csrf}${returnInputs(model)}<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id)}"><input type="hidden" name="name" value="${escapeHtml(model.name)}"><button class="action-button" type="submit">${h('use_existing')}</button><a class="action-button action-button-secondary" href="/projects/new">${h('back')}</a></form>` : `<form method="post" action="/projects/new/create" class="inline-actions">${csrf}${returnInputs(model)}<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id)}"><input type="hidden" name="name" value="${escapeHtml(model.name)}"><button class="action-button" type="submit">${h('create_project')}</button><a class="action-button action-button-secondary" href="/projects/new">${h('back')}</a></form>`;
    body = `<div class="page-intro"><div><span class="eyebrow">${h('title')}</span><h1>${h('create_project')}</h1><p class="lede">${h('create_lede')}</p></div></div><section class="surface">${facts}${existing}</section>`;
  }
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Atlas ${h('title')}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace"><main class="page">${body}</main></div></div></body></html>`;
}
