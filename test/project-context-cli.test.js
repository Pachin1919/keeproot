import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const tempRoot = path.resolve('test', '.tmp');
const cliPath = process.env.ATLAS_TEST_CLI_PATH
  ? path.resolve(process.env.ATLAS_TEST_CLI_PATH)
  : path.resolve('bin', 'atlas.js');
const atlasHome = process.env.ATLAS_TEST_HOME
  ? path.resolve(process.env.ATLAS_TEST_HOME)
  : path.resolve('.');
const externalStateRoot = process.env.ATLAS_TEST_STATE_ROOT
  ? path.resolve(process.env.ATLAS_TEST_STATE_ROOT)
  : null;

function stateFor(caseRoot, name) {
  const stateDir = externalStateRoot
    ? path.join(externalStateRoot, name)
    : path.join(caseRoot, 'state');
  fs.rmSync(stateDir, { recursive: true, force: true });
  return stateDir;
}

if (externalStateRoot) {
  test.after(() => fs.rmSync(externalStateRoot, { recursive: true, force: true }));
}

function call(stateDir, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      ATLAS_STATE_DIR: stateDir,
      ATLAS_HOME: atlasHome,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

function callFailure(stateDir, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      ATLAS_STATE_DIR: stateDir,
      ATLAS_HOME: atlasHome,
    },
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  return envelope.error;
}

test('CLI returns structured cross-Project setup actions instead of a generic miss', () => {
  const caseRoot = path.join(tempRoot, 'project-context-cli-setup-required');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = stateFor(caseRoot, 'project-context-cli-setup-required');
  const targetProject = call(stateDir, [
    'project', 'create', '--name', 'Website', '--path', 'Site',
  ]);

  const error = callFailure(stateDir, [
    'task', 'discover-context',
    '--project', targetProject.project_id,
    '--purpose', 'career_positioning',
    '--term', 'portfolio',
  ]);
  assert.equal(error.code, 'ATLAS_CONTEXT_SETUP_REQUIRED');
  assert.equal(error.details.status, 'context_setup_required');
  assert.deepEqual(
    error.details.required_actions.map((item) => item.action),
    ['root.adopt', 'project.attach-root', 'project.link-context'],
  );
});

