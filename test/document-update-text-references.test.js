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
import { createBoardService } from '../src/board-service.js';
import { CAPABILITIES } from '../src/protocol.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/document-text-references-'));
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
    folder: '01_来源', name: '来源', requestKey: 'source-save', caller: { tool: 'fixture', client_run_id: 'document-text-references-source' } });
  const sourceReview = saveService.review(sourcePrepared.save_id);
  const sourceSave = saveService.execute(sourcePrepared.save_id, { reason: 'fixture confirmed', expectedPreviewRevision: sourceReview.preview_revision });
  const markdownPath = path.join(projectRoot, '知识笔记', '公交方案观察.txt');
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

test('UTF-8 TXT shares the Document Update Resource identity and exposes registered references', async (t) => {
  const f = await fixture(t);
  const inspected = f.updateService.inspect({ projectId: f.project.project_id, resourceId: f.resourceId });
  assert.equal(inspected.baseline.text, f.originalBytes.toString('utf8'));
  assert.equal(inspected.references.scope, 'registered_project_references');
  assert.equal(inspected.references.status, 'complete');
  assert.equal(inspected.references.known_total, 0);
  assert.equal(inspected.references.file_verification, 'not_checked');
  const projectId = f.project.project_id; const caller = { tool: 'text-host', client_run_id: 'append-replace' };
  const request = { projectId, resourceId: f.resourceId, expectedSha256: inspected.baseline.sha256,
    oldText: '', newText: '中文追加建议。', sourceSaveId: f.sourceSave.save_id, requestKey: 'append', caller };
  const p = f.updateService.prepare(request);
  assert.equal(p.change.kind, 'append');
  assert.equal(p.resource_id, f.resourceId);
  const keep = f.updateService.decide(p.update_id, { projectId, expectedRevision: p.revision,
    expectedCurrentSha256: p.current.sha256, decision: 'keep-current', requestKey: 'keep', caller });
  assert.throws(() => f.updateService.execute(p.update_id, { projectId, expectedRevision: keep.revision,
    expectedCurrentSha256: keep.current.sha256, requestKey: 'keep-execute', caller }));
  assert.equal(fs.readFileSync(f.markdownPath, 'utf8'), f.originalBytes.toString('utf8'));
  const d = f.updateService.decide(p.update_id, { projectId, expectedRevision: keep.revision,
    expectedCurrentSha256: keep.current.sha256, decision: 'revise', text: '最终确认追加。', requestKey: 'revise', caller });
  assert.equal(d.change.confirmed_text, '最终确认追加。');
  assert.equal(d.change.suggested_text, '中文追加建议。');
  const a = f.updateService.execute(p.update_id, { projectId, expectedRevision: d.revision,
    expectedCurrentSha256: d.current.sha256, requestKey: 'apply', caller });
  assert.equal(a.resource_id, f.resourceId); assert.equal(a.status, 'applied');
  assert.equal(fs.readFileSync(f.markdownPath, 'utf8'), `${f.originalBytes.toString('utf8')}最终确认追加。`);
  const u = f.updateService.undo(p.update_id, { projectId, expectedRevision: a.revision,
    expectedCurrentSha256: a.current.sha256, requestKey: 'undo', caller });
  assert.equal(u.resource_id, f.resourceId); assert.deepEqual(fs.readFileSync(f.markdownPath), f.originalBytes);
  const replacement = f.updateService.prepare({ ...request, requestKey: 'replace', oldText: '唯一旧块：早班车间隔较长。', newText: '唯一新块。' });
  const confirmed = f.updateService.decide(replacement.update_id, { projectId, expectedRevision: replacement.revision,
    expectedCurrentSha256: replacement.current.sha256, decision: 'accept-suggestion', requestKey: 'replace-confirm', caller });
  const applied = f.updateService.execute(replacement.update_id, { projectId, expectedRevision: confirmed.revision,
    expectedCurrentSha256: confirmed.current.sha256, requestKey: 'replace-apply', caller });
  assert.equal(applied.change.kind, 'replace'); assert.equal(applied.change.confirmed_text, '唯一新块。');
  assert.equal(applied.resource_id, f.resourceId);
  assert.equal(fs.readFileSync(f.markdownPath, 'utf8'), f.originalBytes.toString('utf8').replace('唯一旧块：早班车间隔较长。', '唯一新块。'));
  f.updateService.undo(replacement.update_id, { projectId, expectedRevision: applied.revision,
    expectedCurrentSha256: applied.current.sha256, requestKey: 'replace-undo', caller });
  assert.deepEqual(fs.readFileSync(f.markdownPath), f.originalBytes);
  fs.appendFileSync(f.markdownPath, '后来变化');
  assert.throws(() => f.updateService.prepare({ ...request, requestKey: 'stale' }));
  fs.writeFileSync(f.markdownPath, Buffer.from([0xff, 0xfe]));
  assert.throws(() => f.updateService.inspect({ projectId, resourceId: f.resourceId }));
  const unsupported = path.join(f.projectRoot, 'unsupported.csv'); fs.writeFileSync(unsupported, 'a,b');
  const unsupportedId = f.resourceControl.identify({ filePath: unsupported, project: { id: projectId } }).resource_id;
  assert.throws(() => f.updateService.inspect({ projectId, resourceId: unsupportedId }));
  assert.deepEqual(CAPABILITIES.document_update.formats, ['md', 'txt']);
});

