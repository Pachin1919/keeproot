import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from './ledger.js';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';
import { ARTIFACT_ROLES } from './profiles.js';
import { withStateLock } from './state-lock.js';

const WORKFLOW_RULE_VERSION_ID = 'RULE-PREFERENCE-WORKFLOW-1';
const RULE_KINDS = new Set([
  'naming',
  'placement',
  'directory_role',
  'storage',
  'content_versioning',
  'project_type',
  'agent_output',
]);
const SCOPE_TYPES = new Set(['artifact', 'project', 'library']);
const BASIS_TYPES = new Set(['observed', 'default']);
const ROLE_IDS = new Set(ARTIFACT_ROLES.map((item) => item.id));
const WRITE_STRATEGIES = new Set(['create', 'delta', 'new_version', 'supersede']);
const OPERATION_NEEDS = Object.freeze({
  intake: ['placement', 'naming', 'agent_output'],
  content_work: ['content_versioning', 'naming', 'agent_output'],
  organize: ['directory_role', 'naming', 'storage'],
  project_inspect: ['project_type', 'directory_role', 'storage'],
});
const IMPACT_CONSUMERS = Object.freeze({
  naming: ['rule.context', 'intake', 'save'],
  placement: ['rule.context', 'intake'],
  directory_role: ['rule.context'],
  storage: ['rule.context'],
  content_versioning: ['rule.context', 'save'],
  project_type: ['rule.context'],
  agent_output: ['rule.context', 'intake', 'save'],
});
const DEFAULT_ADVICE = Object.freeze({
  naming: {
    id: 'default.naming.preserve-existing.v1',
    kind: 'naming',
    summary: 'Preserve the Library language and stable names; add dates only when the date is part of the content meaning.',
    value: {
      language: 'preserve_existing',
      date_policy: 'semantic_only',
      date_format: 'YYYY-MM',
      rename_on_content_edit: false,
    },
  },
  storage: {
    id: 'default.storage.local-work.v1',
    kind: 'storage',
    summary: 'Keep technical Temp and Agent candidates outside durable Library content.',
    value: {
      technical_temp: 'atlas_tmp',
      agent_candidates: 'atlas_work',
      inbox_is_durable: true,
      generated_cache_is_durable: false,
    },
  },
  content_versioning: {
    id: 'default.content-versioning.preserve-prior.v1',
    kind: 'content_versioning',
    summary: 'Preserve prior source material and select the write strategy from declared coverage and data class.',
    value: {
      strategy: 'auto',
      preserve_prior: true,
      date_basis: 'semantic',
    },
  },
  agent_output: {
    id: 'default.agent-output.governed-handoff.v1',
    kind: 'agent_output',
    summary: 'Stage Agent candidates in Atlas Work and create durable outputs only through Save.',
    value: {
      candidate_area: 'atlas_work',
      durable_handoff: 'save',
      final_requires_verified_receipt: true,
    },
  },
});

function timestamp() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

function hashJson(value) {
  return crypto.createHash('sha256').update(json(value)).digest('hex');
}

function stateConflict(message) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  return error;
}

function normalizeRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (Object.keys(value).length > 16 || Buffer.byteLength(json(value), 'utf8') > 16 * 1024) {
    throw new Error(`${label} is too large.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(key)) throw new Error(`${label} contains an invalid field: ${key}.`);
    const validPrimitive = item == null || ['string', 'number', 'boolean'].includes(typeof item);
    const validArray = Array.isArray(item)
      && item.length <= 20
      && item.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry));
    if (!validPrimitive && !validArray) {
      throw new Error(`${label}.${key} must be a primitive value or a short primitive array.`);
    }
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizePortableSubdirectory(value, label) {
  const portable = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  const normalized = path.posix.normalize(portable);
  if (!portable || normalized === '..' || normalized.startsWith('../')
      || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new Error(`${label} must remain inside the selected Project.`);
  }
  return normalized;
}

function validateRuleValue(kind, value) {
  if (kind === 'placement') {
    if (!ROLE_IDS.has(value.role)) throw new Error('Placement preference requires a supported role.');
    value.target_subdirectory = normalizePortableSubdirectory(
      value.target_subdirectory,
      'Placement target_subdirectory',
    );
  }
  if (kind === 'content_versioning' && value.strategy !== 'auto' && !WRITE_STRATEGIES.has(value.strategy)) {
    throw new Error(`Content versioning strategy must be auto or one of: ${[...WRITE_STRATEGIES].join(', ')}.`);
  }
  if (kind === 'naming' && value.rename_on_content_edit === true) {
    throw new Error('V1 naming preferences cannot rename a file merely because its content changed.');
  }
  return value;
}

function normalizeEvidence(root, basis, evidence) {
  if (!Array.isArray(evidence) || evidence.length > 12) {
    throw new Error('Rule evidence must be an array with at most 12 items.');
  }
  if (basis === 'observed' && evidence.length === 0) {
    throw new Error('An observed preference requires at least one evidence item.');
  }
  return evidence.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Each rule evidence item must be an object.');
    }
    if (typeof item.fact !== 'string' || !item.fact.trim() || item.fact.length > 500) {
      throw new Error('Each rule evidence item requires one bounded fact.');
    }
    if (typeof item.path !== 'string' || !item.path.trim()) {
      throw new Error('Each rule evidence item requires a path observed inside the Library.');
    }
    const lexical = path.isAbsolute(item.path) ? path.resolve(item.path) : path.resolve(root, item.path);
    if (!isPathInside(root, lexical) || lexical === root || !fs.existsSync(lexical)) {
      throw new Error(`Rule evidence path is outside the Library or missing: ${item.path}`);
    }
    const stat = fs.lstatSync(lexical);
    if (stat.isSymbolicLink()) throw new Error(`Rule evidence cannot use a symbolic link: ${item.path}`);
    return {
      path: toPortablePath(path.relative(root, lexical)),
      fact: item.fact.trim(),
    };
  });
}

function normalizeScope(ledger, root, scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !SCOPE_TYPES.has(scope.type)) {
    throw new Error(`Rule scope must be one of: ${[...SCOPE_TYPES].join(', ')}.`);
  }
  if (scope.type === 'library') return { type: 'library', key: '*' };
  if (scope.type === 'project') {
    if (typeof scope.project_id !== 'string' || !scope.project_id.trim()) {
      throw new Error('Project-scoped preference requires project_id.');
    }
    const project = ledger.getProject(scope.project_id);
    if (project.status !== 'active' || !project.current_path) {
      throw new Error(`Preference Project is not active: ${scope.project_id}`);
    }
    const projectPath = path.resolve(root, ...project.current_path.split('/'));
    if (!isPathInside(root, projectPath) || !fs.existsSync(projectPath)) {
      throw new Error(`Preference Project path is outside or missing from this Library: ${project.current_path}`);
    }
    return { type: 'project', key: project.id };
  }
  if (typeof scope.path !== 'string' || !scope.path.trim()) {
    throw new Error('Artifact-scoped preference requires path.');
  }
  const lexical = path.isAbsolute(scope.path) ? path.resolve(scope.path) : path.resolve(root, scope.path);
  if (!isPathInside(root, lexical) || lexical === root || !fs.existsSync(lexical)) {
    throw new Error(`Artifact preference path is outside or missing from this Library: ${scope.path}`);
  }
  return { type: 'artifact', key: toPortablePath(path.relative(root, lexical)) };
}

function normalizeProposal(ledger, root, proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('Rule proposal must be an object.');
  }
  if (!RULE_KINDS.has(proposal.kind)) {
    throw new Error(`Rule kind must be one of: ${[...RULE_KINDS].join(', ')}.`);
  }
  const scope = normalizeScope(ledger, root, proposal.scope);
  const condition = normalizeRecord(proposal.condition ?? {}, 'Rule condition');
  const value = validateRuleValue(
    proposal.kind,
    normalizeRecord(proposal.value ?? {}, 'Rule value'),
  );
  const basis = proposal.basis ?? 'observed';
  if (!BASIS_TYPES.has(basis)) throw new Error('Rule basis must be observed or default.');
  const confidence = Number(proposal.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Rule confidence must be between 0 and 1.');
  }
  if (basis === 'observed' && confidence < 0.75) {
    throw new Error('Observed evidence is not sufficient to propose a reusable rule; keep it as local advice.');
  }
  if (typeof proposal.summary !== 'string' || !proposal.summary.trim() || proposal.summary.length > 500) {
    throw new Error('Rule proposal requires a bounded summary.');
  }
  const priority = proposal.priority ?? 100;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1000) {
    throw new Error('Rule priority must be an integer from 0 to 1000.');
  }
  if (basis === 'default') {
    const advice = DEFAULT_ADVICE[proposal.kind];
    if (!advice || proposal.default_id !== advice.id || hashJson(value) !== hashJson(advice.value)) {
      throw new Error('A default-based proposal must exactly reference the current Atlas default advice.');
    }
  }
  const evidence = normalizeEvidence(root, basis, proposal.evidence ?? []);
  return {
    schema: 'atlas-preference-rule-candidate.v1',
    root_path: root,
    kind: proposal.kind,
    scope,
    condition,
    value,
    summary: proposal.summary.trim(),
    basis,
    default_id: basis === 'default' ? proposal.default_id : null,
    confidence,
    priority,
    evidence,
  };
}

function rowToRule(row) {
  if (!row) return null;
  return {
    rule_id: row.id,
    run_id: row.run_id,
    rule_version_id: row.rule_version_id,
    root: row.root_path,
    scope: { type: row.scope_type, key: row.scope_key },
    kind: row.kind,
    condition: parseJson(row.condition_json, {}),
    value: parseJson(row.value_json, {}),
    priority: row.priority,
    status: row.status,
    summary: row.summary,
    basis: row.basis,
    evidence: parseJson(row.evidence_json, []),
    created_at: row.created_at,
    superseded_at: row.superseded_at,
  };
}

function routingCorrectionToRule(correction) {
  if (!correction) return null;
  return {
    rule_id: correction.correction_id,
    run_id: correction.run_id,
    rule_version_id: correction.rule_version_id,
    root: null,
    scope: {
      type: correction.scope === 'global' ? 'library' : correction.scope,
      key: correction.scope_key,
    },
    kind: 'placement',
    condition: {
      origin: correction.origin,
      kind: correction.kind,
    },
    value: {
      role: correction.role,
      target_subdirectory: correction.target_subdirectory,
    },
    priority: 1000,
    status: correction.status,
    summary: `Reviewed Intake routing correction: ${correction.reason}`,
    basis: 'reviewed_correction',
    evidence: [],
    created_at: '',
    superseded_at: null,
  };
}

function scopeMatches(rule, request) {
  if (rule.scope.type === 'library') return true;
  if (rule.scope.type === 'project') return rule.scope.key === request.project_id;
  if (rule.scope.key.startsWith('sha256:')) return rule.scope.key === `sha256:${request.candidate_hash}`;
  return rule.scope.key === request.artifact_path || rule.scope.key === request.target_path;
}

function conditionMatches(condition, request) {
  return Object.entries(condition).every(([key, expected]) => {
    if (key === 'path_prefix') {
      const actualPath = request.artifact_path ?? request.target_path;
      return typeof actualPath === 'string'
        && (actualPath === expected || actualPath.startsWith(`${expected}/`));
    }
    const actual = request[key];
    if (Array.isArray(expected)) return expected.includes(actual);
    return actual === expected;
  });
}

function scopeRank(scopeType) {
  return scopeType === 'artifact' ? 3 : scopeType === 'project' ? 2 : 1;
}

function proposalImpact(kind, scope) {
  return {
    scope,
    consumers: IMPACT_CONSUMERS[kind],
    future_behavior: kind === 'placement'
      ? 'Matching Intake requests can reuse the reviewed destination without another placement question.'
      : kind === 'content_versioning'
        ? 'Matching Save or Work requests can reuse the reviewed write strategy.'
        : 'Matching Host work receives this rule in compact effective context.',
    source_changes: [],
  };
}

function difference(currentRule, candidate) {
  const before = currentRule ? { condition: currentRule.condition, value: currentRule.value } : null;
  const after = { condition: candidate.condition, value: candidate.value };
  const keys = [...new Set([
    ...Object.keys(before?.value ?? {}),
    ...Object.keys(after.value),
  ])].sort();
  return {
    before,
    after,
    changed_value_fields: keys.filter((key) => json(before?.value?.[key]) !== json(after.value[key])),
  };
}

export class PreferenceRules {
  constructor({ stateDir, ledger = null }) {
    if (!stateDir) throw new Error('PreferenceRules requires a stateDir.');
    this.stateDir = path.resolve(stateDir);
    this._ledger = ledger;
    this.ownsLedger = ledger == null;
  }

  get ledger() {
    if (!this._ledger) this._ledger = new Ledger(this.stateDir);
    return this._ledger;
  }

  active({ root: rootInput }) {
    const root = normalizeRoot(rootInput);
    return this.ledger.db.prepare(`
      SELECT * FROM preference_rules
      WHERE root_path = ? AND status = 'active'
      ORDER BY kind, priority DESC, created_at DESC, rowid DESC
    `).all(root).map(rowToRule);
  }

  history({ root: rootInput }) {
    const root = normalizeRoot(rootInput);
    return this.ledger.db.prepare(`
      SELECT * FROM preference_rules
      WHERE root_path = ?
      ORDER BY created_at, rowid
    `).all(root).map(rowToRule);
  }

  context({ root: rootInput, request = {} }) {
    const root = normalizeRoot(rootInput);
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('Effective rule context request must be an object.');
    }
    const needs = [...new Set(request.needs ?? OPERATION_NEEDS[request.operation] ?? [])];
    for (const kind of needs) {
      if (!RULE_KINDS.has(kind)) throw new Error(`Unknown effective-context need: ${kind}`);
    }
    const legacyPlacement = request.origin && request.kind
      ? routingCorrectionToRule(this.ledger.findRoutingCorrection({
          root,
          origin: request.origin,
          kind: request.kind,
          candidateHash: request.candidate_hash ?? null,
          projectId: request.project_id ?? null,
        }))
      : null;
    const matched = [...this.active({ root }), ...(legacyPlacement ? [legacyPlacement] : [])]
      .filter((rule) => scopeMatches(rule, request) && conditionMatches(rule.condition, request));
    const applied = [];
    const conflicts = [];
    for (const kind of needs) {
      const candidates = matched.filter((rule) => rule.kind === kind)
        .sort((left, right) => (
          scopeRank(right.scope.type) - scopeRank(left.scope.type)
          || right.priority - left.priority
          || right.created_at.localeCompare(left.created_at)
        ));
      if (!candidates.length) continue;
      const winner = candidates[0];
      const sameRank = candidates.filter((candidate) => (
        scopeRank(candidate.scope.type) === scopeRank(winner.scope.type)
        && candidate.priority === winner.priority
      ));
      const distinctValues = new Map(sameRank.map((item) => [hashJson(item.value), item]));
      if (distinctValues.size > 1) {
        conflicts.push({
          kind,
          rule_ids: sameRank.map((item) => item.rule_id),
          reason: 'Equally specific active rules have different values.',
        });
      } else {
        applied.push(winner);
      }
    }
    const appliedKinds = new Set(applied.map((rule) => rule.kind));
    const conflictKinds = new Set(conflicts.map((item) => item.kind));
    const gaps = needs.filter((kind) => !appliedKinds.has(kind) && !conflictKinds.has(kind));
    const defaultAdvice = gaps.flatMap((kind) => DEFAULT_ADVICE[kind] ? [DEFAULT_ADVICE[kind]] : []);
    const missingWithoutDefault = gaps.filter((kind) => !DEFAULT_ADVICE[kind]);
    const status = conflicts.length
      ? 'conflict'
      : gaps.length === 0
        ? 'learned'
        : missingWithoutDefault.length
          ? 'needs_agent_proposal'
          : 'advice_available';
    const compactRule = (rule) => ({
      rule_id: rule.rule_id,
      rule_version_id: rule.rule_version_id,
      scope: rule.scope,
      kind: rule.kind,
      condition: rule.condition,
      value: rule.value,
      summary: rule.summary,
      basis: rule.basis,
    });
    const compactRules = applied.map(compactRule);
    const compactEligibleRules = [...new Map(
      matched
        .filter((rule) => needs.includes(rule.kind))
        .map((rule) => [rule.rule_id, compactRule(rule)]),
    ).values()].sort((left, right) => (
      left.kind.localeCompare(right.kind) || left.rule_id.localeCompare(right.rule_id)
    ));
    const contextHash = hashJson({
      root,
      request,
      eligible: compactEligibleRules.map((item) => ({
        rule_id: item.rule_id,
        rule_version_id: item.rule_version_id,
      })),
      applied: compactRules.map((item) => ({
        rule_id: item.rule_id,
        rule_version_id: item.rule_version_id,
      })),
      gaps,
      default_advice: defaultAdvice.map((item) => item.id),
      conflicts,
    });
    const modelPayload = {
      status,
      eligible_rules: compactEligibleRules,
      applied_rules: compactRules,
      gaps,
      default_advice: defaultAdvice,
      conflicts,
    };
    const modelPayloadBytes = Buffer.byteLength(json(modelPayload), 'utf8');
    return {
      schema: 'atlas-effective-rule-context.v1',
      status,
      root,
      request,
      context_hash: contextHash,
      eligible_rules: compactEligibleRules,
      applied_rules: compactRules,
      gaps,
      default_advice: defaultAdvice,
      conflicts,
      attention_budget: {
        eligible_rules_considered: compactEligibleRules.length,
        active_rules_returned: compactRules.length,
        maximum_active_rules: 12,
        estimated_tokens: null,
        token_estimate_basis: 'unavailable_without_host_usage',
        model_payload_bytes: modelPayloadBytes,
        approximate_payload_tokens: Math.ceil(modelPayloadBytes / 4),
        approximate_payload_basis: 'rough_utf8_bytes_divided_by_four_not_host_usage',
        visual_default_images: 0,
        visual_maximum_images: 8,
        visual_maximum_resolution: '768x432',
      },
      source_changes: [],
    };
  }

  propose({ root: rootInput, proposal, caller = {} }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the governed rule root: ${this.stateDir}`);
    }
    const normalized = normalizeProposal(this.ledger, root, proposal);
    const conditionHash = hashJson(normalized.condition);
    const existingRule = this.ledger.db.prepare(`
      SELECT * FROM preference_rules
      WHERE root_path = ? AND scope_type = ? AND scope_key = ?
        AND kind = ? AND condition_hash = ? AND status = 'active'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(root, normalized.scope.type, normalized.scope.key, normalized.kind, conditionHash);
    const impact = proposalImpact(normalized.kind, normalized.scope);
    const proposalHash = hashJson(normalized);
    const existingProposal = this.ledger.db.prepare(`
      SELECT id, run_id, status FROM rule_change_proposals
      WHERE root_path = ? AND proposal_hash = ? AND status IN ('prepared', 'approved')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(root, proposalHash);
    if (existingProposal) {
      return {
        rule_change_id: existingProposal.id,
        run_id: existingProposal.run_id,
        status: existingProposal.status,
        reused: true,
      };
    }
    const createdAt = timestamp();
    const runId = `RUL-${createdAt.replace(/[-:.TZ]/gu, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    const changeId = `RCH-${crypto.randomUUID()}`;
    const predictionId = `PRD-${crypto.randomUUID()}`;
    const receipt = {
      rule_change_id: changeId,
      run_id: runId,
      status: 'prepared',
      kind: normalized.kind,
      scope: normalized.scope,
      base_rule_id: existingRule?.id ?? null,
      confidence: normalized.confidence,
      review_required: true,
      reused: false,
    };
    this.ledger.transaction(() => {
      this.ledger.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Atlas preference rule workflow', '1.0.0', ?, ?)
      `).run(
        WORKFLOW_RULE_VERSION_ID,
        json({ schema: 'atlas-preference-rule-workflow.v1', immutable: true }),
        createdAt,
      );
      this.ledger.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at, receipt_json
        ) VALUES (?, 'rule_change', 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, root, normalized.summary,
        caller.actor ?? 'unknown', caller.agent ?? null, caller.model ?? null,
        caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        WORKFLOW_RULE_VERSION_ID, createdAt, json(receipt),
      );
      this.ledger.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'preference_rule_candidate', ?, ?)
      `).run(predictionId, runId, json(normalized), createdAt);
      this.ledger.db.prepare(`
        INSERT INTO rule_change_proposals(
          id, run_id, root_path, proposal_hash, scope_type, scope_key, kind,
          condition_hash, condition_json, value_json, summary, basis, evidence_json,
          confidence, priority, status, base_rule_id, impact_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)
      `).run(
        changeId, runId, root, proposalHash, normalized.scope.type, normalized.scope.key,
        normalized.kind, conditionHash, json(normalized.condition), json(normalized.value),
        normalized.summary, normalized.basis, json(normalized.evidence), normalized.confidence,
        normalized.priority, existingRule?.id ?? null, json(impact), createdAt,
      );
      this.ledger.db.prepare(`
        INSERT INTO operation_events(id, run_id, event_type, payload_json, occurred_at)
        VALUES (?, ?, 'preference_rule_proposed', ?, ?)
      `).run(`EVT-${crypto.randomUUID()}`, runId, json(receipt), createdAt);
    });
    return receipt;
  }

  preview(changeId) {
    const row = this.ledger.db.prepare(`
      SELECT p.*, r.actor, r.agent, r.model, r.tool, r.client_run_id
      FROM rule_change_proposals p JOIN runs r ON r.id = p.run_id
      WHERE p.id = ?
    `).get(changeId);
    if (!row) throw new Error(`Rule change proposal not found: ${changeId}`);
    const current = row.base_rule_id
      ? rowToRule(this.ledger.db.prepare('SELECT * FROM preference_rules WHERE id = ?').get(row.base_rule_id))
      : null;
    const candidate = {
      kind: row.kind,
      scope: { type: row.scope_type, key: row.scope_key },
      condition: parseJson(row.condition_json, {}),
      value: parseJson(row.value_json, {}),
      summary: row.summary,
      basis: row.basis,
      evidence: parseJson(row.evidence_json, []),
      confidence: row.confidence,
      priority: row.priority,
    };
    return {
      schema: 'atlas-preference-rule-preview.v1',
      rule_change_id: row.id,
      run_id: row.run_id,
      status: row.status,
      current_rule: current,
      candidate,
      difference: difference(current, candidate),
      impact: parseJson(row.impact_json, {}),
      user_decision_required: row.status === 'prepared',
      source_changes: [],
    };
  }

  approve(changeId, { reason } = {}) {
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error('Rule approval requires a reason.');
    }
    return withStateLock(this.stateDir, () => {
      const preview = this.preview(changeId);
      if (preview.status === 'approved') {
        return rowToRule(this.ledger.db.prepare(
          'SELECT * FROM preference_rules WHERE id = (SELECT activated_rule_id FROM rule_change_proposals WHERE id = ?)',
        ).get(changeId));
      }
      if (preview.status !== 'prepared') {
        throw new Error(`Rule change cannot be approved from status ${preview.status}.`);
      }
      const row = this.ledger.db.prepare('SELECT * FROM rule_change_proposals WHERE id = ?').get(changeId);
      const current = this.ledger.db.prepare(`
        SELECT * FROM preference_rules
        WHERE root_path = ? AND scope_type = ? AND scope_key = ?
          AND kind = ? AND condition_hash = ? AND status = 'active'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(row.root_path, row.scope_type, row.scope_key, row.kind, row.condition_hash);
      if ((current?.id ?? null) !== (row.base_rule_id ?? null)) {
        throw stateConflict('The effective preference changed after preview; create a new proposal.');
      }
      const reviewedAt = timestamp();
      const definition = {
        schema: 'atlas-preference-rule.v1',
        root_path: row.root_path,
        scope: { type: row.scope_type, key: row.scope_key },
        kind: row.kind,
        condition: parseJson(row.condition_json, {}),
        value: parseJson(row.value_json, {}),
        priority: row.priority,
        basis: row.basis,
        evidence: parseJson(row.evidence_json, []),
        summary: row.summary,
        supersedes: current?.id ?? null,
      };
      const definitionHash = hashJson(definition);
      const preferenceRuleId = `PREF-${definitionHash.slice(0, 20).toUpperCase()}`;
      const ruleVersionId = `RULE-PREF-${definitionHash.slice(0, 20).toUpperCase()}`;
      const receipt = {
        rule_id: preferenceRuleId,
        rule_change_id: changeId,
        run_id: row.run_id,
        rule_version_id: ruleVersionId,
        kind: row.kind,
        scope: definition.scope,
        status: 'active',
        supersedes: current?.id ?? null,
        applied_by: ['rule.context', ...IMPACT_CONSUMERS[row.kind].filter((item) => item !== 'rule.context')],
        source_changes: [],
      };
      this.ledger.transaction(() => {
        this.ledger.db.prepare(`
          INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
          VALUES (?, 'Reviewed Atlas preference', '1.0.0', ?, ?)
        `).run(ruleVersionId, json(definition), reviewedAt);
        if (current) {
          this.ledger.db.prepare(`
            UPDATE preference_rules SET status = 'superseded', superseded_at = ?
            WHERE id = ? AND status = 'active'
          `).run(reviewedAt, current.id);
        }
        this.ledger.db.prepare(`
          INSERT INTO preference_rules(
            id, run_id, root_path, scope_type, scope_key, kind, condition_hash,
            condition_json, value_json, priority, rule_version_id, status, summary,
            basis, evidence_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
        `).run(
          preferenceRuleId, row.run_id, row.root_path, row.scope_type, row.scope_key,
          row.kind, row.condition_hash, row.condition_json, row.value_json, row.priority,
          ruleVersionId, row.summary, row.basis, row.evidence_json, reviewedAt,
        );
        const prediction = this.ledger.db.prepare(`
          SELECT id FROM predictions WHERE run_id = ? AND kind = 'preference_rule_candidate'
          ORDER BY rowid LIMIT 1
        `).get(row.run_id);
        this.ledger.db.prepare(`
          INSERT INTO labels(
            id, run_id, subject_prediction_id, name, value, source, details_json, created_at
          ) VALUES (?, ?, ?, 'preference_rule', 'accepted', 'user', ?, ?)
        `).run(`LBL-${crypto.randomUUID()}`, row.run_id, prediction.id, json({ reason: reason.trim() }), reviewedAt);
        this.ledger.db.prepare(`
          INSERT INTO policy_decisions(
            id, run_id, rule_version_id, decision, reason, details_json, created_at
          ) VALUES (?, ?, ?, 'allow', ?, ?, ?)
        `).run(
          `POL-${crypto.randomUUID()}`, row.run_id, ruleVersionId,
          `User approved preference: ${reason.trim()}`,
          json({ scope: definition.scope, supersedes: current?.id ?? null }),
          reviewedAt,
        );
        this.ledger.db.prepare(`
          UPDATE rule_change_proposals
          SET status = 'approved', activated_rule_id = ?, reviewed_at = ?
          WHERE id = ?
        `).run(preferenceRuleId, reviewedAt, changeId);
        this.ledger.db.prepare(`
          UPDATE runs
          SET status = 'closed', rule_version_id = ?, closed_at = ?, receipt_json = ?
          WHERE id = ?
        `).run(ruleVersionId, reviewedAt, json(receipt), row.run_id);
        this.ledger.db.prepare(`
          INSERT INTO operation_events(id, run_id, event_type, payload_json, occurred_at)
          VALUES (?, ?, 'preference_rule_activated', ?, ?)
        `).run(`EVT-${crypto.randomUUID()}`, row.run_id, json(receipt), reviewedAt);
      });
      return receipt;
    });
  }

  reject(changeId, { reason } = {}) {
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error('Rule rejection requires a reason.');
    }
    return withStateLock(this.stateDir, () => {
      const preview = this.preview(changeId);
      if (preview.status === 'rejected') {
        return parseJson(this.ledger.getRun(preview.run_id).receipt_json, {});
      }
      if (preview.status !== 'prepared') {
        throw new Error(`Rule change cannot be rejected from status ${preview.status}.`);
      }
      const reviewedAt = timestamp();
      const prediction = this.ledger.db.prepare(`
        SELECT id FROM predictions WHERE run_id = ? AND kind = 'preference_rule_candidate'
        ORDER BY rowid LIMIT 1
      `).get(preview.run_id);
      const receipt = {
        rule_change_id: changeId,
        run_id: preview.run_id,
        status: 'rejected',
        reason: reason.trim(),
        source_changes: [],
      };
      this.ledger.transaction(() => {
        this.ledger.db.prepare(`
          INSERT INTO labels(
            id, run_id, subject_prediction_id, name, value, source, details_json, created_at
          ) VALUES (?, ?, ?, 'preference_rule', 'rejected', 'user', ?, ?)
        `).run(`LBL-${crypto.randomUUID()}`, preview.run_id, prediction.id, json({ reason: reason.trim() }), reviewedAt);
        this.ledger.db.prepare(`
          INSERT INTO policy_decisions(
            id, run_id, rule_version_id, decision, reason, details_json, created_at
          ) VALUES (?, ?, ?, 'deny', ?, '{}', ?)
        `).run(
          `POL-${crypto.randomUUID()}`, preview.run_id, WORKFLOW_RULE_VERSION_ID,
          `User rejected preference: ${reason.trim()}`, reviewedAt,
        );
        this.ledger.db.prepare(`
          UPDATE rule_change_proposals SET status = 'rejected', reviewed_at = ? WHERE id = ?
        `).run(reviewedAt, changeId);
        this.ledger.db.prepare(`
          UPDATE runs SET status = 'closed', closed_at = ?, receipt_json = ? WHERE id = ?
        `).run(reviewedAt, json(receipt), preview.run_id);
        this.ledger.db.prepare(`
          INSERT INTO operation_events(id, run_id, event_type, payload_json, occurred_at)
          VALUES (?, ?, 'preference_rule_rejected', ?, ?)
        `).run(`EVT-${crypto.randomUUID()}`, preview.run_id, json(receipt), reviewedAt);
      });
      return receipt;
    });
  }

  dispose() {
    if (this.ownsLedger && this._ledger) this._ledger.close();
  }
}
