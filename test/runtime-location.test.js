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
    assert.equal(JSON.parse(located.stdout).status, 'ready');
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
