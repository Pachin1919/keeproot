import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createDocumentUpdateService } from '../src/document-update-service.js';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const caller = { tool: 'manual-editor-test', client_run_id: 'manual-edit-chain' };

function fixture(t, original = Buffer.from('First\nSecond\n')) {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('test/.tmp/document-manual-'));
  const stateDir = path.join(root, 'state'), workspace = path.join(root, 'workspace'), projectRoot = path.join(workspace, 'A');
  fs.mkdirSync(projectRoot, { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'Manual fixture', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'manual fixture' });
  const control = new ResourceControl({ stateDir, registry }); const saves = createSaveService({ stateDir, resourceControl: control });
  const file = path.join(projectRoot, 'note.md'); fs.writeFileSync(file, original);
  const resourceId = control.identify({ filePath: file, project: registry.show(project.project_id).project }).resource_id;
  let stage = null;
  const service = createDocumentUpdateService({ stateDir, registry, resourceControl: control, saveService: saves, operationHook(name) { if (name === stage) throw Error(`intentional ${stage}`); } });
  t.after(() => { saves.dispose(); control.dispose(); registry.dispose(); });
  const args = { projectId: project.project_id, resourceId };
  const prepare = (body, key = 'preview') => { const inspected = service.inspectManual(args); return service.prepareManual({ ...args, expectedSha256: inspected.baseline.sha256, expectedFileId: inspected.identity.file_id, text: body, requestKey: key, caller }); };
  const confirm = shown => ({ projectId: args.projectId, expectedRevision: shown.revision, expectedCurrentSha256: shown.current.sha256, expectedProposedSha256: shown.proposed.sha256, requestKey: 'confirm', caller });
  return { root, stateDir, projectRoot, registry, control, service, saves, file, resourceId, original, args, prepare, confirm, stopAt(value) { stage = value; } };
}

