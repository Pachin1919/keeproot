import { UI_DISPLAY_NAME } from '../brand.js';
import { escapeHtml, renderFacts, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

function ui(options, key, values = {}) {
  let value = translateUi(options.locale, `filework.${key}`, options.languageCatalog);
  for (const [name, replacement] of Object.entries(values)) value = value.replaceAll(`{${name}}`, String(replacement));
  return value;
}
const label = (options, key, values) => escapeHtml(ui(options, key, values));

function time(value, options) {
  if (!value) return ui(options, 'unknown_time');
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? ui(options, 'unknown_time') : date.toLocaleString(normalizeUiLocale(options.locale));
}

function fileName(filePath) {
  return String(filePath ?? '').split(/[\\/]/u).pop() || 'File';
}

function inspectionFileType(source, options) {
  const extension = String(source.extension ?? fileName(source.path).match(/(\.[^.]+)$/u)?.[1] ?? '').toLowerCase();
  if (extension === '.csv') return 'CSV';
  if (extension === '.xlsx') return 'XLSX';
  return source.media_type ?? source.extension ?? ui(options, 'local_file_type');
}

function columnType(column, options) {
  const value = column.inferred_type ?? column.kind ?? column.type;
  if (!value) return ui(options, 'unknown');
  return String(value).split('_').map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

function list(value) {
  return Array.isArray(value) && value.length ? value.join(', ') : null;
}

function inspectionFacts(inspection, options) {
  const source = inspection?.source ?? {};
  return renderFacts([
    [ui(options, 'file'), fileName(source.path)],
    [ui(options, 'type'), inspectionFileType(source, options)],
    [ui(options, 'size'), source.bytes == null ? ui(options, 'not_available') : ui(options, 'bytes', { count: source.bytes.toLocaleString(normalizeUiLocale(options.locale)) })],
    [ui(options, 'checked'), inspection?.created_at ? time(inspection.created_at, options) : ui(options, 'just_now')],
  ]);
}

function sheetPicker(work, inspection, csrfToken, returnTo = '/files', options = {}) {
  const sheets = inspection?.extraction?.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) return '';
  return `<section class="surface"><h2>${label(options, 'choose_sheet')}</h2><p>${label(options, 'choose_sheet_help')}</p>
    <form method="post" action="/files/inspect" class="inline-actions">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="purpose" value="data"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
      <label>${label(options, 'sheet')} <select name="sheet">${sheets.map((sheet) => `<option value="${escapeHtml(sheet.name ?? sheet.title)}">${escapeHtml(sheet.name ?? sheet.title)}</option>`).join('')}</select></label>
      <button class="action-button" type="submit">${label(options, 'inspect_sheet')}</button>
    </form></section>`;
}

function inspectionDetails(inspection, options) {
  const extraction = inspection?.extraction ?? {};
  const profile = extraction.profile ?? extraction.data_profile ?? extraction;
  const facts = [];
  if (Number.isFinite(profile.row_count)) facts.push([ui(options, 'rows'), profile.row_count.toLocaleString()]);
  if (Number.isFinite(profile.column_count)) facts.push([ui(options, 'fields'), profile.column_count.toLocaleString()]);
  if (Number.isFinite(profile.duplicate_row_count)) facts.push([ui(options, 'duplicate_rows'), profile.duplicate_row_count.toLocaleString()]);
  const columns = Array.isArray(profile.columns) ? profile.columns : [];
  if (facts.length || columns.length) {
    return `<section class="surface"><h2>${label(options, 'found')}</h2><p>${Number.isFinite(profile.row_count) && Number.isFinite(profile.column_count) ? label(options, 'table_ready', { rows: profile.row_count.toLocaleString(), fields: profile.column_count.toLocaleString() }) : label(options, 'table_structure_ready')}</p><details class="details-panel technical-details"><summary>${label(options, 'technical_file_details')}</summary>${facts.length ? renderFacts(facts) : ''}
    ${columns.length ? `<div class="task-table data-profile-table" role="table" aria-label="${label(options, 'detected_fields')}"><div class="task-row task-row-head" role="row"><span>${label(options, 'field')}</span><span>${label(options, 'type')}</span><span>${label(options, 'missing')}</span><span>${label(options, 'notes')}</span></div>${columns.map((column) => `<div class="task-row" role="row"><span><strong>${escapeHtml(column.name ?? ui(options, 'unnamed'))}</strong></span><span>${escapeHtml(columnType(column, options))}</span><span>${escapeHtml(column.missing_count ?? column.missing ?? '—')}</span><span>${escapeHtml(column.date_range ? `${column.date_range.minimum ?? ''} – ${column.date_range.maximum ?? ''}` : '')}</span></div>`).join('')}</div>` : ''}</details>
    </section>`;
  }
  const factsByKind = [];
  const notes = [];
  if (extraction.status === 'complete') factsByKind.push([ui(options, 'local_reading'), ui(options, 'complete')]);
  if (extraction.status === 'partial') factsByKind.push([ui(options, 'local_reading'), ui(options, 'partial')]);
  if (extraction.kind === 'pdf') {
    if (Number.isFinite(extraction.page_count)) factsByKind.push([ui(options, 'pages'), extraction.page_count.toLocaleString()]);
    if (Number.isFinite(extraction.inspected_page_count)) factsByKind.push([ui(options, 'pages_checked'), extraction.inspected_page_count.toLocaleString()]);
    if (Number.isFinite(extraction.text_layer_page_count)) factsByKind.push([ui(options, 'pages_with_text'), extraction.text_layer_page_count.toLocaleString()]);
    if (Number.isFinite(extraction.total_text_characters)) factsByKind.push([ui(options, 'text_extracted'), ui(options, 'characters', { count: extraction.total_text_characters.toLocaleString() })]);
    if (extraction.image_only_pages?.length) notes.push(ui(options, 'image_only_pages', { pages: list(extraction.image_only_pages) }));
    if (extraction.empty_or_vector_pages?.length) notes.push(ui(options, 'no_text_pages', { pages: list(extraction.empty_or_vector_pages) }));
  } else if (extraction.kind === 'docx') {
    if (Number.isFinite(extraction.paragraph_count)) factsByKind.push([ui(options, 'paragraphs'), extraction.paragraph_count.toLocaleString()]);
    if (Number.isFinite(extraction.table_count)) factsByKind.push([ui(options, 'tables'), extraction.table_count.toLocaleString()]);
    if (Array.isArray(extraction.paragraphs)) factsByKind.push([ui(options, 'text_available'), extraction.paragraphs.length ? ui(options, 'yes') : ui(options, 'no_paragraph_text')]);
    notes.push(ui(options, 'docx_note'));
  } else if (extraction.kind === 'pptx') {
    if (Number.isFinite(extraction.slide_count)) factsByKind.push([ui(options, 'slides'), extraction.slide_count.toLocaleString()]);
    if (Array.isArray(extraction.slides)) {
      factsByKind.push([ui(options, 'slides_with_text'), extraction.slides.filter((slide) => slide.text).length.toLocaleString()]);
      factsByKind.push([ui(options, 'speaker_notes'), extraction.slides.filter((slide) => slide.notes).length.toLocaleString()]);
      const images = extraction.slides.reduce((total, slide) => total + (Number(slide.image_count) || 0), 0);
      const tables = extraction.slides.reduce((total, slide) => total + (Number(slide.table_count) || 0), 0);
      if (images) factsByKind.push([ui(options, 'images_on_slides'), images.toLocaleString()]);
      if (tables) factsByKind.push([ui(options, 'tables_on_slides'), tables.toLocaleString()]);
    }
    notes.push(ui(options, 'pptx_note'));
  } else if (extraction.kind === 'text') {
    if (Number.isFinite(extraction.sample_line_count)) factsByKind.push([ui(options, 'sampled_lines'), extraction.sample_line_count.toLocaleString()]);
    if (typeof extraction.text === 'string') factsByKind.push([ui(options, 'text_returned'), ui(options, 'characters', { count: extraction.text.length.toLocaleString() })]);
    if (extraction.line_count_complete === false) notes.push(ui(options, 'line_count_note'));
  }
  if (extraction.status === 'partial') notes.push(ui(options, 'partial_note'));
  if (inspection?.attention?.truncated) {
    notes.push(ui(options, 'returned_limit', { count: Number(inspection.attention.maximum_characters).toLocaleString() }));
  }
  const nextActionKey = {
    bounded_visual_preview: 'next_visual',
    use_local_extraction_with_gaps: 'next_pdf_gaps',
    use_local_data_profile: 'next_data',
    use_local_extraction: 'next_extraction',
    specialized_local_parser_required: 'next_parser',
  }[inspection?.next_action?.mode];
  if (nextActionKey) notes.push(ui(options, nextActionKey));
  else if (inspection?.next_action?.reason) notes.push(inspection.next_action.reason);
  if (extraction.status === 'unsupported') notes.push(ui(options, 'unsupported_note'));
  return `<section class="surface"><h2>${label(options, 'found')}</h2>${factsByKind.length ? renderFacts(factsByKind) : `<p>${label(options, 'no_structured_facts')}</p>`}${notes.length ? `<div class="details-panel"><h3>${label(options, 'reading_notes')}</h3><ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></div>` : ''}</section>`;
}

function projectHref(project, projectBasePath) {
  return project?.id && projectBasePath
    ? `${projectBasePath}${encodeURIComponent(project.id)}`
    : null;
}

function resultActions(work, csrfToken, {
  canReinspect = false, reprocessLabel = 'Update local result', canOpenOriginal = true, canUseSource = true,
  projectBasePath = null, backHref = '/files', currentHref = null, locale, languageCatalog,
} = {}) {
  const options = { locale, languageCatalog };
  const projectLink = projectHref(work.project, projectBasePath);
  const dataWorkLink = canUseSource && work.project?.id && ['.csv', '.xlsx'].some((extension) => fileName(work.file_path).toLowerCase().endsWith(extension))
    ? `<a class="action-button action-button-secondary" href="/data-work/start?work_id=${encodeURIComponent(work.work_id)}">${label(options, 'work_with_data')}</a>` : '';
  return `<div class="inline-actions">
    ${canOpenOriginal && canUseSource ? `<form method="post" action="/files/open-original"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="return_to" value="${escapeHtml(currentHref ?? `/files/result/${encodeURIComponent(work.work_id)}`)}"><button class="action-button action-button-secondary" type="submit">${label(options, 'open_default')}</button></form>` : ''}
    ${canReinspect ? `<form method="post" action="/files/inspect"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="purpose" value="${escapeHtml(work.inspect.purpose)}"><input type="hidden" name="sheet" value="${escapeHtml(work.inspect.sheet ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(backHref)}"><button class="action-button" type="submit">${escapeHtml(reprocessLabel)}</button></form>` : ''}
    ${projectLink ? `<a class="action-button action-button-secondary" href="${escapeHtml(projectLink)}">${label(options, 'open_project')}</a>` : canUseSource ? `<a class="action-button action-button-secondary" href="/files/add-to-project?work_id=${encodeURIComponent(work.work_id)}">${label(options, 'add_project')}</a>` : ''}
    ${dataWorkLink}
    ${work.project_transfer?.undo_available ? `<form method="post" action="/files/add-to-project/undo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button action-button-secondary" type="submit">${label(options, 'undo_add')}</button></form>` : ''}
    ${work.project_transfer?.redo_available ? `<form method="post" action="/files/add-to-project/redo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button" type="submit">${label(options, 'redo_add')}</button></form>` : ''}
    <form method="post" action="/files/remove"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button action-button-remove" type="submit">${label(options, 'remove_recent')}</button></form>
    <a class="action-button action-button-secondary" href="${escapeHtml(backHref)}">${label(options, 'back')}</a>
  </div>`;
}

function failureActionLabel(failure, options) {
  if (failure?.kind === 'cache_unavailable') return ui(options, 'rebuild');
  if (failure?.kind === 'changed') return ui(options, 'update');
  if (failure?.kind === 'busy') return ui(options, 'retry_close');
  if (failure?.kind === 'permission') return ui(options, 'retry_access');
  return ui(options, 'retry_read');
}

function readFailure(work, failure, csrfToken, options) {
  const knownFailure = new Set(['missing', 'permission', 'busy', 'component_unavailable', 'cache_unavailable', 'changed', 'sheet', 'encoding', 'header', 'corrupt', 'unsupported', 'parser', 'unknown']).has(failure?.kind);
  const failureKind = knownFailure ? failure.kind : 'unknown';
  const canRetry = failure?.retry_supported === true;
  const retry = canRetry
    ? `<form method="post" action="/files/inspect"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="purpose" value="${escapeHtml(work.inspect.purpose)}"><input type="hidden" name="sheet" value="${escapeHtml(work.inspect.sheet ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(options.fileBackHref)}"><button class="action-button" type="submit">${escapeHtml(failureActionLabel(failure, options))}</button></form>`
    : '';
  const open = failure?.open_supported === true
    ? `<form method="post" action="/files/open-original"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><input type="hidden" name="return_to" value="${escapeHtml(options.fileCurrentHref ?? `/files/result/${encodeURIComponent(work.work_id)}`)}"><button class="action-button action-button-secondary" type="submit">${label(options, 'open_default')}</button></form>`
    : '';
  const projectLink = projectHref(work.project, options.projectBasePath);
  const project = projectLink ? `<a class="action-button action-button-secondary" href="${escapeHtml(projectLink)}">${label(options, 'open_project')}</a>` : '';
  const undo = work.project_transfer?.undo_available
    ? `<form method="post" action="/files/add-to-project/undo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button action-button-secondary" type="submit">${label(options, 'undo_add')}</button></form>`
    : '';
  const limitation = !canRetry && failure?.open_supported !== true
    ? `<p class="callout warn">${label(options, 'trace_limited')}</p>`
    : '';
  return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'local_read')}</span><h1>${label(options, `failure_${failureKind}_title`)}</h1><p class="lede">${label(options, `failure_${failureKind}_action`)}</p></div></div><section class="surface">${limitation}<details class="details-panel technical-details" open><summary>${label(options, 'technical_details')}</summary><p>${escapeHtml(failure?.detail ?? ui(options, 'no_local_result'))}</p></details><div class="inline-actions">${retry}${open}${project}${undo}<form method="post" action="/files/remove"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(work.work_id)}"><button class="action-button action-button-remove" type="submit">${label(options, 'remove_recent')}</button></form><a class="action-button action-button-secondary" href="${escapeHtml(options.fileBackHref)}">${label(options, 'back')}</a></div></section>`;
}

