import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import {
  buildCodexSessionContext,
  CODEX_HOOK_CONTEXT_LIMIT,
  codexSessionStartOutput,
} from '../src/codex-hook.js';
import {
  codexHookStatus,
  installCodexHook,
  removeCodexHook,
} from '../src/codex-hook-install.js';

const tempRoot = path.resolve('test', '.tmp', 'codex-hook');

function resolved() {
  return {
    status: 'resolved',
    root: { id: 'ROOT-1' },
    project: { id: 'PRJ-1', name: 'Website' },
    context_links: [{ purpose: 'career_context', status: 'active' }],
  };
}

test('SessionStart injects bounded Atlas context only for a managed Project', () => {
  const event = { hook_event_name: 'SessionStart', cwd: 'F:\\Workspace\\Website' };
  const output = codexSessionStartOutput(event, resolved(), [{
    status: 'active',
    kind: 'placement',
    scope: { type: 'project', key: 'PRJ-1' },
    condition: { kind: 'report', extension: '.pdf' },
    value: { target_subdirectory: '06_分析报告' },
  }]);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /atlas-file-governance/u);
  assert.match(output.hookSpecificOutput.additionalContext, /Task status: idle/u);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /agent status/u);
  assert.match(output.hookSpecificOutput.additionalContext, /report\/.pdf.*06_分析报告/u);
  assert.ok(output.hookSpecificOutput.additionalContext.length <= CODEX_HOOK_CONTEXT_LIMIT);

  const pendingOutput = codexSessionStartOutput(event, resolved(), [], [{
    task_id: 'TSK-pending', task_status: 'ready',
  }]);
  assert.match(pendingOutput.hookSpecificOutput.additionalContext, /agent resume TSK-pending/u);
  assert.equal(buildCodexSessionContext(event, { status: 'setup_required', root: null }), null);
  assert.deepEqual(codexSessionStartOutput(event, { status: 'setup_required', root: null }), { continue: true });
  assert.deepEqual(codexSessionStartOutput({ ...event, hook_event_name: 'PostToolUse' }, resolved()), { continue: true });

  const containerOutput = codexSessionStartOutput(event, {
    status: 'setup_required',
    root: { id: 'ROOT-1' },
    project_candidates: [{
      project: { id: 'PRJ-JMC', name: 'JMC' },
      location: { relative_path: 'JMCMOTORS_社媒管理' },
    }],
  }, [{
    status: 'active',
    kind: 'placement',
    scope: { type: 'project', key: 'PRJ-JMC' },
    condition: { kind: 'report', extension: '.pdf' },
    value: { target_subdirectory: '06_分析报告' },
  }]);
  assert.match(containerOutput.hookSpecificOutput.additionalContext, /Project container/u);
  assert.match(containerOutput.hookSpecificOutput.additionalContext, /PRJ-JMC.*JMCMOTORS_社媒管理/u);
  assert.match(containerOutput.hookSpecificOutput.additionalContext, /06_分析报告/u);
});

