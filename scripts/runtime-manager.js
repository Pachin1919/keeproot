#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installRuntime,
  locateInstalledRuntime,
  uninstallRuntime,
} from '../src/runtime-install.js';
import {
  codexHookStatus,
  installCodexHook,
  removeCodexHook,
} from '../src/codex-hook-install.js';
import { handshakeRuntime } from '../src/runtime-location.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultInstallRoot() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Atlas');
}

function defaultSkillRoot() {
  const skillsHome = process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'skills')
    : path.join(os.homedir(), '.codex', 'skills');
  return path.join(skillsHome, 'atlas-file-governance');
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function parse(args) {
  const result = { libraryRoots: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (['--install-root', '--skill-root', '--node', '--library-root', '--codex-home', '--project-root'].includes(token)) {
      const value = args[++index];
      if (value === undefined) throw new Error(`${token} requires a value.`);
      if (token === '--install-root') result.installRoot = value;
      else if (token === '--skill-root') result.skillRoot = value;
      else if (token === '--node') result.nodePath = value;
      else if (token === '--codex-home') result.codexHome = value;
      else if (token === '--project-root') result.projectRoot = value;
      else result.libraryRoots.push(value);
    } else {
      throw new Error(`Unknown Runtime manager argument: ${token}`);
    }
  }
  result.installRoot ??= defaultInstallRoot();
  result.skillRoot ??= defaultSkillRoot();
  result.nodePath ??= process.execPath;
  result.codexHome ??= defaultCodexHome();
  return result;
}

function usage() {
  return `Atlas Runtime manager

Usage:
  node scripts/runtime-manager.js install [options]
  node scripts/runtime-manager.js locate [options]
  node scripts/runtime-manager.js upgrade [options]
  node scripts/runtime-manager.js uninstall [options]
  node scripts/runtime-manager.js hook-install [options]
  node scripts/runtime-manager.js hook-status [options]
  node scripts/runtime-manager.js hook-remove [options]

Options:
  --install-root <path>  User Runtime/state root (default: %LOCALAPPDATA%\\Atlas)
  --skill-root <path>    User Skill directory (default: ~/.codex/skills/atlas-file-governance)
  --node <path>          Node.js 24+ executable
  --codex-home <path>    Codex user config root (default: ~/.codex)
  --project-root <path>  Install/status/remove a project-local Codex Hook
  --library-root <path>  Reject installation inside this governed Library; repeatable
`;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) {
    console.log(usage());
    return;
  }
  const options = parse(rest);
  let result;
  if (command === 'install' || command === 'upgrade') {
    result = installRuntime({ ...options, sourceRoot, operation: command });
  } else if (command === 'locate') {
    result = handshakeRuntime({ installRoot: options.installRoot });
  } else if (command === 'uninstall') {
    result = uninstallRuntime(options);
  } else if (['hook-install', 'hook-status', 'hook-remove'].includes(command)) {
    const located = locateInstalledRuntime(options.installRoot);
    if (command !== 'hook-remove' && located.status !== 'ready') {
      throw new Error(`Atlas Runtime must be ready before ${command}; current status is ${located.status}.`);
    }
    if (command === 'hook-install') {
      result = installCodexHook({
        codexHome: options.codexHome, manifest: located.manifest, projectRoot: options.projectRoot,
      });
    } else if (command === 'hook-status') {
      result = codexHookStatus({
        codexHome: options.codexHome, manifest: located.manifest, projectRoot: options.projectRoot,
      });
    } else {
      result = removeCodexHook({
        codexHome: options.codexHome, manifest: located.manifest, projectRoot: options.projectRoot,
      });
    }
  } else {
    throw new Error(`Unknown Runtime manager command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!['ready', 'installed', 'upgraded', 'already_installed', 'uninstalled', 'not_installed', 'removed'].includes(result.status)) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', message: error.message }, null, 2));
  process.exitCode = 1;
}