function addToProjectForm(model, csrfToken, options) {
  const name = fileName(model.work.file_path);
  const firstProject = model.projects.find((project) => project.available) ?? model.projects[0];
  const projectOptions = model.projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.id === firstProject?.id ? ' selected' : ''}${project.available ? '' : ' disabled'}>${escapeHtml(project.name)}${project.available ? '' : label(options, 'unavailable_suffix')}</option>`).join('');
  const folderGroups = model.projects.map((project) => `<div class="project-folder-group" data-project-folders data-project-id="${escapeHtml(project.id)}"${project.id === firstProject?.id ? '' : ' hidden'}><div class="project-folder-root"><strong>${escapeHtml(project.name)}</strong><small>${label(options, 'project_root')}</small></div>${project.available ? (project.folders.length ? `<div class="project-folder-tree">${project.folders.map((folder) => `<label class="project-folder-option" style="--folder-depth:${escapeHtml(folder.depth)}"><input type="radio" name="folder" value="${escapeHtml(folder.relative_path)}" data-folder-path="${escapeHtml(folder.relative_path)}"${project.id === firstProject?.id ? '' : ' disabled'} required><span><strong>${escapeHtml(folder.name)}</strong><small>${escapeHtml(folder.relative_path)}</small></span></label>`).join('')}</div>${project.folders_truncated ? `<p class="callout warn">${label(options, 'too_many_folders')}</p>` : ''}` : `<p class="callout warn">${label(options, 'no_subfolders')}</p>`) : `<p class="callout warn">${label(options, 'folder_unavailable')}</p>`}</div>`).join('');
  return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'project')}</span><h1>${label(options, 'add_project')}</h1><p class="lede">${label(options, 'add_project_help')}</p></div></div><section class="surface project-import-surface"><div class="project-import-source"><span class="label">${label(options, 'file_to_save')}</span><strong>${escapeHtml(name)}</strong><small class="muted mono">${escapeHtml(model.work.file_path)}</small></div>${model.projects.length ? `<form method="post" action="/files/add-to-project/review" class="project-import-form" data-project-folder-form data-file-name="${escapeHtml(name)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(model.work.work_id)}"><label class="setting-field">${label(options, 'project')}<select name="project_id" data-project-picker>${projectOptions}</select></label><fieldset class="project-folder-picker"><legend>${label(options, 'save_to')}</legend>${folderGroups}</fieldset><div class="project-import-filename"><span class="label">${label(options, 'file_name')}</span><strong>${escapeHtml(name)}</strong><small>${label(options, 'name_unchanged')}</small></div><p class="project-import-path"><span class="label">${label(options, 'selected_location')}</span><span data-project-path>${label(options, 'choose_folder')}</span></p><div class="inline-actions"><button class="action-button" type="submit" disabled>${label(options, 'review_destination')}</button><a class="action-button action-button-secondary" href="/files">${label(options, 'back')}</a></div></form>` : `<p>${label(options, 'no_project')}</p><div class="inline-actions"><a class="action-button" href="/projects/new?return_work_id=${encodeURIComponent(model.work.work_id)}">${label(options, 'create_project')}</a><a class="action-button action-button-secondary" href="/projects/add-existing?return_work_id=${encodeURIComponent(model.work.work_id)}">${label(options, 'add_existing_folder')}</a><a class="action-button action-button-secondary" href="/files">${label(options, 'back')}</a></div>`}</section>`;
}

