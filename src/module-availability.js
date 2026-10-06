import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withStateLock } from './state-lock.js';

export const FIRST_PARTY_MODULES = Object.freeze([
  Object.freeze({
    module_id: 'atlas.capture-source', module_version: '1.0.0', contract: 'static_first_party',
    actions: Object.freeze(['inspect-export', 'prepare-export', 'capture-url', 'show', 'read']),
    readable_actions: Object.freeze(['show', 'read']),
  }),
  Object.freeze({
    module_id: 'atlas.table-work', module_version: '1.0.0', contract: 'static_first_party',
    actions: Object.freeze(['start', 'list', 'show', 'reuse', 'replace-sources', 'reconcile', 'reconcile-batch', 'add-source', 'remove-source', 'prepare', 'sheet', 'align', 'recipe', 'preview', 'read-preview', 'prepare-save', 'confirm-save', 'save']),
    readable_actions: Object.freeze(['list', 'show', 'read-preview']),
  }),
]);

const MODULE_BY_ID = new Map(FIRST_PARTY_MODULES.map((module) => [module.module_id, module]));
const STATE_VERSION = 1;
const MAX_REASON = 300;
const MAX_REQUEST_KEY = 200;

function availabilityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function defaultState() {
  return {
    version: STATE_VERSION,
    modules: Object.fromEntries(FIRST_PARTY_MODULES.map((module) => [module.module_id, { enabled: true, revision: 0 }])),
    requests: {},
  };
}

function assertPathEntry(target, kind) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) throw availabilityError('ATLAS_PATH_BOUNDARY', `Module availability ${kind} must not be a symbolic link or junction: ${target}`);
  if (kind === 'directory' && !stat.isDirectory()) throw availabilityError('ATLAS_PATH_BOUNDARY', `Module availability path component is not a directory: ${target}`);
  if (kind === 'file' && !stat.isFile()) throw availabilityError('ATLAS_PATH_BOUNDARY', `Module availability state is not a regular file: ${target}`);
  try {
    const actual = fs.realpathSync.native(target);
    if (!samePath(actual, target)) throw availabilityError('ATLAS_PATH_BOUNDARY', `Module availability ${kind} resolves through a linked path: ${target}`);
  } catch (error) {
    if (error.code === 'ATLAS_PATH_BOUNDARY') throw error;
    throw availabilityError('ATLAS_PATH_BOUNDARY', `Module availability ${kind} cannot be resolved safely: ${target}`);
  }
  return true;
}

function ensureDirectoryChain(target, { create = false } = {}) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!assertPathEntry(current, 'directory')) {
      if (!create) return false;
      try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      assertPathEntry(current, 'directory');
    }
  }
  return true;
}

function validateState(value) {
  if (!value || value.version !== STATE_VERSION || !value.modules || typeof value.modules !== 'object' || Array.isArray(value.modules)
    || !value.requests || typeof value.requests !== 'object' || Array.isArray(value.requests)) {
    throw availabilityError('ATLAS_MODULE_STATE_INVALID', 'Module availability state has an unsupported or invalid format.');
  }
  for (const module of FIRST_PARTY_MODULES) {
    const entry = value.modules[module.module_id];
    if (!entry || typeof entry.enabled !== 'boolean' || !Number.isSafeInteger(entry.revision) || entry.revision < 0) {
      throw availabilityError('ATLAS_MODULE_STATE_INVALID', `Module availability state is invalid for ${module.module_id}.`);
    }
  }
  for (const [key, record] of Object.entries(value.requests)) {
    if (key.length > MAX_REQUEST_KEY + 80 || !record || typeof record.digest !== 'string' || !record.receipt || typeof record.receipt !== 'object') {
      throw availabilityError('ATLAS_MODULE_STATE_INVALID', 'Module availability request history is invalid.');
    }
  }
  return value;
}

