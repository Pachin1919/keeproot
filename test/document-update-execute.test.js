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

test('same Resource execute, idempotency, refusal of stale facts and Undo after later change', async (t) => {
  const f = await fixture(t); const projectId = f.project.project_id;
  const caller = { tool: 'fixture-host', client_run_id: 'execute-direct' };
  const sourceBefore = JSON.stringify(f.saveService.show(f.sourceSave.save_id));
  const prepared = f.updateService.prepare({ projectId, resourceId: f.resourceId, expectedSha256: sha256(f.originalBytes),
    oldText: '唯一旧块：早班车间隔较长。', newText: '唯一旧块：早班车间隔已缩短。', sourceSaveId: f.sourceSave.save_id,
    requestKey: 'prepare', caller });
  // Exercise the previously blocked positional UPD CLI decide path.
  const cli = spawnSync(process.execPath, ['bin/atlas.js', 'document', 'update', 'decide', prepared.update_id,
    '--project', projectId, '--expected-revision', String(prepared.revision), '--expected-current-sha256', prepared.current.sha256,
    '--decision', 'accept-suggestion', '--request-key', 'decide', '--tool', caller.tool, '--client-run-id', caller.client_run_id, '--json'],
  { encoding: 'utf8', timeout: 15000, env: { ...process.env, ATLAS_STATE_DIR: f.stateDir } });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const decided = f.updateService.show(prepared.update_id, { projectId });
  assert.equal(decided.decision.kind, 'accept-suggestion');
  assert.equal(fs.readFileSync(f.markdownPath, 'utf8'), f.originalBytes.toString('utf8'));
  const options = { projectId, expectedRevision: decided.revision, expectedCurrentSha256: decided.current.sha256, requestKey: 'execute', caller };
  assert.throws(() => f.updateService.execute(prepared.update_id, { ...options, projectId: 'other-project' }));
  assert.throws(() => f.updateService.execute(prepared.update_id, { ...options, expectedRevision: 1 }));
  const sourcePath = f.resourceControl.projectResource(projectId, f.sourceSave.resource_id).locations.find(x => x.status === 'active').path;
  const sourceBytes = fs.readFileSync(sourcePath); fs.appendFileSync(sourcePath, 'source changed');
  assert.throws(() => f.updateService.execute(prepared.update_id, options));
  fs.writeFileSync(sourcePath, sourceBytes);
  fs.appendFileSync(f.markdownPath, '后改');
  assert.throws(() => f.updateService.execute(prepared.update_id, options));
  fs.writeFileSync(f.markdownPath, f.originalBytes);
  const applied = f.updateService.execute(prepared.update_id, options);
  assert.equal(applied.status, 'applied'); assert.equal(applied.resource_id, f.resourceId);
  assert.equal(applied.execution.before.text, f.originalBytes.toString('utf8'));
  assert.equal(applied.current.sha256, applied.candidate.sha256);
  assert.equal(f.resourceControl.projectResource(projectId, f.resourceId).content_hash, applied.candidate.sha256);
  assert.equal(JSON.stringify(f.saveService.show(f.sourceSave.save_id)), sourceBefore);
  assert.equal(f.updateService.execute(prepared.update_id, options).revision, applied.revision);
  assert.throws(() => f.updateService.execute(prepared.update_id, { ...options, expectedRevision: applied.revision }));
  assert.equal(f.resourceControl.describe(f.resourceId).actions.filter(a => a.action_type === 'document_update_execute').length, 1);
  fs.appendFileSync(f.markdownPath, '禁止覆盖的后改');
  const changed = f.updateService.show(prepared.update_id, { projectId });
  assert.throws(() => f.updateService.undo(prepared.update_id, { ...options, expectedRevision: changed.revision,
    expectedCurrentSha256: changed.current.sha256, requestKey: 'undo-changed' }));
  fs.writeFileSync(f.markdownPath, applied.candidate.text);
  fs.appendFileSync(sourcePath, 'Undo still available after source changes');
  const undone = f.updateService.undo(prepared.update_id, { ...options, expectedRevision: applied.revision,
    expectedCurrentSha256: applied.current.sha256, requestKey: 'undo' });
  assert.equal(undone.status, 'undone'); assert.equal(undone.resource_id, f.resourceId);
  assert.equal(fs.readFileSync(f.markdownPath, 'utf8'), f.originalBytes.toString('utf8'));
  assert.ok(CAPABILITIES.workflows.document_update.includes('recover'));
  assert.match(CAPABILITIES.document_update.write_support, /Windows_NTFS/u);
});

