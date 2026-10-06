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
function reuseFieldMismatch(recordedProfile, currentProfile) {
  const recorded = recordedProfile?.profile?.fields ?? [];
  const current = currentProfile?.profile?.fields ?? [];
  const currentByName = new Map(current.map((field) => [field.name, field]));
  const missing = recorded.filter((field) => !currentByName.has(field.name)).map((field) => field.name);
  const incompatible = recorded.filter((field) => {
    const next = currentByName.get(field.name);
    return next && field.inferred_type && next.inferred_type && field.inferred_type !== next.inferred_type;
  }).map((field) => ({ field: field.name, recorded_type: field.inferred_type, current_type: currentByName.get(field.name).inferred_type }));
  const added = current.filter((field) => !recorded.some((entry) => entry.name === field.name)).map((field) => field.name);
  return { missing, incompatible, added };
}
function stateConflict(message) { const error = new Error(message); error.code = 'ATLAS_STATE_CONFLICT'; return error; }
function samePath(left, right) {
  if (!left || !right) return left === right;
  const normalize = (value) => path.resolve(value).replaceAll('\\', '/').toLowerCase();
  return normalize(left) === normalize(right);
}
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
  const profileSummary = (value) => {
    const profile = value?.profile;
    if (!profile) return null;
    return {
      rows: profile.rows ?? null,
      columns: profile.columns ?? null,
      null_cells: profile.null_cells ?? null,
      duplicate_rows: profile.duplicate_rows ?? null,
      fields: (profile.fields ?? []).map((field) => field.name),
      sample: profile.sample ? {
        columns: (profile.sample.columns ?? []).map(String),
        rows: (profile.sample.rows ?? []).slice(0, 5),
      } : null,
      values: profile.sample?.rows?.slice(0, 5) ?? null,
    };
  };
  const representativeChanges = (recorded, observed) => {
    if (!recorded?.sample || !observed?.sample) return [];
    const beforeRows = recorded.sample.rows ?? [];
    const afterRows = observed.sample.rows ?? [];
    const changes = [];
    for (let index = 0; index < Math.max(beforeRows.length, afterRows.length) && changes.length < 3; index += 1) {
      const before = beforeRows[index] ?? null;
      const after = afterRows[index] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ row: index + 1, before, after });
    }
    return changes;
  };
  const reconciliationSummary = (item, current = null, checkedAt = null) => {
    const recorded = item.fingerprint ? {
      path: item.fingerprint.file_path ?? null,
      sha256: item.fingerprint.sha256 ?? null,
      bytes: item.fingerprint.bytes ?? null,
      modified_ns: item.fingerprint.modified_ns ?? null,
      profile: profileSummary(item.profile),
    } : null;
    const observed = current ? {
      path: current.file_path ?? item.file_path ?? null,
      sha256: current.sha256 ?? null,
      bytes: current.bytes ?? null,
      modified_ns: current.modified_ns ?? null,
      profile: profileSummary(current.profile),
    } : null;
    const pathChanged = Boolean(recorded?.path && observed?.path && !samePath(recorded.path, observed.path));
    const contentChanged = Boolean(recorded?.sha256 && observed?.sha256 && recorded.sha256 !== observed.sha256);
    const kind = !item.file_path || !fs.existsSync(item.file_path)
      ? 'missing'
      : !recorded ? 'not_prepared'
        : !observed ? 'not_checked'
          : pathChanged && contentChanged ? 'moved_and_changed'
            : pathChanged ? 'moved'
              : contentChanged ? 'changed'
                : 'unchanged';
    const decisionRequired = ['changed', 'moved', 'moved_and_changed', 'missing'].includes(kind) && item.version_policy !== 'pinned_version';
    const representative = representativeChanges(recorded?.profile, observed?.profile);
    return {
      kind,
      label: ({
        missing: 'Missing', not_prepared: 'Not prepared', not_checked: 'Not checked',
        moved_and_changed: 'Moved and changed', moved: 'Moved', changed: 'Changed', unchanged: 'Unchanged',
      })[kind],
      version_policy: item.version_policy ?? 'follow_latest',
      decision_required: decisionRequired,
      recorded,
      current: observed,
      differences: {
        path_changed: pathChanged,
        content_changed: contentChanged,
        rows_delta: recorded?.profile?.rows != null && observed?.profile?.rows != null ? observed.profile.rows - recorded.profile.rows : null,
        added_fields: observed?.profile?.fields?.filter((field) => !recorded?.profile?.fields?.includes(field)) ?? [],
        removed_fields: recorded?.profile?.fields?.filter((field) => !observed?.profile?.fields?.includes(field)) ?? [],
        representative_changes: representative,
      },
      comparison_note: recorded?.profile?.sample
        ? 'Representative values are a bounded comparison sample, not a full copy of either Source.'
        : 'Recorded values are unavailable for this older Work. Its recorded Hash proves identity; it is not a backup.',
      checked_at: checkedAt,
      actions: {
        use_current: Boolean(observed && ['changed', 'moved', 'moved_and_changed'].includes(kind)),
        pin_recorded: Boolean(recorded && item.version_policy !== 'pinned_version'),
        follow_latest: item.version_policy === 'pinned_version',
        relink: kind === 'missing',
        stop_using: true,
      },
    };
  };
  const changeReview = (value) => {
    const changed = value.sources.filter((item) => ['changed', 'moved', 'moved_and_changed', 'missing'].includes(item.reconciliation?.kind));
    const unresolved = changed.filter((item) => item.reconciliation?.decision_required === true);
    const counts = { total: unresolved.length, changed: 0, moved: 0, moved_and_changed: 0, missing: 0 };
    for (const item of unresolved) counts[item.reconciliation.kind] += 1;
    return {
      status: unresolved.length ? 'needs_review' : 'fresh',
      counts,
      items: unresolved.map((item) => ({
        source_key: item.source_key,
        resource_id: item.resource_id,
        name: item.name,
        kind: item.reconciliation.kind,
        label: item.reconciliation.label,
        before: item.reconciliation.recorded?.profile ?? null,
        after: item.reconciliation.current?.profile ?? null,
        representative_changes: item.reconciliation.differences.representative_changes,
        comparison_note: item.reconciliation.comparison_note,
      })),
      work: {
        session_id: value.session_id,
        revision: value.revision,
        latest_save_id: value.latest_save_id ?? null,
      },
      note: 'A recorded Hash proves which Source version the Work used; it is not a backup of the old file. Review representative values before choosing one decision for selected Sources.',
    };
  };
  const freshnessSummary = (value, { checked = false, checkedAt = null } = {}) => {
    const issue = value.sources.find((item) => ['missing', 'changed', 'moved', 'unsupported', 'failed'].includes(item.status) && item.version_policy !== 'pinned_version');
    if (issue) return { status: 'needs_review', label: 'Needs review', reason: issue.error_message ?? `${issue.name ?? issue.resource_id} is not ready.`, checked_at: checkedAt };
    const pinned = value.sources.find((item) => ['missing', 'changed', 'moved'].includes(item.status) && item.version_policy === 'pinned_version');
    if (pinned) return { status: 'pinned', label: 'Pinned version', reason: 'This Work keeps its recorded Source version. Its saved Result remains fixed; rerun requires an available matching Source or an explicit current-version decision.', checked_at: checkedAt };
    if (value.sources.some((item) => item.status !== 'ready')) return { status: 'not_ready', label: 'Not ready', reason: 'Prepare every Source before running this Work.', checked_at: checkedAt };
    if (!checked) return { status: 'not_checked', label: 'Not checked', reason: 'Open this Work or use table-work show to check current Source files.', checked_at: null };
    return { status: 'fresh', label: 'Fresh', reason: 'Every Source matches the prepared version for this Work.', checked_at: checkedAt };
  };
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
        resource_href: `/projects/${encodeURIComponent(value.project_id)}/resources?resource_id=${encodeURIComponent(item.resource_id)}`,
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
  const reuseProjectSession = (sourceSessionId, { baseRevision, sourceAssignments = null, intent = null, caller = null } = {}) => {
    if (!repository || !resourceControl) throw new Error('Persistent Work Sessions require the Atlas Resource store.');
    if (!Number.isInteger(Number(baseRevision)) || Number(baseRevision) < 1) throw stateConflict('Reusing Work requires its current revision.');
    const sourceSession = repository.byId(sourceSessionId);
    if (!sourceSession || sourceSession.status !== 'open') throw new Error('This Work Session is unavailable.');
    let assignments = null;
    if (sourceAssignments != null) {
      if (!Array.isArray(sourceAssignments) || sourceAssignments.length !== sourceSession.sources.length) throw new Error('Reuse requires exactly one current Resource for every recorded Source slot.');
      const sourceKeys = new Set(sourceSession.sources.map((item) => item.source_key));
      const assignedKeys = new Set(); const assignedResources = new Set();
      assignments = sourceAssignments.map((item) => {
        const sourceKey = String(item?.source_key ?? ''); const resourceId = String(item?.resource_id ?? '');
        if (!sourceKeys.has(sourceKey) || assignedKeys.has(sourceKey)) throw new Error('Reuse Source assignments must name every recorded Source slot exactly once.');
        if (!resourceId || assignedResources.has(resourceId)) throw new Error('Reuse requires a different current Resource for every Source slot.');
        assignedKeys.add(sourceKey); assignedResources.add(resourceId);
        workResource(sourceSession.project_id, resourceId);
        const recorded = sourceSession.sources.find((source) => source.source_key === sourceKey);
        return { source_key: sourceKey, resource_id: resourceId, sheet: item?.sheet == null ? recorded.sheet : String(item.sheet) };
      });
      if (assignedKeys.size !== sourceKeys.size) throw new Error('Reuse requires exactly one current Resource for every recorded Source slot.');
    } else {
      for (const item of sourceSession.sources) workResource(sourceSession.project_id, item.resource_id);
    }
    const reused = repository.reuse({ sourceSessionId, baseRevision: Number(baseRevision), sourceAssignments: assignments, intent, caller, at: isoNow() });
    return persistentSession(reused.session_id);
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
        return { resource_id: item.resource_id, name, status: item.status, version_policy: item.version_policy ?? 'follow_latest' };
      }),
      latest_save_id: value.latest_save_id,
      reused_from_session_id: value.reused_from_session_id,
      freshness: freshnessSummary(value),
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
    const reusedFrom = value?.reused_from_session_id ? repository?.byId(value.reused_from_session_id) : null;
    return value ? {
      ...value,
      comparison: comparison(value),
      mapping_complete: completeMapping(value),
      freshness: freshnessSummary(value),
      reuse_action: `/work/${encodeURIComponent(value.session_id)}/reuse`,
      reused_from_work: value.reused_from_session_id ? {
        session_id: value.reused_from_session_id,
        intent: reusedFrom?.intent ?? null,
        revision: reusedFrom?.revision ?? null,
        desktop_href: `/work/${encodeURIComponent(value.reused_from_session_id)}`,
      } : null,
    } : null;
  };
  const validateSources = async (id) => {
    const stored = repository?.byId(id);
    let value = persistentSession(id);
    if (!value) return null;
    let invalidated = false;
    const reconciliations = new Map();
    for (const item of value.sources) {
      const priorStatus = stored?.sources.find((source) => source.source_key === item.source_key)?.status;
      if (!item.file_path || !fs.existsSync(item.file_path)) {
        repository.setSourceStatus(id, item.source_key, 'missing', 'The selected Resource is no longer available at its recorded location.', isoNow());
        if (priorStatus !== 'missing') invalidated = true;
        reconciliations.set(item.source_key, reconciliationSummary(item, null, isoNow()));
        continue;
      }
      if (!dataFile(item.file_path)) {
        repository.setSourceStatus(id, item.source_key, 'unsupported', 'Work supports CSV or XLSX Resources.', isoNow());
        if (priorStatus !== 'unsupported') invalidated = true;
        continue;
      }
      const current = await fingerprintFn(item.file_path);
      const contentChanged = Boolean(item.fingerprint?.sha256 && current.sha256 !== item.fingerprint.sha256);
      const pathChanged = Boolean(item.fingerprint?.file_path && !samePath(item.fingerprint.file_path, current.file_path ?? item.file_path));
      const nextStatus = contentChanged ? 'changed' : pathChanged ? 'moved' : null;
      let comparedCurrent = current;
      if (contentChanged) {
        try {
          const currentProfile = await runDataWorkFn({ projectRoot, installationRoot, filePath: item.file_path, expectedSha256: current.sha256, action: 'profile', sheet: item.sheet });
          comparedCurrent = { ...current, profile: currentProfile };
        } catch { /* Fingerprint facts still provide a deterministic bounded comparison. */ }
      }
      if (nextStatus) {
        if (priorStatus !== nextStatus) {
          const message = contentChanged && pathChanged
            ? 'This Source moved and changed after its facts were prepared. Review the recorded and current versions before continuing.'
            : contentChanged
              ? 'This Source changed after its facts were prepared. Review the recorded and current versions before continuing.'
              : 'This Source moved after its facts were prepared. Review the recorded and current locations before continuing.';
          repository.setSourceStatus(id, item.source_key, nextStatus, message, isoNow());
          invalidated = true;
        }
      } else if (['missing', 'changed', 'moved'].includes(priorStatus)) {
        repository.setSourceStatus(id, item.source_key, item.fingerprint ? 'ready' : 'pending', null, isoNow());
      }
      reconciliations.set(item.source_key, reconciliationSummary(item, comparedCurrent, isoNow()));
    }
    if (invalidated) { discardPersistentStage(id); repository.invalidate(id, isoNow()); }
    const checkedAt = isoNow();
    const current = persistentSession(id);
    if (!current) return null;
    const withReconciliation = { ...current, sources: current.sources.map((item) => ({ ...item, reconciliation: reconciliations.get(item.source_key) ?? reconciliationSummary(item, null, checkedAt) })) };
    const checked = { ...withReconciliation, freshness: freshnessSummary(withReconciliation, { checked: true, checkedAt }) };
    return { ...checked, change_review: changeReview(checked) };
  };
  const prepareSources = async (id, { baseRevision = null } = {}) => {
    if (baseRevision != null) assertRevision(id, baseRevision);
    let value = persistentSession(id);
    if (!value) throw new Error('This Work Session is unavailable.');
    let reconciliationRequired = false;
    let detectedNewChange = false;
    for (const item of value.sources) {
      if (!item.file_path || !fs.existsSync(item.file_path)) {
        repository.setSourceStatus(id, item.source_key, 'missing', 'The selected Resource is no longer available at its recorded location.', isoNow());
        continue;
      }
      try {
        const fingerprint = await fingerprintFn(item.file_path);
        const changed = Boolean(item.fingerprint?.sha256 && item.fingerprint.sha256 !== fingerprint.sha256);
        const moved = Boolean(item.fingerprint?.file_path && !samePath(item.fingerprint.file_path, fingerprint.file_path ?? item.file_path));
        if (changed || moved) {
          const status = changed ? 'changed' : 'moved';
          if (item.status !== status) detectedNewChange = true;
          repository.setSourceStatus(id, item.source_key, status, changed && moved
            ? 'This Source moved and changed. Choose how to reconcile it before preparing.'
            : changed ? 'This Source changed. Choose how to reconcile it before preparing.' : 'This Source moved. Choose how to reconcile it before preparing.', isoNow());
          reconciliationRequired = true;
          continue;
        }
        const result = await runDataWorkFn({ projectRoot, installationRoot, filePath: item.file_path, expectedSha256: fingerprint.sha256, action: 'profile', sheet: item.sheet });
        const replacementPending = Boolean(value.reused_from_session_id && !item.fingerprint && item.profile?.profile?.fields);
        if (replacementPending && result.status !== 'sheet_required') {
          const mismatch = reuseFieldMismatch(item.profile, result);
          if (mismatch.missing.length || mismatch.incompatible.length || mismatch.added.length) {
            const details = [
              mismatch.missing.length ? `missing fields: ${mismatch.missing.join(', ')}` : '',
              mismatch.added.length ? `added fields: ${mismatch.added.join(', ')}` : '',
              mismatch.incompatible.length ? `type mismatch: ${mismatch.incompatible.map((entry) => `${entry.field} ${entry.recorded_type}→${entry.current_type}`).join(', ')}` : '',
            ].filter(Boolean).join('; ');
            repository.updateSource(id, item.source_key, { fingerprint, profile: result, processorVersion: result.processor?.version ?? null, status: 'failed', errorMessage: `This assigned Source does not match its recorded slot (${details}). Review only this Source assignment.` }, isoNow());
            continue;
          }
          repository.updateSource(id, item.source_key, { fingerprint, profile: result, processorVersion: result.processor?.version ?? null, status: 'ready', errorMessage: null }, isoNow());
          repository.rebindSourceMapping(id, item.source_key, { sha256: fingerprint.sha256, sheet: item.sheet }, isoNow());
          continue;
        }
        repository.updateSource(id, item.source_key, { fingerprint, profile: result, processorVersion: result.processor?.version ?? null, status: result.status === 'sheet_required' ? 'sheet_required' : 'ready', errorMessage: null }, isoNow());
      } catch (error) {
        repository.setSourceStatus(id, item.source_key, 'failed', String(error?.message ?? error).slice(0, 300), isoNow());
      }
    }
    if (reconciliationRequired) {
      discardPersistentStage(id);
      if (detectedNewChange) repository.invalidate(id, isoNow());
      throw stateConflict('One or more Sources changed. Review recorded and current facts, then choose use current, pin recorded, or stop using.');
    }
    if (baseRevision != null) assertRevision(id, baseRevision);
    return persistentSession(id);
  };

  const reconcileSources = async (id, sourceKeys, decision, { baseRevision = null } = {}) => {
    assertRevision(id, baseRevision);
    const value = persistentSession(id);
    const selected = [...new Set((sourceKeys ?? []).map(String))];
    if (!selected.length) throw new Error('Choose at least one Work Source to reconcile.');
    const items = selected.map((sourceKey) => value?.sources.find((entry) => entry.source_key === sourceKey));
    if (items.some((item) => !item)) throw new Error('Work Source is unavailable.');
    if (decision === 'pin-recorded') {
      if (items.some((item) => !item.fingerprint?.sha256)) throw new Error('Every selected Source needs a recorded version before it can be pinned.');
      const result = repository.applySourceReconciliations(id, selected, decision, {}, isoNow(), baseRevision);
      discardPersistentStage(id);
      return persistentSession(result.session_id);
    }
    if (decision === 'follow-latest') {
      const result = repository.applySourceReconciliations(id, selected, decision, {}, isoNow(), baseRevision);
      discardPersistentStage(id);
      return persistentSession(result.session_id);
    }
    if (decision === 'stop-using') {
      const result = repository.applySourceReconciliations(id, selected, decision, {}, isoNow(), baseRevision);
      discardPersistentStage(id);
      return persistentSession(result.session_id);
    }
    if (decision !== 'use-current') throw new Error('Choose use-current, pin-recorded, follow-latest, or stop-using.');
    const updates = [];
    for (const item of items) {
      if (!item.file_path || !fs.existsSync(item.file_path)) throw new Error('A selected current Source is missing. Relink it before using the current version.');
      if (!dataFile(item.file_path)) throw new Error('Work supports CSV or XLSX Resources.');
      const fingerprint = await fingerprintFn(item.file_path);
      const result = await runDataWorkFn({ projectRoot, installationRoot, filePath: item.file_path, expectedSha256: fingerprint.sha256, action: 'profile', sheet: item.sheet });
      const mismatch = reuseFieldMismatch(item.profile, result);
      const mappingCompatible = result.status !== 'sheet_required' && !mismatch.missing.length && !mismatch.incompatible.length && !mismatch.added.length;
      const mismatchDetail = [
        mismatch.missing.length ? `missing fields: ${mismatch.missing.join(', ')}` : '',
        mismatch.added.length ? `added fields: ${mismatch.added.join(', ')}` : '',
        mismatch.incompatible.length ? `type mismatch: ${mismatch.incompatible.map((entry) => `${entry.field} ${entry.recorded_type}→${entry.current_type}`).join(', ')}` : '',
      ].filter(Boolean).join('; ');
      updates.push({
        sourceKey: item.source_key,
        fingerprint,
        profile: result,
        processorVersion: result.processor?.version ?? null,
        sheet: item.sheet,
        mappingCompatible,
        status: result.status === 'sheet_required' ? 'sheet_required' : mappingCompatible ? 'ready' : 'mapping_required',
        errorMessage: mappingCompatible ? null : result.status === 'sheet_required'
          ? 'Choose a sheet before continuing.'
          : `Current Source fields need review (${mismatchDetail}). Only this Source alignment was cleared.`,
      });
    }
    const adopted = repository.applySourceReconciliations(id, selected, decision, { updates }, isoNow(), baseRevision);
    discardPersistentStage(id);
    return persistentSession(adopted.session_id);
  };
  const reconcileSource = (id, sourceKey, decision, options = {}) => reconcileSources(id, [sourceKey], decision, options);
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
    const aggregateDimension = field(input.aggregate_dimension, 'Aggregate dimension');
    const aggregateMeasure = field(input.aggregate_measure, 'Aggregate measure');
    const priorFocus = (value.recipe?.steps ?? []).find((step) => step.focus === true);
    if (priorFocus && priorFocus.column === aggregateDimension
      && value.preview?.aggregation?.groups?.some((group) => String(group.value) === String(priorFocus.value))) {
      steps.push({ ...priorFocus });
    }
    if (Boolean(aggregateDimension) !== Boolean(aggregateMeasure)) throw new Error('Choose both a group dimension and a numeric measure.');
    const pivotRow = field(input.pivot_row_dimension, 'Pivot row dimension');
    const pivotColumn = field(input.pivot_column_dimension, 'Pivot column dimension');
    const pivotMeasure = field(input.pivot_measure, 'Pivot measure');
    const hasPivot = Boolean(pivotRow || pivotColumn || pivotMeasure);
    const trendDate = field(input.trend_date_field, 'Trend date field');
    const trendMeasure = field(input.trend_measure, 'Trend measure');
    const hasTrend = Boolean(trendDate || trendMeasure);
    if ((hasPivot || hasTrend) && aggregateDimension || hasPivot && hasTrend) throw new Error('Group, pivot, and trend aggregates are mutually exclusive.');
    if (hasPivot && (!pivotRow || !pivotColumn || !pivotMeasure)) throw new Error('Choose row, column, and measure fields for the pivot.');
    if (hasPivot && new Set([pivotRow, pivotColumn, pivotMeasure]).size !== 3) throw new Error('Pivot row, column, and measure fields must be distinct.');
    if (aggregateDimension) {
      const formula = String(input.aggregate_formula ?? '');
      const unit = String(input.aggregate_unit ?? '').trim();
      const nullPolicy = String(input.aggregate_null_policy ?? '');
      if (formula !== 'sum') throw new Error('Group aggregate currently supports only sum.');
      if (nullPolicy !== 'exclude') throw new Error('Choose the explicit exclude null policy.');
      if (!unit || unit.length > 40) throw new Error('Aggregate unit must contain 1 to 40 characters.');
      if (selected.length && (!selected.includes(aggregateDimension) || !selected.includes(aggregateMeasure))) throw new Error('Selected output fields must include the aggregate dimension and measure.');
      steps.push({ operation: 'group-aggregate', dimension: aggregateDimension, measure: aggregateMeasure, formula, unit, null_policy: nullPolicy });
    }
    if (hasPivot) {
      const formula = String(input.pivot_formula ?? '');
      const unit = String(input.pivot_unit ?? '').trim();
      const nullPolicy = String(input.pivot_null_policy ?? '');
      if (formula !== 'sum') throw new Error('Pivot currently supports only sum.');
      if (nullPolicy !== 'exclude') throw new Error('Choose the explicit exclude null policy for the pivot.');
      if (!unit || unit.length > 40) throw new Error('Pivot unit must contain 1 to 40 characters.');
      if (selected.length && [pivotRow, pivotColumn, pivotMeasure].some((name) => !selected.includes(name))) throw new Error('Selected output fields must include all pivot fields.');
      if (input.rename_column) throw new Error('Pivot output headings are generated from the selected dimensions and cannot be renamed in this Recipe.');
      if (input.sort_column) steps.push({ operation: 'sort', column: field(input.sort_column, 'Sort field'), direction: input.sort_direction === 'desc' ? 'desc' : 'asc' });
      steps.push({ operation: 'pivot-aggregate', row_dimension: pivotRow, column_dimension: pivotColumn, measure: pivotMeasure, formula, unit, null_policy: nullPolicy });
    }
    if (hasTrend) {
      if (!trendDate || !trendMeasure) throw new Error('Choose both a date field and a numeric measure for the trend.');
      if (trendDate === trendMeasure) throw new Error('Trend date and measure fields must be distinct.');
      const formula = String(input.trend_formula ?? '');
      const unit = String(input.trend_unit ?? '').trim();
      const nullPolicy = String(input.trend_null_policy ?? '');
      const startMonth = String(input.trend_start_month ?? '').trim();
      const currentStartMonth = String(input.trend_current_start_month ?? '').trim();
      const endMonth = String(input.trend_end_month ?? '').trim();
      const monthIndex = (value) => {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) throw new Error('Trend months must use YYYY-MM.');
        const [year, month] = value.split('-').map(Number);
        return year * 12 + month - 1;
      };
      const start = monthIndex(startMonth); const currentStart = monthIndex(currentStartMonth); const end = monthIndex(endMonth);
      const previousLength = currentStart - start; const currentLength = end - currentStart + 1;
      if (previousLength < 1 || previousLength > 12 || currentLength < 1 || currentLength > 12 || previousLength !== currentLength || previousLength + currentLength > 24) throw new Error('Trend needs adjacent equal periods of 1 to 12 months each.');
      if (formula !== 'sum') throw new Error('Trend currently supports only sum.');
      if (nullPolicy !== 'exclude') throw new Error('Choose the explicit exclude null policy for the trend.');
      if (!unit || unit.length > 40) throw new Error('Trend unit must contain 1 to 40 characters.');
      if (selected.length && [trendDate, trendMeasure].some((name) => !selected.includes(name))) throw new Error('Selected output fields must include the trend date and measure fields.');
      if (input.rename_column) throw new Error('Trend output headings are fixed for the selected months and cannot be renamed in this Recipe.');
      if (input.sort_column) steps.push({ operation: 'sort', column: field(input.sort_column, 'Sort field'), direction: input.sort_direction === 'desc' ? 'desc' : 'asc' });
      steps.push({ operation: 'trend-aggregate', date_field: trendDate, measure: trendMeasure, formula, start_month: startMonth, current_start_month: currentStartMonth, end_month: endMonth, unit, null_policy: nullPolicy });
    }
    if (input.sort_column && !hasPivot && !hasTrend) steps.push({ operation: 'sort', column: field(input.sort_column, 'Sort field'), direction: input.sort_direction === 'desc' ? 'desc' : 'asc' });
    if (input.rename_column) {
      const from = field(input.rename_column, 'Rename field'); const to = String(input.rename_to ?? '').trim();
      if (!to) throw new Error('Enter the renamed field.');
      if (hasPivot || hasTrend) throw new Error('Aggregate output headings cannot be renamed in this Recipe.');
      if (to !== from && (fields.includes(to) || to === sourceColumn)) throw new Error('The renamed field must not duplicate another result field.');
      steps.push({ operation: 'rename', from, to });
    }
    steps.push({ operation: 'validate' });
    discardPersistentStage(id);
    return persistentSession(repository.setRecipe(id, { schema: 'atlas.table-recipe.v1', version: Number(value.recipe?.version ?? 0) + 1, combine, steps }, isoNow(), baseRevision).session_id);
  };
  const executePersistent = async (id, action, extension = '.csv', { baseRevision = null, detailOffset = 0, detailLimit = 20 } = {}) => {
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
    fs.writeFileSync(requestPath, JSON.stringify({ sources, mapping: value.mapping, recipe: value.recipe, page_size: 50, detail_offset: detailOffset, detail_limit: detailLimit }), 'utf8');
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
    if (action === 'details') return result;
    if (action === 'preview') {
      repository.setPreview(id, result, value.revision, isoNow());
      return persistentSession(id);
    }
    persistentStages.set(id, { stage_id: `STG-${crypto.randomUUID()}`, revision: value.revision, extension: path.extname(outputPath).toLowerCase(), path: outputPath, staged: result.staged, result });
    return persistentStages.get(id);
  };
  const previewPersistent = (id, options = {}) => executePersistent(id, 'preview', '.csv', options);
  const focusAggregate = async (id, { category = null, clear = false, baseRevision = null, guard = null } = {}) => {
    await validateSources(id);
    assertRevision(id, baseRevision);
    const value = persistentSession(id);
    if (!value?.preview || value.preview_revision !== value.revision || !value.preview.aggregation) throw stateConflict('Preview the current group aggregate before selecting a category.');
    const aggregation = value.preview.aggregation;
    const existing = (value.recipe?.steps ?? []).find((step) => step.focus === true);
    if (clear && !existing) return { ...value, focus: null };
    let selected = null;
    if (!clear) {
      selected = String(category ?? '');
      if (selected.length > 256 || !aggregation.groups.some((group) => String(group.value) === selected)) throw stateConflict('Choose a category from the complete current aggregate Preview.');
    }
    const steps = (value.recipe?.steps ?? []).filter((step) => step.focus !== true);
    if (!clear) {
      const aggregateIndex = steps.findIndex((step) => step.operation === 'group-aggregate');
      if (aggregateIndex < 0) throw stateConflict('Category focus is available only for a group-sum Recipe.');
      steps.splice(aggregateIndex, 0, { operation: 'filter', column: aggregation.dimension, operator: selected === '' ? 'is_empty' : 'equals', value: selected, focus: true });
    }
    const recipe = { ...(value.recipe ?? {}), schema: 'atlas.table-recipe.v1', version: Number(value.recipe?.version ?? 0) + 1, steps };
    discardPersistentStage(id);
    const updated = repository.setRecipe(id, recipe, isoNow(), baseRevision, guard);
    const focused = persistentSession(updated.session_id);
    return { ...focused, focus: clear ? null : { field: aggregation.dimension, value: selected } };
  };
  const readAggregateDetails = async (id, { offset = 0, limit = 20, baseRevision = null } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error('Details offset must be an integer from 0 to 1000000.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Details limit must be an integer from 1 to 50.');
    await validateSources(id);
    assertRevision(id, baseRevision);
    const value = persistentSession(id);
    if (!value?.preview || value.preview_revision !== value.revision || !value.preview.aggregation) throw stateConflict('Preview the current group aggregate before reading its processed input rows.');
    const focus = (value.recipe?.steps ?? []).find((step) => step.focus === true);
    if (!focus || focus.operation !== 'filter' || !((focus.operator === 'equals' && focus.value !== '') || (focus.operator === 'is_empty' && focus.value === '')) || focus.column !== value.preview.aggregation.dimension) throw stateConflict('Select a category from the current group aggregate before reading details.');
    const result = await executePersistent(id, 'details', '.csv', { baseRevision: value.revision, detailOffset: offset, detailLimit: limit });
    assertRevision(id, value.revision);
    const current = persistentSession(id);
    if (current.preview_revision !== value.preview_revision || current.sources.some((item) => item.status !== 'ready')) throw stateConflict('The Work Preview or Source changed while reading details.');
    const pagination = result.details ?? {};
    return {
      session_id: id, project_id: current.project_id, revision: current.revision,
      preview_revision: current.preview_revision, focus: { field: focus.column, value: focus.value },
      columns: result.columns ?? [], rows: result.rows ?? [],
      offset: pagination.offset ?? offset, limit: pagination.limit ?? limit, total: pagination.total ?? 0,
      next_offset: pagination.next_offset ?? null, complete: pagination.complete === true,
      sources: current.sources.map((item) => ({ resource_id: item.resource_id, sha256: item.fingerprint?.sha256 ?? null })),
    };
  };
  const stagePersistent = (id, extension, options = {}) => executePersistent(id, 'export', extension, options);
  const persistentStage = (id) => {
    const value = persistentStages.get(id);
    if (value && value.revision !== repository?.byId(id)?.revision) { discardPersistentStage(id); return null; }
    return value ?? null;
  };
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
  return { projectSession, createProjectSession, reuseProjectSession, currentProjectSession, openProjectSessions, discoverProjectSessions, assertRevision, replaceSources, addSource, removeSource, validateSources, prepareSources, reconcileSource, reconcileSources, selectSourceSheet, confirmMapping, updateRecipe, previewPersistent, focusAggregate, readAggregateDetails, stagePersistent, persistentStage, clearPersistentStage, recordSave, begin, session, selectSheet, change, page, stage, clearStage, attachProject, cleanup, expire };
}