export function createModuleAvailabilityService({ stateDir } = {}) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error('Module availability requires an explicit state directory.');
  const root = path.resolve(stateDir);
  const statePath = path.join(root, 'module-availability.json');
  const lockPath = path.join(root, 'locks', 'runtime.lock');

  const read = () => {
    if (!ensureDirectoryChain(root)) return defaultState();
    if (!assertPathEntry(statePath, 'file')) return defaultState();
    const stat = fs.statSync(statePath);
    if (stat.size > 1024 * 1024) throw availabilityError('ATLAS_MODULE_STATE_INVALID', 'Module availability state exceeds 1 MiB.');
    try { return validateState(JSON.parse(fs.readFileSync(statePath, 'utf8'))); }
    catch (error) {
      if (error.code === 'ATLAS_MODULE_STATE_INVALID' || error.code === 'ATLAS_PATH_BOUNDARY') throw error;
      throw availabilityError('ATLAS_MODULE_STATE_INVALID', 'Module availability state could not be read.');
    }
  };

  const write = (state) => {
    assertPathEntry(statePath, 'file');
    const temporary = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      assertPathEntry(statePath, 'file');
      fs.renameSync(temporary, statePath);
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  };

  const locked = (callback) => {
    ensureDirectoryChain(root, { create: true });
    ensureDirectoryChain(path.dirname(lockPath), { create: true });
    assertPathEntry(lockPath, 'file');
    return withStateLock(root, callback);
  };

  const get = (moduleId) => {
    const descriptor = MODULE_BY_ID.get(moduleId);
    if (!descriptor) throw availabilityError('ATLAS_MODULE_NOT_FOUND', `Unknown first-party Module: ${moduleId ?? '(missing)'}.`);
    const entry = read().modules[moduleId];
    return { ...descriptor, actions: [...descriptor.actions], readable_actions: [...descriptor.readable_actions], enabled: entry.enabled, revision: entry.revision };
  };

  const list = () => FIRST_PARTY_MODULES.map((module) => get(module.module_id));

  const assertActionEnabled = (moduleId, action) => {
    const module = get(moduleId);
    if (!module.enabled && !module.readable_actions.includes(action)) {
      throw availabilityError('ATLAS_MODULE_DISABLED', `${module.module_id} is disabled; ${action} is unavailable until it is enabled.`);
    }
    return module;
  };

  const change = ({ moduleId, enabled, expectedRevision, requestKey, reason }) => {
    if (!MODULE_BY_ID.has(moduleId)) throw availabilityError('ATLAS_MODULE_NOT_FOUND', `Unknown first-party Module: ${moduleId ?? '(missing)'}.`);
    if (typeof enabled !== 'boolean') throw availabilityError('ATLAS_INVALID_ARGUMENT', 'Module enabled state must be true or false.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw availabilityError('ATLAS_INVALID_ARGUMENT', 'Module change requires a non-negative expected revision.');
    if (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > MAX_REQUEST_KEY) throw availabilityError('ATLAS_INVALID_ARGUMENT', `Module change requires a request key of 1 to ${MAX_REQUEST_KEY} characters.`);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > MAX_REASON) throw availabilityError('ATLAS_INVALID_ARGUMENT', `Module change requires a reason of 1 to ${MAX_REASON} characters.`);
    const key = `${moduleId}:${requestKey.trim()}`;
    const input = { module_id: moduleId, enabled, expected_revision: expectedRevision, request_key: requestKey.trim(), reason: reason.trim() };
    const digest = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return locked(() => {
      const state = read();
      const prior = state.requests[key];
      if (prior) {
        if (prior.digest !== digest) throw availabilityError('ATLAS_STATE_CONFLICT', 'This Module request key was already used for different input.');
        return { ...prior.receipt, replayed: true };
      }
      const current = state.modules[moduleId];
      if (current.revision !== expectedRevision) throw availabilityError('ATLAS_STATE_CONFLICT', 'The Module availability revision changed; reload module status before continuing.');
      const changed = current.enabled !== enabled;
      const next = { enabled, revision: changed ? current.revision + 1 : current.revision };
      const receipt = { module_id: moduleId, enabled, revision: next.revision, changed, request_key: input.request_key, reason: input.reason, replayed: false };
      state.modules[moduleId] = next;
      state.requests[key] = { digest, receipt };
      write(state);
      return receipt;
    });
  };

  return { stateDir: root, get, list, change, assertActionEnabled };
}
