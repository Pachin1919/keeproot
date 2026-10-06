import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from './ledger.js';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';
import { sha256File } from './snapshots.js';
import { withStateLock } from './state-lock.js';
import { assertRecoveryWritable } from './storage/recovery-write-guard.js';
import { RollbackConflictError } from './tracker.js';

const OPERATIONS = new Set([
  'create_directory',
  'move_file',
  'migrate_project',
  'migrate_directory',
  'migrate_cross_root',
  'remove_empty_directory',
]);
const MAX_MANIFEST_ENTRIES = 100_000;
const PROJECT_MOVE_GUIDANCE = 'Legacy Evolution migrate_project is unsupported. Use project move prepare --request-file <request.json> for an active Project with an active registered location inside the same Root; review a fresh Project Move preview and confirm its exact revision and digest. Historical Evolution RUN records cannot use Project Move Undo; inspect their receipts and use targeted recovery.';
function refuseProjectMigration(operation) {
  if (operation === 'migrate_project') throw stateConflict(PROJECT_MOVE_GUIDANCE);
}
function refuseProjectPlan(detail) {
  if (detail.operations.some((item) => item.operation === 'migrate_project')) throw stateConflict(PROJECT_MOVE_GUIDANCE);
}
const MAX_PORTABLE_WINDOWS_PATH = 240;
const MAX_CONTROL_FILE_BYTES = 256 * 1024;
const MAX_REFERENCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_INSPECTION_REFERENCES = 200;
const CONTROL_FILE_NAMES = new Set([
  'agents.md', 'readme.md', 'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod',
  'requirements.txt', 'pnpm-workspace.yaml', 'workspace.json',
]);
const REFERENCE_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.config',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.ps1', '.cmd', '.bat', '.sh', '.py',
  '.cs', '.csproj', '.xml', '.html', '.css',
]);
const FUNCTIONAL_REFERENCE_EXTENSIONS = new Set([
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.config',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.ps1', '.cmd', '.bat', '.sh', '.py',
  '.cs', '.csproj',
]);
const GENERATED_INSPECTION_SEGMENTS = new Set([
  'obj', 'bin', 'node_modules', '.next', 'coverage', 'dist', 'build', 'builds', 'out',
]);
const GENERATED_CACHE_DIRECTORY_NAMES = new Map([
  ['.pnpm-store', 'pnpm_store'],
  ['node_modules', 'node_modules'],
  ['.next', 'next_build'],
  ['coverage', 'test_coverage'],
]);
const DIRECTORY_CLASSIFICATIONS = new Map([
  ['toolchains', 'tool_runtime'],
  ['cache', 'generated_cache'],
  ['.cache', 'generated_cache'],
  ['.pnpm-store', 'generated_cache'],
  ['scratch', 'temporary_work'],
  ['tmp', 'temporary_work'],
  ['temp', 'temporary_work'],
  ['tools', 'tool_source_collection'],
  ['ffmpeg', 'tool_runtime'],
]);

function timestamp() {
  return new Date().toISOString();
}

function makeRunId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `EVO-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function makePlanRunId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `ORG-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertPortableWindowsPath(root, absolute) {
  const relative = path.relative(root, absolute);
  if (relative !== relative.normalize('NFC')) {
    throw new Error(`Evolution path must use NFC Unicode normalization: ${relative}`);
  }
  if (absolute.length > MAX_PORTABLE_WINDOWS_PATH) {
    throw new Error(`Evolution path exceeds the V1 portable Windows path limit (${MAX_PORTABLE_WINDOWS_PATH} characters): ${relative}`);
  }
  for (const segment of relative.split(path.sep)) {
    if (!segment || /[<>:"|?*\u0000-\u001f]/u.test(segment)) {
      throw new Error(`Evolution path is not a portable Windows path: ${relative}`);
    }
    if (/[. ]$/u.test(segment)) {
      throw new Error(`Evolution path has a Windows-invalid trailing dot or space: ${relative}`);
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)) {
      throw new Error(`Evolution path uses a reserved Windows name: ${relative}`);
    }
  }
}

function assertNoLinkTraversal(root, absolute) {
  const relative = path.relative(root, absolute);
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Evolution path cannot traverse a symbolic link or junction: ${cursor}`);
    }
  }
}

function normalizeTarget(root, input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Evolution target is required.');
  const lexical = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isPathInside(root, lexical) || lexical === root) {
    throw new Error(`Evolution target escapes the root: ${input}`);
  }
  assertPortableWindowsPath(root, lexical);
  if (fs.existsSync(lexical)) throw new Error(`Evolution target is already claimed: ${lexical}`);
  const parent = path.dirname(lexical);
  if (!fs.existsSync(parent)) throw new Error(`Evolution target parent does not exist: ${parent}`);
  assertNoLinkTraversal(root, parent);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Evolution target parent must be a real non-symbolic-link directory: ${parent}`);
  }
  const realParent = fs.realpathSync.native(parent);
  if (!isPathInside(root, realParent)) throw new Error(`Evolution target resolves outside the root: ${input}`);
  const absolute = path.join(realParent, path.basename(lexical));
  return { absolute, relative: toPortablePath(path.relative(root, absolute)) };
}

function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw stateConflict(`Save directory is not a real directory: ${directory}`);
  }
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtime_ns: stat.birthtimeNs.toString(),
  };
}

