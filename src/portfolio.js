import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from './ledger.js';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';

export const PORTFOLIO_ROOT_TYPES = Object.freeze([
  'managed_library',
  'source_repository',
  'project_workspace',
  'workspace_container',
  'shared_asset',
  'installed_application',
  'portable_application',
  'tool_source',
  'package_store',
  'tool_runtime',
  'generated_cache',
  'system_managed',
  'archive_backup',
  'unknown',
]);

export const PORTFOLIO_RELATIONS = Object.freeze([
  'related', 'infrastructure', 'unrelated', 'excluded', 'unresolved',
]);

const MAX_DEPTH = 2;
const MAX_OBSERVED_ENTRIES = 20_000;
const PRUNED_DIRECTORY_NAMES = new Set([
  '.git', '.obsidian', '.atlas', '.next', '.cache', '.trash',
  'node_modules', 'dist', 'build', 'coverage',
]);
const ROOT_MARKERS = new Set([
  '.git', '.obsidian', 'package.json', 'pyproject.toml', 'cargo.toml',
  'go.mod', 'agents.md', 'skill.md',
]);

function timestamp() {
  return new Date().toISOString();
}

function makeInventoryId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `PFI-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeDepth(value = 1) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_DEPTH) {
    throw new Error(`Portfolio depth must be an integer from 1 to ${MAX_DEPTH}.`);
  }
  return number;
}

function normalizeExclusions(values = []) {
  if (!Array.isArray(values)) throw new Error('Portfolio exclusions must be an array.');
  return [...new Set(values.map((value) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Portfolio exclude path cannot be empty.');
    }
    const portable = value.trim().replace(/\\/g, '/').replace(/^\.\//u, '').replace(/\/$/u, '');
    if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(portable)) {
      throw new Error(`Portfolio exclude path must be relative: ${value}`);
    }
    const normalized = path.posix.normalize(portable);
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Portfolio exclude path escapes the root: ${value}`);
    }
    return normalized;
  }))].sort((left, right) => left.localeCompare(right));
}

function normalizeExpansions(values = []) {
  return normalizeExclusions(values).map((value) => {
    if (value === '.') throw new Error('Portfolio expand path must identify a directory below the root.');
    return value;
  });
}

function isExcluded(relativePath, exclusions) {
  const candidate = relativePath.toLowerCase();
  return exclusions.some((item) => candidate === item.toLowerCase()
    || candidate.startsWith(`${item.toLowerCase()}/`));
}

function evidenceItem(code, detail = {}) {
  return { code, ...detail };
}

function looksLikePackageStore(name) {
  return /^(?:\.pnpm-store|\.npm|npm-cache|yarn-cache|\.m2|\.nuget|packages?)$/iu.test(name);
}

function looksLikeGeneratedCache(name) {
  return /^(?:\.cache|cache|caches|tmp|temp|\.tmp|\.next|dist|build|coverage)$/iu.test(name);
}

function looksLikeRuntime(name) {
  return /^(?:nodejs?|python\d*(?:\.\d+)*|jdk\d*|jre\d*|dotnet|sdk|runtime)$/iu.test(name);
}

function looksLikeBackup(name) {
  return /^(?:_?backup|_?bak|backups?|archives?)$/iu.test(name);
}

function looksLikeSharedAssets(name) {
  return /^(?:shared|assets?|templates?|brand|media)$/iu.test(name);
}

