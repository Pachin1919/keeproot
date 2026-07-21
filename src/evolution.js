import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from './ledger.js';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';
import { sha256File } from './snapshots.js';
import { withStateLock } from './state-lock.js';
import { RollbackConflictError } from './tracker.js';

const OPERATIONS = new Set(['create_directory', 'move_file', 'migrate_project']);
const MAX_MANIFEST_ENTRIES = 100_000;

function timestamp() {
  return new Date().toISOString();
}

function makeRunId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `EVO-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertPortableWindowsPath(root, absolute) {
  const relative = path.relative(root, absolute);
  for (const segment of relative.split(path.sep)) {
    if (!segment || /[<>:"|?*\u0000-\u001f]/u.test(segment)) {
      throw new Error(`Evolution path is not a portable Windows path: ${relative}`);
    }
    if (/[. ]$/u.test(segment)) {
      throw new Error(`Evolution path has a Windows-invalid trailing dot or space: ${relative}`);
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)) {
      throw new Error(`Evolution path uses a reserved Windows name: ${relative}`);
    }
  }
}

function assertNoLinkTraversal(root, absolute) {
  const relative = path.relative(root, absolute);
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Evolution path cannot traverse a symbolic link or junction: ${cursor}`);
    }
  }
}

function normalizeTarget(root, input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Evolution target is required.');
  const lexical = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isPathInside(root, lexical) || lexical === root) {
    throw new Error(`Evolution target escapes the root: ${input}`);
  }
  assertPortableWindowsPath(root, lexical);
  if (fs.existsSync(lexical)) throw new Error(`Evolution target is already claimed: ${lexical}`);
  const parent = path.dirname(lexical);
  if (!fs.existsSync(parent)) throw new Error(`Evolution target parent does not exist: ${parent}`);
  assertNoLinkTraversal(root, parent);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Evolution target parent must be a real non-symbolic-link directory: ${parent}`);
  }
  const realParent = fs.realpathSync.native(parent);
  if (!isPathInside(root, realParent)) throw new Error(`Evolution target resolves outside the root: ${input}`);
  const absolute = path.join(realParent, path.basename(lexical));
  return { absolute, relative: toPortablePath(path.relative(root, absolute)) };
}

function normalizeSource(root, input, expectedKind) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Evolution source is required.');
  const lexical = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isPathInside(root, lexical) || lexical === root) {
    throw new Error(`Evolution source escapes the root: ${input}`);
  }
  assertPortableWindowsPath(root, lexical);
  if (!fs.existsSync(lexical)) throw new Error(`Evolution source does not exist: ${lexical}`);
  assertNoLinkTraversal(root, lexical);
  const stat = fs.lstatSync(lexical);
  if (stat.isSymbolicLink()) throw new Error(`Evolution source cannot be a symbolic link: ${lexical}`);
  if (expectedKind === 'file' && !stat.isFile()) throw new Error(`Evolution source must be a file: ${lexical}`);
  if (expectedKind === 'directory' && !stat.isDirectory()) {
    throw new Error(`Evolution source must be a directory: ${lexical}`);
  }
  const real = fs.realpathSync.native(lexical);
  if (!isPathInside(root, real)) throw new Error(`Evolution source resolves outside the root: ${input}`);
  return { absolute: real, relative: toPortablePath(path.relative(root, real)) };
}

function directoryManifest(directory) {
  const entries = [{ path: '', kind: 'directory' }];
  function walk(current, relativeBase) {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      if (entries.length >= MAX_MANIFEST_ENTRIES) {
        throw new Error(`Evolution Project manifest exceeds ${MAX_MANIFEST_ENTRIES} entries.`);
      }
      const absolute = path.join(current, child.name);
      const relative = relativeBase ? `${relativeBase}/${child.name}` : child.name;
      const stat = fs.lstatSync(absolute);
      if (child.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`Evolution does not follow symbolic links: ${absolute}`);
      }
      if (child.isDirectory()) {
        entries.push({ path: relative, kind: 'directory' });
        walk(absolute, relative);
      } else if (child.isFile()) {
        entries.push({
          path: relative,
          kind: 'file',
          byte_size: stat.size,
          content_hash: sha256File(absolute),
        });
      } else {
        throw new Error(`Evolution does not support special filesystem entries: ${absolute}`);
      }
    }
  }
  walk(directory, '');
  return { kind: 'directory', entries, hash: hashJson(entries) };
}

function manifestAt(absolute, expectedKind = null) {
  if (!fs.existsSync(absolute)) return { kind: 'absent', entries: [], hash: null };
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return { kind: 'unsupported', entries: [], hash: null };
  if (stat.isFile()) {
    if (expectedKind && expectedKind !== 'file') return { kind: 'unsupported', entries: [], hash: null };
    const entries = [{ path: '', kind: 'file', byte_size: stat.size, content_hash: sha256File(absolute) }];
    return { kind: 'file', entries, hash: hashJson(entries) };
  }
  if (stat.isDirectory()) {
    if (expectedKind && expectedKind !== 'directory') return { kind: 'unsupported', entries: [], hash: null };
    try {
      return directoryManifest(absolute);
    } catch {
      return { kind: 'unsupported', entries: [], hash: null };
    }
  }
  return { kind: 'unsupported', entries: [], hash: null };
}

function sameManifest(observed, expectedKind, expectedHash) {
  return observed.kind === expectedKind && observed.hash === expectedHash;
}

function publicManifest(manifest) {
  return {
    kind: manifest.kind,
    hash: manifest.hash,
    entries: manifest.entries.length,
    files: manifest.entries.filter((entry) => entry.kind === 'file').length,
    directories: manifest.entries.filter((entry) => entry.kind === 'directory').length,
    sample_paths: manifest.entries.map((entry) => entry.path || '.').slice(0, 10),
  };
}

function diffFor(operation, source, target) {
  if (operation === 'create_directory') return `create directory ${target}\n`;
  return `move ${operation === 'move_file' ? 'file' : 'project'} ${source} -> ${target}\n`;
}

function stateConflict(message) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  return error;
}

export class Evolution {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('Evolution requires a stateDir');
    this.stateDir = path.resolve(stateDir);
    this._ledger = null;
  }

  get ledger() {
    if (!this._ledger) this._ledger = new Ledger(this.stateDir);
    return this._ledger;
  }

  prepare({
    root: rootInput,
    operation,
    source = null,
    target,
    projectId = null,
    intent = null,
    caller = {},
  }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the Evolution root: ${this.stateDir}`);
    }
    if (!OPERATIONS.has(operation)) {
      throw new Error(`Evolution operation must be one of: ${[...OPERATIONS].join(', ')}.`);
    }
    return withStateLock(this.stateDir, () => {
      const normalizedTarget = normalizeTarget(root, target);
      let normalizedSource = null;
      let project = null;
      if (operation === 'move_file') {
        normalizedSource = normalizeSource(root, source, 'file');
      } else if (operation === 'migrate_project') {
        if (!projectId) throw new Error('Project migration requires a Project ID.');
        project = this.ledger.getProject(projectId);
        if (project.status !== 'active') throw new Error(`Project migration requires an active Project: ${projectId}`);
        normalizedSource = normalizeSource(root, project.current_path, 'directory');
        if (source && normalizeSource(root, source, 'directory').relative !== normalizedSource.relative) {
          throw new Error('Project migration source does not match the Registry current path.');
        }
      }
      if (normalizedSource) {
        if (normalizedSource.absolute.toLowerCase() === normalizedTarget.absolute.toLowerCase()) {
          throw new Error('Evolution does not support an identical or case-only source/target rename.');
        }
        if (operation === 'migrate_project' && isPathInside(normalizedSource.absolute, normalizedTarget.absolute)) {
          throw new Error('Project migration target cannot be nested inside itself.');
        }
      }
      const sourceManifest = normalizedSource
        ? manifestAt(normalizedSource.absolute, operation === 'move_file' ? 'file' : 'directory')
        : null;
      if (normalizedSource && sourceManifest.kind === 'unsupported') {
        throw new Error('Evolution source contains an unsupported or symbolic-link entry.');
      }
      const baseline = {
        source_manifest_hash: sourceManifest?.hash ?? null,
        source_kind: sourceManifest?.kind ?? null,
        source_entries: sourceManifest?.entries ?? [],
        target_state: 'absent',
        project: project ? {
          id: project.id,
          name: project.name,
          path: project.current_path,
          status: project.status,
        } : null,
      };
      const sourceChanges = operation === 'create_directory'
        ? [{ path: normalizedTarget.relative, change: 'create_directory' }]
        : [
            { path: normalizedSource.relative, change: 'remove_original_path' },
            { path: normalizedTarget.relative, change: 'create_moved_path' },
          ];
      const plan = {
        schema: 'atlas-evolution-plan.v1',
        operation,
        summary: operation === 'create_directory'
          ? `Create directory ${normalizedTarget.relative}.`
          : `Move ${normalizedSource.relative} to ${normalizedTarget.relative}.`,
        source: normalizedSource?.relative ?? null,
        target: normalizedTarget.relative,
        project_id: projectId,
        source_manifest: sourceManifest ? publicManifest(sourceManifest) : null,
        source_changes: sourceChanges,
        requires_approval: true,
        recovery: operation === 'create_directory'
          ? 'Remove only if the created directory is still empty.'
          : 'Move back only if source remains absent and target still matches the prepared manifest.',
      };
      const planHash = hashJson(plan);
      const diffText = diffFor(operation, normalizedSource?.relative, normalizedTarget.relative);
      const diffHash = crypto.createHash('sha256').update(diffText).digest('hex');
      const runId = makeRunId();
      const startedAt = timestamp();
      const ids = this.ledger.createEvolutionRun({
        runId,
        root,
        operation,
        sourcePath: normalizedSource?.relative ?? null,
        targetPath: normalizedTarget.relative,
        projectId,
        intent,
        baseline,
        plan,
        planHash,
        diffText,
        diffHash,
        caller,
        startedAt,
      });
      return {
        run_id: runId,
        candidate_change_set_id: ids.candidateChangeSetId,
        prediction_id: ids.predictionId,
        status: 'prepared',
        operation,
        source: normalizedSource?.relative ?? null,
        target: normalizedTarget.relative,
        project_id: projectId,
        plan_hash: planHash,
        requires_approval: true,
        started_at: startedAt,
      };
    });
  }

  preview(runId) {
    return this.ledger.getEvolutionDetail(runId);
  }

  approve(runId, { reason = null } = {}) {
    if (!reason?.trim()) throw new Error('Evolution approval requires a reason.');
    return this.ledger.reviewEvolution(runId, {
      decision: 'accepted', reason: reason.trim(), reviewedAt: timestamp(),
    });
  }

  reject(runId, { reason = null } = {}) {
    return this.ledger.reviewEvolution(runId, {
      decision: 'rejected', reason, reviewedAt: timestamp(),
    });
  }

  execute(runId) {
    return withStateLock(this.stateDir, () => this.#execute(runId));
  }

  #execute(runId) {
    const detail = this.preview(runId);
    if (detail.execution_receipt) return detail.execution_receipt;
    if (detail.run.status !== 'approved') {
      throw new Error(`Evolution execution requires approval; current status is ${detail.run.status}.`);
    }
    if (detail.approved_plan_hash !== detail.operation.plan_hash) {
      throw new Error('Evolution approval does not match the current ChangeSet.');
    }
    const record = this.ledger.getEvolutionOperation(runId);
    const root = detail.run.root_path;
    const sourcePath = record.source_path
      ? path.resolve(root, ...record.source_path.split('/'))
      : null;
    const targetPath = path.resolve(root, ...record.target_path.split('/'));
    const expectedKind = record.operation_type === 'move_file' ? 'file' : 'directory';
    const sourceState = sourcePath ? manifestAt(sourcePath, expectedKind) : null;
    const targetState = manifestAt(targetPath, expectedKind);
    const started = detail.events.some((event) => event.type === 'evolution_execution_started');
    const beforeMatches = record.operation_type === 'create_directory'
      ? targetState.kind === 'absent'
      : sameManifest(sourceState, expectedKind, record.baseline.source_manifest_hash)
        && targetState.kind === 'absent';
    const afterMatches = record.operation_type === 'create_directory'
      ? sameManifest(targetState, 'directory', hashJson([{ path: '', kind: 'directory' }]))
      : sourceState.kind === 'absent'
        && sameManifest(targetState, expectedKind, record.baseline.source_manifest_hash);
    if (record.operation_type === 'migrate_project') {
      const project = this.ledger.getProject(record.project_id);
      const allowedRegistryPaths = started && afterMatches
        ? [record.source_path, record.target_path]
        : [record.source_path];
      if (!allowedRegistryPaths.includes(project.current_path)) {
        throw stateConflict('Project Registry changed after prepare; filesystem migration cannot continue.');
      }
    }
    if (!beforeMatches && !(started && afterMatches)) {
      this.ledger.markEvolutionStale(runId, {
        reason: targetState.kind !== 'absent' ? 'target_claimed_or_changed' : 'source_changed_after_prepare',
        source_observed_hash: sourceState?.hash ?? null,
        target_observed_hash: targetState.hash,
      }, timestamp());
      throw stateConflict('Evolution source changed after prepare or target was claimed; approval is stale.');
    }
    if (beforeMatches) {
      this.ledger.startEvolutionExecution(runId, timestamp());
      if (record.operation_type === 'create_directory') fs.mkdirSync(targetPath);
      else fs.renameSync(sourcePath, targetPath);
    }
    const verifiedSource = sourcePath ? manifestAt(sourcePath, expectedKind) : null;
    const verifiedTarget = manifestAt(targetPath, expectedKind);
    const verified = record.operation_type === 'create_directory'
      ? sameManifest(verifiedTarget, 'directory', hashJson([{ path: '', kind: 'directory' }]))
      : verifiedSource.kind === 'absent'
        && sameManifest(verifiedTarget, expectedKind, record.baseline.source_manifest_hash);
    if (!verified) throw new Error('Evolution verification failed after filesystem operation.');
    if (record.operation_type === 'migrate_project') {
      const project = this.ledger.getProject(record.project_id);
      if (project.current_path === record.source_path) {
        this.ledger.updateProject(record.project_id, {
          name: project.name,
          currentPath: record.target_path,
          aliases: [],
          status: project.status,
          reason: `Evolution run ${runId}`,
          updatedAt: timestamp(),
        });
      } else if (project.current_path !== record.target_path) {
        throw stateConflict('Project Registry changed during migration; filesystem move is preserved for reconciliation.');
      }
    }
    const executedAt = timestamp();
    return this.ledger.finishEvolutionExecution(runId, {
      receipt: {
        run_id: runId,
        status: 'executed',
        operation: record.operation_type,
        source: record.source_path,
        target: record.target_path,
        project_id: record.project_id,
        changed_paths: record.operation_type === 'create_directory' ? 1 : 2,
        after_manifest_hash: verifiedTarget.hash,
        verified: true,
        rollback_ready: true,
        executed_at: executedAt,
      },
      executedAt,
    });
  }

  rollback(runId) {
    return withStateLock(this.stateDir, () => this.#rollback(runId));
  }

  #rollback(runId) {
    const detail = this.preview(runId);
    if (detail.rollback_receipt) return detail.rollback_receipt;
    if (detail.run.status !== 'executed') {
      throw new Error(`Only an executed Evolution run can be rolled back; current status is ${detail.run.status}.`);
    }
    const record = this.ledger.getEvolutionOperation(runId);
    const root = detail.run.root_path;
    const sourcePath = record.source_path
      ? path.resolve(root, ...record.source_path.split('/'))
      : null;
    const targetPath = path.resolve(root, ...record.target_path.split('/'));
    const expectedKind = record.operation_type === 'move_file' ? 'file' : 'directory';
    const sourceState = sourcePath ? manifestAt(sourcePath, expectedKind) : null;
    const targetState = manifestAt(targetPath, expectedKind);
    const started = detail.events.some((event) => event.type === 'evolution_rollback_started');
    const endMatches = record.operation_type === 'create_directory'
      ? sameManifest(targetState, 'directory', record.execution_receipt.after_manifest_hash)
      : sourceState.kind === 'absent'
        && sameManifest(targetState, expectedKind, record.baseline.source_manifest_hash);
    const baselineMatches = record.operation_type === 'create_directory'
      ? targetState.kind === 'absent'
      : sameManifest(sourceState, expectedKind, record.baseline.source_manifest_hash)
        && targetState.kind === 'absent';
    if (record.operation_type === 'migrate_project') {
      const project = this.ledger.getProject(record.project_id);
      const allowedRegistryPaths = started && baselineMatches
        ? [record.target_path, record.source_path]
        : [record.target_path];
      if (!allowedRegistryPaths.includes(project.current_path)) {
        throw stateConflict('Project Registry changed after execution; filesystem rollback cannot continue.');
      }
    }
    if (!endMatches && !(started && baselineMatches)) {
      throw new RollbackConflictError([{
        path: record.target_path,
        expected_end_hash: record.execution_receipt.after_manifest_hash,
        current_hash: targetState.hash,
        current_kind: targetState.kind,
      }]);
    }
    if (endMatches) {
      this.ledger.recordEvent(runId, 'evolution_rollback_started', {
        source: record.source_path, target: record.target_path,
      });
      if (record.operation_type === 'create_directory') fs.rmdirSync(targetPath);
      else fs.renameSync(targetPath, sourcePath);
    }
    const verifiedTarget = manifestAt(targetPath, expectedKind);
    const verifiedSource = sourcePath ? manifestAt(sourcePath, expectedKind) : null;
    const verified = record.operation_type === 'create_directory'
      ? verifiedTarget.kind === 'absent'
      : verifiedTarget.kind === 'absent'
        && sameManifest(verifiedSource, expectedKind, record.baseline.source_manifest_hash);
    if (!verified) throw new Error('Evolution rollback verification failed.');
    if (record.operation_type === 'migrate_project') {
      const project = this.ledger.getProject(record.project_id);
      if (project.current_path === record.target_path) {
        this.ledger.updateProject(record.project_id, {
          name: project.name,
          currentPath: record.source_path,
          aliases: [],
          status: project.status,
          reason: `Rollback Evolution run ${runId}`,
          updatedAt: timestamp(),
        });
      } else if (project.current_path !== record.source_path) {
        throw stateConflict('Project Registry changed before rollback; filesystem state was restored for reconciliation.');
      }
    }
    const rolledBackAt = timestamp();
    return this.ledger.finishEvolutionRollback(runId, {
      run_id: runId,
      status: 'rolled_back',
      operation: record.operation_type,
      restored_source: record.source_path,
      removed_target: record.target_path,
      project_id: record.project_id,
      verified: true,
      rolled_back_at: rolledBackAt,
    }, rolledBackAt);
  }

  dispose() {
    if (this._ledger) this._ledger.close();
    this._ledger = null;
  }
}