function sameDirectoryIdentity(directory, expected) {
  if (!expected || !fs.existsSync(directory)) return false;
  try {
    return JSON.stringify(directoryIdentity(directory)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function assertSaveDirectoryPath(root, relative, { mustExist = false } = {}) {
  const absolute = path.resolve(root, ...String(relative).split('/'));
  if (!isPathInside(root, absolute) || absolute === root) {
    throw stateConflict('Save directory escapes its authorized Root.');
  }
  assertPortableWindowsPath(root, absolute);
  assertNoLinkTraversal(root, absolute);
  if (mustExist) {
    if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isDirectory() || fs.lstatSync(absolute).isSymbolicLink()) {
      throw stateConflict(`Save directory is unavailable: ${relative}`);
    }
    const real = fs.realpathSync.native(absolute);
    if (!isPathInside(root, real)) throw stateConflict('Save directory resolves outside its authorized Root.');
  }
  return absolute;
}

function normalizePlannedTarget(root, input, plannedDirectories) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Organization plan target is required.');
  const lexical = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isPathInside(root, lexical) || lexical === root) {
    throw new Error(`Organization plan target escapes the root: ${input}`);
  }
  assertPortableWindowsPath(root, lexical);
  if (fs.existsSync(lexical)) throw new Error(`Organization plan target is already claimed: ${lexical}`);
  const parent = path.dirname(lexical);
  const parentRelative = toPortablePath(path.relative(root, parent));
  if (fs.existsSync(parent)) {
    assertNoLinkTraversal(root, parent);
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Organization plan target parent must be a real directory: ${parent}`);
    }
    const realParent = fs.realpathSync.native(parent);
    if (!isPathInside(root, realParent)) throw new Error(`Organization plan target resolves outside the root: ${input}`);
  } else if (!plannedDirectories.has(parentRelative)) {
    throw new Error(`Organization plan target parent is neither existing nor created earlier: ${parentRelative}`);
  }
  return { absolute: lexical, relative: toPortablePath(path.relative(root, lexical)) };
}

function normalizeSource(root, input, expectedKind) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Evolution source is required.');
  const lexical = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isPathInside(root, lexical) || lexical === root) {
    throw new Error(`Evolution source escapes the root: ${input}`);
  }
  assertPortableWindowsPath(root, lexical);
  if (!fs.existsSync(lexical)) throw new Error(`Evolution source does not exist: ${lexical}`);
  assertNoLinkTraversal(root, lexical);
  const stat = fs.lstatSync(lexical);
  if (stat.isSymbolicLink()) throw new Error(`Evolution source cannot be a symbolic link: ${lexical}`);
  if (expectedKind === 'file' && !stat.isFile()) throw new Error(`Evolution source must be a file: ${lexical}`);
  if (expectedKind === 'directory' && !stat.isDirectory()) {
    throw new Error(`Evolution source must be a directory: ${lexical}`);
  }
  const real = fs.realpathSync.native(lexical);
  if (!isPathInside(root, real)) throw new Error(`Evolution source resolves outside the root: ${input}`);
  return { absolute: real, relative: toPortablePath(path.relative(root, real)) };
}

function manifestByteSize(manifest) {
  return manifest.entries.reduce((total, entry) => total + (entry.byte_size ?? 0), 0);
}

function availableBytes(directory) {
  try {
    const stats = fs.statfsSync(directory, { bigint: true });
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function directoryManifest(directory) {
  const entries = [{ path: '', kind: 'directory' }];
  function walk(current, relativeBase) {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      if (entries.length >= MAX_MANIFEST_ENTRIES) {
        throw new Error(`Evolution Project manifest exceeds ${MAX_MANIFEST_ENTRIES} entries.`);
      }
      const absolute = path.join(current, child.name);
      const relative = relativeBase ? `${relativeBase}/${child.name}` : child.name;
      const stat = fs.lstatSync(absolute);
      if (child.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`Evolution does not follow symbolic links: ${absolute}`);
      }
      if (child.isDirectory()) {
        entries.push({ path: relative, kind: 'directory' });
        walk(absolute, relative);
      } else if (child.isFile()) {
        entries.push({
          path: relative,
          kind: 'file',
          byte_size: stat.size,
          content_hash: sha256File(absolute),
        });
      } else {
        throw new Error(`Evolution does not support special filesystem entries: ${absolute}`);
      }
    }
  }
  walk(directory, '');
  return { kind: 'directory', entries, hash: hashJson(entries) };
}

function migratableDirectoryManifest(directory) {
  const entries = [{ path: '', kind: 'directory' }];
  function walk(current, relativeBase) {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      if (entries.length >= MAX_MANIFEST_ENTRIES) {
        throw new Error(`Evolution directory manifest exceeds ${MAX_MANIFEST_ENTRIES} entries.`);
      }
      const absolute = path.join(current, child.name);
      const relative = relativeBase ? `${relativeBase}/${child.name}` : child.name;
      const stat = fs.lstatSync(absolute);
      if (child.isSymbolicLink() || stat.isSymbolicLink()) {
        const rawTarget = fs.readlinkSync(absolute);
        const resolvedTarget = path.resolve(path.dirname(absolute), rawTarget);
        const internal = isPathInside(directory, resolvedTarget);
        const targetExists = fs.existsSync(resolvedTarget);
        let linkType = 'file';
        try {
          if (fs.statSync(absolute).isDirectory()) linkType = 'directory';
        } catch {
          linkType = 'unknown';
        }
        entries.push({
          path: relative,
          kind: 'reparse_point',
          link_type: linkType,
          target_scope: internal ? 'internal' : 'external',
          target_relative: internal ? toPortablePath(path.relative(directory, resolvedTarget)) : null,
          target_exists: targetExists,
          raw_target: rawTarget,
        });
      } else if (child.isDirectory()) {
        entries.push({ path: relative, kind: 'directory' });
        walk(absolute, relative);
      } else if (child.isFile()) {
        entries.push({
          path: relative,
          kind: 'file',
          byte_size: stat.size,
          content_hash: sha256File(absolute),
        });
      } else {
        throw new Error(`Evolution does not support special filesystem entries: ${absolute}`);
      }
    }
  }
  walk(directory, '');
  const canonical = entries.map(({ raw_target: _rawTarget, ...entry }) => entry);
  return { kind: 'directory', entries, hash: hashJson(canonical) };
}

function detectPnpmStorePath() {
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd store path'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    })
    : spawnSync('pnpm', ['store', 'path'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
  if (result.status !== 0) return null;
  const candidate = result.stdout.trim().split(/\r?\n/u).at(-1)?.trim();
  return candidate && path.isAbsolute(candidate) ? path.resolve(candidate) : null;
}

function inspectMigratableDirectory(root, directory, manifest) {
  const contentRead = new Map();
  const controlFiles = [];
  const references = [];
  const sourceName = path.basename(directory).toLowerCase();
  const parentName = path.basename(path.dirname(directory)).toLowerCase();
  const sourceClassification = DIRECTORY_CLASSIFICATIONS.get(sourceName)
    ?? (parentName === 'tools' ? 'tool_source_collection' : null);
  const inspectTextContent = !['tool_runtime', 'generated_cache', 'temporary_work'].includes(sourceClassification);
  const fileEntries = manifest.entries.filter((entry) => entry.kind === 'file');
  const readText = (entry, limit) => {
    const absolute = path.resolve(directory, ...entry.path.split('/'));
    const bytes = fs.readFileSync(absolute).subarray(0, limit);
    contentRead.set(entry.path, Math.max(contentRead.get(entry.path) ?? 0, bytes.length));
    return bytes.toString('utf8');
  };
  for (const entry of fileEntries) {
    if (!inspectTextContent) break;
    if (entry.path.split('/').some((segment) => GENERATED_INSPECTION_SEGMENTS.has(segment.toLowerCase()))) {
      continue;
    }
    const basename = path.posix.basename(entry.path).toLowerCase();
    if (CONTROL_FILE_NAMES.has(basename) && controlFiles.length < 30) {
      const text = readText(entry, Math.min(entry.byte_size, MAX_CONTROL_FILE_BYTES));
      controlFiles.push({ path: entry.path, byte_size: entry.byte_size, excerpt: text.slice(0, 1200) });
    }
    const extension = path.posix.extname(entry.path).toLowerCase();
    if (!REFERENCE_EXTENSIONS.has(extension) || entry.byte_size > MAX_REFERENCE_FILE_BYTES) continue;
    const text = readText(entry, entry.byte_size);
    const functional = FUNCTIONAL_REFERENCE_EXTENSIONS.has(extension)
      || entry.path.toLowerCase().startsWith('.obsidian/');
    for (const match of text.matchAll(/[A-Z]:\\[^\r\n"'`<>|]*/gu)) {
      if (references.length >= MAX_INSPECTION_REFERENCES) break;
      const raw = match[0].replace(/[\])},;]+$/gu, '').trimEnd();
      const reference = raw.replace(/\\\\/gu, '\\');
      const firstSegment = reference.slice(3);
      if (/^[nrtvswd][*+?${[(^]/u.test(firstSegment)) continue;
      const resolved = path.resolve(reference);
      references.push({
        path: entry.path,
        functional,
        reference,
        exists: fs.existsSync(resolved),
        points_to_source: resolved.toLowerCase() === directory.toLowerCase()
          || isPathInside(directory, resolved),
      });
    }
  }
  const directPaths = new Set(manifest.entries.map((entry) => entry.path));
  const controlFilePaths = new Set(controlFiles.map((item) => item.path));
  const type = sourceClassification ?? (directPaths.has('.obsidian') ? 'managed_library'
    : directPaths.has('.git') ? 'source_repository'
      : controlFiles.some((item) => path.posix.basename(item.path).toLowerCase() === 'package.json')
        ? 'project_workspace'
        : 'directory_workspace');
  const reparsePoints = manifest.entries.filter((entry) => entry.kind === 'reparse_point');
  const functionalReferences = references.filter((item) => item.functional && item.points_to_source);
  const sourceCacheKind = GENERATED_CACHE_DIRECTORY_NAMES.get(path.basename(directory).toLowerCase()) ?? null;
  const generatedCaches = [];
  const seenCaches = new Set();
  for (const entry of manifest.entries) {
    if (entry.kind !== 'directory' || !entry.path) continue;
    const kind = GENERATED_CACHE_DIRECTORY_NAMES.get(path.posix.basename(entry.path).toLowerCase());
    if (!kind) continue;
    const cacheRoot = entry.path.split('/').slice(0, entry.path.split('/').findIndex((part) => (
      GENERATED_CACHE_DIRECTORY_NAMES.has(part.toLowerCase())
    )) + 1).join('/');
    if (seenCaches.has(cacheRoot)) continue;
    seenCaches.add(cacheRoot);
    const rootAlternativePath = kind === 'pnpm_store' ? path.join(root, '.pnpm-store') : null;
    const cacheAbsolute = path.resolve(directory, ...cacheRoot.split('/'));
    generatedCaches.push({
      path: cacheRoot,
      kind,
      root_level_alternative: rootAlternativePath
        && path.resolve(rootAlternativePath).toLowerCase() !== cacheAbsolute.toLowerCase()
        && fs.existsSync(rootAlternativePath)
        ? toPortablePath(path.relative(root, rootAlternativePath))
        : null,
    });
  }
  const activePnpmStore = sourceCacheKind === 'pnpm_store'
    || generatedCaches.some((item) => item.kind === 'pnpm_store')
    ? detectPnpmStorePath()
    : null;
  const staleInternalReparsePoints = reparsePoints.filter((entry) => (
    entry.target_scope === 'internal' && !entry.target_exists
  ));
  const blockers = [
    ...(functionalReferences.length ? ['functional_absolute_path_references_require_review'] : []),
    ...(!sourceCacheKind && generatedCaches.length ? ['nested_generated_cache_requires_disposition'] : []),
    ...(staleInternalReparsePoints.length ? ['stale_internal_reparse_target'] : []),
  ];
  const reviewableDocumentationReferences = references.filter(
    (item) => !item.functional && controlFilePaths.has(item.path),
  );
  const staleActionableReferences = references.filter(
    (item) => !item.exists && (item.functional || controlFilePaths.has(item.path)),
  );
  const warnings = [
    ...(reviewableDocumentationReferences.length ? ['documentation_contains_old_absolute_path'] : []),
    ...(staleActionableReferences.length ? ['stale_absolute_path_reference'] : []),
    ...(generatedCaches.some((item) => item.root_level_alternative) ? ['root_level_cache_alternative_exists'] : []),
  ];
  return {
    classification: {
      type: sourceCacheKind ? 'generated_cache' : type,
      evidence: [
        ...(sourceCacheKind ? [path.basename(directory)] : []),
        ...(directPaths.has('.obsidian') ? ['.obsidian'] : []),
        ...(directPaths.has('.git') ? ['.git'] : []),
        ...controlFiles.map((item) => item.path),
      ],
    },
    control_files: controlFiles,
    content_files_read: contentRead.size,
    content_bytes_read: [...contentRead.values()].reduce((sum, value) => sum + value, 0),
    path_references: references,
    generated_caches: generatedCaches,
    package_manager_environment: {
      pnpm_store_path: activePnpmStore,
      active_store_inside_source: activePnpmStore ? isPathInside(directory, activePnpmStore) : null,
    },
    reparse_points: {
      total: reparsePoints.length,
      internal: reparsePoints.filter((entry) => entry.target_scope === 'internal').length,
      external: reparsePoints.filter((entry) => entry.target_scope === 'external').length,
      items: reparsePoints.map((entry) => ({
        path: entry.path,
        link_type: entry.link_type,
        target_scope: entry.target_scope,
        target_relative: entry.target_relative,
        target_exists: entry.target_exists,
        raw_target: entry.raw_target,
      })),
    },
    blockers,
    warnings,
    recommendation: !sourceCacheKind && generatedCaches.length
      ? 'quarantine_generated_cache_before_library_migration'
      : 'review_and_migrate',
  };
}

