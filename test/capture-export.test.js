import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { diffChatGptConversations, normalizeChatGptConversation } from '../src/chatgpt-export-capture.js';
import { startAtlasUiServer } from '../src/ui-server.js';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function conversation(id, title, text, sentinel) {
  const root = `${id}-root`; const answer = `${id}-answer`; const alternate = `${id}-alternate`;
  return {
    conversation_id: id, title, current_node: answer,
    mapping: {
      [root]: { id: root, parent: null, children: [answer, alternate], message: null },
      [answer]: { id: answer, parent: root, children: [], message: { id: answer, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] } } },
      [alternate]: { id: alternate, parent: root, children: [], message: { id: alternate, author: { role: 'assistant' }, content: { content_type: 'text', parts: [sentinel] } } },
    },
  };
}

test('ChatGPT export node comparison distinguishes branches and incomplete captures without claiming platform deletion', () => {
  const original = conversation('conversation-branches', '分支讨论', '第一答案', '备用答案');
  const before = normalizeChatGptConversation(original);
  const nextConversation = structuredClone(original);
  const newId = 'conversation-branches-new';
  nextConversation.mapping['conversation-branches-root'].children.push(newId);
  nextConversation.mapping[newId] = { id: newId, parent: 'conversation-branches-root', children: [], message: { id: newId, author: { role: 'assistant' }, content: { content_type: 'text', parts: ['新增分支'] } } };
  nextConversation.mapping['conversation-branches-answer'].message.content.parts = ['第一答案已修订'];
  const updated = normalizeChatGptConversation(nextConversation);
  const changed = diffChatGptConversations({ normalized: updated }, { document: { normalized: before }, save: { save_id: 'SAV-before' } });
  assert.deepEqual(changed.added, [newId]);
  assert.deepEqual(changed.edited, ['conversation-branches-answer']);
  assert.equal(changed.branch_changed_count, 1);
  const partialConversation = structuredClone(original);
  delete partialConversation.mapping['conversation-branches-root'];
  const partial = normalizeChatGptConversation(partialConversation);
  assert.equal(partial.completeness.graph, 'partial');
  const missing = diffChatGptConversations({ normalized: partial }, { document: { normalized: before }, save: { save_id: 'SAV-before' } });
  assert.deepEqual(missing.absent_from_export, []);
  assert.deepEqual(missing.unobserved, ['conversation-branches-root']);
  assert.equal(Object.hasOwn(missing, 'source_deleted'), false);
});

test('ChatGPT export preserves unknown content type changes and rejects duplicate node identity', () => {
  const original = conversation('conversation-types', '类型讨论', '同一正文', '备用正文');
  const before = normalizeChatGptConversation(original);
  const changedConversation = structuredClone(original);
  changedConversation.mapping['conversation-types-answer'].message.content.content_type = 'unsupported_future_type';
  const changed = normalizeChatGptConversation(changedConversation);
  const diff = diffChatGptConversations({ normalized: changed }, { document: { normalized: before }, save: { save_id: 'SAV-before' } });
  assert.deepEqual(diff.edited, ['conversation-types-answer']);
  const duplicate = structuredClone(original);
  duplicate.mapping['conversation-types-alternate'].id = 'conversation-types-answer';
  assert.throws(() => normalizeChatGptConversation(duplicate), { code: 'ATLAS_STATE_CONFLICT' });
});

