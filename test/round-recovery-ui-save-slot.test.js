import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { RoundRecovery } from '../src/round-recovery.js';
import { createResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';

function fixture(t) {
  const temp = fs.mkdtempSync(path.resolve('test/.tmp/round-ui-slot-'));
  const workspace = path.join(temp, 'workspace'); const root = path.join(workspace, 'Project');
  fs.mkdirSync(path.join(root, 'Data'), { recursive: true }); fs.mkdirSync(path.join(root, 'Results'));
  const sourcePath = path.join(root, 'Data', 'input.csv'); fs.writeFileSync(sourcePath, 'name,value\nA,1\n');
  const stateDir = path.join(temp, 'state'); const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Project', currentPath: 'Project' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Project', reason: 'UI save slot fixture' });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const resource = resourceControl.identify({ filePath: sourcePath, project: { id: project.project_id } });
  const work = registry.ledger.workSessions.create({ projectId: project.project_id, resourceIds: [resource.resource_id], intent: 'Prepare result',
    returnState: {}, caller: { actor: 'user', tool: 'test', client_run_id: 'slot' }, at: new Date().toISOString() });
  const recovery = new RoundRecovery({ stateDir, registry }); let server;
  t.after(async () => { if (server) await server.close(); recovery.dispose(); resourceControl.dispose(); registry.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { temp, workspace, root, sourcePath, resource, stateDir, registry, project, work, recovery, resourceControl, start: async (now = Date.now) => {
    server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, now }); return server;
  } };
}

test('UI binds an absent Save output slot through preview, protection, Save and recovery', async (t) => {
  const f = fixture(t); const server = await f.start();
  const route = `${server.workspace_url}projects/${f.project.project_id}/rounds`;
  const page = await (await fetch(route)).text(); const csrf = page.match(/name="csrf" value="([^"]+)"/u)[1];
  const post = (values) => fetch(route, { method: 'POST', body: new URLSearchParams({ csrf, ...values }), redirect: 'manual' });
  const previewResponse = await post({ action: 'preview_protect', work_id: f.work.session_id, label: 'Before save', folder: 'Results', file_name: 'final.csv', format: 'csv' });
  assert.equal(previewResponse.status, 200); const preview = await previewResponse.text();
  assert.match(preview, /Results\/final\.csv/u); assert.match(preview, /does not exist|not exist|尚不存在/u);
  assert.doesNotMatch(preview, /name="[^"]*scope/u);
  assert.match(preview, /SHA-256/u);
  const token = preview.match(/name="protection_token" value="([^"]+)"/u)?.[1]; assert.ok(token);
  const confirmed = await post({ action: 'protect', protection_token: token, save_target: 'Tampered/other.csv', paths: 'tampered.csv' });
  assert.equal(confirmed.status, 303);
  const roundId = confirmed.headers.get('location').split('/').at(-1);
  const before = f.recovery.show({ projectId: f.project.project_id, roundId });
  assert.deepEqual(before.paths, ['Data/input.csv', 'Results/final.csv']);
  assert.deepEqual(before.save_targets, ['Results/final.csv']);
  assert.equal(before.current_files.find((item) => item.path === 'Results/final.csv').sha256, null);
  const candidate = path.join(f.temp, 'candidate.csv'); fs.writeFileSync(candidate, 'name,value\nA,2\n');
  const save = new SaveService({ stateDir: f.stateDir, resourceControl: f.resourceControl });
  try {
    const prepared = save.prepare({ root: f.workspace, projectId: f.project.project_id, target: 'Project/Results/final.csv', candidateFile: candidate,
      origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'ui-slot-save', caller: { actor: 'user', tool: 'test', client_run_id: 'slot-save' },
      inputs: [f.sourcePath], source: { path: f.sourcePath, resource_id: f.resource.resource_id }, parameters: { work_session_id: f.work.session_id } });
    const waitingPage = await (await fetch(`${server.workspace_url}projects/${f.project.project_id}/rounds/${roundId}`)).text();
    assert.match(waitingPage, new RegExp(`/work/${f.work.session_id}/save`, 'u'));
    assert.match(waitingPage, /Save.+not complete|Save 尚未完成/u);
    const saved = save.execute(prepared.save_id, { reason: 'Use the reviewed Round output slot.' });
    assert.equal(saved.verified, true);
    f.registry.ledger.workSessions.setLatestSave(f.work.session_id, saved.save_id, new Date().toISOString());
    assert.equal(f.registry.ledger.resources.byId(f.resource.resource_id).status, 'active');
    assert.equal(f.registry.ledger.resources.byId(saved.resource_id).status, 'active');
    const journalPath = path.join(f.stateDir, 'ui/saved-work.json'); const journal = fs.readFileSync(journalPath);
    const basis = f.recovery.show({ projectId: f.project.project_id, roundId });
    assert.deepEqual(basis.save_ids, [saved.save_id]);
    const outputHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root, 'Results/final.csv'))).digest('hex');
    assert.equal(basis.current_files.find((item) => item.path === 'Results/final.csv').sha256, outputHash);
    const restored = f.recovery.restore({ projectId: f.project.project_id, roundId, baseRevision: basis.revision, expectedDigest: basis.current_digest,
      nodeId: before.head_node_id, requestKey: 'rewind-ui-slot', caller: { actor: 'user', tool: 'test', client_run_id: 'rewind' } });
    assert.equal(fs.existsSync(path.join(f.root, 'Results/final.csv')), false);
    assert.equal(f.registry.ledger.resources.byId(f.resource.resource_id).status, 'active');
    assert.equal(f.registry.ledger.resources.byId(saved.resource_id).status, 'missing');
    assert.equal(f.registry.ledger.workSessions.byId(f.work.session_id).latest_save_id, null);
    assert.equal(save.show(saved.save_id).verified, false);
    assert.throws(() => save.undo(saved.save_id), /not available/u);
    const afterRestore = f.recovery.show({ projectId: f.project.project_id, roundId });
    const returned = f.recovery.returnToLatest({ projectId: f.project.project_id, roundId, baseRevision: afterRestore.revision,
      expectedDigest: afterRestore.current_digest, restoreId: restored.restore_id, requestKey: 'return-ui-slot',
      caller: { actor: 'user', tool: 'test', client_run_id: 'return' } });
    assert.equal(returned.round_id, roundId);
    const returnedHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root, 'Results/final.csv'))).digest('hex');
    assert.equal(returnedHash, outputHash);
    assert.equal(f.registry.ledger.resources.byId(saved.resource_id).status, 'active');
    assert.equal(f.registry.ledger.workSessions.byId(f.work.session_id).latest_save_id, saved.save_id);
    assert.equal(save.show(saved.save_id).verified, true);
    assert.deepEqual(fs.readFileSync(journalPath), journal);
  } finally { save.dispose(); }
});

