import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildCompleteDiff } from './diff.js';
import { Ledger } from './ledger.js';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';
import { ROLE_TRANSITIONS, getArtifactRole } from './profiles.js';
import { evaluateRisk } from './risk.js';
import { RuntimeStorage } from './runtime-storage.js';
import { captureBlob, captureBuffer, sha256File } from './snapshots.js';
import { withStateLock } from './state-lock.js';
import { ProjectContextRepository } from './storage/repositories/project-context-repository.js';
import { RollbackConflictError } from './tracker.js';

const RELATION_TYPES = new Set([
  'derived_from',
  'summarizes',
  'transforms',
  'merges',
  'extracts_from',
  'supersedes',
  'delta_of',
  'overlaps',
  'appends_to',
]);

function timestamp() {
  return new Date().toISOString();
}

function makeRunId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `DRV-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeRole(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Derived role is required.');
  return getArtifactRole(value.trim()).id;
}

function normalizeRelationType(value = 'derived_from') {
  if (!RELATION_TYPES.has(value)) {
    throw new Error(`Derived relationType must be one of: ${[...RELATION_TYPES].join(', ')}.`);
  }
  return value;
}

function normalizeInput(root, input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Derived input path cannot be empty.');
  const lexical = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isPathInside(root, lexical)) throw new Error(`Derived input escapes the root: ${input}`);
  if (!fs.existsSync(lexical)) throw new Error(`Derived input does not exist: ${lexical}`);
  const stat = fs.lstatSync(lexical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Derived input must be a regular non-symbolic-link file: ${lexical}`);
  }
  const real = fs.realpathSync.native(lexical);
  if (!isPathInside(root, real)) throw new Error(`Derived input resolves outside the root: ${input}`);
  return { absolute: real, relative: toPortablePath(path.relative(root, real)) };
}

function normalizeTrustedInput(targetRoot, input) {
  if (!input || typeof input !== 'object') throw new Error('Trusted Derived input must be an object.');
  const sourceRoot = normalizeRoot(input.sourceRootPath ?? targetRoot);
  const sourcePath = input.sourceRelativePath ?? input.path;
  const normalized = normalizeInput(sourceRoot, sourcePath);
  return {
    ...normalized,
    relative: input.path ?? normalized.relative,
    sourceRootId: input.sourceRootId ?? null,
    sourceProjectId: input.sourceProjectId ?? null,
    sourceRootPath: sourceRoot,
    sourceRelativePath: normalized.relative,
  };
}

function realTargetParent(root, parent, targetInput) {
  const lexicalRoot = path.resolve(root);
  const realRoot = fs.realpathSync.native(lexicalRoot);
  if (!isPathInside(lexicalRoot, parent) && parent !== lexicalRoot) throw new Error(`Derived target escapes the root: ${targetInput}`);
  let cursor = lexicalRoot;
  const rootStat = fs.lstatSync(cursor);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Derived target parent must be a real directory: ${cursor}`);
  for (const part of path.relative(lexicalRoot, parent).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Derived target parent must be a real directory: ${cursor}`);
    const realCursor = fs.realpathSync.native(cursor);
    if (!isPathInside(realRoot, realCursor) && realCursor !== realRoot) throw new Error(`Derived target parent resolves outside the root: ${targetInput}`);
  }
  return fs.realpathSync.native(parent);
}

function normalizeNewTarget(root, targetInput) {
  if (typeof targetInput !== 'string' || !targetInput.trim()) {
    throw new Error('Derived prepare requires a target file path.');
  }
  const lexical = path.isAbsolute(targetInput)
    ? path.resolve(targetInput)
    : path.resolve(root, targetInput);
  if (!isPathInside(root, lexical) || lexical === root) {
    throw new Error(`Derived target escapes the root: ${targetInput}`);
  }
  if (fs.existsSync(lexical)) throw new Error(`Derived target already exists: ${lexical}`);
  const parent = path.dirname(lexical);
  if (!fs.existsSync(parent)) {
    throw new Error(`Derived target parent directory does not exist: ${parent}`);
  }
  const realParent = realTargetParent(root, parent, targetInput);
  if (!isPathInside(root, realParent)) {
    throw new Error(`Derived target resolves outside the root: ${targetInput}`);
  }
  const absolute = path.join(realParent, path.basename(lexical));
  if (!isPathInside(root, absolute)) {
    throw new Error(`Derived target resolves outside the root: ${targetInput}`);
  }
  return { absolute, relative: toPortablePath(path.relative(root, absolute)) };
}