test('Codex hook install is idempotent and preserves unrelated hooks', () => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  const codexHome = path.join(tempRoot, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, 'hooks.json');
  fs.writeFileSync(configPath, JSON.stringify({
    description: 'existing',
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'existing-start' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'existing-stop' }] }],
    },
  }), 'utf8');
  const runtimePath = path.join(tempRoot, 'runtime');
  fs.mkdirSync(runtimePath, { recursive: true });
  const manifest = {
    node_path: process.execPath,
    runtime_path: runtimePath,
    state_path: path.join(tempRoot, 'state'),
  };

  installCodexHook({ codexHome, manifest });
  installCodexHook({ codexHome, manifest });
  const installed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const atlasHandlers = installed.hooks.SessionStart
    .flatMap((group) => group.hooks)
    .filter((handler) => handler.command?.includes('atlas-session-context-v1'));
  assert.equal(atlasHandlers.length, 1);
  assert.equal(atlasHandlers[0].additionalContextLimit, 900);
  assert.equal(installed.hooks.Stop[0].hooks[0].command, 'existing-stop');
  const untrusted = codexHookStatus({ codexHome, manifest });
  assert.equal(untrusted.status, 'installed');
  assert.equal(untrusted.trust_status, 'untrusted');
  assert.equal(untrusted.host_ready, false);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    `[hooks.state.'${configPath}:session_start:0:0']`,
    'trusted_hash = "sha256:test"',
    '',
  ].join('\n'), 'utf8');
  const trusted = codexHookStatus({ codexHome, manifest });
  assert.equal(trusted.trust_status, 'trusted');
  assert.equal(trusted.host_ready, true);

  removeCodexHook({ codexHome, manifest });
  const removed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(removed.hooks.SessionStart[0].hooks[0].command, 'existing-start');
  assert.equal(removed.hooks.Stop[0].hooks[0].command, 'existing-stop');
  assert.equal(codexHookStatus({ codexHome, manifest }).status, 'not_installed');
});

test('Codex hook installs at one exact project root and reports project trust', () => {
  const root = path.join(tempRoot, 'project-install');
  const codexHome = path.join(root, 'codex-home');
  const projectRoot = path.join(root, 'Ads projects');
  const runtimePath = path.join(root, 'runtime');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(runtimePath, { recursive: true });
  const manifest = {
    node_path: process.execPath,
    runtime_path: runtimePath,
    state_path: path.join(root, 'state'),
  };

  const installed = installCodexHook({ codexHome, manifest, projectRoot });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.installation_scope, 'project');
  assert.equal(installed.project_root, path.resolve(projectRoot));
  assert.equal(installed.host_ready, false);
  assert.doesNotMatch(installed.trust_action, /\/hooks/u);
  const hookPath = path.join(projectRoot, '.codex', 'hooks.json');
  const config = JSON.parse(fs.readFileSync(hookPath, 'utf8'));
  assert.equal(config.hooks.SessionStart.length, 1);

  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    `[hooks.state.'${hookPath}:session_start:0:0']`,
    'trusted_hash = "sha256:test"',
    '',
  ].join('\n'), 'utf8');
  const trusted = codexHookStatus({ codexHome, manifest, projectRoot });
  assert.equal(trusted.trust_status, 'trusted');
  assert.equal(trusted.host_ready, true);
});

test('Codex hook process returns one JSON document for a managed Project', () => {
  const root = path.join(tempRoot, 'process');
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'Website');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(projectPath, { recursive: true });
  const registry = new Registry({ stateDir });
  const workspaceRoot = registry.adoptRoot({
    rootPath: workspace,
    rootType: 'project_workspace',
    contentPolicy: 'bounded_content',
  });
  const project = registry.create({ name: 'Website', currentPath: 'Website' });
  registry.attachRoot(project.project_id, {
    rootId: workspaceRoot.root_id,
    reason: 'Bind the hook process fixture.',
  });
  registry.dispose();

  const result = spawnSync(process.execPath, [
    path.resolve('bin', 'atlas-codex-hook.js'), '--state-dir', stateDir,
  ], {
    input: JSON.stringify({
      session_id: 'hook-process', cwd: projectPath,
      hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-5',
    }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /PRJ-/u);

  const containerResult = spawnSync(process.execPath, [
    path.resolve('bin', 'atlas-codex-hook.js'), '--state-dir', stateDir,
  ], {
    input: JSON.stringify({
      session_id: 'hook-container', cwd: workspace,
      hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-5',
    }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(containerResult.status, 0, containerResult.stderr);
  const containerOutput = JSON.parse(containerResult.stdout);
  assert.match(containerOutput.hookSpecificOutput.additionalContext, /Project container/u);
  assert.match(containerOutput.hookSpecificOutput.additionalContext, /Website/u);
});
