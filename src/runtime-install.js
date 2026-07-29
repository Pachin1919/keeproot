import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ATLAS_VERSION, PROTOCOL_VERSION } from './protocol.js';
import { isPathInside } from './paths.js';

export const INSTALL_FORMAT = 'atlas-runtime-install.v1';
export const MINIMUM_NODE_MAJOR = 24;
const MANIFEST_NAME = 'atlas-install.json';

function absolute(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return path.resolve(value);
}

function assertPlainPath(value, label) {
  if (/[%"\r\n]/u.test(value)) {
    throw new Error(`${label} contains a character that cannot be represented safely in atlas.cmd: ${value}`);
  }
}

function nodeMajor(version) {
  const match = String(version ?? '').trim().match(/^v?(\d+)(?:\.|$)/u);
  return match ? Number(match[1]) : null;
}

function versionParts(version) {
  const match = String(version ?? '').trim().match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u,
  );
  if (!match) throw new Error(`Atlas version is not valid SemVer: ${version}`);
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ?? null,
  };
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease == null) return 1;
  if (b.prerelease == null) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en');
}

function directoryHash(root) {
  const hash = crypto.createHash('sha256');
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Atlas installation bundle cannot contain a symbolic link: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Atlas installation bundle contains an unsupported entry: ${absolutePath}`);
      }
      const relative = path.relative(root, absolutePath).replaceAll('\\', '/');
      const content = fs.readFileSync(absolutePath);
      hash.update(relative, 'utf8');
      hash.update('\0');
      hash.update(String(content.length), 'utf8');
      hash.update('\0');
      hash.update(content);
    }
  };
  visit(root);
  return hash.digest('hex');
}

export function probeNodeRuntime(nodePath = process.execPath) {
  const resolved = path.resolve(nodePath);
  if (!fs.existsSync(resolved)) return { status: 'missing', node_path: resolved };
  const result = spawnSync(resolved, ['--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    return { status: 'unavailable', node_path: resolved, message: result.error?.message ?? result.stderr.trim() };
  }
  const version = result.stdout.trim().replace(/^v/u, '');
  const major = nodeMajor(version);
  return {
    status: major >= MINIMUM_NODE_MAJOR ? 'ready' : 'old',
    node_path: resolved,
    version,
    major,
    minimum_major: MINIMUM_NODE_MAJOR,
  };
}

function assertOutsideLibraries(installRoot, stateDir, libraryRoots) {
  for (const library of libraryRoots ?? []) {
    const root = path.resolve(library);
    if (isPathInside(root, installRoot) || isPathInside(root, stateDir)) {
      throw new Error(`Atlas Runtime and state must remain outside every governed Library: ${root}`);
    }
  }
}

function copyRuntime(sourceRoot, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const relative of ['bin', 'src', 'schemas', 'python/src', 'python/pyproject.toml', 'package.json']) {
    const source = path.join(sourceRoot, relative);
    if (!fs.existsSync(source)) throw new Error(`Runtime source is incomplete: ${source}`);
    fs.cpSync(source, path.join(target, relative), { recursive: true, force: true });
  }
}

function copySkill(sourceRoot, target) {
  const source = path.join(sourceRoot, '.agents', 'skills', 'atlas-file-governance');
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`Atlas Skill source is missing: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

function safeRemove(target, allowedParent) {
  if (!target || !isPathInside(allowedParent, target) || path.resolve(target) === path.resolve(allowedParent)) {
    throw new Error(`Refusing to remove an unverified runtime path: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function swapDirectory(stage, target, backup) {
  if (fs.existsSync(backup)) safeRemove(backup, path.dirname(backup));
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  fs.renameSync(stage, target);
}

function restoreDirectory(target, backup) {
  if (fs.existsSync(target)) safeRemove(target, path.dirname(target));
  if (fs.existsSync(backup)) fs.renameSync(backup, target);
}

function manifestFor({
  installRoot,
  skillRoot,
  nodePath,
  runtimeSha256,
  skillSha256,
}) {
  return {
    install_format: INSTALL_FORMAT,
    atlas_version: ATLAS_VERSION,
    protocol_version: PROTOCOL_VERSION,
    minimum_node_major: MINIMUM_NODE_MAJOR,
    node_path: nodePath,
    node_args: ['--disable-warning=ExperimentalWarning'],
    runtime_path: path.join(installRoot, 'runtime'),
    state_path: path.join(installRoot, 'state'),
    skill_path: skillRoot,
    runtime_sha256: runtimeSha256,
    skill_sha256: skillSha256,
  };
}

function wrapperText(manifest) {
  return [
    '@echo off',
    `set "ATLAS_HOME=${path.dirname(manifest.runtime_path)}"`,
    `set "ATLAS_STATE_DIR=${manifest.state_path}"`,
    `"${manifest.node_path}" ${manifest.node_args.join(' ')} "${path.join(manifest.runtime_path, 'bin', 'atlas.js')}" %*`,
    '',
  ].join('\r\n');
}

export function locateInstalledRuntime(installRootInput) {
  const installRoot = path.resolve(installRootInput);
  const manifestPath = path.join(installRoot, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return { status: 'runtime_required', install_root: installRoot };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { status: 'invalid_manifest', install_root: installRoot, message: error.message };
  }
  if (manifest.install_format !== INSTALL_FORMAT) {
    return { status: 'invalid_manifest', install_root: installRoot, manifest };
  }
  if (manifest.protocol_version !== PROTOCOL_VERSION) {
    return {
      status: 'incompatible_protocol', install_root: installRoot, manifest,
      expected_protocol: PROTOCOL_VERSION, received_protocol: manifest.protocol_version,
    };
  }
  const required = [manifest.node_path, path.join(manifest.runtime_path, 'bin', 'atlas.js'), manifest.skill_path];
  if (required.some((entry) => !entry || !fs.existsSync(entry))) {
    return { status: 'runtime_required', install_root: installRoot, manifest };
  }
  if (manifest.runtime_sha256 && manifest.skill_sha256) {
    let runtimeSha256;
    let skillSha256;
    try {
      runtimeSha256 = directoryHash(manifest.runtime_path);
      skillSha256 = directoryHash(manifest.skill_path);
    } catch (error) {
      return {
        status: 'integrity_error',
        integrity: 'failed',
        install_root: installRoot,
        manifest,
        message: error.message,
      };
    }
    if (runtimeSha256 !== manifest.runtime_sha256 || skillSha256 !== manifest.skill_sha256) {
      return {
        status: 'integrity_error',
        integrity: 'failed',
        install_root: installRoot,
        manifest,
        expected: {
          runtime_sha256: manifest.runtime_sha256,
          skill_sha256: manifest.skill_sha256,
        },
        actual: {
          runtime_sha256: runtimeSha256,
          skill_sha256: skillSha256,
        },
      };
    }
    return {
      status: 'ready',
      integrity: 'verified',
      install_root: installRoot,
      manifest,
    };
  }
  return {
    status: 'ready',
    integrity: 'unverified',
    install_root: installRoot,
    manifest,
  };
}

export function installRuntime(options) {
  const sourceRoot = absolute(options.sourceRoot, 'sourceRoot');
  const installRoot = absolute(options.installRoot, 'installRoot');
  const skillRoot = absolute(options.skillRoot, 'skillRoot');
  const nodePath = absolute(options.nodePath ?? process.execPath, 'nodePath');
  const operation = options.operation ?? 'install';
  if (!['install', 'upgrade'].includes(operation)) throw new Error(`Unsupported Runtime operation: ${operation}`);
  for (const [value, label] of [[installRoot, 'installRoot'], [skillRoot, 'skillRoot'], [nodePath, 'nodePath']]) {
    assertPlainPath(value, label);
  }
  const stateDir = path.join(installRoot, 'state');
  assertOutsideLibraries(installRoot, stateDir, options.libraryRoots);
  const probe = probeNodeRuntime(nodePath);
  const version = options.nodeVersion ?? probe.version;
  if (probe.status === 'missing' || probe.status === 'unavailable' || nodeMajor(version) < MINIMUM_NODE_MAJOR) {
    throw new Error(`Atlas requires Node.js 24 or newer; supplied Runtime is ${version ?? probe.status}.`);
  }

  const existing = locateInstalledRuntime(installRoot);
  const existingVersion = existing.manifest?.atlas_version ?? null;
  if (operation === 'upgrade' && existing.manifest) {
    if (existing.manifest.protocol_version !== PROTOCOL_VERSION) {
      throw new Error(
        `Atlas protocol ${existing.manifest.protocol_version} cannot be upgraded by ${PROTOCOL_VERSION}.`,
      );
    }
    if (compareVersions(existingVersion, ATLAS_VERSION) > 0) {
      throw new Error(`Refusing downgrade from Atlas ${existingVersion} to ${ATLAS_VERSION}.`);
    }
  }
  if (operation === 'install' && existing.status === 'ready'
      && existing.integrity === 'verified'
      && existing.manifest.atlas_version === ATLAS_VERSION
      && path.resolve(existing.manifest.skill_path) === skillRoot) {
    return {
      status: 'already_installed', install_root: installRoot, state_dir: stateDir,
      skill_root: skillRoot, network_access: false,
    };
  }

  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const runtimeStage = path.join(installRoot, `.runtime-stage-${nonce}`);
  const runtimeBackup = path.join(installRoot, `.runtime-backup-${nonce}`);
  const skillParent = path.dirname(skillRoot);
  const skillStage = path.join(skillParent, `.atlas-skill-stage-${nonce}`);
  const skillBackup = path.join(skillParent, `.atlas-skill-backup-${nonce}`);
  const runtimeTarget = path.join(installRoot, 'runtime');
  const manifestPath = path.join(installRoot, MANIFEST_NAME);
  const wrapperPath = path.join(installRoot, 'atlas.cmd');
  const oldManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null;
  const oldWrapper = fs.existsSync(wrapperPath) ? fs.readFileSync(wrapperPath) : null;
  let runtimeSwapped = false;
  let skillSwapped = false;
  try {
    copyRuntime(sourceRoot, runtimeStage);
    copySkill(sourceRoot, skillStage);
    const runtimeSha256 = directoryHash(runtimeStage);
    const skillSha256 = directoryHash(skillStage);
    swapDirectory(runtimeStage, runtimeTarget, runtimeBackup);
    runtimeSwapped = true;
    if (options.faultAt === 'after_runtime_swap') throw new Error('Injected runtime upgrade failure after Runtime swap.');
    swapDirectory(skillStage, skillRoot, skillBackup);
    skillSwapped = true;
    if (options.faultAt === 'after_skill_swap') throw new Error('Injected runtime upgrade failure after Skill swap.');
    const manifest = manifestFor({
      installRoot,
      skillRoot,
      nodePath,
      runtimeSha256,
      skillSha256,
    });
    fs.writeFileSync(wrapperPath, wrapperText(manifest), 'utf8');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (fs.existsSync(runtimeBackup)) safeRemove(runtimeBackup, installRoot);
    if (fs.existsSync(skillBackup)) safeRemove(skillBackup, skillParent);
    return {
      status: existing.status === 'ready' ? 'upgraded' : 'installed',
      install_root: installRoot,
      state_dir: stateDir,
      skill_root: skillRoot,
      wrapper: wrapperPath,
      atlas_version: ATLAS_VERSION,
      from_version: existingVersion,
      to_version: ATLAS_VERSION,
      protocol_version: PROTOCOL_VERSION,
      runtime_sha256: runtimeSha256,
      skill_sha256: skillSha256,
      network_access: false,
    };
  } catch (error) {
    if (skillSwapped) restoreDirectory(skillRoot, skillBackup);
    else if (fs.existsSync(skillStage)) safeRemove(skillStage, skillParent);
    if (runtimeSwapped) restoreDirectory(runtimeTarget, runtimeBackup);
    else if (fs.existsSync(runtimeStage)) safeRemove(runtimeStage, installRoot);
    if (oldManifest) fs.writeFileSync(manifestPath, oldManifest);
    else fs.rmSync(manifestPath, { force: true });
    if (oldWrapper) fs.writeFileSync(wrapperPath, oldWrapper);
    else fs.rmSync(wrapperPath, { force: true });
    throw error;
  }
}

export function uninstallRuntime({ installRoot: installRootInput, skillRoot: skillRootInput }) {
  const installRoot = absolute(installRootInput, 'installRoot');
  const located = locateInstalledRuntime(installRoot);
  const skillRoot = path.resolve(skillRootInput ?? located.manifest?.skill_path ?? path.join(installRoot, 'missing-skill'));
  const runtime = path.join(installRoot, 'runtime');
  if (fs.existsSync(runtime)) safeRemove(runtime, installRoot);
  if (fs.existsSync(skillRoot)) safeRemove(skillRoot, path.dirname(skillRoot));
  fs.rmSync(path.join(installRoot, MANIFEST_NAME), { force: true });
  fs.rmSync(path.join(installRoot, 'atlas.cmd'), { force: true });
  return {
    status: 'uninstalled',
    install_root: installRoot,
    state_preserved: fs.existsSync(path.join(installRoot, 'state')),
    state_dir: path.join(installRoot, 'state'),
  };
}
