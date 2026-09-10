import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { locateAnalyticsPython } from './analytics-evaluation.js';
import { prepareDataWorkspace } from './data-workspace.js';

export const CONTEXT_PACK_SCHEMA = 'atlas.context-pack.v1';
export const CONTEXT_PACK_PROCESSOR_VERSION = '0.1.0';

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

function validPack(result, expectedId, expectedSourceHash) {
  if (result?.schema !== CONTEXT_PACK_SCHEMA
      || result.processor?.version !== CONTEXT_PACK_PROCESSOR_VERSION
      || result.context_pack_id !== expectedId
      || result.source?.sha256 !== expectedSourceHash
      || !result.manifest_path
      || !fs.existsSync(result.manifest_path)) return false;
  return Object.values(result.files ?? {}).every((item) => (
    item?.path && fs.existsSync(item.path) && sha256File(item.path) === item.sha256
  ));
}

export function prepareContextPack({
  stateDir,
  projectRoot,
  installationRoot,
  filePath,
  sheet = null,
  purpose,
  includeColumns = [],
  pythonPath = null,
  runProcess = spawnSync,
} = {}) {
  if (!purpose?.trim()) throw new Error('content prepare-context requires --purpose <task purpose>');
  const columns = includeColumns.map((item) => item?.trim()).filter(Boolean);
  if (!columns.length) {
    throw new Error('content prepare-context requires one or more --include-column <exact name>');
  }
  if (columns.length > 64) throw new Error('content prepare-context accepts at most 64 included columns');
  const sourceCache = prepareDataWorkspace({
    stateDir, projectRoot, installationRoot, filePath, sheet, pythonPath, runProcess,
  });
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
    source_cache_id: sourceCache.workspace_id,
    source_hash: sourceCache.source.sha256,
    purpose: purpose.trim(),
    include_columns: columns,
    processor_version: CONTEXT_PACK_PROCESSOR_VERSION,
  })).digest('hex');
  const contextPackId = `CTX-${cacheKey.slice(0, 24)}`;
  const outputDirectory = path.join(path.resolve(stateDir), 'work', 'context-packs', contextPackId);
  const manifestPath = path.join(outputDirectory, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const cachedResult = { ...cached, manifest_path: manifestPath };
      if (validPack(cachedResult, contextPackId, sourceCache.source.sha256)) {
        return {
          ...cachedResult,
          source_cache_id: sourceCache.workspace_id,
          source_cache_hit: sourceCache.cache_hit,
          context_cache_hit: true,
        };
      }
    } catch {
      // Rebuild an incomplete or stale Context Pack.
    }
  }
  const executable = pythonPath ?? locateAnalyticsPython({ installationRoot });
  if (!executable) {
    const error = new Error(
      'Atlas Context Pack requires the optional Python component. Run atlas analytics install first.',
    );
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  const pythonSourceRoot = path.join(projectRoot, 'python', 'src');
  const sourceManifestHash = sha256File(sourceCache.manifest_path);
  const processResult = runProcess(executable, [
    '-m', 'atlas_content', 'context-pack',
    '--source-manifest', sourceCache.manifest_path,
    '--output-dir', outputDirectory,
    '--pack-id', contextPackId,
    '--purpose', purpose.trim(),
    ...columns.flatMap((column) => ['--include-column', column]),
    '--expected-manifest-sha256', sourceManifestHash,
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
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (processResult.error || processResult.status !== 0) {
    throw new Error(
      `Atlas Context Pack failed: ${
        processResult.error?.message ?? processResult.stderr?.trim() ?? `exit ${processResult.status}`
      }`,
    );
  }
  let result;
  try {
    result = JSON.parse(processResult.stdout.trim());
  } catch (error) {
    throw new Error(`Atlas Context Pack returned invalid JSON: ${error.message}`);
  }
  if (!validPack(result, contextPackId, sourceCache.source.sha256)) {
    throw new Error('Atlas Context Pack returned incomplete or incompatible output.');
  }
  return {
    ...result,
    source_cache_id: sourceCache.workspace_id,
    source_cache_hit: sourceCache.cache_hit,
    context_cache_hit: false,
  };
}

export function compactContextPackReceipt(result) {
  return {
    schema: result.schema,
    status: result.status,
    context_pack_id: result.context_pack_id,
    source_cache_id: result.source_cache_id,
    source_cache_hit: result.source_cache_hit,
    context_cache_hit: result.context_cache_hit,
    purpose: result.purpose,
    source: { name: result.source?.name, sha256: result.source?.sha256 },
    selection: result.selection,
    excluded: result.excluded,
    quality: result.quality,
    uncertainty: result.uncertainty,
    model_input: result.model_input,
    review_path: result.files?.review?.path ?? null,
    attention: result.attention,
    elapsed_ms: result.elapsed_ms,
  };
}
