import fs from 'node:fs';
import path from 'node:path';
import { contentFilePath } from '../../content-inspection.js';
import { projectPath } from '../project-files.js';
import { savedResultState } from '../services/saved-work-service.js';

function resultStateDetail(status) {
  return {
    verified: 'Output matches the verified saved result',
    changed: 'Output changed after Save · record available',
    missing_source: 'Output file missing · record available',
    undone: 'Save undone · record available',
    unknown: 'Output could not be verified · record available',
  }[status];
}

function displayTime(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function workPosition(work) {
  if (!work.sources?.length) return 'Choose Sources';
  if (work.sources.some((item) => ['missing', 'changed', 'unsupported', 'failed'].includes(item.status))) return 'Resolve a Source issue';
  if (work.sources.some((item) => item.status !== 'ready')) return 'Prepare Sources';
  if (!work.mapping_complete) return 'Confirm field alignment';
  if (!work.preview || work.preview_revision !== work.revision) return 'Review Recipe and preview';
  if (work.latest_save_id) return 'Saved result ready';
  return 'Review preview and save';
}

function inside(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative.replaceAll('\\', '/') : null;
}

function filesHref(base, origin = {}) {
  const query = new URLSearchParams();
  if (origin.folder) query.set('folder', origin.folder);
  if (origin.path) query.set('path', origin.path);
  return `${base}/resources${query.size ? `?${query}` : ''}`;
}

function resultHref(root, base, result, workById) {
  const sessionId = result?.parameters?.work_session_id;
  if (sessionId && workById.has(sessionId)) return `/work/${encodeURIComponent(sessionId)}/saved?work_id=${encodeURIComponent(result.work_id)}`;
  if (result?.resource_id) return `${base}/resources?resource_id=${encodeURIComponent(result.resource_id)}`;
  const relative = result?.result_path ? inside(root, result.result_path) : null;
  return relative ? `${base}/resources?path=${encodeURIComponent(relative)}` : null;
}

function resourceResolution({ root, base, reference, resourceFacts }) {
  const fact = reference.resource_id
    ? resourceFacts.find((item) => item.resource_id === reference.resource_id) ?? null
    : null;
  if (fact) {
    const title = fact.resource?.display_name ?? reference.label ?? path.basename(fact.path ?? reference.relative_path ?? reference.id);
    return {
      title,
      href: `${base}/resources?resource_id=${encodeURIComponent(fact.resource_id)}`,
      detail: fact.resource?.status === 'missing' || fact.status === 'missing' ? 'File missing · record available' : 'Project Resource',
      status: fact.resource?.status === 'missing' || fact.status === 'missing' ? 'missing_source' : 'available',
    };
  }
  if (reference.relative_path) {
    const target = path.resolve(root, reference.relative_path);
    const relative = inside(root, target);
    try {
      const stat = relative == null ? null : fs.lstatSync(contentFilePath(projectPath(root, relative)));
      if (stat?.isFile() && !stat.isSymbolicLink()) return {
        title: reference.label ?? path.basename(target),
        href: `${base}/resources?path=${encodeURIComponent(relative)}`,
        detail: relative,
        status: 'available',
      };
    } catch {}
  }
  return null;
}

function fallbackItem(base, reference, reason) {
  const origin = reference.origin ?? {};
  return {
    kind: 'files',
    title: reference.label ?? 'Return to Project files',
    detail: 'The previous item is unavailable. Atlas kept its original Files position.',
    position: origin.path ?? origin.folder ?? 'Project Files',
    href: filesHref(base, origin),
    updated_at: displayTime(reference.updated_at),
    notice: reason,
  };
}

function resolveReference({ project, root, base, reference, resourceFacts, workById, resultById, viewById, getResultState }) {
  if (!reference) return null;
  if (reference.kind === 'work') {
    const work = workById.get(reference.id);
    if (!work) return fallbackItem(base, reference, 'This Work is no longer available.');
    return {
      kind: 'work', title: reference.label ?? 'Continue data Work', detail: `${work.sources.length} Source${work.sources.length === 1 ? '' : 's'} · revision ${work.revision}`,
      position: workPosition(work), href: `/work/${encodeURIComponent(work.session_id)}`, updated_at: displayTime(reference.updated_at ?? work.updated_at), notice: null,
    };
  }
  if (reference.kind === 'resource') {
    const resource = resourceResolution({ root, base, reference, resourceFacts });
    return resource ? { kind: 'resource', ...resource, position: resource.detail, updated_at: displayTime(reference.updated_at), notice: null }
      : fallbackItem(base, reference, 'This Resource record and file are unavailable.');
  }
  if (reference.kind === 'result') {
    const result = resultById.get(reference.id);
    if (!result) {
      const sourceWork = reference.origin?.kind === 'work' ? workById.get(reference.origin.id) : null;
      if (sourceWork) return {
        kind: 'work', title: reference.label ?? 'Return to the source Work',
        detail: 'The Result record is unavailable. Atlas kept the Work that produced it.',
        position: workPosition(sourceWork), href: `/work/${encodeURIComponent(sourceWork.session_id)}`,
        updated_at: displayTime(reference.updated_at ?? sourceWork.updated_at), notice: 'This Result record is no longer available.',
      };
      return fallbackItem(base, reference, 'This Result record is no longer available.');
    }
    const href = resultHref(root, base, result, workById);
    if (!href) return fallbackItem(base, reference, 'This Result no longer has an available detail route.');
    const status = getResultState(result);
    return {
      kind: 'result', title: reference.label ?? path.basename(result.result_path ?? reference.id),
      status, detail: resultStateDetail(status), position: status === 'verified' ? 'Open Result' : 'Review Result', href,
      updated_at: displayTime(reference.updated_at ?? result.executed_at ?? result.created_at), notice: null,
    };
  }
  if (reference.kind === 'view') {
    const view = viewById.get(reference.id);
    if (!view) return fallbackItem(base, reference, 'This Saved View is no longer available.');
    return {
      kind: 'view',
      title: view.name,
      detail: `${view.mode[0].toUpperCase()}${view.mode.slice(1)} View · revision ${view.revision}`,
      position: 'Open Saved View',
      href: `${base}/resources?view=${encodeURIComponent(view.view_id)}`,
      updated_at: displayTime(reference.updated_at ?? view.updated_at),
      notice: null,
    };
  }
  if (reference.kind === 'files') return {
    kind: 'files', title: reference.label ?? 'Continue in Files', detail: reference.relative_path ?? reference.origin?.folder ?? 'Project Files',
    position: reference.relative_path ?? reference.origin?.folder ?? 'Project Files', href: filesHref(base, { folder: reference.origin?.folder, path: reference.relative_path }),
    updated_at: displayTime(reference.updated_at), notice: null,
  };
  return fallbackItem(base, reference, 'This Saved View is not available in the current slice.');
}

function recentResult(root, base, result, workById, pinnedKeys, getResultState) {
  const status = getResultState(result);
  return {
    id: result.work_id,
    title: path.basename(result.result_path ?? result.work_id),
    detail: resultStateDetail(status),
    href: resultHref(root, base, result, workById),
    status,
    updated_at: displayTime(result.executed_at ?? result.created_at),
    pinned: pinnedKeys.has(`result:${result.work_id}`),
  };
}

export function buildProjectHomeModel({ project, root, base, homeState, resourceFacts = [], workSessions = [], savedWork = [], savedViews = [], currentActivity = [], hasProjectFiles = false }) {
  const workById = new Map(workSessions.map((item) => [item.session_id, item]));
  const resultById = new Map(savedWork.flatMap((item) => [[item.work_id, item], ...(item.save_id && item.save_id !== item.work_id ? [[item.save_id, item]] : [])]));
  const viewById = new Map(savedViews.map((item) => [item.view_id, item]));
  const resultStates = new Map();
  const getResultState = (result) => {
    if (!resultStates.has(result.work_id)) resultStates.set(result.work_id, savedResultState(result));
    return resultStates.get(result.work_id);
  };
  const continueItem = resolveReference({ project, root, base, reference: homeState.continue, resourceFacts, workById, resultById, viewById, getResultState });
  const pinnedKeys = new Set(homeState.pinned.map((item) => `${item.kind}:${item.id}`));
  const pinned = homeState.pinned.map((reference) => {
    const resolved = resolveReference({ project, root, base, reference, resourceFacts, workById, resultById, viewById, getResultState });
    return resolved && {
      key: `${reference.kind}:${reference.id}`, kind: reference.kind, id: reference.id,
      title: resolved.title, detail: resolved.detail, href: resolved.href, status: resolved.status ?? (resolved.notice ? 'unavailable' : 'available'), updated_at: resolved.updated_at,
    };
  }).filter(Boolean);
  const archivedResourceIds = new Set(resourceFacts.filter((fact) => fact.missing_record_archived).map((fact) => fact.resource_id));
  const recentResults = [...savedWork]
    .filter((item) => !archivedResourceIds.has(item.resource_id))
    .sort((left, right) => String(right.executed_at ?? right.created_at ?? '').localeCompare(String(left.executed_at ?? left.created_at ?? '')))
    .slice(0, 6).map((item) => recentResult(root, base, item, workById, pinnedKeys, getResultState));
  const contextualResourceIds = new Set([
    ...workSessions.flatMap((work) => (work.sources ?? []).map((source) => source.resource_id).filter(Boolean)),
    ...savedWork.flatMap((result) => [result.resource_id, ...(result.sources ?? []).map((source) => source.resource_id)].filter(Boolean)),
    ...homeState.pinned.filter((item) => item.kind === 'resource').map((item) => item.resource_id ?? item.id),
    ...(homeState.continue?.kind === 'resource' ? [homeState.continue.resource_id ?? homeState.continue.id] : []),
  ]);
  const missingFacts = resourceFacts.filter((fact) => fact.resource?.status === 'missing' || fact.status === 'missing' || fact.last_known_location?.status === 'missing');
  const unarchivedMissing = missingFacts.filter((fact) => !fact.missing_record_archived);
  const ordinaryMissing = unarchivedMissing.filter((fact) => !contextualResourceIds.has(fact.resource_id));
  const archivedMissing = missingFacts.filter((fact) => fact.missing_record_archived);
  const attention = [];
  for (const changed of homeState.check?.changed_resources ?? []) {
    const fact = resourceFacts.find((item) => item.resource_id === changed.resource_id);
    attention.push({
      key: `resource-change:${changed.resource_id}`,
      title: changed.title ?? fact?.resource?.display_name ?? changed.resource_id,
      detail: 'File changed outside Atlas. Review it, then accept the current version when it is the version you want to use.',
      href: `${base}/resources?resource_id=${encodeURIComponent(changed.resource_id)}`,
      status: 'changed',
    });
  }
  for (const [id, status] of resultStates) {
    if (['verified', 'undone'].includes(status)) continue;
    const result = resultById.get(id);
    attention.push({ key: `result:${id}`, title: path.basename(result.result_path ?? id), detail: resultStateDetail(status), href: resultHref(root, base, result, workById), status });
  }
  for (const work of workSessions) {
    const issue = work.sources.find((source) => !archivedResourceIds.has(source.resource_id) && ['changed', 'missing', 'failed', 'unsupported'].includes(source.status));
    if (issue) attention.push({ key: `work:${work.session_id}`, title: issue.name ?? issue.resource_id, detail: issue.error_message ?? 'Review this Work Source before continuing.', href: `/work/${encodeURIComponent(work.session_id)}`, status: issue.status === 'missing' ? 'missing_source' : issue.status });
  }
  if (ordinaryMissing.length) attention.push({
    key: 'resources:missing',
    title: `${ordinaryMissing.length} unavailable Resource record${ordinaryMissing.length === 1 ? '' : 's'}`,
    detail: 'The recorded files no longer exist. Review or archive records that no longer matter.',
    href: `${base}/resources?missing=1`,
    status: 'missing_source',
  });
  for (const item of currentActivity.filter((entry) => entry.project?.id === project.id && ['failed', 'interrupted', 'waiting'].includes(entry.status))) {
    attention.push({ key: `activity:${item.activity_id}`, title: path.basename(item.file_path ?? item.activity_id), detail: item.error_message ?? 'This activity needs attention.', href: `/activity?selected=${encodeURIComponent(item.activity_id)}`, status: item.status === 'waiting' ? 'waiting' : 'failed' });
  }
  const check = homeState.check;
  const changes = attention.length ? { state: 'attention', checked_at: check?.checked_at ?? null, scope_label: check?.scope_label ?? 'Known Project facts', items: attention }
    : check?.status === 'complete' ? { state: 'clear', checked_at: check.checked_at, scope_label: check.scope_label, items: [] }
      : check?.status === 'failed' ? { state: 'failed', checked_at: check.checked_at, scope_label: check.scope_label, items: [{ key: 'check:failed', title: 'Check did not finish', detail: check.error_message, href: null, status: 'failed' }] }
        : { state: 'not_checked', checked_at: null, scope_label: 'Tracked Project Resources', items: [] };
  const otherWork = workSessions
    .filter((item) => !homeState.continue || homeState.continue.kind !== 'work' || item.session_id !== homeState.continue.id)
    .map((item) => ({ id: item.session_id, title: 'Open data Work', detail: `${item.sources.length} Source${item.sources.length === 1 ? '' : 's'} · revision ${item.revision}`, position: workPosition(item), href: `/work/${encodeURIComponent(item.session_id)}`, updated_at: displayTime(item.updated_at) }));
  return {
    project, base, continue_item: continueItem, other_work: otherWork, pinned, changes, recent_results: recentResults,
    missing_records: {
      count: unarchivedMissing.length,
      resource_ids: unarchivedMissing.map((item) => item.resource_id),
      archived_count: archivedMissing.length,
      archived_resource_ids: archivedMissing.map((item) => item.resource_id),
    },
    empty_project: !hasProjectFiles && !resourceFacts.length && !workSessions.length && !savedWork.length && !pinned.length,
    state_error: homeState.error?.message ?? null,
  };
}
