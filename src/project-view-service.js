import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Registry } from './registry.js';
import { ResourceControl } from './resource-control.js';
import { createContentLocationService } from './content-location-service.js';
import { normalizeSearchTerms } from './catalog.js';
import { withStateLock } from './state-lock.js';
import { projectDirectory, projectPath } from './ui/project-files.js';

const MODES = new Set(['files', 'table', 'cards']);
const CSV_ROW_SHEET = '__ATLAS_CSV_SINGLE_TABLE_V1_RESERVED__';
const PROPERTY_KINDS = new Set(['text', 'single', 'multi']);
const INDEXED_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const MULTI_OPERATIONS = new Set(['add', 'remove', 'replace']);
const TECHNICAL_DIRECTORIES = new Set([
  '.atlas', '.cache', '.codex', '.git', '.npm-cache', '.playwright-cli', '.pytest_cache', '.venv',
  '.tmp', '__pycache__', 'node_modules', 'venv',
]);
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const REGISTERED_DEFAULT_PAGE_SIZE = 20;
const REGISTERED_MAX_PAGE_SIZE = 100;
const MAX_SCAN_ENTRIES = 5000;

const timestamp = () => new Date().toISOString();
const portable = (value) => String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function stateChanged(message, details = {}) {
  const error = new Error(message);
  error.code = 'ATLAS_EVALUATION_CHANGED';
  error.details = details;
  return error;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim().normalize('NFC');
}

function exactRowKeyText(value, label, { allowWhitespaceOnly = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1200
    || (!allowWhitespaceOnly && !value.trim())) throw new Error(`${label} must be an exact bounded string.`);
  return value;
}

