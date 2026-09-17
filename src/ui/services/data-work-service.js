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
export function createDataWorkService({
  stateDir,
  projectRoot,
  installationRoot,
  runDataWorkFn = (args) => runUiContentOperation('data-work', args),
  fingerprintFn = (filePath) => runUiContentOperation('fingerprint', { filePath }),
  now = () => Date.now(),
}) {
  const sessions = new Map();
  const session = (id) => {
    const value = sessions.get(id);
    const activeAt = now();
    if (!value || activeAt - (value.last_active_at ?? value.created_at) > SESSION_AGE_MS) { cleanup(id); return null; }
    value.last_active_at = activeAt;
    return value;
  };
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
  return { begin, session, selectSheet, change, page, stage, clearStage, attachProject, cleanup, expire };
}