test('UI rejects a replaced parent folder after preview without writing Round or blob', async (t) => {
  const f = fixture(t); const server = await f.start(); const route = `${server.workspace_url}projects/${f.project.project_id}/rounds`;
  const page = await (await fetch(route)).text(); const csrf = page.match(/name="csrf" value="([^"]+)"/u)[1];
  const post = (values) => fetch(route, { method: 'POST', body: new URLSearchParams({ csrf, ...values }), redirect: 'manual' });
  const previewResponse = await post({ action: 'preview_protect', work_id: f.work.session_id, label: 'Before save', folder: 'Results', file_name: 'final.csv', format: 'csv' });
  const preview = await previewResponse.text(); const token = preview.match(/name="protection_token" value="([^"]+)"/u)[1];
  fs.renameSync(path.join(f.root, 'Results'), path.join(f.root, 'Results-old')); fs.mkdirSync(path.join(f.root, 'Results'));
  const rejected = await post({ action: 'protect', protection_token: token });
  assert.equal(rejected.status, 409); assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
  assert.deepEqual(fs.existsSync(path.join(f.stateDir, 'blobs/sha256')) ? fs.readdirSync(path.join(f.stateDir, 'blobs/sha256')) : [], []);
});

test('UI rejects an existing output and incomplete or forged slot selections', async (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'Results', 'exists.csv'), 'keep');
  const server = await f.start(); const route = `${server.workspace_url}projects/${f.project.project_id}/rounds`;
  const page = await (await fetch(route)).text(); const csrf = page.match(/name="csrf" value="([^"]+)"/u)[1];
  const post = (values) => fetch(route, { method: 'POST', body: new URLSearchParams({ csrf, ...values }), redirect: 'manual' });
  for (const values of [
    { action: 'preview_protect', work_id: f.work.session_id, label: 'Existing', folder: 'Results', file_name: 'exists.csv', format: 'csv' },
    { action: 'preview_protect', work_id: f.work.session_id, label: 'Missing folder', folder: 'Nope', file_name: 'new.csv', format: 'csv' },
    { action: 'preview_protect', work_id: f.work.session_id, label: 'Mismatch', folder: 'Results', file_name: 'new.xlsx', format: 'csv' },
  ]) assert.equal((await post(values)).status, 409);
  assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
});

