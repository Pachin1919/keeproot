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
  t.after(() => {
    captureSource.dispose(); saveService.dispose(); resourceControl.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { root, stateDir, workspace, projectRoot, project, registry, resourceControl, saveService, captureSource,
    sourceSave, markdownPath, originalBytes, resourceId: identified, updateService };
}

test('Document Update prepares persistent three-way previews without writing the Markdown Resource', async (t) => {
  const f = await fixture(t);
  const inspected = f.updateService.inspect({ projectId: f.project.project_id, resourceId: f.resourceId });
  assert.equal(inspected.resource_id, f.resourceId);
  assert.equal(inspected.baseline.sha256, sha256(f.originalBytes));
  assert.equal(inspected.baseline.text, f.originalBytes.toString('utf8'));
  assert.equal(inspected.limits.markdown_bytes, 256 * 1024);

  const request = { projectId: f.project.project_id, resourceId: f.resourceId, expectedSha256: inspected.baseline.sha256,
    oldText: '唯一旧块：早班车间隔较长。', newText: '唯一旧块：早班车间隔已缩短。', sourceSaveId: f.sourceSave.save_id,
    requestKey: 'update-first', caller: { tool: 'fixture-host', client_run_id: 'document-update-direct' } };
  const baselineChanged = Buffer.concat([f.originalBytes, Buffer.from('\n外部变化。', 'utf8')]);
  fs.writeFileSync(f.markdownPath, baselineChanged);
  assert.throws(() => f.updateService.prepare(request), { code: 'ATLAS_STATE_CONFLICT' });
  fs.writeFileSync(f.markdownPath, f.originalBytes);

  const prepared = f.updateService.prepare(request);
  assert.match(prepared.update_id, /^UPD-/u);
  assert.equal(prepared.status, 'preview_ready');
  assert.equal(prepared.baseline.sha256, sha256(f.originalBytes));
  assert.match(prepared.proposed.text, /早班车间隔已缩短/u);
  assert.equal(fs.readFileSync(f.markdownPath).toString('utf8'), f.originalBytes.toString('utf8'));
  assert.equal(f.updateService.prepare(request).update_id, prepared.update_id);
  assert.throws(() => f.updateService.prepare({ ...request, newText: '同一请求键的不同内容' }), { code: 'ATLAS_STATE_CONFLICT' });

  const externalBytes = Buffer.from(f.originalBytes.toString('utf8').replace('开头段落。', '开头段落已有独立外部修改。'), 'utf8');
  fs.writeFileSync(f.markdownPath, externalBytes);
  const conflicted = f.updateService.show(prepared.update_id, { projectId: f.project.project_id });
  assert.equal(conflicted.status, 'conflict');
  assert.equal(conflicted.conflict.kind, 'independent_change');
  assert.equal(conflicted.current.sha256, sha256(externalBytes));
  assert.equal(conflicted.baseline.sha256, sha256(f.originalBytes));
  assert.equal(conflicted.proposed.sha256, sha256(Buffer.from(f.originalBytes.toString('utf8').replace(request.oldText, request.newText), 'utf8')));
  assert.throws(() => f.updateService.decide(prepared.update_id, { projectId: f.project.project_id,
    expectedRevision: prepared.revision, expectedCurrentSha256: prepared.current.sha256, decision: 'accept-suggestion',
    requestKey: 'stale-choice', caller: request.caller }), { code: 'ATLAS_STATE_CONFLICT' });

  const kept = f.updateService.decide(prepared.update_id, { projectId: f.project.project_id, expectedRevision: conflicted.revision,
    expectedCurrentSha256: conflicted.current.sha256, decision: 'keep-current', requestKey: 'keep-current', caller: request.caller });
  assert.equal(kept.candidate.text, externalBytes.toString('utf8'));
  assert.equal(fs.readFileSync(f.markdownPath).toString('utf8'), externalBytes.toString('utf8'));
  const restarted = createDocumentUpdateService({ stateDir: f.stateDir, registry: f.registry, resourceControl: f.resourceControl, saveService: f.saveService });
  assert.equal(restarted.show(prepared.update_id, { projectId: f.project.project_id }).candidate.sha256, sha256(externalBytes));

  const nextBaseline = restarted.inspect({ projectId: f.project.project_id, resourceId: f.resourceId });
  const next = restarted.prepare({ ...request, expectedSha256: nextBaseline.baseline.sha256, requestKey: 'update-revision', oldText: request.oldText, newText: '新建议块。' });
  const independent = Buffer.from(externalBytes.toString('utf8').replace('结尾段落。', '结尾段落的新外部内容。'), 'utf8');
  fs.writeFileSync(f.markdownPath, independent);
  const changed = restarted.show(next.update_id, { projectId: f.project.project_id });
  const revised = restarted.decide(next.update_id, { projectId: f.project.project_id, expectedRevision: changed.revision,
    expectedCurrentSha256: changed.current.sha256, decision: 'revise', text: '用户修订建议块。', requestKey: 'revise-after-review', caller: request.caller });
  assert.match(revised.candidate.text, /用户修订建议块/u);
  assert.match(revised.candidate.text, /结尾段落的新外部内容/u);
  assert.equal(fs.readFileSync(f.markdownPath).toString('utf8'), independent.toString('utf8'));

  const otherProject = f.registry.create({ name: '另一项目', currentPath: '另一项目' });
  fs.mkdirSync(path.join(f.workspace, '另一项目'));
  f.registry.attachRoot(otherProject.project_id, { rootId: f.registry.show(f.project.project_id).location.root_id, relativePath: '另一项目', reason: 'Cross-project fixture.' });
  const otherPath = path.join(f.workspace, '另一项目', 'note.md'); fs.mkdirSync(path.dirname(otherPath), { recursive: true }); fs.writeFileSync(otherPath, '其他项目');
  const otherResource = f.resourceControl.identify({ filePath: otherPath, project: f.registry.show(otherProject.project_id).project }).resource_id;
  assert.throws(() => restarted.inspect({ projectId: f.project.project_id, resourceId: otherResource }), { code: 'ATLAS_STATE_CONFLICT' });

  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'linked.md'), '链接文件');
  const junction = path.join(f.projectRoot, 'linked'); fs.symlinkSync(outside, junction, 'junction');
  const linkedResource = f.resourceControl.identify({ filePath: path.join(junction, 'linked.md'), project: f.registry.show(f.project.project_id).project }).resource_id;
  assert.throws(() => restarted.inspect({ projectId: f.project.project_id, resourceId: linkedResource }), { code: 'ATLAS_STATE_CONFLICT' });
});