function resolveCurrentTarget(root, targetInput) {
  const recordedRoot = path.resolve(root);
  const lexical = path.resolve(recordedRoot, ...String(targetInput).split('/'));
  if (!isPathInside(recordedRoot, lexical) || lexical === recordedRoot) throw new Error(`Derived target escapes the root: ${targetInput}`);
  const parent = path.dirname(lexical);
  if (!fs.existsSync(parent)) throw new Error(`Derived target parent directory does not exist: ${parent}`);
  const realRoot = fs.realpathSync.native(recordedRoot);
  const realParent = realTargetParent(recordedRoot, parent, targetInput);
  if (!isPathInside(realRoot, realParent)) throw new Error(`Derived target parent resolves outside the root: ${targetInput}`);
  return path.join(realParent, path.basename(lexical));
}

function isTargetInsideProject(targetPath, projectPath) {
  return targetPath.startsWith(`${projectPath}/`);
}

function normalizeFilename(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Derived recommendation requires a filename.');
  const filename = value.trim().normalize('NFC');
  if (filename === '.' || filename === '..' || path.basename(filename) !== filename
      || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Derived recommendation filename must be one file name without a directory.');
  }
  return filename;
}

function pathWithin(relativePath, parentPath) {
  return relativePath === parentPath || relativePath.startsWith(`${parentPath}/`);
}

function selectProject(ledger, inputs, explicitProjectId = null) {
  if (explicitProjectId) {
    const project = ledger.getProject(explicitProjectId);
    return project.status === 'active'
      ? { status: 'selected', project, basis: 'explicit_project' }
      : { status: 'unresolved', reason: 'explicit_project_inactive', candidates: [] };
  }
  const candidates = ledger.listProjects()
    .filter((project) => project.status === 'active' && project.current_path)
    .filter((project) => inputs.every((input) => pathWithin(input.relative, project.current_path)))
    .sort((left, right) => right.current_path.length - left.current_path.length);
  if (!candidates.length) {
    return { status: 'unresolved', reason: 'inputs_do_not_identify_one_project', candidates: [] };
  }
  const longest = candidates[0].current_path.length;
  const finalists = candidates.filter((project) => project.current_path.length === longest);
  if (finalists.length !== 1) {
    return { status: 'unresolved', reason: 'multiple_projects_match_inputs', candidates: finalists };
  }
  return { status: 'selected', project: finalists[0], basis: 'all_inputs_within_project' };
}

