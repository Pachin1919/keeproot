import fs from 'node:fs';
import path from 'node:path';
import { contentFileFingerprint, contentFilePath, readCachedContentInspection } from '../../content-inspection.js';
import { browseProjectFiles, listProjectFolders, projectPath, searchProjectFiles } from '../project-files.js';

function samePath(left, right) {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function resourceType(filePath) {
  const extension = path.extname(filePath).slice(1).toUpperCase();
  return extension || 'Local file';
}

function resourceWork(recentWork, projectId, filePath, resourceId = null) {
  if (resourceId) {
    const matched = recentWork.find((work) => work.project?.id === projectId && work.resource_id === resourceId);
    if (matched) return matched;
  }
  return recentWork.find((work) => work.project?.id === projectId
    && (!resourceId || !work.resource_id) && samePath(work.file_path, filePath)) ?? null;
}

function sourceFingerprintStatus(work, filePath) {
  if (!work) return null;
  try {
    return contentFileFingerprint(filePath).sha256 === work.source_fingerprint.sha256
      ? 'File unchanged since last inspection'
      : 'File changed since last inspection';
  } catch {
    return null;
  }
}

function savedSourceStatus(saved) {
  try {
    const current = contentFileFingerprint(saved.source_path);
    const recordedHash = saved.source_fingerprint?.sha256;
    if (!recordedHash) return null;
    return current.sha256 === recordedHash
      ? 'Source unchanged since this result was created'
      : 'Source changed since this result was created';
  } catch {
    return 'Source file is no longer available';
  }
}

function currentResourceActivity(currentActivity, projectId, filePath, work, resourceId = null) {
  const completedAt = [work?.inspected_at, work?.last_continued_at]
    .filter((value) => typeof value === 'string').sort().at(-1) ?? null;
  const projectEntries = currentActivity.filter((entry) => entry.project?.id === projectId);
  const candidates = resourceId
    ? (() => {
      const explicit = projectEntries.filter((entry) => entry.resource_id === resourceId);
      return explicit.length ? explicit : projectEntries.filter((entry) => !entry.resource_id && samePath(entry.file_path, filePath));
    })()
    : projectEntries.filter((entry) => samePath(entry.file_path, filePath));
  return candidates
    .sort((left, right) => String(right.updated_at ?? right.started_at ?? '').localeCompare(String(left.updated_at ?? left.started_at ?? '')))
    .find((entry) => !(['failed', 'interrupted'].includes(entry.status)
      && completedAt && String(entry.updated_at ?? entry.started_at ?? '') <= completedAt)) ?? null;
}

function resourceRecord(item, root, recentWork, projectId, savedWork = [], currentActivity = [], resourceFacts = []) {
  const filePath = path.join(root, item.relative_path);
  const fact = resourceFacts.find((entry) => samePath(entry.path ?? entry.file_path ?? '', filePath)) ?? null;
  const resourceId = fact?.resource_id ?? fact?.resource?.id ?? null;
  const work = resourceWork(recentWork, projectId, filePath, resourceId);
  const transfer = work?.project_transfer ?? null;
  const saved = resourceId
    ? savedWork.find((entry) => entry.resource_id === resourceId) ?? savedWork.find((entry) => !entry.resource_id && samePath(entry.result_path, filePath))
    : savedWork.find((entry) => samePath(entry.result_path, filePath)) ?? null;
  const createdWork = savedWork.filter((entry) => resourceId
    ? entry.resource_id === resourceId || (!entry.resource_id && samePath(entry.source_path, filePath))
    : samePath(entry.source_path, filePath));
  const activity = currentResourceActivity(currentActivity, projectId, filePath, work, resourceId);
  return {
    resource_fact: fact,
    resource_id: resourceId ?? work?.resource_id ?? saved?.resource_id ?? activity?.resource_id ?? null,
    name: item.name,
    relative_path: item.relative_path,
    file_path: filePath,
    type: resourceType(item.name),
    bytes: item.bytes,
    modified_at: item.modified_at,
    work: work ? {
      work_id: work.work_id,
      inspected_at: work.inspected_at,
      last_continued_at: work.last_continued_at,
      purpose: work.inspect.purpose,
      sheet: work.inspect.sheet,
      source_status: sourceFingerprintStatus(work, filePath),
      initiated_by: work.initiated_by,
      inspection_cache_hit: work.inspection_cache_hit,
      result_summary: work.result_summary,
      cache_reference: work.cache_reference,
      max_characters: work.inspect.max_characters,
    } : null,
    // Disk modification time is deliberately not presented as "Last worked".
    // Atlas only knows a file was worked when it has a Recent Work or Saved Work fact.
    last_worked_at: work?.last_continued_at ?? work?.inspected_at ?? saved?.created_at ?? null,
    added_from: transfer ? {
      origin_file: transfer.origin.file_path,
      saved_at: transfer.saved_at,
      undo_available: transfer.undo_available,
    } : null,
    saved_work: saved ? {
      work_id: saved.work_id, source_path: saved.source_path, parameters: saved.parameters,
      result_summary: saved.result_summary, created_at: saved.created_at,
      undo_available: saved.write?.undo_available === true,
      source_status: savedSourceStatus(saved),
    } : null,
    created_work: createdWork.map((savedItem) => ({ work_id: savedItem.work_id, name: path.basename(savedItem.result_path), result_path: savedItem.result_path, relative_path: path.relative(root, savedItem.result_path).replaceAll('\\', '/'), created_at: savedItem.created_at })),
    activity: activity ? {
      status: activity.status,
      updated_at: activity.updated_at,
      error_message: activity.error_message,
      initiated_by: activity.initiated_by,
    } : null,
  };
}

function resourceCategory(resource) {
  if (resource.saved_work) return 'created';
  if (resource.added_from) return 'source';
  return 'other';
}

function resourceState(resource) {
  if (['failed', 'interrupted'].includes(resource.activity?.status)) return 'failed';
  if (resource.activity?.status === 'waiting') return 'waiting';
  if (resource.activity?.status === 'running') return 'running';
  const status = resource.saved_work?.source_status ?? resource.work?.source_status ?? '';
  if (/no longer available/u.test(status)) return 'missing';
  if (/unchanged/u.test(status)) return 'unchanged';
  if (/changed/u.test(status)) return 'changed';
  return null;
}

function recoveryActions(resource, projectId) {
  const fact = resource.resource_fact ?? resource;
  if (!fact?.resource_id || !fact.resource) return null;
  const missing = fact.resource.status === 'missing';
  const hasActiveLocation = (fact.locations ?? []).some((location) => location.status === 'active');
  return {
    keep_record: missing && !hasActiveLocation,
    relink: missing && !hasActiveLocation,
    relationships: (fact.relationships ?? [])
      .filter((relationship) => relationship.status === 'active' && relationship.target_kind === 'project' && relationship.target_id === projectId)
      .map((relationship) => ({
        id: relationship.id,
        type: relationship.type,
        can_forget: true,
        can_remove_reference: relationship.type === 'used_by',
      })),
  };
}

function projectTree(records, folderRecords = []) {
  const root = { folders: new Map(), files: [] };
  const ensureFolder = (segments) => {
    let cursor = root;
    let folderPath = '';
    for (const segment of segments) {
      folderPath = folderPath ? `${folderPath}/${segment}` : segment;
      if (!cursor.folders.has(segment)) cursor.folders.set(segment, { name: segment, relative_path: folderPath, folders: new Map(), files: [] });
      cursor = cursor.folders.get(segment);
    }
    return cursor;
  };
  for (const folder of folderRecords) ensureFolder(folder.relative_path.split('/').filter(Boolean));
  for (const resource of records) {
    const segments = resource.relative_path.split('/').filter(Boolean);
    const fileName = segments.pop();
    const cursor = ensureFolder(segments);
    if (fileName) cursor.files.push({ ...resource, category: resourceCategory(resource), state: resourceState(resource) });
  }
  const serialize = (node) => ({
    folders: [...node.folders.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((folder) => ({ ...serialize(folder), name: folder.name, relative_path: folder.relative_path })),
    files: [...node.files].sort((left, right) => left.name.localeCompare(right.name)),
  });
  return serialize(root);
}

function projectFolderPaths(tree) {
  const paths = new Set(['']);
  const visit = (folders) => folders.forEach((folder) => {
    paths.add(folder.relative_path);
    visit(folder.folders);
  });
  visit(tree.folders);
  return paths;
}

function missingSources(savedWork) {
  return savedWork
    .filter((item) => item.status === 'active' && item.source_path && !fs.existsSync(item.source_path))
    .map((item) => ({ name: path.basename(item.source_path), source_path: item.source_path }));
}

function focusedRecord(root, focusedPath, recentWork, projectId, savedWork, currentActivity, resourceFacts) {
  if (!focusedPath) return null;
  try {
    const filePath = projectPath(root, focusedPath);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const item = {
      name: path.basename(filePath),
      relative_path: path.relative(root, filePath).replaceAll('\\', '/'),
      bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    };
    const record = resourceRecord(item, root, recentWork, projectId, savedWork, currentActivity, resourceFacts);
    return { ...record, state: resourceState(record) };
  } catch {
    return null;
  }
}

export function summarizeProjectResources({ project, root, recentWork, savedWork = [], savedWorkError = false }) {
  const listed = searchProjectFiles(root, '');
  const records = listed.items.map((item) => resourceRecord(item, root, recentWork, project.id, savedWork));
  const known_sources = records.filter((item) => item.added_from && !item.saved_work).length;
  const created_work = records.filter((item) => item.saved_work).length;
  return {
    known_sources,
    created_work,
    changed_resources: records.filter((resource) => resourceState(resource) === 'changed').length,
    current_output: null,
    other_files: records.filter((item) => !item.added_from && !item.saved_work).length,
    saved_work_error: savedWorkError,
    last_saved_at: savedWork.reduce((latest, item) => String(item.created_at ?? '').localeCompare(latest) > 0 ? String(item.created_at) : latest, ''),
    truncated: listed.truncated,
  };
}

function representationFor(resource, stateDir) {
  const work = resource.work;
  if (!stateDir || !work?.cache_reference || !work?.source_status?.includes('unchanged')) return null;
  try {
    const cached = readCachedContentInspection({
      stateDir,
      filePath: resource.file_path,
      purpose: work.purpose,
      sheet: work.sheet,
      maxCharacters: work.max_characters ?? 4000,
      cacheReference: work.cache_reference,
    });
    if (!cached) return null;
    const summary = work.result_summary;
    if (!summary?.label) return { label: 'Local inspection result available', facts: [] };
    const facts = [
      Number.isFinite(summary.rows) ? `${summary.rows} rows` : null,
      Number.isFinite(summary.columns) ? `${summary.columns} fields` : null,
      Number.isFinite(summary.sheets) ? `${summary.sheets} sheets` : null,
      Number.isFinite(summary.pages) ? `${summary.pages} pages` : null,
      Number.isFinite(summary.paragraphs) ? `${summary.paragraphs} paragraphs` : null,
      Number.isFinite(summary.slides) ? `${summary.slides} slides` : null,
    ].filter(Boolean);
    return { label: summary.label, facts };
  } catch {
    return null;
  }
}

export function buildProjectResourcesModel({ project, root, base, recentWork, savedWork = [], currentActivity = [], resourceFacts = [], savedWorkError = false, focusedPath = null, focusedResourceId = null, selectedFolderPath = null, stateDir = null, activityReturnHref = null }) {
  const listed = searchProjectFiles(root, '');
  const requestedFolder = typeof selectedFolderPath === 'string' ? selectedFolderPath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '') : null;
  const folders = listProjectFolders(root);
  const requestedFolderExists = requestedFolder !== null
    && (requestedFolder === '' || folders.items.some((folder) => folder.relative_path === requestedFolder));
  const visibleItems = [...listed.items];
  if (requestedFolderExists) {
    for (const item of browseProjectFiles(root, requestedFolder).items.filter((entry) => entry.kind === 'file')) {
      if (!visibleItems.some((entry) => entry.relative_path === item.relative_path)) visibleItems.push(item);
    }
  }
  const records = visibleItems.map((item) => {
    const record = resourceRecord(item, root, recentWork, project.id, savedWork, currentActivity, resourceFacts);
    return { ...record, state: resourceState(record) };
  });
  const known_sources = records.filter((item) => item.added_from && !item.saved_work);
  const created_work = records.filter((item) => item.saved_work);
  const other_files = records.filter((item) => !item.added_from && !item.saved_work);
  const explicitFocus = typeof focusedPath === 'string' && focusedPath.length > 0;
  const ledgerFocus = typeof focusedResourceId === 'string' ? resourceFacts.find((item) => item.resource_id === focusedResourceId) ?? null : null;
  const diskLedgerFocus = ledgerFocus ? records.find((item) => item.resource_id === ledgerFocus.resource_id) ?? null : null;
  const ledgerRelativePath = ledgerFocus?.path
    ? path.relative(root, ledgerFocus.path).replaceAll('\\', '/')
    : null;
  const ledgerPathInsideProject = ledgerRelativePath && ledgerRelativePath !== '..'
    && !ledgerRelativePath.startsWith('../') && !path.posix.isAbsolute(ledgerRelativePath)
    ? ledgerRelativePath
    : null;
  const focusedPathRecord = ledgerFocus && !diskLedgerFocus && (explicitFocus || ledgerPathInsideProject)
    ? focusedRecord(root, explicitFocus ? focusedPath : ledgerPathInsideProject, recentWork, project.id, savedWork, currentActivity, resourceFacts)
    : null;
  const verifiedPathLedgerFocus = focusedPathRecord?.resource_id === ledgerFocus?.resource_id ? focusedPathRecord : null;
  const localLedgerFocus = diskLedgerFocus ?? verifiedPathLedgerFocus;
  const redoSave = ledgerFocus ? savedWork.find((item) => item.resource_id === ledgerFocus.resource_id && item.status === 'undone' && item.write?.redo_available === true) ?? null : null;
  const focused_resource = ledgerFocus ? localLedgerFocus ? { ...ledgerFocus, ...localLedgerFocus, relative_path: localLedgerFocus.relative_path, file_path: localLedgerFocus.file_path, open_available: true, state: localLedgerFocus.state, last_known_path: ledgerFocus.path, last_known_hash: ledgerFocus.content_hash, last_known_bytes: ledgerFocus.bytes, last_known_modified_at: ledgerFocus.modified_at }
    : { ...ledgerFocus, name: ledgerFocus.resource?.display_name ?? ledgerFocus.name ?? 'Resource', type: ledgerFocus.resource?.kind ?? 'Local file', relative_path: null, open_available: false, state: ledgerFocus.status, last_known_path: ledgerFocus.path, last_known_hash: ledgerFocus.content_hash, last_known_bytes: ledgerFocus.bytes, last_known_modified_at: ledgerFocus.modified_at }
    : explicitFocus
    ? records.find((item) => item.relative_path === focusedPath)
      ?? focusedRecord(root, focusedPath, recentWork, project.id, savedWork, currentActivity, resourceFacts)
    : null;
  const focused = focused_resource ? { ...focused_resource, redo_save: redoSave ? { save_id: redoSave.save_id ?? redoSave.work_id } : null, actions: recoveryActions(focused_resource, project.id), representation: representationFor(focused_resource, stateDir) } : null;
  const treeRecords = focused?.relative_path && !records.some((item) => item.relative_path === focused.relative_path)
    ? [...records, focused]
    : records;
  const tree = projectTree(treeRecords, folders.items);
  const focusFolder = focused?.relative_path?.split('/').slice(0, -1).join('/') ?? null;
  const selected_folder_path = focusFolder ?? (projectFolderPaths(tree).has(requestedFolder) ? requestedFolder : '');
  return {
    mode: 'explorer',
    project,
    root,
    base,
    known_sources,
    created_work,
    changed_resources: records.filter((resource) => resourceState(resource) === 'changed').length,
    current_output: null,
    other_files,
    tree,
    focused_resource: focused,
    selected_folder_path,
    selected_folder_explicit: explicitFocus || requestedFolder !== null,
    selected_folder_loaded: !listed.truncated || (requestedFolderExists && requestedFolder === selected_folder_path),
    focus_error: (explicitFocus || focusedResourceId) && !focused ? 'The requested Resource is unavailable. It may have moved or been removed.' : null,
    external_references: resourceFacts.filter((item) => item.relationship_to_project === 'used_by' && !item.locations?.some((location) => location.project_id === project.id && location.status === 'active')),
    missing_resources: resourceFacts.filter((item) => item.resource?.status === 'missing' || item.last_known_location?.status === 'missing'),
    activity_return_href: activityReturnHref,
    missing_sources: missingSources(savedWork),
    saved_work_error: savedWorkError,
    truncated: listed.truncated,
  };
}

export function buildProjectResourceDetailModel({ project, root, base, recentWork, savedWork = [], currentActivity = [], resourceFacts = [], relativePath }) {
  const target = contentFilePath(projectPath(root, relativePath));
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Choose a regular Project file.');
  const item = {
    name: path.basename(target),
    relative_path: path.relative(root, target).replaceAll('\\', '/'),
    bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
  };
  return {
    mode: 'detail',
    project,
    root,
    base,
    resource: resourceRecord(item, root, recentWork, project.id, savedWork, currentActivity, resourceFacts),
  };
}
