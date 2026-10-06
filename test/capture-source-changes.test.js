import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { createCaptureSourceModule } from '../src/capture-source-module.js';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function conversation(id, answer) {
  return { conversation_id: id, title: '增量测试', current_node: `${id}-answer`, mapping: {
    [`${id}-root`]: { id: `${id}-root`, parent: null, children: [`${id}-answer`], message: null },
    [`${id}-answer`]: { id: `${id}-answer`, parent: `${id}-root`, children: [], message: { id: `${id}-answer`, author: { role: 'assistant' }, content: { content_type: 'text', parts: [answer] } } },
  } };
}
function shareHtml(messages) {
  const table = [];
  function ref(value) {
    const i = table.length; table.push(null);
    if (Array.isArray(value)) table[i] = value.map(ref);
    else if (value && typeof value === 'object') table[i] = Object.fromEntries(Object.entries(value).map(([key, child]) => [`_${ref(key)}`, ref(child)]));
    else table[i] = value;
    return i;
  }
  ref({ og_title: '增量分享', backing_conversation_id: 'share-chain', linear_conversation: messages.map((message, index) => ({
    id: message.id, parent: index ? messages[index - 1].id : null,
    message: { id: message.id, author: { role: message.role }, content: { content_type: 'text', parts: [message.content] } },
  })) });
  return `<script>streamController.enqueue(${JSON.stringify(JSON.stringify(table))});</script>`;
}

