import fs from 'node:fs';
import path from 'node:path';
import { contentFileFingerprint } from './content-inspection.js';
import { isPathInside } from './paths.js';
import { MODULE_PROTOCOL_VERSION } from './protocol.js';
import { savedResultFreshness, sourceVersionPolicy } from './ui/services/saved-work-service.js';

export const TABLE_WORK_MODULE_DESCRIPTOR = Object.freeze({
  protocol: MODULE_PROTOCOL_VERSION,
  module_id: 'atlas.table-work',
  module_version: '1.0.0',
  contract: 'static_first_party',
  source_formats: Object.freeze(['csv', 'xlsx']),
  actions: Object.freeze([
    'start', 'list', 'show', 'reuse', 'replace-sources', 'reconcile', 'reconcile-batch', 'add-source', 'remove-source',
    'prepare', 'sheet', 'align', 'recipe', 'preview', 'read-preview', 'focus', 'details', 'prepare-save', 'confirm-save', 'save',
  ]),
  unsupported_actions: Object.freeze(['cancel', 'run', 'third-party-load']),
  preview_limits: Object.freeze({ max_rows: 50, max_columns: 100, max_utf8_bytes: 65536 }),
});

const ACTIONS = new Set(TABLE_WORK_MODULE_DESCRIPTOR.actions);
const DESCRIPTOR = TABLE_WORK_MODULE_DESCRIPTOR;

function moduleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw moduleError('ATLAS_MODULE_INVALID_REQUEST', `${label} must be an object.`);
  }
  return value;
}

function requestHeader(request) {
  requireRecord(request, 'Module request');
  if (request.protocol !== MODULE_PROTOCOL_VERSION) {
    throw moduleError('ATLAS_MODULE_PROTOCOL_UNSUPPORTED', `Unsupported Module protocol: ${request.protocol ?? '(missing)'}.`);
  }
  if (request.module_id !== DESCRIPTOR.module_id) {
    throw moduleError('ATLAS_MODULE_NOT_FOUND', `Unknown Module: ${request.module_id ?? '(missing)'}.`);
  }
  if (typeof request.project_id !== 'string' || !request.project_id.trim()) {
    throw moduleError('ATLAS_MODULE_PROJECT_REQUIRED', 'Table Work requires a Project ID.');
  }
  return request;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function recordTruncation(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function safePreviewCopy(value, key = '', depth = 0, reasons = []) {
  if (depth > 6) {
    recordTruncation(reasons, 'depth');
    return null;
  }
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value ?? null;
  if (typeof value === 'string') {
    const maxChars = 1024;
    let result = value;
    while (Buffer.byteLength(result, 'utf8') > maxChars) result = result.slice(0, Math.max(0, Math.floor(result.length * 0.75)));
    if (result.length !== value.length) recordTruncation(reasons, 'string_bytes');
    return result;
  }
  if (Array.isArray(value)) {
    const reason = /columns?/iu.test(key) ? 'columns' : /rows?/iu.test(key) ? 'rows' : 'array_items';
    const limit = reason === 'columns' ? DESCRIPTOR.preview_limits.max_columns
      : reason === 'rows' ? DESCRIPTOR.preview_limits.max_rows : 30;
    if (value.length > limit) recordTruncation(reasons, reason);
    return value.slice(0, limit).map((item) => safePreviewCopy(item, '', depth + 1, reasons));
  }
  if (typeof value === 'object') {
    const result = {};
    const entries = Object.entries(value);
    if (entries.length > 30) recordTruncation(reasons, 'object_fields');
    for (const [name, item] of entries.slice(0, 30)) {
      const copied = safePreviewCopy(item, name, depth + 1, reasons);
      if (copied !== undefined) result[name] = copied;
    }
    return result;
  }
  const text = String(value);
  if (text.length > 128) recordTruncation(reasons, 'string_bytes');
  return text.slice(0, 128);
}

function boundedPreview(value) {
  const reasons = [];
  let preview = safePreviewCopy(value, '', 0, reasons);
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) preview = { value: preview };
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') <= DESCRIPTOR.preview_limits.max_utf8_bytes) {
    return { ...preview, complete: reasons.length === 0, truncated_reasons: reasons };
  }
  recordTruncation(reasons, 'utf8_bytes');
  const summary = safePreviewCopy(value?.result_summary ?? value?.summary ?? {}, 'summary', 0, reasons);
  const fallback = { result_summary: summary, rows: [], columns: [], complete: false, truncated_reasons: reasons };
  if (Buffer.byteLength(JSON.stringify(fallback), 'utf8') <= DESCRIPTOR.preview_limits.max_utf8_bytes) return fallback;
  return { rows: [], columns: [], complete: false, truncated_reasons: reasons };
}

