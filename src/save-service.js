import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './snapshots.js';
import { Intake } from './intake.js';
import { withStateLock } from './state-lock.js';
import { createResourceControl } from './resource-control.js';
import { projectResourceHref } from './resource-links.js';
import { assertRecoveryWritable } from './storage/recovery-write-guard.js';

const journalPath = (stateDir) => path.join(path.resolve(stateDir), 'ui', 'saved-work.json');
const now = () => new Date().toISOString();

function conflict(message) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  return error;
}

function readJournal(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(journalPath(stateDir), 'utf8'));
    if (!value || !Array.isArray(value.items)) throw new Error('Saved Work has an invalid structure.');
    return value.items;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function writeJournal(stateDir, items) {
  const target = journalPath(stateDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function mutate(stateDir, saveId, change, writeJournalFn = writeJournal) {
  return withStateLock(stateDir, () => {
    const items = readJournal(stateDir);
    const index = items.findIndex((item) => item.save_id === saveId);
    const previous = index < 0 ? null : items[index];
    const next = change(previous, items);
    if (next) {
      if (index < 0) items.unshift(next);
      else items[index] = next;
      writeJournalFn(stateDir, items);
    }
    return next;
  });
}

function candidateFact(candidateFile) {
  const absolute = path.resolve(candidateFile);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw conflict('Save Candidate must be a regular non-symbolic-link file.');
  return { path: absolute, sha256: sha256File(absolute), bytes: stat.size };
}

function inputFacts(root, inputs) {
  const absoluteRoot = path.resolve(root);
  return [...inputs].map((input) => {
    const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(absoluteRoot, input);
    const relative = path.relative(absoluteRoot, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw conflict('Save inputs must be regular files inside the selected root.');
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw conflict('Save inputs must be regular non-symbolic-link files.');
    return { relative_path: relative.replaceAll('\\', '/'), sha256: sha256File(absolute) };
  }).sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function requestHash(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function normalizedToken(value, fallback = null) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase().replaceAll('-', '_');
  return token === 'agent' ? 'agent_generated' : (token || fallback);
}

function projectResourcePath(projectPath, target) {
  const project = path.posix.normalize(String(projectPath ?? '').replaceAll('\\', '/'));
  const targetPath = path.posix.normalize(String(target ?? '').replaceAll('\\', '/'));
  if (!project || project === '.' || project === '..' || project.startsWith('../') || path.posix.isAbsolute(project)
    || !targetPath || path.posix.isAbsolute(targetPath) || !targetPath.startsWith(`${project}/`)) throw conflict('Save target is outside the verified Project path.');
  const relative = path.posix.relative(project, targetPath);
  if (!relative || path.posix.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) throw conflict('Save target is outside the verified Project path.');
  return relative;
}

function projectTargetFacts(root, projectPath, target) {
  const resourcePath = projectResourcePath(projectPath, target);
  return {
    path: path.resolve(root, ...String(target).split('/')),
    relative_path: target,
    resource_path: resourcePath,
  };
}

function scopedKey({ channel, caller = {}, requestKey }) {
  if (!requestKey?.trim()) throw new Error('Save prepare requires a caller request key.');
  if (!caller.tool?.trim() || !caller.client_run_id?.trim()) {
    throw new Error('Save prepare requires caller tool and client_run_id.');
  }
  return `${channel}:${caller.tool}:${caller.client_run_id}:${requestKey}`;
}

function awaitReservation(stateDir, requestKey, requestHashValue) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const row = readJournal(stateDir).find((item) => item.request_key === requestKey) ?? null;
    if (!row) break;
    if (row.request_hash !== requestHashValue) throw conflict('This caller request key was already used for a different save request.');
    if (row.status !== 'reserving') return row;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return null;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : null; }
}

function result(row) {
  return {
    schema: 'atlas.save-result.v1', save_id: row.save_id, run_id: row.run_id,
    status: row.status, channel: row.channel, caller: row.caller,
    project: row.project, target: row.target, verification: row.verification ?? null,
    source: row.source ?? null, inputs: row.inputs ?? [], parameters: row.parameters ?? {}, result_summary: row.result_summary ?? {},
    created_at: row.created_at, executed_at: row.executed_at ?? null,
    resources_href: row.resources_href, verified: row.status === 'executed', undo_available: row.undo_available === true, redo_available: row.redo_available === true,
    resource_id: row.resource_id ?? null, relationships: row.relationships ?? [],
  };
}

export class SaveService {
  constructor({ stateDir, intake = null, writeJournalFn = writeJournal, resourceControl = null }) {
    this.stateDir = path.resolve(stateDir);
    this.intake = intake ?? new Intake({ stateDir: this.stateDir });
    this.writeJournal = writeJournalFn;
    this.resourceControl = resourceControl;
  }
  #assertRecoveryWritable(projectId, source = null, inputs = [], root = null) {
    if (!fs.existsSync(path.join(this.stateDir, 'ledger.sqlite'))) return;
    this.resourceControl ??= createResourceControl({ stateDir: this.stateDir });
    const ledger = this.resourceControl.ledger;
    assertRecoveryWritable(ledger.db, { projectId });
    for (const item of [source, ...(source?.sources ?? [])].filter(Boolean)) {
      const resourceId = item.resource_id ?? (item.path ? ledger.resources.byPath(path.resolve(item.path))?.id : null);
      if (resourceId) assertRecoveryWritable(ledger.db, { resourceId });
    }
    for (const input of inputs) {
      const file = typeof input === 'string' ? input : input.relative_path;
      if (!file || (!root && !path.isAbsolute(file))) continue;
      const resourceId = ledger.resources.byPath(path.resolve(root ?? '.', file))?.id;
      if (resourceId) assertRecoveryWritable(ledger.db, { resourceId });
    }
  }
  #assertRowWritable(row) {
    if (!row) return;
    this.#assertRecoveryWritable(row.project?.id ?? row.prepare_request?.project_id, row.source,
      row.inputs ?? row.prepare_request?.inputs ?? [], row.prepare_request?.root);
  }
  #recordResource(saveId, row) {
    if (!fs.existsSync(row.target.path)) return null;
    return withStateLock(this.stateDir, () => {
      const latest = readJournal(this.stateDir).find((item) => item.save_id === saveId) ?? row;
      if (latest.resource_id) return { resource_id: latest.resource_id, relationships: latest.relationships ?? [] };
      if (!fs.existsSync(path.join(this.stateDir, 'ledger.sqlite'))) return null;
      this.resourceControl ??= createResourceControl({ stateDir: this.stateDir });
      if (!this.resourceControl.ledger.resources.projectExists(latest.project?.id)) return null;
      return this.resourceControl.recordSave({ saveId, channel: latest.channel, project: latest.project, target: latest.target, source: latest.source, caller: latest.caller });
    });
  }

  #validatePreparedInputs(row) {
    if (!row?.inputs?.length || !row.prepare_request?.root) return;
    const current = inputFacts(row.prepare_request.root, row.inputs.map((input) => input.relative_path));
    if (JSON.stringify(current) !== JSON.stringify(row.inputs)) {
      throw conflict('A Save input changed after Prepare. Review and prepare the result again.');
    }
  }

  reconcileCommitting(saveId, row = null) {
    const current = row ?? readJournal(this.stateDir).find((item) => item.save_id === saveId);
    if (current?.status !== 'committing') return current;
    this.#assertRowWritable(current);
    if (typeof this.intake.show !== 'function') return current;
    const detail = this.intake.show(saveId);
    const receipt = detail?.execution_receipt;
    if (!receipt?.verified) return current;
    const resource = this.#recordResource(saveId, current);
    const verification = { sha256: receipt.after_sha256 ?? receipt.output_hash, verified_at: receipt.executed_at ?? now() };
    return mutate(this.stateDir, saveId, (latest) => {
      if (!latest || latest.status !== 'committing') return latest;
      return { ...latest, status: 'executed', resource_id: resource?.resource_id ?? null, relationships: resource?.relationships ?? [], resources_href: resource?.resource_id ? projectResourceHref(`/projects/${encodeURIComponent(latest.project.id)}`, latest.target.resource_path, resource.resource_id) : latest.resources_href, verification, undo_available: receipt.rollback_ready === true, redo_available: false, executed_at: receipt.executed_at ?? now(), owner_pid: null, owner_token: null };
    }, this.writeJournal);
  }

  claimStaleReservation(reservation, hash) {
    if (processAlive(reservation.owner_pid) !== false) throw conflict('This save request is still being prepared by another Atlas process. Try again shortly.');
    return withStateLock(this.stateDir, () => {
      const items = readJournal(this.stateDir); const index = items.findIndex((item) => item.save_id === reservation.save_id);
      const row = items[index];
      if (!row || row.request_hash !== hash || row.status !== 'reserving') return { row, acquired: false };
      if (row.owner_pid !== reservation.owner_pid || row.owner_token !== reservation.owner_token) return { row, acquired: false };
      const claim = { ...row, owner_pid: process.pid, owner_token: crypto.randomUUID() };
      items[index] = claim; this.writeJournal(this.stateDir, items); return { row: claim, acquired: true };
    });
  }

  reconcileTransition(saveId, row) {
    if (row?.status !== 'undoing' && row?.status !== 'redoing') return row;
    this.#assertRowWritable(row);
    const detail = this.intake.show(saveId);
    const rolledBack = detail?.run?.status === 'rolled_back';
    const executed = detail?.run?.status === 'executed' && detail?.execution_receipt?.verified;
    if (row.status === 'undoing') {
      if (rolledBack) {
        if (row.resource_id) { this.resourceControl ??= createResourceControl({ stateDir: this.stateDir }); this.resourceControl.markSaveUndone({ resourceId: row.resource_id, target: row.target, saveId, caller: row.caller, transitionId: row.undo_transition_id }); }
        return mutate(this.stateDir, saveId, (latest) => latest?.status === 'undoing' ? { ...latest, status: 'undone', undo_available: false, redo_available: true } : latest, this.writeJournal);
      }
      if (executed) return mutate(this.stateDir, saveId, (latest) => latest?.status === 'undoing' ? { ...latest, status: 'executed', undo_available: true, redo_available: false } : latest, this.writeJournal);
    }
    if (row.status === 'redoing') {
      if (executed) {
        if (row.resource_id) { this.resourceControl ??= createResourceControl({ stateDir: this.stateDir }); this.resourceControl.markSaveRedone({ resourceId: row.resource_id, target: row.target, project: row.project, saveId, caller: row.caller, transitionId: row.redo_transition_id }); }
        return mutate(this.stateDir, saveId, (latest) => latest?.status === 'redoing' ? { ...latest, status: 'executed', undo_available: true, redo_available: false } : latest, this.writeJournal);
      }
      if (rolledBack) return mutate(this.stateDir, saveId, (latest) => latest?.status === 'redoing' ? { ...latest, status: 'undone', undo_available: false, redo_available: true } : latest, this.writeJournal);
    }
    return row;
  }

  recoverClaim(claim, options) {
    try {
    let detail;
    try { detail = this.intake.show(claim.save_id); } catch (error) {
      if (error.code !== 'ATLAS_RUN_NOT_FOUND') throw error;
      const stored = claim.prepare_request;
      const candidate = candidateFact(options.candidateFile); const inputs = inputFacts(options.root, options.inputs ?? []);
      const replayRoot = fs.realpathSync.native(path.resolve(options.root));
      if (!stored || replayRoot !== stored.root || candidate.path !== stored.candidate_path || candidate.sha256 !== stored.candidate_hash || JSON.stringify(inputs) !== JSON.stringify(stored.inputs)) throw conflict('Save replay no longer matches its reserved prepare request.');
      detail = this.intake.prepare({ root: stored.root, candidateFile: stored.candidate_path, origin: stored.origin, kind: stored.kind, projectId: stored.project_id, target: stored.target, inputs: options.inputs ?? [], relationType: stored.relation_type, intent: stored.intent, caller: claim.caller, runId: claim.save_id });
    }
    if (detail?.run) {
      const stored = claim.prepare_request;
      if (detail.run.id !== claim.save_id || detail.run.root_path !== stored.root || detail.candidate?.target_path !== stored.target || detail.candidate?.content_hash !== stored.candidate_hash || detail.placement?.project_id !== stored.project_id) throw conflict('The reserved save run does not match its immutable request facts.');
      const projectPath = detail.placement?.project_path;
      const target = detail.candidate?.target_path;
      const targetFacts = projectTargetFacts(stored.root, projectPath, target);
      const project = { id: detail.placement.project_id, name: detail.placement.project_name ?? '' };
      if (detail.run.status === 'executed' && detail.execution_receipt?.verified) {
        const committing = mutate(this.stateDir, claim.save_id, (latest) => (latest?.status === 'reserving' && latest.owner_pid === claim.owner_pid && latest.owner_token === claim.owner_token
          ? { ...latest, status: 'committing', project, target: targetFacts, resources_href: projectResourceHref(`/projects/${encodeURIComponent(project.id)}`, targetFacts.resource_path), owner_pid: null, owner_token: null }
          : latest), this.writeJournal);
        return this.reconcileCommitting(claim.save_id, committing);
      }
      if (detail.run.status !== 'prepared') throw conflict('The reserved save has an existing run that cannot be recovered yet.');
      detail = { status: 'prepared', run_id: claim.save_id, target, project: { ...project, path: projectPath } };
    }
    if (detail?.status !== 'prepared' || detail.run_id !== claim.save_id) throw conflict('The reserved save has an existing run that cannot be recovered yet.');
    const project = { id: detail.project.id, name: detail.project.name };
    const target = projectTargetFacts(claim.prepare_request.root, detail.project.path, detail.target);
    const row = { ...claim, status: 'prepared', project, target, resources_href: projectResourceHref(`/projects/${encodeURIComponent(project.id)}`, target.resource_path), owner_pid: null, owner_token: null };
    return mutate(this.stateDir, claim.save_id, (latest) => (latest?.status === 'reserving' && latest.owner_pid === claim.owner_pid && latest.owner_token === claim.owner_token ? row : latest), this.writeJournal);
    } catch (error) {
      mutate(this.stateDir, claim.save_id, (latest) => (latest?.status === 'reserving' && latest.owner_pid === claim.owner_pid && latest.owner_token === claim.owner_token
        ? { ...latest, status: 'failed', owner_pid: null, owner_token: null, error: error.message }
        : latest), this.writeJournal);
      throw error;
    }
  }

  prepare(options) {
    this.#assertRecoveryWritable(options.projectId, options.source, options.inputs, options.root);
    const channel = options.channel ?? 'host';
    const caller = options.caller ?? {};
    const request_key = scopedKey({ channel, caller, requestKey: options.requestKey });
    const candidate = candidateFact(options.candidateFile);
    if (options.expectedCandidateHash && options.expectedCandidateHash !== candidate.sha256) {
      throw conflict('The reviewed Save Candidate changed before confirmation.');
    }
    const root = fs.realpathSync.native(path.resolve(options.root));
    const inputs = inputFacts(root, options.inputs ?? []);
    const normalized = {
      root, origin: normalizedToken(options.origin, 'agent_generated'), kind: normalizedToken(options.kind),
      project_id: options.projectId, target: String(options.target ?? '').replaceAll('\\', '/'),
      candidate_hash: candidate.sha256, inputs,
      role: options.role ?? null, relation_type: options.relationType ?? 'derived_from', source: options.source ?? null,
      parameters: options.parameters ?? {}, result_summary: options.resultSummary ?? {},
    };
    const hash = requestHash(normalized);
    const saveId = `SAV-${crypto.randomUUID()}`;
    const reservation = withStateLock(this.stateDir, () => {
      this.#assertRecoveryWritable(options.projectId, options.source, options.inputs, options.root);
      const items = readJournal(this.stateDir);
      const existing = items.find((item) => item.request_key === request_key) ?? null;
      if (existing) return existing;
      const row = {
        save_id: saveId, run_id: saveId, status: 'reserving', channel, caller,
        project: null, target: { path: null, relative_path: normalized.target, resource_path: null }, candidate,
        request_key, request_hash: hash, owner_pid: process.pid, owner_token: crypto.randomUUID(), created_at: now(), resources_href: null, undo_available: false, source: options.source ?? null, parameters: options.parameters ?? {}, result_summary: options.resultSummary ?? {},
        prepare_request: { root: normalized.root, project_id: options.projectId, target: normalized.target, candidate_path: candidate.path, candidate_hash: candidate.sha256, inputs, origin: normalized.origin, kind: normalized.kind, relation_type: options.relationType ?? 'derived_from', intent: options.intent ?? 'Save one prepared result.', source: options.source ?? null, parameters: options.parameters ?? {}, result_summary: options.resultSummary ?? {} },
      };
      items.unshift(row); this.writeJournal(this.stateDir, items); return row;
    });
    if (reservation.save_id !== saveId) {
      if (reservation.request_hash !== hash) throw conflict('This caller request key was already used for a different save request.');
      if (reservation.status !== 'reserving') return result(reservation);
      const settled = awaitReservation(this.stateDir, request_key, hash);
      if (settled) return result(settled);
      const claimed = this.claimStaleReservation(reservation, hash);
      if (!claimed?.row || claimed.row.status !== 'reserving') return result(claimed?.row);
      if (!claimed.acquired) {
        const peerSettled = awaitReservation(this.stateDir, request_key, hash);
        if (peerSettled) return result(peerSettled);
        throw conflict('This save request is still being prepared by another Atlas process. Try again shortly.');
      }
      return result(this.recoverClaim(claimed.row, options));
    }
    let prepared;
    try {
      prepared = this.intake.prepare({
      root: normalized.root, candidateFile: candidate.path, origin: normalized.origin,
      kind: normalized.kind, projectId: options.projectId, target: options.target, inputs: options.inputs ?? [],
      relationType: options.relationType ?? 'derived_from', intent: options.intent ?? 'Save one prepared result.',
      caller, runId: saveId,
    });
      if (prepared.status !== 'prepared' || prepared.run_id !== saveId) throw new Error(prepared.reason ?? 'Atlas could not prepare this save.');
      const project = { id: prepared.project.id, name: prepared.project.name };
      const target = projectTargetFacts(normalized.root, prepared.project.path, prepared.target);
      const row = {
        save_id: saveId, run_id: saveId, status: 'prepared', channel, caller, project,
        target, candidate, request_key,
        request_hash: hash, created_at: now(), resources_href: projectResourceHref(`/projects/${encodeURIComponent(project.id)}`, target.resource_path), owner_pid: null, owner_token: null,
        inputs,
        prepare_request: { ...reservation.prepare_request, target: prepared.target },
        source: options.source ?? null, parameters: options.parameters ?? {}, result_summary: options.resultSummary ?? {},
        undo_available: false,
      };
      return result(mutate(this.stateDir, saveId, () => row, this.writeJournal));
    } catch (error) {
      mutate(this.stateDir, saveId, (row) => ({ ...row, status: 'failed', owner_pid: null, owner_token: null, error: error.message }), this.writeJournal);
      if (!error.code && /already exists|never overwrites/iu.test(error.message)) throw conflict(error.message);
      throw error;
    }
  }

  show(saveId) {
    let row = readJournal(this.stateDir).find((item) => item.save_id === saveId);
    if (!row) throw new Error('Save result is unavailable.');
    if (row.status === 'committing') row = this.reconcileCommitting(saveId, row);
    if (row.status === 'undoing' || row.status === 'redoing') row = this.reconcileTransition(saveId, row);
    const shown = result(row);
    if (row.status === 'executed') {
      // A Save receipt records a past verification, not proof that today's bytes exist.
      shown.verified = false;
      shown.current_output = 'unavailable';
      try {
        const target = path.resolve(row.target.path);
        let cursor = path.parse(target).root;
        for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
          cursor = path.join(cursor, part);
          if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Linked result is unavailable.');
        }
        if (!fs.lstatSync(target).isFile()) throw new Error('Result is not a regular file.');
        shown.verified = sha256File(target) === row.verification?.sha256;
        shown.current_output = shown.verified ? 'verified' : 'changed';
      } catch (error) {
        shown.current_output = error.code === 'ENOENT' ? 'missing' : 'unavailable';
        shown.undo_available = false;
      }
    }
    return shown;
  }

  review(saveId) {
    const save = this.show(saveId);
    if (!['.md', '.txt'].includes(path.extname(save.target?.path ?? '').toLowerCase())) return { save, preview: null };
    const detail = this.intake.show(saveId);
    const candidate = detail.candidate;
    if (!candidate?.blob_path || sha256File(candidate.blob_path) !== candidate.content_hash) throw conflict('Stored Save preview is unavailable or changed.');
    const descriptor = fs.openSync(candidate.blob_path, 'r');
    try {
      const bytes = Buffer.alloc(20_000);
      const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      return { save, preview: { text: bytes.subarray(0, length).toString('utf8'), truncated: candidate.byte_size > length } };
    } finally { fs.closeSync(descriptor); }
  }

  candidateSnapshot(saveId) {
    const detail = this.intake.show(saveId);
    const candidate = detail?.candidate;
    if (!candidate?.blob_path || !fs.existsSync(candidate.blob_path) || sha256File(candidate.blob_path) !== candidate.content_hash) {
      throw conflict('Stored Save candidate is unavailable or changed.');
    }
    return { path: candidate.blob_path, sha256: candidate.content_hash, bytes: candidate.byte_size };
  }

  execute(saveId, { reason } = {}) {
    this.#assertRowWritable(readJournal(this.stateDir).find((row) => row.save_id === saveId));
    const before = this.show(saveId);
    if (before.status === 'executed') return before;
    if (before.status !== 'prepared' && before.status !== 'committing') throw conflict(`Save cannot execute from ${before.status}.`);
    if (before.status === 'prepared') this.#validatePreparedInputs(readJournal(this.stateDir).find((row) => row.save_id === saveId));
    const claimed = mutate(this.stateDir, saveId, (row) => {
      if (!row || !['prepared', 'committing'].includes(row.status)) return row;
      return { ...row, status: 'committing', committing_at: row.committing_at ?? now() };
    }, this.writeJournal);
    if (claimed.status !== 'committing') return result(claimed);
    const reconciled = this.reconcileCommitting(saveId, claimed);
    if (reconciled.status === 'executed') return result(reconciled);
    const receipt = this.intake.execute(saveId, { reason });
    if (!receipt.verified) throw new Error('Atlas did not verify the saved result.');
    const verification = { sha256: receipt.after_sha256 ?? receipt.output_hash, verified_at: receipt.executed_at ?? now() };
    const current = readJournal(this.stateDir).find((row) => row.save_id === saveId);
    const resource = this.#recordResource(saveId, current);
    return result(mutate(this.stateDir, saveId, (row) => {
      if (row?.status !== 'committing') return row;
      return { ...row, status: 'executed', resource_id: resource?.resource_id ?? null, relationships: resource?.relationships ?? [], resources_href: resource?.resource_id ? projectResourceHref(`/projects/${encodeURIComponent(row.project.id)}`, row.target.resource_path, resource.resource_id) : row.resources_href, verification, undo_available: receipt.rollback_ready === true, redo_available: false, executed_at: now(), owner_pid: null, owner_token: null };
    }, this.writeJournal));
  }

  undo(saveId) {
    this.#assertRowWritable(readJournal(this.stateDir).find((row) => row.save_id === saveId));
    const before = this.show(saveId);
    if (!before.undo_available) throw conflict('Undo is not available for this save.');
    const claimed = mutate(this.stateDir, saveId, (row) => {
      if (!row?.undo_available || row.status !== 'executed') throw conflict('Undo is not available for this save.');
      return { ...row, status: 'undoing', undo_available: false, undo_transition_id: crypto.randomUUID(), undo_attempted_at: now() };
    }, this.writeJournal);
    try {
      if (claimed.resource_id) {
        this.resourceControl ??= createResourceControl({ stateDir: this.stateDir });
        if (!this.resourceControl.relationshipsMatch(claimed.resource_id, claimed.relationships ?? [])) throw conflict('Saved Resource relationships changed after this Save. Undo was not applied.');
        this.resourceControl.preflightSaveUndo({ saveId, resourceId: claimed.resource_id, target: claimed.target, project: claimed.project, verification: claimed.verification });
      }
      const receipt = this.intake.rollback(saveId);
      if (claimed.resource_id) this.resourceControl.markSaveUndone({ resourceId: claimed.resource_id, target: claimed.target, saveId, caller: claimed.caller, transitionId: claimed.undo_transition_id });
      return result(mutate(this.stateDir, saveId, (row) => {
        if (row?.status !== 'undoing') return row;
        return { ...row, status: 'undone', undo_available: false, redo_available: true, undone_at: receipt.rolled_back_at ?? now() };
      }, this.writeJournal));
    } catch (error) {
      const detail = this.intake.show?.(saveId);
      if (detail?.run?.status !== 'rolled_back') mutate(this.stateDir, saveId, (row) => row?.status === 'undoing'
        ? { ...row, status: 'executed', undo_available: true, redo_available: false, undo_error: error.message }
        : row, this.writeJournal);
      throw error;
    }
  }

  redo(saveId) {
    this.#assertRowWritable(readJournal(this.stateDir).find((row) => row.save_id === saveId));
    const before = this.show(saveId);
    if (!before.redo_available || before.status !== 'undone') throw conflict('Redo is not available for this save.');
    const claimed = mutate(this.stateDir, saveId, (row) => {
      if (!row?.redo_available || row.status !== 'undone') throw conflict('Redo is not available for this save.');
      return { ...row, status: 'redoing', redo_available: false, redo_transition_id: crypto.randomUUID(), redo_attempted_at: now() };
    }, this.writeJournal);
    try {
      if (claimed.resource_id) {
        this.resourceControl ??= createResourceControl({ stateDir: this.stateDir });
        if (!this.resourceControl.relationshipsMatch(claimed.resource_id, claimed.relationships ?? [])) throw conflict('Saved Resource relationships changed after this Save. Redo was not applied.');
        this.resourceControl.preflightSaveRedo({ saveId, resourceId: claimed.resource_id, target: claimed.target, verification: claimed.verification, channel: claimed.channel });
      }
      const receipt = this.intake.redo(saveId);
      if (!receipt?.verified) throw new Error('Atlas did not verify the redone result.');
      if (claimed.resource_id) this.resourceControl.markSaveRedone({ resourceId: claimed.resource_id, target: claimed.target, project: claimed.project, saveId, caller: claimed.caller, transitionId: claimed.redo_transition_id });
      const verification = { sha256: receipt.after_sha256 ?? receipt.output_hash, verified_at: receipt.redone_at ?? now() };
      return result(mutate(this.stateDir, saveId, (row) => row?.status === 'redoing'
        ? { ...row, status: 'executed', verification, undo_available: true, redo_available: false, redone_at: receipt.redone_at ?? now() }
        : row, this.writeJournal));
    } catch (error) {
      const detail = this.intake.show?.(saveId);
      if (!(detail?.run?.status === 'executed' && detail?.execution_receipt?.verified)) mutate(this.stateDir, saveId, (row) => row?.status === 'redoing'
        ? { ...row, status: 'undone', undo_available: false, redo_available: true, redo_error: error.message }
        : row, this.writeJournal);
      throw error;
    }
  }

  dispose() { this.intake.dispose(); this.resourceControl?.dispose(); }
}

export function createSaveService(options) { return new SaveService(options); }
