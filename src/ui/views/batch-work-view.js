import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function shell(content, options) {
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Atlas Import</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Import', { interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Import' })}<main class="page">${content}</main></div></div></body></html>`;
}

function emptySelectionView(model) {
  const noticeText = typeof model.notice === 'string'
    ? model.notice
    : model.notice?.title ? `${model.notice.title}. ${model.notice.action ?? ''}`.trim()
      : null;
  const notice = noticeText ? `<p class="callout warn">${escapeHtml(noticeText)}</p>` : '';
  return `<div class="page-intro"><div><span class="eyebrow">IMPORT</span><h1>Import</h1><p class="lede">Choose local items to start one Selection Set.</p></div></div>${notice}<section class="surface import-selection-set"><div class="studio-section-heading"><div><h2>Selection Set</h2><p>0 selected · 0 ready</p></div><div class="inline-actions"><button class="action-button action-button-secondary" type="button" data-import-files data-requires-desktop-picker disabled>Add files</button><button class="action-button action-button-secondary" type="button" data-import-add-folder data-requires-desktop-picker disabled>Add folder</button></div></div><p class="muted" data-file-picker-notice aria-live="polite"></p><p class="muted">Add files or a folder from this Desktop to begin.</p></section>`;
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

function selectionSetView(model, csrfToken) {
  const actionable = model.items.filter((item) => item.actionable !== false && item.supported !== false);
  const running = model.import_status === 'running';
  const runningDisabled = running ? ' disabled aria-disabled="true"' : '';
  const projectOptions = model.projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.id === model.destination?.project_id ? ' selected' : ''}${project.available ? '' : ' disabled'}>${escapeHtml(project.name)}${project.available ? '' : ' — unavailable'}</option>`).join('');
  const folderGroups = model.projects.map((project) => `<div data-project-folders data-project-id="${escapeHtml(project.id)}"${project.id === model.destination?.project_id ? '' : ' hidden'}>${project.available && project.folders.length ? `<div class="project-folder-options" data-project-folder-tree>${folderTree(project.folders).map((folder) => renderFolderBranch(folder, project.id === model.destination?.project_id ? model.destination?.folder : null)).join('')}</div>${project.folders_truncated ? '<p class="callout warn">This Project has more folders than Atlas can show here.</p>' : ''}` : project.available ? '<p class="callout warn">This Project has no existing subfolders. Create one before importing.</p>' : '<p class="callout warn">This Project folder is unavailable.</p>'}</div>`).join('');
  const items = model.items.map((item) => `<li class="import-selection-item${item.supported === false ? ' is-unsupported' : ''}"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.type)}</small>${item.reason ? `<p class="callout warn">${escapeHtml(item.reason)}</p>` : ''}</div><form method="post" action="/files/queue/remove"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="queue_id" value="${escapeHtml(model.queue_id)}"><input type="hidden" name="item_id" value="${escapeHtml(item.item_id)}"><button class="action-button action-button-remove" type="submit"${runningDisabled}>Remove</button></form></li>`).join('');
  const importResult = model.import_result?.length ? `<section class="surface import-result-summary"><h2>This import result</h2><ul class="path-list">${model.import_result.map((item) => `<li><strong>${escapeHtml(item.name)}</strong><small class="mono">${escapeHtml(item.target)}</small><a class="text-link" href="${escapeHtml(item.href)}">Locate</a></li>`).join('')}</ul></section>` : '';
  const progress = running ? `<p class="callout" data-import-status-href="${escapeHtml(model.import_status_href)}">Importing available files. <a class="text-link" href="${escapeHtml(model.activity_href)}">View Activity</a></p>` : '';
  return `<div class="page-intro"><div><span class="eyebrow">IMPORT</span><h1>Import files</h1><p class="lede">Choose local items, then place supported files in a real Project folder.</p></div></div>${progress}<section class="surface import-selection-set"><div class="studio-section-heading"><div><h2>Selection Set</h2><p>${escapeHtml(model.items.length)} selected · ${escapeHtml(actionable.length)} ready</p></div><div class="inline-actions"><button class="action-button action-button-secondary" type="button" data-import-add-files data-import-queue="${escapeHtml(model.queue_id)}" data-import-running="${escapeHtml(running)}" data-requires-desktop-picker disabled>Add files</button><button class="action-button action-button-secondary" type="button" data-import-add-folder data-import-queue="${escapeHtml(model.queue_id)}" data-import-running="${escapeHtml(running)}" data-requires-desktop-picker disabled>Add folder</button></div></div><p class="muted" data-file-picker-notice aria-live="polite"></p><ul class="import-selection-list">${items}</ul><form method="post" action="/files/queue/clear" class="inline-actions"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="queue_id" value="${escapeHtml(model.queue_id)}"><button class="action-button action-button-secondary" type="submit"${runningDisabled}>Cancel Import</button></form></section>${importResult}<section class="surface project-import-surface"><h2>Destination</h2>${model.projects.length ? `<form method="post" action="/files/queue/inspect" class="project-import-form" data-project-folder-form data-import-running="${escapeHtml(running)}" data-import-actionable-count="${escapeHtml(actionable.length)}" data-file-name="${escapeHtml(actionable.length === 1 ? actionable[0].name : `${actionable.length} files`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="queue_id" value="${escapeHtml(model.queue_id)}"><label class="setting-field">Project<select name="project_id" data-project-picker>${projectOptions}</select></label><fieldset class="project-folder-picker"><legend>Import to</legend>${folderGroups}</fieldset><p class="project-import-path"><span class="label">SELECTED LOCATION</span><span data-project-path>${model.destination?.folder ? escapeHtml(`${model.destination.project_name ?? 'Project'} / ${model.destination.folder}`) : 'Choose an existing folder.'}</span></p><button class="action-button" type="submit"${actionable.length && !running ? '' : ' disabled'}>Review Import</button></form>` : '<p class="callout warn">Add or relink an available Project before importing.</p>'}</section>`;
}

