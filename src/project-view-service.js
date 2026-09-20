import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Registry } from './registry.js';
import { ResourceControl } from './resource-control.js';
import { projectDirectory, projectPath } from './ui/project-files.js';

const MODES = new Set(['files', 'table', 'cards']);
const PROPERTY_KINDS = new Set(['text', 'single', 'multi']);
const MULTI_OPERATIONS = new Set(['add', 'remove', 'replace']);
const TECHNICAL_DIRECTORIES = new Set([
  '.atlas', '.cache', '.codex', '.git', '.npm-cache', '.playwright-cli', '.pytest_cache', '.venv',
  '.tmp', '__pycache__', 'node_modules', 'venv',
]);
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
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

function pageSize(value) {
  const parsed = Number(value ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new Error(`View page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return parsed;
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
  constructor({ stateDir, registry = null }) {
    this.registry = registry ?? new Registry({ stateDir });
    this.ownsRegistry = registry == null;
    this.ledger = this.registry.ledger;
    this.repository = this.ledger.projectViews;
    this.resources = new ResourceControl({ stateDir, ledger: this.ledger });
    this.disposed = false;
  }

  #project(projectId) {
    const project = this.#activeProject(projectId);
    const location = this.registry.show(projectId).location;
    return { project: { id: project.id, name: project.name }, root: projectDirectory(location) };
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

  submitPropertyCandidates({ projectId, viewId = null, resourceIds = [], propertyId = null, property = null, candidates, caller }) {
    this.#project(projectId);
    if (!caller?.tool || !caller?.model || !caller?.client_run_id) throw new Error('Property suggestions require Host tool, model, and client run metadata.');
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
    return this.repository.createCandidateBatch({
      projectId, viewId, scope: viewId ? { kind: 'view', view_id: viewId } : { kind: 'resources', resource_ids: explicit },
      propertyId: definition.property_id,
      host: { tool: caller.tool, model: caller.model ?? null, client_run_id: caller.client_run_id },
      candidates: prepared, at: timestamp(),
    });
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
    return { ...item, stored_status: item.status, status: stale ? 'needs_review' : item.status,
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
    return { ...batch, candidates: batch.candidates.map((item) => this.#candidateFeedback(item)) };
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

  evaluateView({ viewId, limit = DEFAULT_PAGE_SIZE, continuation = null }) {
    const view = this.repository.viewById(viewId);
    if (!view) throw new Error('Saved View is unavailable.');
    return this.#evaluate({ projectId: view.project_id, view, config: view.config, limit, continuation, kind: 'view' });
  }

  evaluateConfiguration({ projectId, config = {}, limit = DEFAULT_PAGE_SIZE, continuation = null }) {
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
    if (this.ownsRegistry) this.registry.dispose();
  }
}

export function createProjectViewService(options) {
  return new ProjectViewService(options);
}