test('CLI adopts Roots, persists a Context Link, and performs bounded local Catalog search', () => {
  const caseRoot = path.join(tempRoot, 'project-context-cli');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = stateFor(caseRoot, 'project-context-cli');
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
  fs.mkdirSync(path.join(targetRoot, 'Site', 'src'), { recursive: true });
  const resolved = call(stateDir, [
    'project', 'resolve', '--path', path.join(targetRoot, 'Site', 'src'),
  ]);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.project.id, targetProject.project_id);
  assert.equal(resolved.root.id, targetRootReceipt.root_id);
  assert.equal(resolved.context_links[0].link_id, link.link_id);
  const agentContextRequest = path.join(caseRoot, 'agent-context-request.json');
  fs.writeFileSync(agentContextRequest, JSON.stringify({
    operation: 'content_task',
    artifact_role: 'report',
    needs: ['naming', 'agent_output'],
  }), 'utf8');
  const agentContext = call(stateDir, [
    'agent', 'context', '--path', path.join(targetRoot, 'Site', 'src'),
    '--request-file', agentContextRequest,
  ]);
  assert.equal(agentContext.status, 'ready');
  assert.equal(agentContext.project.id, targetProject.project_id);
  assert.equal(agentContext.context_links[0].link_id, link.link_id);
  assert.equal(agentContext.attention.request.project_id, targetProject.project_id);
  assert.equal(agentContext.attention.status, 'advice_available');

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
    '--compact',
    '--actor', 'agent',
    '--agent', 'Codex',
    '--model', 'gpt-5',
    '--tool', 'codex-test',
    '--client-run-id', 'project-context-cli',
  ]);
  assert.equal(discovered.candidates.length, 1);
  assert.equal(discovered.compact, true);
  assert.equal(Object.hasOwn(discovered.candidates[0], 'snippet'), false);
  assert.equal(Object.hasOwn(discovered.candidates[0], 'headings'), false);
  const rediscovered = call(stateDir, [
    'task', 'context-candidates', discovered.candidate_set_id, '--compact',
  ]);
  assert.equal(rediscovered.candidates[0].entry_id, discovered.candidates[0].entry_id);
  assert.equal(Object.hasOwn(rediscovered.candidates[0], 'snippet'), false);
  const focused = call(stateDir, [
    'task', 'context-candidates', discovered.candidate_set_id,
    '--entry', discovered.candidates[0].entry_id,
  ]);
  assert.equal(focused.candidates.length, 1);
  assert.match(focused.candidates[0].snippet, /个人网站/);
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
    '--compact',
    '--actor', 'agent',
    '--agent', 'Codex',
    '--model', 'gpt-5',
    '--tool', 'codex-test',
    '--client-run-id', 'project-context-cli',
  ]);
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.compact, true);
  assert.equal(Object.hasOwn(prepared, 'registration'), false);
  assert.deepEqual(prepared.boundaries.read_root_ids, [sourceRootReceipt.root_id]);
  assert.equal(prepared.boundaries.write_root_id, targetRootReceipt.root_id);
  const sourceSet = call(stateDir, ['task', 'source-set', prepared.source_set_id]);
  assert.equal(sourceSet.items[0].source_project_id, sourceProject.project_id);

  const currentSources = call(stateDir, [
    'task', 'source-status', prepared.task_id,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'codex-test', '--client-run-id', 'project-context-source-status-current',
  ]);
  assert.equal(currentSources.status, 'current');
  assert.equal(currentSources.items[0].status, 'current');

  const operationView = call(stateDir, [
    'ui', 'operation', '--task', prepared.task_id, '--refresh-sources',
  ]);
  assert.equal(operationView.source_freshness.status, 'current');
  assert.equal(operationView.source_freshness.counts.current, 1);
  const operationModel = JSON.parse(fs.readFileSync(operationView.operation_path, 'utf8'));
  assert.equal(operationModel.sources.source_set_id, prepared.source_set_id);
  assert.equal(operationModel.sources.freshness.status, 'current');
  assert.equal(operationModel.sources.freshness.items[0].status, 'current');
  const operationHtml = fs.readFileSync(operationView.view_path, 'utf8');
  assert.match(operationHtml, /Selected sources are unchanged\./u);

  const originalSource = path.join(sourceRoot, 'Career', '方向.md');
  const sourceText = fs.readFileSync(originalSource, 'utf8');
  const sourceStat = fs.statSync(originalSource);
  fs.writeFileSync(originalSource, sourceText.replace('展示', '表明'), 'utf8');
  fs.utimesSync(originalSource, sourceStat.atime, sourceStat.mtime);
  const collidedStat = fs.statSync(originalSource);
  const collisionDb = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'));
  collisionDb.prepare(`
    UPDATE catalog_entries SET byte_size = ?, modified_ms = ?
    WHERE root_id = ? AND relative_path = ?
  `).run(
    collidedStat.size,
    collidedStat.mtimeMs,
    sourceRootReceipt.root_id,
    'Career/方向.md',
  );
  collisionDb.close();
  const sameStatStale = call(stateDir, [
    'task', 'source-status', prepared.task_id,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'codex-test', '--client-run-id', 'project-context-source-status-same-stat',
  ]);
  assert.equal(sameStatStale.catalog_refresh[0].reused_files, 1);
  assert.equal(sameStatStale.status, 'stale_source');
  assert.notEqual(sameStatStale.items[0].current_hash, sameStatStale.items[0].expected_hash);
  fs.writeFileSync(originalSource, sourceText, 'utf8');
  fs.utimesSync(originalSource, sourceStat.atime, sourceStat.mtime);

  const movedSource = path.join(sourceRoot, 'Career', '职业方向.md');
  fs.renameSync(originalSource, movedSource);
  const movedSources = call(stateDir, [
    'task', 'source-status', prepared.task_id,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'codex-test', '--client-run-id', 'project-context-source-status-moved',
  ]);
  assert.equal(movedSources.status, 'moved_same_content');
  assert.equal(movedSources.items[0].status, 'moved_same_content');
  assert.equal(movedSources.items[0].current_relative_path, 'Career/职业方向.md');
  assert.match(movedSources.attention, /refresh/i);
  fs.renameSync(movedSource, originalSource);
  const restoredSources = call(stateDir, [
    'task', 'source-status', prepared.task_id,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'codex-test', '--client-run-id', 'project-context-source-status-restored',
  ]);
  assert.equal(restoredSources.status, 'current');
  fs.writeFileSync(originalSource, `${sourceText}\n新增职业变化。\n`, 'utf8');
  const staleSources = call(stateDir, [
    'task', 'source-status', prepared.task_id,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'codex-test', '--client-run-id', 'project-context-source-status-stale',
  ]);
  assert.equal(staleSources.status, 'stale_source');
  assert.equal(staleSources.items[0].status, 'stale_source');
  fs.writeFileSync(originalSource, sourceText, 'utf8');
  const finalSources = call(stateDir, [
    'task', 'source-status', prepared.task_id,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'codex-test', '--client-run-id', 'project-context-source-status-final',
  ]);
  assert.equal(finalSources.status, 'current');

  const candidateFile = path.join(caseRoot, 'candidate.md');
  fs.writeFileSync(candidateFile, '# 网站方向\n\n展示数据治理项目。\n', 'utf8');
  const completed = call(stateDir, [
    'task', 'fulfill', prepared.task_id,
    '--candidate-file', candidateFile,
    '--reason', 'Authorized fixture output.',
  ]);
  assert.equal(completed.status, 'completed');
  const shown = call(stateDir, ['task', 'show', prepared.task_id, '--compact']);
  assert.equal(shown.compact, true);
  assert.equal(shown.inputs[0].source_project_id, sourceProject.project_id);
  assert.equal(Object.hasOwn(shown, 'events'), false);
  assert.equal(shown.output.lineage.length, 1);
  const rolledBack = call(stateDir, ['task', 'rollback', prepared.task_id]);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(targetRoot, 'Site', 'plan.md')), false);
});

