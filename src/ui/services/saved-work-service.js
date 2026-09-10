import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contentFileFingerprint } from '../../content-inspection.js';
import { projectPath } from '../project-files.js';

function statePath(stateDir) { return path.join(path.resolve(stateDir), 'ui', 'saved-work.json'); }
function samePath(left, right) { return process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right); }
function writeState(stateDir, items) {
  const target = statePath(stateDir); fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try { fs.writeFileSync(temporary, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8'); fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
}
function writeRecoveryState(stateDir, issue) {
  const target = path.join(path.resolve(stateDir), 'ui', 'saved-work-recovery.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ issue }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function validRecord(value) {
  if (!value || !/^SWR-[a-f0-9-]{36}$/u.test(value.work_id ?? '') || typeof value.result_path !== 'string' || typeof value.source_path !== 'string') return null;
  return value;
}
export function readSavedWorkState(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(stateDir), 'utf8'));
    if (!value || !Array.isArray(value.items)) throw new Error('Saved Work has an invalid structure.');
    const items = value.items.map(validRecord); if (items.some((item) => !item)) throw new Error('Saved Work contains an invalid record.');
    return { items, error: null };
  } catch (error) { return error.code === 'ENOENT' ? { items: [], error: null } : { items: [], error: new Error('Saved Work could not be loaded.') }; }
}
function writable(stateDir) { const result = readSavedWorkState(stateDir); if (result.error) throw result.error; return result.items; }
function regularDirectory(directory) { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Destination folder is unavailable or linked outside this Project.'); }
function destination(projectRoot, folder, fileName, sourcePath = null) {
  let cleanName = String(fileName ?? '').trim();
  if (!cleanName || cleanName !== path.basename(cleanName) || cleanName.includes('\0')) throw new Error('Enter one file name.');
  const expectedExtension = path.extname(sourcePath ?? '').toLowerCase();
  if (['.csv', '.xlsx'].includes(expectedExtension)) {
    const enteredExtension = path.extname(cleanName).toLowerCase();
    if (!enteredExtension) cleanName += expectedExtension;
    else if (enteredExtension !== expectedExtension) {
      const format = expectedExtension.slice(1).toUpperCase();
      throw new Error(`This Data Work produces a ${format} result. Use a file name ending in ${expectedExtension}.`);
    }
  }
  const folderPath = projectPath(projectRoot, folder ?? ''); regularDirectory(folderPath);
  const target = path.resolve(folderPath, cleanName);
  const relative = path.relative(path.resolve(projectRoot), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Destination is outside this Project.');
  if (fs.existsSync(target)) { const error = new Error('File already exists. Choose a different name.'); error.code = 'ATLAS_STATE_CONFLICT'; throw error; }
  return target;
}

export function createSavedWorkService({ stateDir, writeStateFn = writeState }) {
  const stateForProject = (projectId) => {
    const state = readSavedWorkState(stateDir);
    return {
      items: state.items.filter((item) => item.status === 'active' && item.project?.id === projectId),
      error: state.error,
    };
  };
  const listForProject = (projectId) => {
    const state = stateForProject(projectId);
    if (state.error) throw state.error;
    return state.items;
  };
  const find = (workId) => readSavedWorkState(stateDir).items.find((item) => item.work_id === workId) ?? null;
  const prepareDestination = ({ projectRoot, folder, fileName, sourcePath }) => destination(projectRoot, folder, fileName, sourcePath);
  const save = ({ project, projectRoot, folder, fileName, stagedPath, sourcePath, sourceFingerprint, parameters, resultSummary }) => {
    const current = contentFileFingerprint(sourcePath);
    if (current.sha256 !== sourceFingerprint.sha256) { const error = new Error('The original file changed while this Data Work was open. Review it before saving.'); error.code = 'ATLAS_STATE_CONFLICT'; throw error; }
    const stage = contentFileFingerprint(stagedPath);
    const target = destination(projectRoot, folder, fileName, sourcePath);
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.atlas-${crypto.randomUUID()}.tmp`);
    try {
      fs.copyFileSync(stage.file_path, temporary, fs.constants.COPYFILE_EXCL);
      const copied = contentFileFingerprint(temporary);
      if (copied.sha256 !== stage.sha256 || copied.bytes !== stage.bytes) throw new Error('Atlas could not verify the staged result before saving.');
      if (fs.existsSync(target)) { const error = new Error('File already exists. Choose a different name.'); error.code = 'ATLAS_STATE_CONFLICT'; throw error; }
      fs.renameSync(temporary, target);
      const result = contentFileFingerprint(target);
      if (result.sha256 !== stage.sha256 || result.bytes !== stage.bytes) throw new Error('Atlas could not verify the saved result.');
      const record = { work_id: `SWR-${crypto.randomUUID()}`, project: { id: project.id, name: project.name }, result_path: result.file_path, result_fingerprint: result, source_path: current.file_path, source_fingerprint: sourceFingerprint, operation_type: 'data_transform', parameters, result_summary: resultSummary, created_at: new Date().toISOString(), write: { target_path: result.file_path, verified_at: new Date().toISOString(), undo_available: true }, status: 'active' };
      try {
        const items = writable(stateDir); writeStateFn(stateDir, [record, ...items]); return record;
      } catch (error) {
        let rollbackError = null;
        try {
          const currentTarget = contentFileFingerprint(target);
          if (currentTarget.sha256 !== result.sha256) throw new Error('The newly saved file changed before Atlas could remove it.');
          fs.rmSync(target, { force: false });
        } catch (caught) {
          rollbackError = caught;
        }
        if (!rollbackError) throw error;
        {
          try {
            writeRecoveryState(stateDir, {
              operation: 'save', status: 'partial', result_path: target,
              error: error.message, rollback_error: rollbackError.message,
              recorded_at: new Date().toISOString(),
            });
          } catch { /* The explicit error below still reports the partial state. */ }
          const partial = new Error(`Partial save: the result file was created, but Created Work could not be updated and Atlas could not remove the file. ${rollbackError.message}`);
          partial.code = 'ATLAS_PARTIAL_STATE'; partial.cause = error; throw partial;
        }
      }
    } finally { fs.rmSync(temporary, { force: true }); }
  };
  const undo = (workId) => {
    const items = writable(stateDir); const index = items.findIndex((item) => item.work_id === workId && item.status === 'active');
    if (index < 0) throw new Error('This saved result is no longer available for Undo.');
    const record = items[index];
    const current = contentFileFingerprint(record.result_path);
    if (current.sha256 !== record.result_fingerprint?.sha256) throw new Error('The saved result changed after Atlas created it, so Atlas will not remove it.');
    const backup = path.join(path.dirname(record.result_path), `.${path.basename(record.result_path)}.atlas-undo-${crypto.randomUUID()}.tmp`);
    let keepBackup = false;
    try {
      fs.copyFileSync(record.result_path, backup, fs.constants.COPYFILE_EXCL);
      if (contentFileFingerprint(backup).sha256 !== current.sha256) throw new Error('Atlas could not prepare a verified Undo recovery copy.');
      fs.rmSync(record.result_path, { force: false });
      if (fs.existsSync(record.result_path)) throw new Error('Atlas could not verify removal of the saved result.');
      const undone = { ...record, status: 'undone', write: { ...record.write, undo_available: false, undone_at: new Date().toISOString() } };
      items[index] = undone;
      try {
        writeStateFn(stateDir, items);
        return undone;
      } catch (error) {
        try {
          if (fs.existsSync(record.result_path)) throw new Error('The result path is no longer free for recovery.');
          fs.renameSync(backup, record.result_path);
          if (contentFileFingerprint(record.result_path).sha256 !== current.sha256) throw new Error('Atlas could not verify the restored result.');
          const stopped = new Error(`Undo was not completed because Created Work could not be updated. The result file was restored. ${error.message}`);
          stopped.code = 'ATLAS_STATE_CONFLICT'; stopped.cause = error; throw stopped;
        } catch (restoreError) {
          if (restoreError.code === 'ATLAS_STATE_CONFLICT') throw restoreError;
          keepBackup = fs.existsSync(backup);
          try {
            writeRecoveryState(stateDir, {
              operation: 'undo', status: 'partial', work_id: record.work_id,
              result_path: record.result_path, recovery_copy: keepBackup ? backup : null,
              error: error.message, rollback_error: restoreError.message,
              recorded_at: new Date().toISOString(),
            });
          } catch { /* The explicit error below still reports the partial state. */ }
          const partial = new Error(`Partial Undo: the result file was removed, Created Work could not be updated, and Atlas could not restore the file. ${restoreError.message}`);
          partial.code = 'ATLAS_PARTIAL_STATE'; partial.cause = error; throw partial;
        }
      }
    } finally {
      if (!keepBackup) fs.rmSync(backup, { force: true });
    }
  };
  return { stateForProject, listForProject, find, prepareDestination, save, undo };
}
