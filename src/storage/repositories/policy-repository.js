import crypto from 'node:crypto';
import path from 'node:path';

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

export class PolicyRepository {
  constructor({ db, transaction, getRun, insertEvent }) {
    this.db = db;
    this.transaction = transaction;
    this.getRun = getRun;
    this.insertEvent = insertEvent;
  }

  activateEnvironment({ runId, root, policy, activatedAt }) {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (run.mode !== 'bootstrap') throw new Error(`Run is not a Bootstrap scan: ${runId}`);
      const existing = this.db.prepare(`
        SELECT id, root_path, scan_run_id, rule_version_id, policy_json, status, activated_at, deactivated_at
        FROM environment_policies WHERE scan_run_id = ?
      `).get(runId);
      if (existing) {
        const existingPolicy = parseJson(existing.policy_json, {});
        return {
          ...existing,
          profile_id: existingPolicy.profile_id ?? null,
          profile_version: existingPolicy.profile_version ?? null,
          policy: existingPolicy,
          policy_json: undefined,
        };
      }
      const normalizedRoot = path.resolve(root);
      if (normalizedRoot !== path.resolve(run.root_path)) {
        throw new Error('Environment policy root must match its Bootstrap scan root.');
      }
      const definition = structuredClone(policy);
      const definitionJson = json(definition);
      const ruleVersionId = `RULE-ENV-${crypto.createHash('sha256').update(definitionJson).digest('hex').slice(0, 16).toUpperCase()}`;
      const policyId = `POL-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        ruleVersionId,
        `Environment routing policy: ${definition.profile_id ?? 'reviewed-bootstrap'}`,
        definition.profile_version ?? '1.0.0',
        definitionJson,
        activatedAt,
      );
      this.db.prepare(`
        UPDATE environment_policies SET status = 'superseded', deactivated_at = ?
        WHERE root_path = ? AND status = 'active'
      `).run(activatedAt, normalizedRoot);
      this.db.prepare(`
        INSERT INTO environment_policies(
          id, root_path, scan_run_id, rule_version_id, policy_json, status, activated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?)
      `).run(policyId, normalizedRoot, runId, ruleVersionId, definitionJson, activatedAt);
      const receipt = {
        id: policyId,
        root_path: normalizedRoot,
        scan_run_id: runId,
        rule_version_id: ruleVersionId,
        profile_id: definition.profile_id ?? null,
        profile_version: definition.profile_version ?? null,
        policy: definition,
        status: 'active',
        activated_at: activatedAt,
        deactivated_at: null,
      };
      this.insertEvent(runId, 'environment_policy_activated', {
        policy_id: policyId,
        rule_version_id: ruleVersionId,
        profile_id: definition.profile_id ?? null,
        profile_version: definition.profile_version ?? null,
      }, activatedAt);
      return receipt;
    });
  }

  getActiveEnvironment(root) {
    const row = this.db.prepare(`
      SELECT id, root_path, scan_run_id, rule_version_id, policy_json, status, activated_at, deactivated_at
      FROM environment_policies
      WHERE root_path = ? AND status = 'active'
      ORDER BY activated_at DESC, rowid DESC LIMIT 1
    `).get(path.resolve(root));
    return this.#environmentRow(row);
  }

  getEnvironmentForScan(runId) {
    const row = this.db.prepare(`
      SELECT id, root_path, scan_run_id, rule_version_id, policy_json, status, activated_at, deactivated_at
      FROM environment_policies WHERE scan_run_id = ?
    `).get(runId);
    return this.#environmentRow(row);
  }

  #environmentRow(row) {
    if (!row) return null;
    const policy = parseJson(row.policy_json, {});
    return {
      ...row,
      profile_id: policy.profile_id ?? null,
      profile_version: policy.profile_version ?? null,
      library_contract: policy.library_contract ?? null,
      policy,
      policy_json: undefined,
    };
  }

  createRoutingCorrection({
    root, scopeType, scopeKey, origin, kind, role, targetSubdirectory,
    reason, caller = {}, createdAt = new Date().toISOString(),
  }) {
    const definition = {
      schema: 'atlas-routing-correction.v1',
      root_path: path.resolve(root),
      scope: scopeType,
      scope_key: scopeKey,
      origin,
      kind,
      role,
      target_subdirectory: targetSubdirectory,
    };
    const definitionJson = json(definition);
    const definitionHash = crypto.createHash('sha256').update(definitionJson).digest('hex');
    const ruleVersionId = `RULE-ROUTE-${definitionHash.slice(0, 16).toUpperCase()}`;
    const existing = this.db.prepare(`
      SELECT * FROM routing_corrections
      WHERE root_path = ? AND scope_type = ? AND scope_key = ?
        AND origin = ? AND kind = ? AND status = 'active'
    `).get(definition.root_path, scopeType, scopeKey, origin, kind);
    if (existing && existing.rule_version_id === ruleVersionId) {
      return {
        correction_id: existing.id,
        run_id: existing.run_id,
        rule_version_id: existing.rule_version_id,
        scope: existing.scope_type,
        scope_key: existing.scope_key,
        origin: existing.origin,
        kind: existing.kind,
        role: existing.role,
        target_subdirectory: existing.target_subdirectory,
        status: existing.status,
        reused: true,
      };
    }
    const runId = `RUL-${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    const correctionId = `COR-${crypto.randomUUID()}`;
    const predictionId = `PRD-${crypto.randomUUID()}`;
    const receipt = {
      correction_id: correctionId,
      run_id: runId,
      rule_version_id: ruleVersionId,
      scope: scopeType,
      scope_key: scopeKey,
      origin,
      kind,
      role,
      target_subdirectory: targetSubdirectory,
      status: 'active',
      reused: false,
    };
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Reviewed Intake routing correction', '1.0.0', ?, ?)
      `).run(ruleVersionId, definitionJson, createdAt);
      this.db.prepare(`
        UPDATE routing_corrections SET status = 'superseded', superseded_at = ?
        WHERE root_path = ? AND scope_type = ? AND scope_key = ?
          AND origin = ? AND kind = ? AND status = 'active'
      `).run(createdAt, definition.root_path, scopeType, scopeKey, origin, kind);
      this.db.prepare(`
        INSERT INTO runs(
          id, mode, status, root_path, intent, actor, agent, model, tool, client_run_id,
          rule_version_id, started_at, closed_at, receipt_json
        ) VALUES (?, 'rule_correction', 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, definition.root_path, reason,
        caller.actor ?? 'unknown', caller.agent ?? null, caller.model ?? null,
        caller.tool ?? 'atlas-cli', caller.client_run_id ?? null,
        ruleVersionId, createdAt, createdAt, json(receipt),
      );
      this.db.prepare(`
        INSERT INTO predictions(id, run_id, kind, payload_json, created_at)
        VALUES (?, ?, 'routing_rule_correction', ?, ?)
      `).run(predictionId, runId, definitionJson, createdAt);
      this.db.prepare(`
        INSERT INTO labels(
          id, run_id, subject_prediction_id, name, value, source, details_json, created_at
        ) VALUES (?, ?, ?, 'routing_rule_correction', 'corrected', 'user', ?, ?)
      `).run(`LBL-${crypto.randomUUID()}`, runId, predictionId, json({ reason, scope: scopeType }), createdAt);
      this.db.prepare(`
        INSERT INTO policy_decisions(
          id, run_id, rule_version_id, decision, reason, details_json, created_at
        ) VALUES (?, ?, ?, 'allow', ?, ?, ?)
      `).run(
        `POL-${crypto.randomUUID()}`, runId, ruleVersionId,
        `Reviewed routing correction: ${reason}`, json({ scope: scopeType, scope_key: scopeKey }), createdAt,
      );
      this.db.prepare(`
        INSERT INTO routing_corrections(
          id, run_id, root_path, scope_type, scope_key, origin, kind, role,
          target_subdirectory, rule_version_id, status, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        correctionId, runId, definition.root_path, scopeType, scopeKey, origin, kind,
        role, targetSubdirectory, ruleVersionId, reason, createdAt,
      );
      this.insertEvent(runId, 'routing_correction_activated', receipt, createdAt);
    });
    return receipt;
  }

  findRoutingCorrection({ root, origin, kind, candidateHash = null, projectId = null }) {
    const rows = this.db.prepare(`
      SELECT * FROM routing_corrections
      WHERE root_path = ? AND origin = ? AND kind = ? AND status = 'active'
      ORDER BY created_at DESC, rowid DESC
    `).all(path.resolve(root), origin, kind);
    const selected = rows.find((row) => row.scope_type === 'artifact' && row.scope_key === `sha256:${candidateHash}`)
      ?? rows.find((row) => row.scope_type === 'project' && row.scope_key === projectId)
      ?? rows.find((row) => row.scope_type === 'global' && row.scope_key === '*')
      ?? null;
    if (!selected) return null;
    return {
      correction_id: selected.id,
      run_id: selected.run_id,
      rule_version_id: selected.rule_version_id,
      scope: selected.scope_type,
      scope_key: selected.scope_key,
      origin: selected.origin,
      kind: selected.kind,
      role: selected.role,
      target_subdirectory: selected.target_subdirectory,
      status: selected.status,
      reason: selected.reason,
    };
  }

  listRoutingCorrections(root) {
    return this.db.prepare(`
      SELECT id AS correction_id, run_id, rule_version_id, scope_type AS scope,
             scope_key, origin, kind, role, target_subdirectory, status, reason, created_at, superseded_at
      FROM routing_corrections WHERE root_path = ? ORDER BY created_at, rowid
    `).all(path.resolve(root));
  }
}