function classifyRoot(observation) {
  const evidence = [...observation.evidence];
  const names = new Set(observation.direct_names.map((item) => item.toLowerCase()));
  const leaf = path.basename(observation.current_path);
  if (observation.special_path) {
    return {
      predictedType: 'unknown', typeConfidence: 1,
      candidateTypes: [], predictedRelation: 'unresolved', relationConfidence: 1,
      evidence,
    };
  }
  if (/^(?:\$recycle\.bin|system volume information)$/iu.test(leaf)) {
    evidence.push(evidenceItem('system_managed_name', { name: leaf }));
    return {
      predictedType: 'system_managed', typeConfidence: 0.99,
      candidateTypes: [], predictedRelation: 'infrastructure', relationConfidence: 0.99,
      evidence,
    };
  }
  if (looksLikeBackup(leaf)) {
    evidence.push(evidenceItem('backup_name', { name: leaf }));
    return {
      predictedType: 'archive_backup', typeConfidence: 0.9,
      candidateTypes: [], predictedRelation: 'excluded', relationConfidence: 0.95,
      evidence,
    };
  }
  if (looksLikePackageStore(leaf)) {
    evidence.push(evidenceItem('package_store_name', { name: leaf }));
    return {
      predictedType: 'package_store', typeConfidence: 0.95,
      candidateTypes: [], predictedRelation: 'infrastructure', relationConfidence: 0.95,
      evidence,
    };
  }
  if (looksLikeGeneratedCache(leaf)) {
    evidence.push(evidenceItem('generated_cache_name', { name: leaf }));
    return {
      predictedType: 'generated_cache', typeConfidence: 0.9,
      candidateTypes: [], predictedRelation: 'infrastructure', relationConfidence: 0.9,
      evidence,
    };
  }
  if (names.has('.obsidian') && names.has('.git')) {
    evidence.push(evidenceItem('mixed_git_and_obsidian_markers'));
    return {
      predictedType: 'unknown', typeConfidence: 0.95,
      candidateTypes: ['managed_library', 'source_repository', 'project_workspace'],
      predictedRelation: 'unresolved', relationConfidence: 1,
      evidence,
    };
  }
  if (names.has('.obsidian')) {
    evidence.push(evidenceItem('obsidian_marker'));
    return {
      predictedType: 'managed_library', typeConfidence: 0.98,
      candidateTypes: [], predictedRelation: 'unresolved', relationConfidence: 1,
      evidence,
    };
  }
  if (names.has('.git')) {
    evidence.push(evidenceItem('git_marker'));
    return {
      predictedType: 'source_repository', typeConfidence: 0.97,
      candidateTypes: ['tool_source'], predictedRelation: 'unresolved', relationConfidence: 1,
      evidence,
    };
  }
  const uninstaller = observation.direct_names.some((name) => /^unins\d*\.exe$|^uninstall(?:er)?\.exe$/iu.test(name));
  if (uninstaller && observation.binary_file_count >= 3) {
    evidence.push(evidenceItem('uninstaller_marker'));
    evidence.push(evidenceItem('binary_density', { count: observation.binary_file_count }));
    return {
      predictedType: 'installed_application', typeConfidence: 0.92,
      candidateTypes: [], predictedRelation: 'infrastructure', relationConfidence: 0.97,
      evidence,
    };
  }
  if (looksLikeRuntime(leaf) && observation.binary_file_count > 0) {
    evidence.push(evidenceItem('runtime_name_and_binary', { name: leaf }));
    return {
      predictedType: 'tool_runtime', typeConfidence: 0.82,
      candidateTypes: ['installed_application'], predictedRelation: 'infrastructure', relationConfidence: 0.9,
      evidence,
    };
  }
  if (observation.binary_file_count > 0) {
    evidence.push(evidenceItem('executable_without_install_evidence', { count: observation.binary_file_count }));
    return {
      predictedType: 'unknown', typeConfidence: 0.75,
      candidateTypes: ['portable_application', 'installed_application'],
      predictedRelation: 'unresolved', relationConfidence: 1,
      evidence,
    };
  }
  if (names.has('package.json') || names.has('pyproject.toml') || names.has('cargo.toml') || names.has('go.mod')) {
    evidence.push(evidenceItem('source_manifest_marker'));
    return {
      predictedType: 'source_repository', typeConfidence: 0.72,
      candidateTypes: ['tool_source', 'project_workspace'],
      predictedRelation: 'unresolved', relationConfidence: 1,
      evidence,
    };
  }
  if (looksLikeSharedAssets(leaf)) {
    evidence.push(evidenceItem('shared_asset_name', { name: leaf }));
    return {
      predictedType: 'shared_asset', typeConfidence: 0.65,
      candidateTypes: ['project_workspace'], predictedRelation: 'unresolved', relationConfidence: 1,
      evidence,
    };
  }
  if (observation.nested_root_markers > 0) {
    evidence.push(evidenceItem('contains_nested_roots', { count: observation.nested_root_markers }));
    return {
      predictedType: 'project_workspace', typeConfidence: 0.68,
      candidateTypes: [], predictedRelation: 'unresolved', relationConfidence: 1,
      evidence,
    };
  }
  return {
    predictedType: 'unknown', typeConfidence: 1,
    candidateTypes: [], predictedRelation: 'unresolved', relationConfidence: 1,
    evidence,
  };
}

