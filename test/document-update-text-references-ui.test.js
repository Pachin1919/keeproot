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
import { createBoardService } from '../src/board-service.js';

test('TXT Resources opens a shared Document Update preview with registered references', async (t) => {
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
  const target = path.join(projectRoot, '公交观察.txt');
  const original = Buffer.from('# 公交观察\n\n唯一旧块：高峰拥挤。\n', 'utf8'); fs.writeFileSync(target, original);
  const resourceId = resourceControl.identify({ filePath: target, project: registry.show(project.project_id).project }).resource_id;
  const boards = createBoardService({ stateDir, registry, resourceControl, saveService: save });
  const createdBoard = boards.createBoard({ projectId: project.project_id, title: '<script>alert(1)</script>' });
  const board = boards.saveBoard({ projectId: project.project_id, boardId: createdBoard.board_id,
    title: createdBoard.title, baseRevision: createdBoard.revision,
    blocks: [{ type: 'material_reference', resource_id: resourceId, version_policy: 'follow_latest' }] });
  const relatedPath = path.join(projectRoot, 'related.md'); fs.writeFileSync(relatedPath, 'Related reference.');
  const related = resourceControl.identify({ filePath: relatedPath, project: { id: project.project_id } });
  const referenceCaller = { tool: 'fixture', client_run_id: 'ui-references' };
  const link = resourceControl.suggestLinkedResource({ requestKey: 'ui-related', caller: referenceCaller, candidate: {
    project_id: project.project_id, source_resource_id: resourceId, target: { kind: 'resource', id: related.resource_id },
    type: 'linked_to', source_sha256: crypto.createHash('sha256').update(original).digest('hex'),
    target_sha256: related.evidence.sha256, evidence: { reason: 'Explicit fixture relation.' },
  } });
  resourceControl.decideLinkedResourceSuggestion({ projectId: project.project_id, candidateId: link.candidate_id,
    decision: 'accept', expectedRevision: link.revision, bindingDigest: link.binding_digest,
    caller: { ...referenceCaller, decision_channel: 'ui_confirm' } });
  const server = await startAtlasUiServer({ stateDir, registry, intake: save.intake, projectRoot: workspace, installationRoot: workspace });
  t.after(async () => {
    await server.close(); boards.dispose(); capture.dispose(); save.dispose(); resourceControl.dispose(); registry.dispose();
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
  assert.match(inspectHtml, /Registered references/u);
  assert.match(inspectHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(inspectHtml, /<script>alert\(1\)<\/script>/u);
  for (const objectId of [board.board_id, related.resource_id]) {
    const href = [...inspectHtml.matchAll(/href="([^"]+)"/gu)].map(match => match[1]).find(value => value.includes(objectId));
    assert.ok(href, objectId);
    const opened = await fetch(new URL(href.replaceAll('&amp;', '&'), server.workspace_url));
    assert.equal(opened.status, 200);
    assert.ok((await opened.text()).includes(objectId));
  }

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
    body: new URLSearchParams({ csrf, expected_revision: revision, expected_current_sha256: currentHash, decision: 'revise',
      request_key: 'ui-decision-1', text: '唯一旧块：修订后仍需观察。' }) });
  assert.equal(decideResponse.status, 303);
  const decidedHtml = await (await fetch(new URL(`${updatePath}`, server.workspace_url))).text();
  assert.match(decidedHtml, /Suggestion preview is ready\./u);
  assert.match(decidedHtml, /Saved suggestion/u);
  const changeSection = decidedHtml.match(/data-document-change>([\s\S]*?)<\/section>/u)?.[1];
  assert.ok(changeSection); assert.match(changeSection, /唯一旧块：修订后仍需观察。/u);
  assert.doesNotMatch(changeSection, /唯一旧块：高峰已缓解。/u);
  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'document-updates', `${updateId}.json`), 'utf8'));
  assert.equal(persisted.decision.candidate.text, original.toString('utf8').replace('唯一旧块：高峰拥挤。', '唯一旧块：修订后仍需观察。'));
  assert.ok(updateId.startsWith('UPD-'));
  assert.equal(fs.readFileSync(target).toString('utf8'), original.toString('utf8'));
  assert.equal(fs.readFileSync(target).length, original.length);
});
