import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorkspaceInspector } from '../src/inspect.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(projectRoot, 'test', '.tmp');
const cliPath = path.join(projectRoot, 'bin', 'atlas.js');

function write(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function setup() {
  const root = path.join(tempRoot, 'workspace-inspect');
  fs.rmSync(root, { recursive: true, force: true });
  write(path.join(root, 'tools', 'demo', 'README.md'), '# Demo\nOld: `F:\\OldWorkspace\\tools\\demo`\n');
  write(path.join(root, 'tools', 'demo', 'script.js'), 'const pattern = /s:\\s*/;\n');
  write(path.join(root, 'tools', 'demo', 'package.json'), JSON.stringify({
    name: 'demo-tool', private: true,
    scripts: { build: 'node build.js', 'check:content': 'node check.js', test: 'node --test' },
  }));
  write(path.join(root, 'tools', 'demo', 'Demo.csproj'), '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
  write(path.join(root, 'placeholder-project', 'package.json'), JSON.stringify({
    name: 'placeholder-project',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  }));
  write(path.join(root, 'toolchains', 'sdk', 'README.md'), 'Do not read F:\\SDK\\internal');
  fs.mkdirSync(path.join(root, 'cache', 'pnpm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scratch'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  write(path.join(root, 'nested-project', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(root, 'nested-project', '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
  write(path.join(root, 'skills', 'alpha', 'SKILL.md'), '# Alpha');
  write(path.join(root, 'skills', 'beta', 'SKILL.md'), '# Beta');
  return root;
}

test('Workspace Inspect returns bounded control facts and catches invalid Git plus old absolute paths', () => {
  const root = setup();
  const result = new WorkspaceInspector().inspect({ root, maxDepth: 5 });
  const top = new Map(result.top_level.map((item) => [item.path, item.role_hint]));

  assert.equal(result.schema, 'atlas-workspace-inspection.v1');
  assert.equal(top.get('tools'), 'tool_source_collection');
  assert.equal(top.get('toolchains'), 'tool_runtime');
  assert.equal(top.get('cache'), 'generated_cache');
  assert.equal(top.get('scratch'), 'temporary_work');
  assert.ok(result.control_files.some((item) => item.path === 'tools/demo/README.md'));
  assert.ok(!result.control_files.some((item) => item.path.startsWith('toolchains/')));
  assert.ok(result.path_references.some((item) => item.reference === 'F:\\OldWorkspace\\tools\\demo'));
  assert.ok(!result.path_references.some((item) => item.reference.includes('SDK')));
  assert.ok(!result.path_references.some((item) => item.reference === 's:\\s*'));
  assert.equal(result.repositories.find((item) => item.path === '.').valid, false);
  assert.equal(result.repositories.find((item) => item.path === 'nested-project').valid, true);
  const nodeManifest = result.manifests.find((item) => item.name === 'demo-tool');
  assert.equal(nodeManifest.name, 'demo-tool');
  assert.deepEqual(nodeManifest.scripts, ['build', 'check:content', 'test']);
  assert.equal(result.manifests.find((item) => item.type === 'dotnet_project').target_framework, 'net8.0');
  assert.ok(result.verification_commands.some((item) => item.script === 'check:content'));
  assert.ok(!result.verification_commands.some((item) => item.path === 'placeholder-project/package.json'));
  assert.ok(result.issues.some((item) => (
    item.kind === 'placeholder_verification_script'
      && item.path === 'placeholder-project/package.json'
      && item.script === 'test'
  )));
  assert.deepEqual(result.skill_collections[0].packages, ['alpha', 'beta']);
  assert.ok(result.content_files_read <= 5);
});

test('CLI exposes Workspace Inspect without creating a governance run', () => {
  const root = setup();
  const result = spawnSync(process.execPath, [cliPath, 'inspect', '--root', root, '--max-depth', '5', '--json'], {
    cwd: projectRoot, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.command, 'inspect');
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.schema, 'atlas-workspace-inspection.v1');
  assert.equal(envelope.data.source_changes.length, 0);
});

test('Workspace Inspect does not read ordinary Markdown bodies inside a managed Obsidian library', () => {
  const root = setup();
  write(path.join(root, 'vault', '.obsidian', 'app.json'), '{}\n');
  write(path.join(root, 'vault', 'AGENTS.md'), '# Vault rules\nMoved from F:\\OldVault\n');
  write(path.join(root, 'vault', 'Notes', 'private.md'), 'Do not inspect F:\\PrivateSource\n');
  write(path.join(root, 'vault', 'skills', 'local', 'SKILL.md'), '# Local skill\n');

  const result = new WorkspaceInspector().inspect({ root, maxDepth: 5 });

  assert.ok(result.managed_libraries.some((item) => item.path === 'vault'));
  assert.ok(result.control_files.some((item) => item.path === 'vault/AGENTS.md'));
  assert.ok(result.path_references.some((item) => item.reference === 'F:\\OldVault'));
  assert.ok(!result.path_references.some((item) => item.reference === 'F:\\PrivateSource'));
  assert.ok(!result.control_files.some((item) => item.path.startsWith('vault/Notes/')));
  assert.ok(result.skill_collections.some((item) => item.path === 'vault/skills'));
});

test('Workspace Inspect keeps the Vault content policy when inspecting one nested directory', () => {
  const root = setup();
  const vault = path.join(root, 'vault');
  const nested = path.join(vault, '08 AI聊天记录');
  write(path.join(vault, '.obsidian', 'app.json'), '{}\n');
  write(path.join(nested, 'AGENTS.md'), '# Nested rules\n');
  write(path.join(nested, 'private-chat.md'), 'Do not inspect F:\\PrivateChatSource\n');

  const result = new WorkspaceInspector().inspect({ root: nested, maxDepth: 2 });

  assert.ok(result.managed_libraries.some((item) => item.path === '.' && item.inherited === true));
  assert.ok(result.control_files.some((item) => item.path === 'AGENTS.md'));
  assert.ok(!result.path_references.some((item) => item.reference === 'F:\\PrivateChatSource'));
  assert.equal(result.content_files_read, 1);
});

test('Workspace Inspect does not mistake a website project with a stray .obsidian folder for a Vault', () => {
  const root = setup();
  write(path.join(root, 'projects', 'website', '.obsidian', 'app.json'), '{}\n');
  write(path.join(root, 'projects', 'website', 'AGENTS.md'), '# Website project\nThis is a Next.js source workspace.\n');
  write(path.join(root, 'projects', 'website', 'app', 'package.json'), JSON.stringify({
    name: 'website-app', scripts: { build: 'next build' },
  }));

  const result = new WorkspaceInspector().inspect({ root, maxDepth: 5 });

  assert.ok(!result.managed_libraries.some((item) => item.path === 'projects/website'));
  assert.ok(result.manifests.some((item) => item.name === 'website-app'));
  assert.ok(result.issues.some((item) => (
    item.kind === 'project_contains_obsidian_config' && item.path === 'projects/website/.obsidian'
  )));
});