test('ChatGPT export capture selects one exact conversation, binds input bytes, and reuses Save identity', async (t) => {
  const temp = path.resolve('test/.tmp'); fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, 'capture-export-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '城市研究'); const folder = path.join(projectRoot, '参考来源');
  fs.mkdirSync(folder, { recursive: true });
  let registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市研究', currentPath: '城市研究' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市研究', reason: 'Capture export fixture.' });
  let save = createSaveService({ stateDir });
  let capture = createCaptureSourceService({ stateDir, registry, saveService: save });
  let server;
  t.after(async () => {
    await server?.close(); capture.dispose(); save.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const selected = conversation('conversation-selected', '已选对话', '选中内容初版', '已选备用分支内容');
  const other = conversation('conversation-private', '未选私聊', '另一个私聊哨兵-勿入库', '第三个哨兵-勿入库');
  const exportPath = path.join(root, 'conversations.json');
  const containerBytes = Buffer.from(`[${JSON.stringify(selected)},${JSON.stringify(other)}]\n`, 'utf8');
  fs.writeFileSync(exportPath, containerBytes);

  const inspected = capture.inspectExport({ inputPath: exportPath, limit: 10 });
  assert.equal(inspected.input_revision.sha256, digest(containerBytes));
  assert.equal(inspected.items.length, 2);
  assert.equal(inspected.items[0].title, '已选对话');
  assert.equal(inspected.items[0].provider_conversation_id, 'conversation-selected');
  assert.equal(inspected.items[0].node_count, 3);
  assert.doesNotMatch(JSON.stringify(inspected), /选中内容初版|勿入库/u);
  const selection = inspected.items[0].selection;
  const rawSelected = Buffer.from(JSON.stringify(selected), 'utf8');
  assert.equal(selection.index, 0);

  const request = {
    inputPath: exportPath, expectedInputSha256: inspected.input_revision.sha256, selection,
    projectId: project.project_id, folder: '参考来源', name: '项目对话', requestKey: 'selected-conversation',
    caller: { tool: 'fixture-host', client_run_id: 'capture-export-chain' },
  };
  const cliEnv = { ...process.env, ATLAS_STATE_DIR: stateDir };
  const cliInspect = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'capture', 'source', 'inspect-export', '--input', exportPath, '--limit', '10', '--json'], { encoding: 'utf8', env: cliEnv, windowsHide: true });
  assert.equal(cliInspect.status, 0, cliInspect.stderr);
  const cliInspectData = JSON.parse(cliInspect.stdout).data;
  assert.equal(cliInspectData.input_revision.sha256, inspected.input_revision.sha256);
  assert.equal(cliInspectData.items[0].selection_token, inspected.items[0].selection_token);

  const staleBytes = Buffer.from(containerBytes.toString('utf8').replace('选中内容初版', '选中内容改版'), 'utf8');
  assert.equal(staleBytes.length, containerBytes.length);
  fs.writeFileSync(exportPath, staleBytes);
  await assert.rejects(capture.prepareExport(request), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.existsSync(path.join(folder, '项目对话.source.json')), false);
  fs.writeFileSync(exportPath, containerBytes);

  const cliPrepare = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'capture', 'source', 'prepare-export',
    '--input', exportPath, '--expected-input-sha256', inspected.input_revision.sha256, '--selection', inspected.items[0].selection_token,
    '--project', project.project_id, '--folder', '参考来源', '--name', '项目对话', '--request-key', 'cli-selected-conversation',
    '--tool', 'fixture-host', '--client-run-id', 'capture-export-cli', '--json'], { encoding: 'utf8', env: cliEnv, windowsHide: true });
  assert.equal(cliPrepare.status, 0, cliPrepare.stderr);
  const prepared = JSON.parse(cliPrepare.stdout).data;
  assert.equal(prepared.status, 'prepared');
  const target = path.join(folder, '项目对话.source.json');
  assert.equal(fs.existsSync(target), false);
  assert.equal(prepared.diff.kind, 'initial');
  assert.equal((await capture.prepareExport(request)).save_id, prepared.save_id);
  const review = save.review(prepared.save_id);

  // The original export is rechecked at the unified Save commit boundary.
  fs.writeFileSync(exportPath, Buffer.from(`[${JSON.stringify(selected)},${JSON.stringify(other)}]\nchanged`, 'utf8'));
  assert.throws(() => save.execute(prepared.save_id, { reason: 'Fixture confirmation.', expectedPreviewRevision: review.preview_revision }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.existsSync(target), false);
  fs.writeFileSync(exportPath, containerBytes);
  const executed = save.execute(prepared.save_id, { reason: 'Fixture confirmation.', expectedPreviewRevision: review.preview_revision });
  assert.equal(executed.status, 'executed');
  const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.doesNotMatch(fs.readFileSync(save.candidateSnapshot(prepared.save_id).path, 'utf8'), /另一个私聊哨兵|第三个哨兵/u);
  assert.equal(Buffer.from(stored.raw.base64, 'base64').toString('utf8'), rawSelected.toString('utf8'));
  assert.equal(stored.raw.sha256, digest(rawSelected));
  assert.equal(stored.container.sha256, digest(containerBytes));
  assert.match(stored.readable, /选中内容初版/u);
  assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /未选私聊哨兵|另一个私聊哨兵/u);
  assert.equal(capture.show(executed.save_id, { projectId: project.project_id }).resource_id, executed.resource_id);
  assert.match(capture.read(executed.save_id, { projectId: project.project_id }).excerpt, /选中内容初版/u);
  assert.equal((await capture.prepareExport({ ...request, requestKey: 'selected-repeat' })).status, 'unchanged');

  const changed = {
    ...selected,
    mapping: {
      ...selected.mapping,
      'conversation-selected-answer': {
        ...selected.mapping['conversation-selected-answer'],
        message: {
          ...selected.mapping['conversation-selected-answer'].message,
          content: { content_type: 'text', parts: ['选中内容更新'] },
        },
      },
    },
  };
  const changedBytes = Buffer.from(`[${JSON.stringify(changed)},${JSON.stringify(other)}]\n`, 'utf8'); fs.writeFileSync(exportPath, changedBytes);
  const changedInspection = capture.inspectExport({ inputPath: exportPath, limit: 10 });
  const next = await capture.prepareExport({ ...request, expectedInputSha256: changedInspection.input_revision.sha256, selection: changedInspection.items[0].selection, requestKey: 'selected-next' });
  assert.equal(next.status, 'prepared');
  assert.equal(next.source_id, prepared.source_id);
  assert.equal(next.diff.kind, 'node_changes');
  assert.equal(next.diff.edited_count, 1);

  // A UI selection and review use the same service and ordinary Save route.
  server = await startAtlasUiServer({ stateDir, registry, intake: save.intake, projectRoot: workspace, installationRoot: workspace });
  const base = new URL(`projects/${encodeURIComponent(project.project_id)}`, server.workspace_url);
  const home = await (await fetch(base)).text();
  const csrf = home.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  assert.match(home, /capture-source\/export\/inspect/u);
  const rejectedCsrf = await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/capture-source/export/inspect`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'invalid', input_path: exportPath }),
  });
  assert.equal(rejectedCsrf.status, 403);
  const inspectResponse = await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/capture-source/export/inspect`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, input_path: exportPath }),
  });
  assert.equal(inspectResponse.status, 200);
  const inspectHtml = await inspectResponse.text();
  assert.match(inspectHtml, /已选对话/u); assert.doesNotMatch(inspectHtml, /选中内容更新|另一个私聊哨兵/u);
  assert.match(inspectHtml, /name="selection_index" value="0"/u);
  const uiSave = await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/capture-source/export/prepare`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, input_path: exportPath, expected_input_sha256: changedInspection.input_revision.sha256,
      selection_index: '0', selected_sha256: changedInspection.items[0].selection.selected_sha256,
      folder: '参考来源', name: '界面选中对话', request_key: 'ui-selected-conversation' }),
  });
  assert.equal(uiSave.status, 303);
  const uiSaveId = new URL(uiSave.headers.get('location'), server.workspace_url).pathname.split('/').at(-1);
  const uiReview = await fetch(new URL(uiSave.headers.get('location'), server.workspace_url));
  assert.equal(uiReview.status, 200); const uiReviewHtml = await uiReview.text(); assert.match(uiReviewHtml, /选中内容更新/u);
  const uiPreviewRevision = uiReviewHtml.match(/name="preview_revision" value="([a-f0-9]+)"/u)?.[1]; assert.ok(uiPreviewRevision);
  const savePath = new URL(uiSave.headers.get('location'), server.workspace_url).pathname;
  const uiExecute = await fetch(new URL(`${savePath}/execute`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, preview_revision: uiPreviewRevision }),
  });
  assert.equal(uiExecute.status, 303);
  const uiSourceDetail = await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/capture-source/${uiSaveId}`, server.workspace_url));
  assert.equal(uiSourceDetail.status, 200);
  assert.match(await uiSourceDetail.text(), /<title>ChatGPT export source · Keeproot<\/title>/u);
  const uiRaw = await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/capture-source/${uiSaveId}/raw`, server.workspace_url));
  assert.equal(uiRaw.status, 200); assert.match(uiRaw.headers.get('content-type'), /application\/json/u);
  assert.equal(await uiRaw.text(), JSON.stringify(changed));
  assert.equal(uiSaveId, next.save_id);
  assert.equal(capture.show(uiSaveId, { projectId: project.project_id }).resource_id, save.show(uiSaveId).resource_id);
  const journalText = fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8');
  assert.doesNotMatch(journalText, /未选私聊哨兵|另一个私聊哨兵|第三个哨兵/u);
  assert.ok(uiSaveId.startsWith('SAV-'));

  const latestOutput = save.show(uiSaveId);
  assert.equal(latestOutput.current_output, 'verified');
  assert.equal(save.show(prepared.save_id).current_output, 'verified');
  fs.writeFileSync(latestOutput.target.path, '外部修改最新来源输出');
  assert.equal(save.show(uiSaveId).current_output, 'changed');
  await assert.rejects(capture.prepareExport({ ...request, expectedInputSha256: changedInspection.input_revision.sha256,
    selection: changedInspection.items[0].selection, requestKey: 'latest-changed-same-version' }), { code: 'ATLAS_STATE_CONFLICT' });
  const third = structuredClone(changed);
  third.mapping['conversation-selected-answer'].message.content.parts = ['第三次会话更新'];
  const thirdBytes = Buffer.from(`[${JSON.stringify(third)},${JSON.stringify(other)}]\n`, 'utf8');
  fs.writeFileSync(exportPath, thirdBytes);
  const thirdInspection = capture.inspectExport({ inputPath: exportPath, limit: 10 });
  await assert.rejects(capture.prepareExport({ ...request, expectedInputSha256: thirdInspection.input_revision.sha256,
    selection: thirdInspection.items[0].selection, requestKey: 'new-version-after-latest-changed' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(save.show(prepared.save_id).current_output, 'verified');

  await server.close(); server = null; capture.dispose(); save.dispose(); registry.dispose();
  registry = new Registry({ stateDir }); save = createSaveService({ stateDir });
  capture = createCaptureSourceService({ stateDir, registry, saveService: save });
  assert.equal(capture.show(uiSaveId, { projectId: project.project_id }).version_id, next.version_id);
  assert.match(capture.read(uiSaveId, { projectId: project.project_id }).excerpt, /选中内容更新/u);
  assert.ok(latestOutput.target.path.startsWith(`${root}${path.sep}`));
  fs.unlinkSync(latestOutput.target.path);
  assert.equal(save.show(uiSaveId).current_output, 'missing');
  assert.equal(save.show(prepared.save_id).current_output, 'verified');
  await assert.rejects(capture.prepareExport({ ...request, expectedInputSha256: thirdInspection.input_revision.sha256,
    selection: thirdInspection.items[0].selection, requestKey: 'new-version-after-latest-missing' }), { code: 'ATLAS_STATE_CONFLICT' });
});