function placementRecommendation(ledger, root, inputs, role, filename, explicitProjectId = null, routeOverride = null) {
  const active = ledger.getActiveEnvironmentPolicy(root);
  if (!active && !routeOverride) {
    return {
      status: 'unresolved',
      decision: 'warn',
      reason: 'No reviewed Bootstrap Profile is active for this root.',
      configured: false,
      rule_version_id: null,
      project_candidates: [],
    };
  }
  const projectSelection = selectProject(ledger, inputs, explicitProjectId);
  if (projectSelection.status !== 'selected') {
    return {
      status: 'unresolved',
      decision: 'warn',
      reason: projectSelection.reason,
      configured: Boolean(active || routeOverride),
      rule_version_id: active?.rule_version_id ?? null,
      profile_id: active?.policy.profile_id ?? null,
      project_candidates: projectSelection.candidates.map((project) => ({
        project_id: project.id, name: project.name, path: project.current_path,
      })),
    };
  }
  const customRules = routeOverride ? [] : active?.policy.custom_routing_rules?.filter((rule) => (
    rule.evidence?.role === role && typeof rule.evidence?.target_directory === 'string'
  )) ?? [];
  const distinctCustomTargets = [...new Set(customRules.map((rule) => rule.evidence.target_directory))];
  if (distinctCustomTargets.length > 1) {
    return {
      status: 'unresolved',
      decision: 'warn',
      reason: `Multiple accepted routing rules conflict for role ${role}; select or correct one in a new Bootstrap version.`,
      configured: true,
      rule_version_id: active?.rule_version_id ?? null,
      profile_id: active?.policy.profile_id ?? null,
      project_id: projectSelection.project.id,
      project_candidates: [],
      route_candidates: customRules.map((rule) => ({
        prediction_id: rule.prediction_id,
        target_directory: rule.evidence.target_directory,
        summary: rule.summary,
      })),
    };
  }
  const customRule = customRules[0] ?? null;
  const route = routeOverride
    ? {
        area: null,
        project_subdirectory: routeOverride.target_subdirectory,
        source: routeOverride.source ?? 'reviewed_routing_correction',
        correction_id: routeOverride.correction_id,
        preference_rule_id: routeOverride.preference_rule_id,
        rule_version_id: routeOverride.rule_version_id,
      }
    : customRule
    ? {
        area: null,
        project_subdirectory: null,
        target_directory: customRule.evidence.target_directory,
        source: 'reviewed_custom_routing_prediction',
        prediction_id: customRule.prediction_id,
      }
    : active?.policy.derived_routes?.[role];
  if (!route) {
    return {
      status: 'unresolved',
      decision: 'warn',
      reason: `The active Profile has no Derived route for role ${role}.`,
      configured: true,
      rule_version_id: active?.rule_version_id ?? null,
      profile_id: active?.policy.profile_id ?? null,
      project_id: projectSelection.project.id,
      project_candidates: [],
    };
  }
  const directory = route.target_directory ?? (route.project_subdirectory
    ? `${projectSelection.project.current_path}/${route.project_subdirectory}`
    : projectSelection.project.current_path);
  const target = `${directory}/${filename}`;
  const absoluteDirectory = path.resolve(root, ...directory.split('/'));
  const absoluteTarget = path.resolve(root, ...target.split('/'));
  let status = 'ready';
  let decision = 'allow';
  let reason = routeOverride
    ? 'The reviewed scoped preference resolves to an existing Project directory.'
    : 'The accepted Profile route and selected Project resolve to an existing directory.';
  if (!pathWithin(directory, projectSelection.project.current_path)) {
    status = 'blocked';
    decision = 'deny';
    reason = 'The reviewed route is outside the selected stable Project boundary.';
  } else if (!isPathInside(root, absoluteDirectory)) {
    status = 'blocked';
    decision = 'deny';
    reason = 'The Profile route resolves outside the authorized root.';
  } else if (!fs.existsSync(absoluteDirectory)) {
    status = 'needs_structure_change';
    decision = 'warn';
    reason = 'The recommended directory does not exist; directory creation needs a separate governed ChangeSet.';
  } else {
    const stat = fs.lstatSync(absoluteDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      status = 'blocked';
      decision = 'deny';
      reason = 'The recommended directory is not a real non-symbolic-link directory.';
    } else if (fs.existsSync(absoluteTarget)) {
      status = 'blocked';
      decision = 'deny';
      reason = 'The recommended target already exists; Derived never overwrites it.';
    }
  }
  return {
    status,
    decision,
    reason,
    configured: true,
    rule_version_id: active?.rule_version_id ?? null,
    routing_rule_version_id: routeOverride?.rule_version_id ?? null,
    environment_policy_id: active?.id ?? null,
    profile_id: active?.policy.profile_id ?? null,
    profile_version: active?.policy.profile_version ?? null,
    project_id: projectSelection.project.id,
    project_name: projectSelection.project.name,
    project_path: projectSelection.project.current_path,
    project_basis: projectSelection.basis,
    role,
    route,
    directory,
    target,
    area_mapping: active?.policy.area_mappings?.find((mapping) => mapping.area_role === route.area) ?? null,
    project_candidates: [],
  };
}

function validateMaterial(material, name) {
  if (!material.blob_path || !fs.existsSync(material.blob_path)) {
    throw new Error(`${name} material is missing.`);
  }
  if (sha256File(material.blob_path) !== material.content_hash) {
    throw new Error(`${name} material hash does not match its Ledger record.`);
  }
}

function currentHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) return 'unsupported';
  return sha256File(filePath);
}

function publishOwnership(targetPath) {
  const publish_token = crypto.randomUUID();
  return { publish_token, temp_path: path.join(path.dirname(targetPath), `.atlas-derived-${publish_token}.publish.tmp`) };
}