function batchResultView(model, csrfToken) {
  const external = model.items.filter((item) => item.status === 'inspected' && !item.project);
  return `<div class="page-intro"><div><span class="eyebrow">LOCAL FILES</span><h1>Files ready</h1><p class="lede">Atlas read ${escapeHtml(model.inspected_count)} of ${escapeHtml(model.items.length)} files without changing the originals.</p></div></div><section class="surface"><div class="task-table"><div class="task-row task-row-head"><span>File</span><span>Status</span><span>What happened</span><span>Action</span></div>${model.items.map((item) => `<div class="task-row"><span>${item.work_id ? `<a class="text-link" href="/files/continue?work_id=${encodeURIComponent(item.work_id)}"><strong>${escapeHtml(item.name)}</strong></a>` : `<strong>${escapeHtml(item.name)}</strong>`}</span><span>${escapeHtml(item.status === 'inspected' ? 'Ready' : item.status === 'unsupported' ? 'Not supported' : item.title ?? 'Could not read')}</span><span>${escapeHtml(item.fact ?? item.action ?? 'No local result')}${item.error ? `<details class="technical-details"><summary>Technical details</summary><small>${escapeHtml(item.error)}</small></details>` : ''}</span><span>${item.work_id ? `<a class="action-button action-button-secondary" href="/files/continue?work_id=${encodeURIComponent(item.work_id)}">View</a>` : '<a class="action-button action-button-secondary" href="/files">Choose again</a>'}</span></div>`).join('')}</div></section>${external.length ? `<section class="surface"><h2>Add files to Project</h2><p>Choose external files and save them into an existing Project folder.</p><form method="get" action="/files/batch-add-to-project"><input type="hidden" name="batch_id" value="${escapeHtml(model.batch_id)}">${external.map((item) => `<label><input type="checkbox" name="work_id" value="${escapeHtml(item.work_id)}" checked> ${escapeHtml(item.name)}</label>`).join('')}<div class="inline-actions"><button class="action-button" type="submit">Add files to Project</button><a class="action-button action-button-secondary" href="/files">Back to Files</a></div></form></section>` : '<p><a class="action-button action-button-secondary" href="/files">Back to Files</a></p>'}`;
}

function batchAddView(model, csrfToken) {
  const choices = model.projects.length ? `<form method="post" action="/files/batch-add-to-project/review"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="batch_id" value="${escapeHtml(model.batch_id)}">${model.work_ids.map((id) => `<input type="hidden" name="work_id" value="${escapeHtml(id)}">`).join('')}<label>Project <select name="project_id">${model.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('')}</select></label><label>Destination folder <input name="folder" value="" placeholder="Existing folder, for example Data/TikTok" required><small>Choose an existing folder inside the Project. The Project root is not a default destination.</small></label><div class="inline-actions"><button class="action-button">Review destinations</button><a class="action-button action-button-secondary" href="/files/batch-result/${encodeURIComponent(model.batch_id)}">Back</a></div></form>` : `<p>No Project yet. Create one or register an existing folder, then Atlas will return to this batch.</p><div class="inline-actions"><a class="action-button" href="/projects/new?return_batch_id=${encodeURIComponent(model.batch_id)}">Create Project</a><a class="action-button action-button-secondary" href="/projects/add-existing?return_batch_id=${encodeURIComponent(model.batch_id)}">Add Existing Folder</a></div>`;
  return `<div class="page-intro"><div><span class="eyebrow">PROJECT</span><h1>Add files to Project</h1><p class="lede">Choose one Project and destination folder for the selected files.</p></div></div><section class="surface">${choices}</section>`;
}

function batchReviewView(model, csrfToken) {
  const backHref = model.queue_id ? `/files/queue/${encodeURIComponent(model.queue_id)}` : `/files/batch-result/${encodeURIComponent(model.batch_id)}`;
  return `<div class="page-intro"><div><span class="eyebrow">PROJECT</span><h1>Review destinations</h1><p class="lede">Existing files will not be overwritten. Other files can still be saved.</p></div></div><section class="surface"><div class="task-table"><div class="task-row task-row-head"><span>File</span><span>Destination</span><span>Status</span></div>${model.items.map((item) => `<div class="task-row"><span>${escapeHtml(item.name)}</span><span class="mono">${escapeHtml(item.target_path ?? '—')}</span><span>${escapeHtml(item.status)}</span></div>`).join('')}</div><div class="inline-actions">${model.prepared_count ? `<form method="post" action="/files/batch-add-to-project/save"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="batch_import_id" value="${escapeHtml(model.batch_import_id)}"><button class="action-button">Import available files</button></form>` : ''}<a class="action-button action-button-secondary" href="${escapeHtml(backHref)}">Back to Selection Set</a></div></section>`;
}

export function renderBatchWorkView(model, options = {}) {
  if (model.mode === 'empty-selection') return shell(emptySelectionView(model), options);
  if (model.mode === 'selection-set') return shell(selectionSetView(model, options.csrfToken), options);
  if (model.mode === 'batch-result') return shell(batchResultView(model, options.csrfToken), options);
  if (model.mode === 'batch-add') return shell(batchAddView(model, options.csrfToken), options);
  if (model.mode === 'batch-review') return shell(batchReviewView(model, options.csrfToken), options);
  return shell('<section class="surface"><p>That temporary file selection is no longer available.</p><a class="action-button" href="/files">Back to Files</a></section>', options);
}