for (const point of ['before-write', 'after-write', 'after-ledger']) {
  test(`explicit interrupted recovery at ${point} never retries a write`, async (t) => {
    const f = await fixture(t); const projectId = f.project.project_id;
    const caller = { tool: 'fixture', client_run_id: point };
    const p = f.updateService.prepare({ projectId, resourceId: f.resourceId, expectedSha256: sha256(f.originalBytes),
      oldText: '唯一旧块：早班车间隔较长。', newText: '完整修改块。', sourceSaveId: f.sourceSave.save_id, requestKey: 'prepare', caller });
    const d = f.updateService.decide(p.update_id, { projectId, expectedRevision: p.revision, expectedCurrentSha256: p.current.sha256,
      decision: 'accept-suggestion', requestKey: 'decide', caller });
    f.updateService.operationHook = (stage) => { if (stage === point) throw new Error('controlled interruption'); };
    assert.throws(() => f.updateService.execute(p.update_id, { projectId, expectedRevision: d.revision,
      expectedCurrentSha256: d.current.sha256, requestKey: 'execute', caller }), /controlled interruption/u);
    f.updateService.operationHook = () => {};
    const pending = f.updateService.show(p.update_id, { projectId }); assert.equal(pending.status, 'pending_recovery');
    assert.throws(() => f.updateService.decide(p.update_id, { projectId, expectedRevision: pending.revision,
      expectedCurrentSha256: pending.current.sha256, decision: 'keep-current', requestKey: 'blocked', caller }));
    if (point === 'after-ledger') {
      fs.writeFileSync(f.markdownPath, f.originalBytes);
      assert.throws(() => f.updateService.recover(p.update_id, { projectId, expectedRevision: pending.revision,
        expectedCurrentSha256: sha256(f.originalBytes), requestKey: 'recorded-before-conflict', caller }));
      assert.equal(f.updateService.show(p.update_id, { projectId }).status, 'pending_recovery');
      fs.writeFileSync(f.markdownPath, d.candidate.text);
    }
    if (point === 'after-write') {
      const sourcePath = f.resourceControl.projectResource(projectId, f.sourceSave.resource_id).locations.find(x => x.status === 'active').path;
      fs.appendFileSync(sourcePath, 'source changed after commit');
    }
    const recovered = f.updateService.recover(p.update_id, { projectId, expectedRevision: pending.revision,
      expectedCurrentSha256: pending.current.sha256, requestKey: 'recover', caller });
    assert.equal(recovered.recovery.outcome, point === 'before-write' ? 'not_applied' : 'applied');
    assert.equal(fs.readFileSync(f.markdownPath, 'utf8'), point === 'before-write' ? f.originalBytes.toString('utf8') : d.candidate.text);
    assert.equal(f.resourceControl.describe(f.resourceId).actions.filter(a => a.action_type === 'document_update_execute').length, point === 'before-write' ? 0 : 1);
    if (point === 'before-write') assert.equal(recovered.decision, null);
  });
}

test('pending recovery refuses third hash and replaced identity', async (t) => {
  const f = await fixture(t); const projectId = f.project.project_id; const caller = { tool: 'fixture', client_run_id: 'conflict' };
  const p = f.updateService.prepare({ projectId, resourceId: f.resourceId, expectedSha256: sha256(f.originalBytes),
    oldText: '唯一旧块：早班车间隔较长。', newText: '改块', sourceSaveId: f.sourceSave.save_id, requestKey: 'p', caller });
  const d = f.updateService.decide(p.update_id, { projectId, expectedRevision: p.revision, expectedCurrentSha256: p.current.sha256,
    decision: 'accept-suggestion', requestKey: 'd', caller });
  f.updateService.operationHook = () => { throw new Error('controlled interruption'); };
  assert.throws(() => f.updateService.execute(p.update_id, { projectId, expectedRevision: d.revision,
    expectedCurrentSha256: d.current.sha256, requestKey: 'e', caller }));
  f.updateService.operationHook = () => {};
  fs.writeFileSync(f.markdownPath, '第三版本');
  let shown = f.updateService.show(p.update_id, { projectId });
  assert.throws(() => f.updateService.recover(p.update_id, { projectId, expectedRevision: shown.revision,
    expectedCurrentSha256: shown.current.sha256, requestKey: 'r', caller }));
  fs.renameSync(f.markdownPath, `${f.markdownPath}.old`); fs.writeFileSync(f.markdownPath, f.originalBytes);
  shown = f.updateService.show(p.update_id, { projectId });
  assert.throws(() => f.updateService.recover(p.update_id, { projectId, expectedRevision: shown.revision,
    expectedCurrentSha256: shown.current.sha256, requestKey: 'r2', caller }));
  assert.equal(fs.readFileSync(f.markdownPath, 'utf8'), f.originalBytes.toString('utf8'));
});

test('interrupted Undo recovers its committed original bytes with one Undo action', async (t) => {
  const f = await fixture(t); const projectId = f.project.project_id; const caller = { tool: 'fixture', client_run_id: 'undo-recovery' };
  const p = f.updateService.prepare({ projectId, resourceId: f.resourceId, expectedSha256: sha256(f.originalBytes),
    oldText: '唯一旧块：早班车间隔较长。', newText: '改块', sourceSaveId: f.sourceSave.save_id, requestKey: 'p', caller });
  const d = f.updateService.decide(p.update_id, { projectId, expectedRevision: p.revision, expectedCurrentSha256: p.current.sha256,
    decision: 'accept-suggestion', requestKey: 'd', caller });
  const a = f.updateService.execute(p.update_id, { projectId, expectedRevision: d.revision,
    expectedCurrentSha256: d.current.sha256, requestKey: 'e', caller });
  f.updateService.operationHook = (stage) => { if (stage === 'after-write') throw new Error('interrupted Undo'); };
  assert.throws(() => f.updateService.undo(p.update_id, { projectId, expectedRevision: a.revision,
    expectedCurrentSha256: a.current.sha256, requestKey: 'u', caller }), /interrupted Undo/u);
  f.updateService.operationHook = () => {};
  const pending = f.updateService.show(p.update_id, { projectId });
  assert.equal(pending.pending.kind, 'undo'); assert.equal(fs.readFileSync(f.markdownPath, 'utf8'), f.originalBytes.toString('utf8'));
  const options = { projectId, expectedRevision: pending.revision, expectedCurrentSha256: pending.current.sha256, requestKey: 'r', caller };
  const recovered = f.updateService.recover(p.update_id, options);
  assert.equal(recovered.status, 'undone');
  assert.equal(f.updateService.recover(p.update_id, options).revision, recovered.revision);
  assert.equal(f.resourceControl.describe(f.resourceId).actions.filter(a => a.action_type === 'document_update_undo').length, 1);
});

