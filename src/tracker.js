import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildCompleteDiff } from './diff.js';
import { Ledger } from './ledger.js';
import {
  absoluteFromRelative,
  isAllowedPath,
  isPathInside,
  normalizeRoot,
  normalizeScopes,
} from './paths.js';
import { scanRoot, sha256File, snapshotChangedFiles } from './snapshots.js';
import { withStateLock } from './state-lock.js';
import { evaluateRisk } from './risk.js';

function timestamp() {
  return new Date().toISOString();
}
function makeRunId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `RUN-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function asMap(entries) {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function compareStates(beforeStates, afterStates, scopes) {
  const before = asMap(beforeStates);
  const after = asMap(afterStates);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];

  for (const relativePath of paths) {
    const left = before.get(relativePath) ?? null;
    const right = after.get(relativePath) ?? null;
    if (left && right && left.kind === right.kind && left.contentHash === right.contentHash) {
      continue;
    }

    changes.push({
      path: relativePath,
      changeType: left && right ? 'modified' : left ? 'deleted' : 'added',
      allowed: isAllowedPath(relativePath, scopes),
      before: left,
      after: right,
    });
  }

  return changes;
}

function currentFileState(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { kind: 'unsupported', contentHash: null };
  }
  return { kind: 'file', contentHash: sha256File(filePath) };
}

function matchesRecordedState(current, kind, contentHash) {
  return kind === null
    ? current === null
    : current?.kind === kind && current.contentHash === contentHash;
}

function atomicRestoreFile(targetPath, blobPath, expectedKind, expectedHash) {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.atlas-rollback-${crypto.randomUUID()}.tmp`);
  try {
    fs.copyFileSync(blobPath, tempPath, fs.constants.COPYFILE_EXCL);
    const current = currentFileState(targetPath);
    if (!matchesRecordedState(current, expectedKind, expectedHash)) {
      throw new RollbackConflictError([{
        path: targetPath,
        expected_end_hash: expectedHash,
        current_hash: current?.contentHash ?? null,
        current_kind: current?.kind ?? 'absent',
      }]);
    }
    fs.renameSync(tempPath, targetPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export class RollbackConflictError extends Error {
  constructor(conflicts) {
    super(`Rollback stopped because ${conflicts.length} path(s) no longer match the run's end state.`);
    this.name = 'RollbackConflictError';
    this.code = 'ATLAS_ROLLBACK_CONFLICT';
    this.conflicts = conflicts;
  }
}

export class Tracker {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('Tracker requires a stateDir');
    this.stateDir = path.resolve(stateDir);
    this._ledger = null;
  }

  get ledger() {
    if (!this._ledger) this._ledger = new Ledger(this.stateDir);
    return this._ledger;
  }

  begin({
    root: rootInput,
    allow,
    intent = null,
    operation = 'update',
    targetImportance = 'normal',
    linkImpact = 0,
    predictionConfidence = 1,
    modifiesRules = false,
    caller = {},
  }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the tracked root: ${this.stateDir}`);
    }
    return withStateLock(this.stateDir, () => this.#begin({
      root,
      allow,
      intent,
      operation,
      targetImportance,
      linkImpact,
      predictionConfidence,
      modifiesRules,
      caller,
    }));
  }

  #begin({
    root,
    allow,
    intent,
    operation,
    targetImportance,
    linkImpact,
    predictionConfidence,
    modifiesRules,
    caller,
  }) {
    const scopes = normalizeScopes(root, allow);
    const startedAt = timestamp();
    const runId = makeRunId();
    const baseline = scanRoot(root, { stateDir: this.stateDir, capture: true });
    const governedPaths = scopes.map((scope) => scope.path || '.');
    const inferredRuleChange = governedPaths.some((item) => (
      /(^|\/)(agents\.md|rules?|polic(?:y|ies))(\/|$)/i.test(item)
    ));
    const affectedBaselineFiles = baseline.filter((entry) => isAllowedPath(entry.path, scopes)).length;
    const risk = evaluateRisk({
      operation,
      paths: governedPaths,
      fileCount: Math.max(1, affectedBaselineFiles),
      targetImportance,
      linkImpact,
      modifiesRules: modifiesRules || inferredRuleChange,
      recoveryAvailable: true,
      predictionConfidence,
      requestedMode: 'tracked_direct',
    });
    if (risk.mode !== 'tracked_direct') {
      throw new Error(
        `Tracked Direct refused by Risk Engine (${risk.mode}): ${risk.reasons.join(' ')} Use atlas guarded for this change.`,
      );
    }

    this.ledger.createRun({
      runId,
      root,
      intent,
      scopes,
      baseline,
      risk,
      caller,
      startedAt,
    });

    return {
      run_id: runId,
      status: 'open',
      mode: 'tracked_direct',
      root,
      allowed_scopes: scopes,
      baseline_files: baseline.length,
      risk_mode: risk.mode,
      started_at: startedAt,
    };
  }

  close(runId = null) {
    return withStateLock(this.stateDir, () => this.#close(runId));
  }

  #close(runId) {
    const selectedRun = runId ? this.ledger.getRun(runId) : this.ledger.findLatestOpenRun();
    if (!selectedRun) throw new Error('No open run found. Pass a run_id or call atlas begin first.');

    const existingReceipt = this.ledger.parseReceipt(selectedRun);
    if (existingReceipt) return existingReceipt;
    if (selectedRun.status !== 'open') {
      throw new Error(`Run cannot be closed from status ${selectedRun.status}: ${selectedRun.id}`);
    }

    try {
      const scopes = this.ledger.getScopes(selectedRun.id);
      const beforeStates = this.ledger.getStates(selectedRun.id, 'before');
      const afterStates = scanRoot(selectedRun.root_path, { capture: false });
      const changes = compareStates(beforeStates, afterStates, scopes);
      snapshotChangedFiles(selectedRun.root_path, this.stateDir, changes);

      const violations = changes.filter((change) => !change.allowed).map((change) => change.path);
      const allowedChanges = changes.length - violations.length;
      const actualModifiesRules = changes.some((change) => (
        /(^|\/)(agents\.md|rules?|polic(?:y|ies))(\/|$)/i.test(change.path)
      ));
      const actualRisk = evaluateRisk({
        operation: changes.some((change) => change.changeType === 'deleted') ? 'delete' : 'update',
        paths: changes.length ? changes.map((change) => change.path) : ['(no changes)'],
        fileCount: Math.max(1, changes.length),
        modifiesRules: actualModifiesRules,
        recoveryAvailable: true,
        requestedMode: 'tracked_direct',
      });
      let decision;
      if (violations.length) {
        decision = {
            status: 'violation',
            reason: 'One or more observed file changes are outside every allowed scope.',
            details: { violation_kind: 'scope', violations, actual_risk: actualRisk },
            ruleVersionId: 'RULE-TRACKED-DIRECT-1',
          };
      } else if (actualRisk.mode !== 'tracked_direct') {
        decision = {
          status: 'violation',
          reason: `The actual change required ${actualRisk.mode} protection: ${actualRisk.reasons.join(' ')}`,
          details: { violation_kind: 'risk', violations: [], actual_risk: actualRisk },
          ruleVersionId: actualRisk.rule_version_id,
        };
      } else {
        decision = {
          status: 'pass',
          reason: 'Every observed file change is inside an allowed scope and remained low risk.',
          details: { violation_kind: null, violations: [], actual_risk: actualRisk },
          ruleVersionId: 'RULE-TRACKED-DIRECT-1',
        };
      }
      const { diffText, diffHash } = buildCompleteDiff(changes);
      const closedAt = timestamp();
      const receipt = {
        run_id: selectedRun.id,
        status: 'closed',
        policy: decision.status,
        changed_files: changes.length,
        allowed_changes: allowedChanges,
        scope_violations: violations,
        violation_kind: decision.details.violation_kind,
        actual_risk_mode: actualRisk.mode,
        diff_sha256: diffHash,
        rollback_ready: true,
        closed_at: closedAt,
      };

      return this.ledger.finalizeClose({
        runId: selectedRun.id,
        afterStates,
        changes,
        decision,
        diffText,
        diffHash,
        receipt,
        closedAt,
      });

    } catch (error) {
      this.ledger.recordEvent(selectedRun.id, 'close_failed', { message: error.message });
      throw error;
    }
  }

  rollback(runId) {
    return withStateLock(this.stateDir, () => this.#rollback(runId));
  }

  #rollback(runId) {
    const run = this.ledger.getRun(runId);
    const existingReceipt = this.ledger.parseRollbackReceipt(run);
    if (existingReceipt) return existingReceipt;
    if (run.status !== 'closed') {
      throw new Error(`Only a closed run can be rolled back; current status is ${run.status}.`);
    }

    const changes = this.ledger.getChanges(runId);
    const conflicts = [];
    for (const change of changes) {
      const absolute = absoluteFromRelative(run.root_path, change.path);
      const current = currentFileState(absolute);
      const matchesEnd = matchesRecordedState(current, change.afterKind, change.afterHash);
      const matchesBaseline = matchesRecordedState(current, change.beforeKind, change.beforeHash);
      if (!matchesEnd && !matchesBaseline) {
        conflicts.push({
          path: change.path,
          expected_end_hash: change.afterHash,
          current_hash: current?.contentHash ?? null,
          current_kind: current?.kind ?? 'absent',
        });
      }
    }

    if (conflicts.length) {
      this.ledger.recordEvent(runId, 'rollback_conflict', { conflicts });
      throw new RollbackConflictError(conflicts);
    }

    const invalidMaterials = [];
    for (const change of changes) {
      if (change.beforeKind === null) continue;
      if (change.beforeKind !== 'file' || !change.beforeBlobPath) {
        invalidMaterials.push({ path: change.path, reason: 'missing recovery material' });
        continue;
      }
      if (!fs.existsSync(change.beforeBlobPath)) {
        invalidMaterials.push({ path: change.path, reason: 'recovery material does not exist' });
        continue;
      }
      const materialHash = sha256File(change.beforeBlobPath);
      if (materialHash !== change.beforeHash) {
        invalidMaterials.push({
          path: change.path,
          reason: 'recovery material hash mismatch',
          expected_hash: change.beforeHash,
          actual_hash: materialHash,
        });
      }
    }

    if (invalidMaterials.length) {
      this.ledger.recordEvent(runId, 'rollback_material_invalid', { materials: invalidMaterials });
      throw new Error(
        `Rollback stopped because recovery material is missing or corrupt for ${invalidMaterials.length} path(s).`,
      );
    }

    const recordedProgress = new Map(
      this.ledger.getRollbackProgress(runId).map((item) => [item.path, item]),
    );
    const completedPaths = [];
    let resumedPaths = 0;
    try {
      for (const change of changes) {
        const absolute = absoluteFromRelative(run.root_path, change.path);
        const current = currentFileState(absolute);
        if (matchesRecordedState(current, change.beforeKind, change.beforeHash)) {
          resumedPaths += 1;
          completedPaths.push(change.path);
          if (recordedProgress.get(change.path)?.status !== 'restored') {
            const restoredAt = timestamp();
            this.ledger.recordRollbackPath(runId, change.path, {
              already_at_baseline: true,
              baseline_hash: change.beforeHash,
            }, restoredAt);
          }
          continue;
        }
        if (!matchesRecordedState(current, change.afterKind, change.afterHash)) {
          const pathConflicts = [{
            path: change.path,
            expected_end_hash: change.afterHash,
            current_hash: current?.contentHash ?? null,
            current_kind: current?.kind ?? 'absent',
          }];
          this.ledger.recordEvent(runId, 'rollback_conflict', { conflicts: pathConflicts });
          throw new RollbackConflictError(pathConflicts);
        }

        if (change.beforeKind === null) {
          fs.rmSync(absolute, { force: true });
        } else if (change.beforeKind === 'file' && change.beforeBlobPath) {
          atomicRestoreFile(
            absolute,
            change.beforeBlobPath,
            change.afterKind,
            change.afterHash,
          );
        } else {
          throw new Error(`Unsupported rollback material for ${change.path}`);
        }

        const restored = currentFileState(absolute);
        if (!matchesRecordedState(restored, change.beforeKind, change.beforeHash)) {
          throw new Error(`Rollback verification failed for ${change.path}`);
        }
        const restoredAt = timestamp();
        this.ledger.recordRollbackPath(runId, change.path, {
          already_at_baseline: false,
          baseline_hash: change.beforeHash,
        }, restoredAt);
        completedPaths.push(change.path);
      }
    } catch (error) {
      const completed = [...new Set(completedPaths)];
      this.ledger.recordEvent(runId, 'rollback_failed', {
        message: error.message,
        restored_paths: completed,
        remaining_paths: changes
          .map((change) => change.path)
          .filter((item) => !completed.includes(item)),
      });
      throw error;
    }

    const rolledBackAt = timestamp();
    const receipt = {
      run_id: runId,
      status: 'rolled_back',
      restored_files: changes.length,
      resumed_paths: resumedPaths,
      rolled_back_at: rolledBackAt,
    };
    return this.ledger.finishRollback(runId, receipt, rolledBackAt);
  }

  abort(runId, { reason = 'aborted by caller' } = {}) {
    return withStateLock(this.stateDir, () => this.#abort(runId, { reason }));
  }

  #abort(runId, { reason }) {
    const run = this.ledger.getRun(runId);
    const existingReceipt = this.ledger.parseAbortReceipt(run);
    if (existingReceipt) return existingReceipt;
    if (run.status !== 'open') {
      throw new Error(`Only an open run can be aborted; current status is ${run.status}.`);
    }

    try {
      const scopes = this.ledger.getScopes(runId);
      const beforeStates = this.ledger.getStates(runId, 'before');
      const currentStates = scanRoot(run.root_path, { capture: false });
      const changes = compareStates(beforeStates, currentStates, scopes);
      if (changes.length) {
        this.ledger.recordEvent(runId, 'abort_refused_changes_present', {
          changed_paths: changes.map((change) => change.path),
        });
        throw new Error(
          `Abort refused because ${changes.length} file change(s) are present. Close the run to record them.`,
        );
      }

      const abortedAt = timestamp();
      return this.ledger.finishAbort(runId, {
        run_id: runId,
        status: 'aborted',
        reason,
        aborted_at: abortedAt,
      }, abortedAt);
    } catch (error) {
      if (!/Close the run to record them/.test(error.message)) {
        this.ledger.recordEvent(runId, 'abort_failed', { message: error.message });
      }
      throw error;
    }
  }

  gc({ minAgeMs = 24 * 60 * 60 * 1000 } = {}) {
    return withStateLock(this.stateDir, () => this.#gc({ minAgeMs }));
  }

  #gc({ minAgeMs }) {
    if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
      throw new Error('minAgeMs must be a non-negative finite number.');
    }
    const blobDir = path.join(this.stateDir, 'blobs', 'sha256');
    const referenced = new Set(
      this.ledger.getReferencedBlobPaths().map((item) => path.resolve(item).toLowerCase()),
    );
    const result = {
      deleted_blobs: 0,
      deleted_bytes: 0,
      skipped_referenced: 0,
      skipped_recent: 0,
    };
    if (!fs.existsSync(blobDir)) return result;

    const currentTime = Date.now();
    for (const entry of fs.readdirSync(blobDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const blobPath = path.resolve(blobDir, entry.name);
      if (referenced.has(blobPath.toLowerCase())) {
        result.skipped_referenced += 1;
        continue;
      }
      const stat = fs.statSync(blobPath);
      if (currentTime - stat.mtimeMs < minAgeMs) {
        result.skipped_recent += 1;
        continue;
      }
      fs.rmSync(blobPath);
      result.deleted_blobs += 1;
      result.deleted_bytes += stat.size;
    }
    return result;
  }

  status({ limit = null } = {}) {
    return this.ledger.listRuns({ limit });
  }

  show(runId) {
    return this.ledger.showRun(runId);
  }

  dispose() {
    if (this._ledger) this._ledger.close();
    this._ledger = null;
  }
}