test('registered relationship, Work, saved Result and Board references read live without changing their objects', async (t) => {
  const f = await fixture(t); const projectId = f.project.project_id; const at = new Date().toISOString();
  const caller = { tool: 'references-test', client_run_id: 'references' };
  const otherPath = path.join(f.projectRoot, 'related.md'); fs.writeFileSync(otherPath, 'related');
  const other = f.resourceControl.identify({ filePath: otherPath, project: { id: projectId } });
  const link = f.resourceControl.suggestLinkedResource({ requestKey: 'link', caller, candidate: {
    project_id: projectId, source_resource_id: f.resourceId, target: { kind: 'resource', id: other.resource_id }, type: 'linked_to',
    source_sha256: sha256(f.originalBytes), target_sha256: other.evidence.sha256, evidence: { reason: 'Recorded relation only.' },
  } });
  const accepted = f.resourceControl.decideLinkedResourceSuggestion({ projectId, candidateId: link.candidate_id,
    decision: 'accept', expectedRevision: link.revision, bindingDigest: link.binding_digest, caller: { ...caller, decision_channel: 'ui_confirm' } });
  const work = f.registry.ledger.workSessions.create({ projectId, resourceIds: [f.resourceId], intent: '<img src=x onerror=alert(1)>', at });
  const resultFolder = path.join(f.projectRoot, '结果'); fs.mkdirSync(resultFolder);
  const candidate = path.join(f.stateDir, 'reference-candidate.txt'); fs.writeFileSync(candidate, 'saved dependent result');
  const resultPrepared = f.saveService.prepare({ root: f.workspace, candidateFile: candidate, projectId,
    target: '城市研究/结果/result.txt', inputs: [f.markdownPath], origin: 'agent_generated', kind: 'intermediate', channel: 'host',
    requestKey: 'result', caller, source: { path: f.markdownPath, resource_id: f.resourceId,
      sources: [{ path: f.markdownPath, resource_id: f.resourceId, version_policy: 'follow_latest' }] },
    parameters: { work_session_id: work.session_id }, intent: 'Registered result source.' });
  const result = f.saveService.execute(resultPrepared.save_id, { reason: 'Fixture accepted.' });
  const boards = createBoardService({ stateDir: f.stateDir, registry: f.registry, resourceControl: f.resourceControl, saveService: f.saveService });
  t.after(() => boards.dispose());
  const created = boards.createBoard({ projectId, title: '<script>alert(1)</script>' });
  const board = boards.saveBoard({ projectId, boardId: created.board_id, title: created.title, baseRevision: created.revision,
    blocks: [{ type: 'material_reference', resource_id: f.resourceId, version_policy: 'follow_latest' },
      { type: 'material_reference', resource_id: f.resourceId, version_policy: 'pinned_version' },
      { type: 'result_preview', save_id: result.save_id, version_policy: 'pinned_version' }] });
  const outsider = f.registry.create({ name: '外部项目', currentPath: '外部项目' }); fs.mkdirSync(path.join(f.workspace, '外部项目'));
  f.registry.attachRoot(outsider.project_id, { rootId: f.registry.show(projectId).location.root_id, relativePath: '外部项目', reason: 'Reference isolation fixture.' });
  const outsideWork = f.registry.ledger.workSessions.create({ projectId: outsider.project_id, resourceIds: [f.resourceId], intent: 'must not leak', at });
  const outsideBoard = f.registry.ledger.boards.create({ projectId: outsider.project_id, title: 'must not leak', at });
  f.registry.ledger.boards.save({ projectId: outsider.project_id, boardId: outsideBoard.board_id, title: outsideBoard.title,
    baseRevision: outsideBoard.revision, blocks: [{ block_id: `BLK-${crypto.randomUUID()}`, type: 'material_reference', resource_id: f.resourceId }], at });
  const p = f.updateService.prepare({ projectId, resourceId: f.resourceId, expectedSha256: sha256(f.originalBytes),
    oldText: '', newText: 'proposal', sourceSaveId: f.sourceSave.save_id, requestKey: 'update', caller });
  const recordPath = path.join(f.stateDir, 'document-updates', `${p.update_id}.json`);
  const upBefore = fs.readFileSync(recordPath); const boardBefore = JSON.stringify(f.registry.ledger.boards.byId(board.board_id));
  const savesBefore = fs.readFileSync(path.join(f.stateDir, 'ui', 'saved-work.json'));
  const sourcePath = f.resourceControl.projectResource(projectId, f.sourceSave.resource_id).locations.find(x => x.status === 'active').path;
  const sourceBytes = fs.readFileSync(sourcePath);
  const inspected = f.updateService.inspect({ projectId, resourceId: f.resourceId });
  const shown = f.updateService.show(p.update_id, { projectId });
  assert.deepEqual(inspected.references, shown.references);
  const references = shown.references;
  assert.equal(references.status, 'complete'); assert.equal(references.known_total, 6); assert.equal(references.truncated, false);
  assert.equal(references.entries.filter(e => e.kind === 'board_reference').length, 3);
  assert.deepEqual(new Set(references.entries.map(e => e.kind)), new Set(['related_resource', 'work_source', 'saved_result_source', 'board_reference']));
  assert.ok(references.entries.some(e => e.relationship_id === accepted.receipt.relationship.id && e.direction === 'outgoing'));
  assert.ok(references.entries.some(e => e.work_id === work.session_id && e.version_policy === 'follow_latest' && e.revision === work.revision));
  assert.ok(references.entries.some(e => e.save_id === result.save_id && e.resource_id === result.resource_id && e.href === `/saves/${result.save_id}`));
  assert.ok(references.entries.some(e => e.board_id === board.board_id && e.version_policy === 'pinned_version'));
  assert.ok(!references.entries.some(e => e.work_id === outsideWork.session_id || e.board_id === outsideBoard.board_id));
  assert.equal(references.file_verification, 'not_checked');
  assert.deepEqual(fs.readFileSync(recordPath), upBefore); assert.equal(JSON.stringify(f.registry.ledger.boards.byId(board.board_id)), boardBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'ui', 'saved-work.json')), savesBefore);
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes); assert.deepEqual(fs.readFileSync(f.markdownPath), f.originalBytes);
  f.registry.ledger.resources.updateRelationshipStatus(accepted.receipt.relationship.id, 'removed');
  const updated = boards.saveBoard({ projectId, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [] });
  const afterRemoval = f.updateService.show(p.update_id, { projectId });
  assert.equal(afterRemoval.references.known_total, 2); assert.equal(afterRemoval.revision, p.revision);
  boards.saveBoard({ projectId, boardId: updated.board_id, title: updated.title, baseRevision: updated.revision,
    blocks: [{ type: 'material_reference', resource_id: f.resourceId, version_policy: 'follow_latest' }] });
  assert.equal(f.updateService.show(p.update_id, { projectId }).references.known_total, 3);
  fs.writeFileSync(path.join(f.stateDir, 'ui', 'saved-work.json'), '{broken');
  const unreadable = f.updateService.show(p.update_id, { projectId }).references;
  assert.equal(unreadable.status, 'unknown'); assert.ok(unreadable.unavailable_kinds.includes('saved_result_source'));
  assert.deepEqual(fs.readFileSync(recordPath), upBefore);
});

test('references filter Work by exact Resource before bounding 100 displayed entries', async (t) => {
  const f = await fixture(t); const projectId = f.project.project_id; const at = new Date().toISOString();
  for (let n = 0; n < 105; n += 1) f.registry.ledger.workSessions.create({ projectId, resourceIds: [], intent: `unrelated ${n}`, at });
  for (let n = 0; n < 103; n += 1) f.registry.ledger.workSessions.create({ projectId, resourceIds: [f.resourceId], intent: `matching ${n}`, at });
  const references = f.updateService.inspect({ projectId, resourceId: f.resourceId }).references;
  assert.equal(references.known_total, 103); assert.equal(references.entries.length, 100); assert.equal(references.truncated, true);
  assert.ok(references.entries.every(e => e.title.startsWith('matching')));
  assert.deepEqual(references, f.updateService.inspect({ projectId, resourceId: f.resourceId }).references);
});