test('one-source Table Work may predeclare an XLSX Save output', async (t) => {
  const f = fixture(t); const server = await f.start();
  const route = `${server.workspace_url}projects/${f.project.project_id}/rounds`;
  const page = await (await fetch(route)).text();
  const csrf = page.match(/name="csrf" value="([^"]+)"/u)[1];
  const response = await fetch(route, { method: 'POST', body: new URLSearchParams({
    csrf, action: 'preview_protect', work_id: f.work.session_id, label: 'Before XLSX Save',
    folder: 'Results', file_name: 'final.xlsx', format: 'xlsx',
  }), redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Results\/final\.xlsx/u);
});

test('UI protection tokens reject cross-Project use and expire after ten minutes', async (t) => {
  const f = fixture(t); let clock = 10_000; const server = await f.start(() => clock);
  const otherRoot = path.join(f.workspace, 'Other'); fs.mkdirSync(otherRoot);
  const rootRecord = f.registry.show(f.project.project_id).location;
  const other = f.registry.create({ name: 'Other', currentPath: 'Other' });
  f.registry.attachRoot(other.project_id, { rootId: rootRecord.root_id, relativePath: 'Other', reason: 'Cross-project token check' });
  const route = `${server.workspace_url}projects/${f.project.project_id}/rounds`;
  const otherRoute = `${server.workspace_url}projects/${other.project_id}/rounds`;
  const page = await (await fetch(route)).text(); const csrf = page.match(/name="csrf" value="([^"]+)"/u)[1];
  const post = (url, values) => fetch(url, { method: 'POST', body: new URLSearchParams({ csrf, ...values }), redirect: 'manual' });
  const preview = async () => {
    const response = await post(route, { action: 'preview_protect', work_id: f.work.session_id, label: 'Token check' });
    const html = await response.text(); return html.match(/name="protection_token" value="([^"]+)"/u)[1];
  };
  const crossProjectToken = await preview();
  assert.equal((await post(otherRoute, { action: 'protect', protection_token: crossProjectToken })).status, 409);
  assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
  const expiredToken = await preview(); clock += 10 * 60_000 + 1;
  assert.equal((await post(route, { action: 'protect', protection_token: expiredToken })).status, 409);
  assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
});

test('slot preview refuses nested Project and linked-parent paths when links are supported', (t) => {
  const f = fixture(t); const nestedPath = path.join(f.root, 'Results', 'Nested'); fs.mkdirSync(nestedPath);
  const rootRecord = f.registry.show(f.project.project_id).location;
  const nested = f.registry.create({ name: 'Nested', currentPath: 'Results/Nested' });
  f.registry.attachRoot(nested.project_id, { rootId: rootRecord.root_id, relativePath: 'Project/Results/Nested', reason: 'Nested Project boundary' });
  assert.throws(() => f.recovery.previewProtect({ projectId: f.project.project_id, workId: f.work.session_id,
    label: 'Nested target', saveTarget: 'Results/Nested/output.csv' }), /another registered Project|Project/u);
  const linked = path.join(f.root, 'Results', 'linked');
  try { fs.symlinkSync(f.temp, linked, 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error.code)) { t.diagnostic(`link case skipped: ${error.code}`); return; }
    throw error;
  }
  assert.throws(() => f.recovery.previewProtect({ projectId: f.project.project_id, workId: f.work.session_id,
    label: 'Linked target', saveTarget: 'Results/linked/output.csv' }), /link|junction|directory/u);
});
