import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

function copy(options) {
  return (key, values = {}) => {
    let value = translateUi(options.locale, `import.${key}`, options.languageCatalog);
    for (const [name, replacement] of Object.entries(values)) value = value.replaceAll(`{${name}}`, String(replacement));
    return escapeHtml(value);
  };
}

function shell(content, options) {
  const title = translateUi(options.locale, 'import.title', options.languageCatalog);
  const pickerMessages = Object.fromEntries(['picker_unavailable', 'picker_retry', 'picker_add_retry', 'register_failed', 'add_failed']
    .map((key) => [key, translateUi(options.locale, `import.${key}`, options.languageCatalog)]));
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Atlas ${escapeHtml(title)}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body data-import-messages="${escapeHtml(JSON.stringify(pickerMessages))}"><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Import', { interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: title, locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page">${content}</main></div></div></body></html>`;
}

function emptySelectionView(model, options = {}) {
  const t = (key) => escapeHtml(translateUi(options.locale, `import.${key}`, options.languageCatalog));
  const noticeText = typeof model.notice === 'string'
    ? model.notice
    : model.notice?.title ? `${model.notice.title}. ${model.notice.action ?? ''}`.trim()
      : null;
  const notice = noticeText ? `<p class="callout warn">${escapeHtml(noticeText)}</p>` : '';
  return `<div class="page-intro"><div><span class="eyebrow">${t('eyebrow')}</span><h1>${t('title')}</h1><p class="lede">${t('lede')}</p></div></div>${notice}<section class="surface import-selection-set"><div class="studio-section-heading"><div><h2>${t('selection_set')}</h2><p>${t('empty_count')}</p></div><div class="inline-actions"><button class="action-button action-button-secondary" type="button" data-import-files data-requires-desktop-picker disabled>${t('add_files')}</button><button class="action-button action-button-secondary" type="button" data-import-add-folder data-requires-desktop-picker disabled>${t('add_folder')}</button></div></div><p class="muted" data-file-picker-notice aria-live="polite"></p><p class="muted">${t('empty_help')}</p></section>`;
}

