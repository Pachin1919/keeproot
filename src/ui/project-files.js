import fs from 'node:fs';
import path from 'node:path';

const MAX_DIRECTORY_ITEMS = 500;
const MAX_SEARCH_ENTRIES = 5000;
const MAX_SEARCH_RESULTS = 150;
const MAX_FOLDER_CHOICES = 500;
const TECHNICAL_DIRECTORIES = new Set([
  '.atlas', '.cache', '.git', '.npm-cache', '.pytest_cache', '.venv',
  '__pycache__', 'node_modules', 'venv',
]);

function technicalDirectory(name) {
  return TECHNICAL_DIRECTORIES.has(String(name).toLowerCase());
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function regularDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project folder is unavailable or linked outside its boundary.');
}

export function projectDirectory(location) {
  if (!location?.root_path || location.relative_path == null) throw new Error('Project has no local directory.');
  const root = path.resolve(location.root_path, location.relative_path);
  regularDirectory(root);
  return root;
}

export function projectPath(root, relativePath = '') {
  const value = String(relativePath).replaceAll('/', path.sep);
  if (value.includes('\0')) throw new Error('Project path is invalid.');
  const target = path.resolve(root, value || '.');
  if (!inside(root, target)) throw new Error('Project path is outside this Project.');
  let cursor = root;
  regularDirectory(cursor);
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('Atlas does not follow linked paths in a Project.');
  }
  return target;
}

function entry(root, absolute, dirent) {
  const relative_path = path.relative(root, absolute).replaceAll('\\', '/');
  if (dirent.isSymbolicLink()) return { name: dirent.name, relative_path, kind: 'link', enterable: false };
  const stat = fs.lstatSync(absolute);
  if (stat.isDirectory()) return { name: dirent.name, relative_path, kind: 'folder', enterable: true };
  if (!stat.isFile()) return { name: dirent.name, relative_path, kind: 'other', enterable: false };
  return { name: dirent.name, relative_path, kind: 'file', extension: path.extname(dirent.name).toLowerCase(), bytes: stat.size, modified_at: stat.mtime.toISOString(), enterable: false };
}

export function browseProjectFiles(root, relativePath = '') {
  const directory = projectPath(root, relativePath);
  const visible = fs.readdirSync(directory, { withFileTypes: true })
    .filter((item) => !(item.isDirectory() && technicalDirectory(item.name)));
  const items = visible.slice(0, MAX_DIRECTORY_ITEMS)
    .map((item) => entry(root, path.join(directory, item.name), item))
    .sort((a, b) => (a.kind === 'folder' ? -1 : 1) - (b.kind === 'folder' ? -1 : 1) || a.name.localeCompare(b.name));
  return { directory: path.relative(root, directory).replaceAll('\\', '/'), items, truncated: visible.length > MAX_DIRECTORY_ITEMS };
}

export function listProjectFolders(root) {
  regularDirectory(root);
  const items = [];
  const stack = [root];
  let scanned = 0;
  while (stack.length && scanned < MAX_SEARCH_ENTRIES && items.length < MAX_FOLDER_CHOICES) {
    const directory = stack.pop();
    regularDirectory(directory);
    const folders = fs.readdirSync(directory, { withFileTypes: true })
      .filter((item) => item.isDirectory() && !item.isSymbolicLink() && !technicalDirectory(item.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const children = [];
    for (const dirent of folders) {
      if (++scanned > MAX_SEARCH_ENTRIES || items.length >= MAX_FOLDER_CHOICES) break;
      const absolute = path.join(directory, dirent.name);
      const value = entry(root, absolute, dirent);
      items.push({
        name: value.name,
        relative_path: value.relative_path,
        depth: value.relative_path.split('/').length,
      });
      children.push(absolute);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  items.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return { items, truncated: scanned >= MAX_SEARCH_ENTRIES || items.length >= MAX_FOLDER_CHOICES };
}

export function searchProjectFiles(root, query, { acceptFile = null } = {}) {
  const term = String(query ?? '').trim().toLowerCase();
  const queue = [root]; const items = []; let scanned = 0;
  while (queue.length && scanned < MAX_SEARCH_ENTRIES && items.length < MAX_SEARCH_RESULTS) {
    const directory = queue.shift(); regularDirectory(directory);
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      if (dirent.isDirectory() && technicalDirectory(dirent.name)) continue;
      if (++scanned > MAX_SEARCH_ENTRIES || items.length >= MAX_SEARCH_RESULTS) break;
      const absolute = path.join(directory, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      const value = entry(root, absolute, dirent);
      if (value.kind === 'folder') queue.push(absolute);
      if (value.kind === 'file'
          && (!term || `${value.name}\n${value.relative_path}\n${value.extension}`.toLowerCase().includes(term))
          && (!acceptFile || acceptFile(value))) items.push(value);
    }
  }
  return { items, truncated: scanned >= MAX_SEARCH_ENTRIES || items.length >= MAX_SEARCH_RESULTS };
}
