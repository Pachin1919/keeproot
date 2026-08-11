import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  installRuntime,
  locateInstalledRuntime,
  probeNodeRuntime,
  uninstallRuntime,
} from '../src/runtime-install.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function setup(name) {
  const root = path.join(tempRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    installRoot: path.join(root, '用户 Atlas'),
    skillRoot: path.join(root, '用户 Skills', 'atlas-file-governance'),
    libraryRoot: path.join(root, '资料库'),
  };
}

test('Runtime installer is offline, user-scoped, idempotent, and keeps state outside the Library', () => {
  const scope = setup('runtime-install-chinese');
  fs.mkdirSync(scope.libraryRoot, { recursive: true });

  const first = installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
    libraryRoots: [scope.libraryRoot],
  });
  const second = installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
    libraryRoots: [scope.libraryRoot],
  });

  assert.equal(first.status, 'installed');
  assert.equal(second.status, 'already_installed');
  assert.equal(first.network_access, false);
  assert.ok(fs.existsSync(path.join(scope.installRoot, 'atlas.cmd')));
  assert.ok(fs.existsSync(path.join(scope.installRoot, 'atlas-ui.cmd')));
  assert.ok(fs.existsSync(path.join(scope.installRoot, 'runtime', 'bin', 'atlas.js')));
  assert.ok(fs.existsSync(path.join(scope.skillRoot, 'SKILL.md')));
  const located = locateInstalledRuntime(scope.installRoot);
  assert.deepEqual(located.manifest.node_args, ['--disable-warning=ExperimentalWarning']);
  assert.equal(located.integrity, 'verified');
  assert.match(located.manifest.runtime_sha256, /^[a-f0-9]{64}$/u);
  assert.match(located.manifest.skill_sha256, /^[a-f0-9]{64}$/u);
  assert.ok(!first.state_dir.startsWith(scope.libraryRoot));
  assert.equal(located.status, 'ready');
});

test('Runtime locate detects a changed installed bundle', () => {
  const scope = setup('runtime-integrity');
  installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
  });
  fs.appendFileSync(path.join(scope.installRoot, 'runtime', 'src', 'protocol.js'), '\n// changed\n', 'utf8');

  const located = locateInstalledRuntime(scope.installRoot);
  assert.equal(located.status, 'integrity_error');
  assert.equal(located.integrity, 'failed');
});

test('Runtime integrity ignores generated Python bytecode but still verifies installed source', () => {
  const scope = setup('runtime-python-cache');
  installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
  });
  const cache = path.join(
    scope.installRoot,
    'runtime',
    'python',
    'src',
    'atlas_content',
    '__pycache__',
  );
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'branches.cpython-314.pyc'), 'generated-bytecode', 'utf8');

  const located = locateInstalledRuntime(scope.installRoot);
  assert.equal(located.status, 'ready');
  assert.equal(located.integrity, 'verified');
});

test('Runtime installer rejects missing or old Node before writing installation files', () => {
  const scope = setup('runtime-node-prerequisite');
  assert.equal(probeNodeRuntime(path.join(scope.root, 'missing-node.exe')).status, 'missing');
  assert.throws(() => installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
    nodeVersion: '20.19.0',
  }), /Node\.js 24 or newer/);
  assert.equal(fs.existsSync(scope.installRoot), false);
});

test('Runtime upgrade rolls back the previous runtime and Skill when the swap fails', () => {
  const scope = setup('runtime-upgrade-rollback');
  installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
  });
  const runtimeFile = path.join(scope.installRoot, 'runtime', 'src', 'protocol.js');
  const oldRuntime = fs.readFileSync(runtimeFile);

  assert.throws(() => installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
    operation: 'upgrade',
    faultAt: 'after_runtime_swap',
  }), /Injected runtime upgrade failure/);

  assert.deepEqual(fs.readFileSync(runtimeFile), oldRuntime);
  assert.equal(locateInstalledRuntime(scope.installRoot).status, 'ready');
});

test('Runtime upgrade preserves an old Ledger and uninstall preserves all user state', () => {
  const scope = setup('runtime-state-preservation');
  installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
  });
  const stateFile = path.join(scope.installRoot, 'state', 'ledger.sqlite');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, 'old-ledger-bytes', 'utf8');

  const upgraded = installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
    operation: 'upgrade',
  });
  assert.equal(upgraded.status, 'upgraded');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'old-ledger-bytes');

  const removed = uninstallRuntime({ installRoot: scope.installRoot, skillRoot: scope.skillRoot });
  assert.equal(removed.status, 'uninstalled');
  assert.equal(fs.existsSync(path.join(scope.installRoot, 'runtime')), false);
  assert.equal(fs.existsSync(path.join(scope.installRoot, 'atlas-ui.cmd')), false);
  assert.equal(fs.existsSync(scope.skillRoot), false);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'old-ledger-bytes');
});

test('Runtime upgrade reports compatibility versions and refuses downgrade', () => {
  const scope = setup('runtime-version-compatibility');
  installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
  });
  const manifestPath = path.join(scope.installRoot, 'atlas-install.json');
  const older = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  older.atlas_version = '0.9.0';
  fs.writeFileSync(manifestPath, `${JSON.stringify(older, null, 2)}\n`, 'utf8');

  const upgraded = installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
    operation: 'upgrade',
  });
  assert.equal(upgraded.from_version, '0.9.0');
  assert.equal(upgraded.to_version, upgraded.atlas_version);

  const newer = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  newer.atlas_version = '999.0.0';
  fs.writeFileSync(manifestPath, `${JSON.stringify(newer, null, 2)}\n`, 'utf8');
  assert.throws(() => installRuntime({
    sourceRoot: projectRoot,
    installRoot: scope.installRoot,
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
    operation: 'upgrade',
  }), /refusing downgrade/i);
});

test('Runtime installer refuses installation or state inside a governed Library', () => {
  const scope = setup('runtime-library-boundary');
  fs.mkdirSync(scope.libraryRoot, { recursive: true });
  assert.throws(() => installRuntime({
    sourceRoot: projectRoot,
    installRoot: path.join(scope.libraryRoot, '.atlas-runtime'),
    skillRoot: scope.skillRoot,
    nodePath: process.execPath,
    libraryRoots: [scope.libraryRoot],
  }), /outside every governed Library/);
});
