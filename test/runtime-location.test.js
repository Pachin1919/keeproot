import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installRuntime } from '../src/runtime-install.js';
import { handshakeRuntime } from '../src/runtime-location.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function setup(name) {
  const root = path.join(tempRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test('user-level locator handshakes with an installed runtime outside any target project', () => {
  const root = setup('runtime-locator-ready');
  const installRoot = path.join(root, 'Atlas Runtime');
  const skillRoot = path.join(root, '.codex', 'skills', 'atlas-file-governance');
  installRuntime({ sourceRoot: projectRoot, installRoot, skillRoot, nodePath: process.execPath });
  const result = handshakeRuntime({ installRoot, timeoutMs: 10_000 });
  assert.equal(result.status, 'ready');
  assert.equal(result.protocol_version, 'atlas-cli.v1');
  assert.equal(result.doctor.status, 'ok');
  assert.equal(result.skill_root, skillRoot);

  if (process.platform === 'win32') {
    const powershell = process.env.PWSH_PATH || 'powershell.exe';
    const located = spawnSync(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(skillRoot, 'scripts', 'locate-atlas.ps1'), '-InstallRoot', installRoot,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.equal(located.status, 0, located.stderr || located.stdout);
    const location = JSON.parse(located.stdout);
    assert.equal(location.status, 'ready');
    assert.equal(location.launcher_path, path.join(installRoot, 'atlas.cmd'));
    const launcher = fs.readFileSync(location.launcher_path, 'utf8');
    assert.match(launcher, /ATLAS_HOME=/u);
    assert.match(launcher, /ATLAS_STATE_DIR=/u);
  }
});

test('locator returns runtime_required and fails closed on old protocol, non-JSON, or timeout', () => {
  const root = setup('runtime-locator-failures');
  assert.equal(handshakeRuntime({ installRoot: path.join(root, 'missing') }).status, 'runtime_required');

  const manifest = {
    install_format: 'atlas-runtime-install.v1',
    atlas_version: '0.1.0',
    protocol_version: 'atlas-cli.v0',
    node_path: process.execPath,
    runtime_path: root,
    state_path: path.join(root, 'state'),
    skill_path: path.join(root, 'skill'),
  };
  fs.writeFileSync(path.join(root, 'atlas-install.json'), JSON.stringify(manifest), 'utf8');
  assert.equal(handshakeRuntime({ installRoot: root }).status, 'incompatible_protocol');

  manifest.protocol_version = 'atlas-cli.v1';
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(manifest.skill_path, { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'atlas.js'), '', 'utf8');
  fs.writeFileSync(path.join(root, 'atlas.cmd'), '', 'utf8');
  fs.writeFileSync(path.join(root, 'atlas-ui.cmd'), '', 'utf8');
  fs.writeFileSync(path.join(root, 'atlas-ui.ps1'), '', 'utf8');
  fs.writeFileSync(path.join(root, 'atlas-install.json'), JSON.stringify(manifest), 'utf8');
  const nonJson = handshakeRuntime({
    installRoot: root,
    invoke: () => ({ status: 0, stdout: 'not-json', stderr: '' }),
  });
  assert.equal(nonJson.status, 'invalid_response');

  const timeout = handshakeRuntime({
    installRoot: root,
    invoke: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }),
  });
  assert.equal(timeout.status, 'timeout');
});

test('an installed runtime refuses direct Node startup without the installed state binding', () => {
  const root = setup('runtime-direct-node-refused');
  const installRoot = path.join(root, 'Atlas Runtime');
  const skillRoot = path.join(root, '.codex', 'skills', 'atlas-file-governance');
  installRuntime({ sourceRoot: projectRoot, installRoot, skillRoot, nodePath: process.execPath });

  const direct = spawnSync(process.execPath, [
    path.join(installRoot, 'runtime', 'bin', 'atlas.js'), 'version', '--json',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ATLAS_HOME', 'ATLAS_STATE_DIR'].includes(key))),
  });

  assert.equal(direct.status, 1, direct.stderr || direct.stdout);
  const envelope = JSON.parse(direct.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'ATLAS_RUNTIME_ENTRYPOINT_REQUIRED');
  assert.equal(fs.existsSync(path.join(installRoot, 'runtime', '.atlas')), false);
});

