import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function withStateLock(stateDir, callback, {
  timeoutMs = 30_000,
  staleMs = 10 * 60_000,
} = {}) {
  const lockDirectory = path.join(stateDir, 'locks');
  const lockPath = path.join(lockDirectory, 'runtime.lock');
  const token = crypto.randomUUID();
  const started = Date.now();
  fs.mkdirSync(lockDirectory, { recursive: true });

  while (true) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() }));
      fs.closeSync(descriptor);
      descriptor = null;
      break;
    } catch (error) {
      if (descriptor != null) fs.closeSync(descriptor);
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (!processIsAlive(owner.pid) || Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (inspectionError) {
        if (inspectionError.code === 'ENOENT') continue;
        let stat;
        try {
          stat = fs.statSync(lockPath);
        } catch (raceError) {
          // The owner may release an incomplete lock between read and retry.
          if (raceError.code === 'ENOENT') continue;
          throw raceError;
        }
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for another Atlas operation to release: ${lockPath}`);
      }
      Atomics.wait(WAIT_BUFFER, 0, 0, 25);
    }
  }

  try {
    return callback();
  } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (owner.token === token) fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
