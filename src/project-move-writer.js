import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateContentPython } from './python-runtime.js';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => Object.assign(new Error(message), { code: 'ATLAS_STATE_CONFLICT' });
export function projectMoveWrite(input, { installationRoot = process.env.ATLAS_HOME ?? runtimeRoot, runProcess = spawnSync } = {}) {
  const python = locateContentPython({ installationRoot });
  if (!python) throw fail('Project Move requires the content Python runtime.');
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw fail('Project Move request exceeds its limit.');
  const result = runProcess(python, ['-B', '-X', 'utf8', path.join(runtimeRoot, 'python/src/atlas_content/project_move.py')], {
    input: payload, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw fail(`Project Move writer failed: ${result.error.message}`);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw fail('Project Move writer returned invalid evidence.'); }
  if (result.status !== 0 || !value.ok || !value.manifest || !Number.isSafeInteger(value.bytes)) throw fail(value.error ?? 'Project Move writer returned incomplete evidence.');
  return value;
}
