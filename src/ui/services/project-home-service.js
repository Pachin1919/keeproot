import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withStateLock } from '../../state-lock.js';

const SCHEMA = 'atlas-project-home.v1';
const PIN_KINDS = new Set(['resource', 'result', 'view']);
const CONTINUE_KINDS = new Set(['resource', 'result', 'view', 'work', 'files']);
const ORIGIN_KINDS = new Set(['files', 'view', 'work']);

function statePath(stateDir) {
  return path.join(path.resolve(stateDir), 'ui', 'project-home.json');
}

function assertStatePaths(stateDir) {
  for (const target of [statePath(stateDir), path.join(path.resolve(stateDir), 'locks', 'runtime.lock')]) {
    let cursor = target;
    while (true) {
      try {
        if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Project Home state cannot traverse a symbolic link or junction.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
}

function shortString(value, maximum = 400) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}

function relativePath(value) {
  const candidate = shortString(value, 2_000)?.replaceAll('\\', '/') ?? null;
  if (candidate == null) return null;
  if (candidate.includes('\0') || /^[a-z]:/iu.test(candidate) || path.posix.isAbsolute(candidate)) return null;
  const normalized = path.posix.normalize(candidate);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '.' ? null : normalized;
}

function validOrigin(value) {
  if (!value || typeof value !== 'object' || !ORIGIN_KINDS.has(value.kind)) return null;
  return {
    kind: value.kind,
    id: shortString(value.id),
    folder: relativePath(value.folder),
    path: relativePath(value.path),
  };
}

function validReference(value, kinds) {
  if (!value || typeof value !== 'object' || !kinds.has(value.kind)) return null;
  const id = shortString(value.id);
  if (!id) return null;
  return {
    kind: value.kind,
    id,
    resource_id: shortString(value.resource_id),
    relative_path: relativePath(value.relative_path),
    label: shortString(value.label, 240),
    revision: Number.isInteger(value.revision) && value.revision > 0 ? value.revision : null,
    origin: validOrigin(value.origin),
    updated_at: shortString(value.updated_at, 80),
  };
}

function validCheck(value) {
  if (!value || typeof value !== 'object' || !['complete', 'failed'].includes(value.status)) return null;
  const checkedAt = shortString(value.checked_at, 80);
  if (!checkedAt) return null;
  return {
    status: value.status,
    checked_at: checkedAt,
    scope_label: shortString(value.scope_label, 240) ?? 'Tracked Project Resources',
    error_message: shortString(value.error_message, 300),
    changed_resources: Array.isArray(value.changed_resources) ? value.changed_resources.map((item) => ({
      resource_id: shortString(item?.resource_id),
      title: shortString(item?.title, 240),
      baseline_version: shortString(item?.baseline_version, 128),
      current_version: shortString(item?.current_version, 128),
    })).filter((item) => item.resource_id && item.current_version).slice(0, 100) : [],
  };
}

function validProject(value) {
  if (!value || typeof value !== 'object') return { pinned: [], continue: null, check: null };
  const pinned = Array.isArray(value.pinned)
    ? value.pinned.map((item) => validReference(item, PIN_KINDS)).filter(Boolean).slice(0, 50)
    : [];
  return {
    pinned: pinned.filter((item, index, all) => all.findIndex((other) => other.kind === item.kind && other.id === item.id) === index),
    continue: validReference(value.continue, CONTINUE_KINDS),
    check: validCheck(value.check),
  };
}

function readState(stateDir) {
  try {
    assertStatePaths(stateDir);
    const parsed = JSON.parse(fs.readFileSync(statePath(stateDir), 'utf8'));
    if (!parsed || parsed.schema !== SCHEMA || !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
      throw new Error('Project Home has an invalid structure.');
    }
    return {
      projects: Object.fromEntries(Object.entries(parsed.projects).map(([projectId, value]) => [projectId, validProject(value)])),
      error: null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { projects: {}, error: null };
    const result = new Error('Project Home state could not be loaded.');
    result.code = 'ATLAS_PROJECT_HOME_UNAVAILABLE';
    result.cause = error;
    return { projects: {}, error: result };
  }
}

function writeState(stateDir, projects) {
  assertStatePaths(stateDir);
  const target = statePath(stateDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.project-home-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ schema: SCHEMA, projects }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readProjectHomeState(stateDir) {
  return readState(stateDir);
}

export function createProjectHomeService({ stateDir, now = () => new Date().toISOString() }) {
  const project = (projectId) => {
    const state = readState(stateDir);
    return { ...validProject(state.projects[projectId]), error: state.error };
  };
  const update = (projectId, callback) => {
    assertStatePaths(stateDir);
    return withStateLock(stateDir, () => {
      const state = readState(stateDir);
      if (state.error) throw state.error;
      const current = validProject(state.projects[projectId]);
      const next = validProject(callback(current));
      writeState(stateDir, { ...state.projects, [projectId]: next });
      return next;
    });
  };
  const pin = (projectId, reference) => {
    const item = validReference({ ...reference, updated_at: reference.updated_at ?? now() }, PIN_KINDS);
    if (!item) throw new Error('Choose a supported Project item to pin.');
    return update(projectId, (current) => ({
      ...current,
      pinned: [...current.pinned.filter((entry) => entry.kind !== item.kind || entry.id !== item.id), item],
    }));
  };
  const unpin = (projectId, { kind, id }) => {
    if (!PIN_KINDS.has(kind) || !shortString(id)) throw new Error('Choose a supported pinned item.');
    return update(projectId, (current) => ({
      ...current,
      pinned: current.pinned.filter((entry) => entry.kind !== kind || entry.id !== id),
    }));
  };
  const recordContinue = (projectId, reference) => {
    const item = validReference({ ...reference, updated_at: reference.updated_at ?? now() }, CONTINUE_KINDS);
    if (!item) throw new Error('Choose a supported Project item to continue.');
    return update(projectId, (current) => ({ ...current, continue: item }));
  };
  const recordCheck = (projectId, { status, scopeLabel, errorMessage = null, changedResources = [] }) => {
    if (!['complete', 'failed'].includes(status)) throw new Error('Project check status is unsupported.');
    return update(projectId, (current) => ({
      ...current,
      check: {
        status,
        checked_at: now(),
        scope_label: shortString(scopeLabel, 240) ?? 'Tracked Project Resources',
        error_message: status === 'failed' ? shortString(errorMessage, 300) ?? 'The tracked Resource check did not finish.' : null,
        changed_resources: status === 'complete' ? changedResources : [],
      },
    }));
  };
  return { project, pin, unpin, recordContinue, recordCheck };
}
