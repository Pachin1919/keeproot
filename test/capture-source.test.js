import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';

function shareHtml(messages) {
  const table = [];
  function ref(value) {
    const i = table.length; table.push(null);
    if (Array.isArray(value)) table[i] = value.map(ref);
    else if (value && typeof value === 'object') table[i] = Object.fromEntries(Object.entries(value).map(([key, child]) => [`_${ref(key)}`, ref(child)]));
    else table[i] = value;
    return i;
  }
  ref({ og_title: '公开对话', backing_conversation_id: 'conversation-1', linear_conversation: messages.map((message, index) => ({
    id: message.id, parent: index ? messages[index - 1].id : null,
    message: { id: message.id, author: { role: message.role }, create_time: index + 1, content: { content_type: 'text', parts: [message.content] } },
  })) });
  return `<script>streamController.enqueue(${JSON.stringify(JSON.stringify(table))});</script>`;
}

test('Capture Source saves immutable public URL versions and returns unchanged versions without another Save', async (t) => {
  fs.mkdirSync(path.resolve('test/.tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve('test/.tmp/capture-source-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '城市研究'); const folder = path.join(projectRoot, '01_来源');
  fs.mkdirSync(folder, { recursive: true });
  let registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市研究', currentPath: '城市研究' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市研究', reason: 'Capture fixture.' });
  let save = createSaveService({ stateDir });
  let articleText = '<html><head><title>通勤研究</title><script>unsafe()</script></head><body><article><p>首段结论。</p><p>&lt;script&gt;unsafe()&lt;/script&gt;</p></article></body></html>';
  let shareText = shareHtml([{ id: 'm1', role: 'user', content: '问题一' }, { id: 'm2', role: 'assistant', content: '回答一' }]);
  const fetchImpl = async (url) => {
    const target = new URL(url);
    const body = target.pathname.includes('/share/')
      ? (target.pathname.endsWith('expired') ? '<html><title>登录 ChatGPT</title><p>Sign in</p></html>' : shareText)
      : articleText;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  let capture = createCaptureSourceService({ stateDir, registry, saveService: save, fetchImpl, lookupHost: async () => [{ address: '93.184.216.34', family: 4 }] });
  let server;
  t.after(async () => {
    await server?.close(); capture.dispose(); save.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const request = { url: 'https://example.com/article?ref=one#section', projectId: project.project_id, folder: '01_来源', name: '通勤研究', caller: { tool: 'fixture-host', client_run_id: 'capture-chain' }, requestKey: 'article-one' };
  const prepared = await capture.prepare(request);
  assert.equal(prepared.status, 'prepared'); assert.ok(prepared.save_id); assert.ok(prepared.source_id); assert.ok(prepared.version_id);
  const target = path.join(folder, '通勤研究.source.json');
  assert.equal(fs.existsSync(target), false);
  assert.equal(prepared.diff.kind, 'initial');
  const reviewed = save.review(prepared.save_id);
  const executed = save.execute(prepared.save_id, { reason: 'fixture user confirmed', expectedPreviewRevision: reviewed.preview_revision });
  assert.equal(executed.status, 'executed'); assert.ok(executed.resource_id);
  const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
  const expectedRaw = Buffer.from(articleText, 'utf8');
  assert.equal(stored.raw.sha256, crypto.createHash('sha256').update(expectedRaw).digest('hex'));
  assert.equal(Buffer.from(stored.raw.base64, 'base64').toString('utf8'), articleText);
  assert.match(stored.normalized.text, /^首段结论。/u);
  assert.match(stored.readable, /<script>unsafe/u);
  const read = capture.read(prepared.save_id, { projectId: project.project_id, characters: 4000 });
  assert.equal(read.save_id, executed.save_id); assert.equal(read.resource_id, executed.resource_id);
  assert.equal(read.current_output, 'verified'); assert.match(read.excerpt, /首段结论/u);
  assert.match(read.excerpt, /<script>unsafe\(\)<\/script>/u);
  assert.throws(() => save.execute(prepared.save_id, { reason: 'stale review', expectedPreviewRevision: '0'.repeat(64) }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.existsSync(target), true);

  capture.dispose(); save.dispose();
  const journalPath = path.join(stateDir, 'ui', 'saved-work.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.items.find((item) => item.save_id === prepared.save_id).status = 'committing';
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  save = createSaveService({ stateDir });
  capture = createCaptureSourceService({ stateDir, registry, saveService: save, fetchImpl, lookupHost: async () => [{ address: '93.184.216.34', family: 4 }] });
  const recovered = save.show(prepared.save_id);
  assert.equal(recovered.status, 'executed'); assert.equal(recovered.resource_id, executed.resource_id);
  assert.equal(recovered.current_output, 'verified');

  articleText = articleText.replace('<body>', '<meta name="shell" content="noise"><body>');
  const unchanged = await capture.prepare({ ...request, requestKey: 'article-repeat' });
  assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.save_id, prepared.save_id);
  assert.equal(fs.readdirSync(folder).filter((name) => name.endsWith('.source.json')).length, 1);
  assert.equal(save.show(prepared.save_id).save_id, executed.save_id);

  articleText = '<html><head><title>通勤研究</title></head><body><article><p>首段结论更新。</p><p>&lt;script&gt;unsafe()&lt;/script&gt;</p></article></body></html>';
  const changed = await capture.prepare({ ...request, requestKey: 'article-changed' });
  assert.equal(changed.status, 'prepared'); assert.notEqual(changed.version_id, prepared.version_id);
  assert.equal(changed.diff.kind, 'article_changed');

  const share = await capture.prepare({ ...request, url: 'https://chatgpt.com/share/share-one?x=1#frag', name: '分享对话', requestKey: 'share-one' });
  assert.equal(share.status, 'prepared'); assert.equal(share.capture_scope, 'shared_linear_conversation');
  const shareSaveReview = save.review(share.save_id);
  const shareSaved = save.execute(share.save_id, { reason: 'fixture user confirmed', expectedPreviewRevision: shareSaveReview.preview_revision });
  const shareData = JSON.parse(fs.readFileSync(path.join(folder, '分享对话.source.json'), 'utf8'));
  assert.equal(shareData.normalized.messages.length, 2);
  assert.deepEqual(share.diff, { kind: 'initial', added_count: 0, edited_count: 0, removed_count: 0, added: [], edited: [], removed: [], previous_save_id: null });
  assert.equal(capture.read(shareSaved.save_id, { projectId: project.project_id, characters: 20 }).truncated, true);

  const partialOld = shareText;
  shareText = shareHtml([{ id: 'm1', role: 'user', content: '问题一' }, { id: 'm2', role: 'assistant', content: '更新回答' }, { id: 'm3', role: 'assistant', content: '新增回答' }]);
  const shareChanged = await capture.prepare({ ...request, url: 'https://chatgpt.com/share/share-one?x=1', name: '分享对话', requestKey: 'share-changed' });
  assert.equal(shareChanged.diff.kind, 'message_changes');
  assert.deepEqual(shareChanged.diff.added, ['m3']); assert.deepEqual(shareChanged.diff.edited, ['m2']); assert.deepEqual(shareChanged.diff.removed, []);
  const shareChangedReview = save.review(shareChanged.save_id);
  save.execute(shareChanged.save_id, { reason: 'fixture user confirmed', expectedPreviewRevision: shareChangedReview.preview_revision });
  shareText = shareHtml([{ id: 'm1', role: 'user', content: '问题一' }]);
  const shareRemoved = await capture.prepare({ ...request, url: 'https://chatgpt.com/share/share-one?x=1', name: '分享对话', requestKey: 'share-removed' });
  assert.equal(shareRemoved.diff.kind, 'message_changes');
  assert.deepEqual(shareRemoved.diff.removed, ['m2', 'm3']); assert.deepEqual(shareRemoved.diff.added, []);
  shareText = shareHtml([{ role: 'user', content: '无稳定ID的问题' }, { role: 'assistant', content: '旧回答' }]);
  const unstable = await capture.prepare({ ...request, url: 'https://chatgpt.com/share/unstable', name: '不完整分享', requestKey: 'share-unstable' });
  assert.equal(unstable.completeness, 'partial');
  const unstableReview = save.review(unstable.save_id);
  save.execute(unstable.save_id, { reason: 'fixture user confirmed', expectedPreviewRevision: unstableReview.preview_revision });
  shareText = shareHtml([{ role: 'assistant', content: '新回答' }]);
  const unstableChanged = await capture.prepare({ ...request, url: 'https://chatgpt.com/share/unstable', name: '不完整分享', requestKey: 'share-unstable-change' });
  assert.equal(unstableChanged.diff.kind, 'conversation_changed');
  assert.equal(unstableChanged.diff.removed_count, null);
  shareText = partialOld.replace('linear_conversation', 'other_conversation');
  const failedShare = await capture.prepare({ ...request, url: 'https://chatgpt.com/share/expired', name: '失效分享', requestKey: 'share-expired' });
  assert.equal(failedShare.status, 'export_required');
  assert.doesNotMatch(JSON.stringify(failedShare), /Sign in|登录 ChatGPT/u);
  assert.equal(fs.existsSync(path.join(folder, '失效分享.source.json')), false);

  await assert.rejects(capture.prepare({ ...request, folder: '../outside', requestKey: 'path-escape' }), { code: 'ATLAS_STATE_CONFLICT' });
  await assert.rejects(capture.prepare({ ...request, url: 'https://example.com/other', requestKey: 'occupied-target' }), { code: 'ATLAS_STATE_CONFLICT' });

  server = await startAtlasUiServer({
    stateDir, registry, intake: save.intake, projectRoot: workspace, installationRoot: workspace,
    captureSourceOptions: { fetchImpl, lookupHost: async () => [{ address: '93.184.216.34', family: 4 }] },
  });
  const home = await (await fetch(`${server.workspace_url}projects/${encodeURIComponent(project.project_id)}`)).text();
  const csrf = home.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  assert.match(home, /capture-source\/prepare/u);
  const rejectedCsrf = await fetch(`${server.workspace_url}projects/${encodeURIComponent(project.project_id)}/capture-source/prepare`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'invalid', url: 'https://example.com/ui-article', folder: '01_来源', name: '网页入口' }),
  });
  assert.equal(rejectedCsrf.status, 403); assert.equal(fs.existsSync(path.join(folder, '网页入口.source.json')), false);
  const uiPreparedResponse = await fetch(`${server.workspace_url}projects/${encodeURIComponent(project.project_id)}/capture-source/prepare`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, url: 'https://example.com/ui-article', folder: '01_来源', name: '网页入口' }),
  });
  assert.equal(uiPreparedResponse.status, 303);
  const saveHref = uiPreparedResponse.headers.get('location'); assert.match(saveHref, /^\/saves\/SAV-/u);
  const reviewHtml = await (await fetch(new URL(saveHref, server.workspace_url))).text();
  assert.match(reviewHtml, /首段结论更新/u); assert.match(reviewHtml, /&lt;script&gt;unsafe/u);
  assert.doesNotMatch(reviewHtml, /<script>unsafe\(\)<\/script>/u);
  const previewRevision = reviewHtml.match(/name="preview_revision" value="([a-f0-9]+)"/u)?.[1]; assert.ok(previewRevision);
  const uiExecuted = await fetch(new URL(`${saveHref}/execute`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, preview_revision: previewRevision }),
  });
  assert.equal(uiExecuted.status, 303);
  const uiSaveId = saveHref.split('/').at(-1);
  const sourcePage = await (await fetch(`${server.workspace_url}projects/${encodeURIComponent(project.project_id)}/capture-source/${uiSaveId}`)).text();
  assert.match(sourcePage, /Download original response/u); assert.match(sourcePage, /首段结论更新/u);
  const download = await fetch(`${server.workspace_url}projects/${encodeURIComponent(project.project_id)}/capture-source/${uiSaveId}/raw`);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/u);
  assert.equal(await download.text(), articleText);

  await server.close(); server = null;
  capture.dispose(); save.dispose(); registry.dispose();
  registry = new Registry({ stateDir }); save = createSaveService({ stateDir });
  capture = createCaptureSourceService({ stateDir, registry, saveService: save, fetchImpl, lookupHost: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(capture.read(prepared.save_id, { projectId: project.project_id }).version_id, prepared.version_id);
  assert.throws(() => capture.read(prepared.save_id, { projectId: 'PRJ-other' }), { code: 'ATLAS_STATE_CONFLICT' });
});
