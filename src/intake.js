import fs from 'node:fs';
import path from 'node:path';
import { Derived } from './derived.js';
import { isPathInside, normalizeRoot } from './paths.js';
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
  }

  plan({
    root: rootInput,
    candidateFile,
    origin: originInput,
    kind = null,
    filename = null,
    projectId = null,
    inputs = [],
  }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the Intake root: ${this.stateDir}`);
    }
    if (!Array.isArray(inputs)) throw new Error('Intake inputs must be an array.');
    const candidate = normalizeCandidate(root, candidateFile);
    const origin = normalizeOrigin(originInput);
    const classification = classify(origin, kind);
    const selectedFilename = normalizeFilename(filename, candidate.filename);
    if (!classification) {
      return {
        schema: 'atlas-intake-plan.v1',
        status: 'needs_input',
        run_id: null,
        reason: `The content kind ${kind} is not in the current V1 vocabulary.`,
        classification: { origin, kind, role: null, basis: 'unresolved_kind' },
        project: null,
        target: null,
        confidence: 0,
        auto_execute: false,
        questions: [{
          field: 'kind',
          prompt: 'Choose the closest current kind or define a routing rule in a new Contract version.',
          options: ['raw_input', 'source', 'note', 'draft', 'intermediate', 'report', 'canonical', 'template', 'code', 'demo', 'asset'],
        }],
        candidate,
      };
    }

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
          classification: { origin, ...classification },
          project: null,
          target: null,
          confidence: classification.explicit ? 0.7 : 0.6,
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

    let recommendation;
    try {
      recommendation = this.derived.recommend({
        root,
        inputs,
        role: classification.role,
        filename: selectedFilename,
        projectId: selectedProjectId,
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
    if (!activePolicy || activePolicy.rule_version_id !== context.contract_rule_version_id) {
      throw stateConflict('The active Library Contract changed after Intake prepare; recompute placement.');
    }
    this.derived.approve(runId, { reason: reason.trim() });
    const receipt = this.derived.execute(runId);
    return { ...receipt, intake: context };
  }

  rollback(runId) {
    return this.derived.rollback(runId);
  }

  dispose() {
    this.derived.dispose();
  }
}
