import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const tempRoot = path.resolve('test', '.tmp');
const cliPath = path.resolve('bin', 'atlas.js');

function call(stateDir, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      ATLAS_STATE_DIR: stateDir,
      ATLAS_HOME: path.resolve('.'),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

test('CLI adopts Roots, persists a Context Link, and performs bounded local Catalog search', () => {
  const caseRoot = path.join(tempRoot, 'project-context-cli');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = path.join(caseRoot, 'state');
  const sourceRoot = path.join(caseRoot, 'vault');
  const targetRoot = path.join(caseRoot, 'website');
  fs.mkdirSync(path.join(sourceRoot, 'Career'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'Site'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'Career', '方向.md'),
    '# 求职方向\n\n个人网站需要展示数据治理项目。\n',
    'utf8',
  );

  const sourceRootReceipt = call(stateDir, [
    'root', 'adopt',
    '--path', sourceRoot,
    '--type', 'managed_library',
    '--content-policy', 'bounded_content',
  ]);
  const targetRootReceipt = call(stateDir, [
    'root', 'adopt',
    '--path', targetRoot,
    '--type', 'project_workspace',
    '--content-policy', 'bounded_content',
  ]);
  const sourceProject = call(stateDir, [
    'project', 'create', '--name', 'Career', '--path', 'Career',
  ]);
  const targetProject = call(stateDir, [
    'project', 'create', '--name', 'Website', '--path', 'Site',
  ]);
  call(stateDir, [
    'project', 'attach-root', sourceProject.project_id,
    '--root', sourceRootReceipt.root_id,
    '--reason', 'Bind source fixture.',
  ]);
  call(stateDir, [
    'project', 'attach-root', targetProject.project_id,
    '--root', targetRootReceipt.root_id,
    '--reason', 'Bind target fixture.',
  ]);
  const link = call(stateDir, [
    'project', 'link-context', targetProject.project_id,
    '--source', sourceProject.project_id,
    '--purpose', 'career_positioning',
    '--extension', '.md',
    '--reason', 'Reuse career notes for website direction.',
  ]);
  assert.equal(link.source_project_id, sourceProject.project_id);

  const generation = call(stateDir, [
    'catalog', 'update',
    '--project', sourceProject.project_id,
    '--actor', 'agent',
    '--agent', 'Codex',
    '--model', 'gpt-5',
    '--tool', 'codex-test',
    '--client-run-id', 'project-context-cli',
  ]);
  assert.equal(generation.changed_files, 1);
  const candidates = call(stateDir, [
    'catalog', 'search',
    '--project', sourceProject.project_id,
    '--term', '个人网站',
    '--max-candidates', '5',
  ]);
  assert.equal(candidates.candidate_count, 1);
  assert.equal(candidates.candidates[0].relative_path, 'Career/方向.md');
  assert.equal(Object.hasOwn(candidates.candidates[0], 'body'), false);

  const discovered = call(stateDir, [
    'task', 'discover-context',
    '--project', targetProject.project_id,
    '--purpose', 'career_positioning',
    '--term', '个人网站',
    '--actor', 'agent',
    '--agent', 'Codex',
    '--model', 'gpt-5',
    '--tool', 'codex-test',
    '--client-run-id', 'project-context-cli',
  ]);
  assert.equal(discovered.candidates.length, 1);
  const rediscovered = call(stateDir, [
    'task', 'context-candidates', discovered.candidate_set_id,
  ]);
  assert.equal(rediscovered.candidates[0].entry_id, discovered.candidates[0].entry_id);
  const requestFile = path.join(caseRoot, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify({
    intent: 'Create one website direction note.',
    project_id: targetProject.project_id,
    output: {
      target: 'Site/plan.md',
      role: 'report',
      action: 'create',
      data_class: 'generated_output',
    },
    budget: { max_files: 5, max_bytes: 1024 * 1024 },
  }), 'utf8');
  const prepared = call(stateDir, [
    'task', 'prepare-context',
    '--candidate-set', discovered.candidate_set_id,
    '--select', discovered.candidates[0].entry_id,
    '--request-file', requestFile,
    '--actor', 'agent',
    '--agent', 'Codex',
    '--model', 'gpt-5',
    '--tool', 'codex-test',
    '--client-run-id', 'project-context-cli',
  ]);
  assert.equal(prepared.status, 'ready');
  assert.deepEqual(prepared.boundaries.read_root_ids, [sourceRootReceipt.root_id]);
  assert.equal(prepared.boundaries.write_root_id, targetRootReceipt.root_id);
  const sourceSet = call(stateDir, ['task', 'source-set', prepared.source_set_id]);
  assert.equal(sourceSet.items[0].source_project_id, sourceProject.project_id);

  const candidateFile = path.join(caseRoot, 'candidate.md');
  fs.writeFileSync(candidateFile, '# 网站方向\n\n展示数据治理项目。\n', 'utf8');
  const completed = call(stateDir, [
    'task', 'fulfill', prepared.task_id,
    '--candidate-file', candidateFile,
    '--reason', 'Authorized fixture output.',
  ]);
  assert.equal(completed.status, 'completed');
  const shown = call(stateDir, ['task', 'show', prepared.task_id]);
  assert.equal(shown.inputs[0].source_project_id, sourceProject.project_id);
  assert.equal(shown.output.lineage.length, 1);
  const rolledBack = call(stateDir, ['task', 'rollback', prepared.task_id]);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(targetRoot, 'Site', 'plan.md')), false);
});
