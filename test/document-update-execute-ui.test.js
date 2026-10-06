import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';

test('Project HTML confirms then applies, reads back and undoes the same Markdown Resource', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/document-update-ui-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '项目'); const sourceFolder = path.join(projectRoot, '来源');
  fs.mkdirSync(sourceFolder, { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '项目', currentPath: '项目' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '项目', reason: 'Document update UI fixture.' });
  const save = createSaveService({ stateDir });
  const resourceControl = new ResourceControl({ stateDir, registry });
  const capture = createCaptureSourceService({ stateDir, registry, saveService: save,
    fetchImpl: async () => new Response('<html><head><title>引用</title></head><body><article><p>已保存来源</p></article></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }] });
  const source = await capture.prepare({ url: 'https://example.test/source', projectId: project.project_id, folder: '来源', name: '引用',
    requestKey: 'ui-source-save', caller: { tool: 'fixture', client_run_id: 'update-ui-source' } });
  const sourceReview = save.review(source.save_id);
  save.execute(source.save_id, { reason: 'fixture confirmed', expectedPreviewRevision: sourceReview.preview_revision });
  const target = path.join(projectRoot, '公交观察.md');
  const original = Buffer.from('# 公交观察\n\n唯一旧块：高峰拥挤。\n', 'utf8'); fs.writeFileSync(target, original);
  const resourceId = resourceControl.identify({ filePath: target, project: registry.show(project.project_id).project }).resource_id;
  const server = await startAtlasUiServer({ stateDir, registry, intake: save.intake, projectRoot: workspace, installationRoot: workspace });
  t.after(async () => {
    await server.close(); capture.dispose(); save.dispose(); resourceControl.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const base = new URL(`projects/${encodeURIComponent(project.project_id)}`, server.workspace_url);
  const home = await (await fetch(base)).text();
  const csrf = home.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const resourceResponse = await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/resources?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url));
  const resourcePage = await resourceResponse.text();
  const pageNotice = resourcePage.match(/<h1>Atlas stopped this action<\/h1><p>([^<]*)<\/p>/u)?.[1] ?? 'no error notice';
  assert.equal(resourceResponse.status, 200, pageNotice);
  assert.match(resourcePage, /document-updates\/new/u, pageNotice);
  const inspectResponse = await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/document-updates/new?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url));
  assert.equal(inspectResponse.status, 200);
  const inspectHtml = await inspectResponse.text();
  assert.match(inspectHtml, /高峰拥挤/u);
  assert.match(inspectHtml, /expected_sha256/u);

  const prepareUrl = new URL(`projects/${encodeURIComponent(project.project_id)}/document-updates/prepare`, server.workspace_url);
  const baseFields = { csrf, resource_id: resourceId, expected_sha256: crypto.createHash('sha256').update(original).digest('hex'),
    old_text: '唯一旧块：高峰拥挤。', new_text: '唯一旧块：高峰已缓解。', source_save_id: source.save_id,
    request_key: 'ui-update-1' };
  const rejectedCsrf = await fetch(prepareUrl, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...baseFields, csrf: 'invalid' }) });
  assert.equal(rejectedCsrf.status, 403);
  const preparedResponse = await fetch(prepareUrl, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(baseFields) });
  assert.equal(preparedResponse.status, 303);
  const updatePath = new URL(preparedResponse.headers.get('location'), server.workspace_url).pathname;
  const previewResponse = await fetch(new URL(updatePath, server.workspace_url));
  assert.equal(previewResponse.status, 200);
  const previewHtml = await previewResponse.text();
  assert.match(previewHtml, /Save suggestion/u);
  assert.match(previewHtml, new RegExp(source.save_id, 'u'));
  assert.match(previewHtml, new RegExp(source.version_id, 'u'));
  const sourceHref = previewHtml.match(/href="([^"]*\/capture-source\/SAV-[a-f0-9-]+)"/u)?.[1];
  assert.ok(sourceHref);
  const sourcePage = await fetch(new URL(sourceHref, server.workspace_url));
  assert.equal(sourcePage.status, 200);
  assert.match(await sourcePage.text(), /已保存来源/u);
  assert.match(previewHtml, /高峰拥挤/u); assert.match(previewHtml, /高峰已缓解/u);
  assert.doesNotMatch(previewHtml, /笔记已更新|更新已完成/u);
  const revision = previewHtml.match(/name="expected_revision" value="(\d+)"/u)?.[1]; assert.ok(revision);
  const currentHash = previewHtml.match(/name="expected_current_sha256" value="([a-f0-9]{64})"/u)?.[1]; assert.ok(currentHash);
  const updateId = updatePath.split('/').at(-1);
  const decideResponse = await fetch(new URL(`${updatePath}/decide`, server.workspace_url), { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, expected_revision: revision, expected_current_sha256: currentHash, decision: 'accept-suggestion',
      request_key: 'ui-decision-1', text: '' }) });
  assert.equal(decideResponse.status, 303);
  const decidedHtml = await (await fetch(new URL(`${updatePath}`, server.workspace_url))).text();
  assert.match(decidedHtml, /Suggestion preview is ready\./u);
  assert.match(decidedHtml, /Saved suggestion/u);
  assert.ok(updateId.startsWith('UPD-'));
  assert.equal(fs.readFileSync(target).toString('utf8'), original.toString('utf8'));
  assert.equal(fs.readFileSync(target).length, original.length);
  const mutation = async (action, html, key, token = csrf) => fetch(new URL(`${updatePath}/${action}`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: token, expected_revision: html.match(/name="expected_revision" value="(\d+)"/u)[1],
      expected_current_sha256: html.match(/name="expected_current_sha256" value="([a-f0-9]{64})"/u)[1], request_key: key }),
  });
  assert.match(decidedHtml, /Apply confirmed update/u);
  assert.equal((await mutation('execute', decidedHtml, 'apply', 'invalid')).status, 403);
  const applied = await mutation('execute', decidedHtml, 'apply');
  assert.equal(applied.status, 303);
  const appliedHtml = await (await fetch(new URL(updatePath, server.workspace_url))).text();
  assert.match(appliedHtml, /confirmed update was applied/u);
  assert.match(appliedHtml, new RegExp(resourceId, 'u'));
  assert.match(appliedHtml, /Undo applied update/u);
  assert.equal(fs.readFileSync(target, 'utf8'), original.toString('utf8').replace('高峰拥挤', '高峰已缓解'));
  assert.equal((await mutation('undo', appliedHtml, 'undo')).status, 303);
  const undoneHtml = await (await fetch(new URL(updatePath, server.workspace_url))).text();
  assert.match(undoneHtml, /update was undone/u);
  assert.equal(fs.readFileSync(target, 'utf8'), original.toString('utf8'));
});
