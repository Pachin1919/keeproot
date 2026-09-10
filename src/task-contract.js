import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Catalog } from './catalog.js';
import { Derived } from './derived.js';
import { Guarded } from './guarded.js';
import { Evolution } from './evolution.js';
import { Ledger, TASK_SCOPED_ENVIRONMENT_RULE_VERSION_ID } from './ledger.js';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';
import { PreferenceRules } from './preference-rules.js';
import { getArtifactRole } from './profiles.js';
import { Registry } from './registry.js';
import { captureBlob, sha256File } from './snapshots.js';
import { withStateLock } from './state-lock.js';
import { TaskContextRepository } from './storage/repositories/task-context-repository.js';

const MAX_INPUTS = 50;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_COMPARE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_LINKS = 20;
const MAX_CONTEXT_CANDIDATES = 50;
const ACTIONS = new Set(['auto', 'create', 'append', 'delta', 'new_version', 'supersede', 'delete', 'archive']);
const DATA_CLASSES = new Set(['generated_output', 'temporal_snapshot', 'append_only_data', 'human_writing']);
export const DIRECT_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.yaml', '.yml', '.xml', '.html', '.htm', '.css',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py',
  '.ps1', '.sh', '.sql', '.toml', '.ini', '.cfg', '.conf', '.log',
]);

function timestamp() {
  return new Date().toISOString();
}

function makeRunId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `TSK-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function makeClaimedWriteRunId(executor) {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  const prefix = executor === 'derived_create' ? 'DRV' : executor === 'guarded_update' ? 'GRD' : 'EVP';
  return `${prefix}-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function stateConflict(message) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  return error;
}

function contextSetupRequired({
  project,
  purpose,
  roots,
  links,
}) {
  const missing = [];
  if (!roots.length) missing.push('workspace_root');
  if (!project.location) missing.push('target_project_location');
  if (!links.length) missing.push('context_link');
  const requiredActions = [];
  if (missing.includes('workspace_root')) {
    requiredActions.push({
      action: 'root.adopt',
      for: 'source_and_target_as_needed',
      required_fields: ['path', 'type', 'content_policy'],
    });
  }
  if (missing.includes('target_project_location')) {
    requiredActions.push({
      action: 'project.attach-root',
      project_id: project.project.id,
      required_fields: ['root_id', 'reason'],
    });
  }
  if (missing.includes('context_link')) {
    requiredActions.push({
      action: 'project.link-context',
      target_project_id: project.project.id,
      required_fields: ['source_project_id', 'purpose', 'reason'],
      source_project_requires_active_location: true,
    });
  }
  const error = new Error(
    `Cross-Project context setup is incomplete for Project ${project.project.id}: ${missing.join(', ')}.`,
  );
  error.code = 'ATLAS_CONTEXT_SETUP_REQUIRED';
  error.details = {
    schema: 'atlas-context-setup.v1',
    status: 'context_setup_required',
    target_project_id: project.project.id,
    purpose,
    missing,
    required_actions: requiredActions,
    known_workspace_roots: roots.map((item) => ({
      root_id: item.id,
      current_path: item.current_path,
      root_type: item.root_type,
      content_policy: item.content_policy,
    })),
    available_context_purposes: [
      ...new Set(project.context_links.map((item) => item.purpose)),
    ].sort(),
  };
  return error;
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function assertRealPathChain(root, absolute, allowMissingLeaf = false) {
  const relative = path.relative(root, absolute);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) {
      if (allowMissingLeaf && cursor === absolute) return;
      throw new Error(`Task path does not exist: ${cursor}`);
    }
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Task paths cannot pass through symbolic links or junctions: ${cursor}`);
    }
  }
}

function normalizeExistingFile(root, value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} path is required.`);
  const lexical = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  if (!isPathInside(root, lexical) || lexical === root) throw new Error(`${label} escapes or is outside the root: ${value}`);
  assertRealPathChain(root, lexical);
  const stat = fs.lstatSync(lexical);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${lexical}`);
  const real = fs.realpathSync.native(lexical);
  if (!isPathInside(root, real)) throw new Error(`${label} resolves outside the root: ${value}`);
  return { absolute: real, path: toPortablePath(path.relative(root, real)), stat: fs.statSync(real) };
}

function normalizeTarget(root, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Task output target is required.');
  const lexical = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  if (!isPathInside(root, lexical) || lexical === root) throw new Error(`Task output target escapes or is outside the root: ${value}`);
  if (fs.existsSync(lexical)) {
    const existing = normalizeExistingFile(root, lexical, 'Task output target');
    return { ...existing, exists: true };
  }
  const parent = path.dirname(lexical);
  if (!fs.existsSync(parent)) throw new Error(`Task output parent directory does not exist: ${parent}`);
  assertRealPathChain(root, parent);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Task output parent must be a real directory: ${parent}`);
  }
  const realParent = fs.realpathSync.native(parent);
  if (!isPathInside(root, realParent)) throw new Error(`Task output resolves outside the root: ${value}`);
  const absolute = path.join(realParent, path.basename(lexical));
  return { absolute, path: toPortablePath(path.relative(root, absolute)), exists: false };
}

function normalizeCoverage(value) {
  if (value == null) return null;
  if (!value || !isValidDate(value.start) || !isValidDate(value.end) || value.start > value.end) {
    throw new Error('Task input coverage requires valid start/end dates with start <= end.');
  }
  return { start: value.start, end: value.end };
}

