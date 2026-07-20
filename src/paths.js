import fs from 'node:fs';
import path from 'node:path';

export function toPortablePath(value) {
  return value.split(path.sep).join('/');
}
export function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function normalizeRoot(rootInput) {
  if (!rootInput) {
    throw new Error('begin requires --root <path>');
  }

  const absolute = path.resolve(rootInput);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Target root does not exist: ${absolute}`);
  }

  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Target root must be a real directory: ${absolute}`);
  }

  return fs.realpathSync.native(absolute);
}

export function normalizeStateDir(projectRootInput, stateDirInput) {
  const projectRoot = fs.realpathSync.native(path.resolve(projectRootInput));
  const absolute = path.resolve(stateDirInput);
  if (!isPathInside(projectRoot, absolute)) {
    throw new Error(`Atlas state directory must remain inside the Atlas project: ${absolute}`);
  }

  let nearestExisting = absolute;
  while (!fs.existsSync(nearestExisting)) {
    const parent = path.dirname(nearestExisting);
    if (parent === nearestExisting) {
      throw new Error(`Cannot resolve an existing parent for Atlas state directory: ${absolute}`);
    }
    nearestExisting = parent;
  }

  let cursor = nearestExisting;
  while (isPathInside(projectRoot, cursor)) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Atlas state directory cannot pass through a symbolic link or junction: ${cursor}`);
    }
    if (cursor === projectRoot) break;
    cursor = path.dirname(cursor);
  }

  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Atlas state directory must be a real directory: ${absolute}`);
    }
  }

  const realParent = fs.realpathSync.native(nearestExisting);
  const physicalCandidate = path.resolve(realParent, path.relative(nearestExisting, absolute));
  if (!isPathInside(projectRoot, physicalCandidate)) {
    throw new Error(`Atlas state directory resolves outside the Atlas project: ${absolute}`);
  }
  return absolute;
}

export function normalizeScopes(root, allowInputs) {
  if (!allowInputs || allowInputs.length === 0) {
    throw new Error('begin requires at least one --allow <path>');
  }

  const scopes = [];
  for (const input of allowInputs) {
    const lexical = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
    if (!isPathInside(root, lexical)) {
      throw new Error(`Allowed path escapes target root: ${input}`);
    }
    if (!fs.existsSync(lexical)) {
      throw new Error(`Allowed path must exist at begin: ${lexical}`);
    }

    const stat = fs.lstatSync(lexical);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported as allowed paths: ${lexical}`);
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Allowed path must be a regular file or directory: ${lexical}`);
    }

    const real = fs.realpathSync.native(lexical);
    if (!isPathInside(root, real)) {
      throw new Error(`Allowed path resolves outside target root: ${input}`);
    }

    const relative = toPortablePath(path.relative(root, real));
    scopes.push({
      path: relative,
      kind: stat.isDirectory() ? 'directory' : 'file',
    });
  }

  const unique = new Map(scopes.map((scope) => [`${scope.kind}:${scope.path}`, scope]));
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function isAllowedPath(relativePath, scopes) {
  return scopes.some((scope) => {
    if (scope.kind === 'file') {
      return relativePath === scope.path;
    }
    return scope.path === '' || relativePath === scope.path || relativePath.startsWith(`${scope.path}/`);
  });
}

export function absoluteFromRelative(root, relativePath) {
  const candidate = path.resolve(root, ...relativePath.split('/'));
  if (!isPathInside(root, candidate)) {
    throw new Error(`Stored path escapes target root: ${relativePath}`);
  }
  return candidate;
}