function inspectAncestorControlReferences(root, source) {
  const references = [];
  const filesRead = [];
  const sourceRelative = toPortablePath(path.relative(root, source));
  const needles = [...new Set([
    source.toLowerCase(),
    source.replaceAll('\\', '/').toLowerCase(),
    sourceRelative.toLowerCase(),
    sourceRelative.replaceAll('/', '\\').toLowerCase(),
  ])].filter(Boolean);
  let cursor = path.dirname(source);
  while (isPathInside(root, cursor)) {
    for (const name of CONTROL_FILE_NAMES) {
      const candidate = path.join(cursor, name);
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_FILE_BYTES) continue;
      const text = fs.readFileSync(candidate, 'utf8');
      filesRead.push({
        path: toPortablePath(path.relative(root, candidate)),
        byte_size: stat.size,
      });
      const normalized = text.replaceAll('\\\\', '\\').toLowerCase();
      const matched = needles.filter((needle) => normalized.includes(needle));
      if (!matched.length) continue;
      const basename = path.basename(candidate).toLowerCase();
      references.push({
        path: toPortablePath(path.relative(root, candidate)),
        functional: basename === 'agents.md' || FUNCTIONAL_REFERENCE_EXTENSIONS.has(path.extname(candidate).toLowerCase()),
        matched_forms: matched,
      });
    }
    if (cursor.toLowerCase() === root.toLowerCase()) break;
    cursor = path.dirname(cursor);
  }
  return {
    files_read: filesRead,
    references,
    blockers: references.some((item) => item.functional)
      ? ['external_control_file_references_source_path'] : [],
    warnings: references.some((item) => !item.functional)
      ? ['external_documentation_references_source_path'] : [],
  };
}

function migratableManifestAt(absolute) {
  if (!fs.existsSync(absolute)) return { kind: 'absent', entries: [], hash: null };
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: 'unsupported', entries: [], hash: null };
  try {
    return migratableDirectoryManifest(absolute);
  } catch {
    return { kind: 'unsupported', entries: [], hash: null };
  }
}

function manifestForOperation(absolute, operation, expectedKind) {
  return operation === 'migrate_directory'
    ? migratableManifestAt(absolute)
    : manifestAt(absolute, expectedKind);
}

function technicalStagePath(target, runId, phase) {
  return path.join(path.dirname(target), `.${path.basename(target)}.atlas-${runId}-${phase}.tmp`);
}

function removeRegularEntry(absolute, kind) {
  if (kind === 'directory') fs.rmSync(absolute, { recursive: true });
  else fs.unlinkSync(absolute);
}

