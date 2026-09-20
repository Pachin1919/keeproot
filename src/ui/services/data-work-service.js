import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contentFilePath } from '../../content-inspection.js';
import { runUiContentOperation } from '../content-worker-client.js';

const SESSION_AGE_MS = 60 * 60 * 1000;
function dataFile(filePath) { return ['.csv', '.xlsx'].includes(path.extname(filePath).toLowerCase()); }
function normalizeColumns(columns, available) { return [...new Set((columns ?? []).filter((item) => available.includes(item)))]; }
function normalizeFilter(input, available, kinds) {
  const column = input?.column; const operator = input?.operator;
  if (!available.includes(column)) throw new Error('Choose one available column.');
  const numeric = ['=', '!=', '>', '>=', '<', '<=']; const text = ['equals', 'not_equals', 'contains', 'not_contains'];
  if (!['is_empty', 'not_empty', ...numeric, ...text].includes(operator)) throw new Error('Choose one supported filter.');
  if (numeric.includes(operator) && kinds[column] !== 'number') throw new Error('Numeric filters are available only for columns Atlas can read as numbers.');
  return { id: `FLT-${crypto.randomBytes(8).toString('hex')}`, column, operator, value: operator.includes('empty') ? null : String(input?.value ?? '') };
}
function completeMapping(value, mapping = value.mapping) {
  const expected = value.sources.flatMap((item) => (item.profile?.profile?.fields ?? []).map((field) => ({
    key: `${item.source_key}\u0000${field.name}`, source_sha256: item.fingerprint?.sha256 ?? null, source_sheet: item.sheet ?? null,
  })));
  const actual = mapping.map((item) => `${item.source_key}\u0000${item.column}`);
  return mapping.length === expected.length && new Set(actual).size === actual.length
    && expected.every((fact) => {
      const item = mapping.find((entry) => `${entry.source_key}\u0000${entry.column}` === fact.key);
      return item && String(item.canonical ?? '').trim() && item.source_sha256 === fact.source_sha256 && (item.source_sheet ?? null) === fact.source_sheet;
    });
}
function stateConflict(message) { const error = new Error(message); error.code = 'ATLAS_STATE_CONFLICT'; return error; }
export function createDataWorkService({
  stateDir,
  projectRoot,
  installationRoot,
  resourceControl = null,
  runDataWorkFn = (args) => runUiContentOperation('data-work', args),
  fingerprintFn = (filePath) => runUiContentOperation('fingerprint', { filePath }),
  now = () => Date.now(),
}) {
  const repository = resourceControl?.ledger?.workSessions ?? null;
  const projectCache = new Map();
  const persistentStages = new Map();
  const discardPersistentStage = (id) => { const value = persistentStages.get(id); if (value?.path) fs.rmSync(value.path, { force: true }); persistentStages.delete(id); };
  const isoNow = () => new Date(now()).toISOString();
  const hydratePersistent = (value) => {
    if (!value) return null;
    const project = projectCache.get(value.project_id) ?? { id: value.project_id };
    const sources = value.sources.map((item) => {
      const detail = resourceControl?.describe(item.resource_id) ?? null;
      const location = detail?.locations?.find((entry) => entry.project_id === value.project_id && entry.status === 'active')
        ?? detail?.locations?.find((entry) => entry.status === 'active')
        ?? detail?.locations?.at(-1)
        ?? null;
      const filePath = location?.path ?? null;
      const present = filePath && fs.existsSync(filePath);
      const supported = present && dataFile(filePath);
      const status = !present ? 'missing' : supported ? item.status : 'unsupported';
      return {
        ...item,
        status,
        error_message: status === item.status ? item.error_message : status === 'missing' ? 'The selected Resource is no longer available at its recorded location.' : 'Work supports CSV or XLSX Resources.',
        file_path: filePath,
        name: detail?.resource?.display_name ?? (filePath ? path.basename(filePath) : item.resource_id),
        sheets: item.profile?.sheets ?? null,
      };
    });
    return { ...value, project, sources };
  };
  const projectSession = (project, returnState = null) => {
    if (!repository || !resourceControl) throw new Error('Persistent Work Sessions require the Atlas Resource store.');
    if (!project?.id) throw new Error('Work Session requires one Project.');
    projectCache.set(project.id, project);
    let value = repository.latestOpenForProject(project.id);
    if (!value) value = repository.create({ projectId: project.id, returnState: returnState ?? {}, at: isoNow() });
    else if (returnState) value = repository.updateReturnState(value.session_id, returnState, isoNow());
    return persistentSession(value.session_id);
  };
  const createProjectSession = (project, returnState = {}, resourceIds = [], metadata = {}) => {
    if (!repository || !resourceControl) throw new Error('Persistent Work Sessions require the Atlas Resource store.');
    if (!project?.id) throw new Error('Work Session requires one Project.');
    projectCache.set(project.id, project);
    const targets = [...new Set((Array.isArray(resourceIds) ? resourceIds : []).map(String))];
    for (const resourceId of targets) workResource(project.id, resourceId);
    return persistentSession(repository.create({ projectId: project.id, returnState, resourceIds: targets, intent: metadata.intent ?? null, caller: metadata.caller ?? null, at: isoNow() }).session_id);
  };
  const currentProjectSession = (project) => {
    if (!repository || !project?.id) return null;
    projectCache.set(project.id, project);
    const value = repository.latestOpenForProject(project.id);
    return value ? persistentSession(value.session_id) : null;
  };
  const openProjectSessions = (project) => {
    if (!repository || !project?.id) return [];
    projectCache.set(project.id, project);
    return repository.listOpenForProject(project.id).map((value) => persistentSession(value.session_id)).filter(Boolean);
  };
  const discoverProjectSessions = (project, { limit = 20, offset = 0 } = {}) => {
    if (!project?.id) throw new Error('Project-scoped Work discovery requires one Project.');
    projectCache.set(project.id, project);
    const listing = repository?.listForProject(project.id, { limit, offset }) ?? { sessions: [], total: 0 };
    const works = listing.sessions.map((value) => ({
      session_id: value.session_id,
      project_id: value.project_id,
      status: value.status,
      revision: value.revision,
      intent: value.intent,
      caller: value.caller,
      created_at: value.created_at,
      updated_at: value.updated_at,
      source_count: value.sources.length,
      sources: value.sources.map((item) => {
        let name = item.resource_id;
        try { name = resourceControl?.describe(item.resource_id)?.resource?.display_name ?? name; } catch { /* Retain the stored identity when its record cannot be read. */ }
        return { resource_id: item.resource_id, name, status: item.status };
      }),
      latest_save_id: value.latest_save_id,
      desktop_href: `/work/${encodeURIComponent(value.session_id)}`,
    }));
    const complete = offset + works.length >= listing.total;
    return { project_id: project.id, works, total: listing.total, limit, offset, complete, next_offset: complete ? null : offset + works.length };
  };
  const assertRevision = (id, baseRevision) => repository?.assertRevision(id, baseRevision);
  const workResource = (projectId, resourceId) => {
    const detail = resourceControl.describe(resourceId);
    const location = detail.locations.find((item) => item.project_id === projectId && item.status === 'active');
    if (!location) throw new Error('Choose a Resource stored in this Project.');
    if (!dataFile(location.path)) throw new Error('Work supports CSV or XLSX Resources.');
    return detail;
  };
  const replaceSources = (id, resourceIds, { baseRevision, returnState = null } = {}) => {
    const value = repository?.byId(id);
    if (!value || value.status !== 'open') throw new Error('This Work Session is unavailable.');
    if (baseRevision == null) throw new Error('Updating Work Sources requires one base revision.');
    assertRevision(id, baseRevision);
    const targets = [...new Set((Array.isArray(resourceIds) ? resourceIds : []).map(String))];
    if (!targets.length) throw new Error('Choose at least one CSV or XLSX Resource.');
    for (const resourceId of targets) workResource(value.project_id, resourceId);
    discardPersistentStage(id);
    return persistentSession(repository.replaceSources({ sessionId: id, resourceIds: targets, baseRevision, returnState, at: isoNow() }).session_id);
  };
  const addSource = (id, resourceId, { baseRevision = null } = {}) => {
    const value = repository?.byId(id);
    if (!value || value.status !== 'open') throw new Error('This Work Session is unavailable.');
    workResource(value.project_id, resourceId);
    assertRevision(id, baseRevision);
    discardPersistentStage(id); return persistentSession(repository.addSource({ sessionId: id, resourceId, baseRevision, at: isoNow() }).session_id);
  };
  const removeSource = (id, resourceId, { baseRevision = null } = {}) => {
    const value = repository?.byId(id);
    if (!value || value.status !== 'open') throw new Error('This Work Session is unavailable.');
    assertRevision(id, baseRevision);
    discardPersistentStage(id); return persistentSession(repository.removeSource(id, resourceId, isoNow(), baseRevision).session_id);
  };
  const comparison = (value) => {
    const ready = value.sources.filter((item) => item.status === 'ready' && item.profile?.profile?.fields);
    const names = ready.map((item) => new Set(item.profile.profile.fields.map((field) => field.name)));
    const common = names.length ? [...names[0]].filter((name) => names.every((set) => set.has(name))) : [];
    const all = [...new Set(names.flatMap((set) => [...set]))];
    const unique = ready.map((item) => ({ source_key: item.source_key, fields: item.profile.profile.fields.map((field) => field.name).filter((name) => !common.includes(name)) }));
    const conflicts = all.map((name) => {
      const types = ready.flatMap((item) => item.profile.profile.fields.filter((field) => field.name === name).map((field) => ({ source_key: item.source_key, type: field.inferred_type })));
      return new Set(types.map((item) => item.type)).size > 1 ? { field: name, types } : null;
    }).filter(Boolean);
    return { common_fields: common, unique_fields: unique, type_conflicts: conflicts };
  };
  const persistentSession = (id) => {
    const value = hydratePersistent(repository?.byId(id));
    return value ? { ...value, comparison: comparison(value), mapping_complete: completeMapping(value) } : null;
  };
  const validateSources = async (id) => {
    const stored = repository?.byId(id);
    let value = persistentSession(id);
    if (!value) return null;
    let invalidated = false;
    for (const item of value.sources) {
      const priorStatus = stored?.sources.find((source) => source.source_key === item.source_key)?.status;
      if (!item.file_path || !fs.existsSync(item.file_path)) {
        repository.setSourceStatus(id, item.source_key, 'missing', 'The selected Resource is no longer available at its recorded location.', isoNow());
        if (priorStatus !== 'missing') invalidated = true;
        continue;
      }
      if (!dataFile(item.file_path)) {
        repository.setSourceStatus(id, item.source_key, 'unsupported', 'Work supports CSV or XLSX Resources.', isoNow());
        if (priorStatus !== 'unsupported') invalidated = true;
        continue;
      }
      const current = await fingerprintFn(item.file_path);
      if (item.fingerprint?.sha256 && current.sha256 !== item.fingerprint.sha256) {
        if (priorStatus !== 'changed') {
          repository.setSourceStatus(id, item.source_key, 'changed', 'This Source changed after its facts were prepared. Refresh Sources before continuing.', isoNow());
          invalidated = true;
        }
      } else if (priorStatus === 'missing' || priorStatus === 'changed') {
        repository.setSourceStatus(id, item.source_key, item.fingerprint ? 'ready' : 'pending', null, isoNow());
      }
    }
    if (invalidated) { discardPersistentStage(id); repository.invalidate(id, isoNow()); }
    return persistentSession(id);
  };
  const prepareSources = async (id, { baseRevision = null } = {}) => {
    if (baseRevision != null) assertRevision(id, baseRevision);
    let value = persistentSession(id);
    if (!value) throw new Error('This Work Session is unavailable.');
    for (const item of value.sources) {
      if (!item.file_path || !fs.existsSync(item.file_path)) {
        repository.setSourceStatus(id, item.source_key, 'missing', 'The selected Resource is no longer available at its recorded location.', isoNow());
        continue;
      }
      try {
        const fingerprint = await fingerprintFn(item.file_path);
        if (item.fingerprint?.sha256 && item.fingerprint.sha256 !== fingerprint.sha256) { discardPersistentStage(id); repository.invalidate(id, isoNow()); }
        const result = await runDataWorkFn({ projectRoot, installationRoot, filePath: item.file_path, expectedSha256: fingerprint.sha256, action: 'profile', sheet: item.sheet });
        repository.updateSource(id, item.source_key, { fingerprint, profile: result, processorVersion: result.processor?.version ?? null, status: result.status === 'sheet_required' ? 'sheet_required' : 'ready', errorMessage: null }, isoNow());
      } catch (error) {
        repository.setSourceStatus(id, item.source_key, 'failed', String(error?.message ?? error).slice(0, 300), isoNow());
      }
    }
    if (baseRevision != null) assertRevision(id, baseRevision);
    return persistentSession(id);
  };
  const selectSourceSheet = (id, sourceKey, sheet, { baseRevision = null } = {}) => { assertRevision(id, baseRevision); discardPersistentStage(id); return persistentSession(repository.setSheet(id, sourceKey, String(sheet ?? ''), isoNow(), baseRevision).session_id); };
  const confirmMapping = (id, mapping, { baseRevision = null } = {}) => {
    assertRevision(id, baseRevision);
    const value = persistentSession(id);
    if (!value) throw new Error('This Work Session is unavailable.');
    const normalized = (mapping ?? []).map((item) => {
      const source = value.sources.find((entry) => entry.source_key === String(item.source_key ?? ''));
      return { source_key: String(item.source_key ?? ''), column: String(item.column ?? ''), canonical: String(item.canonical ?? '').trim(), source_sha256: source?.fingerprint?.sha256 ?? null, source_sheet: source?.sheet ?? null };
    });
    if (!completeMapping(value, normalized)) throw new Error('Confirm exactly one result field for every prepared Source field.');
    discardPersistentStage(id); return persistentSession(repository.setMapping(id, normalized, isoNow(), baseRevision).session_id);
  };
  const canonicalFields = (value) => [...new Set(value.sources.flatMap((item) => (item.profile?.profile?.fields ?? []).map((field) => value.mapping.find((entry) => entry.source_key === item.source_key && entry.column === field.name)?.canonical ?? field.name)))];
  const updateRecipe = (id, input = {}, { baseRevision = null } = {}) => {
    assertRevision(id, baseRevision);
    const value = persistentSession(id);
    if (!value) throw new Error('This Work Session is unavailable.');
    const fields = canonicalFields(value);
    const field = (name, label) => { const normalized = String(name ?? '').trim(); if (normalized && !fields.includes(normalized)) throw new Error(`${label} must use one aligned field.`); return normalized; };
    const combineOperation = input.combine === 'join' ? 'join' : 'concatenate';
    if (combineOperation === 'join' && value.sources.length !== 2) throw new Error('The first join version requires exactly two Sources.');
    let combine = { operation: 'concatenate' };
    if (combineOperation === 'join') {
      const leftKey = field(input.left_key, 'Left join key'); const rightKey = field(input.right_key, 'Right join key');
      const sourceFields = value.sources.map((item) => new Set((item.profile?.profile?.fields ?? []).map((profileField) => value.mapping.find((entry) => entry.source_key === item.source_key && entry.column === profileField.name)?.canonical ?? profileField.name)));
      if (!sourceFields[0]?.has(leftKey) || !sourceFields[1]?.has(rightKey)) throw new Error('Choose a join key available in its corresponding Source.');
      combine = { operation: 'join', how: input.join_how === 'left' ? 'left' : 'inner', left_key: leftKey, right_key: rightKey };
    }
    const steps = [];
    const sourceColumn = input.source_column === true ? String(input.source_column_name ?? '').trim() || '__source' : null;
    if (sourceColumn && fields.includes(sourceColumn)) throw new Error('The Source column must use a new field name.');
    if (sourceColumn) steps.push({ operation: 'source-column', column: sourceColumn });
    if (input.cast_column) steps.push({ operation: 'cast', column: field(input.cast_column, 'Cast field'), type: ['text', 'number', 'date', 'boolean'].includes(input.cast_type) ? input.cast_type : 'text' });
    if (input.filter_column) {
      const operator = ['equals', 'not_equals', 'contains', 'not_contains', '=', '!=', '>', '>=', '<', '<=', 'is_empty', 'not_empty'].includes(input.filter_operator) ? input.filter_operator : 'equals';
      steps.push({ operation: 'filter', column: field(input.filter_column, 'Filter field'), operator, value: operator.includes('empty') ? null : String(input.filter_value ?? '') });
    }
    if (input.fill_column) steps.push({ operation: 'fill-null', column: field(input.fill_column, 'Fill-null field'), value: String(input.fill_value ?? '') });
    const selected = [...new Set((input.select_columns ?? []).map((item) => field(item, 'Selected field')).filter(Boolean))];
    if (selected.length && selected.length !== fields.length) steps.push({ operation: 'select', columns: selected });
    const deduplicate = [...new Set(String(input.deduplicate_columns ?? '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => field(item, 'Deduplicate field')))];
    if (deduplicate.length) steps.push({ operation: 'deduplicate', columns: deduplicate });
    if (input.sort_column) steps.push({ operation: 'sort', column: field(input.sort_column, 'Sort field'), direction: input.sort_direction === 'desc' ? 'desc' : 'asc' });
    if (input.rename_column) {
      const from = field(input.rename_column, 'Rename field'); const to = String(input.rename_to ?? '').trim();
      if (!to) throw new Error('Enter the renamed field.');
      if (to !== from && (fields.includes(to) || to === sourceColumn)) throw new Error('The renamed field must not duplicate another result field.');
      steps.push({ operation: 'rename', from, to });
    }
    steps.push({ operation: 'validate' });
    discardPersistentStage(id);
    return persistentSession(repository.setRecipe(id, { schema: 'atlas.table-recipe.v1', version: Number(value.recipe?.version ?? 0) + 1, combine, steps }, isoNow(), baseRevision).session_id);
  };
  const executePersistent = async (id, action, extension = '.csv', { baseRevision = null } = {}) => {
    let value = await validateSources(id);
    if (baseRevision != null) {
      assertRevision(id, baseRevision);
      value = persistentSession(id);
    }
    if (!value?.sources.length) throw new Error('Choose at least one Source.');
    const blocked = value.sources.filter((item) => item.status !== 'ready');
    if (blocked.length) throw stateConflict(`Refresh all Sources before execution: ${blocked.map((item) => item.name).join(', ')}.`);
    const fieldCount = value.sources.reduce((total, item) => total + (item.profile?.profile?.fields?.length ?? 0), 0);
    if (value.mapping.length !== fieldCount || !completeMapping(value)) throw new Error('Confirm field alignment before Preview.');
    const requestPath = path.join(path.resolve(stateDir), 'tmp', 'work', `${id}-r${value.revision}.json`);
    fs.mkdirSync(path.dirname(requestPath), { recursive: true });
    const sources = value.sources.map((item) => ({ source_key: item.source_key, resource_id: item.resource_id, path: item.file_path, name: item.name, sheet: item.sheet, sha256: item.fingerprint.sha256 }));
    fs.writeFileSync(requestPath, JSON.stringify({ sources, mapping: value.mapping, recipe: value.recipe, page_size: 50 }), 'utf8');
    let outputPath = null;
    if (action === 'export') {
      const normalized = extension === '.xlsx' ? '.xlsx' : '.csv';
      outputPath = path.join(path.resolve(stateDir), 'tmp', 'work', `${id}-r${value.revision}-${crypto.randomUUID()}${normalized}`);
    }
    const primary = sources[0];
    const result = await runDataWorkFn({ projectRoot, installationRoot, filePath: primary.path, expectedSha256: primary.sha256, action, sheet: primary.sheet, requestPath, outputPath });
    for (const item of sources) {
      const current = await fingerprintFn(item.path);
      if (current.sha256 !== item.sha256) { const error = new Error(`Source changed while Atlas was executing this Recipe: ${item.name}`); error.code = 'ATLAS_STATE_CONFLICT'; throw error; }
    }
    assertRevision(id, value.revision);
    if (action === 'preview') {
      repository.setPreview(id, result, value.revision, isoNow());
      return persistentSession(id);
    }
    persistentStages.set(id, { stage_id: `STG-${crypto.randomUUID()}`, revision: value.revision, extension: path.extname(outputPath).toLowerCase(), path: outputPath, staged: result.staged, result });
    return persistentStages.get(id);
  };
  const previewPersistent = (id, options = {}) => executePersistent(id, 'preview', '.csv', options);
  const stagePersistent = (id, extension, options = {}) => executePersistent(id, 'export', extension, options);
  const persistentStage = (id) => persistentStages.get(id) ?? null;
  const clearPersistentStage = (id) => discardPersistentStage(id);
  const recordSave = (id, saveId) => persistentSession(repository.setLatestSave(id, saveId, isoNow()).session_id);
  const sessions = new Map();
  const legacySession = (id) => {
    const value = sessions.get(id);
    const activeAt = now();
    if (!value || activeAt - (value.last_active_at ?? value.created_at) > SESSION_AGE_MS) { cleanup(id); return null; }
    value.last_active_at = activeAt;
    return value;
  };
  const session = (id) => repository?.byId(id) ? persistentSession(id) : legacySession(id);
  const cleanup = (id) => { const value = sessions.get(id); if (value?.staged_path) fs.rmSync(value.staged_path, { force: true }); if (value?.request_path) fs.rmSync(value.request_path, { force: true }); sessions.delete(id); };
  const invalidateStage = (value) => { if (value.staged_path) fs.rmSync(value.staged_path, { force: true }); value.staged_path = null; value.staged = null; };
  const expire = () => { for (const [id, value] of sessions) if (now() - (value.last_active_at ?? value.created_at) > SESSION_AGE_MS) cleanup(id); };
  const invoke = async (value, action, { page = 0, exportStage = false } = {}) => {
    const requestPath = path.join(path.resolve(stateDir), 'tmp', 'data-work', `${value.session_id}.json`);
    fs.mkdirSync(path.dirname(requestPath), { recursive: true });
    fs.writeFileSync(requestPath, JSON.stringify({ operations: value.operations, page, page_size: 50 }), 'utf8');
    value.request_path = requestPath;
    if (exportStage) {
      const extension = path.extname(value.file_path).toLowerCase();
      const staged = path.join(path.resolve(stateDir), 'tmp', 'data-work', `${value.session_id}-${crypto.randomUUID()}${extension}`);
      const result = await runDataWorkFn({ projectRoot, installationRoot, filePath: value.file_path, expectedSha256: value.source_fingerprint.sha256, action: 'export', sheet: value.sheet, requestPath, outputPath: staged });
      value.staged_path = staged; value.staged = result.staged; value.preview = result; return result;
    }
    const result = await runDataWorkFn({ projectRoot, installationRoot, filePath: value.file_path, expectedSha256: value.source_fingerprint.sha256, action, sheet: value.sheet, requestPath });
    value.preview = result;
    value.column_types = result.column_types;
    // Result columns change as the user shapes the output.  The selectable set must
    // remain the complete source column list so an excluded column can be restored.
    if (!value.available_columns) value.available_columns = Object.keys(result.column_types ?? {});
    return result;
  };
  const begin = async ({ filePath, project = null, knownSheets = null }) => {
    const resolved = contentFilePath(filePath); if (!dataFile(resolved)) throw new Error('Data Work currently supports CSV and XLSX files.');
    const startedAt = now();
    const value = { session_id: `DWT-${crypto.randomBytes(16).toString('hex')}`, created_at: startedAt, last_active_at: startedAt, file_path: resolved, source_fingerprint: await fingerprintFn(resolved), project, sheet: null, sheets: Array.isArray(knownSheets) ? knownSheets.map((item) => typeof item === 'string' ? { name: item, rows: null } : item) : null, operations: { search: null, filters: [], sort: null, columns: null, remove_empty_rows: false, remove_duplicates: false }, preview: null, staged_path: null, staged: null };
    if (path.extname(resolved).toLowerCase() === '.csv') { await invoke(value, 'preview'); } else if (!value.sheets?.length) { value.sheets = (await runDataWorkFn({ projectRoot, installationRoot, filePath: resolved, expectedSha256: value.source_fingerprint.sha256, action: 'describe' })).sheets; }
    sessions.set(value.session_id, value); return value;
  };
  const selectSheet = async (id, sheet) => { const value = session(id); if (!value) throw new Error('This Data Work session is no longer available.'); if (!value.sheets?.some((item) => item.name === sheet)) throw new Error('Choose one workbook sheet.'); value.sheet = sheet; await invoke(value, 'preview'); invalidateStage(value); return value; };
  const change = async (id, action, input = {}) => {
    const value = session(id); if (!value) throw new Error('This Data Work session is no longer available.'); if (!value.preview) throw new Error('Choose a sheet first.');
    const columns = value.available_columns ?? value.preview.columns;
    const previousOperations = structuredClone(value.operations);
    const previousPreview = value.preview;
    const previousColumnTypes = value.column_types;
    try {
      if (action === 'search') value.operations.search = String(input.search ?? '').trim() || null;
      if (action === 'add_filter') value.operations.filters.push(normalizeFilter(input, columns, value.column_types ?? {}));
      if (action === 'remove_filter') value.operations.filters = value.operations.filters.filter((item) => item.id !== input.filter_id);
      if (action === 'sort') value.operations.sort = input.column ? { column: input.column, direction: input.direction === 'desc' ? 'desc' : 'asc' } : null;
      if (action === 'columns') {
        value.operations.columns = input.column_mode === 'all'
          ? [...columns]
          : (input.column_mode === 'clear' ? [] : normalizeColumns(input.columns, columns));
      }
      if (action === 'clean') { value.operations.remove_empty_rows = input.remove_empty_rows === true; value.operations.remove_duplicates = input.remove_duplicates === true; }
      if (value.operations.columns?.length !== 0) await invoke(value, 'preview');
      invalidateStage(value);
      return value;
    } catch (error) {
      value.operations = previousOperations;
      value.preview = previousPreview;
      value.column_types = previousColumnTypes;
      throw error;
    }
  };
  const page = async (id, value) => { const item = session(id); if (!item) throw new Error('This Data Work session is no longer available.'); await invoke(item, 'preview', { page: Number(value) || 0 }); return item; };
  const stage = async (id) => { const value = session(id); if (!value) throw new Error('This Data Work session is no longer available.'); if (value.staged_path && value.staged && fs.existsSync(value.staged_path)) return value.preview; return invoke(value, 'export', { exportStage: true }); };
  const clearStage = (id) => { const value = session(id); if (!value) return; invalidateStage(value); };
  const attachProject = (id, project) => { const value = session(id); if (!value) return null; value.project = project; return value; };
  return { projectSession, createProjectSession, currentProjectSession, openProjectSessions, discoverProjectSessions, assertRevision, replaceSources, addSource, removeSource, validateSources, prepareSources, selectSourceSheet, confirmMapping, updateRecipe, previewPersistent, stagePersistent, persistentStage, clearPersistentStage, recordSave, begin, session, selectSheet, change, page, stage, clearStage, attachProject, cleanup, expire };
}
