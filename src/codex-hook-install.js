import fs from 'node:fs';
import path from 'node:path';

export const ATLAS_CODEX_HOOK_ID = 'atlas-session-context-v1';

function quoted(value) {
  return `"${String(value).replace(/"/gu, '\\"')}"`;
}

function hookHandler({ nodePath, runtimePath, statePath }) {
  const command = [
    quoted(nodePath),
    '--disable-warning=ExperimentalWarning',
    quoted(path.join(runtimePath, 'bin', 'atlas-codex-hook.js')),
    '--state-dir',
    quoted(statePath),
    '--atlas-hook-id',
    ATLAS_CODEX_HOOK_ID,
  ].join(' ');
  return {
    type: 'command',
    command,
    commandWindows: command,
    timeout: 5,
    statusMessage: 'Loading Atlas project context',
    additionalContextLimit: 900,
  };
}

function isAtlasHandler(handler) {
  return handler?.type === 'command'
    && [handler.command, handler.commandWindows].some((value) => (
      typeof value === 'string' && value.includes(ATLAS_CODEX_HOOK_ID)
    ));
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return { hooks: {} };
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex hooks.json must contain a JSON object.');
  }
  parsed.hooks ??= {};
  if (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks)) {
    throw new Error('Codex hooks.json hooks field must contain an object.');
  }
  return parsed;
}

function atomicWrite(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.atlas-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function hookTarget(codexHome, projectRoot = null) {
  if (!projectRoot) {
    return {
      scope: 'user',
      project_root: null,
      config_path: path.join(path.resolve(codexHome), 'hooks.json'),
    };
  }
  const resolved = path.resolve(projectRoot);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Codex project root is not an existing directory: ${resolved}`);
  }
  if (fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`Codex project root cannot be a symbolic link: ${resolved}`);
  }
  return {
    scope: 'project',
    project_root: resolved,
    config_path: path.join(resolved, '.codex', 'hooks.json'),
  };
}

function trustStatus(codexHome, hookPath) {
  const configToml = path.join(path.resolve(codexHome), 'config.toml');
  if (!fs.existsSync(configToml)) return { status: 'untrusted', config_path: configToml };
  const raw = fs.readFileSync(configToml, 'utf8');
  const normalizedHook = hookPath.replace(/\\/gu, '/').toLowerCase();
  const sections = raw.split(/(?=^\s*\[)/gmu);
  const trusted = sections.some((section) => {
    const header = section.split(/\r?\n/u, 1)[0].replace(/\\/gu, '/').toLowerCase();
    return header.includes(normalizedHook)
      && header.includes(':session_start:')
      && /^\s*trusted_hash\s*=\s*["']/mu.test(section);
  });
  return { status: trusted ? 'trusted' : 'untrusted', config_path: configToml };
}

export function codexHookStatus({ codexHome, manifest, projectRoot = null }) {
  const target = hookTarget(codexHome, projectRoot);
  const configPath = target.config_path;
  const config = readConfig(configPath);
  const groups = Array.isArray(config.hooks.SessionStart) ? config.hooks.SessionStart : [];
  const handlers = groups.flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : []);
  const installed = handlers.some(isAtlasHandler);
  const trust = installed ? trustStatus(codexHome, configPath) : { status: 'not_applicable', config_path: null };
  const runtimeReady = Boolean(manifest?.runtime_path && fs.existsSync(manifest.runtime_path));
  return {
    schema: 'atlas-codex-hook-install.v1',
    installation_scope: target.scope,
    project_root: target.project_root,
    status: installed ? 'installed' : 'not_installed',
    config_path: configPath,
    runtime_ready: runtimeReady,
    trust_status: trust.status,
    trust_evidence_path: trust.config_path,
    host_ready: installed && runtimeReady && trust.status === 'trusted',
    trust_required: installed && trust.status !== 'trusted',
    trust_action: installed && trust.status !== 'trusted'
      ? (target.scope === 'project'
        ? 'Open a fresh Codex task in this project and approve the hook trust prompt.'
        : 'Codex Desktop may not expose user-hook trust. Install Atlas into an exact project root instead.')
      : null,
  };
}

export function installCodexHook({ codexHome, manifest, projectRoot = null }) {
  if (!manifest?.node_path || !manifest?.runtime_path || !manifest?.state_path) {
    throw new Error('A ready Atlas installation manifest is required before installing the Codex hook.');
  }
  const target = hookTarget(codexHome, projectRoot);
  const configPath = target.config_path;
  const config = readConfig(configPath);
  const groups = Array.isArray(config.hooks.SessionStart) ? config.hooks.SessionStart : [];
  for (const group of groups) {
    if (Array.isArray(group?.hooks)) group.hooks = group.hooks.filter((entry) => !isAtlasHandler(entry));
  }
  const targetGroup = groups.find((group) => group?.matcher === 'startup|resume|clear|compact')
    ?? { matcher: 'startup|resume|clear|compact', hooks: [] };
  if (!groups.includes(targetGroup)) groups.push(targetGroup);
  targetGroup.hooks ??= [];
  targetGroup.hooks.push(hookHandler({
    nodePath: manifest.node_path,
    runtimePath: manifest.runtime_path,
    statePath: manifest.state_path,
  }));
  config.hooks.SessionStart = groups.filter((group) => Array.isArray(group.hooks) && group.hooks.length);
  atomicWrite(configPath, config);
  return codexHookStatus({ codexHome, manifest, projectRoot });
}

export function removeCodexHook({ codexHome, manifest = null, projectRoot = null }) {
  const target = hookTarget(codexHome, projectRoot);
  const configPath = target.config_path;
  if (!fs.existsSync(configPath)) {
    return {
      schema: 'atlas-codex-hook-install.v1', status: 'not_installed',
      installation_scope: target.scope, project_root: target.project_root, config_path: configPath,
    };
  }
  const config = readConfig(configPath);
  const groups = Array.isArray(config.hooks.SessionStart) ? config.hooks.SessionStart : [];
  for (const group of groups) {
    if (Array.isArray(group?.hooks)) group.hooks = group.hooks.filter((entry) => !isAtlasHandler(entry));
  }
  const remaining = groups.filter((group) => Array.isArray(group.hooks) && group.hooks.length);
  if (remaining.length) config.hooks.SessionStart = remaining;
  else delete config.hooks.SessionStart;
  atomicWrite(configPath, config);
  return {
    ...codexHookStatus({ codexHome, manifest, projectRoot }),
    status: 'removed',
    trust_required: false,
    trust_action: null,
  };
}
