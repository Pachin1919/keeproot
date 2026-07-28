import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from './ledger.js';
import { isPathInside, toPortablePath } from './paths.js';
import { sha256File } from './snapshots.js';
import { withStateLock } from './state-lock.js';

const WORK_KINDS = new Set(['candidate', 'proposal', 'intermediate']);

function timestamp() {
  return new Date().toISOString();
}

function makeWorkId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `WORK-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function countFiles(root) {
  const result = { files: 0, bytes: 0 };
  if (!fs.existsSync(root)) return result;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        result.files += 1;
        result.bytes += stat.size;
      }
    }
  }
  walk(root);
  return result;
}

function writeJsonAtomic(filePath, value) {
  const temporary = path.join(path.dirname(filePath), `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readManifest(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function regularFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) files.push({ path: absolute, size: stat.size, modified_ms: stat.mtimeMs });
    }
  }
  walk(root);
  return files;
}

export class RuntimeStorage {
  constructor({ stateDir, ledger = null }) {
    if (!stateDir) throw new Error('RuntimeStorage requires a stateDir.');
    this.stateDir = path.resolve(stateDir);
    this.workDir = path.join(this.stateDir, 'work');
    this.tempDir = path.join(this.stateDir, 'tmp');
    this._ledger = ledger;
    this._ownsLedger = false;
  }

  get ledger() {
    if (!this._ledger) {
      this._ledger = new Ledger(this.stateDir);
      this._ownsLedger = true;
    }
    return this._ledger;
  }