function scanStructure(root, depth, exclusions, expansions) {
  const candidates = new Map();
  let observedEntries = 0;
  let truncated = false;
  let accessErrors = 0;

  function inspectDirectory(absolute, relative, level, specialPath = false) {
    const base = {
      current_path: absolute,
      relative_path: relative,
      special_path: specialPath,
      direct_names: [],
      direct_entry_count: 0,
      direct_names_truncated: false,
      direct_file_count: 0,
      direct_directory_count: 0,
      binary_file_count: 0,
      observed_direct_bytes: 0,
      nested_root_markers: 0,
      evidence: [],
    };
    if (specialPath) {
      base.evidence.push(evidenceItem('reparse_point_not_followed'));
      return base;
    }
    let children;
    try {
      children = fs.readdirSync(absolute, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      accessErrors += 1;
      base.evidence.push(evidenceItem('directory_unreadable', { error_code: error.code ?? 'UNKNOWN' }));
      return base;
    }
    const allNames = children.map((item) => item.name);
    const importantNames = allNames.filter((name) => ROOT_MARKERS.has(name.toLowerCase())
      || /^unins\d*\.exe$|^uninstall(?:er)?\.exe$/iu.test(name));
    base.direct_entry_count = allNames.length;
    base.direct_names_truncated = allNames.length > 20;
    base.direct_names = [...new Set([...allNames.slice(0, 20), ...importantNames])]
      .sort((left, right) => left.localeCompare(right));
    for (const child of children) {
      if (observedEntries >= MAX_OBSERVED_ENTRIES) {
        truncated = true;
        break;
      }
      const childRelative = `${relative}/${child.name}`;
      if (isExcluded(childRelative, exclusions)) continue;
      const childAbsolute = path.join(absolute, child.name);
      let stat;
      try {
        stat = fs.lstatSync(childAbsolute);
        observedEntries += 1;
      } catch (error) {
        accessErrors += 1;
        base.evidence.push(evidenceItem('entry_unreadable', { name: child.name, error_code: error.code ?? 'UNKNOWN' }));
        continue;
      }
      if (stat.isSymbolicLink()) {
        base.direct_directory_count += 1;
        if (level < depth) candidates.set(childRelative, inspectDirectory(childAbsolute, childRelative, level + 1, true));
      } else if (stat.isDirectory()) {
        base.direct_directory_count += 1;
        if (ROOT_MARKERS.has(child.name.toLowerCase())) base.nested_root_markers += 1;
      } else if (stat.isFile()) {
        base.direct_file_count += 1;
        base.observed_direct_bytes += stat.size;
        if (/\.(?:exe|dll|sys|msi)$/iu.test(child.name)) base.binary_file_count += 1;
      }
    }
    return base;
  }

  function walk(directory, relativeParent, level) {
    if (level > depth || truncated) return;
    let children;
    try {
      children = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      accessErrors += 1;
      return;
    }
    for (const child of children) {
      if (observedEntries >= MAX_OBSERVED_ENTRIES) {
        truncated = true;
        return;
      }
      const relative = relativeParent ? `${relativeParent}/${child.name}` : child.name;
      if (isExcluded(relative, exclusions)) continue;
      const absolute = path.join(directory, child.name);
      let stat;
      try {
        stat = fs.lstatSync(absolute);
        observedEntries += 1;
      } catch {
        accessErrors += 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        candidates.set(relative, inspectDirectory(absolute, relative, level, true));
        continue;
      }
      if (!stat.isDirectory()) continue;
      const observation = inspectDirectory(absolute, relative, level);
      const markerBoundary = observation.direct_names.some((name) => ROOT_MARKERS.has(name.toLowerCase()));
      if (level === 1 || markerBoundary) candidates.set(relative, observation);
      const explicitlyExpanded = expansions.some((item) => item === relative || item.startsWith(`${relative}/`));
      if (level < depth && explicitlyExpanded && !PRUNED_DIRECTORY_NAMES.has(child.name.toLowerCase())) {
        walk(absolute, relative, level + 1);
      }
    }
  }

  walk(root, '', 1);
  const classifiedRoots = [...candidates.values()].map((observation) => {
    const classification = classifyRoot(observation);
    return {
      ...observation,
      predicted_type: classification.predictedType,
      type_confidence: classification.typeConfidence,
      candidate_types: classification.candidateTypes,
      predicted_relation: classification.predictedRelation,
      relation_confidence: classification.relationConfidence,
      evidence: classification.evidence,
    };
  }).sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const roots = classifiedRoots.map((item) => {
    const nestedRoots = classifiedRoots.filter((candidate) => candidate.relative_path.startsWith(`${item.relative_path}/`));
    if (item.predicted_type !== 'unknown' || nestedRoots.length === 0) return item;
    return {
      ...item,
      predicted_type: 'workspace_container',
      type_confidence: 0.85,
      candidate_types: ['project_workspace'],
      evidence: [
        ...item.evidence,
        evidenceItem('contains_discovered_root_boundaries', {
          count: nestedRoots.length,
          roots: nestedRoots.map((candidate) => candidate.relative_path),
        }),
      ],
    };
  });
  return { roots, observedEntries, truncated, accessErrors };
}

function planTarget(targetRoot, item) {
  const leaf = path.basename(item.current_path);
  if (item.effective_type === 'managed_library') return path.join(targetRoot, 'Obsidian', leaf);
  if (item.effective_type === 'tool_source') return path.join(targetRoot, 'tools', leaf);
  if (['source_repository', 'project_workspace'].includes(item.effective_type)) {
    return path.join(targetRoot, 'projects', leaf);
  }
  if (item.effective_type === 'shared_asset') return path.join(targetRoot, 'shared', leaf);
  return null;
}

export class Portfolio {
  constructor({ stateDir }) {
    this.ledger = new Ledger(stateDir);
  }

  inventory(options) {
    const root = normalizeRoot(options.root);
    if (isPathInside(root, this.ledger.stateDir)) {
      throw new Error(`Atlas Portfolio state must remain outside the inventoried root: ${this.ledger.stateDir}`);
    }
    const depth = normalizeDepth(options.depth ?? 1);
    const excluded = normalizeExclusions(options.exclude ?? []);
    const expanded = normalizeExpansions(options.expand ?? []);
    if (depth > 1 && expanded.length === 0) {
      throw new Error('Portfolio depth 2 requires at least one --expand path.');
    }
    for (const item of expanded) {
      if (isExcluded(item, excluded)) throw new Error(`Portfolio expand path is excluded: ${item}`);
      const absolute = path.resolve(root, ...item.split('/'));
      if (!isPathInside(root, absolute)) throw new Error(`Portfolio expand path escapes the root: ${item}`);
      if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isDirectory() || fs.lstatSync(absolute).isSymbolicLink()) {
        throw new Error(`Portfolio expand path must be a real directory: ${item}`);
      }
    }
    const scanned = scanStructure(root, depth, excluded, expanded);
    const fingerprintPayload = scanned.roots.map((item) => ({
      path: item.relative_path,
      special: item.special_path,
      names: item.direct_names,
      files: item.direct_file_count,
      directories: item.direct_directory_count,
      bytes: item.observed_direct_bytes,
    }));
    const fingerprint = sha256(JSON.stringify({ root, depth, excluded, expanded, roots: fingerprintPayload }));
    const existing = options.forceNew ? null : this.ledger.findPortfolioInventory(root, fingerprint);
    if (existing) return { ...JSON.parse(existing.receipt_json), reused: true };

    const inventoryId = makeInventoryId();
    const startedAt = timestamp();
    const summary = {
      root_candidates: scanned.roots.length,
      observed_entries: scanned.observedEntries,
      access_errors: scanned.accessErrors,
      truncated: scanned.truncated,
      content_files_read: 0,
      content_bytes_read: 0,
      type_counts: Object.fromEntries(PORTFOLIO_ROOT_TYPES.map((type) => [
        type, scanned.roots.filter((item) => item.predicted_type === type).length,
      ])),
    };
    const receipt = {
      inventory_id: inventoryId,
      status: 'inventoried',
      root,
      depth,
      excluded,
      expanded,
      fingerprint,
      root_candidates: scanned.roots.length,
      observed_entries: scanned.observedEntries,
      access_errors: scanned.accessErrors,
      truncated: scanned.truncated,
      content_files_read: 0,
      content_bytes_read: 0,
      source_changes: [],
      reused: false,
      inventoried_at: startedAt,
    };
    this.ledger.createPortfolioInventory({
      runId: inventoryId,
      root,
      fingerprint,
      depth,
      excluded,
      expanded,
      roots: scanned.roots,
      summary,
      receipt,
      caller: options.caller,
      startedAt,
    });
    return receipt;
  }

  show(inventoryId) {
    return this.ledger.getPortfolioDetail(inventoryId);
  }

  review(inventoryId, options) {
    if (!PORTFOLIO_ROOT_TYPES.includes(options.rootType)) {
      throw new Error(`Portfolio root type must be one of: ${PORTFOLIO_ROOT_TYPES.join(', ')}.`);
    }
    if (!PORTFOLIO_RELATIONS.includes(options.relation)) {
      throw new Error(`Portfolio relation must be one of: ${PORTFOLIO_RELATIONS.join(', ')}.`);
    }
    if (!options.reason?.trim()) throw new Error('Portfolio review requires a reason.');
    return this.ledger.reviewPortfolioRoot(inventoryId, {
      rootId: options.rootId,
      rootType: options.rootType,
      relation: options.relation,
      reason: options.reason.trim(),
      reviewedAt: timestamp(),
    });
  }

  plan(inventoryId, { target }) {
    const detail = this.show(inventoryId);
    if (!target) throw new Error('Portfolio plan requires a target root.');
    const targetRoot = path.resolve(target);
    const inventoryRoot = detail.inventory.root_path;
    if (targetRoot === inventoryRoot || !isPathInside(inventoryRoot, targetRoot)) {
      throw new Error(`Portfolio target must remain inside the inventoried root: ${targetRoot}`);
    }
    let targetStatus = 'absent';
    if (fs.existsSync(targetRoot)) {
      const stat = fs.lstatSync(targetRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Portfolio target must be an absent path or real directory: ${targetRoot}`);
      }
      targetStatus = 'existing';
    } else {
      const parent = path.dirname(targetRoot);
      if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory()) {
        throw new Error(`Portfolio target parent must be an existing real directory: ${parent}`);
      }
    }

    const rootPaths = detail.roots.map((item) => item.current_path);
    const items = detail.roots.map((item) => {
      const effectiveType = item.review?.root_type ?? item.predicted_type;
      const effectiveRelation = item.review?.relation ?? item.predicted_relation;
      const blockers = [];
      const hasNestedRoot = rootPaths.some((candidate) => candidate !== item.current_path
        && isPathInside(item.current_path, candidate));
      let disposition = 'blocked';
      let suggestedTarget = null;
      if (['installed_application', 'portable_application', 'package_store', 'tool_runtime', 'generated_cache', 'system_managed', 'archive_backup']
        .includes(effectiveType) || ['infrastructure', 'unrelated', 'excluded'].includes(effectiveRelation)) {
        disposition = 'keep';
      } else if (item.special_path) {
        blockers.push('special_path_not_followed');
      } else if (!item.review?.root_type || !item.review?.relation) {
        blockers.push('classification_review_required');
      } else if (effectiveRelation !== 'related') {
        blockers.push('relationship_review_required');
      } else if (hasNestedRoot) {
        disposition = 'needs_split';
        blockers.push('nested_root_boundaries_require_split_review');
      } else if (['managed_library', 'source_repository', 'project_workspace', 'shared_asset', 'tool_source'].includes(effectiveType)) {
        suggestedTarget = planTarget(targetRoot, { ...item, effective_type: effectiveType });
        if (suggestedTarget.localeCompare(item.current_path, undefined, { sensitivity: 'accent' }) === 0) {
          disposition = 'adopt_only';
        } else {
          blockers.push('path_dependency_report_required');
          blockers.push('cross_root_migration_not_authorized');
        }
      } else {
        blockers.push('classification_review_required');
      }
      return {
        root_id: item.root_id,
        current_path: item.current_path,
        relative_path: item.relative_path,
        predicted_type: item.predicted_type,
        predicted_relation: item.predicted_relation,
        effective_type: effectiveType,
        effective_relation: effectiveRelation,
        disposition,
        suggested_target: suggestedTarget,
        blockers,
        evidence: item.evidence,
      };
    });
    const plan = {
      inventory_id: inventoryId,
      target_root: targetRoot,
      target_status: targetStatus,
      status: items.some((item) => item.disposition === 'blocked' || item.disposition === 'needs_split')
        ? 'needs_review'
        : 'planned',
      source_changes: [],
      items,
      counts: Object.fromEntries(['keep', 'adopt_only', 'move_ready', 'needs_split', 'blocked'].map((status) => [
        status, items.filter((item) => item.disposition === status).length,
      ])),
      policy: 'read_only_plan_no_migration_authority',
    };
    const planHash = sha256(JSON.stringify(plan));
    return this.ledger.savePortfolioPlan(inventoryId, {
      targetRoot, planHash, plan: { ...plan, plan_hash: planHash }, createdAt: timestamp(),
    });
  }

  dispose() {
    this.ledger.close();
  }
}
