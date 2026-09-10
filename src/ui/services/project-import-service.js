import fs from 'node:fs';
import path from 'node:path';
import {
  contentFileFingerprint, rebindCachedContentInspection,
} from '../../content-inspection.js';
import { listProjectFolders, projectDirectory } from '../project-files.js';
import {
  moveRecentWorkToProjectArtifact, recentWorkById, restoreRecentWorkProjectTransfer,
} from '../recent-work.js';
import { cacheReference } from './file-work-service.js';

function pathContains(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function saveProjectImport({ stateDir, intake, imported }) {
  const receipt = intake.execute(imported.run_id, { reason: 'User saved this local file from Atlas Desktop.' });
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
        undo_available: receipt.rollback_ready === true,
        origin: {
          file_path: beforeTransfer.file_path,
          source_fingerprint: beforeTransfer.source_fingerprint,
          inspection_id: beforeTransfer.inspection_id,
          cache_reference: beforeTransfer.cache_reference,
          project: beforeTransfer.project,
        },
      },
    });
    if (!work) throw new Error('Atlas saved the Project file, but the Recent Work item is no longer available.');
    return work;
  } catch (error) {
    try {
      const rollback = intake.rollback(imported.run_id);
      if (rollback?.status !== 'rolled_back') throw new Error('Atlas could not verify the automatic rollback.');
    } catch (rollbackError) {
      const partial = new Error(`Atlas saved a Project file but could not complete its local record. Automatic rollback failed, so the Project file may still exist. Original error: ${error.message}. Rollback error: ${rollbackError.message}`);
      partial.code = 'ATLAS_PARTIAL_STATE';
      partial.cause = error;
      throw partial;
    }
    throw error;
  }
}

export function createProjectImportService({ stateDir, registry, intake, runSaveOperation = null }) {
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

  function destinationForFolder(projectId, folderInput, sourcePath, targetFileName = null) {
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
    if (fs.existsSync(targetPath)) {
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

  function prepare({ work, projectId, folder = null, targetFileName = null }) {
    if (!work) throw new Error('This Recent Work item is no longer available.');
    if (work.project?.id || projectForFile(work.file_path)?.id) {
      throw new Error('This file already belongs to a registered Project and will not be imported again.');
    }
    if (!intake) throw new Error('The existing Atlas file intake service is not available.');
    const target = destinationForFolder(projectId, folder, work.file_path, targetFileName);
    const prepared = intake.prepare({
      root: target.location.root_path,
      candidateFile: work.file_path,
      origin: 'human_submitted',
      kind: 'source',
      projectId: target.project.id,
      target: target.target,
      intent: 'Add one inspected local file to the selected Project.',
      caller: { actor: 'user', tool: 'atlas-ui' },
    });
    if (prepared.status !== 'prepared' || !prepared.run_id) {
      throw new Error(prepared.reason ?? 'Atlas could not prepare this destination.');
    }
    return {
      created_at: Date.now(),
      run_id: prepared.run_id,
      work_id: work.work_id,
      project: target.project,
      target_path: target.target_path,
      executed: false,
      prepared,
    };
  }

  function save(imported) {
    return saveProjectImport({ stateDir, intake, imported });
  }

  async function saveAsync(imported) {
    if (runSaveOperation) return runSaveOperation(imported);
    return save(imported);
  }

  function undo(work) {
    const transfer = work?.project_transfer;
    if (!transfer?.undo_available) throw new Error('Undo is not available for this saved file.');
    intake.rollback(transfer.run_id);
    const restored = restoreRecentWorkProjectTransfer({
      stateDir,
      workId: work.work_id,
      project: projectForFile(transfer.origin.file_path),
    });
    if (!restored) throw new Error('Atlas rolled back the Project file, but could not restore Recent Work.');
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
  };
}