export function createTableWorkModule({ dataWork, savedWork, resolveProject, availability = null, handoffService = null }) {
  if (!dataWork || typeof dataWork.session !== 'function') throw new Error('Table Work Module requires the Data Work service.');
  if (!savedWork || typeof savedWork.save !== 'function') throw new Error('Table Work Module requires the Saved Work service.');
  if (typeof resolveProject !== 'function') throw new Error('Table Work Module requires a verified Project resolver.');

  const verifiedProject = (projectId) => {
    const resolved = resolveProject(projectId);
    const project = resolved?.project;
    const location = resolved?.location;
    if (!project || project.id !== projectId || project.status && project.status !== 'active') {
      throw moduleError('ATLAS_MODULE_PROJECT_UNAVAILABLE', 'The selected Project is unavailable or inactive.');
    }
    if (!location?.root_path || location.relative_path == null) {
      throw moduleError('ATLAS_MODULE_PROJECT_LOCATION_UNAVAILABLE', 'The selected Project has no verified local location.');
    }
    const workspaceRoot = path.resolve(location.root_path);
    const projectRoot = path.resolve(workspaceRoot, ...String(location.relative_path).replaceAll('\\', '/').split('/').filter(Boolean));
    if (projectRoot === workspaceRoot || !isPathInside(workspaceRoot, projectRoot)) {
      throw moduleError('ATLAS_MODULE_PROJECT_LOCATION_INVALID', 'The Project location is outside its verified root.');
    }
    let realWorkspace;
    let realProject;
    try {
      realWorkspace = fs.realpathSync.native(workspaceRoot);
      realProject = fs.realpathSync.native(projectRoot);
    } catch {
      throw moduleError('ATLAS_MODULE_PROJECT_LOCATION_UNAVAILABLE', 'The selected Project location is unavailable.');
    }
    if (!samePath(realWorkspace, workspaceRoot) || !samePath(realProject, projectRoot) || !isPathInside(realWorkspace, realProject)) {
      throw moduleError('ATLAS_MODULE_PROJECT_LOCATION_INVALID', 'The Project location contains a linked or escaping path.');
    }
    const projectStat = fs.lstatSync(projectRoot);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
      throw moduleError('ATLAS_MODULE_PROJECT_LOCATION_INVALID', 'The Project location is not a regular directory.');
    }
    return { project: { id: project.id, name: project.name }, workspaceRoot: realWorkspace, projectRoot: realProject };
  };

  const loadWork = (request, { checkRevision = true } = {}) => {
    const work = requireRecord(request.work, 'Work reference');
    if (typeof work.session_id !== 'string' || !work.session_id.trim()) {
      throw moduleError('ATLAS_MODULE_WORK_REQUIRED', 'Table Work requires an existing Work ID.');
    }
    const session = dataWork.session(work.session_id);
    if (!session || session.project_id !== request.project_id) {
      throw moduleError('ATLAS_MODULE_PROJECT_MISMATCH', 'The Work does not belong to the requested Project.');
    }
    if (checkRevision && (!Number.isInteger(work.base_revision) || work.base_revision !== session.revision)) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'The Work revision changed; reload this Work before continuing.');
    }
    return session;
  };

  const workState = (session, project) => {
    if (!session) return null;
    const sources = (session.sources ?? []).map((source) => ({
      source_key: source.source_key,
      resource_id: source.resource_id,
      name: source.name ?? null,
      sha256: source.fingerprint?.sha256 ?? null,
      status: source.status,
      version_policy: source.version_policy ?? 'follow_latest',
      reason: source.error_message ?? source.reconciliation?.label ?? null,
    }));
    const notReady = sources.filter((source) => source.status !== 'ready');
    const fieldCount = (session.sources ?? []).reduce((count, source) => count + (source.profile?.profile?.fields?.length ?? 0), 0);
    const mappingReady = session.mapping_complete === true;
    const ready = sources.length > 0 && notReady.length === 0;
    const previewCurrent = Boolean(session.preview && session.preview_revision === session.revision);
    const blockedReason = notReady.length
      ? notReady.map((source) => `${source.name ?? source.resource_id}: ${source.reason ?? source.status}`).join('; ')
      : !mappingReady ? 'Confirm Source field alignment before Preview.' : !previewCurrent ? 'Preview the current Recipe before preparing a Save.' : null;
    const stage = dataWork.persistentStage?.(session.session_id) ?? null;
    return {
      project_id: session.project_id,
      work: {
        session_id: session.session_id,
        revision: session.revision,
        status: session.status,
        intent: session.intent,
        latest_save_id: session.latest_save_id ?? null,
      },
      sources,
      preview: {
        reference: session.preview && session.preview_revision === session.revision
          ? { session_id: session.session_id, revision: session.revision, preview_revision: session.preview_revision } : null,
        current: previewCurrent,
        summary: session.preview?.result_summary ?? null,
      },
      saves: { latest_save_id: session.latest_save_id ?? null },
      actions: [
        { action: 'show', executable: true, blocked_reason: null },
        { action: 'prepare', executable: sources.length > 0, blocked_reason: sources.length ? null : 'Choose at least one Source.' },
        { action: 'preview', executable: ready && mappingReady, blocked_reason: ready ? mappingReady ? null : 'Confirm Source field alignment before Preview.' : blockedReason },
        { action: 'prepare-save', executable: ready && mappingReady && previewCurrent, blocked_reason: ready && mappingReady && previewCurrent ? null : blockedReason },
        { action: 'confirm-save', executable: Boolean(stage && stage.revision === session.revision && stage.staged?.sha256), blocked_reason: stage ? 'The staged result is stale or incomplete.' : 'Prepare a Save from the current Preview first.' },
      ],
    };
  };

  const response = (project, session, data, action, extra = {}) => ({
    protocol: MODULE_PROTOCOL_VERSION,
    module_id: DESCRIPTOR.module_id,
    module_version: DESCRIPTOR.module_version,
    status: 'ok',
    action,
    state: workState(session, project),
    data,
    ...extra,
  });

  const readPreview = async (request) => {
    requestHeader(request);
    const project = verifiedProject(request.project_id);
    const session = loadWork(request);
    if (!session.preview || session.preview_revision !== session.revision
      || request.preview_revision !== session.preview_revision) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'The Preview reference is stale; preview the current Recipe again.');
    }
    const preview = boundedPreview(session.preview);
    return {
      protocol: MODULE_PROTOCOL_VERSION,
      module_id: DESCRIPTOR.module_id,
      project_id: request.project_id,
      work: { session_id: session.session_id, revision: session.revision },
      preview_revision: session.preview_revision,
      preview,
      limits: DESCRIPTOR.preview_limits,
    };
  };

  const saveReplay = async (request, project, session, parameters, { reviewed = false } = {}) => {
    if (!parameters.request_key || !parameters.reason || !parameters.caller?.tool || !parameters.caller?.client_run_id) {
      throw moduleError('ATLAS_MODULE_SAVE_IDENTITY_REQUIRED', 'Confirm Save requires request_key, reason, caller.tool, and caller.client_run_id.');
    }
    const channel = parameters.channel ?? 'host';
    if (!['host', 'work'].includes(channel)) throw moduleError('ATLAS_MODULE_SAVE_CHANNEL_UNSUPPORTED', 'Table Work Save channel must be host or work.');
    const format = String(parameters.format ?? '').toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) throw moduleError('ATLAS_MODULE_INVALID_SAVE_FORMAT', 'Table Work Save format must be CSV or XLSX.');
    await dataWork.validateSources(session.session_id);
    dataWork.assertRevision(session.session_id, request.work.base_revision);
    const current = dataWork.session(session.session_id);
    if (!current.sources.length || current.sources.some((item) => item.status !== 'ready')) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'Every Source must be ready before confirming a Save.');
    }
    if (!current.preview || current.preview_revision !== current.revision
      || (reviewed && parameters.preview_revision !== current.preview_revision)) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'The reviewed Preview is stale; preview the current Recipe again.');
    }
    const { target, receipt } = savedWork.replayRequest({
      projectRoot: project.projectRoot, folder: parameters.folder, fileName: parameters.file_name,
      sourcePath: current.sources[0].file_path, outputExtension: `.${format}`,
      channel, caller: parameters.caller, requestKey: parameters.request_key,
    });
    const relativeTarget = path.relative(project.workspaceRoot, target).replaceAll('\\', '/');
    const identity = {
      module_id: DESCRIPTOR.module_id, channel,
      caller: { actor: parameters.caller.actor ?? null, tool: parameters.caller.tool, client_run_id: parameters.caller.client_run_id },
      request_key: parameters.request_key, reason: parameters.reason,
      project_id: request.project_id, root: project.workspaceRoot, project_root: project.projectRoot,
      session_id: current.session_id, base_revision: request.work.base_revision,
      preview_revision: current.preview_revision, target: relativeTarget, format,
      sources: current.sources.map((item) => ({
        source_key: item.source_key, resource_id: item.resource_id, path: item.file_path,
        sha256: item.fingerprint?.sha256 ?? null, sheet: item.sheet ?? null,
        version_policy: item.version_policy ?? 'follow_latest',
      })),
      mapping: current.mapping, recipe: current.recipe,
    };
    if (reviewed && parameters.target !== relativeTarget) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'The Save target differs from the reviewed target.');
    }
    if (!receipt) return { identity, receipt: null };
    const prior = receipt.parameters?.table_work_save;
    if (!prior || JSON.stringify(prior.identity) !== JSON.stringify(identity)
      || (reviewed && (prior.stage_id !== parameters.stage_id
        || prior.candidate_sha256 !== parameters.candidate_sha256
        || prior.identity.target !== parameters.target))) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'This caller request key was already used for a different Table Work Save.');
    }
    if (!['executed', 'undone'].includes(receipt.status)) {
      throw moduleError('ATLAS_STATE_CONFLICT', `The original Save ${receipt.save_id} is ${receipt.status}; inspect its receipt before retrying.`);
    }
    return { identity, receipt };
  };

  const prepareSave = async (request, project, session) => {
    const parameters = requireRecord(request.parameters ?? {}, 'Save preparation parameters');
    const baseRevision = request.work.base_revision;
    const format = String(parameters.format ?? '').toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) throw moduleError('ATLAS_MODULE_INVALID_SAVE_FORMAT', 'Table Work Save format must be CSV or XLSX.');
    const extension = `.${format}`;
    let current = await dataWork.validateSources(session.session_id);
    dataWork.assertRevision(session.session_id, baseRevision);
    current = dataWork.session(session.session_id);
    if (!current.sources.length || current.sources.some((item) => item.status !== 'ready')) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'Every Source must be ready before preparing a Save.');
    }
    if (!current.preview || current.preview_revision !== current.revision) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'Preview the current Recipe before preparing a Save.');
    }
    const target = savedWork.prepareDestination({
      projectRoot: project.projectRoot, folder: parameters.folder, fileName: parameters.file_name,
      sourcePath: current.sources[0]?.file_path, outputExtension: extension,
    });
    let stage = dataWork.persistentStage(session.session_id);
    let reusableStage = false;
    if (stage?.revision === current.revision && stage.extension === extension && stage.staged?.sha256 && stage.path) {
      try {
        const stat = fs.lstatSync(stage.path);
        reusableStage = stat.isFile() && !stat.isSymbolicLink()
          && contentFileFingerprint(stage.path).sha256 === stage.staged.sha256;
      } catch {
        reusableStage = false;
      }
    }
    if (!reusableStage) {
      if (stage) dataWork.clearPersistentStage(session.session_id);
      stage = await dataWork.stagePersistent(session.session_id, extension, { baseRevision });
    }
    if (stage.revision !== current.revision || stage.extension !== extension || !stage.staged?.sha256) {
      dataWork.clearPersistentStage(session.session_id);
      throw moduleError('ATLAS_STATE_CONFLICT', 'The staged result no longer matches the current Work revision.');
    }
    dataWork.assertRevision(session.session_id, current.revision);
    const prepared = {
      status: 'prepared',
      session_id: session.session_id,
      revision: stage.revision,
      preview_revision: current.preview_revision,
      preview_reference: { session_id: session.session_id, revision: current.revision, preview_revision: current.preview_revision },
      stage_id: stage.stage_id,
      candidate_sha256: stage.staged.sha256,
      output_extension: extension,
      target: path.relative(project.workspaceRoot, target).replaceAll('\\', '/'),
      result_summary: stage.result?.result_summary ?? {},
      validation: stage.result?.validation ?? null,
    };
    return response(project, dataWork.session(session.session_id), prepared, 'prepare-save');
  };

  const confirmSave = async (request, project, session) => {
    const parameters = requireRecord(request.parameters ?? {}, 'Save confirmation parameters');
    const replay = await saveReplay(request, project, session, parameters, { reviewed: true });
    if (replay.receipt) return response(project, dataWork.session(session.session_id), replay.receipt, 'confirm-save');
    const baseRevision = request.work.base_revision;
    if (!parameters.request_key || !parameters.reason || !parameters.caller?.tool || !parameters.caller?.client_run_id) {
      throw moduleError('ATLAS_MODULE_SAVE_IDENTITY_REQUIRED', 'Confirm Save requires request_key, reason, caller.tool, and caller.client_run_id.');
    }
    const channel = parameters.channel ?? 'host';
    if (!['host', 'work'].includes(channel)) {
      throw moduleError('ATLAS_MODULE_SAVE_CHANNEL_UNSUPPORTED', 'Table Work Save channel must be host or work.');
    }
    const format = String(parameters.format ?? '').toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) throw moduleError('ATLAS_MODULE_INVALID_SAVE_FORMAT', 'Table Work Save format must be CSV or XLSX.');
    const extension = `.${format}`;
    const current = await dataWork.validateSources(session.session_id);
    dataWork.assertRevision(session.session_id, baseRevision);
    const value = dataWork.session(session.session_id);
    if (value.sources.some((item) => item.status !== 'ready') || value.sources.length === 0) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'Every Source must be ready before confirming a Save.');
    }
    if (!value.preview || value.preview_revision !== value.revision || parameters.preview_revision !== value.preview_revision) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'The reviewed Preview is stale; preview the current Recipe again.');
    }
    const stage = dataWork.persistentStage(session.session_id);
    if (!stage || stage.stage_id !== parameters.stage_id || stage.revision !== value.revision
      || stage.extension !== extension || stage.staged?.sha256 !== parameters.candidate_sha256) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'The reviewed stage or Candidate Hash is stale. Prepare the Save again.');
    }
    let stageStat;
    try { stageStat = fs.lstatSync(stage.path); } catch { throw moduleError('ATLAS_STATE_CONFLICT', 'The staged Candidate is unavailable. Prepare the Save again.'); }
    if (!stageStat.isFile() || stageStat.isSymbolicLink()) throw moduleError('ATLAS_STATE_CONFLICT', 'The staged Candidate is not a regular file.');
    const stagedFingerprint = contentFileFingerprint(stage.path);
    if (stagedFingerprint.sha256 !== parameters.candidate_sha256) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'The staged Candidate changed after review. Prepare the Save again.');
    }
    const target = savedWork.prepareDestination({
      projectRoot: project.projectRoot, folder: parameters.folder, fileName: parameters.file_name,
      sourcePath: value.sources[0].file_path, outputExtension: extension,
    });
    if (parameters.target && !samePath(path.resolve(project.workspaceRoot, ...String(parameters.target).split('/')), target)) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'The Save target differs from the reviewed target.');
    }
    if (parameters.target !== path.relative(project.workspaceRoot, target).replaceAll('\\', '/')) {
      throw moduleError('ATLAS_STATE_CONFLICT', 'The Save target differs from the reviewed target.');
    }
    const sources = value.sources.map((item) => ({
      source_key: item.source_key, resource_id: item.resource_id, path: item.file_path,
      sheet: item.sheet, fingerprint: item.fingerprint, version_policy: item.version_policy ?? 'follow_latest',
    }));
    let record;
    try {
      record = savedWork.save({
        project: project.project, projectRoot: project.projectRoot, root: project.workspaceRoot,
        folder: parameters.folder, fileName: parameters.file_name, stagedPath: stage.path,
        expectedCandidateHash: parameters.candidate_sha256, sourcePath: sources[0].path,
        sourceFingerprint: sources[0].fingerprint, sources, recipe: value.recipe,
        versionPolicy: sourceVersionPolicy(value.sources), outputExtension: extension,
        requestKey: parameters.request_key, caller: parameters.caller, channel,
        executionReason: parameters.reason,
        parameters: { work_session_id: session.session_id, mapping: value.mapping, recipe_version: value.recipe.version,
          table_work_save: { identity: replay.identity, stage_id: parameters.stage_id, candidate_sha256: parameters.candidate_sha256 } },
        resultSummary: { ...stage.result.result_summary, validation: stage.result.validation, format: format.toUpperCase(), recipe_version: value.recipe.version },
      });
    } finally {
      dataWork.clearPersistentStage(session.session_id);
    }
    try {
      dataWork.recordSave(session.session_id, record.work_id);
    } catch (error) {
      return response(project, dataWork.session(session.session_id), {
        status: 'saved_pointer_not_recorded',
        saved_work: record,
        latest_save_id: dataWork.session(session.session_id)?.latest_save_id ?? null,
        error: String(error?.message ?? error),
      }, 'confirm-save');
    }
    return response(project, dataWork.session(session.session_id), record, 'confirm-save');
  };

  const invoke = async (request) => {
    requestHeader(request);
    const action = request.action;
    if (action === 'cancel' || !ACTIONS.has(action)) {
      throw moduleError('ATLAS_MODULE_ACTION_UNSUPPORTED', `Table Work action is unsupported: ${action ?? '(missing)'}.`);
    }
    availability?.assertActionEnabled?.(DESCRIPTOR.module_id, action);
    const project = verifiedProject(request.project_id);
    const parameters = requireRecord(request.parameters ?? {}, 'Module action parameters');
    if (action === 'list') {
      const data = dataWork.discoverProjectSessions(project.project, { limit: parameters.limit, offset: parameters.offset });
      return response(project, null, data, action);
    }
    if (action === 'start') {
      if (!Array.isArray(parameters.resource_ids) || parameters.resource_ids.length === 0) {
        throw moduleError('ATLAS_MODULE_SOURCE_REQUIRED', 'Starting Table Work requires at least one Project Resource ID.');
      }
      const data = dataWork.createProjectSession(project.project, parameters.return_state ?? {}, parameters.resource_ids,
        { intent: parameters.intent, caller: parameters.caller });
      return response(project, dataWork.session(data.session_id), data, action);
    }
    const session = loadWork(request);
    if (action === 'read-preview') return readPreview(request);
    if (action === 'focus') {
      if (typeof dataWork.focusAggregate !== 'function') throw moduleError('ATLAS_MODULE_ACTION_UNSUPPORTED', 'Table Work category focus is unavailable.');
      if (parameters.clear === true ? parameters.category != null : typeof parameters.category !== 'string') throw moduleError('ATLAS_MODULE_INVALID_REQUEST', 'Choose one category or clear the current focus.');
      let guard = null;
      if (parameters.handoff_id != null || parameters.handoff_digest != null) {
        if (!handoffService || typeof parameters.handoff_id !== 'string' || typeof parameters.handoff_digest !== 'string') throw moduleError('ATLAS_MODULE_INVALID_REQUEST', 'Handoff focus requires both handoff_id and handoff_digest.');
        guard = () => handoffService.assertFocus({ projectId: project.project.id, handoffId: parameters.handoff_id, expectedDigest: parameters.handoff_digest, workId: session.session_id, baseRevision: request.work.base_revision });
      }
      const data = await dataWork.focusAggregate(session.session_id, {
        category: parameters.category, clear: parameters.clear === true, baseRevision: request.work.base_revision, guard,
      });
      return response(project, dataWork.session(session.session_id), data, action);
    }
    if (action === 'details') {
      if (typeof dataWork.readAggregateDetails !== 'function') throw moduleError('ATLAS_MODULE_ACTION_UNSUPPORTED', 'Table Work aggregate details are unavailable.');
      const offset = parameters.offset ?? 0; const limit = parameters.limit ?? 20;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw moduleError('ATLAS_MODULE_INVALID_REQUEST', 'Details offset must be 0..1000000 and limit must be 1..50.');
      const data = await dataWork.readAggregateDetails(session.session_id, {
        offset, limit, baseRevision: request.work.base_revision,
      });
      return response(project, dataWork.session(session.session_id), data, action);
    }
    if (action === 'prepare-save') return prepareSave(request, project, session);
    if (action === 'confirm-save') return confirmSave(request, project, session);
    if (action === 'save') {
      const replay = await saveReplay(request, project, session, parameters);
      if (replay.receipt) return response(project, dataWork.session(session.session_id), replay.receipt, 'save');
      const prepared = await prepareSave(request, project, session);
      return confirmSave({ ...request, parameters: { ...parameters, ...prepared.data } }, project, dataWork.session(session.session_id));
    }
    let data;
    if (action === 'show') {
      data = await dataWork.validateSources(session.session_id);
      const latest = data.latest_save_id ? savedWork.find(data.latest_save_id) : null;
      if (latest) data = { ...data, latest_result: { ...latest, freshness: savedResultFreshness(latest) } };
    } else if (action === 'reuse') {
      data = dataWork.reuseProjectSession(session.session_id, { baseRevision: request.work.base_revision, sourceAssignments: parameters.source_assignments ?? null, intent: parameters.intent, caller: parameters.caller ?? null });
    } else if (action === 'replace-sources') {
      data = dataWork.replaceSources(session.session_id, parameters.resource_ids, { baseRevision: request.work.base_revision, returnState: parameters.return_state });
    } else if (action === 'reconcile') {
      data = await dataWork.reconcileSource(session.session_id, parameters.source_key, parameters.decision, { baseRevision: request.work.base_revision, caller: parameters.caller });
    } else if (action === 'reconcile-batch') {
      data = await dataWork.reconcileSources(session.session_id, parameters.source_keys, parameters.decision, { baseRevision: request.work.base_revision, caller: parameters.caller });
    } else if (action === 'add-source') {
      data = dataWork.addSource(session.session_id, parameters.resource_id, { baseRevision: request.work.base_revision });
    } else if (action === 'remove-source') {
      data = dataWork.removeSource(session.session_id, parameters.resource_id, { baseRevision: request.work.base_revision });
    } else if (action === 'prepare') {
      data = await dataWork.prepareSources(session.session_id, { baseRevision: request.work.base_revision });
    } else if (action === 'sheet') {
      dataWork.selectSourceSheet(session.session_id, parameters.source_key, parameters.sheet, { baseRevision: request.work.base_revision });
      data = await dataWork.prepareSources(session.session_id);
    } else if (action === 'align') {
      data = dataWork.confirmMapping(session.session_id, parameters.mapping, { baseRevision: request.work.base_revision });
    } else if (action === 'recipe') {
      data = dataWork.updateRecipe(session.session_id, parameters.recipe ?? parameters, { baseRevision: request.work.base_revision });
    } else if (action === 'preview') {
      data = await dataWork.previewPersistent(session.session_id, { baseRevision: request.work.base_revision });
    }
    const resultingSessionId = data?.session_id ?? session.session_id;
    const resultingSession = dataWork.session(resultingSessionId);
    return response(project, resultingSession, data, action);
  };

  return {
    describe: () => {
      const current = availability?.get?.(DESCRIPTOR.module_id) ?? { enabled: true, revision: 0 };
      return { ...DESCRIPTOR, source_formats: [...DESCRIPTOR.source_formats], actions: [...DESCRIPTOR.actions], unsupported_actions: [...DESCRIPTOR.unsupported_actions], preview_limits: { ...DESCRIPTOR.preview_limits }, enabled: current.enabled, revision: current.revision };
    },
    invoke,
    readPreview,
  };
}
