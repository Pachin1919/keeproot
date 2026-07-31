import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { locateAnalyticsPython } from './analytics-evaluation.js';

export const CONTENT_INSPECTION_SCHEMA = 'atlas.content-inspection.v1';
export const CONTENT_PROCESSOR_VERSION = '0.2.0';

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

export function inspectContent({
  stateDir: stateDirInput,
  projectRoot,
  installationRoot,
  filePath: filePathInput,
  purpose = 'content',
  sheet = null,
  maxCharacters = 4000,
  pythonPath = null,
  runProcess = spawnSync,
} = {}) {
  if (!['structure', 'content', 'data', 'visual'].includes(purpose)) {
    throw new Error('content inspect --purpose must be structure, content, data, or visual');
  }
  if (!Number.isInteger(maxCharacters) || maxCharacters < 500 || maxCharacters > 20_000) {
    throw new Error('content inspect --max-characters must be an integer from 500 to 20000');
  }
  if (!filePathInput) throw new Error('content inspect requires --file <path>');
  const filePath = path.resolve(filePathInput);
  if (!fs.existsSync(filePath)) throw new Error(`Content input does not exist: ${filePath}`);
  assertNoLinkTraversal(filePath);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Content input must be a regular non-symbolic-link file: ${filePath}`);
  }

  const sourceHash = sha256File(filePath);
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
    source_path: filePath,
    source_hash: sourceHash,
    purpose,
    sheet,
    max_characters: maxCharacters,
    processor_version: CONTENT_PROCESSOR_VERSION,
  })).digest('hex');
  const inspectionId = `CIN-${cacheKey.slice(0, 24)}`;
  const cacheDirectory = path.join(path.resolve(stateDirInput), 'tmp', 'content-inspections');
  const cachePath = path.join(cacheDirectory, `${cacheKey}.json`);
  const cached = fs.existsSync(cachePath)
    ? parseCached(cachePath, sourceHash, purpose, maxCharacters, sheet)
    : null;
  if (cached) {
    return {
      ...cached,
      inspection_id: inspectionId,
      cache_hit: true,
      cache_path: cachePath,
    };
  }

  const executable = pythonPath ?? locateAnalyticsPython({ installationRoot });
  if (!executable) {
    const error = new Error(
      'Atlas local content inspection requires the optional Python component. Run atlas analytics install first.',
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
    purpose,
    ...(sheet ? ['--sheet', sheet] : []),
    '--max-characters',
    String(maxCharacters),
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

  fs.mkdirSync(cacheDirectory, { recursive: true });
  const temporary = `${cachePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(inspection, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, cachePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return {
    ...inspection,
    inspection_id: inspectionId,
    cache_hit: false,
    cache_path: cachePath,
  };
}
