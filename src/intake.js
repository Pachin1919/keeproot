import fs from 'node:fs';
import path from 'node:path';
import { Derived } from './derived.js';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';
import { PreferenceRules } from './preference-rules.js';
import { ARTIFACT_ROLES } from './profiles.js';
import { sha256File } from './snapshots.js';

const ORIGINS = new Set(['human_submitted', 'human_written', 'agent_generated', 'download']);
const ROLE_IDS = new Set(ARTIFACT_ROLES.map((role) => role.id));
const KIND_ALIASES = new Map([
  ['raw', 'raw_input'],
  ['code', 'intermediate'],
  ['demo', 'intermediate'],
  ['asset', 'source'],
]);
const ORIGIN_DEFAULTS = Object.freeze({
  human_submitted: { kind: 'raw_input', role: 'raw_input' },
  human_written: { kind: 'note', role: 'note' },
  agent_generated: { kind: 'intermediate', role: 'intermediate' },
  download: { kind: 'source', role: 'source' },
});

function normalizeOrigin(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replaceAll('-', '_');
  if (normalized === 'agent') return 'agent_generated';
  if (!ORIGINS.has(normalized)) {
    throw new Error(`Intake origin must be one of: ${[...ORIGINS].join(', ')}.`);
  }
  return normalized;
}

function classify(origin, kindInput) {
  if (kindInput == null || !String(kindInput).trim()) {
    return { ...ORIGIN_DEFAULTS[origin], basis: 'origin_default', explicit: false };
  }
  const kind = String(kindInput).trim().toLowerCase().replaceAll('-', '_');
  const role = KIND_ALIASES.get(kind) ?? (ROLE_IDS.has(kind) ? kind : null);
  if (!role) return null;
  return { kind, role, basis: 'explicit_kind', explicit: true };
}

function normalizeKindKey(origin, kindInput) {
  if (kindInput == null || !String(kindInput).trim()) return ORIGIN_DEFAULTS[origin].kind;
  const kind = String(kindInput).trim().toLowerCase().replaceAll('-', '_');
  if (!/^[a-z0-9_]+$/u.test(kind)) throw new Error('Intake kind must use lowercase letters, digits, or underscores.');
  return kind;
}

function normalizeTargetSubdirectory(value) {
  const portable = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!portable) throw new Error('Routing correction requires a target subdirectory.');
  const normalized = path.posix.normalize(portable);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)
      || path.win32.isAbsolute(normalized)) {
    throw new Error('Routing correction target subdirectory must remain inside the selected Project.');
  }
  return normalized;
}

function normalizeFilename(value, fallback) {
  const filename = String(value ?? fallback).trim().normalize('NFC');
  if (!filename || filename === '.' || filename === '..' || path.basename(filename) !== filename
      || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Intake filename must be one file name without a directory.');
  }
  return filename;
}

function normalizeCandidate(root, candidateFile) {
  if (!candidateFile) throw new Error('Intake requires a Candidate file.');
  const absolute = path.resolve(candidateFile);
  if (isPathInside(root, absolute)) {
    throw new Error('Intake Candidate must remain outside the governed root until execution.');
  }
  if (!fs.existsSync(absolute)) throw new Error(`Intake Candidate does not exist: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Intake Candidate must be a regular non-symbolic-link file: ${absolute}`);
  }
  return {
    path: absolute,
    filename: path.basename(absolute),
    content_hash: sha256File(absolute),
    byte_size: stat.size,
  };
}