function rangesOverlap(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

function containsRange(container, contained) {
  return container.start <= contained.start && container.end >= contained.end;
}

function normalizedCandidate(candidateFile, root) {
  if (typeof candidateFile !== 'string' || !candidateFile.trim()) throw new Error('Task fulfillment requires a candidate file.');
  const absolute = path.resolve(candidateFile);
  if (!fs.existsSync(absolute)) throw new Error(`Task candidate does not exist: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Task candidate must be a regular non-symbolic-link file.');
  const real = fs.realpathSync.native(absolute);
  if (isPathInside(root, real)) throw new Error('Task candidate must remain outside the governed root until Atlas executes it.');
  return real;
}

function fileStartsWith(candidatePath, baselinePath, baselineSize, baselineHash) {
  const candidateSize = fs.statSync(candidatePath).size;
  if (candidateSize <= baselineSize) return false;
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(candidatePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, baselineSize)));
    let offset = 0;
    while (offset < baselineSize) {
      const length = Math.min(buffer.length, baselineSize - offset);
      const read = fs.readSync(handle, buffer, 0, length, offset);
      if (read <= 0) return false;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex') === baselineHash;
}

function relationForStrategy(strategy) {
  if (strategy === 'supersede') return 'supersedes';
  if (strategy === 'delta') return 'delta_of';
  if (strategy === 'new_version') return 'transforms';
  if (strategy === 'append') return 'appends_to';
  return 'derived_from';
}

function publicContract(taskId, contract) {
  return { task_id: taskId, ...contract };
}

function summarizeSelectedPayload(selected) {
  let textBytes = 0;
  let binaryBytes = 0;
  const requiresLocalExtraction = [];
  for (const input of selected) {
    if (DIRECT_TEXT_EXTENSIONS.has(path.extname(input.path).toLowerCase())) {
      textBytes += input.byte_size;
    } else {
      binaryBytes += input.byte_size;
      requiresLocalExtraction.push(input.path);
    }
  }
  return {
    selected_text_bytes: textBytes,
    selected_binary_bytes: binaryBytes,
    estimated_tokens: null,
    token_estimate_basis: 'unavailable_without_host_usage',
    direct_text_payload_estimate: {
      bytes: textBytes,
      approximate_tokens: Math.ceil(textBytes / 4),
      basis: 'rough_utf8_bytes_divided_by_four',
      excludes_binary_extraction: true,
      is_host_usage: false,
    },
    requires_local_extraction: requiresLocalExtraction,
  };
}

function normalizedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Task request must be an object.');
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_REQUEST_BYTES) throw new Error('Task request is too large.');
  if (typeof request.intent !== 'string' || !request.intent.trim()) throw new Error('Task intent is required.');
  if (typeof request.project_id !== 'string' || !request.project_id.trim()) throw new Error('Task project_id is required.');
  if (!Array.isArray(request.inputs) || request.inputs.length > MAX_INPUTS) {
    throw new Error(`Task inputs must be an array with at most ${MAX_INPUTS} items.`);
  }
  if (request.inputs.length === 0 && !request.discovery) {
    throw new Error('Task requires explicit inputs or bounded candidate discovery.');
  }
  if (!request.output || typeof request.output !== 'object') throw new Error('Task output is required.');
  const action = request.output.action ?? 'auto';
  const dataClass = request.output.data_class ?? 'generated_output';
  if (!ACTIONS.has(action)) throw new Error(`Unsupported Task output action: ${action}`);
  if (!DATA_CLASSES.has(dataClass)) throw new Error(`Unsupported Task data class: ${dataClass}`);
  const role = getArtifactRole(request.output.role).id;
  const maxFiles = request.budget?.max_files ?? DEFAULT_MAX_FILES;
  const maxBytes = request.budget?.max_bytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_INPUTS) throw new Error('Task budget max_files is invalid.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Task budget max_bytes is invalid.');
  let discovery = null;
  if (request.discovery != null) {
    if (!request.discovery || typeof request.discovery !== 'object' || Array.isArray(request.discovery)) {
      throw new Error('Task discovery must be an object.');
    }
    const roles = [...new Set((request.discovery.roles ?? []).map((roleId) => getArtifactRole(roleId).id))];
    const extensions = [...new Set((request.discovery.extensions ?? []).map((extension) => {
      const normalized = String(extension).trim().toLowerCase();
      if (!/^\.[a-z0-9]+$/u.test(normalized)) throw new Error(`Task discovery extension is invalid: ${extension}`);
      return normalized;
    }))];
    const modifiedAfter = request.discovery.modified_after ?? null;
    if (modifiedAfter != null && Number.isNaN(Date.parse(modifiedAfter))) {
      throw new Error('Task discovery modified_after must be an ISO date or timestamp.');
    }
    const maxCandidates = request.discovery.max_candidates ?? Math.min(DEFAULT_MAX_FILES, MAX_INPUTS);
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_INPUTS) {
      throw new Error(`Task discovery max_candidates must be between 1 and ${MAX_INPUTS}.`);
    }
    discovery = { roles, extensions, modified_after: modifiedAfter, max_candidates: maxCandidates };
  }
  return {
    intent: request.intent.trim(),
    project_id: request.project_id.trim(),
    inputs: request.inputs.map((input, ordinal) => {
      if (!input || typeof input !== 'object') throw new Error('Each Task input must be an object.');
      const temporalMode = input.temporal_mode ?? null;
      if (temporalMode != null && !['snapshot', 'segment'].includes(temporalMode)) {
        throw new Error(`Unsupported temporal_mode: ${temporalMode}`);
      }
      return {
        ordinal,
        path: input.path,
        series: typeof input.series === 'string' && input.series.trim() ? input.series.trim() : null,
        temporal_mode: temporalMode,
        coverage: normalizeCoverage(input.coverage),
        required: input.required !== false,
        priority: Number.isSafeInteger(input.priority) && input.priority >= 0 ? input.priority : 100,
      };
    }),
    budget: { max_files: maxFiles, max_bytes: maxBytes },
    discovery,
    output: {
      target: request.output.target,
      role,
      data_class: dataClass,
      action,
      base_input: request.output.base_input ?? null,
    },
  };
}

function buildTemporalRelations(inputs) {
  const relations = [];
  const excluded = new Map();
  for (let leftIndex = 0; leftIndex < inputs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < inputs.length; rightIndex += 1) {
      const left = inputs[leftIndex];
      const right = inputs[rightIndex];
      if (!left.series || left.series !== right.series) continue;
      if (left.content_hash === right.content_hash) {
        excluded.set(right.ordinal, 'duplicate_material');
        relations.push({
          type: 'duplicate_of', from: right.path, to: left.path, confidence: 1,
          evidence: { same_hash: true, content_inclusion: true },
        });
        continue;
      }
      if (!left.coverage || !right.coverage) {
        relations.push({
          type: 'coverage_unknown',
          from: right.path,
          to: left.path,
          confidence: 1,
          decision: 'preserve_both',
          evidence: {
            same_series: true,
            left_coverage_known: Boolean(left.coverage),
            right_coverage_known: Boolean(right.coverage),
          },
        });
        continue;
      }
      let container = null;
      let contained = null;
      if (containsRange(left.coverage, right.coverage)) [container, contained] = [left, right];
      else if (containsRange(right.coverage, left.coverage)) [container, contained] = [right, left];
      if (container && contained) {
        let inclusion = null;
        if (container.byte_size <= MAX_COMPARE_BYTES && contained.byte_size <= MAX_COMPARE_BYTES) {
          inclusion = fs.readFileSync(container.absolute).includes(fs.readFileSync(contained.absolute));
        }
        if (inclusion) {
          excluded.set(contained.ordinal, 'superseded_by_verified_snapshot');
          relations.push({
            type: 'supersedes', from: container.path, to: contained.path, confidence: 1,
            evidence: { same_series: true, coverage_contains: true, content_inclusion: true },
          });
        } else {
          relations.push({
            type: 'overlaps', from: container.path, to: contained.path, confidence: inclusion === false ? 0.9 : 0.7,
            evidence: { same_series: true, coverage_contains: true, content_inclusion: inclusion },
          });
        }
      } else if (rangesOverlap(left.coverage, right.coverage)) {
        relations.push({
          type: 'overlaps', from: right.path, to: left.path, confidence: 0.9,
          evidence: { same_series: true, coverage_overlap: true, content_inclusion: false },
        });
      } else if (left.temporal_mode === 'segment' && right.temporal_mode === 'segment') {
        const newer = left.coverage.start > right.coverage.start ? left : right;
        const older = newer === left ? right : left;
        relations.push({
          type: 'delta_of', from: newer.path, to: older.path, confidence: 0.95,
          evidence: { same_series: true, disjoint_segments: true },
        });
      }
    }
  }
  return { relations, excluded };
}

function chooseReadSet(inputs, temporalExcluded, budget) {
  const selected = [];
  const excluded = [];
  let bytes = 0;
  const candidates = [...inputs].sort((left, right) => (
    left.priority - right.priority
      || (right.coverage?.end ?? '').localeCompare(left.coverage?.end ?? '')
      || left.ordinal - right.ordinal
  ));
  for (const input of candidates) {
    const temporalReason = temporalExcluded.get(input.ordinal);
    if (temporalReason) {
      excluded.push({ ...input, reason: temporalReason });
    } else if (selected.length >= budget.max_files || bytes + input.byte_size > budget.max_bytes) {
      const budgetReason = input.byte_size > budget.max_bytes
        ? 'single_file_too_large'
        : selected.length >= budget.max_files
          ? 'file_count_limit'
          : 'total_byte_limit';
      excluded.push({ ...input, reason: 'read_budget', budget_reason: budgetReason });
    } else {
      selected.push({ ...input, reason: 'selected' });
      bytes += input.byte_size;
    }
  }
  selected.sort((a, b) => a.ordinal - b.ordinal);
  excluded.sort((a, b) => a.ordinal - b.ordinal);
  return { selected, excluded, bytes };
}

function chooseWrite(target, output, inputs, relations, strategyOverride = null) {
  const base = { target: target.path, role: output.role, data_class: output.data_class, scope: 'exact_target_only' };
  if (output.action === 'delete') {
    return { ...base, strategy: 'deny', executor: 'none', decision: 'deny', relation_type: null, reason: 'Task Contract V1 does not execute delete actions.' };
  }
  if (output.action === 'archive') {
    if (target.exists || !output.base_input || !inputs.some((input) => input.path === output.base_input)) {
      return { ...base, strategy: 'deny', executor: 'none', decision: 'deny', relation_type: null, reason: 'Archive requires one absent target and one selected base_input.' };
    }
    return {
      ...base,
      strategy: 'archive',
      executor: 'organization_plan',
      decision: 'warn',
      relation_type: null,
      source: output.base_input,
      reason: 'Archive is a retained move and requires one reviewed organization plan.',
    };
  }
  if (target.exists) {
    if (output.data_class === 'append_only_data' && ['auto', 'append'].includes(output.action)
        && inputs.some((input) => input.path === target.path)) {
      return { ...base, strategy: 'append', executor: 'guarded_update', decision: 'warn', relation_type: 'appends_to', reason: 'Existing append-only data requires exact Candidate review and Guarded execution.' };
    }
    return { ...base, strategy: 'deny', executor: 'none', decision: 'deny', relation_type: null, reason: 'Existing targets may only use the append-only Guarded strategy in Task Contract V1.' };
  }
  if (output.action === 'append') {
    return { ...base, strategy: 'deny', executor: 'none', decision: 'deny', relation_type: null, reason: 'Append requires an existing target included in the read set.' };
  }
  let strategy = output.action;
  if (strategy === 'auto') {
    if (strategyOverride && strategyOverride !== 'auto') strategy = strategyOverride;
    else if (output.data_class === 'temporal_snapshot' && relations.some((relation) => relation.type === 'supersedes')) strategy = 'supersede';
    else if (output.data_class === 'append_only_data') strategy = 'delta';
    else if (output.data_class === 'human_writing' && output.base_input) strategy = 'new_version';
    else strategy = 'create';
  }
  return { ...base, strategy, executor: 'derived_create', decision: 'allow', relation_type: relationForStrategy(strategy), reason: `Create one governed ${strategy} output at the exact target.` };
}

export class TaskContract {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('TaskContract requires a stateDir.');
    this.stateDir = path.resolve(stateDir);
    this._ledger = null;
    this._derived = null;
    this._guarded = null;
    this._evolution = null;
    this._rules = null;
    this._registry = null;
    this._catalog = null;
    this._taskContext = null;
    this._taskRepository = null;
  }

  get ledger() {
    if (!this._ledger) this._ledger = new Ledger(this.stateDir);
    return this._ledger;
  }

  get derived() {
    if (!this._derived) this._derived = new Derived({ stateDir: this.stateDir });
    return this._derived;
  }

  get guarded() {
    if (!this._guarded) this._guarded = new Guarded({ stateDir: this.stateDir });
    return this._guarded;
  }

  get evolution() {
    if (!this._evolution) this._evolution = new Evolution({ stateDir: this.stateDir });
    return this._evolution;
  }

  get rules() {
    if (!this._rules) this._rules = new PreferenceRules({ stateDir: this.stateDir, ledger: this.ledger });
    return this._rules;
  }

  get registry() {
    if (!this._registry) this._registry = new Registry({ stateDir: this.stateDir });
    return this._registry;
  }

  get catalog() {
    if (!this._catalog) this._catalog = new Catalog({
      stateDir: this.stateDir,
      registry: this.registry,
    });
    return this._catalog;
  }

  get taskContext() {
    if (!this._taskContext) {
      this._taskContext = new TaskContextRepository({
        db: this.ledger.db,
        transaction: (callback) => this.ledger.transaction(callback),
      });
    }
    return this._taskContext;
  }

  get taskRepository() {
    if (!this._taskRepository) this._taskRepository = this.ledger.tasks;
    return this._taskRepository;
  }

  listPendingTasks(projectId, options = {}) {
    this.ledger.getProject(projectId);
    return this.taskRepository.listPendingByProject(projectId, options);
  }

  discoverContext({
    projectId,
    purpose,
    terms = [],
    caller = {},
  }) {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      throw new Error('Cross-Project context discovery requires a target Project ID.');
    }
    if (typeof purpose !== 'string' || !purpose.trim()) {
      throw new Error('Cross-Project context discovery requires a purpose.');
    }
    if (!Array.isArray(terms) || terms.length > 12) {
      throw new Error('Cross-Project context discovery accepts at most 12 terms.');
    }
    const normalizedTerms = [...new Set(
      terms.map((item) => String(item).trim().normalize('NFC')).filter(Boolean),
    )];
    const normalizedPurpose = purpose.trim().toLowerCase().replace(/[\s-]+/gu, '_');
    const targetProject = this.registry.show(projectId);
    const roots = this.registry.listRoots();
    const links = targetProject.context_links
      .filter((item) => item.purpose === normalizedPurpose);
    if (!targetProject.location || !links.length) {
      throw contextSetupRequired({
        project: targetProject,
        purpose: normalizedPurpose,
        roots,
        links,
      });
    }
    if (links.length > MAX_CONTEXT_LINKS) {
      throw new Error(`Cross-Project context discovery accepts at most ${MAX_CONTEXT_LINKS} active links per purpose.`);
    }
    const candidates = [];
    const seen = new Set();
    const generations = [];
    for (const link of links) {
      const generation = this.catalog.update({
        projectId: link.source_project_id,
        caller,
      });
      generations.push(generation);
      const result = this.catalog.search({
        projectId: link.source_project_id,
        terms: normalizedTerms,
        extensions: link.filters.extensions,
        maxCandidates: link.filters.max_candidates,
      });
      for (const item of result.candidates) {
        if (seen.has(item.entry_id)) continue;
        seen.add(item.entry_id);
        candidates.push({
          ...item,
          context_link_id: link.link_id,
          context_purpose: link.purpose,
        });
      }
    }
    candidates.sort((left, right) => (
      (left.score ?? Number.MAX_SAFE_INTEGER) - (right.score ?? Number.MAX_SAFE_INTEGER)
      || right.modified_at.localeCompare(left.modified_at)
      || left.relative_path.localeCompare(right.relative_path)
    ));
    const boundedCandidates = candidates.slice(0, MAX_CONTEXT_CANDIDATES);
    const createdAt = timestamp();
    const candidateSet = this.taskContext.createCandidateSet({
      targetProjectId: projectId,
      purpose: links[0].purpose,
      terms: normalizedTerms,
      contextLinks: links,
      candidates: boundedCandidates,
      createdAt,
    });
    return {
      schema: 'atlas-context-candidate-set.v1',
      status: candidates.length ? 'ready' : 'empty',
      candidate_set_id: candidateSet.candidate_set_id,
      target_project_id: projectId,
      purpose: candidateSet.purpose,
      context_links: links,
      catalog_generations: generations.map((item) => ({
        generation_id: item.generation_id,
        project_id: item.project_id,
        root_id: item.root_id,
        changed_files: item.changed_files,
        reused_files: item.reused_files,
      })),
      candidates: candidateSet.candidates.map((item) => ({
        entry_id: item.entry_id,
        context_link_id: item.context_link_id,
        project_id: item.project_id,
        root_id: item.root_id,
        relative_path: item.relative_path,
        project_relative_path: item.project_relative_path,
        extension: item.extension,
        byte_size: item.byte_size,
        modified_at: item.modified_at,
        content_hash: item.content_hash,
        title: item.title,
        headings: item.headings,
        tags: item.tags,
        score: item.score,
        snippet: item.snippet,
      })),
      candidate_limit_excluded: Math.max(0, candidates.length - boundedCandidates.length),
      content_files_read: generations.reduce((sum, item) => sum + item.content_files_read, 0),
      source_changes: [],
    };
  }

  prepareContext({
    candidateSetId,
    selectedEntryIds,
    request,
    caller = {},
  }) {
    if (!request || typeof request !== 'object') throw new Error('Cross-Project Task request is required.');
    if (!Array.isArray(selectedEntryIds)) throw new Error('selectedEntryIds must be an array.');
    const targetProject = this.registry.show(request.project_id);
    if (!targetProject.location) {
      throw new Error(`Target Project has no active Workspace Root location: ${request.project_id}`);
    }
    const candidateSet = this.taskContext.getCandidateSet(candidateSetId);
    if (candidateSet.target_project_id !== request.project_id) {
      throw new Error('Task Project does not match the Context Candidate Set target Project.');
    }
    const selectedIds = [...new Set(selectedEntryIds)];
    if (!selectedIds.length) throw new Error('Source Set requires at least one selected Catalog entry.');
    const candidatesById = new Map(candidateSet.candidates.map((item) => [item.entry_id, item]));
    const activeContextLinkIds = new Set(
      this.registry.contextLinks(request.project_id).map((item) => item.link_id),
    );
    for (const entryId of selectedIds) {
      const item = candidatesById.get(entryId);
      if (!item) throw new Error(`Catalog entry is not in the Candidate Set: ${entryId}`);
      if (!activeContextLinkIds.has(item.context_link_id)) {
        throw stateConflict(`Candidate Set Context Link is no longer active: ${item.context_link_id}`);
      }
      if (item.catalog_status !== 'active' || item.catalog_current_hash !== item.content_hash) {
        throw stateConflict(`Candidate Set source changed after discovery: ${entryId}`);
      }
      const sourceRoot = this.registry.showRoot(item.root_id).root;
      const normalized = normalizeExistingFile(
        sourceRoot.current_path,
        item.relative_path,
        'Candidate Set input',
      );
      const observedHash = sha256File(normalized.absolute);
      if (observedHash !== item.content_hash) {
        this.catalog.invalidate(entryId);
        throw stateConflict(`Candidate Set source changed after discovery: ${item.relative_path}`);
      }
    }
    const sourceSet = this.taskContext.createSourceSet({
      candidateSetId,
      targetProjectId: request.project_id,
      selectedEntryIds: selectedIds,
      createdAt: timestamp(),
    });
    const trustedInputs = sourceSet.items.map((item, ordinal) => {
      const normalized = normalizeExistingFile(
        item.source_root_path,
        item.source_relative_path,
        'Source Set input',
      );
      const observedHash = sha256File(normalized.absolute);
      if (observedHash !== item.content_hash) {
        throw stateConflict(`Source Set input changed after Catalog discovery: ${item.source_relative_path}`);
      }
      return {
        ordinal,
        path: `${item.source_root_id}:${item.source_relative_path}`,
        absolute: normalized.absolute,
        stat: normalized.stat,
        content_hash: observedHash,
        byte_size: normalized.stat.size,
        series: null,
        temporal_mode: null,
        coverage: null,
        required: true,
        priority: 100,
        source_root_id: item.source_root_id,
        source_project_id: item.source_project_id,
        source_root_path: item.source_root_path,
        source_relative_path: item.source_relative_path,
        catalog_entry_id: item.catalog_entry_id,
      };
    });
    return this.prepare({
      root: targetProject.location.root_path,
      request: {
        ...request,
        inputs: trustedInputs.map((item) => ({
          path: item.path,
          required: true,
          priority: item.priority,
        })),
      },
      caller,
      trustedInputs,
      sourceSet,
    });
  }

  showContextCandidates(candidateSetId) {
    return this.taskContext.getCandidateSet(candidateSetId);
  }

  showSourceSet(sourceSetId) {
    return this.taskContext.getSourceSet(sourceSetId);
  }

  sourceStatus(taskId, { caller = {} } = {}) {
    const detail = this.show(taskId);
    if (!detail.source_set_id) {
      return {
        schema: 'atlas-source-freshness.v1',
        task_id: taskId,
        status: 'unavailable',
        reason_code: 'task_has_no_source_set',
        items: [],
        attention: 'This Task has no persistent cross-Project Source Set.',
        source_changes: [],
      };
    }
    const sourceSet = this.taskContext.getSourceSet(detail.source_set_id);
    const projectIds = [...new Set(sourceSet.items.map((item) => item.source_project_id))];
    const refresh = projectIds.map((projectId) => this.catalog.update({ projectId, caller }));
    const exactHash = (rootId, relativePath) => {
      const root = this.registry.showRoot(rootId).root.current_path;
      const absolute = path.resolve(root, ...relativePath.split('/'));
      if (!isPathInside(root, absolute) || absolute === root) return null;
      try {
        assertRealPathChain(root, absolute);
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        const real = fs.realpathSync.native(absolute);
        if (!isPathInside(root, real)) return null;
        return sha256File(real);
      } catch {
        return null;
      }
    };
    const items = sourceSet.items.map((item) => {
      const current = this.catalog.repository.getEntry(
        item.source_root_id,
        item.source_relative_path,
      );
      if (current?.status === 'active') {
        const observedHash = exactHash(item.source_root_id, item.source_relative_path);
        if (observedHash != null) {
          return observedHash === item.content_hash
          ? {
              source_relative_path: item.source_relative_path,
              status: 'current',
              expected_hash: item.content_hash,
              current_hash: observedHash,
            }
          : {
              source_relative_path: item.source_relative_path,
              status: 'stale_source',
              expected_hash: item.content_hash,
              current_hash: observedHash,
            };
        }
      }
      const matches = this.catalog.repository.findActiveEntriesByHash(
        item.source_project_id,
        item.content_hash,
      ).filter((match) => (
        match.relative_path !== item.source_relative_path
        && exactHash(item.source_root_id, match.relative_path) === item.content_hash
      ));
      if (matches.length) {
        return {
          source_relative_path: item.source_relative_path,
          status: 'moved_same_content',
          expected_hash: item.content_hash,
          current_relative_path: matches[0].relative_path,
          additional_matches: Math.max(0, matches.length - 1),
        };
      }
      return {
        source_relative_path: item.source_relative_path,
        status: 'missing_source',
        expected_hash: item.content_hash,
        current_hash: null,
      };
    });
    const counts = Object.fromEntries(
      ['current', 'stale_source', 'missing_source', 'moved_same_content']
        .map((status) => [status, items.filter((item) => item.status === status).length]),
    );
    const status = counts.stale_source
      ? 'stale_source'
      : counts.missing_source
        ? 'missing_source'
        : counts.moved_same_content
          ? 'moved_same_content'
          : 'current';
    const attention = status === 'current'
      ? 'Selected sources are unchanged.'
      : status === 'moved_same_content'
        ? 'Source content is unchanged but its path moved; refresh the Source Set before the next write.'
        : status === 'stale_source'
          ? 'A selected source changed; refresh context before reusing or revising the output.'
          : 'A selected source is missing; resolve the source before reusing or revising the output.';
    return {
      schema: 'atlas-source-freshness.v1',
      task_id: taskId,
      source_set_id: sourceSet.source_set_id,
      status,
      counts,
      items,
      catalog_refresh: refresh.map((item) => ({
        project_id: item.project_id,
        generation_id: item.generation_id,
        changed_files: item.changed_files,
        reused_files: item.reused_files,
        missing_files: item.missing_files,
        content_files_read: item.content_files_read,
      })),
      attention,
      source_changes: [],
    };
  }

  discover({ root: rootInput, projectId, roles = [], extensions = [], modifiedAfter = null, maxCandidates = 12 }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) throw new Error(`Atlas state directory must be outside the Task root: ${this.stateDir}`);
    const active = this.ledger.getActiveEnvironmentPolicy(root);
    const project = this.ledger.getProject(projectId);
    if (project.status !== 'active' || !project.current_path) throw new Error(`Task Project is not active: ${projectId}`);
    const normalizedRoles = [...new Set(roles.map((roleId) => getArtifactRole(roleId).id))];
    const normalizedExtensions = [...new Set(extensions.map((extension) => String(extension).toLowerCase()))];
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_INPUTS) {
      throw new Error(`Task discovery maxCandidates must be between 1 and ${MAX_INPUTS}.`);
    }
    const cutoff = modifiedAfter == null ? null : Date.parse(modifiedAfter);
    if (cutoff != null && Number.isNaN(cutoff)) throw new Error('Task discovery modifiedAfter must be an ISO date or timestamp.');
    const projectRoot = path.resolve(root, ...project.current_path.split('/'));
    assertRealPathChain(root, projectRoot);
    const candidates = [];
    const excluded = [];
    const ignored = new Set(['.git', '.atlas', 'node_modules', '.next', 'dist', 'build', 'coverage']);
    const routes = active?.policy.derived_routes ?? {};
    const ledger = this.ledger;
    const roleForPath = (relativeToProject) => {
      const matches = Object.entries(routes)
        .filter(([, route]) => route.project_subdirectory
          && (relativeToProject === route.project_subdirectory
            || relativeToProject.startsWith(`${route.project_subdirectory}/`)))
        .map(([role]) => role);
      return [...new Set(matches)];
    };
    function walk(directory) {
      const children = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const absolute = path.join(directory, child.name);
        const projectRelative = toPortablePath(path.relative(projectRoot, absolute));
        const rootRelative = `${project.current_path}/${projectRelative}`;
        const stat = fs.lstatSync(absolute);
        if (child.isSymbolicLink() || stat.isSymbolicLink()) {
          excluded.push({ path: rootRelative, reason: 'symbolic_link' });
          continue;
        }
        if (child.isDirectory()) {
          if (ignored.has(child.name)) excluded.push({ path: rootRelative, reason: 'generated_or_internal_directory' });
          else walk(absolute);
          continue;
        }
        if (!child.isFile()) {
          excluded.push({ path: rootRelative, reason: 'special_file' });
          continue;
        }
        const inferredRoles = roleForPath(projectRelative);
        const registered = ledger.getActiveArtifactContext(root, rootRelative);
        if (registered?.role && !inferredRoles.includes(registered.role)) inferredRoles.push(registered.role);
        const extension = path.extname(child.name).toLowerCase();
        if (normalizedExtensions.length && !normalizedExtensions.includes(extension)) continue;
        if (cutoff != null && stat.mtimeMs < cutoff) continue;
        if (normalizedRoles.length && !normalizedRoles.some((role) => inferredRoles.includes(role))) continue;
        candidates.push({
          path: rootRelative,
          byte_size: stat.size,
          modified_at: stat.mtime.toISOString(),
          extension,
          inferred_roles: inferredRoles,
          registered_artifact: registered,
          discovered_by: active
            ? 'project_structure_and_active_routes'
            : 'project_structure_and_registered_artifacts',
        });
      }
    }
    walk(projectRoot);
    candidates.sort((left, right) => right.modified_at.localeCompare(left.modified_at) || left.path.localeCompare(right.path));
    return {
      schema: 'atlas-task-candidate-discovery.v1',
      project_id: project.id,
      project_path: project.current_path,
      environment_policy_mode: active ? 'library_contract' : 'task_scoped_project',
      criteria: {
        roles: normalizedRoles,
        extensions: normalizedExtensions,
        modified_after: modifiedAfter,
        max_candidates: maxCandidates,
      },
      candidates: candidates.slice(0, maxCandidates),
      excluded: [...excluded, ...candidates.slice(maxCandidates).map((item) => ({ path: item.path, reason: 'candidate_limit' }))],
      content_files_read: 0,
      source_changes: [],
    };
  }

  prepare({
    root: rootInput,
    request: rawRequest,
    caller = {},
    trustedInputs = null,
    sourceSet = null,
  }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) throw new Error(`Atlas state directory must be outside the Task root: ${this.stateDir}`);
    const request = normalizedRequest(rawRequest);
    const active = this.ledger.getActiveEnvironmentPolicy(root);
    const environmentPolicyMode = active ? 'library_contract' : 'task_scoped_explicit';
    const environmentRuleVersionId = active?.rule_version_id ?? TASK_SCOPED_ENVIRONMENT_RULE_VERSION_ID;
    const project = this.ledger.getProject(request.project_id);
    if (project.status !== 'active' || !project.current_path) throw new Error(`Task Project is not active: ${request.project_id}`);
    const discovery = request.discovery ? this.discover({
      root,
      projectId: request.project_id,
      roles: request.discovery.roles,
      extensions: request.discovery.extensions,
      modifiedAfter: request.discovery.modified_after,
      maxCandidates: request.discovery.max_candidates,
    }) : null;
    const combinedInputRequests = [...request.inputs];
    const requestedPaths = new Set(combinedInputRequests.map((input) => input.path));
    for (const item of discovery?.candidates ?? []) {
      if (!requestedPaths.has(item.path)) {
        combinedInputRequests.push({
          ordinal: combinedInputRequests.length,
          path: item.path,
          series: null,
          temporal_mode: null,
          coverage: null,
          required: false,
          priority: 100 + combinedInputRequests.length,
        });
        requestedPaths.add(item.path);
      }
    }
    const seen = new Set();
    const inputs = trustedInputs ?? combinedInputRequests.map((input, ordinal) => {
      const normalized = normalizeExistingFile(root, input.path, 'Task input');
      if (seen.has(normalized.path)) throw new Error(`Task input is duplicated: ${normalized.path}`);
      seen.add(normalized.path);
      return {
        ...input,
        ordinal,
        ...normalized,
        content_hash: sha256File(normalized.absolute),
        byte_size: normalized.stat.size,
      };
    });
    const target = normalizeTarget(root, request.output.target);
    if (!(target.path === project.current_path || target.path.startsWith(`${project.current_path}/`))) {
      throw new Error(`Task output must remain inside Project ${project.id} at ${project.current_path}.`);
    }
    request.inputs = inputs.map(({ ordinal, path: inputPath, series, temporal_mode: temporalMode, coverage, required, priority }) => ({
      ordinal, path: inputPath, series, temporal_mode: temporalMode, coverage, required, priority,
    }));
    if (request.output.base_input != null) {
      const base = normalizeExistingFile(root, request.output.base_input, 'Task output base_input');
      if (!inputs.some((input) => input.path === base.path)) {
        throw new Error('Task output base_input must also be one of the explicit inputs.');
      }
      request.output.base_input = base.path;
    }
    request.output.target = target.path;
    const temporal = buildTemporalRelations(inputs);
    const readSet = chooseReadSet(inputs, temporal.excluded, request.budget);
    const tokenEstimate = summarizeSelectedPayload(readSet.selected);
    const attention = this.rules.context({
      root,
      request: {
        operation: 'content_task',
        project_id: project.id,
        artifact_role: request.output.role,
        data_class: request.output.data_class,
        target_path: target.path,
        extension: path.extname(target.path).toLowerCase(),
      },
    });
    if (attention.conflicts.some((item) => item.kind === 'content_versioning')) {
      throw stateConflict('Reviewed content-versioning preferences conflict for this Task.');
    }
    const versioningPreference = attention.applied_rules.find(
      (item) => item.kind === 'content_versioning',
    ) ?? null;
    const write = chooseWrite(
      target,
      request.output,
      inputs,
      temporal.relations,
      versioningPreference?.value.strategy ?? null,
    );
    if (versioningPreference && request.output.action === 'auto') {
      write.preference_rule_id = versioningPreference.rule_id;
      write.rule_version_id = versioningPreference.rule_version_id;
      write.reason = `Create one governed ${write.strategy} output using the reviewed content-versioning preference.`;
    }
    const missingRequired = readSet.excluded.filter((input) => input.required && input.reason === 'read_budget');
    const appendInputMissing = write.strategy === 'append'
      && !readSet.selected.some((input) => input.path === target.path);
    const questions = [];
    if (inputs.length === 0) questions.push({
      field: 'discovery',
      question: 'No candidate matched the bounded discovery criteria; refine roles, extensions, or time.',
      paths: [],
    });
    if (missingRequired.length) questions.push({ field: 'budget', question: 'Increase the explicit read budget or make the excluded input optional.', paths: missingRequired.map((input) => input.path) });
    if (appendInputMissing) questions.push({ field: 'inputs', question: 'The append target must fit in the selected read set.', paths: [target.path] });
    const status = write.decision === 'deny'
      ? 'blocked'
      : (inputs.length === 0 || missingRequired.length || appendInputMissing) ? 'needs_input' : 'ready';
    const cleanItem = (item) => ({
      ordinal: item.ordinal, path: item.path, content_hash: item.content_hash,
      byte_size: item.byte_size, series: item.series, temporal_mode: item.temporal_mode,
      coverage: item.coverage, required: item.required, priority: item.priority,
      ...(item.source_root_id ? {
        source_root_id: item.source_root_id,
        source_project_id: item.source_project_id,
        source_root_path: item.source_root_path,
        source_relative_path: item.source_relative_path,
        catalog_entry_id: item.catalog_entry_id,
      } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.budget_reason ? { budget_reason: item.budget_reason } : {}),
    });
    const contract = {
      schema: 'atlas-task-contract.v1',
      status,
      read: {
        scope: 'selected_paths_only',
        selected: readSet.selected.map(cleanItem),
        excluded: readSet.excluded.map(cleanItem),
        budget: request.budget,
        selected_bytes: readSet.bytes,
        ...tokenEstimate,
      },
      temporal_relations: temporal.relations,
      discovery,
      attention,
      write,
      boundaries: {
        root,
        write_root_id: sourceSet ? this.registry.show(project.id).location.root_id : null,
        read_root_ids: sourceSet
          ? [...new Set(inputs.map((item) => item.source_root_id))].sort()
          : [],
        project_id: project.id,
        project_path: project.current_path,
        environment_policy_mode: environmentPolicyMode,
        environment_rule_version_id: environmentRuleVersionId,
        allowed_read_paths: readSet.selected.map((item) => item.path),
        forbidden_read_policy: 'all_unlisted_paths',
        candidate_area: path.join(this.stateDir, 'work'),
        candidate_must_be_outside_root: true,
        formal_target: write.target,
        allowed_write_paths: write.executor === 'none' ? [] : [write.target],
      },
      ...(sourceSet ? {
        candidate_set_id: sourceSet.candidate_set_id,
        source_set_id: sourceSet.source_set_id,
      } : {}),
      registration: {
        required: write.executor !== 'none',
        method: write.executor === 'guarded_update' ? 'task_complete_after_guarded' : 'task_fulfill_or_complete',
        records: ['output_artifact', 'output_material', 'input_material_lineage', 'actual_hash', 'write_run', 'rollback_entry'],
      },
      questions: questions.slice(0, 3),
    };
    const contractHash = sha256Json({ request, contract });
    const contractId = `TASKC-${contractHash.slice(0, 16)}`;
    const existing = this.ledger.findTaskContract(contractId);
    if (existing) return publicContract(existing.run.id, existing.contract);
    let result = null;
    withStateLock(this.stateDir, () => {
      const lockedExisting = this.ledger.findTaskContract(contractId);
      if (lockedExisting) {
        result = publicContract(lockedExisting.run.id, lockedExisting.contract);
        return;
      }
      const runId = makeRunId();
      const capturedInputs = inputs.map((input) => {
        const selected = readSet.selected.some((candidate) => candidate.ordinal === input.ordinal);
        return {
          ...cleanItem(input),
          selected,
          selection_reason: selected ? 'selected' : readSet.excluded.find((candidate) => candidate.ordinal === input.ordinal)?.reason,
          capture: selected ? captureBlob(input.absolute, this.stateDir) : null,
        };
      });
      this.ledger.createTaskContract({
        runId, contractId, root, request, contract, contractHash, project,
        environmentRuleVersionId, inputs: capturedInputs, caller,
        candidateSetId: sourceSet?.candidate_set_id ?? null,
        sourceSetId: sourceSet?.source_set_id ?? null,
        writeRootId: contract.boundaries.write_root_id,
        startedAt: timestamp(),
      });
      result = publicContract(runId, contract);
    });
    return result;
  }

  show(taskId) {
    return this.ledger.getTaskDetail(taskId);
  }

  reviewRule(taskId, { ruleId, decision, reason }) {
    return this.ledger.reviewTaskRuleApplication(taskId, {
      ruleId,
      decision,
      reason,
    });
  }

  #completionResult(detail) {
    return { ...detail.completion_receipt, write_run: { run_id: detail.completion_receipt.write_run_id, mode: detail.completion_receipt.write_mode } };
  }

  #validateCurrent(detail, allowedInputHashes = {}, allowDerivedTarget = false) {
    if (detail.run.status !== 'ready') throw new Error(`Task Contract is not ready; current status is ${detail.run.status}.`);
    const active = this.ledger.getActiveEnvironmentPolicy(detail.run.root_path);
    const project = this.ledger.getProject(detail.project_id);
    let stale = null;
    if (detail.contract.boundaries.environment_policy_mode === 'library_contract'
      && (!active || active.rule_version_id !== detail.environment_rule_version_id)) {
      stale = { reason: 'environment_rule_changed' };
    }
    if (!stale && detail.contract.attention) {
      const currentAttention = this.rules.context({
        root: detail.run.root_path,
        request: detail.contract.attention.request,
      });
      if (currentAttention.context_hash !== detail.contract.attention.context_hash) {
        stale = { reason: 'effective_rule_context_changed' };
      }
    }
    if (!stale && (project.status !== 'active' || project.current_path !== detail.project_path)) {
      stale = { reason: 'project_path_changed' };
    }
    if (!stale && detail.write_root_id) {
      const targetLocation = this.registry.show(detail.project_id).location;
      if (!targetLocation
          || targetLocation.root_id !== detail.write_root_id
          || path.resolve(targetLocation.root_path) !== path.resolve(detail.run.root_path)) {
        stale = { reason: 'target_root_changed' };
      }
    }
    if (!stale && detail.candidate_set_id) {
      const candidateSet = this.taskContext.getCandidateSet(detail.candidate_set_id);
      const candidateLinks = new Map(
        candidateSet.candidates.map((item) => [item.entry_id, item.context_link_id]),
      );
      const activeLinkIds = new Set(
        this.registry.contextLinks(detail.project_id).map((item) => item.link_id),
      );
      const revokedInput = detail.inputs
        .filter((item) => item.selected && item.catalog_entry_id)
        .find((item) => !activeLinkIds.has(candidateLinks.get(item.catalog_entry_id)));
      if (revokedInput) {
        stale = {
          reason: 'context_link_changed',
          path: revokedInput.path,
          context_link_id: candidateLinks.get(revokedInput.catalog_entry_id) ?? null,
        };
      }
    }
    if (!stale && !allowDerivedTarget && detail.contract.write.executor === 'derived_create'
        && fs.existsSync(path.resolve(detail.run.root_path, ...detail.contract.write.target.split('/')))) {
      stale = { reason: 'target_claimed', path: detail.contract.write.target };
    }
    if (!stale) {
      for (const input of detail.inputs.filter((item) => item.selected)) {
        const inputRoot = input.source_root_path ?? detail.run.root_path;
        const inputPath = input.source_relative_path ?? input.path;
        if (input.source_root_id) {
          const sourceLocation = this.registry.show(input.source_project_id).location;
          if (!sourceLocation
              || sourceLocation.root_id !== input.source_root_id
              || !(inputPath === sourceLocation.relative_path
                || inputPath.startsWith(`${sourceLocation.relative_path}/`))) {
            stale = {
              reason: 'source_project_location_changed',
              path: input.path,
            };
            break;
          }
        }
        const absolute = path.resolve(inputRoot, ...inputPath.split('/'));
        let observed = null;
        if (fs.existsSync(absolute)) {
          const stat = fs.lstatSync(absolute);
          if (stat.isFile() && !stat.isSymbolicLink()) {
            try {
              const real = fs.realpathSync.native(absolute);
              observed = isPathInside(inputRoot, real) ? sha256File(real) : null;
            } catch {
              observed = null;
            }
          }
        }
        if (observed !== input.content_hash && observed !== allowedInputHashes[input.path]) {
          stale = { reason: 'selected_input_changed', path: input.path, expected_hash: input.content_hash, observed_hash: observed };
          break;
        }
      }
    }
    if (stale) {
      this.ledger.markTaskStale(detail.run.id, stale, timestamp());
      if (stale.reason === 'effective_rule_context_changed') {
        throw stateConflict('Task Contract is stale because the effective rule context changed.');
      }
      if (stale.reason === 'context_link_changed') {
        throw stateConflict('Task Contract is stale because its Context Link changed.');
      }
      if (stale.reason === 'target_root_changed') {
        throw stateConflict('Task Contract is stale because its target Workspace Root changed.');
      }
      throw stateConflict(`Task Contract is stale because ${stale.path ?? stale.reason} changed.`);
    }
  }

  fulfill(taskId, { candidateFile, reason = null } = {}) {
    let detail = this.show(taskId);
    if (detail.completion_receipt) return this.#completionResult(detail);
    this.#validateCurrent(detail);
    const contract = detail.contract;
    if (contract.status !== 'ready') throw new Error(`Task Contract is not ready; current status is ${contract.status}.`);
    if (contract.write.executor === 'none') throw new Error('Task Contract write policy denies execution.');
    const candidate = normalizedCandidate(candidateFile, detail.run.root_path);
    if (contract.write.executor === 'derived_create') {
      let writeRunId = detail.underlying_run_id;
      if (!writeRunId) {
        const claimToken = crypto.randomUUID();
        const claim = this.ledger.claimTaskFulfillment(
          taskId, claimToken, process.pid, timestamp(), makeClaimedWriteRunId(contract.write.executor),
        );
        if (claim.status === 'staged') writeRunId = claim.write_run_id;
        else {
          try {
            const prepared = this.derived.prepare({
              root: detail.run.root_path,
              inputs: detail.inputs.filter((input) => input.selected).map((input) => input.path),
              trustedInputs: detail.inputs.filter((input) => input.selected).map((input) => ({
                path: input.path,
                sourceRootId: input.source_root_id,
                sourceProjectId: input.source_project_id,
                sourceRootPath: input.source_root_path,
                sourceRelativePath: input.source_relative_path,
              })),
              target: contract.write.target,
              candidateFile: candidate,
              projectId: detail.project_id,
              role: contract.write.role,
              relationType: contract.write.relation_type,
              intent: detail.request.intent,
              caller: detail.run.caller,
              runId: claim.planned_write_run_id,
            });
            writeRunId = prepared.run_id;
            this.ledger.recordTaskUnderlyingRun(taskId, writeRunId, timestamp(), claimToken);
          } catch (error) {
            this.ledger.releaseTaskFulfillmentClaim(taskId, claimToken, timestamp());
            throw error;
          }
        }
      }
      const write = this.derived.preview(writeRunId);
      if (write.run.status === 'prepared') this.derived.approve(writeRunId, { reason: reason ?? 'Authorized by the exact Task Contract.' });
      if (['prepared', 'approved'].includes(this.derived.preview(writeRunId).run.status)) this.derived.execute(writeRunId);
      return this.complete(taskId, { runId: writeRunId });
    }
    if (contract.write.executor === 'guarded_update') {
      const selectedTarget = detail.inputs.find((input) => input.selected && input.path === contract.write.target);
      if (!selectedTarget || !fileStartsWith(candidate, path.resolve(detail.run.root_path, ...selectedTarget.path.split('/')), selectedTarget.byte_size, selectedTarget.content_hash)) {
        throw new Error('Append candidate must preserve the exact baseline and add bytes after it.');
      }
      let writeRunId = detail.underlying_run_id;
      if (!writeRunId) {
        const claimToken = crypto.randomUUID();
        const claim = this.ledger.claimTaskFulfillment(
          taskId, claimToken, process.pid, timestamp(), makeClaimedWriteRunId(contract.write.executor),
        );
        if (claim.status === 'staged') writeRunId = claim.write_run_id;
        else {
          try {
            const prepared = this.guarded.prepare({
              root: detail.run.root_path, target: contract.write.target, candidateFile: candidate,
              intent: detail.request.intent, caller: detail.run.caller,
              runId: claim.planned_write_run_id,
            });
            writeRunId = prepared.run_id;
            this.ledger.recordTaskUnderlyingRun(taskId, writeRunId, timestamp(), claimToken);
          } catch (error) {
            this.ledger.releaseTaskFulfillmentClaim(taskId, claimToken, timestamp());
            throw error;
          }
        }
      }
      const write = this.guarded.preview(writeRunId);
      if (write.run.status === 'executed') return this.complete(taskId, { runId: writeRunId });
      return { task_id: taskId, contract_id: detail.contract_id, status: 'needs_approval', write_run: { run_id: writeRunId, mode: 'guarded' }, target: contract.write.target, reason: reason ?? contract.write.reason };
    }
    throw new Error(`Unknown Task executor: ${contract.write.executor}`);
  }

  archivePlan(taskId) {
    const detail = this.show(taskId);
    if (detail.underlying_run_id) return this.evolution.previewPlan(detail.underlying_run_id).receipt;
    this.#validateCurrent(detail);
    if (detail.contract.status !== 'ready' || detail.contract.write.executor !== 'organization_plan') {
      throw new Error('Task Contract does not contain a ready archive organization plan.');
    }
    const claimToken = crypto.randomUUID();
    const claim = this.ledger.claimTaskFulfillment(
      taskId, claimToken, process.pid, timestamp(), makeClaimedWriteRunId(detail.contract.write.executor),
    );
    if (claim.status === 'staged') return this.evolution.previewPlan(claim.write_run_id).receipt;
    try {
      const prepared = this.evolution.preparePlan({
        root: detail.run.root_path,
        intent: detail.request.intent,
        operations: [{
          operation: 'move_file',
          source: detail.contract.write.source,
          target: detail.contract.write.target,
        }],
        caller: detail.run.caller,
        runId: claim.planned_write_run_id,
      });
      this.ledger.recordTaskUnderlyingRun(taskId, prepared.run_id, timestamp(), claimToken);
      return prepared;
    } catch (error) {
      this.ledger.releaseTaskFulfillmentClaim(taskId, claimToken, timestamp());
      throw error;
    }
  }

  complete(taskId, { runId } = {}) {
    const detail = this.show(taskId);
    if (detail.completion_receipt) return this.#completionResult(detail);
    if (!runId || runId !== detail.underlying_run_id) throw stateConflict('Task completion write run does not match the staged run.');
    const contract = detail.contract;
    const allowedInputHashes = {};
    let allowDerivedTarget = false;
    if (contract.write.executor === 'derived_create') {
      const stagedWrite = this.derived.preview(runId);
      allowDerivedTarget = stagedWrite.run.status === 'executed'
        && stagedWrite.candidate.target_path === contract.write.target;
    }
    if (contract.write.executor === 'guarded_update') {
      const stagedWrite = this.guarded.preview(runId);
      if (stagedWrite.run.status === 'executed') {
        allowedInputHashes[contract.write.target] = stagedWrite.candidate.content_hash;
      }
    }
    this.#validateCurrent(detail, allowedInputHashes, allowDerivedTarget);
    let output;
    let mode;
    if (contract.write.executor === 'derived_create') {
      const write = this.derived.preview(runId);
      if (write.run.status !== 'executed' || !write.output) throw new Error('Derived write must be executed before Task completion.');
      if (write.candidate.target_path !== contract.write.target || write.placement.project_id !== detail.project_id
          || write.placement.role !== contract.write.role || write.placement.relation_type !== contract.write.relation_type) {
        throw stateConflict('Derived write no longer matches the exact Task Contract.');
      }
      const expected = detail.inputs.filter((input) => input.selected).map((input) => input.path).sort();
      const observed = write.inputs.map((input) => input.path).sort();
      if (JSON.stringify(expected) !== JSON.stringify(observed)) throw stateConflict('Derived inputs do not match the Task read scope.');
      output = { artifactId: write.output.artifact_id, materialId: write.output.material_id };
      mode = 'derived';
    } else if (contract.write.executor === 'guarded_update') {
      const write = this.guarded.preview(runId);
      if (write.run.status !== 'executed' || !write.execution_receipt) throw new Error('Guarded append must be executed before Task completion.');
      if (write.candidate.target_path !== contract.write.target) throw stateConflict('Guarded target does not match the exact Task Contract.');
      const selectedTarget = detail.inputs.find((input) => input.selected && input.path === contract.write.target);
      if (!selectedTarget || !fileStartsWith(write.candidate.blob_path, write.baseline.blob_path, selectedTarget.byte_size, selectedTarget.content_hash)) {
        throw stateConflict('Executed Guarded output does not satisfy append-only semantics.');
      }
      output = { artifactId: write.candidate.artifact_id, materialId: write.candidate.material_id };
      mode = 'guarded';
    } else {
      throw new Error('Task Contract has no executable write strategy.');
    }
    this.ledger.completeTaskContract(taskId, {
      writeRunId: runId,
      outputArtifactId: output.artifactId,
      outputMaterialId: output.materialId,
      targetPath: contract.write.target,
      relationType: contract.write.relation_type,
      writeMode: mode,
      completedAt: timestamp(),
    });
    return this.#completionResult(this.show(taskId));
  }

  rollback(taskId) {
    const detail = this.show(taskId);
    if (detail.rollback_receipt) return detail.rollback_receipt;
    if (!detail.completion_receipt) throw new Error(`Only a completed Task Contract can be rolled back; current status is ${detail.run.status}.`);
    const writeRunId = detail.completion_receipt.write_run_id;
    const mode = detail.completion_receipt.write_mode;
    const underlying = mode === 'derived' ? this.derived.rollback(writeRunId) : this.guarded.rollback(writeRunId);
    const receipt = {
      task_id: taskId, contract_id: detail.contract_id, status: 'rolled_back',
      write_run: { run_id: writeRunId, mode }, target: detail.completion_receipt.target,
      underlying_rollback: underlying, rolled_back_at: underlying.rolled_back_at ?? timestamp(),
    };
    return this.ledger.finishTaskRollback(taskId, receipt, receipt.rolled_back_at);
  }

  dispose() {
    if (this._rules) this._rules.dispose();
    if (this._derived) this._derived.dispose();
    if (this._guarded) this._guarded.dispose();
    if (this._evolution) this._evolution.dispose();
    if (this._catalog) this._catalog.dispose();
    if (this._registry) this._registry.dispose();
    if (this._ledger) this._ledger.close();
    this._derived = null;
    this._guarded = null;
    this._evolution = null;
    this._catalog = null;
    this._registry = null;
    this._taskContext = null;
    this._taskRepository = null;
    this._ledger = null;
  }
}
