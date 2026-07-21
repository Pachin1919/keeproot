import crypto from 'node:crypto';
import path from 'node:path';
import { Ledger } from './ledger.js';

function timestamp() {
  return new Date().toISOString();
}

function projectId() {
  return `PRJ-${crypto.randomUUID()}`;
}

function normalizeName(value, field = 'Project name') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim().normalize('NFC');
}

function normalizeProjectPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Project path is required.');
  const input = value.trim();
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || input.startsWith('/')) {
    throw new Error('Project path must be relative to the registered environment.');
  }
  const portable = input.replace(/\\/g, '/').normalize('NFC');
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Project path cannot escape the registered environment.');
  }
  return normalized;
}

function normalizeAliases(values = []) {
  if (!Array.isArray(values)) throw new Error('Project aliases must be an array.');
  return [...new Set(values.map((value) => normalizeName(value, 'Project alias')))];
}

export class Registry {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('Registry requires a stateDir');
    this.stateDir = path.resolve(stateDir);
    this._ledger = null;
  }

  get ledger() {
    if (!this._ledger) this._ledger = new Ledger(this.stateDir);
    return this._ledger;
  }

  create({
    name,
    currentPath,
    aliases = [],
    status = 'active',
    parentProjectId = null,
    splitFrom = [],
  }) {
    if (!['active', 'paused', 'archived'].includes(status)) {
      throw new Error(`Unsupported initial Project status: ${status}`);
    }
    if (!Array.isArray(splitFrom)) throw new Error('splitFrom must be an array of Project IDs.');
    const createdAt = timestamp();
    const id = projectId();
    this.ledger.createProject({
      projectId: id,
      name: normalizeName(name),
      currentPath: normalizeProjectPath(currentPath),
      aliases: normalizeAliases(aliases),
      status,
      parentProjectId,
      splitFrom: [...new Set(splitFrom)],
      createdAt,
    });
    return { project_id: id, status, created_at: createdAt };
  }

  update(projectIdValue, {
    name,
    currentPath,
    aliases = [],
    status,
    reason = null,
  }) {
    const existing = this.ledger.getProject(projectIdValue);
    if (status != null && !['active', 'paused', 'archived'].includes(status)) {
      throw new Error(`Unsupported Project status: ${status}`);
    }
    const updatedAt = timestamp();
    this.ledger.updateProject(projectIdValue, {
      name: name == null ? existing.name : normalizeName(name),
      currentPath: currentPath == null ? existing.current_path : normalizeProjectPath(currentPath),
      aliases: normalizeAliases(aliases),
      status: status ?? existing.status,
      reason,
      updatedAt,
    });
    return { project_id: projectIdValue, status: status ?? existing.status, updated_at: updatedAt };
  }

  evolve(projectIdValue, {
    name = null,
    aliases = [],
    status = null,
    reason = null,
  } = {}) {
    if (name == null && !aliases.length && status == null) {
      throw new Error('Project evolve requires a name, alias, or status change.');
    }
    const existing = this.ledger.getProject(projectIdValue);
    const normalizedName = name == null ? existing.name : normalizeName(name);
    const preservedAliases = normalizedName === existing.name ? aliases : [existing.name, ...aliases];
    const updated = this.update(projectIdValue, {
      name: normalizedName,
      currentPath: existing.current_path,
      aliases: preservedAliases,
      status,
      reason,
    });
    return {
      ...updated,
      semantic_only: true,
      current_path: existing.current_path,
      source_changes: [],
    };
  }

  merge(sourceProjectIds, targetProjectId) {
    if (!Array.isArray(sourceProjectIds) || sourceProjectIds.length === 0) {
      throw new Error('merge requires at least one source Project ID.');
    }
    const sources = [...new Set(sourceProjectIds)];
    const effectiveAt = timestamp();
    this.ledger.mergeProjects(sources, targetProjectId, effectiveAt);
    return { source_project_ids: sources, target_project_id: targetProjectId, effective_at: effectiveAt };
  }

  show(projectIdValue) {
    return this.ledger.getProjectDetail(projectIdValue);
  }

  list() {
    return this.ledger.listProjects();
  }

  dispose() {
    if (this._ledger) this._ledger.close();
    this._ledger = null;
  }
}
