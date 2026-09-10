import fs from 'node:fs';
import path from 'node:path';
import { projectDirectory } from '../project-files.js';
import { realLocalFolder } from './desktop-selection-service.js';

function localPathEquals(left, right) {
  return path.resolve(left).localeCompare(path.resolve(right), undefined, { sensitivity: 'accent' }) === 0;
}

function pathContains(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function projectFolderName(value) {
  const name = String(value ?? '').trim().normalize('NFC');
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001F]/u.test(name)) {
    throw new Error('Project name must be a valid local folder name.');
  }
  return name;
}

export function createProjectOnboardingService({ registry }) {
  function relinkFolder(projectId, folderPath) {
    const folder = realLocalFolder(folderPath);
    const project = registry.show(projectId);
    if (!project?.location) throw new Error('This Project has no recorded location to recover.');
    const previous = path.resolve(project.location.root_path, project.location.relative_path ?? '');
    if (fs.existsSync(previous)) {
      projectDirectory(project.location);
      throw new Error('The recorded Project folder is still available.');
    }
    const roots = registry.listRoots().filter((root) => pathContains(root.current_path, folder))
      .sort((left, right) => right.current_path.length - left.current_path.length);
    const root = roots.find((item) => !localPathEquals(item.current_path, folder));
    if (!root) throw new Error('Choose the moved Project folder inside an existing Atlas Workspace Root.');
    const relativePath = path.relative(root.current_path, folder).replaceAll('\\', '/');
    const receipt = registry.relocate(projectId, {
      rootId: root.id,
      relativePath,
      reason: 'User relinked a missing Project folder in Atlas Desktop.',
    });
    if (receipt.status !== 'relocated') {
      const error = new Error(receipt.reason_code === 'identity_baseline_unavailable'
        ? 'Atlas has no identity record for this older Project, so it cannot verify the selected folder.'
        : 'The selected folder does not match the recorded Project. No Project location was changed.');
      error.code = 'ATLAS_PROJECT_RELINK_REJECTED';
      throw error;
    }
    return { project: registry.list().find((item) => item.id === projectId), folder, receipt };
  }
  function registerFolder(folderPath, name) {
    const folder = realLocalFolder(folderPath);
    for (const project of registry.list().filter((item) => item.status === 'active')) {
      const location = registry.show(project.id).location;
      if (location?.root_path && localPathEquals(projectDirectory(location), folder)) {
        throw new Error('This folder is already managed as an Atlas Project.');
      }
    }
    const roots = registry.listRoots().filter((root) => pathContains(root.current_path, folder))
      .sort((left, right) => right.current_path.length - left.current_path.length);
    let rootId;
    let relativePath;
    if (roots.length && !localPathEquals(roots[0].current_path, folder)) {
      rootId = roots[0].id;
      relativePath = path.relative(roots[0].current_path, folder).replaceAll('\\', '/');
    } else {
      const parent = realLocalFolder(path.dirname(folder));
      const adopted = registry.adoptRoot({ rootPath: parent, rootType: 'workspace_container', contentPolicy: 'structure_only' });
      rootId = adopted.root_id;
      relativePath = path.basename(folder);
    }
    const created = registry.create({ name: projectFolderName(name), currentPath: relativePath });
    try {
      registry.attachRoot(created.project_id, {
        rootId,
        relativePath,
        reason: 'User registered this local folder in Atlas Desktop.',
      });
    } catch (error) {
      registry.evolve(created.project_id, { status: 'archived', reason: 'Project registration could not attach the selected local folder.' });
      throw error;
    }
    return { project: registry.list().find((item) => item.id === created.project_id), folder };
  }

  function previewNewProject(parentPath, rawName) {
    const parent = realLocalFolder(parentPath);
    const name = projectFolderName(rawName);
    const target = path.resolve(parent, name);
    if (!pathContains(parent, target) || localPathEquals(parent, target)) {
      throw new Error('Project folder must remain inside the selected parent folder.');
    }
    return { parent, name, target, target_exists: fs.existsSync(target) };
  }

  function createOrUseProject({ parentPath, name: rawName, create }) {
    const preview = previewNewProject(parentPath, rawName);
    let createdTarget = false;
    if (create) {
      if (preview.target_exists) throw new Error('Folder already exists. Choose Use existing folder instead.');
      fs.mkdirSync(preview.target);
      createdTarget = true;
    } else if (!preview.target_exists) {
      throw new Error('That folder no longer exists. Create the Project again.');
    }
    try {
      return registerFolder(preview.target, preview.name);
    } catch (error) {
      if (createdTarget) {
        try {
          const stat = fs.lstatSync(preview.target);
          if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(preview.target).length === 0) {
            fs.rmdirSync(preview.target);
          }
        } catch {}
      }
      throw error;
    }
  }

  return { registerFolder, previewNewProject, createOrUseProject, relinkFolder };
}
