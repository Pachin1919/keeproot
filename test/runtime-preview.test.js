import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

test('preview retains a nonzero locate receipt and its specific remedy', { skip: process.platform !== 'win32' }, () => {
  const source = fs.readFileSync('start-preview.ps1', 'utf8');
  const start = source.indexOf('$previewLocationText =');
  const end = source.indexOf('# This pointer', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  for (const status of ['runtime_required', 'integrity_error', 'incompatible_protocol', 'timeout', 'doctor_failed']) {
    const receipt = JSON.stringify({ status, message: `${status} at capabilities`, next_step: `inspect ${status}` });
    const script = `
$ErrorActionPreference = 'Stop'
$previewNode = 'Invoke-Locator'
$previewManager = 'unused'
$previewRoot = 'unused'
function Invoke-Locator { $global:LASTEXITCODE = 1; '${receipt}' }
try {
${block}
  throw 'Unexpected continuation'
} catch { [Console]::WriteLine($_.Exception.Message) }
`;
    const result = spawnSync(process.env.PWSH_PATH || 'powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`${status} at capabilities`), result.stdout);
    assert.ok(result.stdout.includes(`Next: inspect ${status}`), result.stdout);
    assert.equal(result.stdout.includes('Use -Install for the first installation'), false);
  }
});