function projectReview(model, csrfToken, options) {
  const target = model.prepared.target_path ?? model.prepared.target ?? ui(options, 'not_available');
  return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'project')}</span><h1>${label(options, 'review_destination')}</h1><p class="lede">${label(options, 'review_help')}</p></div></div><section class="surface">${renderFacts([[ui(options, 'file'), fileName(model.work.file_path)], [ui(options, 'project'), model.project.name], [ui(options, 'destination'), target, true]])}<div class="inline-actions"><form method="post" action="/files/add-to-project/save"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="import_id" value="${escapeHtml(model.import_id)}"><button class="action-button" type="submit">${label(options, 'save')}</button></form><a class="action-button action-button-secondary" href="/files/add-to-project?work_id=${encodeURIComponent(model.work.work_id)}">${label(options, 'change_destination')}</a><a class="action-button action-button-secondary" href="/files">${label(options, 'back')}</a></div></section>`;
}

function projectConflict(model, csrfToken, options) {
  const folders = model.folders ?? [];
  const folderOptions = folders.map((folder) => `<option value="${escapeHtml(folder.relative_path)}"${folder.relative_path === model.folder ? ' selected' : ''}>${escapeHtml(folder.relative_path)}</option>`).join('');
  return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'import_choice')}</span><h1>${label(options, 'choose_another')}</h1><p class="lede">${label(options, 'conflict_help')}</p></div></div><section class="surface project-import-surface">${model.reason ? `<details class="technical-details"><summary>${label(options, 'original_reason')}</summary><p>${escapeHtml(model.reason)}</p></details>` : ''}<div class="project-import-source"><span class="label">${label(options, 'file_to_save')}</span><strong>${escapeHtml(fileName(model.work.file_path))}</strong><small class="muted mono">${escapeHtml(model.target_path)}</small></div><form method="post" action="/files/add-to-project/conflict/resolve" class="project-import-form"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="import_id" value="${escapeHtml(model.import_id)}"><p><strong>${escapeHtml(model.project.name)}</strong></p><label class="setting-field">${label(options, 'existing_folder')}<select name="folder" required>${folderOptions}</select></label><label class="setting-field">${label(options, 'new_name')}<input name="file_name" value="${escapeHtml(model.file_name)}" required></label><p class="muted">${label(options, 'no_overwrite')}</p><div class="inline-actions"><button class="action-button" type="submit">${label(options, 'review_new')}</button></form><form method="post" action="/files/add-to-project/conflict/cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="import_id" value="${escapeHtml(model.import_id)}"><button class="action-button action-button-secondary" type="submit">${label(options, 'cancel_import')}</button></form></div></section>`;
}

