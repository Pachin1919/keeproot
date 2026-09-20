import { escapeHtml, renderFacts, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function time(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown time' : date.toLocaleString();
}

function fileName(filePath) {
  return String(filePath ?? '').split(/[\\/]/u).pop() || 'File';
}

function inspectionFileType(source) {
  const extension = String(source.extension ?? fileName(source.path).match(/(\.[^.]+)$/u)?.[1] ?? '').toLowerCase();
  if (extension === '.csv') return 'CSV';
  if (extension === '.xlsx') return 'XLSX';
  return source.media_type ?? source.extension ?? 'Local file';
}

function columnType(column) {
  const value = column.inferred_type ?? column.kind ?? column.type;
  if (!value) return 'Unknown';
  return String(value).split('_').map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

function list(value) {
  return Array.isArray(value) && value.length ? value.join(', ') : null;
}

function inspectionFacts(inspection) {
  const source = inspection?.source ?? {};
  return renderFacts([
    ['File', fileName(source.path)],
    ['Type', inspectionFileType(source)],
    ['Size', source.bytes == null ? 'Not available' : `${source.bytes.toLocaleString()} bytes`],
    ['Checked', inspection?.created_at ? time(inspection.created_at) : 'Just now'],
  ]);
}

function sheetPicker(work, inspection, csrfToken, returnTo = '/files') {
  const sheets = inspection?.extraction?.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) return '';
  return `<section class="surface"><h2>Choose a sheet</h2><p>Atlas has recorded the workbook structure. Select one sheet for a data inspection.</p>
    <form method="post" action="/files/inspect" class="inline-actions">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="purpose" value="data"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
      <label>Sheet <select name="sheet">${sheets.map((sheet) => `<option value="${escapeHtml(sheet.name ?? sheet.title)}">${escapeHtml(sheet.name ?? sheet.title)}</option>`).join('')}</select></label>
      <button class="action-button" type="submit">Inspect sheet</button>
    </form></section>`;
}

function inspectionDetails(inspection) {
  const extraction = inspection?.extraction ?? {};
  const profile = extraction.profile ?? extraction.data_profile ?? extraction;
  const facts = [];
  if (Number.isFinite(profile.row_count)) facts.push(['Rows', profile.row_count.toLocaleString()]);
  if (Number.isFinite(profile.column_count)) facts.push(['Fields', profile.column_count.toLocaleString()]);
  if (Number.isFinite(profile.duplicate_row_count)) facts.push(['Duplicate rows', profile.duplicate_row_count.toLocaleString()]);
  const columns = Array.isArray(profile.columns) ? profile.columns : [];
  if (facts.length || columns.length) {
    return `<section class="surface"><h2>What Atlas found</h2><p>${Number.isFinite(profile.row_count) && Number.isFinite(profile.column_count) ? `A table with ${escapeHtml(profile.row_count.toLocaleString())} rows and ${escapeHtml(profile.column_count.toLocaleString())} fields is ready.` : 'The local table structure is ready.'}</p><details class="details-panel technical-details"><summary>Technical file details</summary>${facts.length ? renderFacts(facts) : ''}
    ${columns.length ? `<div class="task-table data-profile-table" role="table" aria-label="Detected fields"><div class="task-row task-row-head" role="row"><span>Field</span><span>Type</span><span>Missing</span><span>Notes</span></div>${columns.map((column) => `<div class="task-row" role="row"><span><strong>${escapeHtml(column.name ?? 'Unnamed')}</strong></span><span>${escapeHtml(columnType(column))}</span><span>${escapeHtml(column.missing_count ?? column.missing ?? '—')}</span><span>${escapeHtml(column.date_range ? `${column.date_range.minimum ?? ''} – ${column.date_range.maximum ?? ''}` : '')}</span></div>`).join('')}</div>` : ''}</details>
    </section>`;
  }
  const factsByKind = [];
  const notes = [];
  if (extraction.status === 'complete') factsByKind.push(['Local reading', 'Complete']);
  if (extraction.status === 'partial') factsByKind.push(['Local reading', 'Partial']);
  if (extraction.kind === 'pdf') {
    if (Number.isFinite(extraction.page_count)) factsByKind.push(['Pages', extraction.page_count.toLocaleString()]);
    if (Number.isFinite(extraction.inspected_page_count)) factsByKind.push(['Pages checked', extraction.inspected_page_count.toLocaleString()]);
    if (Number.isFinite(extraction.text_layer_page_count)) factsByKind.push(['Pages with readable text', extraction.text_layer_page_count.toLocaleString()]);
    if (Number.isFinite(extraction.total_text_characters)) factsByKind.push(['Text extracted', `${extraction.total_text_characters.toLocaleString()} characters`]);
    if (extraction.image_only_pages?.length) notes.push(`Image-only pages: ${list(extraction.image_only_pages)}. Atlas did not use OCR.`);
    if (extraction.empty_or_vector_pages?.length) notes.push(`No readable text found on pages: ${list(extraction.empty_or_vector_pages)}.`);
  } else if (extraction.kind === 'docx') {
    if (Number.isFinite(extraction.paragraph_count)) factsByKind.push(['Paragraphs', extraction.paragraph_count.toLocaleString()]);
    if (Number.isFinite(extraction.table_count)) factsByKind.push(['Tables', extraction.table_count.toLocaleString()]);
    if (Array.isArray(extraction.paragraphs)) factsByKind.push(['Text available', extraction.paragraphs.length ? 'Yes' : 'No readable paragraph text']);
    notes.push('The current local reader reports paragraphs and tables, but does not classify headings or sections.');
  } else if (extraction.kind === 'pptx') {
    if (Number.isFinite(extraction.slide_count)) factsByKind.push(['Slides', extraction.slide_count.toLocaleString()]);
    if (Array.isArray(extraction.slides)) {
      factsByKind.push(['Slides with extracted text', extraction.slides.filter((slide) => slide.text).length.toLocaleString()]);
      factsByKind.push(['Speaker notes found', extraction.slides.filter((slide) => slide.notes).length.toLocaleString()]);
      const images = extraction.slides.reduce((total, slide) => total + (Number(slide.image_count) || 0), 0);
      const tables = extraction.slides.reduce((total, slide) => total + (Number(slide.table_count) || 0), 0);
      if (images) factsByKind.push(['Images on checked slides', images.toLocaleString()]);
      if (tables) factsByKind.push(['Tables on checked slides', tables.toLocaleString()]);
    }
    notes.push('The current local reader reports slide text, notes, and object counts, but does not infer slide meaning.');
  } else if (extraction.kind === 'text') {
    if (Number.isFinite(extraction.sample_line_count)) factsByKind.push(['Sampled lines', extraction.sample_line_count.toLocaleString()]);
    if (typeof extraction.text === 'string') factsByKind.push(['Text returned', `${extraction.text.length.toLocaleString()} characters`]);
    if (extraction.line_count_complete === false) notes.push('The line count covers only the input Atlas could read locally.');
  }
  if (extraction.status === 'partial') notes.push('Atlas reached a local reading limit before it could inspect the whole file.');
  if (inspection?.attention?.truncated) {
    notes.push(`Returned text was limited to ${Number(inspection.attention.maximum_characters).toLocaleString()} characters.`);
  }
  if (inspection?.next_action?.reason) notes.push(inspection.next_action.reason);
  if (extraction.status === 'unsupported') notes.push('This file type has no built-in local reader in the current Atlas Runtime.');
  return `<section class="surface"><h2>What Atlas found</h2>${factsByKind.length ? renderFacts(factsByKind) : '<p>Atlas could not extract structured facts for this file type.</p>'}${notes.length ? `<div class="details-panel"><h3>Reading notes</h3><ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></div>` : ''}</section>`;
}

function projectHref(project, projectBasePath) {
  return project?.id && projectBasePath
    ? `${projectBasePath}${encodeURIComponent(project.id)}`
    : null;
}

function resultActions(work, csrfToken, {
  canReinspect = false, reprocessLabel = 'Update local result', canOpenOriginal = true, canUseSource = true,
  projectBasePath = null, backHref = '/files', currentHref = null,
} = {}) {
  const projectLink = projectHref(work.project, projectBasePath);
  const dataWorkLink = canUseSource && work.project?.id && ['.csv', '.xlsx'].some((extension) => fileName(work.file_path).toLowerCase().endsWith(extension))
    ? `<a class="action-button action-button-secondary" href="/data-work/start?work_id=${encodeURIComponent(work.work_id)}">Work with data</a>` : '';
  return `<div class="inline-actions">
    ${canOpenOriginal && canUseSource ? `<form method="post" action="/files/open-original"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="return_to" value="${escapeHtml(currentHref ?? `/files/result/${encodeURIComponent(work.work_id)}`)}"><button class="action-button action-button-secondary" type="submit">Open in default app</button></form>` : ''}
    ${canReinspect ? `<form method="post" action="/files/inspect"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="purpose" value="${escapeHtml(work.inspect.purpose)}"><input type="hidden" name="sheet" value="${escapeHtml(work.inspect.sheet ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(backHref)}"><button class="action-button" type="submit">${escapeHtml(reprocessLabel)}</button></form>` : ''}
    ${projectLink ? `<a class="action-button action-button-secondary" href="${escapeHtml(projectLink)}">Open Project</a>` : canUseSource ? `<a class="action-button action-button-secondary" href="/files/add-to-project?work_id=${encodeURIComponent(work.work_id)}">Add to Project</a>` : ''}
    ${dataWorkLink}
    ${work.project_transfer?.undo_available ? `<form method="post" action="/files/add-to-project/undo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button action-button-secondary" type="submit">Undo Add to Project</button></form>` : ''}
    ${work.project_transfer?.redo_available ? `<form method="post" action="/files/add-to-project/redo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button" type="submit">Redo Add to Project</button></form>` : ''}
    <form method="post" action="/files/remove"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button action-button-remove" type="submit">Remove from Recent Work</button></form>
    <a class="action-button action-button-secondary" href="${escapeHtml(backHref)}">Back</a>
  </div>`;
}

function failureActionLabel(failure) {
  if (failure?.kind === 'cache_unavailable') return 'Rebuild local result';
  if (failure?.kind === 'changed') return 'Update local result';
  if (failure?.kind === 'busy') return 'Retry after closing file';
  if (failure?.kind === 'permission') return 'Retry after allowing access';
  if (failure?.kind === 'component_unavailable') return 'Retry local read';
  return 'Retry local read';
}

function readFailure(work, failure, csrfToken, options) {
  const canRetry = failure?.retry_supported === true;
  const retry = canRetry
    ? `<form method="post" action="/files/inspect"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="purpose" value="${escapeHtml(work.inspect.purpose)}"><input type="hidden" name="sheet" value="${escapeHtml(work.inspect.sheet ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(options.fileBackHref)}"><button class="action-button" type="submit">${escapeHtml(failureActionLabel(failure))}</button></form>`
    : '';
  const open = failure?.open_supported === true
    ? `<form method="post" action="/files/open-original"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="return_to" value="${escapeHtml(options.fileCurrentHref ?? `/files/result/${encodeURIComponent(work.work_id)}`)}"><button class="action-button action-button-secondary" type="submit">Open in default app</button></form>`
    : '';
  const projectLink = projectHref(work.project, options.projectBasePath);
  const project = projectLink ? `<a class="action-button action-button-secondary" href="${escapeHtml(projectLink)}">Open Project</a>` : '';
  const undo = work.project_transfer?.undo_available
    ? `<form method="post" action="/files/add-to-project/undo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button action-button-secondary" type="submit">Undo Add to Project</button></form>`
    : '';
  const limitation = !canRetry && failure?.open_supported !== true
    ? '<p class="callout warn">This saved trace cannot reopen or retry its missing source. You can remove the trace or return.</p>'
    : '';
  return `<div class="page-intro"><div><span class="eyebrow">LOCAL READ</span><h1>${escapeHtml(failure?.title ?? 'Atlas could not read this file')}</h1><p class="lede">${escapeHtml(failure?.action ?? 'Choose the file again or return to the Project.')}</p></div></div><section class="surface">${limitation}<details class="details-panel technical-details" open><summary>Technical details</summary><p>${escapeHtml(failure?.detail ?? 'Atlas did not receive a readable local result.')}</p></details><div class="inline-actions">${retry}${open}${project}${undo}<form method="post" action="/files/remove"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button action-button-remove" type="submit">Remove from Recent Work</button></form><a class="action-button action-button-secondary" href="${escapeHtml(options.fileBackHref)}">Back</a></div></section>`;
}

function addToProjectForm(model, csrfToken) {
  const name = fileName(model.work.file_path);
  const firstProject = model.projects.find((project) => project.available) ?? model.projects[0];
  const projectOptions = model.projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.id === firstProject?.id ? ' selected' : ''}${project.available ? '' : ' disabled'}>${escapeHtml(project.name)}${project.available ? '' : ' — unavailable'}</option>`).join('');
  const folderGroups = model.projects.map((project) => `<div class="project-folder-group" data-project-folders data-project-id="${escapeHtml(project.id)}"${project.id === firstProject?.id ? '' : ' hidden'}><div class="project-folder-root"><strong>${escapeHtml(project.name)}</strong><small>Project root · choose a folder below</small></div>${project.available ? (project.folders.length ? `<div class="project-folder-tree">${project.folders.map((folder) => `<label class="project-folder-option" style="--folder-depth:${escapeHtml(folder.depth)}"><input type="radio" name="folder" value="${escapeHtml(folder.relative_path)}" data-folder-path="${escapeHtml(folder.relative_path)}"${project.id === firstProject?.id ? '' : ' disabled'} required><span><strong>${escapeHtml(folder.name)}</strong><small>${escapeHtml(folder.relative_path)}</small></span></label>`).join('')}</div>${project.folders_truncated ? '<p class="callout warn">This Project has more folders than Atlas can show here.</p>' : ''}` : '<p class="callout warn">This Project has no existing subfolders. Create a folder in the Project first, then return here.</p>') : '<p class="callout warn">This Project folder is unavailable.</p>'}</div>`).join('');
  return `<div class="page-intro"><div><span class="eyebrow">PROJECT</span><h1>Add to Project</h1><p class="lede">Choose an existing Project folder for this file.</p></div></div><section class="surface project-import-surface"><div class="project-import-source"><span class="label">FILE TO SAVE</span><strong>${escapeHtml(name)}</strong><small class="muted mono">${escapeHtml(model.work.file_path)}</small></div>${model.projects.length ? `<form method="post" action="/files/add-to-project/review" class="project-import-form" data-project-folder-form data-file-name="${escapeHtml(name)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(model.work.work_id)}"><label class="setting-field">Project<select name="project_id" data-project-picker>${projectOptions}</select></label><fieldset class="project-folder-picker"><legend>Save to</legend>${folderGroups}</fieldset><div class="project-import-filename"><span class="label">FILE NAME</span><strong>${escapeHtml(name)}</strong><small>The file name stays unchanged.</small></div><p class="project-import-path"><span class="label">SELECTED LOCATION</span><span data-project-path>Choose an existing folder.</span></p><div class="inline-actions"><button class="action-button" type="submit" disabled>Review destination</button><a class="action-button action-button-secondary" href="/files">Back</a></div></form>` : `<p>No Project yet. Create one or register an existing folder, then Atlas will return here.</p><div class="inline-actions"><a class="action-button" href="/projects/new?return_work_id=${encodeURIComponent(model.work.work_id)}">Create Project</a><a class="action-button action-button-secondary" href="/projects/add-existing?return_work_id=${encodeURIComponent(model.work.work_id)}">Add Existing Folder</a><a class="action-button action-button-secondary" href="/files">Back</a></div>`}</section>`;
}

function projectReview(model, csrfToken) {
  const target = model.prepared.target_path ?? model.prepared.target ?? 'Not available';
  return `<div class="page-intro"><div><span class="eyebrow">PROJECT</span><h1>Review destination</h1><p class="lede">Atlas will create one new file at the destination below. It will not overwrite an existing file.</p></div></div><section class="surface">${renderFacts([['File', fileName(model.work.file_path)], ['Project', model.project.name], ['Destination', target, true]])}<div class="inline-actions"><form method="post" action="/files/add-to-project/save"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="import_id" value="${escapeHtml(model.import_id)}"><button class="action-button" type="submit">Save</button></form><a class="action-button action-button-secondary" href="/files/add-to-project?work_id=${encodeURIComponent(model.work.work_id)}">Change destination</a><a class="action-button action-button-secondary" href="/files">Back</a></div></section>`;
}

function projectConflict(model, csrfToken) {
  const folders = model.folders ?? [];
  const folderOptions = folders.map((folder) => `<option value="${escapeHtml(folder.relative_path)}"${folder.relative_path === model.folder ? ' selected' : ''}>${escapeHtml(folder.relative_path)}</option>`).join('');
  return `<div class="page-intro"><div><span class="eyebrow">IMPORT NEEDS A CHOICE</span><h1>Choose another destination</h1><p class="lede">${escapeHtml(model.reason)}</p></div></div><section class="surface project-import-surface"><div class="project-import-source"><span class="label">FILE TO SAVE</span><strong>${escapeHtml(fileName(model.work.file_path))}</strong><small class="muted mono">${escapeHtml(model.target_path)}</small></div><form method="post" action="/files/add-to-project/conflict/resolve" class="project-import-form"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="import_id" value="${escapeHtml(model.import_id)}"><p><strong>${escapeHtml(model.project.name)}</strong></p><label class="setting-field">Existing destination folder<select name="folder" required>${folderOptions}</select></label><label class="setting-field">New file name<input name="file_name" value="${escapeHtml(model.file_name)}" required></label><p class="muted">Atlas will not overwrite the existing file.</p><div class="inline-actions"><button class="action-button" type="submit">Review new destination</button></form><form method="post" action="/files/add-to-project/conflict/cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="import_id" value="${escapeHtml(model.import_id)}"><button class="action-button action-button-secondary" type="submit">Cancel import</button></form></div></section>`;
}