function pageSize(value) {
  const parsed = Number(value ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new Error(`View page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return parsed;
}

function registeredPageSize(value) {
  const parsed = Number(value ?? REGISTERED_DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > REGISTERED_MAX_PAGE_SIZE) {
    throw new Error(`Registered Resource page size must be between 1 and ${REGISTERED_MAX_PAGE_SIZE}.`);
  }
  return parsed;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeExtensions(values = []) {
  if (!Array.isArray(values)) throw new Error('View extensions must be an array.');
  return [...new Set(values.map((value) => {
    const extension = String(value).trim().toLowerCase();
    const normalized = extension && !extension.startsWith('.') ? `.${extension}` : extension;
    if (!/^\.[a-z0-9]+$/u.test(normalized)) throw new Error(`Unsupported View extension: ${value}`);
    return normalized;
  }))].sort();
}

function normalizeConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Saved View config must be an object.');
  const scope = config.scope ?? {};
  const scopePath = portable(scope.path ?? config.scope_path ?? '');
  if (scopePath === '..' || scopePath.startsWith('../') || path.posix.isAbsolute(scopePath)) {
    throw new Error('Saved View scope must remain inside its Project.');
  }
  const filters = Array.isArray(config.filters) ? config.filters.map((filter) => ({
    field: requiredText(filter?.field, 'View filter field'),
    operator: requiredText(filter?.operator, 'View filter operator').toLowerCase(),
    value: filter?.value ?? null,
  })) : [];
  if (filters.length > 20) throw new Error('A Saved View supports at most 20 filters.');
  const sort = Array.isArray(config.sort) ? config.sort.map((item) => ({
    field: requiredText(item?.field, 'View sort field'),
    direction: String(item?.direction ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
  })) : [];
  if (sort.length > 3) throw new Error('A Saved View supports at most 3 sort fields.');
  if (config.membership != null && config.membership !== 'registered_local') {
    throw new Error(`Unsupported Saved View membership: ${config.membership}`);
  }
  let fulltext;
  if (config.fulltext != null) {
    if (config.membership !== 'registered_local') throw new Error('Catalog fulltext requires registered_local membership.');
    const terms = normalizeSearchTerms(config.fulltext.terms ?? []);
    if (!terms.length || (config.fulltext.match != null && config.fulltext.match !== 'any')) {
      throw new Error('Catalog fulltext requires terms and supports match="any" only.');
    }
    fulltext = { terms, match: 'any' };
  }
  return {
    scope: {
      path: scopePath,
      recursive: scope.recursive !== false,
      extensions: normalizeExtensions(scope.extensions ?? config.extensions ?? []),
    },
    filters,
    sort,
    group_by: config.group_by == null ? null : String(config.group_by),
    visible_fields: Array.isArray(config.visible_fields) ? [...new Set(config.visible_fields.map(String))] : [],
    ...(config.membership === 'registered_local' ? { membership: 'registered_local' } : {}),
    ...(fulltext ? { fulltext } : {}),
  };
}

function encodeContinuation(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `atlas-view-v1.${body}.${digest(payload).slice(0, 24)}`;
}

function decodeContinuation(value) {
  const [prefix, body, checksum, ...rest] = String(value ?? '').split('.');
  if (prefix !== 'atlas-view-v1' || !body || !checksum || rest.length) throw new Error('View continuation is invalid.');
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('View continuation is invalid.'); }
  if (digest(payload).slice(0, 24) !== checksum) throw new Error('View continuation is invalid.');
  return payload;
}

function enumerate(root, config) {
  const scopeRoot = projectPath(root, config.scope.path);
  const queue = [scopeRoot];
  const items = [];
  const failedScopes = [];
  const uncheckedScopes = [];
  let observed = 0;
  while (queue.length) {
    const directory = queue.shift();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) {
      failedScopes.push({ path: portable(path.relative(root, directory)), error: error.message });
      continue;
    }
    for (let index = 0; index < entries.length; index += 1) {
      if (observed >= MAX_SCAN_ENTRIES) {
        uncheckedScopes.push(portable(path.relative(root, directory)) || '.');
        for (const pending of queue) uncheckedScopes.push(portable(path.relative(root, pending)) || '.');
        queue.length = 0;
        break;
      }
      const dirent = entries[index];
      if (dirent.isDirectory() && TECHNICAL_DIRECTORIES.has(dirent.name.toLowerCase())) continue;
      observed += 1;
      const absolute = path.join(directory, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (config.scope.recursive) queue.push(absolute);
        continue;
      }
      if (!dirent.isFile()) continue;
      const extension = path.extname(dirent.name).toLowerCase();
      if (config.scope.extensions.length && !config.scope.extensions.includes(extension)) continue;
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      items.push({
        absolute_path: absolute,
        relative_path: portable(path.relative(root, absolute)),
        name: dirent.name,
        extension,
        bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
      });
    }
  }
  return {
    items,
    observed_entries: observed,
    unchecked_scopes: [...new Set(uncheckedScopes)],
    failed_scopes: failedScopes,
  };
}

function fieldValue(member, field) {
  if (field.startsWith('property:')) return member.properties[field.slice('property:'.length)]?.value ?? null;
  if (field === 'type') return member.extension.replace(/^\./u, '');
  return member[field] ?? null;
}

function matchesFilter(member, filter) {
  const actual = fieldValue(member, filter.field);
  if (filter.operator === 'is_empty') return actual == null || actual === '' || (Array.isArray(actual) && actual.length === 0);
  if (filter.operator === 'equals') {
    if (filter.field === 'extension') return String(actual ?? '').replace(/^\./u, '').toLowerCase() === String(filter.value ?? '').replace(/^\./u, '').toLowerCase();
    return Array.isArray(actual) ? actual.includes(filter.value) : String(actual ?? '') === String(filter.value ?? '');
  }
  if (filter.operator === 'contains') return String(actual ?? '').toLowerCase().includes(String(filter.value ?? '').toLowerCase());
  if (filter.operator === 'includes') return Array.isArray(actual) && actual.includes(filter.value);
  throw new Error(`Unsupported View filter operator: ${filter.operator}`);
}

function compareValues(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function candidateValue(property, value) {
  if (property.kind === 'text') return String(value ?? '');
  if (property.kind === 'single') {
    const normalized = requiredText(value, 'Single-select value');
    if (!property.options.includes(normalized)) throw new Error('Single-select value is not an allowed option.');
    return normalized;
  }
  const normalized = [...new Set((Array.isArray(value) ? value : String(value ?? '').split(',')).map((item) => requiredText(item, 'Multi-select value')))];
  if (normalized.some((item) => !property.options.includes(item))) throw new Error('Multi-select value contains an unsupported option.');
  return normalized;
}

export class ProjectViewService {
  constructor({ stateDir, registry = null, pythonPath = null, pythonSourceRoot = null, installationRoot = null }) {
    this.stateDir = path.resolve(stateDir);
    this.registry = registry ?? new Registry({ stateDir });
    this.ownsRegistry = registry == null;
    this.ledger = this.registry.ledger;
    this.repository = this.ledger.projectViews;
    this.resources = new ResourceControl({ stateDir, ledger: this.ledger });
    this.contentLocations = createContentLocationService({ registry: this.registry, resourceControl: this.resources,
      pythonPath, ...(pythonSourceRoot ? { pythonSourceRoot } : {}), installationRoot });
    this.disposed = false;
  }

  #project(projectId) {
    const project = this.#activeProject(projectId);
    const location = this.registry.show(projectId).location;
    return { project: { id: project.id, name: project.name }, root: projectDirectory(location), location };
  }

  #activeProject(projectId) {
    const project = this.registry.list().find((item) => item.id === projectId && item.status === 'active');
    if (!project) throw new Error('The selected Project is not available.');
    return project;
  }

  saveView({ projectId, viewId = null, name, mode = 'files', config = {}, baseRevision = null }) {
    this.#project(projectId);
    const normalizedMode = String(mode).toLowerCase();
    if (!MODES.has(normalizedMode)) throw new Error('Saved View mode must be files, table, or cards.');
    return this.repository.saveView({
      projectId,
      viewId,
      name: requiredText(name, 'Saved View name'),
      mode: normalizedMode,
      config: normalizeConfig(config),
      baseRevision,
      at: timestamp(),
    });
  }

  listViews(projectId) {
    this.#activeProject(projectId);
    return {
      project_id: projectId,
      views: this.repository.listViews(projectId),
      host_access: 'read_write_views_and_submit_bounded_candidates',
      semantic_property_write: 'candidate_preview_with_user_decision',
    };
  }

  defineProperty({ projectId, name, kind, options = [] }) {
    this.#project(projectId);
    const normalizedKind = String(kind).toLowerCase();
    if (!PROPERTY_KINDS.has(normalizedKind)) throw new Error('Property kind must be text, single, or multi.');
    const normalizedOptions = normalizedKind === 'text' ? [] : [...new Set((Array.isArray(options) ? options : []).map((value) => requiredText(value, 'Property option')))];
    if (normalizedKind !== 'text' && !normalizedOptions.length) throw new Error('Single and multi properties require at least one option.');
    return this.repository.defineProperty({
      projectId,
      name: requiredText(name, 'Property name'),
      kind: normalizedKind,
      options: normalizedOptions,
      at: timestamp(),
    });
  }

  listProperties(projectId) {
    this.#activeProject(projectId);
    return this.repository.listProperties(projectId);
  }

  submitPropertyCandidates({ projectId, viewId = null, resourceIds = [], propertyId = null, property = null, promptVersion = null, candidates, caller }) {
    this.#project(projectId);
    if (!caller?.tool || !caller?.model || !caller?.client_run_id) throw new Error('Property suggestions require Host tool, model, and client run metadata.');
    if (promptVersion != null && (typeof promptVersion !== 'string' || !promptVersion.trim() || promptVersion.length > 120)) {
      throw new Error('Property suggestion prompt version must be non-empty and at most 120 characters.');
    }
    const normalizedPromptVersion = promptVersion == null ? null : promptVersion.trim();
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 10) throw new Error('Property suggestion Preview requires 1 to 10 candidates.');
    let definition = propertyId ? this.repository.propertyById(propertyId) : null;
    if (!definition && property) {
      definition = this.repository.listProperties(projectId).find((item) => item.name === String(property.name ?? '').trim())
        ?? this.defineProperty({ projectId, name: property.name, kind: property.kind, options: property.options ?? [] });
    }
    if (!definition || definition.project_id !== projectId) throw new Error('Property suggestion requires a property in this Project.');
    if (viewId && resourceIds.length) throw new Error('Property suggestion scope must use one Saved View or explicit Resource IDs, not both.');
    const explicit = [...new Set(resourceIds.map(String))];
    if (!viewId && !explicit.length) throw new Error('Property suggestion scope requires a Saved View or explicit Resource IDs.');
    const candidateIds = candidates.map((item) => String(item?.resource_id ?? ''));
    if (candidateIds.some((id) => !id) || new Set(candidateIds).size !== candidateIds.length) throw new Error('Property suggestion candidates require unique Resource IDs.');
    let allowed;
    if (viewId) {
      const view = this.repository.viewById(viewId);
      if (!view || view.project_id !== projectId) throw new Error('Saved View is unavailable in this Project.');
      allowed = new Set(); let continuation = null;
      do {
        const page = this.evaluateView({ viewId, limit: MAX_PAGE_SIZE, continuation });
        for (const member of page.members) allowed.add(member.resource_id);
        continuation = page.continuation;
      } while (continuation && candidateIds.some((id) => !allowed.has(id)));
    } else allowed = new Set(explicit);
    if (candidateIds.some((id) => !allowed.has(id))) throw new Error('A Property suggestion Resource is outside the declared scope.');
    const prepared = candidates.map((item) => {
      const fact = this.resources.projectResource(projectId, String(item.resource_id), { refresh: true });
      const currentVersion = fact.external_change?.current?.sha256;
      if (!currentVersion || String(item.source_version ?? '') !== currentVersion) throw stateChanged('A Property suggestion Source changed before Preview was stored.', { resource_id: item.resource_id, current_source_version: currentVersion ?? null });
      const currentProperty = this.repository.value(definition.property_id, String(item.resource_id));
      const evidence = requiredText(typeof item.evidence === 'string' ? item.evidence : item.evidence?.summary, 'Property suggestion evidence');
      return { resourceId: String(item.resource_id), value: candidateValue(definition, item.value), sourceVersion: currentVersion, propertyRevision: currentProperty?.revision ?? 0, evidence };
    });
    const batch = this.repository.createCandidateBatch({
      projectId, viewId, scope: viewId ? { kind: 'view', view_id: viewId } : { kind: 'resources', resource_ids: explicit },
      propertyId: definition.property_id,
      host: { tool: caller.tool, model: caller.model ?? null, client_run_id: caller.client_run_id, prompt_version: normalizedPromptVersion },
      candidates: prepared, at: timestamp(),
    });
    return { ...batch, prompt_version: normalizedPromptVersion,
      candidates: batch.candidates.map((item) => ({ ...item, prompt_version: normalizedPromptVersion })) };
  }

  #candidateFeedback(item) {
    let currentSourceVersion = null; let sourceStatus = 'unknown';
    const basis = item.decision?.reviewed_source_version ?? item.source_version;
    try {
      const fact = this.resources.projectResource(item.project_id, item.resource_id, { refresh: true });
      currentSourceVersion = fact.external_change?.current?.sha256 ?? null;
      sourceStatus = fact.external_change?.status === 'missing' ? 'missing'
        : currentSourceVersion ? (currentSourceVersion === basis ? 'current' : 'changed') : 'unknown';
    } catch { /* An unavailable inspection is not proof that the file is missing. */ }
    const current = this.repository.value(item.property_id, item.resource_id);
    const application = this.repository.candidateApplication(item);
    const stale = item.status === 'pending' && (sourceStatus !== 'current' || (current?.revision ?? 0) !== item.property_revision);
    const applicationStatus = item.status !== 'accepted' ? 'not_applied' : !application ? 'unknown'
      : application.status === 'undone' ? 'undone'
        : current?.revision === application.revision && JSON.stringify(current.value) === JSON.stringify(application.value) ? 'current' : 'superseded';
    return { ...item, prompt_version: item.host?.prompt_version ?? null, stored_status: item.status, status: stale ? 'needs_review' : item.status,
      current_value: current ?? null, applied_value: application ? { value: application.value, revision: application.revision } : null,
      application_status: applicationStatus, source_status: sourceStatus, basis_source_version: basis,
      current_source_version: currentSourceVersion, current_property_revision: current?.revision ?? 0,
      can_accept: item.status === 'pending' && !stale,
      desktop_href: `/projects/${encodeURIComponent(item.project_id)}/resources?mode=table&resource_id=${encodeURIComponent(item.resource_id)}` };
  }

  propertyCandidateBatch({ projectId, batchId }) {
    this.#activeProject(projectId);
    const batch = this.repository.candidateBatch(projectId, requiredText(batchId, 'Property suggestion batch'));
    if (!batch) throw new Error('Property suggestion batch is unavailable in this Project.');
    return { ...batch, prompt_version: batch.host?.prompt_version ?? null,
      candidates: batch.candidates.map((item) => this.#candidateFeedback(item)) };
  }

  listPropertyCandidates(projectId, { includeDecided = false, limit = 100 } = {}) {
    this.#activeProject(projectId);
    return this.repository.listCandidates({ projectId, statuses: includeDecided ? null : ['pending'], limit })
      .map((item) => this.#candidateFeedback(item));
  }

  recentPropertyDecisions(projectId) {
    this.#activeProject(projectId);
    return this.repository.listCandidates({ projectId, statuses: ['accepted', 'rejected'], limit: 10, recentDecisions: true })
      .map((item) => this.#candidateFeedback(item));
  }

  decidePropertyCandidate({ projectId, candidateId, action, value = null, expectedRevision, expectedSourceVersion, caller }) {
    this.#project(projectId);
    if (!caller?.tool || !caller?.client_run_id) throw new Error('Property suggestion review requires caller metadata.');
    const current = this.repository.candidateById(candidateId);
    if (!current || current.project_id !== projectId) throw new Error('Property suggestion is unavailable in this Project.');
    if (String(expectedSourceVersion ?? '') !== current.source_version) throw stateChanged('Property suggestion version changed after it was opened.', { candidate_id: candidateId });
    const normalizedAction = String(action ?? '').toLowerCase();
    if (normalizedAction === 'reject') return this.repository.decideCandidate({ candidateId, expectedRevision, status: 'rejected', decision: { action: 'reject', caller }, at: timestamp() });
    if (!['accept', 'edit_accept'].includes(normalizedAction)) throw new Error('Property suggestion decision must be accept, edit_accept, or reject.');
    const fact = this.resources.projectResource(projectId, current.resource_id, { refresh: true });
    const currentSourceVersion = fact.external_change?.current?.sha256 ?? null;
    const currentPropertyRevision = this.repository.value(current.property_id, current.resource_id)?.revision ?? 0;
    if (normalizedAction === 'accept' && (currentSourceVersion !== current.source_version || currentPropertyRevision !== current.property_revision)) {
      throw stateChanged('Property suggestion needs review because its Source or current property changed.', { candidate_id: candidateId, current_source_version: currentSourceVersion, current_property_revision: currentPropertyRevision });
    }
    const property = this.repository.propertyById(current.property_id);
    const acceptedValue = candidateValue(property, normalizedAction === 'edit_accept' ? value : current.value);
    return this.repository.acceptCandidate({
      candidateId, expectedRevision, expectedPropertyRevision: currentPropertyRevision,
      value: acceptedValue,
      decision: { action: normalizedAction, caller, reviewed_source_version: currentSourceVersion }, at: timestamp(),
    });
  }

  submitRowPropertyCandidates({ projectId, propertyId, promptVersion, phase = 'preview', previewBatchId = null, candidates, caller }) {
    this.#project(projectId);
    if (!caller?.tool || !caller?.model || !caller?.client_run_id
      || [caller.tool, caller.model, caller.client_run_id].some((item) => String(item).length > 200)) throw new Error('Row property candidates require bounded Host tool, model, and client run metadata.');
    const limit = phase === 'preview' ? 10 : phase === 'batch' ? 50 : 0;
    if (!limit || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > limit) throw new Error('Row candidate Preview allows 1-10 items; batch allows 1-50.');
    const version = requiredText(promptVersion, 'Prompt version');
    if (version.length > 128) throw new Error('Prompt version exceeds its supported length.');
    const property = this.repository.propertyById(propertyId);
    if (!property || property.project_id !== projectId) throw new Error('Row property candidate requires a property in this Project.');
    const seen = new Set();
    const prepared = candidates.map((item) => {
      const resourceId = requiredText(item?.resource_id, 'Resource ID');
      const format = item?.format ?? 'xlsx';
      if (!['xlsx', 'csv'].includes(format)) throw new Error('Row candidates support only XLSX and CSV Resources.');
      if (format === 'csv' && (Object.hasOwn(item, 'sheet') || item?.row != null)) throw new Error('CSV row candidates do not accept a Sheet or row coordinate.');
      const sheet = format === 'csv' ? CSV_ROW_SHEET : requiredText(item?.sheet, 'Sheet');
      const locator = item?.key ? { kind: 'key', ...(format === 'csv' ? { format: 'csv' } : {}),
        column: format === 'csv' ? exactRowKeyText(item.key.column, 'Key column') : requiredText(item.key.column, 'Key column'),
        value: format === 'csv' ? exactRowKeyText(item.key.value, 'Key value', { allowWhitespaceOnly: true }) : requiredText(item.key.value, 'Key value') }
        : { kind: 'row', row: Number(item?.row) };
      if (format === 'xlsx' && locator.kind === 'key') locator.column = locator.column.toUpperCase();
      if (locator.kind === 'row' && (!Number.isInteger(locator.row) || locator.row < 1 || locator.row > 1048576)) throw new Error('Excel row is outside supported bounds.');
      if (format === 'csv' && locator.kind !== 'key') throw new Error('CSV row candidates require a stable unique key.');
      const unique = `${format}\0${resourceId}\0${sheet}\0${JSON.stringify(locator)}`;
      if (seen.has(unique)) throw new Error('Row property candidates must identify unique rows.'); seen.add(unique);
      const snapshot = format === 'csv'
        ? this.contentLocations.locateCsvRow({ projectId, resourceId, key: { column: locator.column, value: locator.value } })
        : this.contentLocations.locateXlsxRow({ projectId, resourceId, sheet,
          row: locator.kind === 'row' ? locator.row : null,
          key: locator.kind === 'key' ? { column: locator.column, value: locator.value } : null });
      if (typeof item.source_version !== 'string' || item.source_version !== snapshot.row_sha256) throw stateChanged('Row changed before Preview or the source row version is missing.', { resource_id: resourceId, sheet: format === 'csv' ? null : sheet });
      const evidence = item.evidence;
      if (!evidence || typeof evidence !== 'object' || typeof evidence.summary !== 'string' || !evidence.summary.trim()
        || evidence.summary.length > 1000 || !Array.isArray(evidence.cells) || evidence.cells.length > 20
        || evidence.cells.some((cell) => typeof cell !== 'string' || cell.length > 12)) throw new Error('Row evidence requires a bounded summary and cell references.');
      const rowCells = new Set(snapshot.cells.map((cell) => format === 'csv' ? cell.column : cell.cell));
      if (evidence.cells.some((cell) => !rowCells.has(format === 'csv' ? cell : cell.toUpperCase()))) throw new Error('Row evidence must reference cells in the identified row.');
      const normalizedValue = candidateValue(property, item.value);
      if (typeof normalizedValue === 'string' && normalizedValue.length > 1200) throw new Error('Row property value exceeds 1200 characters.');
      return { resourceId, sheet, locator, rowSha256: snapshot.row_sha256,
        value: normalizedValue, evidence: { summary: evidence.summary.trim(), cells: [...new Set(evidence.cells.map((cell) => format === 'csv' ? cell : cell.toUpperCase()))] } };
    });
    const host = { tool: caller.tool, model: caller.model, client_run_id: caller.client_run_id };
    const requestHash = digest({ projectId, propertyId, promptVersion: version, phase, previewBatchId, host, candidates: prepared });
    const batch = this.repository.createRowCandidateBatch({ projectId, propertyId, promptVersion: version, phase,
      previewBatchId, requestKey: caller.client_run_id, requestHash, host, candidates: prepared, at: timestamp() });
    return { ...batch, candidates: batch.candidates.map((candidate) => candidate.locator.format === 'csv'
      ? { ...candidate, sheet: null } : candidate) };
  }

  rowPropertyCandidateBatch({ projectId, batchId }) {
    this.#activeProject(projectId);
    const batch = this.repository.rowCandidateBatch(projectId, requiredText(batchId, 'Row candidate batch'));
    if (!batch) throw new Error('Row candidate batch is unavailable in this Project.');
    return { ...batch, candidates: batch.candidates.map((candidate) => {
      let current = null;
      const csv = candidate.locator.format === 'csv';
      try {
        current = csv
          ? this.contentLocations.locateCsvRow({ projectId, resourceId: candidate.resource_id,
            key: { column: candidate.locator.column, value: candidate.locator.value } })
          : this.contentLocations.locateXlsxRow({ projectId, resourceId: candidate.resource_id, sheet: candidate.sheet,
            row: candidate.locator.kind === 'row' ? candidate.locator.row : null,
            key: candidate.locator.kind === 'key' ? { column: candidate.locator.column, value: candidate.locator.value } : null });
      } catch { /* unavailable rows need review */ }
      const changed = !current || current.row_sha256 !== candidate.row_sha256;
      const acceptedStored = this.repository.acceptedRowValue({ projectId, propertyId: candidate.property_id, resourceId: candidate.resource_id,
        sheet: candidate.sheet, locator: candidate.locator });
      const accepted = acceptedStored && { ...acceptedStored, sheet: csv ? null : acceptedStored.sheet };
      return { ...candidate, sheet: csv ? null : candidate.sheet, stored_status: candidate.status, status: candidate.status === 'pending' && changed ? 'needs_review' : candidate.status,
        current_row_sha256: current?.row_sha256 ?? null, current_cells: current?.cells ?? null,
        ...(csv ? { current_record_number: current?.record_number ?? null } : {}),
        accepted_row_value: accepted, can_accept: candidate.status === 'pending' && !changed };
    }) };
  }

  listRowPropertyCandidates(projectId) {
    this.#activeProject(projectId);
    return this.repository.listRowCandidateBatches(projectId, { limit: 10 }).map((batch) => this.rowPropertyCandidateBatch({ projectId, batchId: batch.batch_id }));
  }

  decideRowPropertyCandidate({ projectId, candidateId, action, value = null, expectedRevision, expectedRowVersion = null, evidence = null, caller }) {
    this.#project(projectId);
    if (!caller?.tool || !caller?.client_run_id) throw new Error('Row property review requires caller metadata.');
    const candidate = this.repository.rowCandidateById(candidateId);
    if (!candidate || candidate.project_id !== projectId) throw new Error('Row property candidate is unavailable in this Project.');
    const normalized = String(action ?? '').toLowerCase();
    if (normalized === 'reject') {
      const rejected = this.repository.decideRowCandidate({ candidateId, expectedRevision, status: 'rejected', decision: { action: normalized, caller }, at: timestamp() });
      return { ...rejected, sheet: candidate.locator.format === 'csv' ? null : rejected.sheet };
    }
    if (!['accept', 'edit_accept'].includes(normalized)) throw new Error('Row candidate decision must be accept, edit_accept, or reject.');
    const csv = candidate.locator.format === 'csv';
    const current = csv
      ? this.contentLocations.locateCsvRow({ projectId, resourceId: candidate.resource_id,
        key: { column: candidate.locator.column, value: candidate.locator.value } })
      : this.contentLocations.locateXlsxRow({ projectId, resourceId: candidate.resource_id, sheet: candidate.sheet,
        row: candidate.locator.kind === 'row' ? candidate.locator.row : null,
        key: candidate.locator.kind === 'key' ? { column: candidate.locator.column, value: candidate.locator.value } : null });
    const unchanged = current.row_sha256 === candidate.row_sha256;
    if (normalized === 'accept' && !unchanged) throw stateChanged('The row changed; this candidate needs review.', { candidate_id: candidateId, current_row_sha256: current.row_sha256 });
    if (normalized === 'edit_accept' && !unchanged && String(expectedRowVersion ?? '') !== current.row_sha256) throw stateChanged('Edit acceptance requires the current row version.', { candidate_id: candidateId, current_row_sha256: current.row_sha256 });
    if (normalized === 'edit_accept' && !unchanged) {
      const currentReferences = new Set(current.cells.map((item) => csv ? item.column : item.cell));
      if (!evidence || typeof evidence.summary !== 'string' || !evidence.summary.trim() || evidence.summary.length > 1000
        || !Array.isArray(evidence.cells) || evidence.cells.length < 1 || evidence.cells.length > 20
        || evidence.cells.some((cell) => !currentReferences.has(csv ? String(cell) : String(cell).toUpperCase()))) {
        throw new Error('Changed-row edit acceptance requires bounded evidence from current row cells.');
      }
    }
    const property = this.repository.propertyById(candidate.property_id);
    const acceptedValue = candidateValue(property, normalized === 'edit_accept' ? value : candidate.value);
    if (typeof acceptedValue === 'string' && acceptedValue.length > 1200) throw new Error('Row property value exceeds 1200 characters.');
    const acceptedEvidence = evidence ? { summary: requiredText(evidence.summary, 'Revised row evidence'), cells: (evidence.cells ?? []).map((cell) => csv ? String(cell) : String(cell).toUpperCase()) } : candidate.evidence;
    const accepted = this.repository.decideRowCandidate({ candidateId, expectedRevision, status: 'accepted', value: acceptedValue,
      decision: { action: normalized, caller, reviewed_row_sha256: current.row_sha256, evidence: acceptedEvidence }, at: timestamp() });
    return { ...accepted, sheet: csv ? null : accepted.sheet };
  }

  applyPropertyBatch({ projectId, resourceIds, propertyId, operation = 'replace', value, expectedVersions = {} }) {
    this.#project(projectId);
    const property = this.repository.propertyById(propertyId);
    if (!property || property.project_id !== projectId) throw new Error('Property is unavailable in this Project.');
    const targets = [...new Set((Array.isArray(resourceIds) ? resourceIds : []).map(String))];
    if (!targets.length) throw new Error('Property edit requires at least one Resource.');
    if (targets.length > 500) throw new Error('A property batch supports at most 500 Resources.');
    const normalizedOperation = String(operation).toLowerCase();
    let normalizedValue;
    if (property.kind === 'text') normalizedValue = String(value ?? '');
    else if (property.kind === 'single') {
      normalizedValue = requiredText(value, 'Single-select value');
      if (!property.options.includes(normalizedValue)) throw new Error('Single-select value is not an allowed option.');
    } else {
      if (!MULTI_OPERATIONS.has(normalizedOperation)) throw new Error('Multi-select properties require add, remove, or replace.');
      normalizedValue = [...new Set((Array.isArray(value) ? value : []).map((item) => requiredText(item, 'Multi-select value')))];
      if (normalizedValue.some((item) => !property.options.includes(item))) throw new Error('Multi-select value contains an unsupported option.');
    }
    return this.repository.applyPropertyBatch({
      projectId,
      changes: targets.map((resourceId) => ({
        resourceId,
        propertyId,
        operation: property.kind === 'multi' ? normalizedOperation : 'replace',
        value: normalizedValue,
        expectedRevision: Object.hasOwn(expectedVersions, resourceId) ? expectedVersions[resourceId] : null,
      })),
      at: timestamp(),
    });
  }

  undoPropertyBatch(batchId, { projectId = null } = {}) {
    if (projectId != null) this.#project(projectId);
    return this.repository.undoPropertyBatch(batchId, timestamp(), projectId);
  }

  latestPropertyUndo(projectId) {
    this.#activeProject(projectId);
    return this.repository.latestAppliedPropertyBatch(projectId);
  }

  propertyActivity(limit = 100) {
    return this.repository.listPropertyActivity(limit).map((item) => ({
      work_id: item.batch_id,
      resource_name: `Property change · ${item.resource_count} Resource${item.resource_count === 1 ? '' : 's'}`,
      project: { id: item.project_id, name: item.project_name },
      status: 'completed',
      initiated_by: { channel: 'desktop' },
      result_summary: {
        label: item.status === 'undone'
          ? 'Property change undone'
          : `${item.property_count} propert${item.property_count === 1 ? 'y' : 'ies'} updated atomically`,
      },
      updated_at: item.undone_at ?? item.created_at,
      resource_href: `/projects/${encodeURIComponent(item.project_id)}/resources?mode=table`,
    }));
  }

  #registeredFilterPlan(projectId, config, projectRoot) {
    if (config.sort.length || config.group_by) {
      throw new Error('Registered-local Saved Views use Project path order and do not support custom sorting or grouping.');
    }
    const properties = new Map();
    let relationshipTarget = null;
    let linkedResourceTarget = null;
    for (const filter of config.filters) {
      if (filter.field.startsWith('property:')) {
        const propertyId = filter.field.slice('property:'.length);
        const definition = this.repository.propertyById(propertyId);
        if (!definition || definition.project_id !== projectId) {
          throw new Error(`Property ${propertyId} is unavailable in this Project.`);
        }
        if (filter.operator === 'equals') {
          if (filter.value == null || (typeof filter.value === 'object' && !Array.isArray(filter.value))) {
            throw new Error('Registered property equals requires a scalar value.');
          }
        } else if (filter.operator === 'date_between') {
          const range = filter.value;
          if (definition.kind !== 'text' || !range || typeof range !== 'object'
              || !validDate(range.from) || !validDate(range.to) || range.from > range.to) {
            throw new Error('Property date_between requires a text date property and a valid YYYY-MM-DD range.');
          }
        } else throw new Error(`Unsupported registered property filter operator: ${filter.operator}`);
        if (!properties.has(propertyId)) properties.set(propertyId, definition);
      } else if (filter.field === 'relationship:used_by' && filter.operator === 'equals') {
        if (relationshipTarget != null) throw new Error('A registered-local View supports one used_by target filter.');
        relationshipTarget = requiredText(filter.value, 'used_by Project ID');
        if (relationshipTarget === projectId) throw new Error('A used_by filter must target another Project.');
        this.#activeProject(relationshipTarget);
      } else if (filter.field === 'relationship:linked_to' && filter.operator === 'equals') {
        if (linkedResourceTarget != null) throw new Error('A registered-local View supports one linked_to Resource target filter.');
        linkedResourceTarget = requiredText(filter.value, 'linked_to target Resource ID');
        const target = this.ledger.resources.byId(linkedResourceTarget);
        const activeLocations = this.ledger.resources.activeLocationsForResourceInProject(linkedResourceTarget, projectId);
        if (!target || target.status !== 'active' || !activeLocations.length) {
          throw new Error('linked_to target Resource is unavailable in this Project.');
        }
        for (const item of activeLocations) {
          const relative = path.relative(projectRoot, path.resolve(item.path));
          if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error('linked_to target Resource is outside this Project Root.');
          }
        }
      } else {
        throw new Error(`Unsupported registered-local View filter: ${filter.field} ${filter.operator}`);
      }
    }
    const propertyIds = [...properties.keys()];
    return {
      propertyIds,
      propertyDefinitions: propertyIds.map((propertyId) => {
        const definition = properties.get(propertyId);
        return { property_id: propertyId, kind: definition.kind, revision: definition.revision, project_id: definition.project_id };
      }),
      relationshipTarget,
      linkedResourceTarget,
      linkedTargetFacts: linkedResourceTarget == null ? null : (() => {
        const target = this.ledger.resources.byId(linkedResourceTarget);
        const locations = this.ledger.resources.activeLocationsForResourceInProject(linkedResourceTarget, projectId);
        return {
          resource_id: target.id,
          status: target.status,
          locations: locations.map((item) => ({
            id: item.id, path: portable(path.relative(projectRoot, path.resolve(item.path))),
            status: item.status, content_hash: item.content_hash ?? null,
            bytes: item.bytes ?? null, modified_at: item.modified_at ?? null,
            valid_from: item.valid_from ?? null,
          })),
        };
      })(),
    };
  }

  #evaluateRegistered({ projectId, view = null, config, limit = null, continuation = null }) {
    const size = registeredPageSize(limit);
    const normalizedConfig = normalizeConfig(config);
    const { root, location } = this.#project(projectId);
    const plan = this.#registeredFilterPlan(projectId, normalizedConfig, root);
    const catalogGeneration = normalizedConfig.fulltext
      ? this.repository.latestCatalogGeneration(projectId)
      : null;
    const indexUnavailable = normalizedConfig.fulltext && (
      !catalogGeneration
      || catalogGeneration.status !== 'completed'
      || catalogGeneration.root_id !== location.root_id
    );
    if (indexUnavailable) {
      if (continuation) throw stateChanged('Catalog index changed or is unavailable. Restart from the first page.', { view_id: view?.view_id ?? null });
      const evaluatedAt = timestamp();
      if (view) this.repository.markEvaluated(view.view_id, evaluatedAt);
      return {
        project_id: projectId,
        ...(view ? { view: { ...view, last_evaluated_at: evaluatedAt } } : {}),
        evaluation_id: `EVAL-${crypto.randomUUID()}`,
        evaluated_at: evaluatedAt,
        membership: 'registered_local',
        scope: normalizedConfig.scope,
        completeness: 'registered_local',
        registered_local_completeness: 'registered_local',
        fulltext_index: {
          status: 'index_unavailable',
          reason: !catalogGeneration ? 'no_generation'
            : catalogGeneration.status !== 'completed' ? 'latest_generation_incomplete' : 'root_mismatch',
          generation_id: catalogGeneration?.generation_id ?? null,
          completed_at: catalogGeneration?.completed_at ?? null,
          coverage: null,
        },
        returned_count: 0,
        known_total: null,
        members: [],
        unchecked_scopes: [],
        failed_scopes: [],
        continuation: null,
        file_verification: 'not_checked',
        host_access: 'read_only',
        semantic_property_write: 'candidate_preview_with_user_decision',
      };
    }
    const scopeRoot = projectPath(root, normalizedConfig.scope.path);
    const scopePrefix = scopeRoot.endsWith(path.sep) ? scopeRoot : `${scopeRoot}${path.sep}`;
    const catalogIndex = normalizedConfig.fulltext ? {
      rootId: location.root_id,
      projectRootPath: portable(root).replace(/\/$/u, ''),
      projectRelativePrefix: `${portable(location.relative_path).replace(/\/$/u, '')}/`,
      generationId: catalogGeneration.generation_id,
      terms: normalizedConfig.fulltext.terms,
    } : null;
    const configHash = digest({
      config: normalizedConfig,
      property_definitions: plan.propertyDefinitions,
      ...(plan.linkedResourceTarget ? { linked_resource_target: plan.linkedTargetFacts } : {}),
      ...(catalogGeneration ? { catalog_generation_id: catalogGeneration.generation_id } : {}),
    });
    let offset = 0;
    let evaluationId = `EVAL-${crypto.randomUUID()}`;
    let continuationToken = null;
    if (continuation) {
      if (typeof continuation !== 'string' || continuation.length > 8192) throw new Error('Registered View continuation is invalid.');
      continuationToken = decodeContinuation(continuation);
      if (continuationToken.kind !== 'registered_local' || continuationToken.project_id !== projectId
          || continuationToken.view_id !== (view?.view_id ?? null)
          || continuationToken.view_revision !== (view?.revision ?? null)
          || continuationToken.config_hash !== configHash || continuationToken.page_size !== size) {
        throw stateChanged('Registered View evaluation changed. Restart from the first page.', {
          view_id: view?.view_id ?? null,
          current_revision: view?.revision ?? null,
        });
      }
      offset = Number(continuationToken.offset);
      evaluationId = continuationToken.evaluation_id;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Registered View continuation is invalid.');
    }

    const propertyIndex = new Map(plan.propertyIds.map((propertyId, index) => [propertyId, index]));
    const facts = crypto.createHash('sha256');
    const selected = [];
    let matchCount = 0;
    const coverage = normalizedConfig.fulltext ? {
      registered_resources: 0,
      indexed_resources: 0,
      unindexed_resources: 0,
      hash_mismatch: 0,
      unsupported_format: 0,
      truncated: 0,
    } : null;
    const rows = this.repository.iterateRegisteredLocal({
      projectId,
      scopePrefix,
      recursive: normalizedConfig.scope.recursive,
      extensions: normalizedConfig.scope.extensions,
      propertyIds: plan.propertyIds,
      relationshipTarget: plan.relationshipTarget,
      linkedResourceTarget: plan.linkedResourceTarget,
      catalogIndex,
    });
    for (const row of rows) {
      const propertyFacts = plan.propertyIds.map((propertyId, index) => [
        propertyId,
        row[`property_${index}_value_json`] ?? null,
        row[`property_${index}_revision`] ?? null,
        row[`property_${index}_updated_at`] ?? null,
      ]);
      const catalogFacts = catalogIndex ? [
        row.catalog_entry_id ?? null, row.catalog_status ?? null,
        row.catalog_project_id ?? null, row.catalog_root_id ?? null,
        row.catalog_relative_path ?? null, row.catalog_content_hash ?? null,
        row.catalog_generation_id ?? null, row.catalog_extension ?? null,
        row.catalog_parser_name ?? null, row.catalog_parser_version ?? null,
        row.catalog_indexed_bytes ?? null, row.catalog_truncated ?? null,
        row.catalog_term_match ?? null,
      ] : null;
      facts.update(JSON.stringify([
        row.resource_id, row.resource_status, row.location_id, row.path, row.display_name,
        row.content_hash, row.bytes, row.modified_at, row.location_status, row.valid_from,
        propertyFacts, row.relationship_id ?? null, row.relationship_target_id ?? null,
        row.relationship_effective_at ?? null, catalogFacts,
        row.linked_relationship_id ?? null, row.linked_relationship_status ?? null, row.linked_relationship_target_id ?? null,
        row.linked_relationship_effective_at ?? null, row.linked_last_action_id ?? null,
        row.linked_last_action_type ?? null, row.linked_last_action_created_at ?? null,
      ])).update('\n');

      let catalogMember = null;
      let catalogMatches = true;
      if (catalogIndex) {
        coverage.registered_resources += 1;
        const extension = path.extname(row.display_name).toLowerCase();
        if (!INDEXED_TEXT_EXTENSIONS.has(extension)) {
          coverage.unsupported_format += 1;
          catalogMatches = false;
        } else if (!row.catalog_entry_id || row.catalog_status !== 'active'
            || row.catalog_generation_id !== catalogGeneration.generation_id) {
          coverage.unindexed_resources += 1;
          catalogMatches = false;
        } else if (row.catalog_content_hash !== row.content_hash) {
          coverage.hash_mismatch += 1;
          catalogMatches = false;
        } else {
          coverage.indexed_resources += 1;
          if (row.catalog_truncated) coverage.truncated += 1;
          catalogMatches = Boolean(row.catalog_term_match);
          if (catalogMatches) catalogMember = {
            entry_id: row.catalog_entry_id,
            generation_id: catalogGeneration.generation_id,
            relative_path: row.catalog_relative_path,
            content_hash: row.catalog_content_hash,
            registered_content_hash: row.content_hash,
            status: row.catalog_status,
            parser: {
              name: row.catalog_parser_name,
              version: row.catalog_parser_version,
              indexed_bytes: row.catalog_indexed_bytes,
              truncated: Boolean(row.catalog_truncated),
            },
          };
        }
      }

      const properties = {};
      for (const propertyId of plan.propertyIds) {
        const index = propertyIndex.get(propertyId);
        const storedValue = row[`property_${index}_value_json`];
        if (storedValue == null) continue;
        properties[propertyId] = {
          value: JSON.parse(storedValue),
          revision: row[`property_${index}_revision`],
          updated_at: row[`property_${index}_updated_at`],
        };
      }
      const matches = normalizedConfig.filters.every((filter) => {
        if (filter.field === 'relationship:used_by') return row.relationship_id != null;
        if (filter.field === 'relationship:linked_to') return row.linked_relationship_id != null;
        const propertyId = filter.field.slice('property:'.length);
        const property = properties[propertyId];
        if (!property) return false;
        if (filter.operator === 'equals') {
          return Array.isArray(property.value)
            ? property.value.includes(filter.value)
            : String(property.value ?? '') === String(filter.value ?? '');
        }
        return validDate(property.value)
          && property.value >= filter.value.from && property.value <= filter.value.to;
      });
      if (!catalogMatches || !matches) continue;

      const relativePath = path.relative(root, row.path);
      if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error('A registered Resource location is outside its Project root.');
      }
      if (matchCount >= offset && selected.length < size + 1) {
        const location = {
          id: row.location_id,
          resource_id: row.resource_id,
          project_id: projectId,
          path: row.path,
          display_name: row.display_name,
          content_hash: row.content_hash,
          bytes: row.bytes,
          modified_at: row.modified_at,
          status: row.location_status,
          valid_from: row.valid_from,
        };
        selected.push({
          resource_id: row.resource_id,
          name: row.display_name,
          relative_path: portable(relativePath),
          extension: path.extname(row.display_name).toLowerCase(),
          resource_status: row.resource_status,
          location_id: row.location_id,
          last_known_location: location,
          content_hash: row.content_hash,
          bytes: row.bytes,
          modified_at: row.modified_at,
          properties,
          property_versions: Object.fromEntries(Object.entries(properties).map(([id, item]) => [id, item.revision])),
          relationship_id: row.relationship_id ?? null,
          relationship_ids: [row.relationship_id, row.linked_relationship_id].filter(Boolean),
          relationship: row.relationship_id ? {
            id: row.relationship_id,
            type: 'used_by',
            target_kind: 'project',
            target_id: row.relationship_target_id,
            effective_at: row.relationship_effective_at,
          } : null,
          linked_relationship_id: row.linked_relationship_id ?? null,
          linked_relationship_status: row.linked_relationship_status ?? null,
          linked_relationship_target_id: row.linked_relationship_target_id ?? null,
          linked_target: plan.linkedTargetFacts,
          linked_relationship: row.linked_relationship_id ? {
            id: row.linked_relationship_id,
            type: 'linked_to',
            status: row.linked_relationship_status,
            target_kind: 'resource',
            target_id: row.linked_relationship_target_id,
            effective_at: row.linked_relationship_effective_at,
            last_action: row.linked_last_action_id ? {
              id: row.linked_last_action_id,
              action_type: row.linked_last_action_type,
              created_at: row.linked_last_action_created_at,
            } : null,
          } : null,
          relationships: [
            ...(row.relationship_id ? [{ id: row.relationship_id, type: 'used_by', target_kind: 'project', target_id: row.relationship_target_id, effective_at: row.relationship_effective_at }] : []),
            ...(row.linked_relationship_id ? [{ id: row.linked_relationship_id, type: 'linked_to', target_kind: 'resource', target_id: row.linked_relationship_target_id, effective_at: row.linked_relationship_effective_at, last_action_id: row.linked_last_action_id }] : []),
          ],
          ...(catalogMember ? { catalog_index: catalogMember } : {}),
          file_verification: 'not_checked',
          fact_version: digest({
            resource_id: row.resource_id,
            location_id: row.location_id,
            content_hash: row.content_hash,
            modified_at: row.modified_at,
            properties: propertyFacts,
            relationship_id: row.relationship_id ?? null,
            linked_relationship_id: row.linked_relationship_id ?? null,
            linked_relationship_status: row.linked_relationship_status ?? null,
            linked_relationship_target_id: row.linked_relationship_target_id ?? null,
            linked_relationship_effective_at: row.linked_relationship_effective_at ?? null,
            linked_last_action_id: row.linked_last_action_id ?? null,
            linked_target: plan.linkedTargetFacts,
          }),
        });
      }
      matchCount += 1;
    }
    const factsWindow = digest({
      project_id: projectId,
      view_id: view?.view_id ?? null,
      view_revision: view?.revision ?? null,
      config_hash: configHash,
      catalog_generation_id: catalogGeneration?.generation_id ?? null,
      registered_facts: facts.digest('hex'),
    });
    if (continuationToken && continuationToken.facts_window !== factsWindow) {
      throw stateChanged('Registered Resource facts changed. Restart from the first page.', {
        view_id: view?.view_id ?? null,
        current_revision: view?.revision ?? null,
      });
    }
    if (offset > matchCount) throw new Error('Registered View continuation is invalid.');
    const members = selected.slice(0, size);
    const projectProperties = new Map(this.repository.listProperties(projectId).map((definition) => [definition.property_id, definition]));
    const displayPropertiesByResource = new Map(members.map((member) => [member.resource_id, {}]));
    for (const stored of this.repository.valuesForResources(members.map((member) => member.resource_id))) {
      if (!projectProperties.has(stored.property_id)) continue;
      displayPropertiesByResource.get(stored.resource_id)[stored.property_id] = {
        value: stored.value,
        revision: stored.revision,
        updated_at: stored.updated_at,
      };
    }
    const membersWithDisplayProperties = members.map((member) => ({
      ...member,
      display_properties: displayPropertiesByResource.get(member.resource_id),
    }));
    const hasMore = selected.length > size;
    const evaluatedAt = timestamp();
    const nextOffset = offset + members.length;
    const next = hasMore ? encodeContinuation({
      kind: 'registered_local',
      project_id: projectId,
      view_id: view?.view_id ?? null,
      view_revision: view?.revision ?? null,
      config_hash: configHash,
      facts_window: factsWindow,
      page_size: size,
      evaluation_id: evaluationId,
      offset: nextOffset,
    }) : null;
    if (view) this.repository.markEvaluated(view.view_id, evaluatedAt);
    return {
      project_id: projectId,
      ...(view ? { view: { ...view, last_evaluated_at: evaluatedAt } } : {}),
      evaluation_id: evaluationId,
      evaluated_at: evaluatedAt,
      membership: 'registered_local',
      scope: normalizedConfig.scope,
      completeness: 'registered_local',
      registered_local_completeness: 'registered_local',
      ...(catalogIndex ? {
        fulltext_index: {
          status: 'available',
          generation_id: catalogGeneration.generation_id,
          completed_at: catalogGeneration.completed_at,
          fingerprint: catalogGeneration.fingerprint,
          terms: normalizedConfig.fulltext.terms,
          match: normalizedConfig.fulltext.match,
          coverage,
        },
      } : {}),
      returned_count: members.length,
      known_total: matchCount,
      members: membersWithDisplayProperties,
      unchecked_scopes: [],
      failed_scopes: [],
      continuation: next,
      file_verification: 'not_checked',
      host_access: 'read_only',
      semantic_property_write: 'candidate_preview_with_user_decision',
    };
  }

  #evaluate({ projectId, view = null, config, limit, continuation = null, kind }) {
    const size = pageSize(limit);
    const normalizedConfig = normalizeConfig(config);
    let project;
    let root;
    try {
      ({ project, root } = this.#project(projectId));
    }
    catch (error) {
      if (continuation) throw stateChanged('View evaluation changed. Restart from the first page.', { view_id: view?.view_id ?? null });
      return {
        project_id: projectId,
        ...(view ? { view } : {}),
        evaluation_id: `EVAL-${crypto.randomUUID()}`,
        evaluated_at: timestamp(),
        scope: normalizedConfig.scope,
        completeness: 'unknown',
        returned_count: 0,
        known_total: null,
        members: [],
        unchecked_scopes: [normalizedConfig.scope.path || '.'],
        failed_scopes: [{ path: normalizedConfig.scope.path || '.', error: error.message }],
        continuation: null,
        host_access: 'read_only',
        semantic_property_write: 'candidate_preview_with_user_decision',
      };
    }
    let scan;
    try { scan = enumerate(root, normalizedConfig); }
    catch (error) {
      if (continuation) throw stateChanged('View evaluation changed. Restart from the first page.', { view_id: view?.view_id ?? null });
      return {
        project_id: projectId,
        ...(view ? { view } : {}),
        evaluation_id: `EVAL-${crypto.randomUUID()}`,
        evaluated_at: timestamp(),
        scope: normalizedConfig.scope,
        completeness: 'unknown',
        returned_count: 0,
        known_total: null,
        members: [],
        unchecked_scopes: [normalizedConfig.scope.path || '.'],
        failed_scopes: [{ path: normalizedConfig.scope.path || '.', error: error.message }],
        continuation: null,
      };
    }

    const identified = [];
    const identifyFailures = [...scan.failed_scopes];
    for (const file of scan.items) {
      try {
        const detail = this.resources.observe({ filePath: file.absolute_path, project });
        identified.push({ ...file, resource_id: detail.resource_id, content_hash: detail.evidence.sha256, resource_status: detail.resource.status, external_change: detail.external_change });
      } catch (error) {
        identifyFailures.push({ path: file.relative_path, error: error.message });
      }
    }
    const values = this.repository.valuesForResources(identified.map((item) => item.resource_id));
    const byResource = new Map();
    for (const item of values) {
      if (!byResource.has(item.resource_id)) byResource.set(item.resource_id, {});
      byResource.get(item.resource_id)[item.property_id] = { value: item.value, revision: item.revision };
    }
    let members = identified.map((item) => {
      const properties = byResource.get(item.resource_id) ?? {};
      return {
        ...item,
        fact_version: item.content_hash,
        properties,
        property_versions: Object.fromEntries(Object.entries(properties).map(([propertyId, stored]) => [propertyId, stored.revision])),
      };
    });
    members = members.filter((member) => normalizedConfig.filters.every((filter) => matchesFilter(member, filter)));
    const configuredSort = normalizedConfig.sort.length ? normalizedConfig.sort : [{ field: 'relative_path', direction: 'asc' }];
    const sort = normalizedConfig.group_by
      ? [{ field: normalizedConfig.group_by, direction: 'asc' }, ...configuredSort.filter((item) => item.field !== normalizedConfig.group_by)]
      : configuredSort;
    members.sort((left, right) => {
      for (const rule of sort) {
        const compared = compareValues(fieldValue(left, rule.field), fieldValue(right, rule.field));
        if (compared) return rule.direction === 'desc' ? -compared : compared;
      }
      return left.relative_path.localeCompare(right.relative_path);
    });
    const factsWindow = digest({
      project_id: projectId,
      view_id: view?.view_id ?? null,
      revision: view?.revision ?? null,
      config: normalizedConfig,
      members: members.map((item) => [item.resource_id, item.relative_path, item.content_hash, item.modified_at, item.properties]),
      unchecked: scan.unchecked_scopes,
      failed: identifyFailures,
    });
    let offset = 0;
    let evaluationId = `EVAL-${crypto.randomUUID()}`;
    if (continuation) {
      const token = decodeContinuation(continuation);
      if (token.kind !== kind || token.project_id !== projectId || token.view_id !== (view?.view_id ?? null)
        || token.view_revision !== (view?.revision ?? null) || token.config_hash !== digest(normalizedConfig)
        || token.facts_window !== factsWindow) {
        throw stateChanged('View evaluation changed. Restart from the first page.', {
          view_id: view?.view_id ?? null,
          current_revision: view?.revision ?? null,
        });
      }
      offset = Number(token.offset);
      evaluationId = token.evaluation_id;
      if (!Number.isInteger(offset) || offset < 0 || offset > members.length) throw new Error('View continuation is invalid.');
    }
    const page = members.slice(offset, offset + size);
    const nextOffset = offset + page.length;
    const morePages = nextOffset < members.length;
    const incompleteScan = scan.unchecked_scopes.length > 0 || identifyFailures.length > 0;
    const next = morePages ? encodeContinuation({
      kind,
      project_id: projectId,
      view_id: view?.view_id ?? null,
      view_revision: view?.revision ?? null,
      evaluation_id: evaluationId,
      config_hash: digest(normalizedConfig),
      facts_window: factsWindow,
      offset: nextOffset,
    }) : null;
    const evaluatedAt = timestamp();
    if (view) this.repository.markEvaluated(view.view_id, evaluatedAt);
    return {
      project_id: projectId,
      ...(view ? { view: { ...view, last_evaluated_at: evaluatedAt } } : {}),
      evaluation_id: evaluationId,
      evaluated_at: evaluatedAt,
      scope: normalizedConfig.scope,
      completeness: morePages || incompleteScan ? 'partial' : 'complete',
      returned_count: page.length,
      known_total: incompleteScan ? null : members.length,
      members: page,
      unchecked_scopes: scan.unchecked_scopes,
      failed_scopes: identifyFailures,
      continuation: next,
      host_access: 'read_only',
      semantic_property_write: 'candidate_preview_with_user_decision',
    };
  }

  evaluateView({ viewId, limit = null, continuation = null }) {
    const view = this.repository.viewById(viewId);
    if (!view) throw new Error('Saved View is unavailable.');
    if (view.config.membership === 'registered_local') {
      const evaluate = (current) => {
        if (!current) throw new Error('Saved View is unavailable.');
        if (current.config.membership === 'registered_local') {
          return this.#evaluateRegistered({ projectId: current.project_id, view: current, config: current.config, limit, continuation });
        }
        return this.#evaluate({ projectId: current.project_id, view: current, config: current.config, limit, continuation, kind: 'view' });
      };
      const current = this.repository.viewById(viewId);
      if (current?.config.membership === 'registered_local' && current.config.fulltext) {
        return withStateLock(this.stateDir, () => evaluate(this.repository.viewById(viewId)));
      }
      return evaluate(current);
    }
    return this.#evaluate({ projectId: view.project_id, view, config: view.config, limit, continuation, kind: 'view' });
  }

  evaluateConfiguration({ projectId, config = {}, limit = null, continuation = null }) {
    if (config?.membership === 'registered_local') {
      const evaluate = () => this.#evaluateRegistered({ projectId, config, limit, continuation });
      return config.fulltext ? withStateLock(this.stateDir, evaluate) : evaluate();
    }
    return this.#evaluate({ projectId, config, limit, continuation, kind: 'files' });
  }

  listProjectFiles({ projectId, scope = {}, limit = DEFAULT_PAGE_SIZE, continuation = null }) {
    return this.#evaluate({
      projectId,
      config: { scope, filters: [], sort: [{ field: 'relative_path', direction: 'asc' }] },
      limit,
      continuation,
      kind: 'files',
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resources.dispose();
    this.contentLocations.dispose();
    if (this.ownsRegistry) this.registry.dispose();
  }
}

export function createProjectViewService(options) {
  return new ProjectViewService(options);
}