function body(model, csrfToken, options) {
  const actions = (work, extra = {}) => resultActions(work, csrfToken, {
    ...options, projectBasePath: options.projectBasePath, backHref: options.fileBackHref,
    currentHref: options.fileCurrentHref, ...extra,
  });
  const inspection = () => `${inspectionFacts(model.inspection, options)}${inspectionDetails(model.inspection, options)}${sheetPicker(model.work, model.inspection, csrfToken, options.fileBackHref, options)}`;
  if (model.mode === 'selected') {
    return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'local_file')}</span><h1>${escapeHtml(model.selected.name)}</h1><p class="lede">${label(options, 'ready_to_inspect')}</p></div></div><section class="surface"><p class="mono">${escapeHtml(model.selected.file_path)}</p><form method="post" action="/files/inspect" class="inline-actions"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="selection_id" value="${escapeHtml(model.selected.selection_id)}"><input type="hidden" name="purpose" value="${escapeHtml(model.selected.purpose)}"><button class="action-button" type="submit">${label(options, 'inspect')}</button><a class="action-button action-button-secondary" href="/files">${label(options, 'back')}</a></form></section>`;
  }
  if (model.mode === 'ready') {
    return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'local_result')}</span><h1>${label(options, 'inspection_ready')}</h1><p class="lede">${label(options, 'saved_for_later')}</p></div></div>${inspection()}<section class="surface">${actions(model.work)}</section>`;
  }
  if (model.mode === 'unchanged') {
    return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'recent_work')}</span><h1>${label(options, 'previously_inspected')}</h1><p class="lede">${label(options, 'unchanged_help')}</p></div></div>${inspection()}<section class="surface">${actions(model.work)}</section>`;
  }
  if (model.mode === 'cache-missing') {
    return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'recent_work')}</span><h1>${label(options, 'previous_unavailable')}</h1><p class="lede">${label(options, 'cache_missing_help')}</p></div></div><section class="surface">${actions(model.work, { canReinspect: true, reprocessLabel: ui(options, 'rebuild') })}</section>`;
  }
  if (model.mode === 'changed') {
    return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'recent_work')}</span><h1>${label(options, 'file_changed')}</h1><p class="lede">${label(options, 'changed_help')}</p></div></div><section class="surface">${actions(model.work, { canReinspect: true, reprocessLabel: ui(options, 'update') })}</section>`;
  }
  if (model.mode === 'missing') {
    return `<div class="page-intro"><div><span class="eyebrow">${label(options, 'recent_work')}</span><h1>${label(options, 'file_not_found')}</h1><p class="lede">${label(options, 'not_searched')}</p></div></div><section class="surface"><p class="callout warn">${label(options, 'missing_help')}</p>${actions(model.work, { canReinspect: false, canOpenOriginal: false, canUseSource: false })}</section>`;
  }
  if (model.mode === 'read-failed') return readFailure(model.work, model.failure, csrfToken, options);
  if (model.mode === 'add-to-project') return addToProjectForm(model, csrfToken, options);
  if (model.mode === 'project-conflict') return projectConflict(model, csrfToken, options);
  if (model.mode === 'project-review') return projectReview(model, csrfToken, options);
  return `<section class="surface"><p>${label(options, 'view_unavailable')}</p><a class="action-button action-button-secondary" href="/files">${label(options, 'back_import')}</a></section>`;
}

export function renderFileWorkView(model, options = {}) {
  const notice = typeof model.notice === 'string'
    ? model.notice
    : model.notice?.title ? `${model.notice.title}. ${model.notice.action ?? ''}`.trim()
      : null;
  const title = translateUi(options.locale, 'import.title', options.languageCatalog);
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${UI_DISPLAY_NAME} ${escapeHtml(title)}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Import', { ...options, project: model.work?.project ?? options.project, interactive: true, workspaceHref: options.workspaceHref, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: title, locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page">${notice ? `<section class="surface"><p class="callout warn">${escapeHtml(notice)}</p></section>` : ''}${body(model, options.csrfToken, options)}</main></div></div></body></html>`;
}
