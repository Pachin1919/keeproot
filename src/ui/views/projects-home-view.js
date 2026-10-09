import { UI_DISPLAY_NAME } from '../brand.js';
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
  return `<div class="projects-home-layout"><section class="projects-home-list-panel" aria-labelledby="projects-list-title"><div class="projects-home-list-heading"><div><h2 id="projects-list-title">${escapeHtml(t('list'))}</h2><p>${escapeHtml(t('choose'))}</p></div><label class="projects-home-filter-label">${escapeHtml(t('filter'))}<input type="search" data-project-filter placeholder="${escapeHtml(t('filter'))}" autocomplete="off"></label></div><div class="projects-home-list">${projects.map((project) => renderProjectRow(project, t)).join('')}</div></section></div>`;
}

function renderBootstrapConnectScans(scans, t) {
  if (!scans?.length) return '';
  return `<section class="surface projects-bootstrap-connect" aria-labelledby="bootstrap-connect-title"><h2 id="bootstrap-connect-title">${escapeHtml(t('bootstrap_connect_available'))}</h2><p>${escapeHtml(t('bootstrap_connect_available_detail'))}</p><div class="projects-home-list">${scans.map((scan) => `<article class="projects-home-row"><span class="projects-home-row-copy"><strong>${escapeHtml(scan.root_path)}</strong><small>${escapeHtml(scan.scan_id)} · ${escapeHtml(String(scan.projects.length))} ${escapeHtml(t('bootstrap_connect_project_count'))}</small>${scan.blocked_reason ? `<small class="projects-home-issue">${escapeHtml(scan.blocked_reason)}</small>` : ''}</span><span class="projects-home-state ${scan.status === 'blocked' ? 'is-unavailable' : 'is-available'}">${escapeHtml(t(`bootstrap_connect_${scan.status}`))}</span><a class="text-link" href="/projects/bootstrap/${encodeURIComponent(scan.scan_id)}/connect">${escapeHtml(t('bootstrap_connect_review'))}</a></article>`).join('')}</div></section>`;
}

export function renderProjectsHomeView(model, options = {}) {
  const t = (key) => translateUi(options.locale, key === 'open_project' ? 'workspace.open_project' : `projects.${key}`, options.languageCatalog);
  const projects = model.projects ?? [];
  const actions = `<div class="inline-actions"><a class="action-button" href="/projects/new">${escapeHtml(t('new'))}</a><a class="action-button action-button-secondary" href="/projects/add-existing">${escapeHtml(t('add_existing'))}</a><a class="action-button action-button-secondary" href="/modules">${escapeHtml(t('modules_manage'))}</a></div>`;
  const content = renderProjectsContent(model, projects, t);
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${UI_DISPLAY_NAME} ${escapeHtml(t('title'))}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="product-workspace-body"><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { ...options, project: options.project, interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('title'), locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page projects-home product-projects-home"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('local'))}</span><h1>${escapeHtml(t('title'))}</h1><p class="lede">${escapeHtml(translateUi(options.locale, 'workspace.projects_lede', options.languageCatalog))}</p></div>${!model.loading && !model.error ? actions : ''}</div>${model.notice ? `<section class="surface"><p class="callout warn">${escapeHtml(model.notice)}</p></section>` : ''}${renderBootstrapConnectScans(model.bootstrap_connect_scans, t)}${content}</main></div></div></body></html>`;
}

export function renderBootstrapConnectView(model, options = {}) {
  const t = (key) => translateUi(options.locale, `projects.${key}`, options.languageCatalog);
  const projects = (model.projects ?? []).map((project) => `<li><strong>${escapeHtml(project.name ?? project.project_id ?? t('bootstrap_connect_unknown'))}</strong> <code>${escapeHtml(project.project_id ?? '')}</code> <span>${escapeHtml(project.relative_path ?? '')}</span> <span class="projects-home-state ${project.connection_status === 'blocked' ? 'is-unavailable' : 'is-available'}">${escapeHtml(t(`bootstrap_connect_${project.connection_status}`))}</span>${project.blocked_reason ? `<p class="callout warn">${escapeHtml(project.blocked_reason)}</p>` : ''}</li>`).join('');
  const facts = `<dl><dt>${escapeHtml(t('bootstrap_connect_scan'))}</dt><dd><code>${escapeHtml(model.scan_id ?? '')}</code></dd><dt>${escapeHtml(t('bootstrap_connect_root'))}</dt><dd>${escapeHtml(model.root_path ?? '')}</dd><dt>${escapeHtml(t('bootstrap_connect_root_type'))}</dt><dd>${escapeHtml(model.root_type ?? '')}</dd><dt>${escapeHtml(t('bootstrap_connect_content_policy'))}</dt><dd>${escapeHtml(model.content_policy ?? '')}</dd></dl>`;
  const form = model.can_connect && !model.receipt
    ? `<form method="post" action="/projects/bootstrap/${encodeURIComponent(model.scan_id)}/connect"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken ?? '')}"><input type="hidden" name="preview_token" value="${escapeHtml(model.preview_token ?? '')}"><button class="action-button" type="submit">${escapeHtml(t('bootstrap_connect_confirm'))}</button></form>` : '';
  const receipt = model.receipt ? `<p class="callout">${escapeHtml(t('bootstrap_connect_success'))}</p>` : '';
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(t('bootstrap_connect_title'))}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { ...options, project: options.project, interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace"><main class="page"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('bootstrap_connect_eyebrow'))}</span><h1>${escapeHtml(t('bootstrap_connect_title'))}</h1><p class="lede">${escapeHtml(t('bootstrap_connect_lede'))}</p></div></div><section class="surface">${model.error ? `<p class="callout warn" role="alert">${escapeHtml(model.error)}</p>` : ''}${model.blocked_reason ? `<p class="callout warn">${escapeHtml(model.blocked_reason)}</p>` : ''}${facts}<h2>${escapeHtml(t('bootstrap_connect_projects'))}</h2><ul>${projects}</ul><p class="callout warn">${escapeHtml(t('bootstrap_connect_read_note'))}</p>${receipt}${form}<a class="text-link" href="/projects">${escapeHtml(t('back'))}</a></section></main></div></div></body></html>`;
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
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${UI_DISPLAY_NAME} ${h('title')}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { ...options, project: options.project, interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace"><main class="page">${body}</main></div></div></body></html>`;
}
