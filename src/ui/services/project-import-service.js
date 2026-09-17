import fs from 'node:fs';
import path from 'node:path';
import {
  contentFileFingerprint, rebindCachedContentInspection,
} from '../../content-inspection.js';
import { listProjectFolders, projectDirectory } from '../project-files.js';
import {
  moveRecentWorkToProjectArtifact, recentWorkById, restoreRecentWorkProjectTransfer, redoRecentWorkProjectTransfer,
} from '../recent-work.js';
import { cacheReference } from './file-work-service.js';
import { createSaveService } from '../../save-service.js';
import { readSavedWorkState } from './saved-work-service.js';

function pathContains(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function saveProjectImport({ stateDir, saveService, imported }) {
  const receipt = saveService.execute(imported.save_id, { reason: 'User saved this local file from Atlas Desktop.' });
  if (receipt.verified !== true) throw new Error('Atlas did not verify the saved Project file.');
  try {
    const beforeTransfer = recentWorkById(stateDir, imported.work_id);
    if (!beforeTransfer) throw new Error('Atlas saved the Project file, but the Recent Work item is no longer available.');
    const rebound = rebindCachedContentInspection({
      stateDir,
      sourceFilePath: beforeTransfer.file_path,
      sourceCacheReference: beforeTransfer.cache_reference,
      targetFilePath: imported.target_path,
      purpose: beforeTransfer.inspect.purpose,
      sheet: beforeTransfer.inspect.sheet,
      maxCharacters: beforeTransfer.inspect.max_characters,
    });
    const targetFingerprint = contentFileFingerprint(imported.target_path);
    const work = moveRecentWorkToProjectArtifact({
      stateDir,
      workId: imported.work_id,
      targetPath: imported.target_path,
      sourceFingerprint: targetFingerprint,
      inspectionId: rebound.inspection_id,
      cacheReference: cacheReference(stateDir, rebound.cache_path),
      project: imported.project,
      transfer: {
        run_id: imported.run_id,
        target_path: imported.target_path,
        saved_at: new Date().toISOString(),
        undo_available: receipt.undo_available === true,
        redo_available: false,
        status: 'executed',
        project: imported.project,
        origin: {
          resource_id: beforeTransfer.resource_id ?? receipt.resource_id ?? null,
          file_path: beforeTransfer.file_path,
          source_fingerprint: beforeTransfer.source_fingerprint,
          inspection_id: beforeTransfer.inspection_id,
          cache_reference: beforeTransfer.cache_reference,
          project: beforeTransfer.project,
        },
      },
      resourceId: receipt.resource_id ?? beforeTransfer.resource_id ?? null,
    });
    if (!work) throw new Error('Atlas saved the Project file, but the Recent Work item is no longer available.');
    return work;
  } catch (error) {
    const partial = new Error(`Atlas saved and verified the Project file, but its Recent Work projection could not be completed. Retry this import to finish the projection. ${error.message}`);
    partial.code = 'ATLAS_PROJECTION_PENDING';
    partial.cause = error;
    throw partial;
  }
}

export function createProjectImportService({ stateDir, registry, intake = null, saveService, runSaveOperation = null }) {
  const saves = saveService ?? (intake ? createSaveService({ stateDir, intake }) : null);
  function activeProjects() {
    return registry.list().filter((project) => project.status === 'active')
      .map((project) => ({ id: project.id, name: project.name }));
  }

  function projectForFile(filePath) {
    try {
      const resolution = registry.resolvePath(path.dirname(filePath));
      return resolution.project ? { id: resolution.project.id, name: resolution.project.name } : null;
    } catch {
      return null;
    }
  }

  function activeProject(projectId) {
    const project = activeProjects().find((item) => item.id === projectId);
    if (!project) throw new Error('Choose an active Project.');
    const location = registry.show(project.id).location;
    if (!location?.root_path || location.relative_path == null) {
      throw new Error('The selected Project does not have an available local destination.');
    }
    return { project, location, root: projectDirectory(location) };
  }

  function projectChoices() {
    return activeProjects().map((project) => {
      try {
        const value = activeProject(project.id);
        const folders = listProjectFolders(value.root);
        return { ...project, available: true, folders: folders.items, folders_truncated: folders.truncated };
      } catch {
        return { ...project, available: false, folders: [], folders_truncated: false };
      }
    });
  }

  function destinationFileName(sourcePath, targetFileName) {
    if (targetFileName == null) return path.basename(sourcePath);
    const name = String(targetFileName).trim();
    if (!name || name === '.' || name === '..'
      || name.includes('/') || name.includes('\\')
      || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)
      || path.basename(name) !== name) {
      throw new Error('Choose a file name without a path.');
    }
    return name;
  }

  function destinationForFolder(projectId, folderInput, sourcePath, targetFileName = null, checkExists = true) {
    const value = activeProject(projectId);
    const folder = String(folderInput ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
    if (!folder) throw new Error('Choose an existing destination folder inside the selected Project.');
    if (path.posix.isAbsolute(folder) || path.win32.isAbsolute(folder) || folder === '..' || folder.startsWith('../')) {
      throw new Error('Destination folder must remain inside the selected Project.');
    }
    const folderPath = path.resolve(value.root, ...folder.split('/').filter(Boolean));
    if (!pathContains(value.root, folderPath)) throw new Error('Destination folder must remain inside the selected Project.');
    if (!fs.existsSync(folderPath)) throw new Error('Choose an existing destination folder inside the selected Project.');
    const relativeFolder = path.relative(value.root, folderPath);
    let cursor = value.root;
    for (const segment of (relativeFolder ? relativeFolder.split(path.sep) : [])) {
      cursor = path.join(cursor, segment);
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Destination folder must be a real folder inside the selected Project.');
    }
    const targetPath = path.join(folderPath, destinationFileName(sourcePath, targetFileName));
    if (checkExists && fs.existsSync(targetPath)) {
      const error = new Error('A file with this name already exists in the selected destination folder.');
      error.code = 'ATLAS_IMPORT_TARGET_EXISTS';
      error.target = { project: value.project, target_path: targetPath, target: path.relative(value.location.root_path, targetPath).replaceAll('\\', '/') };
      throw error;
    }
    return {
      ...value,
      target_path: targetPath,
      target: path.relative(value.location.root_path, targetPath).replaceAll('\\', '/'),
    };
  }

  function prepare({ work, projectId, folder = null, targetFileName = null, attemptKey = null }) {
    if (!work) throw new Error('This Recent Work item is no longer available.');
    const pending = !work.project_transfer
      ? readSavedWorkState(stateDir).items.find((item) => item.channel === 'import' && item.status === 'executed'
        && item.source?.work_id === work.work_id && item.project?.id === projectId)
      : null;
    if (pending) {
      const target = destinationForFolder(projectId, folder, work.file_path, targetFileName, false);
      if (path.resolve(target.target_path) !== path.resolve(pending.target.path)) {
        throw new Error('This saved import is waiting for its original Recent Work projection. Choose the same destination to retry it.');
      }
      return {
        created_at: Date.parse(pending.created_at), run_id: pending.run_id, save_id: pending.save_id,
        work_id: work.work_id, project: pending.project, target_path: pending.target.path,
        executed: false, prepared: { ...pending, schema: 'atlas.save-result.v1' },
      };
    }
    if (work.project_transfer || work.project?.id || projectForFile(work.file_path)?.id) {
      throw new Error('This file already belongs to a registered Project and will not be imported again.');
    }
    if (!saves) throw new Error('The Atlas Save Service is unavailable.');
    const target = destinationForFolder(projectId, folder, work.file_path, targetFileName);
    const prepared = saves.prepare({
      root: target.location.root_path, candidateFile: work.file_path, origin: 'human_submitted', kind: 'source',
      projectId: target.project.id, target: target.target, intent: 'Add one inspected local file to the selected Project.',
      channel: 'import', requestKey: attemptKey ?? work.work_id,
      caller: { actor: 'user', tool: 'atlas-ui', client_run_id: attemptKey ?? work.work_id },
      source: {
        ...(work.resource_id ? { resource_id: work.resource_id } : {}),
        path: work.file_path,
        fingerprint: work.source_fingerprint,
        work_id: work.work_id,
        inspection_id: work.inspection_id,
        cache_reference: work.cache_reference,
        inspect: work.inspect,
        project: work.project ?? null,
      },
    });
    if (prepared.status !== 'prepared' || !prepared.run_id) {
      throw new Error(prepared.reason ?? 'Atlas could not prepare this destination.');
    }
    return {
      created_at: Date.now(),
      run_id: prepared.run_id,
      save_id: prepared.save_id,
      work_id: work.work_id,
      project: target.project,
      target_path: target.target_path,
      executed: false,
      prepared,
    };
  }

  function save(imported) {
    return saveProjectImport({ stateDir, saveService: saves, imported });
  }

  async function saveAsync(imported) {
    if (runSaveOperation) return runSaveOperation(imported);
    return save(imported);
  }

  function undo(work) {
    const transfer = work?.project_transfer;
    if (!transfer?.undo_available) throw new Error('Undo is not available for this saved file.');
    saves.undo(transfer.run_id);
    const restored = restoreRecentWorkProjectTransfer({
      stateDir,
      workId: work.work_id,
      project: projectForFile(transfer.origin.file_path),
    });
    if (!restored) throw new Error('Atlas rolled back the Project file, but could not restore Recent Work.');
    return restored;
  }

  function redo(work) {
    const transfer = work?.project_transfer;
    if (!transfer?.redo_available) throw new Error('Redo is not available for this saved file.');
    saves.redo(transfer.run_id);
    const restored = redoRecentWorkProjectTransfer({ stateDir, workId: work.work_id });
    if (!restored) throw new Error('Atlas redid the Project file, but could not restore Recent Work.');
    return restored;
  }

  return {
    activeProjects,
    projectChoices,
    projectForFile,
    destinationForFolder,
    prepare,
    save,
    saveAsync,
    undo,
    redo,
  };
}
