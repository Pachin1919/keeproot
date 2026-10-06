import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function conversation(text) {
  return { conversation_id: 'ui-changes-conversation', title: 'UI 增量', current_node: 'answer', mapping: {
    root: { id: 'root', parent: null, children: ['answer'], message: null },
    answer: { id: 'answer', parent: 'root', children: [], message: { id: 'answer', author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] } } },
  } };
}

test('Capture Source changes UI keeps safe excerpts, modes, and previous Save navigation', async (t) => {
  const temp = path.resolve('test/.tmp'); fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, 'capture-changes-ui-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'UI 项目'), { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'UI 项目', currentPath: 'UI 项目' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'UI 项目', reason: 'Capture changes UI fixture.' });
  const save = createSaveService({ stateDir }); const capture = createCaptureSourceService({ stateDir, registry, saveService: save });
  let server;
  t.after(async () => { await server?.close(); capture.dispose(); save.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const inputPath = path.join(root, 'conversation.json');
  const prepare = async (value, key) => {
    const bytes = Buffer.from(JSON.stringify([value])); fs.writeFileSync(inputPath, bytes);
    const inspected = capture.inspectExport({ inputPath, limit: 5 });
    const prepared = await capture.prepareExport({ inputPath, expectedInputSha256: digest(bytes), selection: inspected.items[0].selection,
      projectId: project.project_id, folder: '.', name: '对话', requestKey: key, caller: { tool: 'changes-ui-test', client_run_id: key } });
    const preview = save.review(prepared.save_id);
    save.execute(prepared.save_id, { reason: 'UI changes fixture.', expectedPreviewRevision: preview.preview_revision });
    return prepared;
  };
  const first = await prepare(conversation('<script>before()</script>'), 'changes-ui-first');
  const nextConversation = conversation('<script>after()</script>');
  nextConversation.mapping.answer.message.content.parts = ['<script>after()</script>'];
  const second = await prepare(nextConversation, 'changes-ui-second');
  server = await startAtlasUiServer({ stateDir, registry, intake: save.intake, projectRoot: workspace, installationRoot: workspace });
  const url = new URL(`projects/${encodeURIComponent(project.project_id)}/capture-source/${second.save_id}?mode=changes`, server.workspace_url);
  const response = await fetch(url); assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Read changes|阅读变化/u);
  assert.match(html, /mode=full/u);
  assert.match(html, /mode=changes/u);
  assert.match(html, new RegExp(encodeURIComponent(first.save_id)));
  assert.match(html, /Open previous version|打开上一版本/u);
  assert.match(html, /&lt;script&gt;after\(\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>after\(\)<\/script>/u);
  assert.match(html, new RegExp(second.save_id));
  assert.match(html, new RegExp(capture.show(second.save_id, { projectId: project.project_id }).resource_id));
  assert.match(html, new RegExp(second.version_id));
});
