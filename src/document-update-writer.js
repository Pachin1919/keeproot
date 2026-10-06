import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateContentPython } from './python-runtime.js';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => Object.assign(new Error(message), { code: 'ATLAS_STATE_CONFLICT' });
export function documentUpdateWrite(input, { installationRoot = process.env.ATLAS_HOME ?? runtimeRoot,
  runProcess = spawnSync } = {}) {
  const executable = locateContentPython({ installationRoot });
  if (!executable) throw fail('Document Update requires the content Python runtime.');
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 2 * 1024 * 1024) throw fail('Document Update writer input is too large.');
  const result = runProcess(executable, ['-B', '-X', 'utf8', path.join(runtimeRoot, 'python', 'src', 'atlas_content', 'document_update_write.py')], {
    input: payload, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw fail(`Document Update writer failed: ${result.error.message}`);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw fail('Document Update writer returned invalid evidence.'); }
  if (result.status !== 0 || !value.ok) throw fail(value.error ?? 'Transactional Document Update is unsupported.');
  if (!/^[a-f0-9]{64}$/u.test(value.sha256 ?? '') || typeof value.file_id !== 'string'
    || typeof value.text !== 'string' || value.bytes !== Buffer.byteLength(value.text, 'utf8')) {
    throw fail('Document Update writer returned incomplete evidence.');
  }
  return value;
}