  stage({ source, kind, ttlHours = 168 }) {
    if (!WORK_KINDS.has(kind)) {
      throw new Error(`Work kind must be one of: ${[...WORK_KINDS].join(', ')}.`);
    }
    const hours = Number(ttlHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
      throw new Error('Work ttlHours must be greater than 0 and no more than 8760.');
    }
    const absoluteSource = path.resolve(source);
    if (!fs.existsSync(absoluteSource)) throw new Error(`Work source does not exist: ${absoluteSource}`);
    const sourceStat = fs.lstatSync(absoluteSource);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Work source must be a regular non-symbolic-link file: ${absoluteSource}`);
    }
    return withStateLock(this.stateDir, () => {
      fs.mkdirSync(this.workDir, { recursive: true });
      const workId = makeWorkId();
      const itemDir = path.join(this.workDir, workId);
      fs.mkdirSync(itemDir);
      try {
        const extension = path.extname(absoluteSource).slice(0, 32);
        const payloadPath = path.join(itemDir, `payload${extension}`);
        fs.copyFileSync(absoluteSource, payloadPath, fs.constants.COPYFILE_EXCL);
        const createdAt = timestamp();
        const manifest = {
          version: 'atlas-work.v1',
          work_id: workId,
          kind,
          status: 'staged',
          source_name: path.basename(absoluteSource),
          payload: path.basename(payloadPath),
          content_hash: sha256File(payloadPath),
          byte_size: fs.statSync(payloadPath).size,
          created_at: createdAt,
          updated_at: createdAt,
          expires_at: new Date(Date.parse(createdAt) + hours * 60 * 60 * 1000).toISOString(),
          captured_by_run_id: null,
        };
        writeJsonAtomic(path.join(itemDir, 'manifest.json'), manifest);
        return { ...manifest, payload_path: payloadPath };
      } catch (error) {
        fs.rmSync(itemDir, { recursive: true, force: true });
        throw error;
      }
    });
  }

  #resolveWorkItem(workId) {
    if (typeof workId !== 'string' || !/^WORK-[A-Za-z0-9-]+$/u.test(workId)) {
      throw new Error('Work ID is invalid.');
    }
    const itemDir = path.resolve(this.workDir, workId);
    if (!isPathInside(this.workDir, itemDir) || itemDir === this.workDir) {
      throw new Error('Work item escapes the managed work directory.');
    }
    const manifest = readManifest(itemDir);
    if (!manifest || manifest.work_id !== workId) throw new Error(`Work item not found or invalid: ${workId}`);
    return { itemDir, manifest };
  }

  markCaptured(payloadPath, runId) {
    const absolute = path.resolve(payloadPath);
    if (!isPathInside(this.workDir, absolute) || absolute === this.workDir) return null;
    const relative = path.relative(this.workDir, absolute).split(path.sep);
    if (relative.length < 2) return null;
    const workId = relative[0];
    if (!/^WORK-[A-Za-z0-9-]+$/u.test(workId)) {
      throw new Error(
        'Candidate path is inside Atlas managed work but is not a staged Work payload. '
        + 'Run atlas work stage --file <candidate> --kind candidate and use the returned payload_path.',
      );
    }
    return withStateLock(this.stateDir, () => {
      const { itemDir, manifest } = this.#resolveWorkItem(workId);
      const expected = path.resolve(itemDir, manifest.payload);
      if (absolute !== expected) throw new Error('Captured path is not the Work item payload.');
      if (!fs.existsSync(expected) || sha256File(expected) !== manifest.content_hash) {
        throw new Error(`Work item payload no longer matches its manifest: ${workId}`);
      }
      if (manifest.status === 'captured' && manifest.captured_by_run_id === runId) {
        return { ...manifest, payload_path: expected };
      }
      if (manifest.status !== 'staged') {
        throw new Error(`Work item ${workId} cannot be captured from status ${manifest.status}.`);
      }
      const updated = {
        ...manifest,
        status: 'captured',
        captured_by_run_id: runId,
        updated_at: timestamp(),
      };
      writeJsonAtomic(path.join(itemDir, 'manifest.json'), updated);
      return { ...updated, payload_path: expected };
    });
  }

  release(workId, { reason = null } = {}) {
    return withStateLock(this.stateDir, () => {
      const { itemDir, manifest } = this.#resolveWorkItem(workId);
      if (manifest.status === 'released') return { ...manifest, payload_path: path.join(itemDir, manifest.payload) };
      const updated = { ...manifest, status: 'released', release_reason: reason, updated_at: timestamp() };
      writeJsonAtomic(path.join(itemDir, 'manifest.json'), updated);
      return { ...updated, payload_path: path.join(itemDir, manifest.payload) };
    });
  }

  listWork() {
    if (!fs.existsSync(this.workDir)) return [];
    return fs.readdirSync(this.workDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => {
        const itemDir = path.join(this.workDir, entry.name);
        const manifest = readManifest(itemDir);
        return manifest ? { ...manifest, payload_path: path.join(itemDir, manifest.payload) } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  status() {
    const workItems = this.listWork();
    const grouped = {};
    for (const item of workItems) {
      grouped[item.status] ??= { items: 0, bytes: 0 };
      grouped[item.status].items += 1;
      grouped[item.status].bytes += item.byte_size;
    }
    const nowMs = Date.now();
    const overdueStaged = workItems.filter(
      (item) => item.status === 'staged' && Date.parse(item.expires_at) <= nowMs,
    );
    const ledgerFiles = ['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm']
      .map((name) => path.join(this.stateDir, name))
      .filter((filePath) => fs.existsSync(filePath) && fs.lstatSync(filePath).isFile())
      .map((filePath) => ({ path: filePath, size: fs.statSync(filePath).size }));
    const summarize = (items) => ({
      files: items.length,
      bytes: items.reduce((sum, item) => sum + item.size, 0),
    });
    return {
      state_dir: this.stateDir,
      technical_temp: countFiles(this.tempDir),
      managed_work: {
        items: workItems.length,
        bytes: workItems.reduce((sum, item) => sum + item.byte_size, 0),
        overdue_staged_items: overdueStaged.length,
        overdue_staged_bytes: overdueStaged.reduce((sum, item) => sum + item.byte_size, 0),
        by_status: grouped,
      },
      content_blobs: countFiles(path.join(this.stateDir, 'blobs', 'sha256')),
      protected_backups: countFiles(path.join(this.stateDir, 'backups')),
      ledger: summarize(ledgerFiles),
      policies: {
        inbox_is_temp: false,
        staged_work_auto_deleted: false,
        protected_backups_auto_deleted: false,
        cleanup_requires_execute: true,
      },
    };
  }

  plan({ minAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
      throw new Error('Storage minAgeMs must be a non-negative finite number.');
    }
    const cutoff = Date.now() - minAgeMs;
    const tempFiles = regularFiles(this.tempDir)
      .filter((item) => item.modified_ms <= cutoff)
      .map((item) => ({ path: item.path, bytes: item.size, reason: 'stale_technical_temp' }));
    const workItems = this.listWork()
      .filter((item) => ['captured', 'released'].includes(item.status))
      .filter((item) => Date.parse(item.updated_at) <= cutoff)
      .map((item) => ({
        work_id: item.work_id,
        path: path.dirname(item.payload_path),
        bytes: item.byte_size,
        status: item.status,
        captured_by_run_id: item.captured_by_run_id,
        reason: 'captured_or_released_work_copy',
      }));
    const referenced = new Set(this.ledger.getReferencedBlobPaths().map((item) => path.resolve(item).toLowerCase()));
    const blobFiles = regularFiles(path.join(this.stateDir, 'blobs', 'sha256'))
      .filter((item) => item.modified_ms <= cutoff && !referenced.has(path.resolve(item.path).toLowerCase()))
      .map((item) => ({ path: item.path, bytes: item.size, reason: 'unreferenced_content_blob' }));
    return {
      mode: 'plan',
      min_age_ms: minAgeMs,
      temp_files: tempFiles,
      work_items: workItems,
      blob_files: blobFiles,
      protected: ['ledger', 'referenced_blobs', 'staged_work', 'backups', 'inbox', 'source_vault'],
      total_items: tempFiles.length + workItems.length + blobFiles.length,
      total_bytes: [...tempFiles, ...workItems, ...blobFiles].reduce((sum, item) => sum + item.bytes, 0),
    };
  }

  execute({ minAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    return withStateLock(this.stateDir, () => {
      const plan = this.plan({ minAgeMs });
      let deletedTempFiles = 0;
      let deletedWorkItems = 0;
      let deletedBlobs = 0;
      let deletedBytes = 0;
      for (const item of plan.temp_files) {
        const absolute = path.resolve(item.path);
        if (!isPathInside(this.tempDir, absolute)) throw new Error(`Temp cleanup target escaped: ${absolute}`);
        if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()) {
          fs.rmSync(absolute);
          deletedTempFiles += 1;
          deletedBytes += item.bytes;
        }
      }
      for (const item of plan.work_items) {
        const { itemDir, manifest } = this.#resolveWorkItem(item.work_id);
        if (!['captured', 'released'].includes(manifest.status)) continue;
        fs.rmSync(itemDir, { recursive: true });
        deletedWorkItems += 1;
        deletedBytes += item.bytes;
      }
      for (const item of plan.blob_files) {
        const blobRoot = path.join(this.stateDir, 'blobs', 'sha256');
        const absolute = path.resolve(item.path);
        if (!isPathInside(blobRoot, absolute)) throw new Error(`Blob cleanup target escaped: ${absolute}`);
        if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()) {
          fs.rmSync(absolute);
          deletedBlobs += 1;
          deletedBytes += item.bytes;
        }
      }
      return {
        mode: 'execute',
        min_age_ms: minAgeMs,
        deleted_temp_files: deletedTempFiles,
        deleted_work_items: deletedWorkItems,
        deleted_blobs: deletedBlobs,
        deleted_bytes: deletedBytes,
        protected: plan.protected,
      };
    });
  }

  showWork(workId) {
    const { itemDir, manifest } = this.#resolveWorkItem(workId);
    return { ...manifest, payload_path: path.join(itemDir, manifest.payload), relative_path: toPortablePath(path.relative(this.stateDir, itemDir)) };
  }

  dispose() {
    if (this._ownsLedger && this._ledger) this._ledger.close();
    this._ledger = null;
    this._ownsLedger = false;
  }
}
