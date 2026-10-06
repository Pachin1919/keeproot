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

const caller = (id) => ({ actor: 'user', tool: 'atlas-html-ui', client_run_id: id });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, name) {
  const temp = fs.mkdtempSync(path.resolve('test/.tmp', `round-ui-protect-${name}-`));
  const workspace = path.join(temp, 'workspace'); const root = path.join(workspace, 'Project');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'Data', 'input.csv'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'name,value\nA,1\n');
  const stateDir = path.join(temp, 'state'); const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Project', currentPath: 'Project' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Project', reason: 'UI protection fixture.' });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const resource = resourceControl.identify({ filePath: file, project: { id: project.project_id } });
  const work = registry.ledger.workSessions.create({ projectId: project.project_id, resourceIds: [resource.resource_id], intent: 'Review the source',
    returnState: {}, caller: { actor: 'user', tool: 'test', client_run_id: name }, at: new Date().toISOString() });
  const recovery = new RoundRecovery({ stateDir, registry }); let server;
  t.after(async () => { if (server) await server.close(); recovery.dispose(); resourceControl.dispose(); registry.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { temp, workspace, root, file, stateDir, registry, project, resource, resourceControl, work, recovery, start: async () => {
    server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {} }); return server;
  } };
}

test('Project Rounds protects an open Work through a bound preview and idempotent UI confirmation', async (t) => {
  const f = fixture(t, 'chain'); const journal = path.join(f.stateDir, 'ui/saved-work.json');
  const roundsBefore = f.recovery.list({ projectId: f.project.project_id });
  const journalBefore = fs.existsSync(journal) ? fs.readFileSync(journal) : null;
  const blobDir = path.join(f.stateDir, 'blobs/sha256');
  const blobsBefore = fs.existsSync(blobDir) ? fs.readdirSync(blobDir) : [];
  const server = await f.start(); const route = `${server.workspace_url}projects/${f.project.project_id}/rounds`;
  const get = await fetch(route); assert.equal(get.status, 200); const html = await get.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)?.[1]; assert.ok(csrf);
  assert.match(html, new RegExp(f.work.session_id, 'u'));
  const post = (body) => fetch(route, { method: 'POST', body: new URLSearchParams({ csrf, ...body }), redirect: 'manual' });
  const previewResponse = await post({ action: 'preview_protect', work_id: f.work.session_id, label: 'Before trial' });
  assert.equal(previewResponse.status, 200); const previewHtml = await previewResponse.text();
  assert.match(previewHtml, /Data\/input\.csv/u); assert.match(previewHtml, new RegExp(sha256(fs.readFileSync(f.file)), 'u'));
  assert.match(previewHtml, new RegExp(String(f.work.revision), 'u'));
  assert.deepEqual(f.recovery.list({ projectId: f.project.project_id }), roundsBefore);
  assert.deepEqual(fs.existsSync(blobDir) ? fs.readdirSync(blobDir) : [], blobsBefore);
  assert.deepEqual(fs.existsSync(journal) ? fs.readFileSync(journal) : null, journalBefore);
  const token = previewHtml.match(/name="protection_token" value="([^"]+)"/u)?.[1]; assert.ok(token);
  const confirmed = await post({ action: 'protect', protection_token: token, work_id: 'TAMPERED', label: 'Tampered', paths: 'elsewhere.txt' });
  const roundId = confirmed.headers.get('location')?.match(/\/rounds\/([^/?]+)$/u)?.[1];
  assert.ok(roundId);
  assert.equal(confirmed.status, 303); assert.match(confirmed.headers.get('location'), new RegExp(`/rounds/${roundId}$`, 'u'));
  const round = f.recovery.show({ projectId: f.project.project_id, roundId });
  assert.deepEqual(round.paths, ['Data/input.csv']); assert.deepEqual(round.work_ids, [f.work.session_id]);
  assert.deepEqual(round.resource_ids, [f.resource.resource_id]); assert.deepEqual(round.save_ids, []); assert.deepEqual(round.save_targets, []);
  assert.equal(round.nodes[0].files[0].sha256, sha256(fs.readFileSync(f.file)));
  const replay = await post({ action: 'protect', protection_token: token }); assert.equal(replay.status, 303);
  assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 1);
});

