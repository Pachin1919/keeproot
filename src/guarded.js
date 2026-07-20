import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildCompleteDiff } from './diff.js';
import { Ledger } from './ledger.js';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';
import { evaluateRisk } from './risk.js';
import { RuntimeStorage } from './runtime-storage.js';
import { captureBlob, captureBuffer, sha256File } from './snapshots.js';
import { withStateLock } from './state-lock.js';

function timestamp() {
  return new Date().toISOString();
}

function makeRunId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `GRD-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeTarget(root, targetInput) {
  if (typeof targetInput !== 'string' || !targetInput.trim()) {
    throw new Error('Guarded prepare requires a target path.');
  }
  const lexical = path.isAbsolute(targetInput)
    ? path.resolve(targetInput)
    : path.resolve(root, targetInput);
  if (!isPathInside(root, lexical)) throw new Error(`Guarded target escapes the root: ${targetInput}`);
  if (!fs.existsSync(lexical)) throw new Error(`Guarded target does not exist: ${lexical}`);
  const stat = fs.lstatSync(lexical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Guarded target must be a regular non-symbolic-link file: ${lexical}`);
  }
  const real = fs.realpathSync.native(lexical);
  if (!isPathInside(root, real)) throw new Error(`Guarded target resolves outside the root: ${targetInput}`);
  return { absolute: real, relative: toPortablePath(path.relative(root, real)) };
}

function validateMaterial(material, name) {
  if (!material.blob_path || !fs.existsSync(material.blob_path)) {
    throw new Error(`${name} material is missing.`);
  }
  const actualHash = sha256File(material.blob_path);
  if (actualHash !== material.content_hash) {
    throw new Error(`${name} material hash does not match its Ledger record.`);
  }
}

function currentHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) return 'unsupported';
  return sha256File(filePath);
}