function explicitTargetRecommendation(ledger, root, targetInput, projectId, role) {
  if (!projectId) {
    return {
      status: 'needs_input',
      decision: 'warn',
      reason: 'An Agent-proposed target requires one explicit stable Project.',
      configured: false,
      rule_version_id: null,
      project_candidates: [],
    };
  }
  if (typeof targetInput !== 'string' || !targetInput.trim()) {
    throw new Error('Intake explicit target cannot be empty.');
  }
  const project = ledger.getProject(projectId);
  if (project.status !== 'active') {
    return {
      status: 'needs_input',
      decision: 'warn',
      reason: `Intake Project is not active: ${projectId}`,
      configured: false,
      rule_version_id: null,
      project_candidates: [],
    };
  }
  const lexical = path.isAbsolute(targetInput)
    ? path.resolve(targetInput)
    : path.resolve(root, targetInput);
  if (!isPathInside(root, lexical) || lexical === root) {
    throw new Error(`Intake explicit target escapes the root: ${targetInput}`);
  }
  const relative = toPortablePath(path.relative(root, lexical));
  const insideProject = relative.startsWith(`${project.current_path}/`);
  if (!insideProject) {
    return {
      status: 'blocked',
      decision: 'deny',
      reason: `The explicit target is outside Project ${projectId} at ${project.current_path}.`,
      configured: false,
      rule_version_id: null,
      project_id: project.id,
      project_name: project.name,
      project_path: project.current_path,
      project_basis: 'explicit_project',
      project_candidates: [],
      role,
      target: relative,
    };
  }
  if (fs.existsSync(lexical)) {
    return {
      status: 'blocked',
      decision: 'deny',
      reason: 'The explicit target already exists; Intake never overwrites it.',
      configured: false,
      rule_version_id: null,
      project_id: project.id,
      project_name: project.name,
      project_path: project.current_path,
      project_basis: 'explicit_project',
      project_candidates: [],
      role,
      target: relative,
    };
  }
  const parent = path.dirname(lexical);
  if (!fs.existsSync(parent)) {
    return {
      status: 'needs_structure_change',
      decision: 'warn',
      reason: 'The explicit target parent does not exist; directory creation needs a separate governed ChangeSet.',
      configured: false,
      rule_version_id: null,
      project_id: project.id,
      project_name: project.name,
      project_path: project.current_path,
      project_basis: 'explicit_project',
      project_candidates: [],
      role,
      target: relative,
    };
  }
  const parentStat = fs.lstatSync(parent);
  const realParent = parentStat.isDirectory() && !parentStat.isSymbolicLink()
    ? fs.realpathSync.native(parent)
    : null;
  if (!realParent || !isPathInside(root, realParent)) {
    return {
      status: 'blocked',
      decision: 'deny',
      reason: 'The explicit target parent must be a real directory inside the authorized root.',
      configured: false,
      rule_version_id: null,
      project_id: project.id,
      project_name: project.name,
      project_path: project.current_path,
      project_basis: 'explicit_project',
      project_candidates: [],
      role,
      target: relative,
    };
  }
  return {
    status: 'ready',
    decision: 'allow',
    reason: 'The Agent proposed one absent target inside the selected Project and the user task authorized its placement.',
    configured: false,
    rule_version_id: null,
    environment_policy_id: null,
    profile_id: null,
    profile_version: null,
    project_id: project.id,
    project_name: project.name,
    project_path: project.current_path,
    project_basis: 'explicit_project',
    role,
    route: { source: 'agent_explicit_target' },
    directory: toPortablePath(path.dirname(relative)),
    target: relative,
    area_mapping: null,
    project_candidates: [],
  };
}

function activeProjects(ledger) {
  return ledger.listProjects().filter((project) => project.status === 'active');
}

function stateConflict(message) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  return error;
}