function body(model, csrfToken, options) {
  if (model.mode === 'selected') {
    return `<div class="page-intro"><div><span class="eyebrow">LOCAL FILE</span><h1>${escapeHtml(model.selected.name)}</h1><p class="lede">Ready to inspect this local file.</p></div></div><section class="surface"><p class="mono">${escapeHtml(model.selected.file_path)}</p><form method="post" action="/files/inspect" class="inline-actions"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="selection_id" value="${escapeHtml(model.selected.selection_id)}"><input type="hidden" name="purpose" value="${escapeHtml(model.selected.purpose)}"><button class="action-button" type="submit">Inspect</button><a class="action-button action-button-secondary" href="/files">Back</a></form></section>`;
  }
  if (model.mode === 'ready') {
    return `<div class="page-intro"><div><span class="eyebrow">LOCAL RESULT</span><h1>Inspection ready</h1><p class="lede">Atlas saved this work so you can return to it later.</p></div></div>${inspectionFacts(model.inspection)}${inspectionDetails(model.inspection)}${sheetPicker(model.work, model.inspection, csrfToken, options.fileBackHref)}<section class="surface">${resultActions(model.work, csrfToken, { projectBasePath: options.projectBasePath, backHref: options.fileBackHref, currentHref: options.fileCurrentHref })}</section>`;
  }
  if (model.mode === 'unchanged') {
    return `<div class="page-intro"><div><span class="eyebrow">RECENT WORK</span><h1>Previously inspected</h1><p class="lede">File unchanged. Using previous result. Processing was not run again.</p></div></div>${inspectionFacts(model.inspection)}${inspectionDetails(model.inspection)}${sheetPicker(model.work, model.inspection, csrfToken, options.fileBackHref)}<section class="surface">${resultActions(model.work, csrfToken, { projectBasePath: options.projectBasePath, backHref: options.fileBackHref, currentHref: options.fileCurrentHref })}</section>`;
  }
  if (model.mode === 'cache-missing') {
    return `<div class="page-intro"><div><span class="eyebrow">RECENT WORK</span><h1>Previous result unavailable</h1><p class="lede">The file is unchanged, but the earlier local result is no longer available. Atlas may have cleaned its temporary result cache.</p></div></div><section class="surface">${resultActions(model.work, csrfToken, { canReinspect: true, reprocessLabel: 'Rebuild local result', projectBasePath: options.projectBasePath, backHref: options.fileBackHref, currentHref: options.fileCurrentHref })}</section>`;
  }
  if (model.mode === 'changed') {
    return `<div class="page-intro"><div><span class="eyebrow">RECENT WORK</span><h1>File changed</h1><p class="lede">This file no longer matches the version Atlas used before. The earlier result remains recorded but is not shown as current.</p></div></div><section class="surface">${resultActions(model.work, csrfToken, { canReinspect: true, reprocessLabel: 'Update local result', projectBasePath: options.projectBasePath, backHref: options.fileBackHref, currentHref: options.fileCurrentHref })}</section>`;
  }
  if (model.mode === 'missing') {
    return `<div class="page-intro"><div><span class="eyebrow">RECENT WORK</span><h1>File not found</h1><p class="lede">Atlas did not search for a moved copy.</p></div></div><section class="surface"><p class="callout warn">The saved trace remains available, but actions that require the missing source are unavailable.</p>${resultActions(model.work, csrfToken, { canReinspect: false, canOpenOriginal: false, canUseSource: false, projectBasePath: options.projectBasePath, backHref: options.fileBackHref, currentHref: options.fileCurrentHref })}</section>`;
  }
  if (model.mode === 'read-failed') return readFailure(model.work, model.failure, csrfToken, options);
  if (model.mode === 'add-to-project') return addToProjectForm(model, csrfToken);
  if (model.mode === 'project-conflict') return projectConflict(model, csrfToken);
  if (model.mode === 'project-review') return projectReview(model, csrfToken);
  return '<section class="surface"><p>This file work view is unavailable.</p><a class="action-button action-button-secondary" href="/files">Back to Import</a></section>';
}

export function renderFileWorkView(model, options = {}) {
  const notice = typeof model.notice === 'string'
    ? model.notice
    : model.notice?.title ? `${model.notice.title}. ${model.notice.action ?? ''}`.trim()
      : null;
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas Import</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Import', { interactive: true, workspaceHref: options.workspaceHref, settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Import' })}<main class="page">${notice ? `<section class="surface"><p class="callout warn">${escapeHtml(notice)}</p></section>` : ''}${body(model, options.csrfToken, options)}</main></div></div></body></html>`;
}
