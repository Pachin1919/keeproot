#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installRuntime,
  locateInstalledRuntime,
  uninstallRuntime,
} from '../src/runtime-install.js';
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

function parse(args) {
  const result = { libraryRoots: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (['--install-root', '--skill-root', '--node', '--library-root'].includes(token)) {
      const value = args[++index];
      if (value === undefined) throw new Error(`${token} requires a value.`);
      if (token === '--install-root') result.installRoot = value;
      else if (token === '--skill-root') result.skillRoot = value;
      else if (token === '--node') result.nodePath = value;
      else result.libraryRoots.push(value);
    } else {
      throw new Error(`Unknown Runtime manager argument: ${token}`);
    }
  }
  result.installRoot ??= defaultInstallRoot();
  result.skillRoot ??= defaultSkillRoot();
  result.nodePath ??= process.execPath;
  return result;
}

function usage() {
  return `Atlas Runtime manager

Usage:
  node scripts/runtime-manager.js install [options]
  node scripts/runtime-manager.js locate [options]
  node scripts/runtime-manager.js upgrade [options]
  node scripts/runtime-manager.js uninstall [options]

Options:
  --install-root <path>  User Runtime/state root (default: %LOCALAPPDATA%\\Atlas)
  --skill-root <path>    User Skill directory (default: ~/.codex/skills/atlas-file-governance)
  --node <path>          Node.js 24+ executable
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
  } else {
    throw new Error(`Unknown Runtime manager command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!['ready', 'installed', 'upgraded', 'already_installed', 'uninstalled'].includes(result.status)) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', message: error.message }, null, 2));
  process.exitCode = 1;
}
