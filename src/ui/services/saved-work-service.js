import fs from 'node:fs';
import path from 'node:path';
import { contentFileFingerprint } from '../../content-inspection.js';
import { projectPath } from '../project-files.js';

export function savedResultState(result) {
  if (result.status === 'undone') return 'undone';
  try {
    const current = contentFileFingerprint(result.result_path);
    const expected = result.result_fingerprint?.sha256 ?? result.verification?.sha256;
    return !expected ? 'unknown' : current.sha256 === expected ? 'verified' : 'changed';
  } catch (error) {
    return error.code === 'ATLAS_CONTENT_INPUT_MISSING' ? 'missing_source' : 'unknown';
  }
}

function statePath(stateDir) { return path.join(path.resolve(stateDir), 'ui', 'saved-work.json'); }
function validRecord(value) {
  if (!value) return null;
  // V1.7 Save Service owns current writes.  Historical SWR rows remain readable.
  if (typeof value.save_id === 'string' && value.target) {
    const fingerprint = value.verification?.sha256 ? {
      file_path: value.target.path, sha256: value.verification.sha256,
      bytes: value.candidate?.bytes ?? null,
    } : null;
    return {
      ...value,
      work_id: value.save_id,
      result_path: value.target.path ?? null,
      result_fingerprint: fingerprint,
      source_path: value.source?.path ?? value.candidate?.path ?? value.target.path ?? null,
      source_fingerprint: value.source?.fingerprint ?? value.candidate ?? null,
      sources: value.source?.sources ?? (value.source ? [value.source] : []),
      recipe: value.source?.recipe ?? value.parameters?.recipe ?? null,
      created_at: value.executed_at ?? value.created_at,
      parameters: value.parameters ?? {}, result_summary: value.result_summary ?? {},
      write: { target_path: value.target.path ?? null, verified_at: value.verification?.verified_at ?? null, undo_available: value.undo_available === true, redo_available: value.redo_available === true },
    };
  }
  if (!/^SWR-[a-f0-9-]{36}$/u.test(value.work_id ?? '') || typeof value.result_path !== 'string' || typeof value.source_path !== 'string') return null;
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
function regularDirectory(directory) { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Destination folder is unavailable or linked outside this Project.'); }
function destination(projectRoot, folder, fileName, sourcePath = null, checkExists = true, outputExtension = null) {
  const selectedFolder = String(folder ?? '').trim();
  if (!selectedFolder || selectedFolder === '.') throw new Error('Choose an existing destination folder in this Project.');
  let cleanName = String(fileName ?? '').trim();
  if (!cleanName || cleanName !== path.basename(cleanName) || cleanName.includes('\0')) throw new Error('Enter one file name.');
  const expectedExtension = String(outputExtension ?? path.extname(sourcePath ?? '')).toLowerCase();
  if (['.csv', '.xlsx'].includes(expectedExtension)) {
    const enteredExtension = path.extname(cleanName).toLowerCase();
    if (!enteredExtension) cleanName += expectedExtension;
    else if (enteredExtension !== expectedExtension) {
      const format = expectedExtension.slice(1).toUpperCase();
      throw new Error(`This Data Work produces a ${format} result. Use a file name ending in ${expectedExtension}.`);
    }
  }
  const folderPath = projectPath(projectRoot, selectedFolder); regularDirectory(folderPath);
  if (path.resolve(folderPath) === path.resolve(projectRoot)) throw new Error('Choose an existing destination folder in this Project.');
  const target = path.resolve(folderPath, cleanName);
  const relative = path.relative(path.resolve(projectRoot), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Destination is outside this Project.');
  if (checkExists && fs.existsSync(target)) { const error = new Error('File already exists. Choose a different name.'); error.code = 'ATLAS_STATE_CONFLICT'; throw error; }
  return target;
}

export function createSavedWorkService({ stateDir, saveService = null }) {
  const stateForProject = (projectId) => {
    const state = readSavedWorkState(stateDir);
    return {
      items: state.items.filter((item) => (['active', 'executed'].includes(item.status) || (item.status === 'undone' && item.write?.redo_available === true)) && item.project?.id === projectId),
      error: state.error,
    };
  };
  const listForProject = (projectId) => {
    const state = stateForProject(projectId);
    if (state.error) throw state.error;
    return state.items;
  };
  const find = (workId) => readSavedWorkState(stateDir).items.find((item) => item.work_id === workId || item.save_id === workId) ?? null;
  const activityItems = () => readSavedWorkState(stateDir).items.filter((item) => item.save_id && item.status === 'executed').map((item) => ({
    activity_id: item.save_id, work_id: item.save_id, save_id: item.save_id, file_path: item.result_path,
    project: item.project, initiated_by: { channel: item.channel === 'host' ? 'host' : 'desktop', agent: item.caller?.tool ?? null }, caller: item.caller ?? null,
    channel: item.channel ?? 'work', status: 'completed', updated_at: item.executed_at ?? item.created_at,
    inspected_at: item.executed_at ?? item.created_at, executed_at: item.executed_at ?? item.created_at,
    result_summary: item.result_summary ?? {}, verification: item.verification ?? null,
    resource_href: item.resources_href, resources_href: item.resources_href,
    resource_id: item.resource_id ?? null,
  }));
  const prepareDestination = ({ projectRoot, folder, fileName, sourcePath, outputExtension = null }) => destination(projectRoot, folder, fileName, sourcePath, true, outputExtension);
  const save = ({ project, projectRoot, root = projectRoot, target: targetInput = null, folder, fileName, stagedPath, expectedCandidateHash = null, sourcePath, sourceFingerprint, sourceResourceId = null, sources = null, recipe = null, outputExtension = null, parameters, resultSummary, requestKey = null, caller = {}, channel = 'work', executionReason = 'User confirmed this Data Work result.' }) => {
    if (!saveService) throw new Error('The Atlas Save Service is unavailable for current saves.');
    const requestedSources = Array.isArray(sources) && sources.length ? sources : [{ path: sourcePath, fingerprint: sourceFingerprint, ...(sourceResourceId ? { resource_id: sourceResourceId } : {}) }];
    const currentSources = requestedSources.map((item) => {
      const current = contentFileFingerprint(item.path);
      if (current.sha256 !== item.fingerprint?.sha256) { const error = new Error(`Source changed before Save: ${path.basename(item.path)}.`); error.code = 'ATLAS_STATE_CONFLICT'; throw error; }
      return { ...item, path: current.file_path, fingerprint: current };
    });
    const current = currentSources[0].fingerprint;
    const resolvedTarget = destination(projectRoot, folder, fileName, sourcePath, false, outputExtension);
    const targetPath = path.relative(root, resolvedTarget).replaceAll('\\', '/');
    if (targetInput && String(targetInput).replaceAll('\\', '/') !== targetPath) throw new Error('Destination does not match the selected Project folder.');
    const prepared = saveService.prepare({ root, candidateFile: stagedPath, expectedCandidateHash, projectId: project.id, target: targetPath,
      inputs: currentSources.map((item) => item.path),
      origin: 'agent_generated', kind: 'intermediate', channel, requestKey: requestKey ?? `${Date.now()}`,
      caller, source: { path: current.file_path, fingerprint: current, resource_id: currentSources[0].resource_id ?? null, sources: currentSources, recipe }, parameters: { ...parameters, recipe }, resultSummary,
      intent: 'Save one reviewed Data Work result.' });
    const result = saveService.execute(prepared.save_id, { reason: executionReason });
    return validRecord(readSavedWorkState(stateDir).items.find((item) => item.save_id === result.save_id) ?? { ...result, source: { path: current.file_path, fingerprint: current, sources: currentSources, recipe }, parameters: { ...parameters, recipe }, result_summary: resultSummary });
  };
  const undo = (workId) => {
    if (!saveService) throw new Error('The Atlas Save Service is unavailable for current Undo.');
    return saveService.undo(workId);
  };
  const redo = (workId) => {
    if (!saveService) throw new Error('The Atlas Save Service is unavailable for current Redo.');
    return saveService.redo(workId);
  };
  return { stateForProject, listForProject, find, activityItems, prepareDestination, save, undo, redo };
}