function copyRegularEntry(source, target, kind) {
  if (kind === 'directory') {
    fs.cpSync(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  } else {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
}

function copyVerifiedToAbsentTarget({ source, target, kind, manifestHash, runId, phase }) {
  const targetState = manifestAt(target, kind);
  const stage = technicalStagePath(target, runId, phase);
  if (sameManifest(targetState, kind, manifestHash)) {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    return;
  }
  if (targetState.kind !== 'absent') {
    throw stateConflict('Cross-Root migration target was claimed or changed.');
  }
  let stageState = manifestAt(stage, kind);
  if (!sameManifest(stageState, kind, manifestHash)) {
    if (stageState.kind !== 'absent') fs.rmSync(stage, { recursive: true, force: true });
    try {
      copyRegularEntry(source, stage, kind);
    } catch (error) {
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
    stageState = manifestAt(stage, kind);
  }
  if (!sameManifest(stageState, kind, manifestHash)) {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    throw new Error('Cross-Root migration staging verification failed.');
  }
  fs.renameSync(stage, target);
  if (!sameManifest(manifestAt(target, kind), kind, manifestHash)) {
    throw new Error('Cross-Root migration target verification failed.');
  }
}

function internalReparseEntries(entries) {
  return (entries ?? []).filter((entry) => entry.kind === 'reparse_point' && entry.target_scope === 'internal');
}

function removeInternalReparsePoints(base, entries) {
  for (const entry of internalReparseEntries(entries)) {
    fs.rmSync(path.resolve(base, ...entry.path.split('/')), { force: true });
  }
}

function createInternalReparsePoints(base, entries) {
  for (const entry of internalReparseEntries(entries)) {
    const linkPath = path.resolve(base, ...entry.path.split('/'));
    const targetPath = path.resolve(base, ...entry.target_relative.split('/'));
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Evolution cannot rebase internal reparse target because it is absent: ${entry.target_relative}`);
    }
    fs.symlinkSync(targetPath, linkPath, entry.link_type === 'directory' ? 'junction' : 'file');
  }
}

function renameMigratableDirectory(source, target, entries) {
  removeInternalReparsePoints(source, entries);
  let renamed = false;
  try {
    fs.renameSync(source, target);
    renamed = true;
    createInternalReparsePoints(target, entries);
  } catch (error) {
    try {
      if (renamed && fs.existsSync(target) && !fs.existsSync(source)) {
        removeInternalReparsePoints(target, entries);
        fs.renameSync(target, source);
      }
      if (fs.existsSync(source)) createInternalReparsePoints(source, entries);
    } catch (recoveryError) {
      error.recovery_error = recoveryError.message;
    }
    throw error;
  }
}

function manifestAt(absolute, expectedKind = null) {
  if (!fs.existsSync(absolute)) return { kind: 'absent', entries: [], hash: null };
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return { kind: 'unsupported', entries: [], hash: null };
  if (stat.isFile()) {
    if (expectedKind && expectedKind !== 'file') return { kind: 'unsupported', entries: [], hash: null };
    const entries = [{ path: '', kind: 'file', byte_size: stat.size, content_hash: sha256File(absolute) }];
    return { kind: 'file', entries, hash: hashJson(entries) };
  }
  if (stat.isDirectory()) {
    if (expectedKind && expectedKind !== 'directory') return { kind: 'unsupported', entries: [], hash: null };
    try {
      return directoryManifest(absolute);
    } catch {
      return { kind: 'unsupported', entries: [], hash: null };
    }
  }
  return { kind: 'unsupported', entries: [], hash: null };
}

function sameManifest(observed, expectedKind, expectedHash) {
  return observed.kind === expectedKind && observed.hash === expectedHash;
}

function publicManifest(manifest) {
  return {
    kind: manifest.kind,
    hash: manifest.hash,
    entries: manifest.entries.length,
    files: manifest.entries.filter((entry) => entry.kind === 'file').length,
    directories: manifest.entries.filter((entry) => entry.kind === 'directory').length,
    sample_paths: manifest.entries.map((entry) => entry.path || '.').slice(0, 10),
  };
}

function diffFor(operation, source, target) {
  if (operation === 'create_directory') return `create directory ${target}\n`;
  if (operation === 'remove_empty_directory') return `remove empty directory ${source}\n`;
  const subject = operation === 'move_file' ? 'file'
    : operation === 'migrate_directory' ? 'directory'
      : operation === 'migrate_cross_root' ? 'cross-root entry'
      : 'project';
  return `move ${subject} ${source} -> ${target}\n`;
}

function stateConflict(message) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  return error;
}

export class Evolution {
  constructor({ stateDir, registry = null, saveService = null }) {
    if (!stateDir) throw new Error('Evolution requires a stateDir');
    this.stateDir = path.resolve(stateDir);
    this.registry = registry;
    this.saveService = saveService;
    this._ledger = null;
  }

  get ledger() {
    if (!this._ledger) this._ledger = new Ledger(this.stateDir);
    return this._ledger;
  }

  #verifySaveDirectoryContext(context, { checkPlan = true, identityEvent = null, allowAbsentIdentity = false } = {}) {
    if (!context || !this.registry || !this.saveService) {
      throw new Error('Project Save directory changes require Registry and Save services.');
    }
    const root = normalizeRoot(context.root);
    if (root !== context.root) {
      throw stateConflict('Save directory Root context changed.');
    }
    const detail = this.registry.show(context.project_id);
    const project = detail.project;
    const location = detail.location;
    if (!project || project.status !== 'active' || !location
      || location.root_id !== context.root_id
      || path.resolve(location.root_path).toLowerCase() !== root.toLowerCase()
      || project.current_path !== context.project_path
      || location.relative_path !== context.project_path) {
      throw stateConflict('Project or attached Root changed after Save directory preparation.');
    }
    assertRecoveryWritable(this.ledger.db, { projectId: context.project_id });
    const rootIdentity = directoryIdentity(root);
    const projectPath = assertSaveDirectoryPath(root, context.project_path, { mustExist: true });
    const parentPath = assertSaveDirectoryPath(root, context.parent_path, { mustExist: true });
    if (JSON.stringify(rootIdentity) !== JSON.stringify(context.root_identity)
      || JSON.stringify(directoryIdentity(projectPath)) !== JSON.stringify(context.project_identity)
      || JSON.stringify(directoryIdentity(parentPath)) !== JSON.stringify(context.parent_identity)) {
      throw stateConflict('Save directory Root, Project, or existing parent identity changed.');
    }
    const targetPath = assertSaveDirectoryPath(root, context.directory_path);
    const saveTargetPath = assertSaveDirectoryPath(root, context.save_target);
    if (!isPathInside(projectPath, targetPath) || !isPathInside(targetPath, saveTargetPath)
      || toPortablePath(path.relative(root, targetPath)) !== context.directory_path
      || toPortablePath(path.relative(root, saveTargetPath)) !== context.save_target) {
      throw stateConflict('Save directory target is outside the attached Project.');
    }
    if (checkPlan) {
      const plan = this.saveService.plan(context.save_options);
      if (plan.status !== 'needs_structure_change'
        || plan.plan_revision !== context.plan_revision
        || String(plan.target ?? '').replaceAll('\\', '/') !== context.save_target) {
        throw stateConflict('Save plan changed; review the current plan before approving or creating its directory.');
      }
    }
    if (identityEvent) {
      if (!sameDirectoryIdentity(targetPath, identityEvent.payload?.identity)
        && !(allowAbsentIdentity && !fs.existsSync(targetPath))) {
        throw stateConflict('Created Save directory identity cannot be proven; recovery is required.');
      }
      if (fs.existsSync(targetPath)) {
        const manifest = directoryManifest(targetPath);
        if (manifest.entries.length !== 1) throw stateConflict('Created Save directory is no longer empty.');
      }
    } else if (fs.existsSync(targetPath)) {
      throw stateConflict('Save directory target was claimed before Atlas recorded its identity.');
    }
    return { targetPath, targetRelative: context.directory_path };
  }

  preparePlan({ root: rootInput, operations, intent = null, caller = {}, runId: requestedRunId = null }) {
    if (Array.isArray(operations)) operations.forEach((item) => refuseProjectMigration(item?.operation));
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the organization plan root: ${this.stateDir}`);
    }
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100) {
      throw new Error('Organization plan requires between 1 and 100 operations.');
    }
    return withStateLock(this.stateDir, () => {
      const plannedDirectories = new Set();
      const targets = new Set();
      const normalized = operations.map((item, ordinal) => {
        if (!['create_directory', 'move_file', 'migrate_project', 'migrate_directory'].includes(item.operation)) {
          throw new Error(`Organization plan operation ${ordinal} is unsupported: ${item.operation}`);
        }
        const target = normalizePlannedTarget(root, item.target, plannedDirectories);
        if (targets.has(target.relative)) throw new Error(`Organization plan repeats target: ${target.relative}`);
        targets.add(target.relative);
        let source = null;
        let project = null;
        if (item.operation === 'move_file') {
          source = normalizeSource(root, item.source, 'file');
        } else if (item.operation === 'migrate_directory') {
          source = normalizeSource(root, item.source, 'directory');
        } else if (item.operation === 'migrate_project') {
          if (!item.projectId) throw new Error('Organization plan Project migration requires projectId.');
          project = this.ledger.getProject(item.projectId);
          if (project.status !== 'active') throw new Error(`Organization plan Project is not active: ${item.projectId}`);
          source = normalizeSource(root, project.current_path, 'directory');
        }
        if (source && source.absolute.toLowerCase() === target.absolute.toLowerCase()) {
          throw new Error('Organization plan does not support identical or case-only moves.');
        }
        if (source && ['migrate_project', 'migrate_directory'].includes(item.operation)
          && isPathInside(source.absolute, target.absolute)) {
          throw new Error('Organization plan migration target cannot be nested inside its source.');
        }
        const sourceManifest = source
          ? manifestForOperation(
              source.absolute,
              item.operation,
              item.operation === 'move_file' ? 'file' : 'directory',
            )
          : null;
        if (sourceManifest?.kind === 'unsupported') {
          throw new Error(`Organization plan source contains unsupported entries: ${source.relative}`);
        }
        const inspection = item.operation === 'migrate_directory'
          ? inspectMigratableDirectory(root, source.absolute, sourceManifest)
          : null;
        const operation = {
          ordinal,
          operation: item.operation,
          source: source?.relative ?? null,
          target: target.relative,
          project_id: item.projectId ?? null,
          baseline: {
            source_kind: sourceManifest?.kind ?? null,
            source_manifest_hash: sourceManifest?.hash ?? null,
            project_path: project?.current_path ?? null,
            target_state: 'absent',
          },
          recovery: item.operation === 'create_directory'
            ? 'Remove only if still empty.'
            : 'Move back only if the target still matches the prepared source manifest.',
          ...(inspection ? {
            inspection,
            blockers: inspection.blockers,
            warnings: inspection.warnings,
          } : {}),
        };
        if (item.operation === 'create_directory') plannedDirectories.add(target.relative);
        return operation;
      });
      const planHash = hashJson({ root, operations: normalized });
      const runId = requestedRunId ?? makePlanRunId();
      return this.ledger.createOrganizationPlan({
        runId,
        root,
        intent,
        operations: normalized,
        planHash,
        caller,
        createdAt: timestamp(),
      });
    });
  }

  previewPlan(runId) {
    const detail = this.ledger.getOrganizationPlan(runId);
    if (detail.operations.some((item) => item.operation === 'migrate_project')) {
      return { ...detail, project_migration_compatibility: { guidance: PROJECT_MOVE_GUIDANCE, legacy_undo_supported: false } };
    }
    return detail;
  }

  approvePlan(runId, { reason = null } = {}) {
    if (!reason?.trim()) throw new Error('Organization plan approval requires a reason.');
    const detail = this.previewPlan(runId);
    refuseProjectPlan(detail);
    const blockers = detail.operations.flatMap((operation) => operation.blockers ?? []);
    if (blockers.length) {
      throw new Error(`Organization plan has unresolved blockers: ${[...new Set(blockers)].join(', ')}.`);
    }
    return this.ledger.reviewOrganizationPlan(runId, { reason: reason.trim(), reviewedAt: timestamp() });
  }

  rejectPlan(runId, { reason = null } = {}) {
    if (!reason?.trim()) throw new Error('Organization plan rejection requires a reason.');
    return this.ledger.rejectOrganizationPlan(runId, { reason: reason.trim(), reviewedAt: timestamp() });
  }

  #preflightPlan(detail) {
    const conflicts = [];
    const availablePlannedDirectories = new Set();
    for (const operation of detail.operations) {
      const item = detail.items.find((candidate) => candidate.ordinal === operation.ordinal);
      if (item?.status === 'executed' || item?.status === 'rolled_back') {
        if (operation.operation === 'create_directory' && item.status === 'executed') {
          availablePlannedDirectories.add(operation.target);
        }
        continue;
      }
      const root = detail.run.root_path;
      const targetPath = path.resolve(root, ...operation.target.split('/'));
      const targetState = manifestForOperation(
        targetPath,
        operation.operation,
        operation.operation === 'move_file' ? 'file' : 'directory',
      );
      if (targetState.kind !== 'absent') {
        conflicts.push({ ordinal: operation.ordinal, path: operation.target, reason: 'target_claimed' });
      }
      if (operation.source) {
        const sourcePath = path.resolve(root, ...operation.source.split('/'));
        const sourceState = manifestForOperation(
          sourcePath,
          operation.operation,
          operation.baseline.source_kind,
        );
        if (!sameManifest(sourceState, operation.baseline.source_kind, operation.baseline.source_manifest_hash)) {
          conflicts.push({ ordinal: operation.ordinal, path: operation.source, reason: 'source_changed' });
        }
      }
      const parentRelative = toPortablePath(path.posix.dirname(operation.target));
      const parentPath = path.resolve(root, ...parentRelative.split('/'));
      if (!fs.existsSync(parentPath) && !availablePlannedDirectories.has(parentRelative)) {
        conflicts.push({ ordinal: operation.ordinal, path: parentRelative, reason: 'target_parent_missing' });
      }
      if (operation.project_id) {
        const project = this.ledger.getProject(operation.project_id);
        if (project.status !== 'active' || project.current_path !== operation.baseline.project_path) {
          conflicts.push({ ordinal: operation.ordinal, path: operation.source, reason: 'project_registry_changed' });
        }
      }
      if (operation.operation === 'create_directory') availablePlannedDirectories.add(operation.target);
    }
    return conflicts;
  }

  executePlan(runId) {
    let detail = this.previewPlan(runId);
    refuseProjectPlan(detail);
    if (detail.execution_receipt) return detail.execution_receipt;
    if (!['approved', 'partially_executed'].includes(detail.run.status)) {
      throw new Error(`Organization plan execution requires approval; current status is ${detail.run.status}.`);
    }
    if (detail.approved_plan_hash !== detail.plan_hash) {
      throw stateConflict('Organization plan approval does not match the immutable plan hash.');
    }
    const conflicts = this.#preflightPlan(detail);
    if (conflicts.length) {
      this.ledger.markOrganizationPlanStale(runId, conflicts, timestamp());
      throw stateConflict(`Organization plan source changed or target was claimed; plan is stale: ${conflicts[0].path}`);
    }
    for (const operation of detail.operations) {
      detail = this.previewPlan(runId);
      let item = detail.items.find((candidate) => candidate.ordinal === operation.ordinal);
      if (item.status === 'executed') continue;
      let childRunId = item.child_run_id;
      if (!childRunId) {
        const prepared = this.prepare({
          root: detail.run.root_path,
          operation: operation.operation,
          source: operation.source,
          target: operation.target,
          projectId: operation.project_id,
          intent: `Organization plan ${runId} item ${operation.ordinal + 1}`,
          caller: {
            actor: detail.run.actor,
            agent: detail.run.agent,
            model: detail.run.model,
            tool: detail.run.tool,
            client_run_id: detail.run.client_run_id,
          },
        });
        childRunId = prepared.run_id;
        this.ledger.recordOrganizationPlanItem(runId, operation.ordinal, {
          childRunId,
          status: 'prepared',
          occurredAt: timestamp(),
        });
      }
      const child = this.preview(childRunId);
      if (child.run.status === 'prepared') {
        this.approve(childRunId, { reason: `Approved once by immutable organization plan ${runId}.` });
      }
      this.execute(childRunId);
      this.ledger.recordOrganizationPlanItem(runId, operation.ordinal, {
        childRunId,
        status: 'executed',
        occurredAt: timestamp(),
      });
    }
    const executedAt = timestamp();
    const receipt = {
      run_id: runId,
      status: 'executed',
      plan_hash: detail.plan_hash,
      completed_operations: detail.operations.length,
      user_decisions: 1,
      verified: true,
      rollback_ready: true,
      executed_at: executedAt,
    };
    return this.ledger.finishOrganizationPlanExecution(runId, receipt, executedAt);
  }

  rollbackPlan(runId) {
    let detail = this.previewPlan(runId);
    refuseProjectPlan(detail);
    if (detail.rollback_receipt) return detail.rollback_receipt;
    if (!['executed', 'partially_executed', 'stale'].includes(detail.run.status)) {
      throw new Error(`Organization plan has no executed source changes to roll back from ${detail.run.status}.`);
    }
    for (const item of [...detail.items].sort((left, right) => right.ordinal - left.ordinal)) {
      if (!item.child_run_id || item.status === 'rolled_back') continue;
      const child = this.preview(item.child_run_id);
      if (child.run.status === 'executed') this.rollback(item.child_run_id);
      if (['executed', 'rolled_back'].includes(child.run.status) || child.rollback_receipt) {
        this.ledger.recordOrganizationPlanItem(runId, item.ordinal, {
          childRunId: item.child_run_id,
          status: 'rolled_back',
          occurredAt: timestamp(),
        });
      }
    }
    detail = this.previewPlan(runId);
    const remaining = detail.items.filter((item) => item.status === 'executed').length;
    if (remaining) throw new Error(`Organization plan rollback left ${remaining} executed operation(s).`);
    const rolledBackAt = timestamp();
    const receipt = {
      run_id: runId,
      status: 'rolled_back',
      rolled_back_operations: detail.items.filter((item) => item.child_run_id).length,
      verified: true,
      rolled_back_at: rolledBackAt,
    };
    return this.ledger.finishOrganizationPlanRollback(runId, receipt, rolledBackAt);
  }

  prepare({
    root: rootInput,
    targetRoot: targetRootInput = null,
    operation,
    source = null,
    target,
    projectId = null,
    intent = null,
    caller = {},
    saveDirectory = null,
    internalPreflight = null,
  }) {
    refuseProjectMigration(operation);
    const root = normalizeRoot(rootInput);
    const targetRoot = operation === 'migrate_cross_root'
      ? normalizeRoot(targetRootInput)
      : root;
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the Evolution root: ${this.stateDir}`);
    }
    if (operation === 'migrate_cross_root') {
      if (projectId) {
        throw new Error('Cross-Root migration does not update Project Location; omit --project and reconcile the verified target with project relocate afterward.');
      }
      if (root.toLowerCase() === targetRoot.toLowerCase()) {
        throw new Error('Cross-Root migration requires two different Roots.');
      }
      if (isPathInside(root, targetRoot) || isPathInside(targetRoot, root)) {
        throw new Error('Cross-Root migration does not support nested Roots.');
      }
      if (isPathInside(targetRoot, this.stateDir)) {
        throw new Error(`Atlas state directory must be outside the Evolution target Root: ${this.stateDir}`);
      }
    }
    if (!OPERATIONS.has(operation)) {
      throw new Error(`Evolution operation must be one of: ${[...OPERATIONS].join(', ')}.`);
    }
    return withStateLock(this.stateDir, () => {
      if (internalPreflight) internalPreflight();
      let normalizedSource = null;
      let normalizedTarget = null;
      let project = null;
      if (operation === 'remove_empty_directory') {
        normalizedSource = normalizeSource(root, source, 'directory');
        normalizedTarget = {
          absolute: normalizedSource.absolute,
          relative: normalizedSource.relative,
        };
      } else {
        normalizedTarget = normalizeTarget(targetRoot, target);
      }
      if (saveDirectory) {
        if (operation !== 'create_directory' || !projectId || saveDirectory.project_id !== projectId
          || normalizeRoot(saveDirectory.root) !== root
          || String(saveDirectory.directory_path).replaceAll('\\', '/') !== normalizedTarget.relative
          || saveDirectory.save_target == null || saveDirectory.plan_revision == null) {
          throw new Error('Save directory preparation context does not match the Evolution operation.');
        }
        this.#verifySaveDirectoryContext(saveDirectory);
      }
      if (operation === 'move_file') {
        normalizedSource = normalizeSource(root, source, 'file');
      } else if (operation === 'migrate_directory') {
        normalizedSource = normalizeSource(root, source, 'directory');
      } else if (operation === 'migrate_project') {
        if (!projectId) throw new Error('Project migration requires a Project ID.');
        project = this.ledger.getProject(projectId);
        if (project.status !== 'active') throw new Error(`Project migration requires an active Project: ${projectId}`);
        normalizedSource = normalizeSource(root, project.current_path, 'directory');
        if (source && normalizeSource(root, source, 'directory').relative !== normalizedSource.relative) {
          throw new Error('Project migration source does not match the Registry current path.');
        }
      } else if (operation === 'migrate_cross_root') {
        normalizedSource = normalizeSource(root, source, null);
      }
      if (normalizedSource) {
        if (operation !== 'remove_empty_directory'
          && normalizedSource.absolute.toLowerCase() === normalizedTarget.absolute.toLowerCase()) {
          throw new Error('Evolution does not support an identical or case-only source/target rename.');
        }
        if (['migrate_project', 'migrate_directory'].includes(operation)
          && isPathInside(normalizedSource.absolute, normalizedTarget.absolute)) {
          throw new Error('Directory migration target cannot be nested inside itself.');
        }
      }
      const sourceManifest = normalizedSource
        ? manifestForOperation(
            normalizedSource.absolute,
            operation,
            operation === 'move_file' ? 'file'
              : operation === 'migrate_cross_root' ? null : 'directory',
          )
        : null;
      if (normalizedSource && sourceManifest.kind === 'unsupported') {
        throw new Error('Evolution source contains an unsupported or symbolic-link entry.');
      }
      if (operation === 'remove_empty_directory'
        && (sourceManifest.kind !== 'directory' || sourceManifest.entries.length !== 1)) {
        throw new Error('Evolution remove_empty_directory source must be empty.');
      }
      let inspection = (operation === 'migrate_directory'
        || (operation === 'migrate_cross_root' && sourceManifest.kind === 'directory'))
        ? inspectMigratableDirectory(root, normalizedSource.absolute, sourceManifest)
        : null;
      if (operation === 'migrate_cross_root') {
        const external = inspectAncestorControlReferences(root, normalizedSource.absolute);
        inspection = {
          ...(inspection ?? {
            classification: { type: sourceManifest.kind === 'file' ? 'file' : 'directory_workspace', evidence: [] },
            control_files: [],
            content_files_read: 0,
            content_bytes_read: 0,
            path_references: [],
            generated_caches: [],
            package_manager_environment: { pnpm_store_path: null, active_store_inside_source: null },
            reparse_points: { total: 0, internal: 0, external: 0, items: [] },
            blockers: [],
            warnings: [],
            recommendation: 'review_and_migrate',
          }),
          external_control_references: external,
          blockers: [...new Set([...(inspection?.blockers ?? []), ...external.blockers])],
          warnings: [...new Set([...(inspection?.warnings ?? []), ...external.warnings])],
        };
      }
      const requiredBytes = operation === 'migrate_cross_root' ? manifestByteSize(sourceManifest) : null;
      const freeBytes = operation === 'migrate_cross_root' ? availableBytes(path.dirname(normalizedTarget.absolute)) : null;
      if (requiredBytes != null && freeBytes != null && BigInt(requiredBytes) > freeBytes) {
        throw new Error('Cross-Root migration target does not have enough free space for the reviewed source.');
      }
      const baseline = {
        source_manifest_hash: sourceManifest?.hash ?? null,
        source_kind: sourceManifest?.kind ?? null,
        source_entries: sourceManifest?.entries ?? [],
        target_state: operation === 'remove_empty_directory' ? 'not_applicable' : 'absent',
        source_root_path: root,
        target_root_path: targetRoot,
        required_copy_bytes: requiredBytes,
        available_target_bytes: freeBytes == null ? null : freeBytes.toString(),
        project: project ? {
          id: project.id,
          name: project.name,
          path: project.current_path,
          status: project.status,
        } : null,
        ...(saveDirectory ? { save_directory: saveDirectory } : {}),
      };
      const sourceChanges = operation === 'create_directory'
        ? [{ path: normalizedTarget.relative, change: 'create_directory' }]
        : operation === 'remove_empty_directory'
          ? [{ path: normalizedSource.relative, change: 'remove_empty_directory' }]
          : [
            {
              path: operation === 'migrate_cross_root'
                ? `${root}::${normalizedSource.relative}` : normalizedSource.relative,
              change: 'remove_original_path',
            },
            {
              path: operation === 'migrate_cross_root'
                ? `${targetRoot}::${normalizedTarget.relative}` : normalizedTarget.relative,
              change: 'create_moved_path',
            },
          ];
      const plan = {
        schema: 'atlas-evolution-plan.v1',
        operation,
        summary: operation === 'create_directory'
          ? `Create directory ${normalizedTarget.relative}.`
          : operation === 'remove_empty_directory'
            ? `Remove empty directory ${normalizedSource.relative}.`
            : `Move ${normalizedSource.relative} to ${normalizedTarget.relative}.`,
        source: normalizedSource?.relative ?? null,
        target: operation === 'remove_empty_directory' ? null : normalizedTarget.relative,
        ...(operation === 'migrate_cross_root' ? {
          source_root: root,
          target_root: targetRoot,
          transfer_method: 'copy_verify_remove',
          required_copy_bytes: requiredBytes,
          available_target_bytes: freeBytes == null ? null : freeBytes.toString(),
        } : {}),
        project_id: projectId,
        ...(saveDirectory ? { save_directory: {
          project_id: saveDirectory.project_id,
          root_id: saveDirectory.root_id,
          root: saveDirectory.root,
          project_path: saveDirectory.project_path,
          directory_path: saveDirectory.directory_path,
          save_target: saveDirectory.save_target,
          plan_revision: saveDirectory.plan_revision,
        } } : {}),
        source_manifest: sourceManifest ? publicManifest(sourceManifest) : null,
        ...(inspection ? {
          inspection,
          blockers: inspection.blockers,
          warnings: inspection.warnings,
        } : {}),
        source_changes: sourceChanges,
        requires_approval: true,
        recovery: operation === 'create_directory'
          ? 'Remove only if the created directory is still empty.'
          : operation === 'remove_empty_directory'
            ? 'Recreate only if the removed path is still absent and its parent still exists.'
            : 'Move back only if source remains absent and target still matches the prepared manifest.',
      };
      const planHash = hashJson(plan);
      const diffText = diffFor(
        operation,
        operation === 'migrate_cross_root' ? `${root}::${normalizedSource.relative}` : normalizedSource?.relative,
        operation === 'migrate_cross_root' ? `${targetRoot}::${normalizedTarget.relative}` : normalizedTarget.relative,
      );
      const diffHash = crypto.createHash('sha256').update(diffText).digest('hex');
      const runId = makeRunId();
      const startedAt = timestamp();
      const ids = this.ledger.createEvolutionRun({
        runId,
        root,
        operation,
        sourcePath: normalizedSource?.relative ?? null,
        targetPath: normalizedTarget.relative,
        projectId,
        intent,
        baseline,
        plan,
        planHash,
        diffText,
        diffHash,
        caller,
        startedAt,
      });
      return {
        run_id: runId,
        candidate_change_set_id: ids.candidateChangeSetId,
        prediction_id: ids.predictionId,
        status: 'prepared',
        operation,
        source: normalizedSource?.relative ?? null,
        target: operation === 'remove_empty_directory' ? null : normalizedTarget.relative,
        project_id: projectId,
        plan_hash: planHash,
        requires_approval: true,
        started_at: startedAt,
      };
    });
  }

  preview(runId) {
    const detail = this.ledger.getEvolutionDetail(runId);
    if (detail.operation.type === 'migrate_project' && !this.ledger.getEvolutionOperation(runId).baseline.project_move) {
      return { ...detail, project_migration_compatibility: { guidance: PROJECT_MOVE_GUIDANCE, legacy_undo_supported: false } };
    }
    return detail;
  }

  approve(runId, { reason = null } = {}) {
    if (!reason?.trim()) throw new Error('Evolution approval requires a reason.');
    const approveLocked = () => {
      const detail = this.preview(runId);
      refuseProjectMigration(detail.operation.type);
      if (detail.plan.blockers?.length) {
        throw new Error(`Evolution plan has unresolved blockers: ${detail.plan.blockers.join(', ')}.`);
      }
      const record = this.ledger.getEvolutionOperation(runId);
      if (record.baseline.save_directory) this.#verifySaveDirectoryContext(record.baseline.save_directory);
      return this.ledger.reviewEvolution(runId, {
        decision: 'accepted', reason: reason.trim(), reviewedAt: timestamp(),
      });
    };
    const detail = this.preview(runId);
    return detail.plan.save_directory ? withStateLock(this.stateDir, approveLocked) : approveLocked();
  }

  reject(runId, { reason = null } = {}) {
    return this.ledger.reviewEvolution(runId, {
      decision: 'rejected', reason, reviewedAt: timestamp(),
    });
  }

  execute(runId) {
    refuseProjectMigration(this.ledger.getEvolutionOperation(runId).operation_type);
    return withStateLock(this.stateDir, () => this.#execute(runId));
  }

  #execute(runId) {
    const detail = this.preview(runId);
    refuseProjectMigration(detail.operation.type);
    if (detail.execution_receipt) return detail.execution_receipt;
    if (detail.run.status !== 'approved') {
      throw new Error(`Evolution execution requires approval; current status is ${detail.run.status}.`);
    }
    if (detail.approved_plan_hash !== detail.operation.plan_hash) {
      throw new Error('Evolution approval does not match the current ChangeSet.');
    }
    const record = this.ledger.getEvolutionOperation(runId);
    const root = detail.run.root_path;
    const sourceRoot = record.baseline.source_root_path ?? root;
    const targetRoot = record.baseline.target_root_path ?? root;
    const sourcePath = record.source_path
      ? path.resolve(sourceRoot, ...record.source_path.split('/'))
      : null;
    const targetPath = path.resolve(targetRoot, ...record.target_path.split('/'));
    const expectedKind = record.operation_type === 'move_file' ? 'file'
      : record.operation_type === 'migrate_cross_root' ? record.baseline.source_kind : 'directory';
    const sourceState = sourcePath
      ? manifestForOperation(sourcePath, record.operation_type, expectedKind)
      : null;
    const targetState = manifestForOperation(targetPath, record.operation_type, expectedKind);
    const started = detail.events.some((event) => event.type === 'evolution_execution_started');
    const beforeMatches = record.operation_type === 'create_directory'
      ? targetState.kind === 'absent'
      : record.operation_type === 'remove_empty_directory'
        ? sameManifest(sourceState, 'directory', record.baseline.source_manifest_hash)
          && sourceState.entries.length === 1
        : sameManifest(sourceState, expectedKind, record.baseline.source_manifest_hash)
          && targetState.kind === 'absent';
    let afterMatches = record.operation_type === 'create_directory'
      ? sameManifest(targetState, 'directory', hashJson([{ path: '', kind: 'directory' }]))
      : record.operation_type === 'remove_empty_directory'
        ? sourceState.kind === 'absent'
        : sourceState.kind === 'absent'
          && sameManifest(targetState, expectedKind, record.baseline.source_manifest_hash);
    const crossRootCopyReady = record.operation_type === 'migrate_cross_root'
      && sameManifest(sourceState, expectedKind, record.baseline.source_manifest_hash)
      && sameManifest(targetState, expectedKind, record.baseline.source_manifest_hash);
    const saveDirectory = record.baseline.save_directory ?? null;
    const directoryIdentityEvent = detail.events.find((event) => event.type === 'evolution_save_directory_identity') ?? null;
    if (saveDirectory) {
      if (started && !directoryIdentityEvent && fs.existsSync(targetPath)) {
        this.ledger.markEvolutionStale(runId, {
          reason: 'save_directory_created_without_identity_receipt',
          target_observed_hash: targetState.hash,
        }, timestamp());
        throw stateConflict('Save directory was created without a durable identity receipt; Atlas will not claim or remove it.');
      }
      this.#verifySaveDirectoryContext(saveDirectory, {
        checkPlan: !directoryIdentityEvent,
        identityEvent: directoryIdentityEvent,
      });
      afterMatches = Boolean(directoryIdentityEvent
        && sameDirectoryIdentity(targetPath, directoryIdentityEvent.payload?.identity)
        && targetState.kind === 'directory' && targetState.entries.length === 1);
    }
    if (record.operation_type === 'migrate_project') {
      const project = this.ledger.getProject(record.project_id);
      const allowedRegistryPaths = started && afterMatches
        ? [record.source_path, record.target_path]
        : [record.source_path];
      if (!allowedRegistryPaths.includes(project.current_path)) {
        throw stateConflict('Project Registry changed after prepare; filesystem migration cannot continue.');
      }
    }
    if (!beforeMatches && !(started && (afterMatches || crossRootCopyReady))) {
      this.ledger.markEvolutionStale(runId, {
        reason: targetState.kind !== 'absent' ? 'target_claimed_or_changed' : 'source_changed_after_prepare',
        source_observed_hash: sourceState?.hash ?? null,
        target_observed_hash: targetState.hash,
      }, timestamp());
      throw stateConflict('Evolution source changed after prepare or target was claimed; approval is stale.');
    }
    if (beforeMatches || (started && crossRootCopyReady)) {
      if (!started) this.ledger.startEvolutionExecution(runId, timestamp());
      if (record.operation_type === 'create_directory') {
        fs.mkdirSync(targetPath);
        if (saveDirectory) {
          const identity = directoryIdentity(targetPath);
          this.ledger.recordEvent(runId, 'evolution_save_directory_identity', {
            directory_path: saveDirectory.directory_path,
            identity,
          });
        }
      }
      else if (record.operation_type === 'remove_empty_directory') fs.rmdirSync(sourcePath);
      else if (record.operation_type === 'migrate_directory') {
        renameMigratableDirectory(sourcePath, targetPath, record.baseline.source_entries);
      }
      else if (record.operation_type === 'migrate_cross_root') {
        if (!crossRootCopyReady) {
          copyVerifiedToAbsentTarget({
            source: sourcePath,
            target: targetPath,
            kind: expectedKind,
            manifestHash: record.baseline.source_manifest_hash,
            runId,
            phase: 'execute',
          });
        }
        const currentSource = manifestAt(sourcePath, expectedKind);
        const currentTarget = manifestAt(targetPath, expectedKind);
        if (!sameManifest(currentSource, expectedKind, record.baseline.source_manifest_hash)
          || !sameManifest(currentTarget, expectedKind, record.baseline.source_manifest_hash)) {
          throw stateConflict('Cross-Root migration changed during copy verification.');
        }
        removeRegularEntry(sourcePath, expectedKind);
      }
      else fs.renameSync(sourcePath, targetPath);
    }
    const verifiedSource = sourcePath
      ? manifestForOperation(sourcePath, record.operation_type, expectedKind)
      : null;
    const verifiedTarget = manifestForOperation(targetPath, record.operation_type, expectedKind);
    const verified = record.operation_type === 'create_directory'
      ? sameManifest(verifiedTarget, 'directory', hashJson([{ path: '', kind: 'directory' }]))
      : record.operation_type === 'remove_empty_directory'
        ? verifiedSource.kind === 'absent'
        : verifiedSource.kind === 'absent'
          && sameManifest(verifiedTarget, expectedKind, record.baseline.source_manifest_hash);
    if (!verified) throw new Error('Evolution verification failed after filesystem operation.');
    if (record.operation_type === 'migrate_project') {
      const project = this.ledger.getProject(record.project_id);
      if (project.current_path === record.source_path) {
        this.ledger.updateProject(record.project_id, {
          name: project.name,
          currentPath: record.target_path,
          aliases: [],
          status: project.status,
          reason: `Evolution run ${runId}`,
          updatedAt: timestamp(),
        });
      } else if (project.current_path !== record.target_path) {
        throw stateConflict('Project Registry changed during migration; filesystem move is preserved for reconciliation.');
      }
    }
    const executedAt = timestamp();
    return this.ledger.finishEvolutionExecution(runId, {
      receipt: {
        run_id: runId,
        status: 'executed',
        operation: record.operation_type,
        source: record.source_path,
        target: record.operation_type === 'remove_empty_directory' ? null : record.target_path,
        ...(record.operation_type === 'migrate_cross_root' ? {
          source_root: sourceRoot,
          target_root: targetRoot,
          transfer_method: 'copy_verify_remove',
        } : {}),
        project_id: record.project_id,
        changed_paths: ['create_directory', 'remove_empty_directory'].includes(record.operation_type) ? 1 : 2,
        before_manifest_hash: record.baseline.source_manifest_hash,
        after_manifest_hash: record.operation_type === 'remove_empty_directory' ? null : verifiedTarget.hash,
        verified: true,
        rollback_ready: true,
        ...(saveDirectory ? { save_directory_identity: directoryIdentity(targetPath) } : {}),
        executed_at: executedAt,
      },
      executedAt,
    });
  }

  rollback(runId) {
    // Unsupported legacy records must not acquire a rollback-error event.
    refuseProjectMigration(this.ledger.getEvolutionOperation(runId).operation_type);
    return withStateLock(this.stateDir, () => {
      try {
        return this.#rollback(runId);
      } catch (error) {
        this.ledger.recordRollbackError(runId, error);
        throw error;
      }
    });
  }

  #rollback(runId) {
    refuseProjectMigration(this.ledger.getEvolutionOperation(runId).operation_type);
    const detail = this.preview(runId);
    if (detail.rollback_receipt) return detail.rollback_receipt;
    if (detail.run.status !== 'executed') {
      throw new Error(`Only an executed Evolution run can be rolled back; current status is ${detail.run.status}.`);
    }
    const record = this.ledger.getEvolutionOperation(runId);
    const root = detail.run.root_path;
    const sourceRoot = record.baseline.source_root_path ?? root;
    const targetRoot = record.baseline.target_root_path ?? root;
    const sourcePath = record.source_path
      ? path.resolve(sourceRoot, ...record.source_path.split('/'))
      : null;
    const targetPath = path.resolve(targetRoot, ...record.target_path.split('/'));
    const expectedKind = record.operation_type === 'move_file' ? 'file'
      : record.operation_type === 'migrate_cross_root' ? record.baseline.source_kind : 'directory';
    const sourceState = sourcePath
      ? manifestForOperation(sourcePath, record.operation_type, expectedKind)
      : null;
    const targetState = manifestForOperation(targetPath, record.operation_type, expectedKind);
    const started = detail.events.some((event) => event.type === 'evolution_rollback_started');
    let endMatches = record.operation_type === 'create_directory'
      ? sameManifest(targetState, 'directory', record.execution_receipt.after_manifest_hash)
      : record.operation_type === 'remove_empty_directory'
        ? sourceState.kind === 'absent'
        : sourceState.kind === 'absent'
          && sameManifest(targetState, expectedKind, record.baseline.source_manifest_hash);
    const baselineMatches = record.operation_type === 'create_directory'
      ? targetState.kind === 'absent'
      : record.operation_type === 'remove_empty_directory'
        ? sameManifest(sourceState, 'directory', record.baseline.source_manifest_hash)
          && sourceState.entries.length === 1
        : sameManifest(sourceState, expectedKind, record.baseline.source_manifest_hash)
          && targetState.kind === 'absent';
    const saveDirectory = record.baseline.save_directory ?? null;
    const directoryIdentityEvent = detail.events.find((event) => event.type === 'evolution_save_directory_identity') ?? null;
    if (saveDirectory) {
      if (!directoryIdentityEvent
        || JSON.stringify(directoryIdentityEvent.payload?.identity) !== JSON.stringify(record.execution_receipt?.save_directory_identity)) {
        throw stateConflict('Created Save directory has no matching identity receipt.');
      }
      this.#verifySaveDirectoryContext(saveDirectory, {
        checkPlan: false,
        identityEvent: directoryIdentityEvent,
        allowAbsentIdentity: started,
      });
      endMatches = !fs.existsSync(targetPath)
        ? started
        : sameDirectoryIdentity(targetPath, record.execution_receipt.save_directory_identity)
          && targetState.kind === 'directory' && targetState.entries.length === 1;
    }
    const crossRootRestoreReady = record.operation_type === 'migrate_cross_root'
      && sameManifest(sourceState, expectedKind, record.baseline.source_manifest_hash)
      && sameManifest(targetState, expectedKind, record.baseline.source_manifest_hash);
    if (record.operation_type === 'migrate_project') {
      const project = this.ledger.getProject(record.project_id);
      const allowedRegistryPaths = started && baselineMatches
        ? [record.target_path, record.source_path]
        : [record.target_path];
      if (!allowedRegistryPaths.includes(project.current_path)) {
        throw stateConflict('Project Registry changed after execution; filesystem rollback cannot continue.');
      }
    }
    if (!endMatches && !(started && (baselineMatches || crossRootRestoreReady))) {
      throw new RollbackConflictError([{
        path: record.operation_type === 'remove_empty_directory' ? record.source_path : record.target_path,
        expected_end_hash: record.execution_receipt.after_manifest_hash,
        current_hash: record.operation_type === 'remove_empty_directory' ? sourceState.hash : targetState.hash,
        current_kind: record.operation_type === 'remove_empty_directory' ? sourceState.kind : targetState.kind,
      }]);
    }
    if (endMatches || (started && crossRootRestoreReady)) {
      if (!started) this.ledger.recordEvent(runId, 'evolution_rollback_started', {
        source: record.source_path, target: record.target_path,
      });
      if (record.operation_type === 'create_directory') {
        if (fs.existsSync(targetPath)) fs.rmdirSync(targetPath);
      }
      else if (record.operation_type === 'remove_empty_directory') fs.mkdirSync(sourcePath);
      else if (record.operation_type === 'migrate_directory') {
        renameMigratableDirectory(targetPath, sourcePath, record.baseline.source_entries);
      }
      else if (record.operation_type === 'migrate_cross_root') {
        if (!crossRootRestoreReady) {
          copyVerifiedToAbsentTarget({
            source: targetPath,
            target: sourcePath,
            kind: expectedKind,
            manifestHash: record.baseline.source_manifest_hash,
            runId,
            phase: 'rollback',
          });
        }
        const restoredSource = manifestAt(sourcePath, expectedKind);
        const currentTarget = manifestAt(targetPath, expectedKind);
        if (!sameManifest(restoredSource, expectedKind, record.baseline.source_manifest_hash)
          || !sameManifest(currentTarget, expectedKind, record.baseline.source_manifest_hash)) {
          throw new RollbackConflictError([{
            path: record.target_path,
            expected_end_hash: record.baseline.source_manifest_hash,
            current_hash: currentTarget.hash,
            current_kind: currentTarget.kind,
          }]);
        }
        removeRegularEntry(targetPath, expectedKind);
      }
      else fs.renameSync(targetPath, sourcePath);
    }
    const verifiedTarget = manifestForOperation(targetPath, record.operation_type, expectedKind);
    const verifiedSource = sourcePath
      ? manifestForOperation(sourcePath, record.operation_type, expectedKind)
      : null;
    const verified = record.operation_type === 'create_directory'
      ? verifiedTarget.kind === 'absent'
      : record.operation_type === 'remove_empty_directory'
        ? sameManifest(verifiedSource, 'directory', record.baseline.source_manifest_hash)
        : verifiedTarget.kind === 'absent'
          && sameManifest(verifiedSource, expectedKind, record.baseline.source_manifest_hash);
    if (!verified) throw new Error('Evolution rollback verification failed.');
    if (record.operation_type === 'migrate_project') {
      const project = this.ledger.getProject(record.project_id);
      if (project.current_path === record.target_path) {
        this.ledger.updateProject(record.project_id, {
          name: project.name,
          currentPath: record.source_path,
          aliases: [],
          status: project.status,
          reason: `Rollback Evolution run ${runId}`,
          updatedAt: timestamp(),
        });
      } else if (project.current_path !== record.source_path) {
        throw stateConflict('Project Registry changed before rollback; filesystem state was restored for reconciliation.');
      }
    }
    const rolledBackAt = timestamp();
    return this.ledger.finishEvolutionRollback(runId, {
      run_id: runId,
      status: 'rolled_back',
      operation: record.operation_type,
      restored_source: record.source_path,
      removed_target: record.operation_type === 'remove_empty_directory' ? null : record.target_path,
      ...(record.operation_type === 'migrate_cross_root' ? {
        source_root: sourceRoot,
        target_root: targetRoot,
        transfer_method: 'copy_verify_remove',
      } : {}),
      project_id: record.project_id,
      verified: true,
      rolled_back_at: rolledBackAt,
    }, rolledBackAt);
  }

  dispose() {
    if (this._ledger) this._ledger.close();
    this._ledger = null;
  }
}