function atomicReplace(targetPath, blobPath, expectedCurrentHash) {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(directory, `.atlas-${crypto.randomUUID()}.tmp`);
  const mode = fs.statSync(targetPath).mode;
  try {
    fs.copyFileSync(blobPath, tempPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(tempPath, mode);
    if (currentHash(targetPath) !== expectedCurrentHash) {
      throw new Error('Target changed during the protected write.');
    }
    fs.renameSync(tempPath, targetPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export class Guarded {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('Guarded requires a stateDir');
    this.stateDir = path.resolve(stateDir);
    this._ledger = null;
  }

  get ledger() {
    if (!this._ledger) this._ledger = new Ledger(this.stateDir);
    return this._ledger;
  }

  prepare({
    root: rootInput,
    target,
    candidateContent,
    candidateFile = null,
    intent = null,
    targetImportance = 'normal',
    linkImpact = 0,
    predictionConfidence = 1,
    modifiesRules = false,
    revisedFromRunId = null,
    caller = {},
  }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the Guarded root: ${this.stateDir}`);
    }
    const receipt = withStateLock(this.stateDir, () => this.#prepare({
      root,
      target,
      candidateContent,
      candidateFile,
      intent,
      targetImportance,
      linkImpact,
      predictionConfidence,
      modifiesRules,
      revisedFromRunId,
      caller,
    }));
    if (candidateFile) {
      new RuntimeStorage({ stateDir: this.stateDir, ledger: this.ledger })
        .markCaptured(candidateFile, receipt.run_id);
    }
    return receipt;
  }

  #prepare({
    root,
    target,
    candidateContent,
    candidateFile,
    intent,
    targetImportance,
    linkImpact,
    predictionConfidence,
    modifiesRules,
    revisedFromRunId,
    caller,
  }) {
    const normalizedTarget = normalizeTarget(root, target);
    if (candidateContent == null && !candidateFile) {
      throw new Error('Guarded prepare requires candidateContent or candidateFile.');
    }
    if (candidateContent != null && candidateFile) {
      throw new Error('Pass candidateContent or candidateFile, not both.');
    }

    const baseline = captureBlob(normalizedTarget.absolute, this.stateDir);
    let candidate;
    if (candidateFile) {
      const absoluteCandidate = path.resolve(candidateFile);
      if (!fs.existsSync(absoluteCandidate)) throw new Error(`Candidate file does not exist: ${absoluteCandidate}`);
      const stat = fs.lstatSync(absoluteCandidate);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Candidate must be a regular non-symbolic-link file: ${absoluteCandidate}`);
      }
      candidate = captureBlob(absoluteCandidate, this.stateDir);
    } else if (Buffer.isBuffer(candidateContent)) {
      candidate = captureBuffer(candidateContent, this.stateDir);
    } else if (typeof candidateContent === 'string') {
      candidate = captureBuffer(Buffer.from(candidateContent, 'utf8'), this.stateDir);
    } else {
      throw new Error('candidateContent must be a string or Buffer.');
    }
    if (candidate.contentHash === baseline.contentHash) {
      throw new Error('Candidate content is identical to the current target; no Guarded change is needed.');
    }

    const risk = evaluateRisk({
      operation: 'update',
      paths: [normalizedTarget.relative],
      fileCount: 1,
      targetImportance,
      linkImpact,
      modifiesRules,
      recoveryAvailable: true,
      predictionConfidence,
      requestedMode: 'guarded',
    });
    if (risk.mode === 'deny') throw new Error(`Guarded prepare denied: ${risk.reasons.join(' ')}`);
    const change = {
      path: normalizedTarget.relative,
      before: { kind: 'file', ...baseline },
      after: { kind: 'file', ...candidate },
    };
    const { diffText, diffHash } = buildCompleteDiff([change]);
    const startedAt = timestamp();
    const runId = makeRunId();
    const ids = this.ledger.createGuardedRun({
      runId,
      root,
      targetPath: normalizedTarget.relative,
      intent,
      baseline,
      candidate,
      diffText,
      diffHash,
      risk,
      caller,
      revisedFromRunId,
      startedAt,
    });
    return {
      run_id: runId,
      candidate_change_set_id: ids.candidateChangeSetId,
      status: 'prepared',
      target: normalizedTarget.relative,
      risk: risk.mode,
      started_at: startedAt,
    };
  }

  preview(runId) {
    return this.ledger.getGuardedDetail(runId);
  }

  approve(runId, { reason = null } = {}) {
    return this.ledger.reviewGuarded(runId, {
      decision: 'accepted',
      reason,
      reviewedAt: timestamp(),
    });
  }

  reject(runId, { reason = null } = {}) {
    return this.ledger.reviewGuarded(runId, {
      decision: 'rejected',
      reason,
      reviewedAt: timestamp(),
    });
  }

  revise(runId, { candidateContent, candidateFile = null, reason = null }) {
    const original = this.preview(runId);
    if (!['prepared', 'approved'].includes(original.run.status)) {
      throw new Error(`Only a prepared or approved Guarded run can be revised; current status is ${original.run.status}.`);
    }
    const revised = this.prepare({
      root: original.run.root_path,
      target: original.candidate.target_path,
      candidateContent,
      candidateFile,
      intent: original.run.intent,
      revisedFromRunId: runId,
      caller: original.run.caller,
    });
    this.ledger.markGuardedRevised(runId, revised.run_id, reason, timestamp());
    return revised;
  }

  execute(runId) {
    return withStateLock(this.stateDir, () => this.#execute(runId));
  }

  #execute(runId) {
    const detail = this.preview(runId);
    if (detail.execution_receipt) return detail.execution_receipt;
    if (detail.run.status !== 'approved') {
      throw new Error(`Guarded execution requires approval; current status is ${detail.run.status}.`);
    }
    if (detail.approved_candidate_hash !== detail.candidate.content_hash) {
      throw new Error('Guarded approval does not match the current Candidate ChangeSet.');
    }
    validateMaterial(detail.candidate, 'Candidate');
    validateMaterial(detail.baseline, 'Recovery');
    const targetPath = path.resolve(detail.run.root_path, ...detail.candidate.target_path.split('/'));
    const observedHash = currentHash(targetPath);
    if (observedHash !== detail.baseline.content_hash && observedHash !== detail.candidate.content_hash) {
      this.ledger.markGuardedStale(runId, {
        target_path: detail.candidate.target_path,
        expected_hash: detail.baseline.content_hash,
        observed_hash: observedHash,
      }, timestamp());
      throw new Error('Guarded target changed after preview; approval is now stale.');
    }

    if (observedHash === detail.baseline.content_hash) {
      try {
        atomicReplace(targetPath, detail.candidate.blob_path, detail.baseline.content_hash);
      } catch (error) {
        const afterFailure = currentHash(targetPath);
        if (afterFailure !== detail.baseline.content_hash && afterFailure !== detail.candidate.content_hash) {
          this.ledger.markGuardedStale(runId, {
            target_path: detail.candidate.target_path,
            expected_hash: detail.baseline.content_hash,
            observed_hash: afterFailure,
            error: error.message,
          }, timestamp());
        }
        throw error;
      }
    }
    const verifiedHash = currentHash(targetPath);
    if (verifiedHash !== detail.candidate.content_hash) {
      throw new Error('Guarded verification failed: target does not match the approved candidate.');
    }
    const executedAt = timestamp();
    const receipt = {
      run_id: runId,
      status: 'executed',
      changed_files: 1,
      target: detail.candidate.target_path,
      before_sha256: detail.baseline.content_hash,
      after_sha256: detail.candidate.content_hash,
      verified: true,
      rollback_ready: true,
      executed_at: executedAt,
    };
    return this.ledger.finishGuardedExecution(runId, { receipt, executedAt });
  }

  rollback(runId) {
    return withStateLock(this.stateDir, () => this.#rollback(runId));
  }

  #rollback(runId) {
    const detail = this.preview(runId);
    if (detail.rollback_receipt) return detail.rollback_receipt;
    if (detail.run.status !== 'executed') {
      throw new Error(`Only an executed Guarded run can be rolled back; current status is ${detail.run.status}.`);
    }
    validateMaterial(detail.baseline, 'Recovery');
    const targetPath = path.resolve(detail.run.root_path, ...detail.candidate.target_path.split('/'));
    const observedHash = currentHash(targetPath);
    if (observedHash !== detail.candidate.content_hash && observedHash !== detail.baseline.content_hash) {
      throw new Error('Guarded rollback stopped because the target changed after execution.');
    }
    if (observedHash === detail.candidate.content_hash) {
      atomicReplace(targetPath, detail.baseline.blob_path, detail.candidate.content_hash);
    }
    if (currentHash(targetPath) !== detail.baseline.content_hash) {
      throw new Error('Guarded rollback verification failed.');
    }
    const rolledBackAt = timestamp();
    const receipt = {
      run_id: runId,
      status: 'rolled_back',
      restored_files: 1,
      target: detail.candidate.target_path,
      rolled_back_at: rolledBackAt,
    };
    return this.ledger.finishGuardedRollback(runId, receipt, rolledBackAt);
  }

  dispose() {
    if (this._ledger) this._ledger.close();
    this._ledger = null;
  }
}