test('CLI verifies a moved Project by local identity and rejects the wrong directory', () => {
  const caseRoot = path.join(tempRoot, 'project-relocation-identity');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = stateFor(caseRoot, 'project-relocation-identity');
  const workspace = path.join(caseRoot, 'workspace');
  const original = path.join(workspace, 'Projects', 'Atlas-old');
  const relocated = path.join(workspace, 'Projects', 'Atlas-new');
  const wrong = path.join(workspace, 'Projects', 'Wrong-project');
  fs.mkdirSync(path.join(original, '.git'), { recursive: true });
  fs.mkdirSync(wrong, { recursive: true });
  fs.writeFileSync(
    path.join(original, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/example/atlas.git\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(original, 'package.json'),
    JSON.stringify({ name: '@example/atlas' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(wrong, 'package.json'),
    JSON.stringify({ name: '@example/wrong' }),
    'utf8',
  );

  const root = call(stateDir, [
    'root', 'adopt', '--path', workspace,
    '--type', 'workspace_container', '--content-policy', 'structure_only',
  ]);
  const project = call(stateDir, [
    'project', 'create', '--name', 'Atlas', '--path', 'Projects/Atlas-old',
  ]);
  const attached = call(stateDir, [
    'project', 'attach-root', project.project_id,
    '--root', root.root_id,
    '--reason', 'Establish the original project identity.',
  ]);
  assert.equal(attached.identity.status, 'captured');
  assert.deepEqual(attached.identity.stable_signals.sort(), ['git_remote', 'node_package']);

  fs.renameSync(original, relocated);

  const rejected = call(stateDir, [
    'project', 'relocate', project.project_id,
    '--root', root.root_id,
    '--path', 'Projects/Wrong-project',
    '--reason', 'Check a suspected location.',
  ]);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason_code, 'identity_mismatch');
  assert.deepEqual(rejected.mismatched_signals, ['node_package']);
  const afterRejection = call(stateDir, ['project', 'show', project.project_id]);
  assert.equal(afterRejection.location.relative_path, 'Projects/Atlas-old');
  assert.equal(afterRejection.location_history.length, 1);

  const accepted = call(stateDir, [
    'project', 'relocate', project.project_id,
    '--root', root.root_id,
    '--path', 'Projects/Atlas-new',
    '--reason', 'Recover the moved project location.',
  ]);
  assert.equal(accepted.status, 'relocated');
  assert.equal(accepted.project_id, project.project_id);
  assert.equal(accepted.location.relative_path, 'Projects/Atlas-new');
  assert.deepEqual(accepted.matched_signals.sort(), ['git_remote', 'node_package']);

  const detail = call(stateDir, ['project', 'show', project.project_id]);
  assert.equal(detail.location.relative_path, 'Projects/Atlas-new');
  assert.equal(detail.location_history.length, 2);
  assert.equal(detail.identity.status, 'active');
});

test('CLI preserves Root identity after an exact moved-root candidate is verified', () => {
  const caseRoot = path.join(tempRoot, 'root-relocation-identity');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = stateFor(caseRoot, 'root-relocation-identity');
  const oldRoot = path.join(caseRoot, 'PachinStudio-old');
  const newRoot = path.join(caseRoot, 'PachinStudio-new');
  const wrongRoot = path.join(caseRoot, 'WrongStudio');
  const relativeProject = path.join('projects', 'Atlas');
  fs.mkdirSync(path.join(oldRoot, relativeProject, '.git'), { recursive: true });
  fs.mkdirSync(path.join(wrongRoot, relativeProject), { recursive: true });
  fs.writeFileSync(
    path.join(oldRoot, relativeProject, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/example/atlas.git\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(oldRoot, relativeProject, 'package.json'),
    JSON.stringify({ name: '@example/atlas' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(wrongRoot, relativeProject, 'package.json'),
    JSON.stringify({ name: '@example/wrong' }),
    'utf8',
  );

  const root = call(stateDir, [
    'root', 'adopt', '--path', oldRoot,
    '--type', 'workspace_container', '--content-policy', 'structure_only',
  ]);
  const project = call(stateDir, [
    'project', 'create', '--name', 'Atlas', '--path', 'projects/Atlas',
  ]);
  call(stateDir, [
    'project', 'attach-root', project.project_id,
    '--root', root.root_id,
    '--reason', 'Establish a Root identity anchor.',
  ]);

  fs.renameSync(oldRoot, newRoot);

  const rejected = call(stateDir, [
    'root', 'relocate', root.root_id,
    '--path', wrongRoot,
    '--reason', 'Check a suspected moved Root.',
  ]);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason_code, 'project_identity_mismatch');
  assert.equal(call(stateDir, ['root', 'show', root.root_id]).root.current_path, oldRoot);

  const relocated = call(stateDir, [
    'root', 'relocate', root.root_id,
    '--path', newRoot,
    '--reason', 'Recover the moved Workspace Root.',
  ]);
  assert.equal(relocated.status, 'relocated');
  assert.equal(relocated.root_id, root.root_id);
  assert.equal(relocated.current_path, newRoot);
  assert.deepEqual(relocated.verified_project_ids, [project.project_id]);

  const detail = call(stateDir, ['root', 'show', root.root_id]);
  assert.equal(detail.root.current_path, newRoot);
  assert.equal(detail.paths.length, 2);
  assert.equal(detail.paths[0].valid_to != null, true);
  assert.equal(detail.paths[1].path, newRoot);
  const resolved = call(stateDir, ['project', 'resolve', '--path', path.join(newRoot, relativeProject)]);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.project.id, project.project_id);
  assert.equal(resolved.root.id, root.root_id);
});