test('manual edit inspect, no-write preview, explicit confirm/replay and exact-byte BOM/CRLF Undo', t => {
  const original = Buffer.from('\uFEFFFirst\r\nSecond\r\n'); const f = fixture(t, original);
  const inspect = f.service.inspectManual(f.args); assert.equal(inspect.baseline.text, 'First\r\nSecond\r\n');
  assert.equal(inspect.editing.max_utf8_bytes, 256 * 1024); assert.equal(inspect.editing.has_bom, true); assert.equal(inspect.editing.newline_policy, 'crlf');
  const request = { ...f.args, expectedSha256: inspect.baseline.sha256, expectedFileId: inspect.identity.file_id, text: 'Changed\nSecond\n', requestKey: 'preview', caller };
  assert.throws(()=>f.service.prepare({...request,source:{kind:'manual_edit',origin:'manual_editor'},patch:{kind:'link_repair',wikiBase:'registered_root',syntax:['relative_markdown']}}),/prepareManual/u);
  assert.throws(()=>f.service.prepare({...request,source:{kind:'manual_edit',origin:'manual_editor',save_id:'fabricated'},patch:{kind:'whole_text'}}),/prepareManual/u);
  assert.throws(()=>f.service.prepareManual({...request,source:{kind:'capture_source'}}),/source and patch/u);
  const preview = f.service.prepareManual(request); assert.deepEqual(fs.readFileSync(f.file), original); assert.equal(preview.source.kind, 'manual_edit'); assert.equal(preview.change.kind, 'whole_text');
  assert.throws(()=>f.service.confirmManual(preview.update_id,{...f.confirm(preview),source:{kind:'manual_edit',origin:'manual_editor',save_id:'fabricated'}}),/only displayed/u);
  const confirmation = f.confirm(preview); const applied = f.service.confirmManual(preview.update_id, confirmation);
  assert.equal(applied.status, 'applied'); assert.equal(applied.resource_id, f.resourceId); assert.deepEqual(fs.readFileSync(f.file), Buffer.from('\uFEFFChanged\r\nSecond\r\n'));
  assert.equal(f.service.prepareManual(request).update_id, preview.update_id); assert.equal(f.service.confirmManual(preview.update_id, confirmation).execution.operation_id, applied.execution.operation_id);
  assert.throws(() => f.service.prepareManual({ ...request, text: 'Different' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.service.confirmManual(preview.update_id, { ...confirmation, expectedProposedSha256: 'f'.repeat(64) }), { code: 'ATLAS_STATE_CONFLICT' });
  const undone = f.service.undo(preview.update_id, { projectId: f.args.projectId, expectedRevision: applied.revision, expectedCurrentSha256: applied.current.sha256, requestKey: 'undo', caller });
  assert.equal(undone.status, 'undone'); assert.deepEqual(fs.readFileSync(f.file), original);
});

test('manual no-op creates no action, empty text is supported, and whole-text excludes block and batch execution', t => {
  const f = fixture(t); const noChange = f.prepare(f.original.toString()); assert.equal(noChange.status, 'no_change');
  assert.equal(f.registry.ledger.db.prepare('SELECT count(*) n FROM resource_actions').get().n, 0);
  const empty = f.prepare('', 'empty');
  assert.throws(() => f.service.decide(empty.update_id, { projectId: f.args.projectId, expectedRevision: empty.revision, expectedCurrentSha256: empty.current.sha256, decision: 'revise', text: 'x', requestKey: 'block', caller }), /manual|whole|confirm/iu);
  assert.throws(() => f.service.execute(empty.update_id, { ...f.confirm(empty) }), /manual|confirm/iu);
  assert.throws(() => f.service.prepareBatch({ projectId: f.args.projectId, items: [{ updateId: empty.update_id, expectedRevision: empty.revision, expectedCurrentSha256: empty.current.sha256, expectedCandidateSha256: empty.proposed.sha256 }], requestKey: 'batch', caller }), /whole|manual|accepted/iu);
  const applied = f.service.confirmManual(empty.update_id, f.confirm(empty)); assert.equal(applied.status, 'applied'); assert.equal(fs.statSync(f.file).size, 0);
});

test('manual identity rejects same-byte replacement and stale text without overwriting', t => {
  const f = fixture(t); const inspected = f.service.inspectManual(f.args);
  const request = { ...f.args, expectedSha256: inspected.baseline.sha256, expectedFileId: inspected.identity.file_id, text: 'Draft', requestKey: 'p', caller };
  const preview = f.service.prepareManual(request);
  const replacement = f.file + '.new'; fs.writeFileSync(replacement, f.original); fs.renameSync(replacement, f.file);
  assert.throws(() => f.service.prepareManual({ ...request, requestKey: 'other' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.service.confirmManual(preview.update_id, f.confirm(preview)), { code: 'ATLAS_STATE_CONFLICT' }); assert.deepEqual(fs.readFileSync(f.file), f.original);
  const fresh = f.prepare('New', 'fresh'); fs.writeFileSync(f.file, 'External');
  assert.throws(() => f.service.confirmManual(fresh.update_id, f.confirm(fresh)), { code: 'ATLAS_STATE_CONFLICT' }); assert.equal(fs.readFileSync(f.file, 'utf8'), 'External');
});

test('manual refuses malformed UTF8, mixed newline, hardlinks, output bounds and projected journal overflow', t => {
  const mixed = fixture(t, Buffer.from('a\r\nb\n')); assert.throws(() => mixed.service.inspectManual(mixed.args), /mixed|newline/iu);
  const invalid = fixture(t, Buffer.from([255])); assert.throws(() => invalid.service.inspectManual(invalid.args), /UTF-8/u);
  const linked = fixture(t); fs.linkSync(linked.file, linked.file + '.alias'); assert.throws(() => linked.service.inspectManual(linked.args), /hard|link/iu);
  const f = fixture(t); assert.throws(() => f.prepare('a'.repeat(256 * 1024 + 1)), /limit|bytes/iu);
  const escaping = fixture(t, Buffer.from('\u0001'.repeat(160 * 1024))); const before = fs.readFileSync(escaping.file);
  assert.throws(() => escaping.prepare('\u0002'.repeat(160 * 1024)), /storage|serialized|limit/iu); assert.deepEqual(fs.readFileSync(escaping.file), before);
});

test('manual interruption recovery uses before/after bytes, never blindly retries, and protects later changes on Undo', t => {
  for (const stage of ['before-write', 'after-write', 'after-ledger']) {
    const f = fixture(t); const preview = f.prepare('Changed\n'); f.stopAt(stage);
    assert.throws(() => f.service.confirmManual(preview.update_id, f.confirm(preview)), new RegExp(stage)); f.stopAt(null);
    const pending = f.service.show(preview.update_id, { projectId: f.args.projectId }); assert.equal(pending.status, 'pending_recovery');
    assert.equal(f.service.confirmManual(preview.update_id, f.confirm(preview)).status, 'pending_recovery');
    assert.throws(() => f.service.inspectManual(f.args), /pending|recover/iu);
    const recovered = f.service.recover(preview.update_id, { projectId: f.args.projectId, expectedRevision: pending.revision, expectedCurrentSha256: pending.current.sha256, requestKey: 'recover', caller });
    assert.equal(recovered.recovery.outcome, stage === 'before-write' ? 'not_applied' : 'applied');
    if (stage === 'before-write') assert.deepEqual(fs.readFileSync(f.file), f.original);
    else { fs.writeFileSync(f.file, 'Later'); assert.throws(() => f.service.undo(preview.update_id, { projectId: f.args.projectId, expectedRevision: recovered.revision, expectedCurrentSha256: hash(Buffer.from('Later')), requestKey: 'undo', caller }), /later/iu); }
  }
});

test('manual rejects global multiple locations, linked parents and changed Project Root identity', t => {
  const f = fixture(t); const second = path.join(f.projectRoot,'copy.md'); fs.writeFileSync(second,f.original);
  f.registry.ledger.resources.ensureLocation({resourceId:f.resourceId,projectId:f.args.projectId,path:second,displayName:'copy.md',evidence:{sha256:hash(f.original),bytes:f.original.length,modified_at:new Date().toISOString()},at:new Date().toISOString()});
  assert.throws(()=>f.service.inspectManual(f.args),/one|exactly|location/iu);
  const linked=fixture(t); const real=path.join(linked.root,'outside');fs.mkdirSync(real);fs.writeFileSync(path.join(real,'linked.md'),'linked');
  const junction=path.join(linked.projectRoot,'junction');fs.symlinkSync(real,junction,process.platform==='win32'?'junction':'dir');
  const id=linked.control.identify({filePath:path.join(junction,'linked.md'),project:linked.registry.show(linked.args.projectId).project}).resource_id;
  assert.throws(()=>linked.service.inspectManual({...linked.args,resourceId:id}),/link|junction/iu);
  const moved=fixture(t);const preview=moved.prepare('draft'); const old=moved.projectRoot+'.old';fs.renameSync(moved.projectRoot,old);fs.mkdirSync(moved.projectRoot);fs.renameSync(path.join(old,'note.md'),moved.file);
  assert.throws(()=>moved.service.confirmManual(preview.update_id,moved.confirm(preview)),/identity|location/iu);assert.deepEqual(fs.readFileSync(moved.file),moved.original);
});

test('manual third-version recovery retains pending intent and no-op rejects missing caller identity', t => {
  const f=fixture(t);const inspect=f.service.inspectManual(f.args);
  assert.throws(()=>f.service.prepareManual({...f.args,expectedSha256:inspect.baseline.sha256,expectedFileId:inspect.identity.file_id,text:inspect.baseline.text,requestKey:'missing',caller:{tool:'test'}}),/caller/u);
  const preview=f.prepare('draft');f.stopAt('before-write');assert.throws(()=>f.service.confirmManual(preview.update_id,f.confirm(preview)),/before-write/u);f.stopAt(null);
  fs.writeFileSync(f.file,'Third');const pending=f.service.show(preview.update_id,{projectId:f.args.projectId});
  assert.throws(()=>f.service.recover(preview.update_id,{projectId:f.args.projectId,expectedRevision:pending.revision,expectedCurrentSha256:hash(Buffer.from('Third')),requestKey:'third-recover',caller}),/third document version/u);
  assert.equal(f.service.show(preview.update_id,{projectId:f.args.projectId}).status,'pending_recovery');assert.equal(fs.readFileSync(f.file,'utf8'),'Third');
  assert.equal(f.registry.ledger.db.prepare('SELECT count(*) n FROM resource_actions').get().n,0);
});
