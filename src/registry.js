import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from './ledger.js';
import { isPathInside, normalizeRoot } from './paths.js';
import { captureProjectIdentity, compareProjectIdentity } from './project-identity.js';
import { ProjectContextRepository } from './storage/repositories/project-context-repository.js';

const ROOT_TYPES = new Set([
  'managed_library',
  'source_repository',
  'project_workspace',
  'workspace_container',
  'shared_asset',
  'tool_source',
]);
const CONTENT_POLICIES = new Set(['structure_only', 'bounded_content']);

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

function normalizeReason(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} requires a reason.`);
  return value.trim().normalize('NFC');
}

function normalizePurpose(value) {
  const purpose = normalizeName(value, 'Context purpose').toLowerCase().replace(/[\s-]+/gu, '_');
  if (!/^[a-z0-9][a-z0-9_]{1,63}$/u.test(purpose)) {
    throw new Error('Context purpose must be a lowercase identifier with 2 to 64 characters.');
  }
  return purpose;
}

function normalizeExtensions(values = []) {
  if (!Array.isArray(values)) throw new Error('Context extensions must be an array.');
  return [...new Set(values.map((value) => {
    const extension = String(value).trim().toLowerCase();
    if (!/^\.[a-z0-9]+$/u.test(extension)) throw new Error(`Invalid context extension: ${value}`);
    return extension;
  }))].sort();
}

function realProjectDirectory(root, relativePath) {
  const portable = normalizeProjectPath(relativePath);
  const absolute = path.resolve(root, ...portable.split('/'));
  if (!isPathInside(root, absolute) || absolute === root) {
    throw new Error(`Project location escapes the Workspace Root: ${relativePath}`);
  }
  let cursor = root;
  for (const segment of portable.split('/')) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) throw new Error(`Project location does not exist: ${cursor}`);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Project location cannot pass through a symbolic link or junction: ${cursor}`);
    }
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory()) throw new Error(`Project location must be a real directory: ${absolute}`);
  const real = fs.realpathSync.native(absolute);
  if (!isPathInside(root, real)) throw new Error(`Project location resolves outside the Workspace Root: ${relativePath}`);
  return portable;
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

  get projectContext() {
    if (!this._projectContext) {
      this._projectContext = new ProjectContextRepository({
        db: this.ledger.db,
        transaction: (callback) => this.ledger.transaction(callback),
      });
    }
    return this._projectContext;
  }

  adoptRoot({
    rootPath,
    rootType,
    contentPolicy = 'structure_only',
  }) {
    const root = normalizeRoot(rootPath);
    if (isPathInside(root, this.stateDir) || isPathInside(this.stateDir, root)) {
      throw new Error(`Atlas state and an adopted Workspace Root must not overlap: ${this.stateDir}`);
    }
    if (!ROOT_TYPES.has(rootType)) {
      throw new Error(`Unsupported governed Workspace Root type: ${rootType}`);
    }
    if (!CONTENT_POLICIES.has(contentPolicy)) {
      throw new Error(`Workspace Root content policy must be one of: ${[...CONTENT_POLICIES].join(', ')}.`);
    }
    for (const existing of this.projectContext.listRoots()) {
      const existingPath = path.resolve(existing.current_path);
      const samePath = existingPath.localeCompare(
        root,
        undefined,
        { sensitivity: 'accent' },
      ) === 0;
      if (!samePath
          && (isPathInside(existingPath, root) || isPathInside(root, existingPath))) {
        throw new Error(
          `Adopted Workspace Roots must not overlap: ${root} and ${existing.current_path}`,
        );
      }
    }
    return this.projectContext.adoptRoot({
      currentPath: root,
      rootType,
      contentPolicy,
      adoptedAt: timestamp(),
    });
  }

  showRoot(rootId) {
    return this.projectContext.getRoot(rootId);
  }

  listRoots() {
    return this.projectContext.listRoots();
  }

  relocateRoot(rootId, { rootPath, reason }) {
    const current = this.projectContext.getRoot(rootId).root;
    if (current.governance_status !== 'adopted') {
      throw new Error(`Workspace Root is not adopted: ${rootId}`);
    }
    if (fs.existsSync(current.current_path)) {
      throw new Error('The active Workspace Root still exists. Use governed Evolution for a physical move.');
    }
    const candidateRoot = normalizeRoot(rootPath);
    if (isPathInside(candidateRoot, this.stateDir) || isPathInside(this.stateDir, candidateRoot)) {
      throw new Error(`Atlas state and an adopted Workspace Root must not overlap: ${this.stateDir}`);
    }
    for (const existing of this.projectContext.listRoots()) {
      if (existing.id === rootId) continue;
      const existingPath = path.resolve(existing.current_path);
      if (isPathInside(existingPath, candidateRoot) || isPathInside(candidateRoot, existingPath)) {
        throw new Error(`Adopted Workspace Roots must not overlap: ${candidateRoot} and ${existing.current_path}`);
      }
    }

    const locations = this.projectContext.listActiveLocationsForRoot(rootId);
    const verifiedProjectIds = [];
    const unverifiedProjectIds = [];
    for (const location of locations) {
      let relativePath;
      try {
        relativePath = realProjectDirectory(candidateRoot, location.relative_path);
      } catch {
        return {
          schema: 'atlas-root-relocation.v1',
          status: 'rejected',
          reason_code: 'project_location_missing',
          root_id: rootId,
          project_id: location.project_id,
          relative_path: location.relative_path,
          source_changes: [],
        };
      }
      const baseline = this.projectContext.getActiveIdentity(location.project_id);
      if (!baseline) {
        unverifiedProjectIds.push(location.project_id);
        continue;
      }
      const candidate = captureProjectIdentity(
        path.resolve(candidateRoot, ...relativePath.split('/')),
      );
      const comparison = compareProjectIdentity(baseline.evidence, candidate.evidence);
      if (comparison.status !== 'verified') {
        return {
          schema: 'atlas-root-relocation.v1',
          status: 'rejected',
          root_id: rootId,
          project_id: location.project_id,
          ...comparison,
          identity_reason_code: comparison.reason_code,
          reason_code: 'project_identity_mismatch',
          source_changes: [],
        };
      }
      verifiedProjectIds.push(location.project_id);
    }
    if (!verifiedProjectIds.length) {
      return {
        schema: 'atlas-root-relocation.v1',
        status: 'rejected',
        reason_code: 'root_identity_baseline_unavailable',
        root_id: rootId,
        unverified_project_ids: unverifiedProjectIds,
        source_changes: [],
      };
    }

    const relocatedAt = timestamp();
    const updated = this.projectContext.relocateRoot({
      rootId,
      currentPath: candidateRoot,
      reason: normalizeReason(reason, 'Workspace Root relocation'),
      relocatedAt,
    });
    return {
      schema: 'atlas-root-relocation.v1',
      status: 'relocated',
      reason_code: 'project_identity_anchors_verified',
      root_id: rootId,
      current_path: updated.root.current_path,
      verified_project_ids: verifiedProjectIds,
      unverified_project_ids: unverifiedProjectIds,
      source_changes: [],
    };
  }

  attachRoot(projectIdValue, {
    rootId,
    relativePath = null,
    reason,
  }) {
    const project = this.ledger.getProject(projectIdValue);
    const root = this.projectContext.getRoot(rootId).root;
    if (root.governance_status !== 'adopted') throw new Error(`Workspace Root is not adopted: ${rootId}`);
    const selectedPath = relativePath ?? project.current_path;
    const normalizedPath = realProjectDirectory(root.current_path, selectedPath);
    const attachedAt = timestamp();
    const location = this.projectContext.attachLocation({
      projectId: projectIdValue,
      rootId,
      relativePath: normalizedPath,
      reason: normalizeReason(reason, 'Project Root attachment'),
      attachedAt,
    });
    const absolute = path.resolve(root.current_path, ...normalizedPath.split('/'));
    const captured = captureProjectIdentity(absolute);
    const identity = captured.status === 'captured'
      ? this.projectContext.recordIdentity({
          projectId: projectIdValue,
          signature: captured,
          reason: 'Project Root attachment identity capture.',
          recordedAt: attachedAt,
        })
      : captured;
    return { ...location, identity: identity ? { ...identity, status: captured.status } : captured };
  }

  relocate(projectIdValue, {
    rootId,
    relativePath,
    reason,
  }) {
    const project = this.ledger.getProject(projectIdValue);
    const current = this.projectContext.getActiveLocation(projectIdValue);
    if (!current) throw new Error(`Project has no active Workspace Root location: ${projectIdValue}`);
    const currentAbsolute = path.resolve(current.root_path, ...current.relative_path.split('/'));
    if (fs.existsSync(currentAbsolute)) {
      throw new Error('The active Project location still exists. Use a governed Evolution move instead of identity recovery.');
    }
    const baseline = this.projectContext.getActiveIdentity(projectIdValue);
    if (!baseline) {
      return {
        schema: 'atlas-project-relocation.v1',
        status: 'rejected',
        reason_code: 'identity_baseline_unavailable',
        project_id: project.id,
        source_changes: [],
      };
    }
    const root = this.projectContext.getRoot(rootId).root;
    const normalizedPath = realProjectDirectory(root.current_path, relativePath);
    const absolute = path.resolve(root.current_path, ...normalizedPath.split('/'));
    const candidate = captureProjectIdentity(absolute);
    const comparison = compareProjectIdentity(baseline.evidence, candidate.evidence);
    if (comparison.status !== 'verified') {
      return {
        schema: 'atlas-project-relocation.v1',
        ...comparison,
        project_id: project.id,
        candidate: { root_id: rootId, relative_path: normalizedPath },
        source_changes: [],
      };
    }
    const relocatedAt = timestamp();
    const location = this.projectContext.attachLocation({
      projectId: projectIdValue,
      rootId,
      relativePath: normalizedPath,
      reason: normalizeReason(reason, 'Project relocation'),
      attachedAt: relocatedAt,
    });
    this.projectContext.recordIdentity({
      projectId: projectIdValue,
      signature: candidate,
      reason: 'Verified Project relocation identity.',
      recordedAt: relocatedAt,
    });
    return {
      schema: 'atlas-project-relocation.v1',
      status: 'relocated',
      reason_code: comparison.reason_code,
      project_id: project.id,
      location,
      matched_signals: comparison.matched_signals,
      mismatched_signals: [],
      missing_signals: comparison.missing_signals,
      source_changes: [],
    };
  }

  linkContext(targetProjectId, {
    sourceProjectId,
    purpose,
    extensions = [],
    roles = [],
    maxCandidates = 20,
    reason,
  }) {
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 50) {
      throw new Error('Context maxCandidates must be an integer from 1 to 50.');
    }
    if (!Array.isArray(roles)) throw new Error('Context roles must be an array.');
    if (roles.length) {
      throw new Error('Cross-Project Context Link role filters are not supported by the V1.3 direct-text Catalog.');
    }
    return this.projectContext.linkContext({
      targetProjectId,
      sourceProjectId,
      purpose: normalizePurpose(purpose),
      filters: {
        extensions: normalizeExtensions(extensions),
        roles: [],
        max_candidates: maxCandidates,
      },
      reason: normalizeReason(reason, 'Project context link'),
      linkedAt: timestamp(),
    });
  }

  contextLinks(projectIdValue) {
    this.ledger.getProject(projectIdValue);
    return this.projectContext.listContextLinks(projectIdValue);
  }

  contextLinkHistory(projectIdValue) {
    this.ledger.getProject(projectIdValue);
    return this.projectContext.listContextLinks(projectIdValue, { includeHistory: true });
  }

  resolvePath(pathValue) {
    const resolvedPath = normalizeRoot(pathValue);
    const locations = this.projectContext.listActiveLocations();
    const matches = locations.filter((location) => {
      const projectPath = path.resolve(
        location.root_path,
        ...location.relative_path.split('/'),
      );
      return isPathInside(projectPath, resolvedPath);
    }).sort((left, right) => {
      const leftPath = path.resolve(left.root_path, ...left.relative_path.split('/'));
      const rightPath = path.resolve(right.root_path, ...right.relative_path.split('/'));
      return rightPath.length - leftPath.length;
    });
    if (matches.length) {
      const location = matches[0];
      return {
        schema: 'atlas-project-resolution.v1',
        status: 'resolved',
        input_path: resolvedPath,
        root: this.projectContext.getRoot(location.root_id).root,
        project: this.ledger.getProject(location.project_id),
        location,
        context_links: this.projectContext.listContextLinks(location.project_id),
        source_changes: [],
      };
    }
    const containingRoots = this.projectContext.listRoots().filter((root) => (
      isPathInside(path.resolve(root.current_path), resolvedPath)
    ));
    const containingRoot = containingRoots[0] ?? null;
    const projectCandidates = containingRoot
      ? locations.filter((location) => {
        if (location.root_id !== containingRoot.id) return false;
        const projectPath = path.resolve(
          location.root_path,
          ...location.relative_path.split('/'),
        );
        return isPathInside(resolvedPath, projectPath);
      }).map((location) => ({
        project: this.ledger.getProject(location.project_id),
        location,
      }))
      : [];
    return {
      schema: 'atlas-project-resolution.v1',
      status: 'setup_required',
      input_path: resolvedPath,
      root: containingRoot,
      project: null,
      location: null,
      context_links: [],
      project_candidates: projectCandidates,
      missing: containingRoots.length ? ['project_location'] : ['workspace_root', 'project_location'],
      source_changes: [],
    };
  }

  disableContextLink(linkId, { reason }) {
    return this.projectContext.disableContextLink(linkId, {
      reason: normalizeReason(reason, 'Disable context link'),
      disabledAt: timestamp(),
    });
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
    return {
      ...this.ledger.getProjectDetail(projectIdValue),
      location: this.projectContext.getActiveLocation(projectIdValue),
      location_history: this.projectContext.locationHistory(projectIdValue),
      identity: this.projectContext.getActiveIdentity(projectIdValue),
      identity_history: this.projectContext.identityHistory(projectIdValue),
      context_links: this.projectContext.listContextLinks(projectIdValue),
    };
  }

  list() {
    return this.ledger.listProjects();
  }

  dispose() {
    if (this._ledger) this._ledger.close();
    this._ledger = null;
    this._projectContext = null;
  }
}