function regularFileIdentity(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(leftPath, rightPath) {
  const left = regularFileIdentity(leftPath);
  const right = regularFileIdentity(rightPath);
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function atomicCreate(targetPath, blobPath, tempPath) {
  if (!fs.existsSync(tempPath)) fs.copyFileSync(blobPath, tempPath, fs.constants.COPYFILE_EXCL);
  if (currentHash(tempPath) !== sha256File(blobPath)) {
    throw new Error('Derived publish temporary file does not match the approved Candidate.');
  }
  fs.linkSync(tempPath, targetPath);
}

export class Derived {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('Derived requires a stateDir');
    this.stateDir = path.resolve(stateDir);
    this._ledger = null;
    this._projectContext = null;
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

  recommend({ root: rootInput, inputs, role, filename, projectId = null, routeOverride = null }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the Derived root: ${this.stateDir}`);
    }
    if (!Array.isArray(inputs) || (inputs.length === 0 && !projectId)) {
      throw new Error('Derived recommendation requires input paths or an explicit Project ID.');
    }
    const normalizedRole = normalizeRole(role);
    const normalizedFilename = normalizeFilename(filename);
    const normalizedInputs = [];
    const seen = new Set();
    for (const input of inputs) {
      const normalized = normalizeInput(root, input);
      if (!seen.has(normalized.relative)) normalizedInputs.push(normalized);
      seen.add(normalized.relative);
    }
    return placementRecommendation(
      this.ledger,
      root,
      normalizedInputs,
      normalizedRole,
      normalizedFilename,
      projectId,
      routeOverride,
    );
  }

  prepare({
    root: rootInput,
    inputs,
    target,
    candidateContent,
    candidateFile = null,
    projectId,
    role,
    relationType = 'derived_from',
    intent = null,
    targetImportance = 'normal',
    linkImpact = 0,
    predictionConfidence = 1,
    revisedFromRunId = null,
    allowNoInputs = false,
    intakeContext = null,
    caller = {},
    runId: requestedRunId = null,
    trustedInputs = null,
    internalPreflight = null,
  }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the Derived root: ${this.stateDir}`);
    }
    const receipt = withStateLock(this.stateDir, () => {
      internalPreflight?.();
      return this.#prepare({
      root,
      inputs,
      target,
      candidateContent,
      candidateFile,
      projectId,
      role,
      relationType,
      intent,
      targetImportance,
      linkImpact,
      predictionConfidence,
      revisedFromRunId,
      allowNoInputs,
      intakeContext,
      caller,
      requestedRunId,
      trustedInputs,
      });
    });
    if (candidateFile) {
      new RuntimeStorage({ stateDir: this.stateDir, ledger: this.ledger })
        .markCaptured(candidateFile, receipt.run_id);
    }
    return receipt;
  }

  #prepare({
    root,
    inputs,
    target,
    candidateContent,
    candidateFile,
    projectId,
    role,
    relationType,
    intent,
    targetImportance,
    linkImpact,
    predictionConfidence,
    revisedFromRunId,
    allowNoInputs,
    intakeContext,
    caller,
    requestedRunId,
    trustedInputs,
  }) {
    if (!Array.isArray(inputs) || (inputs.length === 0 && !allowNoInputs)) {
      throw new Error('Derived prepare requires at least one input path.');
    }
    if (!projectId) throw new Error('Derived prepare requires a Project ID.');
    const normalizedRole = normalizeRole(role);
    const normalizedRelation = normalizeRelationType(relationType);
    const normalizedTarget = normalizeNewTarget(root, target);
    const project = this.ledger.getProject(projectId);
    if (project.status !== 'active') throw new Error(`Derived Project is not active: ${projectId}`);
    if (!isTargetInsideProject(normalizedTarget.relative, project.current_path)) {
      throw new Error(
        `Derived target must be inside Project ${projectId} at ${project.current_path}: ${normalizedTarget.relative}`,
      );
    }
    const normalizedInputs = [];
    const inputPaths = new Set();
    for (const input of trustedInputs ?? inputs) {
      const normalized = trustedInputs
        ? normalizeTrustedInput(root, input)
        : normalizeInput(root, input);
      if (trustedInputs && normalized.sourceRootId) {
        const governedRoot = this.projectContext.getRoot(normalized.sourceRootId).root;
        if (path.resolve(governedRoot.current_path) !== path.resolve(normalized.sourceRootPath)
            || governedRoot.governance_status !== 'adopted') {
          throw new Error(`Trusted Derived input Root is not the active adopted Root: ${normalized.sourceRootId}`);
        }
        const location = this.projectContext.getActiveLocation(normalized.sourceProjectId);
        if (!location
            || location.root_id !== normalized.sourceRootId
            || !(normalized.sourceRelativePath === location.relative_path
              || normalized.sourceRelativePath.startsWith(`${location.relative_path}/`))) {
          throw new Error(`Trusted Derived input is outside its active source Project: ${normalized.relative}`);
        }
      }
      if (normalized.relative === normalizedTarget.relative) {
        throw new Error('Derived target cannot also be an input.');
      }
      if (inputPaths.has(normalized.relative)) continue;
      inputPaths.add(normalized.relative);
      normalizedInputs.push(normalized);
    }
    if (candidateContent == null && !candidateFile) {
      throw new Error('Derived prepare requires candidateContent or candidateFile.');
    }
    if (candidateContent != null && candidateFile) {
      throw new Error('Pass candidateContent or candidateFile, not both.');
    }

    let candidate;
    if (candidateFile) {
      const absoluteCandidate = path.resolve(candidateFile);
      if (isPathInside(root, absoluteCandidate)) {
        throw new Error('Derived Candidate must remain outside the governed root until execution.');
      }
      if (!fs.existsSync(absoluteCandidate)) {
        throw new Error(`Derived Candidate file does not exist: ${absoluteCandidate}`);
      }
      const stat = fs.lstatSync(absoluteCandidate);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Derived Candidate must be a regular non-symbolic-link file: ${absoluteCandidate}`);
      }
      candidate = captureBlob(absoluteCandidate, this.stateDir);
    } else if (Buffer.isBuffer(candidateContent)) {
      candidate = captureBuffer(candidateContent, this.stateDir);
    } else if (typeof candidateContent === 'string') {
      candidate = captureBuffer(Buffer.from(candidateContent, 'utf8'), this.stateDir);
    } else {
      throw new Error('candidateContent must be a string or Buffer.');
    }
    const capturedInputs = normalizedInputs.map((input) => ({
      path: input.relative,
      sourceRootId: input.sourceRootId ?? null,
      sourceProjectId: input.sourceProjectId ?? null,
      sourceRootPath: input.sourceRootPath ?? null,
      sourceRelativePath: input.sourceRelativePath ?? null,
      ...captureBlob(input.absolute, this.stateDir),
    }));
    const explicitIntakePlacement = intakeContext?.route_source === 'agent_explicit_target'
      && intakeContext.explicit_target === normalizedTarget.relative
      && intakeContext.project?.id === project.id
      ? {
          status: 'ready',
          decision: 'allow',
          reason: 'The Agent proposed one absent target inside the selected Project and the current request authorized its placement.',
          configured: false,
          rule_version_id: null,
          environment_policy_id: null,
          profile_id: null,
          profile_version: null,
          project_id: project.id,
          project_name: project.name,
          project_path: project.current_path,
          project_basis: 'explicit_project',
          role: normalizedRole,
          route: { source: 'agent_explicit_target' },
          directory: toPortablePath(path.dirname(normalizedTarget.relative)),
          target: normalizedTarget.relative,
          area_mapping: null,
          project_candidates: [],
        }
      : null;
    const recommendedPlacement = {
      ...(explicitIntakePlacement ?? placementRecommendation(
        this.ledger,
        root,
        normalizedInputs,
        normalizedRole,
        path.basename(normalizedTarget.relative),
        project.id,
        intakeContext?.route_override ?? null,
      )),
      ...(intakeContext ? { intake: intakeContext } : {}),
    };
    const placementPolicy = recommendedPlacement.status === 'ready'
      && recommendedPlacement.target === normalizedTarget.relative
      ? recommendedPlacement
      : {
          ...recommendedPlacement,
          decision: 'warn',
          reason: recommendedPlacement.status === 'ready'
            ? `Explicit target differs from the active Profile recommendation: ${recommendedPlacement.target}.`
            : recommendedPlacement.reason,
          explicit_target: normalizedTarget.relative,
        };
    const confidence = Number(predictionConfidence);
    const risk = evaluateRisk({
      operation: 'create',
      paths: [normalizedTarget.relative],
      fileCount: 1,
      targetImportance,
      linkImpact,
      recoveryAvailable: true,
      predictionConfidence: confidence,
      requestedMode: 'guarded',
    });
    if (risk.mode === 'deny') throw new Error(`Derived prepare denied: ${risk.reasons.join(' ')}`);
    const change = {
      path: normalizedTarget.relative,
      before: null,
      after: { kind: 'file', ...candidate },
    };
    const { diffText, diffHash } = buildCompleteDiff([change]);
    const startedAt = timestamp();
    const runId = requestedRunId ?? makeRunId();
    const ids = this.ledger.createDerivedRun({
      runId,
      root,
      targetPath: normalizedTarget.relative,
      intent,
      inputs: capturedInputs,
      candidate,
      project,
      role: normalizedRole,
      relationType: normalizedRelation,
      predictionConfidence: confidence,
      diffText,
      diffHash,
      risk,
      placementPolicy,
      revisedFromRunId,
      caller,
      startedAt,
    });
    return {
      run_id: runId,
      candidate_change_set_id: ids.candidateChangeSetId,
      placement_prediction_id: ids.placementPredictionId,
      status: 'prepared',
      target: normalizedTarget.relative,
      project_id: projectId,
      role: normalizedRole,
      inputs: capturedInputs.length,
      risk: risk.mode,
      placement_policy: placementPolicy,
      started_at: startedAt,
    };
  }

  preview(runId) {
    return this.ledger.getDerivedDetail(runId);
  }

  approve(runId, { reason = null } = {}) {
    return this.ledger.reviewDerived(runId, {
      decision: 'accepted',
      reason,
      reviewedAt: timestamp(),
    });
  }

  reject(runId, { reason = null } = {}) {
    return this.ledger.reviewDerived(runId, {
      decision: 'rejected',
      reason,
      reviewedAt: timestamp(),
    });
  }

  revise(runId, {
    target = null,
    role = null,
    candidateContent,
    candidateFile = null,
    reason = null,
  } = {}) {
    const original = this.preview(runId);
    if (!['prepared', 'approved', 'rejected', 'stale'].includes(original.run.status)) {
      throw new Error(`Derived run cannot be revised from status ${original.run.status}.`);
    }
    if (candidateContent != null && candidateFile) {
      throw new Error('Pass candidateContent or candidateFile, not both.');
    }
    const selectedCandidateFile = candidateContent == null && !candidateFile
      ? original.candidate.blob_path
      : candidateFile;
    const revised = this.prepare({
      root: original.run.root_path,
      inputs: original.inputs.map((input) => input.path),
      target: target ?? original.candidate.target_path,
      candidateContent,
      candidateFile: selectedCandidateFile,
      projectId: original.placement.project_id,
      role: role ?? original.placement.role,
      relationType: original.placement.relation_type,
      intent: original.run.intent,
      revisedFromRunId: runId,
      allowNoInputs: original.inputs.length === 0,
      intakeContext: original.placement.policy?.intake ?? null,
      caller: original.run.caller,
      trustedInputs: original.inputs.map((input) => ({
        path: input.path,
        sourceRootId: input.source_root_id,
        sourceProjectId: input.source_project_id,
        sourceRootPath: input.source_root_path,
        sourceRelativePath: input.source_relative_path,
      })),
    });
    this.ledger.markDerivedRevised(runId, revised.run_id, reason, timestamp());
    return revised;
  }

  promote(runId, { role, reason = null } = {}) {
    const detail = this.preview(runId);
    if (detail.run.status !== 'executed' || !detail.output) {
      throw new Error(`Derived role promotion requires executed status; current status is ${detail.run.status}.`);
    }
    const fromRole = normalizeRole(detail.output.role);
    const toRole = normalizeRole(role);
    if (fromRole === toRole) {
      return this.ledger.promoteDerivedArtifact(runId, {
        fromRole, toRole, reason, promotedAt: timestamp(),
      });
    }
    if (!(ROLE_TRANSITIONS[fromRole] ?? []).includes(toRole)) {
      throw new Error(`Derived role transition ${fromRole} → ${toRole} is not allowed.`);
    }
    return this.ledger.promoteDerivedArtifact(runId, {
      fromRole, toRole, reason, promotedAt: timestamp(),
    });
  }

  execute(runId, { internalPreflight = null } = {}) {
    return withStateLock(this.stateDir, () => this.#execute(runId, internalPreflight));
  }

  #execute(runId, internalPreflight = null) {
    const detail = this.preview(runId);
    if (detail.execution_receipt) {
      const targetPath = resolveCurrentTarget(detail.run.root_path, detail.candidate.target_path);
      const ownership = detail.events.find((event) => event.type === 'derived_execution_started')?.payload?.ownership;
      const tempPath = ownership?.temp_path;
      if (typeof tempPath === 'string'
          && path.dirname(tempPath) === path.dirname(targetPath)
          && currentHash(targetPath) === detail.candidate.content_hash
          && currentHash(tempPath) === detail.candidate.content_hash
          && sameFile(targetPath, tempPath)) {
        fs.rmSync(tempPath, { force: true });
      }
      return detail.execution_receipt;
    }
    if (detail.run.status !== 'approved') {
      throw new Error(`Derived execution requires approval; current status is ${detail.run.status}.`);
    }
    if (detail.approved_candidate_hash !== detail.candidate.content_hash) {
      throw new Error('Derived approval does not match the current Candidate ChangeSet.');
    }
    validateMaterial(detail.candidate, 'Candidate');
    for (const input of detail.inputs) {
      validateMaterial(input, `Input ${input.path}`);
      const inputRoot = input.source_root_path ?? detail.run.root_path;
      const inputPath = input.source_relative_path ?? input.path;
      const absoluteInput = path.resolve(inputRoot, ...inputPath.split('/'));
      const observed = currentHash(absoluteInput);
      if (observed !== input.content_hash) {
        this.ledger.markDerivedStale(runId, {
          reason: 'input_changed',
          input_path: input.path,
          expected_hash: input.content_hash,
          observed_hash: observed,
        }, timestamp());
        throw new Error(`Derived input changed after preview: ${input.path}`);
      }
    }

    const targetPath = resolveCurrentTarget(detail.run.root_path, detail.candidate.target_path);
    const startedEvent = detail.events.find((event) => event.type === 'derived_execution_started');
    const executionStarted = Boolean(startedEvent);
    const ownership = startedEvent?.payload?.ownership ?? null;
    let tempPath = ownership?.temp_path ?? null;
    const observedTarget = currentHash(targetPath);
    const ownershipProven = executionStarted
      && observedTarget === detail.candidate.content_hash
      && typeof tempPath === 'string'
      && path.dirname(tempPath) === path.dirname(targetPath)
      && currentHash(tempPath) === detail.candidate.content_hash && sameFile(targetPath, tempPath);
    if (observedTarget !== null && !ownershipProven) {
      this.ledger.markDerivedStale(runId, {
        reason: executionStarted && observedTarget === detail.candidate.content_hash
          ? 'ownership_unresolved' : 'target_claimed',
        target_path: detail.candidate.target_path,
        expected_hash: null,
        observed_hash: observedTarget,
      }, timestamp());
      throw new Error('Derived target already exists or was claimed after preview; approval is stale.');
    }
    if (observedTarget === null) {
      internalPreflight?.(detail);
      const started = this.ledger.startDerivedExecution(runId, timestamp(), publishOwnership(targetPath));
      const publishTemp = started.ownership?.temp_path;
      if (!publishTemp || path.dirname(publishTemp) !== path.dirname(targetPath)) throw new Error('Derived publish ownership is invalid.');
      tempPath = publishTemp;
      try {
        atomicCreate(targetPath, detail.candidate.blob_path, publishTemp);
      } catch (error) {
        const afterFailure = currentHash(targetPath);
        if (afterFailure === detail.candidate.content_hash && sameFile(targetPath, publishTemp)) {
          // The protected create completed or converged after Atlas recorded its intent.
        } else if (afterFailure !== null) {
          this.ledger.markDerivedStale(runId, {
            reason: 'target_claimed_during_create',
            target_path: detail.candidate.target_path,
            expected_hash: null,
            observed_hash: afterFailure,
            error: error.message,
          }, timestamp());
          throw error;
        } else {
          throw error;
        }
      }
    }
    if (currentHash(targetPath) !== detail.candidate.content_hash) {
      throw new Error('Derived verification failed: target does not match the approved Candidate.');
    }
    const executedAt = timestamp();
    const receipt = this.ledger.finishDerivedExecution(runId, {
      receipt: {
        run_id: runId,
        status: 'executed',
        changed_files: 1,
        target: detail.candidate.target_path,
        project_id: detail.placement.project_id,
        role: detail.placement.role,
        input_material_ids: detail.inputs.map((input) => input.material_id),
        relation_type: detail.placement.relation_type,
        after_sha256: detail.candidate.content_hash,
        verified: true,
        rollback_ready: true,
        executed_at: executedAt,
      },
      executedAt,
    });
    if (tempPath) fs.rmSync(tempPath, { force: true });
    return receipt;
  }

  rollback(runId) {
    return withStateLock(this.stateDir, () => {
      try {
        return this.#rollback(runId);
      } catch (error) {
        this.ledger.recordRollbackError(runId, error);
        throw error;
      }
    });
  }

  redo(runId) {
    return withStateLock(this.stateDir, () => {
      const detail = this.preview(runId);
      if (detail.run.status !== 'rolled_back') throw new Error(`Only a rolled back Derived run can be redone; current status is ${detail.run.status}.`);
      validateMaterial(detail.candidate, 'Candidate');
      for (const input of detail.inputs) {
        validateMaterial(input, `Input ${input.path}`);
        const inputRoot = input.source_root_path ?? detail.run.root_path;
        const inputPath = input.source_relative_path ?? input.path;
        if (currentHash(path.resolve(inputRoot, ...inputPath.split('/'))) !== input.content_hash) throw new Error(`Derived input changed after preview: ${input.path}`);
      }
      const targetPath = resolveCurrentTarget(detail.run.root_path, detail.candidate.target_path);
      const startedEvent = detail.events.find((event) => event.type === 'derived_redo_started');
      const started = startedEvent?.payload ?? null;
      let tempPath = started?.ownership?.temp_path ?? null;
      const observedTarget = currentHash(targetPath);
      const ownershipProven = observedTarget === detail.candidate.content_hash
        && typeof tempPath === 'string'
        && path.dirname(tempPath) === path.dirname(targetPath)
        && currentHash(tempPath) === detail.candidate.content_hash
        && sameFile(targetPath, tempPath);
      if (observedTarget !== null && !ownershipProven) throw new Error('Derived redo requires an empty target path.');
      if (observedTarget === null) {
        const intent = this.ledger.derived.startDerivedRedo(runId, timestamp(), publishOwnership(targetPath));
        tempPath = intent.ownership?.temp_path;
        if (!tempPath || path.dirname(tempPath) !== path.dirname(targetPath)) throw new Error('Derived redo ownership is invalid.');
        try {
          atomicCreate(targetPath, detail.candidate.blob_path, tempPath);
        } catch (error) {
          const afterFailure = currentHash(targetPath);
          if (!(afterFailure === detail.candidate.content_hash && sameFile(targetPath, tempPath))) throw error;
        }
      }
      if (currentHash(targetPath) !== detail.candidate.content_hash) throw new Error('Derived redo verification failed: target does not match the approved Candidate.');
      const redoneAt = timestamp();
      let committed = false;
      try {
        const receipt = this.ledger.derived.finishDerivedRedo(runId, { ...detail.execution_receipt, run_id: runId, status: 'executed', verified: true, rollback_ready: true, after_sha256: detail.candidate.content_hash, redone_at: redoneAt }, redoneAt);
        committed = true;
        return receipt;
      } finally {
        if (committed && tempPath) fs.rmSync(tempPath, { force: true });
      }
    });
  }

  #rollback(runId) {
    const detail = this.preview(runId);
    if (detail.rollback_receipt) return detail.rollback_receipt;
    if (detail.run.status !== 'executed') {
      throw new Error(`Only an executed Derived run can be rolled back; current status is ${detail.run.status}.`);
    }
    const consumers = this.ledger.getDerivedConsumers(runId);
    if (consumers.length) {
      throw new RollbackConflictError([{
        path: detail.candidate.target_path,
        kind: 'downstream_dependency',
        expected_end_hash: detail.output.content_hash,
        current_hash: currentHash(path.resolve(
          detail.run.root_path,
          ...detail.candidate.target_path.split('/'),
        )),
        downstream_runs: consumers,
      }]);
    }
    const targetPath = resolveCurrentTarget(detail.run.root_path, detail.candidate.target_path);
    const observed = currentHash(targetPath);
    const rollbackStarted = detail.events.some((event) => event.type === 'derived_rollback_started');
    if (observed !== detail.output.content_hash && !(observed === null && rollbackStarted)) {
      throw new RollbackConflictError([{
        path: detail.candidate.target_path,
        expected_end_hash: detail.output.content_hash,
        current_hash: observed === 'unsupported' ? null : observed,
        current_kind: observed === 'unsupported' ? 'unsupported' : observed === null ? 'missing' : 'file',
      }]);
    }
    if (observed === detail.output.content_hash) {
      const verified = currentHash(targetPath);
      if (verified !== detail.output.content_hash) {
        throw new RollbackConflictError([{
          path: detail.candidate.target_path,
          expected_end_hash: detail.output.content_hash,
          current_hash: verified === 'unsupported' ? null : verified,
          current_kind: verified === 'unsupported' ? 'unsupported' : verified === null ? 'missing' : 'file',
        }]);
      }
      this.ledger.startDerivedRollback(runId, timestamp());
      fs.rmSync(targetPath);
    }
    if (fs.existsSync(targetPath)) throw new Error('Derived rollback verification failed.');
    const rolledBackAt = timestamp();
    return this.ledger.finishDerivedRollback(runId, {
      run_id: runId,
      status: 'rolled_back',
      removed_files: 1,
      target: detail.candidate.target_path,
      retained_lineage: true,
      rolled_back_at: rolledBackAt,
    }, rolledBackAt);
  }

  dispose() {
    if (this._ledger) this._ledger.close();
    this._ledger = null;
    this._projectContext = null;
  }
}
