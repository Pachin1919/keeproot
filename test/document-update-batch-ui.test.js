import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { createDocumentUpdateService } from '../src/document-update-service.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
import { spawnSync } from 'node:child_process';
import { CAPABILITIES } from '../src/protocol.js';

let serverToClose = null;
async function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/document-update-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '城市研究'); const sourceFolder = path.join(projectRoot, '01_来源');
  fs.mkdirSync(sourceFolder, { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市研究', currentPath: '城市研究' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市研究', reason: 'Document update fixture.' });
  const resourceControl = new ResourceControl({ stateDir, registry });
  const saveService = createSaveService({ stateDir, resourceControl });
  const captureSource = createCaptureSourceService({ stateDir, registry, saveService,
    fetchImpl: async () => new Response('<html><head><title>来源</title></head><body><article><p>引用内容</p></article></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }] });
  const sourcePrepared = await captureSource.prepare({ url: 'https://example.test/source', projectId: project.project_id,
    folder: '01_来源', name: '来源', requestKey: 'source-save', caller: { tool: 'fixture', client_run_id: 'document-update-source' } });
  const sourceReview = saveService.review(sourcePrepared.save_id);
  const sourceSave = saveService.execute(sourcePrepared.save_id, { reason: 'fixture confirmed', expectedPreviewRevision: sourceReview.preview_revision });
  const markdownPath = path.join(projectRoot, '知识笔记', '公交方案观察.md');
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  const originalBytes = Buffer.from('# 观察\n\n开头段落。\n\n唯一旧块：早班车间隔较长。\n\n结尾段落。\n', 'utf8');
  fs.writeFileSync(markdownPath, originalBytes);
  const identified = resourceControl.identify({ filePath: markdownPath, project: registry.show(project.project_id).project }).resource_id;
  const updateService = createDocumentUpdateService({ stateDir, registry, resourceControl, saveService });
  t.after(async () => {
    await serverToClose?.close();
    captureSource.dispose(); saveService.dispose(); resourceControl.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { root, stateDir, workspace, projectRoot, project, registry, resourceControl, saveService, captureSource,
    sourceSave, markdownPath, originalBytes, resourceId: identified, updateService };
}

import { startAtlasUiServer } from '../src/ui-server.js';

test('Project batch POST retains partial failure, same Host ID, explicit selection and escaped names', async t => {
  const f = await fixture(t); const projectId = f.project.project_id;
  const caller = { tool: 'fixture', client_run_id: 'batch-ui' }; const updates = []; const targets = [];
  for (let i = 0; i < 3; i++) {
    const target = path.join(f.projectRoot, `材料 ${i} & 资料.txt`); fs.writeFileSync(target, '唯一旧块\n', 'utf8'); targets.push(target);
    const resourceId = f.resourceControl.identify({ filePath: target, project: f.registry.show(projectId).project }).resource_id;
    const p = f.updateService.prepare({ projectId, resourceId, expectedSha256: sha256(fs.readFileSync(target)), oldText: '唯一旧块', newText: `已审候选 ${i}`,
      sourceSaveId: f.sourceSave.save_id, requestKey: `prepare-ui-${i}`, caller });
    updates.push(f.updateService.decide(p.update_id, { projectId, expectedRevision: p.revision, expectedCurrentSha256: p.current.sha256,
      decision: 'accept-suggestion', requestKey: `decide-ui-${i}`, caller }));
  }
  const originals = targets.map(target => fs.readFileSync(target));
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, intake: f.saveService.intake, projectRoot: path.resolve('.'), installationRoot: path.resolve('.') });
  serverToClose = server;
  const base = new URL(`projects/${projectId}/document-update-batches`, server.workspace_url).href;
  const select = await (await fetch(`${base}/new`)).text();
  assert.match(select, /name="item"/u, select.slice(-1600)); assert.match(select, /材料 1 &amp; 资料.txt/u);
  const displayedSelections = [...select.matchAll(/name="item" value="([^"]+)"/gu)].map(match => JSON.parse(match[1].replaceAll('&quot;', '"')));
  assert.equal(displayedSelections.length, 3);
  const csrf = select.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const post = (url, values, ids = []) => {
    const body = new URLSearchParams({ csrf, ...values }); for (const id of ids) body.append('item', JSON.stringify(displayedSelections.find(item => item.updateId === id)));
    return fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  };
  assert.equal((await post(`${base}/prepare`, { csrf: 'bad', request_key: 'bad' }, updates.map(u => u.update_id))).status, 403);
  const created = await post(`${base}/prepare`, { request_key: 'ui-create' }, updates.map(u => u.update_id));
  assert.equal(created.status, 303, (await created.clone().text()).slice(-1000));
  const location = new URL(created.headers.get('location'), server.workspace_url).href;
  const batchId = location.split('/').pop(); assert.match(batchId, /^BUP-[a-f0-9]{32}$/u);
  let batch = f.updateService.showBatch(batchId, { projectId }); assert.equal(batch.items.length, 3);
  targets.forEach((target, i) => assert.deepEqual(fs.readFileSync(target), originals[i]));
  const resources = await (await fetch(new URL(`projects/${projectId}/resources?resource_id=${updates[0].resource_id}`, server.workspace_url))).text();
  assert.ok(resources.includes(`/projects/${projectId}/document-update-batches/new`));
  const single = await (await fetch(new URL(`projects/${projectId}/document-updates/${updates[0].update_id}`, server.workspace_url))).text();
  assert.ok(single.includes(`/projects/${projectId}/document-update-batches/new`));
  fs.appendFileSync(targets[1], '外部后改');
  const advance = async key => {
    const response = await post(`${location}/advance`, { expected_revision: String(batch.revision), expected_digest: batch.digest, request_key: key });
    assert.equal(response.status, 303, (await response.clone().text()).slice(-1000)); batch = f.updateService.showBatch(batchId, { projectId });
  };
  const before = batch;
  await advance('first'); assert.equal(batch.successful_count, 1);
  assert.equal((await post(`${location}/advance`, { expected_revision: String(before.revision), expected_digest: before.digest, request_key: 'stale' })).status, 409);
  await advance('second'); assert.equal(batch.items[1].status, 'blocked'); await advance('third'); assert.equal(batch.successful_count, 2);
  const page = await (await fetch(location)).text(); assert.ok(page.includes(batchId)); assert.match(page, /<span>Applied items<\/span><strong>2<\/strong>/u);
  assert.match(page, /<span>Blocked items<\/span><strong>1<\/strong>/u);
  assert.match(page, /Blocked; retained for review/u); assert.match(page, /材料 1 &amp; 资料.txt/u);
  for (const update of updates) assert.ok(page.includes(`/projects/${projectId}/document-updates/${update.update_id}`));
  assert.match(fs.readFileSync(targets[1], 'utf8'), /外部后改/u);
  const show = spawnSync(process.execPath, ['bin/atlas.js', 'document', 'update', 'batch', 'show', batchId, '--project', projectId, '--json'],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, ATLAS_STATE_DIR: f.stateDir } });
  assert.equal(show.status, 0, show.stdout + show.stderr); assert.equal(JSON.parse(show.stdout).data.successful_count, 2);
});