function folderTree(folders) {
  const nodes = new Map(folders.map((folder) => [folder.relative_path, { ...folder, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const slash = node.relative_path.lastIndexOf('/');
    const parent = slash === -1 ? null : nodes.get(node.relative_path.slice(0, slash));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items) => {
    items.sort((left, right) => left.name.localeCompare(right.name));
    items.forEach((item) => sort(item.children));
    return items;
  };
  return sort(roots);
}

function folderChoice(folder, destinationFolder) {
  return `<label class="project-folder-choice"><input type="radio" name="folder" value="${escapeHtml(folder.relative_path)}" data-folder-path="${escapeHtml(folder.relative_path)}"${folder.relative_path === destinationFolder ? ' checked' : ''}><span><strong>${escapeHtml(folder.name)}</strong><small>${escapeHtml(folder.relative_path)}</small></span></label>`;
}

function renderFolderBranch(folder, destinationFolder) {
  const containsDestination = Boolean(destinationFolder)
    && (folder.relative_path === destinationFolder || destinationFolder.startsWith(`${folder.relative_path}/`));
  const choice = folderChoice(folder, destinationFolder);
  if (!folder.children.length) return `<div class="project-folder-branch project-folder-leaf" data-project-folder-branch="${escapeHtml(folder.relative_path)}">${choice}</div>`;
  return `<details class="project-folder-branch" data-project-folder-branch="${escapeHtml(folder.relative_path)}"${containsDestination ? ' open' : ''}><summary>${escapeHtml(folder.name)}</summary><div class="project-folder-branch-content">${choice}<div class="project-folder-children">${folder.children.map((child) => renderFolderBranch(child, destinationFolder)).join('')}</div></div></details>`;
}

function selectionSetView(model, csrfToken, t) {
  const actionable = model.items.filter((item) => item.actionable !== false && item.supported !== false);
  const running = model.import_status === 'running';
  const runningDisabled = running ? ' disabled aria-disabled="true"' : '';
  const projectOptions = model.projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.id === model.destination?.project_id ? ' selected' : ''}${project.available ? '' : ' disabled'}>${escapeHtml(project.name)}${project.available ? '' : t('unavailable_suffix')}</option>`).join('');
  const folderGroups = model.projects.map((project) => `<div data-project-folders data-project-id="${escapeHtml(project.id)}"${project.id === model.destination?.project_id ? '' : ' hidden'}>${project.available && project.folders.length ? `<div class="project-folder-options" data-project-folder-tree>${folderTree(project.folders).map((folder) => renderFolderBranch(folder, project.id === model.destination?.project_id ? model.destination?.folder : null)).join('')}</div>${project.folders_truncated ? `<p class="callout warn">${t('too_many_folders')}</p>` : ''}` : project.available ? `<p class="callout warn">${t('no_subfolders')}</p>` : `<p class="callout warn">${t('folder_unavailable')}</p>`}</div>`).join('');
  const items = model.items.map((item) => `<li class="import-selection-item${item.supported === false ? ' is-unsupported' : ''}"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.type)}</small>${item.reason ? `<p class="callout warn">${escapeHtml(item.reason)}</p>` : ''}</div><form method="post" action="/files/queue/remove"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="queue_id" value="${escapeHtml(model.queue_id)}"><input type="hidden" name="item_id" value="${escapeHtml(item.item_id)}"><button class="action-button action-button-remove" type="submit"${runningDisabled}>${t('remove')}</button></form></li>`).join('');
  const importResult = model.import_result?.length ? `<section class="surface import-result-summary"><h2>${t('result')}</h2><ul class="path-list">${model.import_result.map((item) => `<li><strong>${escapeHtml(item.name)}</strong><small class="mono">${escapeHtml(item.target)}</small><a class="text-link" href="${escapeHtml(item.href)}">${t('locate')}</a></li>`).join('')}</ul></section>` : '';
  const progress = running ? `<p class="callout" data-import-status-href="${escapeHtml(model.import_status_href)}">${t('importing')} <a class="text-link" href="${escapeHtml(model.activity_href)}">${t('view_activity')}</a></p>` : '';
  return `<div class="page-intro"><div><span class="eyebrow">${t('eyebrow')}</span><h1>${t('import_files')}</h1><p class="lede">${t('import_files_lede')}</p></div></div>${progress}<section class="surface import-selection-set"><div class="studio-section-heading"><div><h2>${t('selection_set')}</h2><p>${t('selection_count', { count: model.items.length, ready: actionable.length })}</p></div><div class="inline-actions"><button class="action-button action-button-secondary" type="button" data-import-add-files data-import-queue="${escapeHtml(model.queue_id)}" data-import-running="${escapeHtml(running)}" data-requires-desktop-picker disabled>${t('add_files')}</button><button class="action-button action-button-secondary" type="button" data-import-add-folder data-import-queue="${escapeHtml(model.queue_id)}" data-import-running="${escapeHtml(running)}" data-requires-desktop-picker disabled>${t('add_folder')}</button></div></div><p class="muted" data-file-picker-notice aria-live="polite"></p><ul class="import-selection-list">${items}</ul><form method="post" action="/files/queue/clear" class="inline-actions"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="queue_id" value="${escapeHtml(model.queue_id)}"><button class="action-button action-button-secondary" type="submit"${runningDisabled}>${t('cancel')}</button></form></section>${importResult}<section class="surface project-import-surface"><h2>${t('destination')}</h2>${model.projects.length ? `<form method="post" action="/files/queue/inspect" class="project-import-form" data-project-folder-form data-import-running="${escapeHtml(running)}" data-import-actionable-count="${escapeHtml(actionable.length)}" data-file-name="${escapeHtml(actionable.length === 1 ? actionable[0].name : `${actionable.length} files`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="queue_id" value="${escapeHtml(model.queue_id)}"><label class="setting-field">${t('project')}<select name="project_id" data-project-picker>${projectOptions}</select></label><fieldset class="project-folder-picker"><legend>${t('import_to')}</legend>${folderGroups}</fieldset><p class="project-import-path"><span class="label">${t('selected_location')}</span><span data-project-path>${model.destination?.folder ? escapeHtml(`${model.destination.project_name ?? 'Project'} / ${model.destination.folder}`) : t('choose_existing')}</span></p><button class="action-button" type="submit"${actionable.length && !running ? '' : ' disabled'}>${t('review')}</button></form>` : `<p class="callout warn">${t('need_project')}</p>`}</section>`;
}

function batchResultView(model, csrfToken, t) {
  const external = model.items.filter((item) => item.status === 'inspected' && !item.project);
  return `<div class="page-intro"><div><span class="eyebrow">${t('local_files')}</span><h1>${t('files_ready')}</h1><p class="lede">${t('read_count', { read: model.inspected_count, total: model.items.length })}</p></div></div><section class="surface"><div class="task-table"><div class="task-row task-row-head"><span>${t('file')}</span><span>${t('status')}</span><span>${t('what_happened')}</span><span>${t('action')}</span></div>${model.items.map((item) => `<div class="task-row"><span>${item.work_id ? `<a class="text-link" href="/files/continue?work_id=${encodeURIComponent(item.work_id)}"><strong>${escapeHtml(item.name)}</strong></a>` : `<strong>${escapeHtml(item.name)}</strong>`}</span><span>${item.status === 'inspected' ? t('ready') : item.status === 'unsupported' ? t('unsupported') : escapeHtml(item.title ?? t('cannot_read'))}</span><span>${escapeHtml(item.fact ?? item.action ?? t('no_result'))}${item.error ? `<details class="technical-details"><summary>${t('technical')}</summary><small>${escapeHtml(item.error)}</small></details>` : ''}</span><span>${item.work_id ? `<a class="action-button action-button-secondary" href="/files/continue?work_id=${encodeURIComponent(item.work_id)}">${t('view')}</a>` : `<a class="action-button action-button-secondary" href="/files">${t('choose_again')}</a>`}</span></div>`).join('')}</div></section>${external.length ? `<section class="surface"><h2>${t('add_to_project')}</h2><p>${t('external_lede')}</p><form method="get" action="/files/batch-add-to-project"><input type="hidden" name="batch_id" value="${escapeHtml(model.batch_id)}">${external.map((item) => `<label><input type="checkbox" name="work_id" value="${escapeHtml(item.work_id)}" checked> ${escapeHtml(item.name)}</label>`).join('')}<div class="inline-actions"><button class="action-button" type="submit">${t('add_to_project')}</button><a class="action-button action-button-secondary" href="/files">${t('back_files')}</a></div></form></section>` : `<p><a class="action-button action-button-secondary" href="/files">${t('back_files')}</a></p>`}`;
}

function batchAddView(model, csrfToken, t) {
  const choices = model.projects.length ? `<form method="post" action="/files/batch-add-to-project/review"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="batch_id" value="${escapeHtml(model.batch_id)}">${model.work_ids.map((id) => `<input type="hidden" name="work_id" value="${escapeHtml(id)}">`).join('')}<label>${t('project')} <select name="project_id">${model.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('')}</select></label><label>${t('destination_folder')} <input name="folder" value="" placeholder="${t('destination_placeholder')}" required><small>${t('destination_help')}</small></label><div class="inline-actions"><button class="action-button">${t('review_destinations')}</button><a class="action-button action-button-secondary" href="/files/batch-result/${encodeURIComponent(model.batch_id)}">${t('back')}</a></div></form>` : `<p>${t('no_project')}</p><div class="inline-actions"><a class="action-button" href="/projects/new?return_batch_id=${encodeURIComponent(model.batch_id)}">${t('create_project')}</a><a class="action-button action-button-secondary" href="/projects/add-existing?return_batch_id=${encodeURIComponent(model.batch_id)}">${t('add_existing')}</a></div>`;
  return `<div class="page-intro"><div><span class="eyebrow">${t('project_eyebrow')}</span><h1>${t('add_to_project')}</h1><p class="lede">${t('add_lede')}</p></div></div><section class="surface">${choices}</section>`;
}

function batchReviewView(model, csrfToken, t) {
  const backHref = model.queue_id ? `/files/queue/${encodeURIComponent(model.queue_id)}` : `/files/batch-result/${encodeURIComponent(model.batch_id)}`;
  return `<div class="page-intro"><div><span class="eyebrow">${t('project_eyebrow')}</span><h1>${t('review_destinations')}</h1><p class="lede">${t('review_lede')}</p></div></div><section class="surface"><div class="task-table"><div class="task-row task-row-head"><span>${t('file')}</span><span>${t('destination')}</span><span>${t('status')}</span></div>${model.items.map((item) => `<div class="task-row"><span>${escapeHtml(item.name)}</span><span class="mono">${escapeHtml(item.target_path ?? '—')}</span><span>${escapeHtml(item.status)}</span></div>`).join('')}</div><div class="inline-actions">${model.prepared_count ? `<form method="post" action="/files/batch-add-to-project/save"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="batch_import_id" value="${escapeHtml(model.batch_import_id)}"><button class="action-button">${t('import_available')}</button></form>` : ''}<a class="action-button action-button-secondary" href="${escapeHtml(backHref)}">${t('back_selection')}</a></div></section>`;
}

export function renderBatchWorkView(model, options = {}) {
  const t = copy(options);
  if (model.mode === 'empty-selection') return shell(emptySelectionView(model, options), options);
  if (model.mode === 'selection-set') return shell(selectionSetView(model, options.csrfToken, t), options);
  if (model.mode === 'batch-result') return shell(batchResultView(model, options.csrfToken, t), options);
  if (model.mode === 'batch-add') return shell(batchAddView(model, options.csrfToken, t), options);
  if (model.mode === 'batch-review') return shell(batchReviewView(model, options.csrfToken, t), options);
  return shell(`<section class="surface"><p>${t('selection_missing')}</p><a class="action-button" href="/files">${t('back_files')}</a></section>`, options);
}