test('Project Rounds rejects a preview after Work revision or source bytes change without creating a Round', async (t) => {
  const f = fixture(t, 'stale'); const server = await f.start();
  const route = `${server.workspace_url}projects/${f.project.project_id}/rounds`;
  const html = await (await fetch(route)).text(); const csrf = html.match(/name="csrf" value="([^"]+)"/u)[1];
  const post = (body) => fetch(route, { method: 'POST', body: new URLSearchParams({ csrf, ...body }), redirect: 'manual' });
  const preview = await post({ action: 'preview_protect', work_id: f.work.session_id, label: 'Before trial' });
  assert.equal(preview.status, 200); const previewHtml = await preview.text();
  const token = previewHtml.match(/name="protection_token" value="([^"]+)"/u)[1];
  fs.writeFileSync(f.file, 'name,value\nA,changed\n');
  const rejected = await post({ action: 'protect', protection_token: token });
  assert.equal(rejected.status, 409); assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'name,value\nA,changed\n');
});

test('reviewed protection refuses a later Work revision and a moved Project root', (t) => {
  const f = fixture(t, 'work-root');
  const protect = (preview, requestKey) => f.recovery.protect({
    projectId: f.project.project_id, ...preview.scope, label: preview.label,
    protectionBasis: preview.protection_basis, requestKey, caller: caller(requestKey),
  });
  const beforeWork = f.recovery.previewProtect({ projectId: f.project.project_id, workId: f.work.session_id, label: 'Before edit' });
  f.registry.ledger.workSessions.setMapping(f.work.session_id, [], new Date().toISOString(), f.work.revision);
  assert.throws(() => protect(beforeWork, 'work-changed'), /preview changed|changed/i);
  assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);

  const beforeRoot = f.recovery.previewProtect({ projectId: f.project.project_id, workId: f.work.session_id, label: 'Before move' });
  const movedRoot = path.join(f.workspace, 'Project-moved');
  fs.renameSync(f.root, movedRoot);
  assert.throws(() => protect(beforeRoot, 'root-moved'));
  fs.renameSync(movedRoot, f.root);
  assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'name,value\nA,1\n');
});

test('reviewed protection refuses a Save dependency added after preview', (t) => {
  const f = fixture(t, 'later-save');
  const preview = f.recovery.previewProtect({ projectId: f.project.project_id, workId: f.work.session_id, label: 'Before Save' });
  const candidate = path.join(f.temp, 'candidate.csv');
  fs.writeFileSync(candidate, 'name,value\nSaved,3\n');
  const save = new SaveService({ stateDir: f.stateDir, resourceControl: f.resourceControl });
  try {
    const prepared = save.prepare({
      root: f.workspace, candidateFile: candidate, projectId: f.project.project_id, target: 'Project/Data/derived.csv',
      inputs: [f.file], origin: 'agent_generated', kind: 'intermediate', channel: 'host', requestKey: 'later-save',
      caller: caller('later-save'), source: { path: f.file, resource_id: f.resource.resource_id,
        sources: [{ path: f.file, resource_id: f.resource.resource_id }] },
      parameters: { test: 'round-ui-protect-later-save' }, resultSummary: { rows: 1, columns: 2 },
      intent: 'Add a Save dependency after the protection preview.',
    });
    save.execute(prepared.save_id, { reason: 'Review Save dependency after preview.' });
    assert.throws(() => f.recovery.protect({ projectId: f.project.project_id, ...preview.scope, label: preview.label,
      protectionBasis: preview.protection_basis, requestKey: 'protect-after-save', caller: caller('protect-after-save') }), /Save|preview changed/i);
    assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
    assert.equal(sha256(fs.readFileSync(f.file)), preview.files[0].sha256);
  } finally { save.dispose(); }
});
