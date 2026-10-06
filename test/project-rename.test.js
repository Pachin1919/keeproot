import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { Intake } from '../src/intake.js';
import { createResourceControl } from '../src/resource-control.js';
import { startAtlasUiServer } from '../src/ui-server.js';

const put = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
  return filePath;
};

test('Project Home previews and confirms a revision-bound semantic rename without moving files', async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'project-rename-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, '项目甲');
  const sourcePath = put(path.join(projectPath, '资料', '说明.md'), '# 保留\n');
  const sourceBytes = fs.readFileSync(sourcePath);
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const created = registry.create({ name: '旧名称', currentPath: '项目甲' });
  registry.attachRoot(created.project_id, { rootId: adopted.root_id, relativePath: '项目甲', reason: 'Rename test fixture.' });
  const project = { id: created.project_id, name: '旧名称', status: 'active' };
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const resource = resourceControl.identify({ filePath: sourcePath, project });
  const intake = new Intake({ stateDir });
  const server = await startAtlasUiServer({
    stateDir, registry, intake, rules: {}, runtime: {}, projectRoot: root, installationRoot: root, resourceControl,
  });
  t.after(async () => {
    await server.close();
    intake.dispose();
    resourceControl.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base = new URL(`projects/${project.id}`, server.workspace_url);
  const getHome = async () => {
    const response = await fetch(base);
    return { response, html: await response.text() };
  };
  const post = (action, values) => fetch(new URL(`projects/${project.id}/rename/${action}`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  });

  let home = await getHome();
  assert.equal(home.response.status, 200);
  assert.match(home.html, /project-rename-form/u);
  const csrf = home.html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);

  let previewResponse = await post('preview', { csrf, new_name: '新名称' });
  assert.equal(previewResponse.status, 200);
  let previewHtml = await previewResponse.text();
  assert.match(previewHtml, new RegExp(project.id, 'u'));
  assert.match(previewHtml, /旧名称/u);
  assert.match(previewHtml, /新名称/u);
  assert.match(previewHtml, /项目甲/u);
  assert.match(previewHtml, /不移动文件|Files will not move/u);
  assert.equal(registry.show(project.id).project.name, '旧名称');

  const preview = Object.fromEntries(['expected_name', 'expected_updated_at', 'new_name', 'preview_revision'].map((name) => [
    name,
    previewHtml.match(new RegExp(`name="${name}" value="([^"]*)"`, 'u'))?.[1],
  ]));
  assert.ok(Object.values(preview).every(Boolean));
  registry.evolve(project.id, { name: '并发改名', reason: 'Concurrent rename for stale preview test.' });
  const stale = await post('confirm', { csrf, ...preview });
  assert.equal(stale.status, 409);
  assert.equal(registry.show(project.id).project.name, '并发改名');

  home = await getHome();
  const freshCsrf = home.html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  previewResponse = await post('preview', { csrf: freshCsrf, new_name: '最终名称' });
  assert.equal(previewResponse.status, 200);
  previewHtml = await previewResponse.text();
  const freshPreview = Object.fromEntries(['expected_name', 'expected_updated_at', 'new_name', 'preview_revision'].map((name) => [
    name,
    previewHtml.match(new RegExp(`name="${name}" value="([^"]*)"`, 'u'))?.[1],
  ]));
  const confirmed = await post('confirm', { csrf: freshCsrf, ...freshPreview });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get('location'), `/projects/${project.id}`);

  const detail = registry.show(project.id);
  assert.equal(detail.project.id, project.id);
  assert.equal(detail.project.name, '最终名称');
  assert.ok(detail.aliases.includes('旧名称'));
  assert.ok(detail.aliases.includes('并发改名'));
  assert.equal(detail.location.relative_path, '项目甲');
  assert.equal(fs.readFileSync(sourcePath).compare(sourceBytes), 0);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'), crypto.createHash('sha256').update(sourceBytes).digest('hex'));

  const host = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'project', 'show', project.id, '--json'], {
    cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ATLAS_STATE_DIR: stateDir },
  });
  assert.equal(host.status, 0, host.stderr);
  const hostReceipt = JSON.parse(host.stdout);
  assert.equal(hostReceipt.ok, true);
  assert.equal(hostReceipt.data.project.id, project.id);
  assert.equal(hostReceipt.data.project.name, '最终名称');
  assert.ok(hostReceipt.data.aliases.includes('旧名称'));
  assert.equal(hostReceipt.data.location.relative_path, '项目甲');

  const renamedHome = await getHome();
  assert.equal(renamedHome.response.status, 200);
  assert.match(renamedHome.html, /最终名称/u);
  assert.match(renamedHome.html, new RegExp(`/projects/${project.id}/resources`, 'u'));
  assert.match(renamedHome.html, new RegExp(`/projects/${project.id}/boards`, 'u'));
  const resourcePage = await fetch(new URL(`projects/${project.id}/resources?resource_id=${encodeURIComponent(resource.resource_id)}`, server.workspace_url));
  assert.equal(resourcePage.status, 200);
  assert.match(await resourcePage.text(), new RegExp(resource.resource_id, 'u'));
  const boardsPage = await fetch(new URL(`projects/${project.id}/boards`, server.workspace_url));
  assert.equal(boardsPage.status, 200);
  assert.match(await boardsPage.text(), new RegExp(project.id, 'u'));
});
