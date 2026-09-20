import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateContentPython } from './python-runtime.js';

// Coordination boundary: Desktop UI and Execution Hosts call these same Node
// application services. Node binds local resource identity and state; Python
// performs deterministic content work. Neither port owns a separate parser.

export const CONTENT_INSPECTION_SCHEMA = 'atlas.content-inspection.v1';
export const CONTENT_PROCESSOR_VERSION = '0.3.4';
export const CONTENT_RELATIONSHIP_SCHEMA = 'atlas.content-relationship.v1';
export const CONTENT_RELATIONSHIP_PROCESSOR_VERSION = '0.2.0';
export const CHAT_BRANCH_SET_SCHEMA = 'atlas.chat-branch-set.v1';
export const CHAT_BRANCH_PROCESSOR_VERSION = '0.1.0';
export const DATA_WORK_PROCESSOR_VERSION = '1.1.0';
const CONTENT_COMPARISON_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log']);
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256File(filePath) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest('hex');
}

function assertNoLinkTraversal(filePath) {
  let cursor = filePath;
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Content inspection cannot traverse a symbolic link or junction: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function parseCached(cachePath, expectedHash, purpose, maxCharacters, sheet) {
  try {
    const stat = fs.lstatSync(cachePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null;
    const result = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (result.schema !== CONTENT_INSPECTION_SCHEMA
        || result.source?.sha256 !== expectedHash
        || result.purpose !== purpose
        || (result.selection?.sheet ?? null) !== (sheet ?? null)
        || result.attention?.maximum_characters !== maxCharacters
        || result.processor?.version !== CONTENT_PROCESSOR_VERSION) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

function inspectionOptions({ purpose = 'content', sheet = null, maxCharacters = 4000 } = {}) {
  if (!['structure', 'content', 'data', 'visual'].includes(purpose)) {
    throw new Error('content inspect --purpose must be structure, content, data, or visual');
  }
  if (!Number.isInteger(maxCharacters) || maxCharacters < 500 || maxCharacters > 20_000) {
    throw new Error('content inspect --max-characters must be an integer from 500 to 20000');
  }
  return { purpose, sheet: sheet || null, maxCharacters };
}

export function contentFilePath(filePathInput) {
  if (!filePathInput) throw new Error('content inspect requires --file <path>');
  const filePath = path.resolve(filePathInput);
  if (!fs.existsSync(filePath)) {
    const error = new Error(`Content input does not exist: ${filePath}`);
    error.code = 'ATLAS_CONTENT_INPUT_MISSING';
    throw error;
  }
  assertNoLinkTraversal(filePath);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Content input must be a regular non-symbolic-link file: ${filePath}`);
  }
  return filePath;
}

export function contentFileFingerprint(filePathInput) {
  const filePath = contentFilePath(filePathInput);
  const stat = fs.lstatSync(filePath);
  return {
    file_path: filePath,
    sha256: sha256File(filePath),
    bytes: stat.size,
    modified_ns: Math.round(stat.mtimeMs * 1_000_000),
  };
}

export function contentComparisonSupported(filePathInput) {
  return CONTENT_COMPARISON_EXTENSIONS.has(path.extname(String(filePathInput ?? '')).toLowerCase());
}

function inspectionCache({ stateDir, filePath, sourceHash, purpose, sheet, maxCharacters }) {
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
    source_path: filePath,
    source_hash: sourceHash,
    purpose,
    sheet,
    max_characters: maxCharacters,
    processor_version: CONTENT_PROCESSOR_VERSION,
  })).digest('hex');
  const inspectionId = `CIN-${cacheKey.slice(0, 24)}`;
  const cacheDirectory = path.join(path.resolve(stateDir), 'tmp', 'content-inspections');
  return {
    inspectionId,
    cachePath: path.join(cacheDirectory, `${cacheKey}.json`),
  };
}

function writeInspectionCache(cachePath, inspection) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(inspection, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, cachePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readCachedContentInspection({
  stateDir, filePath, purpose = 'content', sheet = null, maxCharacters = 4000, cacheReference = null,
} = {}) {
  const options = inspectionOptions({ purpose, sheet, maxCharacters });
  const source = contentFileFingerprint(filePath);
  const cache = inspectionCache({
    stateDir,
    filePath: source.file_path,
    sourceHash: source.sha256,
    ...options,
  });
  if (cacheReference) {
    const referencedPath = path.resolve(path.resolve(stateDir), cacheReference);
    if (referencedPath !== cache.cachePath) return null;
  }
  const cached = fs.existsSync(cache.cachePath)
    ? parseCached(cache.cachePath, source.sha256, options.purpose, options.maxCharacters, options.sheet)
    : null;
  if (!cached) return null;
  return {
    ...cached,
    inspection_id: cache.inspectionId,
    cache_hit: true,
    cache_path: cache.cachePath,
  };
}

// Reuses one verified inspection when an Intake operation has created an identical
// Project artifact.  This is deliberately a cache binding, not another result store.
export function rebindCachedContentInspection({
  stateDir,
  sourceFilePath,
  sourceCacheReference,
  targetFilePath,
  purpose = 'content',
  sheet = null,
  maxCharacters = 4000,
} = {}) {
  const options = inspectionOptions({ purpose, sheet, maxCharacters });
  const source = contentFileFingerprint(sourceFilePath);
  const target = contentFileFingerprint(targetFilePath);
  if (target.sha256 !== source.sha256) {
    const error = new Error('The saved Project file does not match the inspected local file.');
    error.code = 'ATLAS_STATE_CONFLICT';
    throw error;
  }
  const existing = readCachedContentInspection({
    stateDir,
    filePath: source.file_path,
    purpose: options.purpose,
    sheet: options.sheet,
    maxCharacters: options.maxCharacters,
    cacheReference: sourceCacheReference,
  });
  if (!existing) {
    const error = new Error('The earlier local inspection result is unavailable and cannot be attached to the saved Project file.');
    error.code = 'ATLAS_CONTENT_CACHE_UNAVAILABLE';
    throw error;
  }
  const cache = inspectionCache({
    stateDir,
    filePath: target.file_path,
    sourceHash: target.sha256,
    ...options,
  });
  const cached = fs.existsSync(cache.cachePath)
    ? parseCached(cache.cachePath, target.sha256, options.purpose, options.maxCharacters, options.sheet)
    : null;
  if (cached) {
    return {
      ...cached,
      inspection_id: cache.inspectionId,
      cache_hit: true,
      cache_path: cache.cachePath,
    };
  }
  const rebound = {
    ...existing,
    source: {
      ...existing.source,
      path: target.file_path,
      name: path.basename(target.file_path),
      extension: path.extname(target.file_path).toLowerCase(),
      media_type: path.extname(target.file_path).toLowerCase() === String(existing.source?.extension ?? '').toLowerCase()
        ? existing.source?.media_type ?? null
        : null,
      bytes: target.bytes,
      sha256: target.sha256,
      modified_ns: target.modified_ns,
    },
  };
  writeInspectionCache(cache.cachePath, rebound);
  return {
    ...rebound,
    inspection_id: cache.inspectionId,
    cache_hit: true,
    cache_path: cache.cachePath,
  };
}

export function inspectContent({
  stateDir: stateDirInput,
  projectRoot = runtimeRoot,
  installationRoot = process.env.ATLAS_HOME ? path.resolve(process.env.ATLAS_HOME) : runtimeRoot,
  filePath: filePathInput,
  purpose = 'content',
  sheet = null,
  maxCharacters = 4000,
  pythonPath = null,
  runProcess = spawnSync,
} = {}) {
  const options = inspectionOptions({ purpose, sheet, maxCharacters });
  const source = contentFileFingerprint(filePathInput);
  const filePath = source.file_path;
  const sourceHash = source.sha256;
  const { inspectionId, cachePath } = inspectionCache({
    stateDir: stateDirInput, filePath, sourceHash, ...options,
  });
  const cacheDirectory = path.dirname(cachePath);
  const cached = fs.existsSync(cachePath)
    ? parseCached(cachePath, sourceHash, options.purpose, options.maxCharacters, options.sheet)
    : null;
  if (cached) {
    return {
      ...cached,
      inspection_id: inspectionId,
      cache_hit: true,
      cache_path: cachePath,
    };
  }

  const executable = pythonPath ?? locateContentPython({ installationRoot });
  if (!executable) {
    const error = new Error(
      'Atlas local content inspection requires the installed Desktop Python component. Run atlas ui install first.',
    );
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const pythonSourceRoot = path.join(projectRoot, 'python', 'src');
  if (!fs.existsSync(path.join(pythonSourceRoot, 'atlas_content', '__main__.py'))) {
    throw new Error('Atlas local content Python source is missing from the Runtime.');
  }
  const result = runProcess(executable, [
    '-m',
    'atlas_content',
    'inspect',
    '--file',
    filePath,
    '--purpose',
    options.purpose,
    ...(options.sheet ? ['--sheet', options.sheet] : []),
    '--max-characters',
    String(options.maxCharacters),
    '--expected-sha256',
    sourceHash,
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PYTHONPATH: [pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Atlas local content inspection failed: ${
        result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`
      }`,
    );
  }
  let inspection;
  try {
    inspection = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`Atlas local content inspection returned invalid JSON: ${error.message}`);
  }
  if (inspection.schema !== CONTENT_INSPECTION_SCHEMA
      || inspection.source?.sha256 !== sourceHash
      || inspection.processor?.version !== CONTENT_PROCESSOR_VERSION) {
    throw new Error('Atlas local content inspection returned an incompatible or stale result.');
  }
  if (sha256File(filePath) !== sourceHash) {
    const error = new Error('Content input changed during local extraction; retry with the current file.');
    error.code = 'ATLAS_STATE_CONFLICT';
    throw error;
  }

  writeInspectionCache(cachePath, inspection);
  return {
    ...inspection,
    inspection_id: inspectionId,
    cache_hit: false,
    cache_path: cachePath,
  };
}

// Data Work uses the same optional local Python component as inspection.  Node only
// carries the bounded session request; CSV/XLSX parsing and operations stay in Python.
export function runDataWork({
  projectRoot = runtimeRoot,
  installationRoot = process.env.ATLAS_HOME ? path.resolve(process.env.ATLAS_HOME) : runtimeRoot,
  filePath: filePathInput,
  expectedSha256,
  action,
  sheet = null,
  requestPath = null,
  outputPath = null,
  pythonPath = null,
  runProcess = spawnSync,
} = {}) {
  const source = contentFileFingerprint(filePathInput);
  if (expectedSha256 && source.sha256 !== expectedSha256) {
    const error = new Error('The original file changed while this Data Work was open.');
    error.code = 'ATLAS_STATE_CONFLICT';
    throw error;
  }
  const executable = pythonPath ?? locateContentPython({ installationRoot });
  if (!executable) {
    const error = new Error('Atlas Data Work requires the installed local Python component.');
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const pythonSourceRoot = path.join(projectRoot, 'python', 'src');
  if (!fs.existsSync(path.join(pythonSourceRoot, 'atlas_content', '__main__.py'))) {
    throw new Error('Atlas local content Python source is missing from the Runtime.');
  }
  const result = runProcess(executable, [
    '-m', 'atlas_content', 'data-work', '--file', source.file_path,
    '--expected-sha256', source.sha256, '--action', action,
    ...(sheet ? ['--sheet', sheet] : []),
    ...(requestPath ? ['--request', requestPath] : []),
    ...(outputPath ? ['--output', outputPath] : []),
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PYTHONPATH: [pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    }, encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Atlas Data Work failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout.trim()); } catch (error) { throw new Error(`Atlas Data Work returned invalid JSON: ${error.message}`); }
  if (parsed.processor?.version !== DATA_WORK_PROCESSOR_VERSION || parsed.source?.sha256 !== source.sha256) {
    throw new Error('Atlas Data Work returned an incompatible local result.');
  }
  if (contentFileFingerprint(source.file_path).sha256 !== source.sha256) {
    const error = new Error('The original file changed while Atlas was preparing this result.'); error.code = 'ATLAS_STATE_CONFLICT'; throw error;
  }
  return parsed;
}

function relationshipInput(filePathInput, label) {
  if (!filePathInput) throw new Error(`content compare requires --${label} <path>`);
  const filePath = path.resolve(filePathInput);
  if (!fs.existsSync(filePath)) throw new Error(`Content comparison input does not exist: ${filePath}`);
  assertNoLinkTraversal(filePath);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Content comparison input must be a regular non-symbolic-link file: ${filePath}`);
  }
  return { filePath, hash: sha256File(filePath) };
}

function parseRelationshipCache(cachePath, leftHash, rightHash) {
  try {
    const stat = fs.lstatSync(cachePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null;
    const result = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (result.schema !== CONTENT_RELATIONSHIP_SCHEMA
        || result.processor?.version !== CONTENT_RELATIONSHIP_PROCESSOR_VERSION
        || result.sources?.left?.sha256 !== leftHash
        || result.sources?.right?.sha256 !== rightHash) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

export function compareContent({
  stateDir: stateDirInput,
  projectRoot,
  installationRoot,
  leftPath: leftPathInput,
  rightPath: rightPathInput,
  pythonPath = null,
  runProcess = spawnSync,
} = {}) {
  const left = relationshipInput(leftPathInput, 'left');
  const right = relationshipInput(rightPathInput, 'right');
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
    left_path: left.filePath,
    left_hash: left.hash,
    right_path: right.filePath,
    right_hash: right.hash,
    processor_version: CONTENT_RELATIONSHIP_PROCESSOR_VERSION,
  })).digest('hex');
  const relationshipId = `REL-${cacheKey.slice(0, 24)}`;
  const cacheDirectory = path.join(path.resolve(stateDirInput), 'tmp', 'content-relationships');
  const cachePath = path.join(cacheDirectory, `${cacheKey}.json`);
  const cached = fs.existsSync(cachePath)
    ? parseRelationshipCache(cachePath, left.hash, right.hash)
    : null;
  if (cached) {
    return {
      ...cached,
      relationship_id: relationshipId,
      cache_hit: true,
      cache_path: cachePath,
    };
  }

  const executable = pythonPath ?? locateContentPython({ installationRoot });
  if (!executable) {
    const error = new Error(
      'Atlas local content comparison requires the installed Desktop Python component. Run atlas ui install first.',
    );
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const pythonSourceRoot = path.join(projectRoot, 'python', 'src');
  if (!fs.existsSync(path.join(pythonSourceRoot, 'atlas_content', '__main__.py'))) {
    throw new Error('Atlas local content Python source is missing from the Runtime.');
  }
  const result = runProcess(executable, [
    '-m', 'atlas_content', 'compare',
    '--left', left.filePath,
    '--right', right.filePath,
    '--expected-left-sha256', left.hash,
    '--expected-right-sha256', right.hash,
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PYTHONPATH: [pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Atlas local content comparison failed: ${
        result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`
      }`,
    );
  }
  let relationship;
  try {
    relationship = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`Atlas local content comparison returned invalid JSON: ${error.message}`);
  }
  if (relationship.schema !== CONTENT_RELATIONSHIP_SCHEMA
      || relationship.processor?.version !== CONTENT_RELATIONSHIP_PROCESSOR_VERSION
      || relationship.sources?.left?.sha256 !== left.hash
      || relationship.sources?.right?.sha256 !== right.hash) {
    throw new Error('Atlas local content comparison returned an incompatible or stale result.');
  }
  if (sha256File(left.filePath) !== left.hash || sha256File(right.filePath) !== right.hash) {
    const error = new Error('Content comparison input changed during local analysis; retry with current files.');
    error.code = 'ATLAS_STATE_CONFLICT';
    throw error;
  }

  fs.mkdirSync(cacheDirectory, { recursive: true });
  const temporary = `${cachePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(relationship, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, cachePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return {
    ...relationship,
    relationship_id: relationshipId,
    cache_hit: false,
    cache_path: cachePath,
  };
}

function validBranchResult(result, sources) {
  if (result?.schema !== CHAT_BRANCH_SET_SCHEMA
      || result.processor?.version !== CHAT_BRANCH_PROCESSOR_VERSION
      || result.sources?.length !== sources.length) return false;
  for (const [index, source] of sources.entries()) {
    if (result.sources[index]?.path !== source.filePath
        || result.sources[index]?.sha256 !== source.hash) return false;
  }
  return (result.segments ?? []).every((segment) => (
    segment.path && fs.existsSync(segment.path) && sha256File(segment.path) === segment.sha256
  ));
}

function validBranchCache(cachePath, sources) {
  try {
    const result = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return validBranchResult(result, sources) ? result : null;
  } catch {
    return null;
  }
}

export function compareContentBranches({
  stateDir: stateDirInput,
  projectRoot,
  installationRoot,
  filePaths = [],
  pythonPath = null,
  runProcess = spawnSync,
} = {}) {
  if (!Array.isArray(filePaths) || filePaths.length < 2 || filePaths.length > 12) {
    throw new Error('content branches requires 2 to 12 --file <path> inputs');
  }
  const sources = filePaths.map((filePath, index) => ({
    ...relationshipInput(filePath, `file-${index + 1}`),
    sourceId: `source-${index + 1}`,
  }));
  if (new Set(sources.map((source) => source.filePath.toLowerCase())).size !== sources.length) {
    throw new Error('content branches requires distinct input files');
  }
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
    sources: sources.map((source) => ({ path: source.filePath, hash: source.hash })),
    processor_version: CHAT_BRANCH_PROCESSOR_VERSION,
  })).digest('hex');
  const branchSetId = `BRN-${cacheKey.slice(0, 24)}`;
  const cacheDirectory = path.join(path.resolve(stateDirInput), 'tmp', 'content-branch-sets');
  const cachePath = path.join(cacheDirectory, `${cacheKey}.json`);
  const cached = fs.existsSync(cachePath) ? validBranchCache(cachePath, sources) : null;
  if (cached) return { ...cached, branch_set_id: branchSetId, cache_hit: true, cache_path: cachePath };

  const executable = pythonPath ?? locateContentPython({ installationRoot });
  if (!executable) {
    const error = new Error(
      'Atlas local chat branch analysis requires the installed Desktop Python component. Run atlas ui install first.',
    );
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const pythonSourceRoot = path.join(projectRoot, 'python', 'src');
  if (!fs.existsSync(path.join(pythonSourceRoot, 'atlas_content', '__main__.py'))) {
    throw new Error('Atlas local content Python source is missing from the Runtime.');
  }
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const requestPath = path.join(cacheDirectory, `${cacheKey}.request.json`);
  const outputDirectory = path.join(cacheDirectory, `${cacheKey}.segments`);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.writeFileSync(requestPath, JSON.stringify({
    sources: sources.map((source) => ({
      source_id: source.sourceId,
      path: source.filePath,
      sha256: source.hash,
    })),
  }), 'utf8');
  let processResult;
  try {
    processResult = runProcess(executable, [
      '-m', 'atlas_content', 'branches',
      '--request', requestPath,
      '--output-dir', outputDirectory,
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONPATH: [pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(requestPath, { force: true });
  }
  if (processResult.error || processResult.status !== 0) {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    throw new Error(
      `Atlas local chat branch analysis failed: ${
        processResult.error?.message ?? processResult.stderr?.trim() ?? `exit ${processResult.status}`
      }`,
    );
  }
  let analysis;
  try {
    analysis = JSON.parse(processResult.stdout.trim());
  } catch (error) {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    throw new Error(`Atlas local chat branch analysis returned invalid JSON: ${error.message}`);
  }
  if (!validBranchResult(analysis, sources)) {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    throw new Error('Atlas local chat branch analysis returned an incompatible result.');
  }
  if (sources.some((source) => sha256File(source.filePath) !== source.hash)) {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    const error = new Error('Chat branch input changed during local analysis; retry with current files.');
    error.code = 'ATLAS_STATE_CONFLICT';
    throw error;
  }
  fs.writeFileSync(cachePath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  return { ...analysis, branch_set_id: branchSetId, cache_hit: false, cache_path: cachePath };
}
