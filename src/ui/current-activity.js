import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectionInitiator } from '../work-coordination.js';

function activityPath(stateDir) {
  return path.join(path.resolve(stateDir), 'ui', 'current-activity.json');
}

function activityError(error) {
  const result = new Error('Current activity could not be loaded.');
  result.code = 'ATLAS_CURRENT_ACTIVITY_UNAVAILABLE';
  result.cause = error;
  return result;
}

function validProject(value) {
  return value && typeof value.id === 'string' && typeof value.name === 'string'
    ? { id: value.id, name: value.name }
    : null;
}

function validRecord(value) {
  if (!value || typeof value !== 'object' || !/^ACT-[a-f0-9-]{36}$/u.test(value.activity_id ?? '')) return null;
  if (typeof value.file_path !== 'string' || !['running', 'waiting', 'failed'].includes(value.status)) return null;
  const started = typeof value.started_at === 'string' ? value.started_at : null;
  if (!started) return null;
  const stale = value.status === 'running' && Date.now() - Date.parse(started) > 30 * 60 * 1000;
  return {
    activity_id: value.activity_id,
    file_path: path.resolve(value.file_path),
    purpose: typeof value.purpose === 'string' ? value.purpose : 'content',
    status: stale ? 'interrupted' : value.status,
    started_at: started,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : started,
    error_message: typeof value.error_message === 'string' ? value.error_message : null,
    recovery_href: typeof value.recovery_href === 'string' && value.recovery_href.startsWith('/') ? value.recovery_href : null,
    recovery_label: typeof value.recovery_label === 'string' ? value.recovery_label : null,
    initiated_by: value.initiated_by && typeof value.initiated_by === 'object' ? value.initiated_by : null,
    project: validProject(value.project),
  };
}

export function readCurrentActivityState(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(activityPath(stateDir), 'utf8'));
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('Current activity has an invalid structure.');
    const items = parsed.items.map(validRecord);
    if (items.some((item) => !item)) throw new Error('Current activity contains an invalid entry.');
    return { items: items.sort((left, right) => right.started_at.localeCompare(left.started_at)), error: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { items: [], error: null };
    return { items: [], error: activityError(error) };
  }
}

function writableItems(stateDir) {
  const state = readCurrentActivityState(stateDir);
  if (state.error) throw state.error;
  return state.items.map((item) => ({ ...item, status: item.status === 'interrupted' ? 'running' : item.status }));
}

function writeItems(stateDir, items) {
  const target = activityPath(stateDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function beginCurrentActivity({ stateDir, filePath, purpose = 'content', caller = {}, project = null, channel = 'host' }) {
  const now = new Date().toISOString();
  const items = writableItems(stateDir);
  const record = {
    activity_id: `ACT-${crypto.randomUUID()}`,
    file_path: path.resolve(filePath),
    purpose,
    status: 'running',
    started_at: now,
    updated_at: now,
    error_message: null,
    recovery_href: null,
    recovery_label: null,
    initiated_by: inspectionInitiator(caller, channel),
    project: validProject(project),
  };
  writeItems(stateDir, [record, ...items.filter((item) => {
    const sameRun = record.initiated_by.client_run_id
      && item.initiated_by?.client_run_id === record.initiated_by.client_run_id;
    return item.status !== 'running' || !sameRun;
  })]);
  return record;
}

export function waitCurrentActivity({ stateDir, activityId, reason, recoveryHref, recoveryLabel }) {
  const items = writableItems(stateDir);
  const index = items.findIndex((item) => item.activity_id === activityId);
  if (index < 0) return null;
  items[index] = {
    ...items[index],
    status: 'waiting',
    updated_at: new Date().toISOString(),
    error_message: String(reason ?? 'Atlas needs a choice before it can continue.').slice(0, 300),
    recovery_href: typeof recoveryHref === 'string' && recoveryHref.startsWith('/') ? recoveryHref : null,
    recovery_label: typeof recoveryLabel === 'string' ? recoveryLabel.slice(0, 120) : null,
  };
  writeItems(stateDir, items);
  return items[index];
}

export function resumeCurrentActivity({ stateDir, activityId }) {
  const items = writableItems(stateDir);
  const index = items.findIndex((item) => item.activity_id === activityId);
  if (index < 0) return null;
  items[index] = {
    ...items[index],
    status: 'running',
    updated_at: new Date().toISOString(),
    error_message: null,
    recovery_href: null,
    recovery_label: null,
  };
  writeItems(stateDir, items);
  return items[index];
}

export function failCurrentActivity({ stateDir, activityId, error, recoveryHref = null, recoveryLabel = null }) {
  const items = writableItems(stateDir);
  const index = items.findIndex((item) => item.activity_id === activityId);
  if (index < 0) return null;
  items[index] = {
    ...items[index],
    status: 'failed',
    updated_at: new Date().toISOString(),
    error_message: String(error?.message ?? error ?? 'Host work stopped.').slice(0, 300),
    recovery_href: typeof recoveryHref === 'string' && recoveryHref.startsWith('/') ? recoveryHref : null,
    recovery_label: typeof recoveryLabel === 'string' ? recoveryLabel.slice(0, 120) : null,
  };
  writeItems(stateDir, items);
  return items[index];
}

export function finishCurrentActivity(stateDir, activityId) {
  const items = writableItems(stateDir);
  const remaining = items.filter((item) => item.activity_id !== activityId);
  if (remaining.length === items.length) return false;
  writeItems(stateDir, remaining);
  return true;
}
