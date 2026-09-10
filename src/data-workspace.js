import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { locateAnalyticsPython } from './analytics-evaluation.js';

// Host and Desktop consumers share this application service and the same Python
// delimited-file reader. Data Workspace is a local representation, not a second
// source of Workspace truth.

export const DATA_WORKSPACE_SCHEMA = 'atlas.data-workspace.v1';
export const DATA_WORKSPACE_PROCESSOR_VERSION = '0.2.3';

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

function exactRegularFile(filePathInput) {
  if (!filePathInput) throw new Error('content prepare-data requires --file <path>');
  const filePath = path.resolve(filePathInput);
  if (!fs.existsSync(filePath)) throw new Error(`Data input does not exist: ${filePath}`);
  let cursor = filePath;
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Data workspace cannot traverse a symbolic link or junction: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Data input must be a regular non-symbolic-link file: ${filePath}`);
  }
  return { filePath, hash: sha256File(filePath) };
}

function validWorkspace(result, sourceHash) {
  if (result?.schema !== DATA_WORKSPACE_SCHEMA
      || result.processor?.version !== DATA_WORKSPACE_PROCESSOR_VERSION
      || result.source?.sha256 !== sourceHash
      || !result.manifest_path
      || !fs.existsSync(result.manifest_path)) return false;
  return Object.values(result.files ?? {}).every((item) => (
    item?.path && fs.existsSync(item.path) && sha256File(item.path) === item.sha256
  ));
}

export function prepareDataWorkspace({
  stateDir: stateDirInput,
  projectRoot,
  installationRoot,
  filePath: filePathInput,
  sheet = null,
  pythonPath = null,
  runProcess = spawnSync,
} = {}) {
  const source = exactRegularFile(filePathInput);
  const extension = path.extname(source.filePath).toLowerCase();
  if (!['.csv', '.tsv', '.xlsx'].includes(extension)) {
    throw new Error('content prepare-data supports CSV, TSV, and one exact XLSX sheet');
  }
  if (extension === '.xlsx' && !sheet) {
    throw new Error('content prepare-data requires --sheet for XLSX input');
  }
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
    source_path: source.filePath,
    source_hash: source.hash,
    sheet,
    processor_version: DATA_WORKSPACE_PROCESSOR_VERSION,
  })).digest('hex');
  const workspaceId = `DWS-${cacheKey.slice(0, 24)}`;
  const outputDirectory = path.join(path.resolve(stateDirInput), 'work', 'data-workspaces', workspaceId);
  const receiptPath = path.join(outputDirectory, 'receipt.json');
  if (fs.existsSync(receiptPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (validWorkspace(cached, source.hash)) {
        return { ...cached, workspace_id: workspaceId, cache_hit: true, receipt_path: receiptPath };
      }
    } catch {
      // Rebuild an incomplete or stale local workspace.
    }
  }
  const executable = pythonPath ?? locateAnalyticsPython({ installationRoot });
  if (!executable) {
    const error = new Error(
      'Atlas local data workspace requires the optional Python component. Run atlas analytics install first.',
    );
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const pythonSourceRoot = path.join(projectRoot, 'python', 'src');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const processResult = runProcess(executable, [
    '-m', 'atlas_content', 'data-workspace',
    '--file', source.filePath,
    ...(sheet ? ['--sheet', sheet] : []),
    '--output-dir', outputDirectory,
    '--expected-sha256', source.hash,
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
      `Atlas local data workspace failed: ${
        processResult.error?.message ?? processResult.stderr?.trim() ?? `exit ${processResult.status}`
      }`,
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(processResult.stdout.trim());
  } catch (error) {
    throw new Error(`Atlas local data workspace returned invalid JSON: ${error.message}`);
  }
  if (!validWorkspace(receipt, source.hash)) {
    throw new Error('Atlas local data workspace returned incomplete or incompatible output.');
  }
  if (sha256File(source.filePath) !== source.hash) {
    const error = new Error('Data input changed during local preparation; retry with the current file.');
    error.code = 'ATLAS_STATE_CONFLICT';
    throw error;
  }
  const result = {
    ...receipt,
    workspace_id: workspaceId,
    cache_hit: false,
    receipt_path: receiptPath,
  };
  const temporary = `${receiptPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, receiptPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return result;
}
