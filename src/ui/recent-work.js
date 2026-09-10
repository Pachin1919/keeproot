import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RECENT_WORK_LOCK_TIMEOUT_MS = 2_000;
const RECENT_WORK_LOCK_POLL_MS = 5;
const recentWorkLockWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function recentWorkPath(stateDir) {
  return path.join(path.resolve(stateDir), 'ui', 'recent-work.json');
}

function acquireRecentWorkLock(stateDir) {
  const lockPath = `${recentWorkPath(stateDir)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + RECENT_WORK_LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, 'utf8');
        return { descriptor, lockPath };
      } catch (error) {
        fs.closeSync(descriptor);
        fs.rmSync(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      Atomics.wait(recentWorkLockWait, 0, 0, RECENT_WORK_LOCK_POLL_MS);
    }
  }
  const error = new Error('Recent Work is busy with another local update. Try this action again.');
  error.code = 'ATLAS_RECENT_WORK_BUSY';
  throw error;
}

function releaseRecentWorkLock(lock) {
  try {
    fs.closeSync(lock.descriptor);
  } finally {
    fs.rmSync(lock.lockPath, { force: true });
  }
}

function recentWorkError(error) {
  const result = new Error('Recent Work could not be loaded.');
  result.code = 'ATLAS_RECENT_WORK_UNAVAILABLE';
  result.cause = error;
  return result;
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function effectiveRecentTime(record) {
  return [record?.inspected_at, record?.last_continued_at]
    .filter((value) => typeof value === 'string')
    .sort()
    .at(-1) ?? '';
}

function validFingerprint(value) {
  if (!value || typeof value.sha256 !== 'string') return null;
  return {
    sha256: value.sha256,
    bytes: Number.isFinite(value.bytes) ? value.bytes : null,
    modified_ns: Number.isFinite(value.modified_ns) ? value.modified_ns : null,
  };
}

function validProject(value) {
  return value && typeof value === 'object' && typeof value.id === 'string' && typeof value.name === 'string'
    ? { id: value.id, name: value.name }
    : null;
}

function validInitiator(value) {
  if (!value || typeof value !== 'object') return null;
  const channel = ['host', 'desktop', 'local'].includes(value.channel) ? value.channel : 'local';
  return {
    channel,
    actor: typeof value.actor === 'string' ? value.actor : 'unknown',
    agent: typeof value.agent === 'string' ? value.agent : null,
    model: typeof value.model === 'string' ? value.model : null,
    tool: typeof value.tool === 'string' ? value.tool : null,
    client_run_id: typeof value.client_run_id === 'string' ? value.client_run_id : null,
  };
}

function validResultSummary(value) {
  if (!value || typeof value !== 'object' || typeof value.label !== 'string') return null;
  const result = { label: value.label };
  for (const key of ['rows', 'columns', 'sheets', 'pages', 'paragraphs', 'slides']) {
    if (Number.isFinite(value[key])) result[key] = value[key];
  }
  return result;
}

function validTransfer(value) {
  if (!value || typeof value !== 'object' || typeof value.run_id !== 'string'
      || typeof value.target_path !== 'string' || typeof value.saved_at !== 'string'
      || typeof value.undo_available !== 'boolean') return null;
  const origin = value.origin;
  const fingerprint = validFingerprint(origin?.source_fingerprint);
  if (!origin || typeof origin.file_path !== 'string' || typeof origin.inspection_id !== 'string'
      || typeof origin.cache_reference !== 'string' || !fingerprint) return null;
  return {
    run_id: value.run_id,
    target_path: path.resolve(value.target_path),
    saved_at: value.saved_at,
    undo_available: value.undo_available,
    origin: {
      file_path: path.resolve(origin.file_path),
      source_fingerprint: fingerprint,
      inspection_id: origin.inspection_id,
      cache_reference: origin.cache_reference,
      project: validProject(origin.project),
    },
  };
}

function validRecord(value) {
  if (!value || typeof value !== 'object' || !/^RWK-[a-f0-9-]{36}$/u.test(value.work_id ?? '')) return null;
  if (typeof value.file_path !== 'string' || typeof value.inspection_id !== 'string') return null;
  const fingerprint = validFingerprint(value.source_fingerprint);
  if (!fingerprint) return null;
  if (!value.inspect || typeof value.inspect !== 'object' || typeof value.cache_reference !== 'string') return null;
  return {
    work_id: value.work_id,
    file_path: path.resolve(value.file_path),
    last_action: value.last_action === 'inspect' ? 'inspect' : 'inspect',
    inspect: {
      purpose: typeof value.inspect.purpose === 'string' ? value.inspect.purpose : 'content',
      sheet: typeof value.inspect.sheet === 'string' ? value.inspect.sheet : null,
      max_characters: Number.isInteger(value.inspect.max_characters) ? value.inspect.max_characters : 4000,
    },
    source_fingerprint: fingerprint,
    inspection_id: value.inspection_id,
    cache_reference: value.cache_reference,
    inspected_at: typeof value.inspected_at === 'string' ? value.inspected_at : null,
    last_continued_at: typeof value.last_continued_at === 'string' ? value.last_continued_at : null,
    project: validProject(value.project),
    project_transfer: value.project_transfer == null ? null : validTransfer(value.project_transfer),
    initiated_by: validInitiator(value.initiated_by),
    inspection_cache_hit: value.inspection_cache_hit === true,
    result_summary: validResultSummary(value.result_summary),
  };
}

export function readRecentWorkState(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(recentWorkPath(stateDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      throw new Error('Recent Work has an invalid structure.');
    }
    const records = parsed.items.map(validRecord);
    if (records.some((record) => !record)) {
      throw new Error('Recent Work contains an invalid entry.');
    }
    return {
      items: records.sort((left, right) => {
      const leftTime = effectiveRecentTime(left);
      const rightTime = effectiveRecentTime(right);
      return String(rightTime).localeCompare(String(leftTime));
      }),
      error: null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { items: [], error: null };
    return { items: [], error: recentWorkError(error) };
  }
}

export function readRecentWork(stateDir) {
  const state = readRecentWorkState(stateDir);
  if (state.error) throw state.error;
  return state.items;
}

function writableRecentWork(stateDir) {
  const state = readRecentWorkState(stateDir);
  if (state.error) throw state.error;
  return state.items;
}

function writeRecentWork(stateDir, records) {
  const target = recentWorkPath(stateDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ items: records }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function mutateRecentWork(stateDir, mutator) {
  if (typeof mutator !== 'function') throw new Error('Recent Work mutation requires a function.');
  const lock = acquireRecentWorkLock(stateDir);
  try {
    const records = writableRecentWork(stateDir);
    const result = mutator(records);
    if (!result || !Array.isArray(result.records)) {
      throw new Error('Recent Work mutation must return the complete record set.');
    }
    if (result.write !== false) writeRecentWork(stateDir, result.records);
    return result.value;
  } finally {
    releaseRecentWorkLock(lock);
  }
}

export function recentWorkById(stateDir, workId) {
  if (!/^RWK-[a-f0-9-]{36}$/u.test(workId ?? '')) return null;
  return readRecentWork(stateDir).find((item) => item.work_id === workId) ?? null;
}

export function upsertRecentWork({
  stateDir, filePath, inspect, sourceFingerprint, inspectionId, cacheReference, project = null,
  initiatedBy = null, inspectionCacheHit = false, resultSummary = null,
}) {
  const normalizedPath = path.resolve(filePath);
  const now = new Date().toISOString();
  return mutateRecentWork(stateDir, (existing) => {
    const previous = existing.find((item) => samePath(item.file_path, normalizedPath));
    const record = {
      work_id: previous?.work_id ?? `RWK-${crypto.randomUUID()}`,
      file_path: normalizedPath,
      last_action: 'inspect',
      inspect: {
        purpose: inspect.purpose,
        sheet: inspect.sheet ?? null,
        max_characters: inspect.maxCharacters,
      },
      source_fingerprint: sourceFingerprint,
      inspection_id: inspectionId,
      cache_reference: cacheReference,
      inspected_at: now,
      last_continued_at: previous?.last_continued_at ?? null,
      project: project ?? previous?.project ?? null,
      project_transfer: previous?.project_transfer ?? null,
      initiated_by: validInitiator(initiatedBy) ?? previous?.initiated_by ?? null,
      inspection_cache_hit: inspectionCacheHit === true,
      result_summary: validResultSummary(resultSummary) ?? previous?.result_summary ?? null,
    };
    return {
      records: [record, ...existing.filter((item) => !samePath(item.file_path, normalizedPath))],
      value: record,
    };
  });
}

export function touchRecentWork(stateDir, workId) {
  return mutateRecentWork(stateDir, (records) => {
    const index = records.findIndex((item) => item.work_id === workId);
    if (index < 0) return { records, value: null, write: false };
    const record = { ...records[index], last_continued_at: new Date().toISOString() };
    records[index] = record;
    return { records, value: record };
  });
}

export function setRecentWorkProject(stateDir, workId, project) {
  if (!/^RWK-[a-f0-9-]{36}$/u.test(workId ?? '')) return null;
  if (project != null && (typeof project.id !== 'string' || typeof project.name !== 'string')) {
    throw new Error('Recent Work Project must include an id and name.');
  }
  return mutateRecentWork(stateDir, (records) => {
    const index = records.findIndex((item) => item.work_id === workId);
    if (index < 0) return { records, value: null, write: false };
    const record = {
      ...records[index],
      project: project ? { id: project.id, name: project.name } : null,
    };
    records[index] = record;
    return { records, value: record };
  });
}

export function moveRecentWorkToProjectArtifact({
  stateDir, workId, targetPath, sourceFingerprint, inspectionId, cacheReference, project, transfer,
}) {
  if (!/^RWK-[a-f0-9-]{36}$/u.test(workId ?? '')) return null;
  const fingerprint = validFingerprint(sourceFingerprint);
  const projectValue = validProject(project);
  const transferValue = validTransfer(transfer);
  if (!fingerprint || !projectValue || !transferValue || typeof inspectionId !== 'string' || typeof cacheReference !== 'string') {
    throw new Error('Recent Work requires one verified Project artifact and reversible transfer.');
  }
  return mutateRecentWork(stateDir, (records) => {
    const index = records.findIndex((item) => item.work_id === workId);
    if (index < 0) return { records, value: null, write: false };
    const record = {
      ...records[index],
      file_path: path.resolve(targetPath),
      source_fingerprint: fingerprint,
      inspection_id: inspectionId,
      cache_reference: cacheReference,
      project: projectValue,
      project_transfer: transferValue,
    };
    records[index] = record;
    return { records, value: record };
  });
}

export function restoreRecentWorkProjectTransfer({ stateDir, workId, project = null }) {
  if (!/^RWK-[a-f0-9-]{36}$/u.test(workId ?? '')) return null;
  return mutateRecentWork(stateDir, (records) => {
    const index = records.findIndex((item) => item.work_id === workId);
    if (index < 0) return { records, value: null, write: false };
    const transfer = records[index].project_transfer;
    if (!transfer?.undo_available) return { records, value: null, write: false };
    const record = {
      ...records[index],
      file_path: transfer.origin.file_path,
      source_fingerprint: transfer.origin.source_fingerprint,
      inspection_id: transfer.origin.inspection_id,
      cache_reference: transfer.origin.cache_reference,
      project: validProject(project) ?? transfer.origin.project,
      project_transfer: null,
    };
    records[index] = record;
    return { records, value: record };
  });
}

export function removeRecentWork(stateDir, workId) {
  if (!/^RWK-[a-f0-9-]{36}$/u.test(workId ?? '')) return false;
  return mutateRecentWork(stateDir, (records) => {
    const remaining = records.filter((item) => item.work_id !== workId);
    if (remaining.length === records.length) return { records, value: false, write: false };
    return { records: remaining, value: true };
  });
}