test('Capture Source changes read recomputes all version differences and binds paged cursors', async (t) => {
  const temp = path.resolve('test/.tmp'); fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, 'capture-changes-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '增量项目'); fs.mkdirSync(projectRoot, { recursive: true });
  let registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '增量项目', currentPath: '增量项目' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '增量项目', reason: 'Capture changes fixture.' });
  const save = createSaveService({ stateDir });
  const capture = createCaptureSourceService({ stateDir, registry, saveService: save });
  t.after(() => { capture.dispose(); save.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const inputPath = path.join(root, 'conversations.json');
  const readBytes = (conversationValue) => { const bytes = Buffer.from(JSON.stringify([conversationValue])); fs.writeFileSync(inputPath, bytes); return bytes; };
  const prepare = async (value, requestKey) => {
    const bytes = readBytes(value); const inspected = capture.inspectExport({ inputPath, limit: 10 });
    const result = await capture.prepareExport({ inputPath, expectedInputSha256: digest(bytes), selection: inspected.items[0].selection,
      projectId: project.project_id, folder: '.', name: '对话', requestKey, caller: { tool: 'capture-changes-test', client_run_id: requestKey } });
    const preview = save.review(result.save_id);
    const executed = save.execute(result.save_id, { reason: 'Test the saved conversation version.', expectedPreviewRevision: preview.preview_revision });
    return { ...result, resource_id: executed.resource_id };
  };
  const original = conversation('changes-conversation', '初始文本');
  const first = await prepare(original, 'changes-first');
  const initial = capture.read(first.save_id, { projectId: project.project_id, mode: 'changes' });
  assert.equal(initial.comparison.status, 'comparison_not_available');
  assert.equal(initial.comparison.reason, 'no_previous_version');
  assert.match(initial.excerpt, /初始文本/u);

  const longBefore = `BEFORE-${'b'.repeat(5_000)}-BEFORE-END`;
  const longAfter = `AFTER-${'a'.repeat(9_000)}-AFTER-END`;
  const beforeEdit = structuredClone(original);
  beforeEdit.mapping['changes-conversation-answer'].message.content.parts = [longBefore];
  const second = await prepare(beforeEdit, 'changes-second');
  const edited = structuredClone(beforeEdit);
  const rootNode = edited.mapping['changes-conversation-root'];
  for (let index = 0; index < 120; index += 1) {
    const id = `extra-${String(index).padStart(3, '0')}`; rootNode.children.push(id);
    edited.mapping[id] = { id, parent: 'changes-conversation-root', children: [], message: { id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [`added-${id}`] } } };
  }
  edited.mapping['changes-conversation-answer'].message.content.parts = [longAfter];
  const third = await prepare(edited, 'changes-third');
  const journalPath = path.join(stateDir, 'ui', 'saved-work.json');
  const journalBeforeReads = fs.readFileSync(journalPath);
  const outputBeforeReads = fs.readFileSync(save.show(third.save_id).target.path);
  const page = capture.read(third.save_id, { projectId: project.project_id, mode: 'changes', characters: 4_000 });
  assert.equal(page.comparison.status, 'available');
  assert.equal(page.comparison.added_count, 120);
  assert.equal(page.comparison.edited_count, 1);
  assert.ok(page.comparison.branch_changed_count >= 1);
  assert.equal(page.previous_save_id, second.save_id);
  assert.equal(page.previous_resource_id, second.resource_id);
  assert.equal(page.current_output, 'verified');
  assert.equal(page.previous_output, 'verified');
  assert.ok(page.truncated);
  assert.throws(() => capture.read(third.save_id, { projectId: project.project_id, mode: 'full', cursor: page.next_cursor }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => capture.read(second.save_id, { projectId: project.project_id, mode: 'changes', cursor: page.next_cursor }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => capture.read(third.save_id, { projectId: 'PRJ-other', mode: 'changes', cursor: page.next_cursor }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => capture.read(third.save_id, { projectId: project.project_id, mode: 'changes', cursor: Buffer.from('null').toString('base64url') }), { code: 'ATLAS_STATE_CONFLICT' });
  const cursorValue = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString('utf8'));
  assert.throws(() => capture.read(third.save_id, { projectId: project.project_id, mode: 'changes', cursor: Buffer.from(JSON.stringify({ ...cursorValue, previous_sha256: 'f'.repeat(64) })).toString('base64url') }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => capture.read(third.save_id, { projectId: project.project_id, mode: 'changes', cursor: Buffer.from(JSON.stringify({ ...cursorValue, offset: 1_000_000 })).toString('base64url') }), { code: 'ATLAS_STATE_CONFLICT' });
  const legacyCursor = Buffer.from(JSON.stringify({ save_id: third.save_id, sha256: save.candidateSnapshot(third.save_id).sha256, offset: 1 })).toString('base64url');
  assert.equal(capture.read(third.save_id, { projectId: project.project_id, cursor: legacyCursor }).start_character, 1);
  let content = page.excerpt; let cursor = page.next_cursor;
  while (cursor) { const next = capture.read(third.save_id, { projectId: project.project_id, mode: 'changes', cursor, characters: 4_000 }); content += next.excerpt; cursor = next.next_cursor; }
  assert.match(content, /extra-119/u);
  assert.match(content, new RegExp(longBefore));
  assert.match(content, new RegExp(longAfter));
  assert.match(content, /"kind":"edited"/u);
  assert.equal(capture.read(third.save_id, { projectId: project.project_id }).mode, 'full');
  const module = createCaptureSourceModule({ captureSource: { inspectExport() {}, prepareExport() {}, prepare() {}, show() {}, read: (...args) => capture.read(...args) } });
  const delegated = await module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', project_id: project.project_id, action: 'read', parameters: { saveId: third.save_id, mode: 'changes' } });
  assert.equal(delegated.data.mode, 'changes');
  assert.equal(save.show(third.save_id).resource_id, third.resource_id);
  assert.deepEqual(fs.readFileSync(journalPath), journalBeforeReads);
  assert.deepEqual(fs.readFileSync(save.show(third.save_id).target.path), outputBeforeReads);

  const partial = structuredClone(edited);
  delete partial.mapping['extra-000'];
  const fourth = await prepare(partial, 'changes-fourth-partial');
  const partialPage = capture.read(fourth.save_id, { projectId: project.project_id, mode: 'changes' });
  assert.equal(partialPage.comparison.absent_from_export_count, 0);
  assert.equal(partialPage.comparison.unobserved_count, 1);
  assert.match(partialPage.excerpt, /"kind":"unobserved"/u);
  assert.match(partialPage.excerpt, /"before_text":"added-extra-000"/u);
});

test('Capture Source Module delegates the requested changes read mode', async () => {
  let received;
  const captureSource = { inspectExport() {}, prepareExport() {}, prepare() {}, show() {}, read(saveId, options) { received = { saveId, ...options }; return { excerpt: '' }; } };
  const module = createCaptureSourceModule({ captureSource });
  await module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', project_id: 'PRJ-example', action: 'read',
    parameters: { saveId: 'SAV-example', mode: 'changes', characters: 4_000 } });
  assert.equal(received.mode, 'changes');
});