function simulatedInstallation() {
  const root = setup('runtime-locator-stage-diagnostics');
  const installRoot = path.join(root, 'installation');
  installRuntime({ sourceRoot: projectRoot, installRoot, skillRoot: path.join(root, 'skill'), nodePath: process.execPath });
  return installRoot;
}

function response(command, data = {}) {
  return { status: 0, stderr: '', stdout: JSON.stringify({ protocol_version: 'atlas-cli.v1', ok: true, command, data }) };
}

test('locator applies stage budgets, reports diagnostics and preserves the explicit uniform override', () => {
  const installRoot = simulatedInstallation();
  for (const override of [undefined, 1234]) {
    const calls = [];
    const result = handshakeRuntime({ installRoot, timeoutMs: override, invoke(command, options) {
      calls.push([command, options.timeoutMs]);
      return response(command, command === 'doctor' ? { status: 'ok' } : {});
    } });
    assert.equal(result.status, 'ready');
    assert.deepEqual(calls, [['version', override ?? 15000], ['capabilities', override ?? 15000], ['doctor', override ?? 45000]]);
    assert.deepEqual(result.stages.map(stage => stage.command), ['locate', 'version', 'capabilities', 'doctor']);
    for (const stage of result.stages) {
      assert.equal(stage.status, 'ready');
      assert.ok(Number.isInteger(stage.elapsed_ms) && stage.elapsed_ms >= 0);
      assert.equal(stage.error_code, null);
    }
    assert.equal(result.stages.at(-1).timeout_ms, override ?? 45000);
  }
});

test('locator keeps each failure reason and stops at the failed command without retries', () => {
  const installRoot = simulatedInstallation();
  const failures = [
    ['invalid_response', () => ({ status: 0, stdout: 'not-json', stderr: '' })],
    ['incompatible_protocol', command => ({ ...response(command), stdout: JSON.stringify({ protocol_version: 'old' }) })],
    ['timeout', () => ({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } })],
    ['runtime_error', command => ({ ...response(command), status: 1, stderr: 'probe failed', error: { code: 'ENOENT' } })],
    ['doctor_failed', command => response(command, { status: 'failed', reason: 'dependency unavailable' })],
  ];
  for (const [status, failure] of failures) {
    const failedCommand = status === 'doctor_failed' ? 'doctor' : 'capabilities';
    const calls = [];
    const result = handshakeRuntime({ installRoot, invoke(command) {
      calls.push(command);
      return command === failedCommand ? failure(command) : response(command);
    } });
    assert.equal(result.status, status);
    assert.equal(result.command, failedCommand);
    assert.deepEqual(calls, failedCommand === 'doctor' ? ['version', 'capabilities', 'doctor'] : ['version', 'capabilities']);
    assert.equal(result.stages.at(-1).status, status);
    assert.ok(result.message && result.next_step);
    if (status === 'timeout') assert.equal(result.stages.at(-1).error_code, 'ETIMEDOUT');
    if (status === 'doctor_failed') assert.equal(result.doctor.reason, 'dependency unavailable');
  }
  let invoked = false;
  const missing = handshakeRuntime({ installRoot: path.join(installRoot, 'missing'), invoke() { invoked = true; } });
  assert.equal(missing.status, 'runtime_required');
  assert.equal(missing.stages[0].command, 'locate');
  assert.equal(invoked, false);
  assert.ok(missing.next_step);
});

test('locator reports JSON null and scalar responses without throwing or continuing', () => {
  const installRoot = simulatedInstallation();
  for (const stdout of ['null', '[]', 'true', '0']) {
    const calls = [];
    const result = handshakeRuntime({ installRoot, invoke(command) {
      calls.push(command);
      return command === 'capabilities' ? { status: 0, stderr: '', stdout } : response(command);
    } });
    assert.equal(result.status, 'invalid_response');
    assert.equal(result.command, 'capabilities');
    assert.deepEqual(calls, ['version', 'capabilities']);
    assert.equal(result.stages.at(-1).status, 'invalid_response');
    assert.ok(result.next_step);
  }
});
