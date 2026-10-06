import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Evolution } from '../src/evolution.js';
import { Intake } from '../src/intake.js';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';

const temporaryRoot = path.resolve('test/.tmp');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('Save directory review page confirms one empty directory and returns the same receipt', async (t) => {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'save-directory-ui-'));
  const root = path.join(temporary, '中文资料库');
  const stateDir = path.join(temporary, 'state');
  const projectPath = path.join(root, 'Projects', '城市研究');
  const otherProjectPath = path.join(root, 'Projects', '其他项目');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(otherProjectPath, { recursive: true });
  const candidateFile = path.join(temporary, '候选.md');
  fs.writeFileSync(candidateFile, '# 候选内容\n', 'utf8');
  const candidateHash = sha256(candidateFile);

  const registry = new Registry({ stateDir });
  const intake = new Intake({ stateDir });
  let server;
  let testEvolution;
  t.after(async () => {
    if (server) await server.close();
    testEvolution?.dispose();
    intake.dispose();
    registry.dispose();
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const rootRecord = registry.adoptRoot({ rootPath: root, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市研究', currentPath: 'Projects/城市研究' });
  registry.attachRoot(project.project_id, { rootId: rootRecord.root_id, relativePath: 'Projects/城市研究', reason: 'Save directory UI fixture.' });
  const otherProject = registry.create({ name: '其他项目', currentPath: 'Projects/其他项目' });
  registry.attachRoot(otherProject.project_id, { rootId: rootRecord.root_id, relativePath: 'Projects/其他项目', reason: 'Cross-Project rejection fixture.' });

  const cliPath = path.resolve('bin/atlas.js');
  const runCli = (args) => {
    const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
      cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: stateDir }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    return envelope.data;
  };
  const saveArgs = [
    '--root', root, '--candidate-file', candidateFile, '--project', project.project_id,
    '--target', 'Projects/城市研究/03_图表资料/2026-09-28_交通图表素材.md',
    '--origin', 'human_written', '--kind', 'note', '--tool', 'save-directory-ui-test',
    '--client-run-id', 'review-one-directory',
  ];
  const plan = runCli(['save', 'plan', ...saveArgs]);
  assert.equal(plan.status, 'needs_structure_change');
  const prepared = runCli(['save', 'directory', 'prepare', ...saveArgs, '--expected-plan-revision', plan.plan_revision]);
  assert.equal(prepared.project_id, project.project_id);
  const directoryPath = path.join(root, prepared.directory_path);
  const targetPath = path.join(root, prepared.save_target);
  assert.equal(fs.existsSync(directoryPath), false);

  testEvolution = new Evolution({ stateDir });
  const ordinaryRun = testEvolution.prepare({
    root,
    operation: 'create_directory',
    target: 'Projects/城市研究/Foundation',
    projectId: project.project_id,
    caller: { tool: 'save-directory-ui-test', client_run_id: 'ordinary-evolution' },
  });
  server = await startAtlasUiServer({ stateDir, registry, intake, runtime: {} });
  const reviewUrl = new URL(prepared.review_href, server.workspace_url);
  const previewResponse = await fetch(reviewUrl);
  assert.equal(previewResponse.status, 200);
  const previewHtml = await previewResponse.text();
  assert.match(previewHtml, /2026-09-28_交通图表素材.md/u);
  assert.match(previewHtml, /不会保存文件|does not save the file/iu);
  assert.equal(fs.existsSync(directoryPath), false);
  assert.equal(fs.existsSync(targetPath), false);
  const csrf = previewHtml.match(/name="csrf" value="([^"]+)"/u)?.[1];
  const planHash = previewHtml.match(/name="expected_plan_hash" value="([^"]+)"/u)?.[1];
  assert.ok(csrf);
  assert.ok(planHash);

  const post = (url, fields) => fetch(url, {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
  });
  assert.equal((await post(reviewUrl, { csrf: 'invalid', expected_plan_hash: planHash })).status, 403);
  assert.equal((await post(reviewUrl, { csrf, expected_plan_hash: '0'.repeat(64) })).status, 409);
  const otherProjectUrl = new URL(`/projects/${encodeURIComponent(otherProject.project_id)}/save-directory/${encodeURIComponent(prepared.run_id)}`, server.workspace_url);
  assert.ok([403, 404].includes((await post(otherProjectUrl, { csrf, expected_plan_hash: planHash })).status));
  const ordinaryUrl = new URL(`/projects/${encodeURIComponent(project.project_id)}/save-directory/${encodeURIComponent(ordinaryRun.run_id)}`, server.workspace_url);
  assert.ok([403, 404].includes((await post(ordinaryUrl, { csrf, expected_plan_hash: ordinaryRun.plan_hash })).status));
  assert.equal(fs.existsSync(directoryPath), false);
  assert.equal(fs.existsSync(targetPath), false);

  const confirmed = await post(reviewUrl, { csrf, expected_plan_hash: planHash });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get('location'), prepared.review_href);
  assert.equal(fs.existsSync(directoryPath), true);
  assert.deepEqual(fs.readdirSync(directoryPath), []);
  assert.equal(fs.existsSync(targetPath), false);
  const afterConfirm = await fetch(reviewUrl);
  assert.equal(afterConfirm.status, 200);
  const completeHtml = await afterConfirm.text();
  assert.match(completeHtml, /目录已创建|directory was created/iu);
  assert.match(completeHtml, /本次确认只创建了目录.*没有保存文件|this confirmation created the directory only.*did not save the file/iu);
  assert.match(completeHtml, /save plan|保存计划/iu);

  const firstReceipt = testEvolution.preview(prepared.run_id).execution_receipt;
  assert.ok(firstReceipt?.save_directory_identity?.ino);
  const repeated = await post(reviewUrl, { csrf, expected_plan_hash: planHash });
  assert.equal(repeated.status, 303);
  const secondReceipt = testEvolution.preview(prepared.run_id).execution_receipt;
  assert.deepEqual(secondReceipt, firstReceipt);
  assert.equal(fs.readdirSync(directoryPath).length, 0);
  assert.equal(fs.existsSync(targetPath), false);
  assert.equal(sha256(candidateFile), candidateHash);
});