test('Capture Source changes reports stable share edits, rejects partial share comparison, and marks articles inapplicable', async (t) => {
  const temp = path.resolve('test/.tmp'); fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, 'capture-changes-modes-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'Modes'), { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'Modes', currentPath: 'Modes' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Modes', reason: 'Capture changes modes fixture.' });
  const save = createSaveService({ stateDir }); let shareBody = '';
  const fetchImpl = async (url) => new Response(new URL(url).pathname.includes('/share/') ? shareBody : '<html><head><title>Article</title></head><body><article><p>Article body.</p></article></body></html>',
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const capture = createCaptureSourceService({ stateDir, registry, saveService: save, fetchImpl, lookupHost: async () => [{ address: '93.184.216.34', family: 4 }] });
  t.after(() => { capture.dispose(); save.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const request = async (key) => {
    const result = await capture.prepare({ url: 'https://chatgpt.com/share/changes-mode', projectId: project.project_id, folder: '.', name: '分享', requestKey: key,
      caller: { tool: 'capture-changes-modes-test', client_run_id: key } });
    const preview = save.review(result.save_id);
    save.execute(result.save_id, { reason: 'Capture share version.', expectedPreviewRevision: preview.preview_revision });
    return result;
  };
  shareBody = shareHtml([{ id: 'm1', role: 'user', content: 'Question' }, { id: 'm2', role: 'assistant', content: 'Before' }]);
  const first = await request('share-mode-first');
  assert.equal(capture.read(first.save_id, { projectId: project.project_id, mode: 'changes' }).comparison.reason, 'no_previous_version');
  shareBody = shareHtml([{ id: 'm1', role: 'user', content: 'Question' }, { id: 'm2', role: 'assistant', content: 'After' }, { id: 'm3', role: 'assistant', content: 'Added' }]);
  const second = await request('share-mode-second');
  const shareChanges = capture.read(second.save_id, { projectId: project.project_id, mode: 'changes' });
  assert.equal(shareChanges.comparison.status, 'available');
  assert.equal(shareChanges.comparison.edited_count, 1);
  assert.equal(shareChanges.comparison.added_count, 1);
  assert.match(shareChanges.excerpt, /Before/u); assert.match(shareChanges.excerpt, /After/u);
  shareBody = shareHtml([{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Partial answer' }]);
  const third = await request('share-mode-partial');
  const unavailable = capture.read(third.save_id, { projectId: project.project_id, mode: 'changes' });
  assert.equal(unavailable.comparison.status, 'comparison_not_available');
  assert.equal(unavailable.comparison.reason, 'stable_complete_message_ids_required');
  assert.match(unavailable.excerpt, /Partial answer/u);

  const article = await capture.prepare({ url: 'https://example.com/article', projectId: project.project_id, folder: '.', name: '文章', requestKey: 'article-mode',
    caller: { tool: 'capture-changes-modes-test', client_run_id: 'article-mode' } });
  const articleReview = save.review(article.save_id);
  save.execute(article.save_id, { reason: 'Capture article.', expectedPreviewRevision: articleReview.preview_revision });
  const articleChanges = capture.read(article.save_id, { projectId: project.project_id, mode: 'changes' });
  assert.equal(articleChanges.comparison.status, 'comparison_not_available');
  assert.equal(articleChanges.comparison.reason, 'capture_mode_not_supported_for_changes');
  assert.match(articleChanges.excerpt, /Article body/u);
});
