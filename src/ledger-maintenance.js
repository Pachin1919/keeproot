import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION } from './ledger.js';
import { withStateLock } from './state-lock.js';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function databaseImage(databasePath) {
  if (!fs.existsSync(databasePath)) throw new Error(`Ledger does not exist: ${databasePath}`);
  let database = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const integrityMessages = database.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]);
    if (integrityMessages.length !== 1 || integrityMessages[0] !== 'ok') {
      throw new Error(`Ledger integrity check failed: ${integrityMessages.join('; ')}`);
    }
    const schemaVersion = database.prepare('PRAGMA user_version').get().user_version;
    return {
      image: Buffer.from(database.serialize()),
      schemaVersion,
      integrity: 'ok',
    };
  } catch (error) {
    if (/integrity check failed/i.test(error.message)) throw error;
    throw new Error(`Backup is not a valid SQLite Ledger: ${error.message}`);
  } finally {
    database?.close();
  }
}

function backupPath(stateDir, backupName) {
  if (typeof backupName !== 'string'
      || backupName !== path.basename(backupName)
      || !backupName.toLowerCase().endsWith('.sqlite')) {
    throw new Error('Backup name must be one SQLite filename from the Atlas backups directory.');
  }
  const backupDir = path.join(path.resolve(stateDir), 'backups');
  const candidate = path.join(backupDir, backupName);
  const relative = path.relative(backupDir, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Backup name escapes the Atlas backups directory.');
  }
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup must be a regular non-symbolic-link file.');
  return candidate;
}

export function ledgerFileHash(stateDir) {
  const current = databaseImage(path.join(path.resolve(stateDir), 'ledger.sqlite'));
  return sha256(current.image);
}

export function listLedgerBackups(stateDir) {
  const resolvedState = path.resolve(stateDir);
  const directory = path.join(resolvedState, 'backups');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.sqlite'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const absolute = path.join(directory, entry.name);
      try {
        const inspected = databaseImage(absolute);
        return {
          name: entry.name,
          schema_version: inspected.schemaVersion,
          byte_size: fs.statSync(absolute).size,
          sha256: sha256(inspected.image),
          integrity: inspected.integrity,
          restorable: inspected.schemaVersion <= LATEST_SCHEMA_VERSION,
        };
      } catch (error) {
        return {
          name: entry.name,
          byte_size: fs.statSync(absolute).size,
          integrity: 'failed',
          restorable: false,
          error: error.message,
        };
      }
    });
}

export function restoreLedgerBackup({ stateDir, backupName, expectedCurrentHash }) {
  const resolvedState = path.resolve(stateDir);
  return withStateLock(resolvedState, () => {
    if (!/^[a-f0-9]{64}$/i.test(expectedCurrentHash ?? '')) {
      throw new Error('Ledger restore requires the exact current Ledger SHA-256.');
    }
    const databasePath = path.join(resolvedState, 'ledger.sqlite');
    const current = databaseImage(databasePath);
    const currentHash = sha256(current.image);
    if (currentHash !== expectedCurrentHash.toLowerCase()) {
      throw new Error('Current Ledger changed after the restore plan; inspect backups and retry.');
    }

    const sourcePath = backupPath(resolvedState, backupName);
    const source = databaseImage(sourcePath);
    if (source.schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Backup schema ${source.schemaVersion} is newer than this Atlas build supports (${LATEST_SCHEMA_VERSION}).`,
      );
    }

    const backupDir = path.join(resolvedState, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const suffix = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${currentHash.slice(0, 12)}`;
    const safetyName = `ledger-pre-restore-${suffix}.sqlite`;
    const safetyPath = path.join(backupDir, safetyName);
    const replacementPath = path.join(resolvedState, `ledger-restore-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(safetyPath, current.image, { flag: 'wx' });
    try {
      fs.writeFileSync(replacementPath, source.image, { flag: 'wx' });
      fs.copyFileSync(replacementPath, databasePath);
      fs.rmSync(`${databasePath}-wal`, { force: true });
      fs.rmSync(`${databasePath}-shm`, { force: true });
      const restored = databaseImage(databasePath);
      if (sha256(restored.image) !== sha256(source.image)) {
        throw new Error('Restored Ledger does not match the selected backup.');
      }
    } catch (error) {
      fs.writeFileSync(databasePath, current.image);
      fs.rmSync(`${databasePath}-wal`, { force: true });
      fs.rmSync(`${databasePath}-shm`, { force: true });
      throw error;
    } finally {
      fs.rmSync(replacementPath, { force: true });
    }

    return {
      status: 'restored',
      restored_from: backupName,
      restored_schema_version: source.schemaVersion,
      restored_hash: sha256(source.image),
      previous_hash: currentHash,
      safety_backup: safetyName,
      next_step: source.schemaVersion < LATEST_SCHEMA_VERSION
        ? `Open Atlas to migrate schema ${source.schemaVersion} to ${LATEST_SCHEMA_VERSION}.`
        : 'Run atlas doctor --json.',
    };
  });
}
