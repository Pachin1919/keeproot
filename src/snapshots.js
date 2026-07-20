import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { toPortablePath } from './paths.js';

const COPY_RETRIES = 3;

export function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function sameFileVersion(before, after) {
  return before.size === after.size && before.mtimeMs === after.mtimeMs;
}

export function captureBlob(sourcePath, stateDir) {
  const blobDir = path.join(stateDir, 'blobs', 'sha256');
  const tempDir = path.join(stateDir, 'tmp');
  fs.mkdirSync(blobDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  for (let attempt = 1; attempt <= COPY_RETRIES; attempt += 1) {
    const before = fs.statSync(sourcePath);
    const tempPath = path.join(tempDir, `${crypto.randomUUID()}.snapshot`);
    fs.copyFileSync(sourcePath, tempPath);
    const afterCopy = fs.statSync(sourcePath);

    if (!sameFileVersion(before, afterCopy)) {
      fs.rmSync(tempPath, { force: true });
      continue;
    }

    const contentHash = sha256File(tempPath);
    const sourceHash = sha256File(sourcePath);
    const afterHash = fs.statSync(sourcePath);
    if (!sameFileVersion(afterCopy, afterHash) || sourceHash !== contentHash) {
      fs.rmSync(tempPath, { force: true });
      continue;
    }
    const blobPath = path.join(blobDir, contentHash);
    if (fs.existsSync(blobPath)) {
      fs.rmSync(tempPath, { force: true });
    } else {
      try {
        fs.renameSync(tempPath, blobPath);
      } catch (error) {
        fs.rmSync(tempPath, { force: true });
        if (!fs.existsSync(blobPath)) throw error;
      }
    }

    return {
      contentHash,
      byteSize: afterHash.size,
      blobPath,
    };
  }

  throw new Error(`File kept changing while Atlas captured its baseline: ${sourcePath}`);
}

export function captureBuffer(value, stateDir) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const contentHash = sha256Buffer(buffer);
  const blobDir = path.join(stateDir, 'blobs', 'sha256');
  const tempDir = path.join(stateDir, 'tmp');
  const blobPath = path.join(blobDir, contentHash);
  fs.mkdirSync(blobDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  if (!fs.existsSync(blobPath)) {
    const tempPath = path.join(tempDir, `${crypto.randomUUID()}.snapshot`);
    fs.writeFileSync(tempPath, buffer, { flag: 'wx' });
    try {
      fs.renameSync(tempPath, blobPath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      if (!fs.existsSync(blobPath)) throw error;
    }
  }
  return { contentHash, byteSize: buffer.length, blobPath };
}

export function scanRoot(root, { stateDir, capture = false } = {}) {
  const entries = [];

  function walk(directory) {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = toPortablePath(path.relative(root, absolute));

      if (child.isSymbolicLink()) {
        throw new Error(`Symbolic links are not supported inside a tracked root: ${absolute}`);
      }
      if (child.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!child.isFile()) {
        throw new Error(`Unsupported filesystem entry inside tracked root: ${absolute}`);
      }

      if (capture) {
        const snapshot = captureBlob(absolute, stateDir);
        entries.push({ path: relative, kind: 'file', ...snapshot });
      } else {
        const stat = fs.statSync(absolute);
        entries.push({
          path: relative,
          kind: 'file',
          contentHash: sha256File(absolute),
          byteSize: stat.size,
          blobPath: null,
        });
      }
    }
  }

  walk(root);
  return entries;
}

export function snapshotChangedFiles(root, stateDir, changes) {
  for (const change of changes) {
    if (!change.after) continue;
    const absolute = path.join(root, ...change.path.split('/'));
    const snapshot = captureBlob(absolute, stateDir);
    if (snapshot.contentHash !== change.after.contentHash) {
      throw new Error(`File changed while Atlas was closing the run; retry close: ${absolute}`);
    }
    change.after = { ...change.after, ...snapshot };
  }
}
