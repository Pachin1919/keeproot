import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contentFilePath } from '../../content-inspection.js';

export function realLocalFolder(folderPath) {
  const absolute = path.resolve(folderPath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Choose a real local folder, not a symbolic link or junction.');
  }
  return absolute;
}

export function createDesktopSelectionService({
  maxBatchFiles = 20,
  now = Date.now,
  selectionLifetimeMs = 5 * 60 * 1000,
  queueLifetimeMs = 30 * 60 * 1000,
} = {}) {
  const selections = new Map();
  const queues = new Map();

  function expire() {
    const currentTime = now();
    for (const [selectionId, value] of selections) {
      if (value.used || currentTime - value.created_at > selectionLifetimeMs) selections.delete(selectionId);
    }
    for (const [queueId, value] of queues) {
      if (!value.pending && currentTime - (value.updated_at ?? value.created_at) > queueLifetimeMs) queues.delete(queueId);
    }
  }

  function selection(selectionId, { consume = false, kind = null } = {}) {
    if (!/^SEL-[a-f0-9]{32}$/u.test(selectionId ?? '')) return null;
    const value = selections.get(selectionId);
    if (!value || value.used || now() - value.created_at > selectionLifetimeMs || (kind && value.kind !== kind)) {
      selections.delete(selectionId);
      return null;
    }
    if (consume) value.used = true;
    return value;
  }

  function queue(queueId) {
    if (!/^BQS-[a-f0-9]{32}$/u.test(queueId ?? '')) return null;
    const value = queues.get(queueId);
    if (!value || (!value.pending && now() - (value.updated_at ?? value.created_at) > queueLifetimeMs)) {
      queues.delete(queueId);
      return null;
    }
    return value;
  }

  function importItem(filePath, kind) {
    const supported = kind === 'file';
    return {
      item_id: `BQI-${crypto.randomBytes(12).toString('hex')}`,
      path: filePath,
      name: path.basename(filePath),
      type: kind === 'folder' ? 'Folder' : path.extname(filePath).slice(1).toUpperCase() || 'Local file',
      kind,
      supported,
      actionable: supported,
      reason: supported ? null : 'Atlas can select this folder, but the current Intake operation imports files only and does not copy folders.',
    };
  }

  function registerImport({ kind = 'file', paths = [], queueId = null } = {}) {
    const normalizedKind = kind === 'folder' ? 'folder' : 'file';
    const supplied = paths.filter(Boolean);
    if (!supplied.length || (normalizedKind === 'folder' && supplied.length !== 1)) {
      throw new Error('Atlas could not use this desktop selection.');
    }
    const selectedPaths = supplied.map((candidate) => (
      normalizedKind === 'folder' ? realLocalFolder(candidate) : contentFilePath(candidate)
    ));
    const appending = queueId != null && queueId !== '';
    const existing = appending ? queue(queueId) : null;
    if (appending && !existing) {
      throw new Error('This Selection Set is no longer available. Start a new Import.');
    }
    const currentTime = now();
    const result = existing ?? {
      queue_id: `BQS-${crypto.randomBytes(16).toString('hex')}`,
      created_at: currentTime,
      updated_at: currentTime,
      items: [],
    };
    const pathKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    const known = new Set(result.items.map((item) => pathKey(path.resolve(item.path))));
    const additions = selectedPaths
      .filter((selectedPath) => {
        const key = pathKey(path.resolve(selectedPath));
        if (known.has(key)) return false;
        known.add(key);
        return true;
      })
      .map((selectedPath) => importItem(selectedPath, normalizedKind));
    if (result.items.length + additions.length > maxBatchFiles) {
      throw new Error(`Choose up to ${maxBatchFiles} local files or folders for one Import.`);
    }
    result.items.push(...additions);
    result.updated_at = currentTime;
    queues.set(result.queue_id, result);
    return { kind: 'queue', queue: result };
  }

  function register({ kind = 'file', mode = 'single', paths = [] } = {}) {
    const normalizedKind = kind === 'folder' ? 'folder' : 'file';
    const normalizedMode = mode === 'multiple' ? 'multiple' : 'single';
    const supplied = paths.filter(Boolean);
    if (!supplied.length || (normalizedKind === 'folder' && (normalizedMode !== 'single' || supplied.length !== 1))) {
      throw new Error('Atlas could not use this desktop selection.');
    }
    if (normalizedMode === 'multiple' && (normalizedKind !== 'file' || supplied.length > maxBatchFiles)) {
      throw new Error(`Choose up to ${maxBatchFiles} local files at one time.`);
    }
    const selectedPaths = supplied.map((candidate) => (
      normalizedKind === 'folder' ? realLocalFolder(candidate) : contentFilePath(candidate)
    ));
    if (normalizedMode === 'multiple') {
      const queueId = `BQS-${crypto.randomBytes(16).toString('hex')}`;
      const result = {
        queue_id: queueId,
        created_at: now(),
        items: selectedPaths.map((filePath) => ({
          item_id: `BQI-${crypto.randomBytes(12).toString('hex')}`,
          path: filePath,
          name: path.basename(filePath),
          type: path.extname(filePath).slice(1).toUpperCase() || 'Local file',
        })),
      };
      queues.set(queueId, result);
      return { kind: 'queue', queue: result };
    }
    const filePath = selectedPaths[0];
    const selectionId = `SEL-${crypto.randomBytes(16).toString('hex')}`;
    const result = {
      selection_id: selectionId,
      path: filePath,
      kind: normalizedKind,
      created_at: now(),
      used: false,
    };
    selections.set(selectionId, result);
    return { kind: 'selection', selection: result };
  }

  function removeFromQueue(queueId, itemId) {
    const value = queue(queueId);
    if (!value) return null;
    value.items = value.items.filter((item) => item.item_id !== itemId);
    value.updated_at = now();
    return value;
  }

  function setQueuePending(queueId, pending) {
    const value = pending ? queue(queueId) : queues.get(queueId);
    if (!value) return null;
    value.pending = Boolean(pending);
    value.updated_at = now();
    return value;
  }

  function clearQueue(queueId) {
    queues.delete(queueId);
  }

  return {
    register,
    registerImport,
    selection,
    queue,
    removeFromQueue,
    setQueuePending,
    clearQueue,
    expire,
    clear() {
      selections.clear();
      queues.clear();
    },
  };
}