export class Intake {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('Intake requires a stateDir');
    this.stateDir = path.resolve(stateDir);
    this.derived = new Derived({ stateDir: this.stateDir });
    this.rules = new PreferenceRules({ stateDir: this.stateDir, ledger: this.derived.ledger });
  }

  plan({
    root: rootInput,
    candidateFile,
    origin: originInput,
    kind = null,
    filename = null,
    projectId = null,
    target = null,
    inputs = [],
  }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the Intake root: ${this.stateDir}`);
    }
    if (!Array.isArray(inputs)) throw new Error('Intake inputs must be an array.');
    const candidate = normalizeCandidate(root, candidateFile);
    const origin = normalizeOrigin(originInput);
    const kindKey = normalizeKindKey(origin, kind);
    const baseClassification = classify(origin, kind);
    const selectedFilename = normalizeFilename(filename, candidate.filename);

    let selectedProjectId = projectId;
    let projectBasis = projectId ? 'explicit_project' : null;
    if (!selectedProjectId && inputs.length === 0) {
      const projects = activeProjects(this.derived.ledger);
      if (projects.length === 1) {
        selectedProjectId = projects[0].id;
        projectBasis = 'only_active_project';
      } else {
        return {
          schema: 'atlas-intake-plan.v1',
          status: 'needs_input',
          run_id: null,
          reason: projects.length
            ? 'More than one active Project could receive this file.'
            : 'No active Project can receive this file.',
          classification: baseClassification
            ? { origin, ...baseClassification }
            : { origin, kind: kindKey, role: null, basis: 'unresolved_kind' },
          project: null,
          target: null,
          confidence: baseClassification?.explicit ? 0.7 : 0.6,
          auto_execute: false,
          questions: [{
            field: 'project_id',
            prompt: 'Which stable Project should own this file?',
            options: projects.slice(0, 10).map((project) => ({
              project_id: project.id, name: project.name, path: project.current_path,
            })),
          }],
          candidate,
        };
      }
    }

    const attention = this.rules.context({
      root,
      request: {
        operation: 'intake',
        project_id: selectedProjectId,
        origin,
        kind: kindKey,
        artifact_role: baseClassification?.role ?? null,
        extension: path.extname(selectedFilename).toLowerCase(),
        candidate_hash: candidate.content_hash,
      },
    });
    if (attention.conflicts.some((item) => item.kind === 'placement')) {
      return {
        schema: 'atlas-intake-plan.v1',
        status: 'needs_input',
        run_id: null,
        reason: 'Reviewed placement preferences conflict for this Intake request.',
        classification: baseClassification
          ? { origin, ...baseClassification }
          : { origin, kind: kindKey, role: null, basis: 'unresolved_kind' },
        project: selectedProjectId ? { id: selectedProjectId } : null,
        target: null,
        attention,
        confidence: 0,
        auto_execute: false,
        questions: [{
          field: 'preference_rule',
          prompt: 'Review the conflicting placement preferences before Intake.',
          options: attention.conflicts.find((item) => item.kind === 'placement').rule_ids,
        }],
        candidate,
      };
    }
    const preference = attention.applied_rules.find((item) => item.kind === 'placement') ?? null;
    const correction = this.derived.ledger.findRoutingCorrection({
      root,
      origin,
      kind: kindKey,
      candidateHash: candidate.content_hash,
      projectId: selectedProjectId,
    });
    const classification = correction
      ? { kind: kindKey, role: correction.role, basis: 'routing_correction', explicit: true }
      : preference
        ? { kind: kindKey, role: preference.value.role, basis: 'preference_rule', explicit: true }
      : baseClassification;
    if (!classification) {
      return {
        schema: 'atlas-intake-plan.v1',
        status: 'needs_input',
        run_id: null,
        reason: `The content kind ${kind} is not in the current V1 vocabulary and has no reviewed correction.`,
        classification: { origin, kind: kindKey, role: null, basis: 'unresolved_kind' },
        project: null,
        target: null,
        correction: null,
        confidence: 0,
        auto_execute: false,
        questions: [{
          field: 'kind',
          prompt: 'Choose the closest current kind or create one scoped routing correction.',
          options: ['raw_input', 'source', 'note', 'draft', 'intermediate', 'report', 'canonical', 'template', 'code', 'demo', 'asset'],
        }],
        candidate,
      };
    }

    const routeOverride = correction ? {
      ...correction,
      source: 'reviewed_routing_correction',
    } : preference ? {
      preference_rule_id: preference.rule_id,
      rule_version_id: preference.rule_version_id,
      target_subdirectory: preference.value.target_subdirectory,
      source: 'reviewed_preference_rule',
    } : null;
    let recommendation;
    if (target) {
      recommendation = explicitTargetRecommendation(
        this.derived.ledger,
        root,
        target,
        selectedProjectId,
        classification.role,
      );
    } else {
      try {
        recommendation = this.derived.recommend({
          root,
          inputs,
          role: classification.role,
          filename: selectedFilename,
          projectId: selectedProjectId,
          routeOverride,
        });
      } catch (error) {
        if (/project|inputs_do_not_identify|multiple_projects/i.test(error.message)) {
          return {
            schema: 'atlas-intake-plan.v1',
            status: 'needs_input',
            run_id: null,
            reason: error.message,
            classification: { origin, ...classification },
            project: null,
            target: null,
            confidence: 0.6,
            auto_execute: false,
            questions: [{ field: 'project_id', prompt: 'Select one active Project for this file.', options: [] }],
            candidate,
          };
        }
        throw error;
      }
    }
    if (!selectedProjectId && recommendation.project_id) {
      selectedProjectId = recommendation.project_id;
      projectBasis = recommendation.project_basis;
    }
    const confidence = Number((
      (classification.explicit ? 0.96 : 0.93)
      - (projectBasis === 'explicit_project' ? 0 : 0.02)
    ).toFixed(2));
    const status = recommendation.status;
    return {
      schema: 'atlas-intake-plan.v1',
      status,
      run_id: null,
      reason: recommendation.reason,
      classification: { origin, ...classification },
      project: recommendation.project_id ? {
        id: recommendation.project_id,
        name: recommendation.project_name,
        path: recommendation.project_path,
        basis: projectBasis ?? recommendation.project_basis,
      } : null,
      target: recommendation.target ?? null,
      route: recommendation.route ?? null,
      rule_version_id: recommendation.rule_version_id ?? null,
      correction: correction ? {
        correction_id: correction.correction_id,
        rule_version_id: correction.rule_version_id,
        scope: correction.scope,
        role: correction.role,
        target_subdirectory: correction.target_subdirectory,
      } : null,
      preference: preference ? {
        rule_id: preference.rule_id,
        rule_version_id: preference.rule_version_id,
        scope: preference.scope,
        target_subdirectory: preference.value.target_subdirectory,
      } : null,
      attention,
      confidence,
      auto_execute: status === 'ready' && recommendation.decision === 'allow' && confidence >= 0.9,
      questions: status === 'unresolved' ? [{
        field: 'project_id',
        prompt: 'Select or correct the Project/routing rule before Intake.',
        options: recommendation.project_candidates ?? [],
      }] : [],
      candidate,
    };
  }

  prepare(options) {
    const plan = this.plan(options);
    if (!plan.auto_execute) return plan;
    const intakeContext = {
      schema: 'atlas-intake-context.v1',
      origin: plan.classification.origin,
      kind: plan.classification.kind,
      classification_basis: plan.classification.basis,
      confidence: plan.confidence,
      auto_execute: true,
      contract_rule_version_id: plan.rule_version_id,
      route_source: plan.route?.source ?? null,
      explicit_target: plan.route?.source === 'agent_explicit_target' ? plan.target : null,
      project: plan.project,
      correction: plan.correction,
      preference: plan.preference,
      attention: plan.attention,
      route_override: plan.correction ? {
        correction_id: plan.correction.correction_id,
        rule_version_id: plan.correction.rule_version_id,
        target_subdirectory: plan.correction.target_subdirectory,
        source: 'reviewed_routing_correction',
      } : plan.preference ? {
        preference_rule_id: plan.preference.rule_id,
        rule_version_id: plan.preference.rule_version_id,
        target_subdirectory: plan.preference.target_subdirectory,
        source: 'reviewed_preference_rule',
      } : null,
      source: plan.candidate,
    };
    const prepared = this.derived.prepare({
      root: options.root,
      inputs: options.inputs ?? [],
      target: plan.target,
      candidateFile: options.candidateFile,
      projectId: plan.project.id,
      role: plan.classification.role,
      relationType: options.relationType ?? 'derived_from',
      intent: options.intent ?? `Intake ${plan.classification.origin} ${plan.classification.kind}`,
      predictionConfidence: plan.confidence,
      allowNoInputs: true,
      intakeContext,
      caller: options.caller ?? {},
    });
    return {
      ...plan,
      ...prepared,
      classification: plan.classification,
      confidence: plan.confidence,
      auto_execute: true,
      questions: [],
    };
  }

  show(runId) {
    return this.derived.preview(runId);
  }

  correct({
    root: rootInput,
    scope,
    candidateFile = null,
    projectId = null,
    origin: originInput,
    kind,
    role,
    targetSubdirectory,
    reason,
    caller = {},
  }) {
    const root = normalizeRoot(rootInput);
    if (!['artifact', 'project', 'global'].includes(scope)) {
      throw new Error('Routing correction scope must be artifact, project, or global.');
    }
    if (!reason?.trim()) throw new Error('Routing correction requires a reason.');
    const origin = normalizeOrigin(originInput);
    const kindKey = normalizeKindKey(origin, kind);
    if (!ROLE_IDS.has(role)) throw new Error(`Routing correction role must be a supported role: ${role}.`);
    const subdirectory = normalizeTargetSubdirectory(targetSubdirectory);
    let scopeKey = '*';
    if (scope === 'artifact') {
      scopeKey = `sha256:${normalizeCandidate(root, candidateFile).content_hash}`;
    } else if (scope === 'project') {
      if (!projectId) throw new Error('Project-scoped routing correction requires a Project ID.');
      const project = this.derived.ledger.getProject(projectId);
      if (project.status !== 'active') throw new Error(`Routing correction Project is not active: ${projectId}`);
      scopeKey = projectId;
    }
    if (!this.derived.ledger.getActiveEnvironmentPolicy(root)) {
      throw new Error('Routing correction requires an active Library Contract.');
    }
    return this.derived.ledger.createRoutingCorrection({
      root,
      scopeType: scope,
      scopeKey,
      origin,
      kind: kindKey,
      role,
      targetSubdirectory: subdirectory,
      reason: reason.trim(),
      caller,
    });
  }

  batchPlan({ root, items }) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('Intake batch plan requires at least one item.');
    const plans = items.map((item, index) => ({ index, ...this.plan({ root, ...item }) }));
    const questionMap = new Map();
    for (const item of plans) {
      for (const question of item.questions ?? []) {
        const key = `${question.field}|${question.prompt}`;
        const aggregated = questionMap.get(key) ?? { ...question, item_indices: [] };
        aggregated.item_indices.push(item.index);
        questionMap.set(key, aggregated);
      }
    }
    return {
      schema: 'atlas-intake-batch-plan.v1',
      status: plans.every((item) => item.status === 'ready') ? 'ready' : 'needs_input',
      summary: {
        total: plans.length,
        ready: plans.filter((item) => item.status === 'ready').length,
        unresolved: plans.filter((item) => !['ready', 'blocked'].includes(item.status)).length,
        blocked: plans.filter((item) => item.status === 'blocked').length,
      },
      items: plans,
      questions: [...questionMap.values()],
      source_changes: [],
    };
  }

  execute(runId, { reason = null } = {}) {
    if (!reason?.trim()) throw new Error('Intake execution requires the user task authorization reason.');
    const detail = this.show(runId);
    const context = detail.placement.policy?.intake;
    if (!context?.auto_execute || context.confidence < 0.9) {
      throw new Error('Intake execution is not allowed without a high-confidence Intake policy.');
    }
    const source = context.source;
    if (!source?.path || !fs.existsSync(source.path)) {
      throw stateConflict('Intake source Candidate no longer exists; prepare a new Intake run.');
    }
    const sourceStat = fs.lstatSync(source.path);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()
        || sourceStat.size !== source.byte_size || sha256File(source.path) !== source.content_hash) {
      throw stateConflict('Intake source Candidate changed after prepare; prepare a new Intake run.');
    }
    const project = this.derived.ledger.getProject(detail.placement.project_id);
    const preparedProjectPath = detail.placement.policy?.project_path;
    if (project.status !== 'active' || !preparedProjectPath || project.current_path !== preparedProjectPath) {
      throw stateConflict('Intake Project changed after prepare; recompute placement before execution.');
    }
    const activePolicy = this.derived.ledger.getActiveEnvironmentPolicy(detail.run.root_path);
    if (context.contract_rule_version_id
        && (!activePolicy || activePolicy.rule_version_id !== context.contract_rule_version_id)) {
      throw stateConflict('The active Library Contract changed after Intake prepare; recompute placement.');
    }
    if (context.correction) {
      const currentCorrection = this.derived.ledger.findRoutingCorrection({
        root: detail.run.root_path,
        origin: context.origin,
        kind: context.kind,
        candidateHash: context.source.content_hash,
        projectId: detail.placement.project_id,
      });
      if (currentCorrection?.correction_id !== context.correction.correction_id) {
        throw stateConflict('The reviewed Intake routing correction changed after prepare; recompute placement.');
      }
    }
    if (context.attention) {
      const currentAttention = this.rules.context({
        root: detail.run.root_path,
        request: context.attention.request,
      });
      if (currentAttention.context_hash !== context.attention.context_hash) {
        throw stateConflict('The effective rule context changed after Intake prepare; recompute placement.');
      }
    }
    this.derived.approve(runId, { reason: reason.trim() });
    const receipt = this.derived.execute(runId);
    return { ...receipt, intake: context };
  }

  rollback(runId) {
    return this.derived.rollback(runId);
  }

  dispose() {
    this.rules.dispose();
    this.derived.dispose();
  }
}
