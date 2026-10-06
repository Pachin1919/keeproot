import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Intake } from '../src/intake.js';
import { Registry } from '../src/registry.js';
import { RoundRecovery } from '../src/round-recovery.js';
import { createResourceControl } from '../src/resource-control.js';
import { startAtlasUiServer } from '../src/ui-server.js';

function uiFixture(t) {
  const temp = fs.mkdtempSync(path.resolve('test/.tmp/round-module-ui-slot-'));
  const stateDir = path.join(temp, 'state'); const workspace = path.join(temp, 'workspace');
  const projectRoot = path.join(workspace, 'Project'); const results = path.join(projectRoot, 'Results');
  fs.mkdirSync(results, { recursive: true });
  const sourcePath = path.join(projectRoot, 'note.txt'); fs.writeFileSync(sourcePath, 'hello Atlas', 'utf8');
  const registry = new Registry({ stateDir });
  const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'Project', currentPath: 'Project' });
  registry.attachRoot(project.project_id, { rootId: root.root_id, relativePath: 'Project', reason: 'Module Round UI fixture' });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  const resource = resourceControl.identify({ filePath: sourcePath, project: { id: project.project_id, name: 'Project' } });
  const intake = new Intake({ stateDir }); let server;
  const recovery = new RoundRecovery({ stateDir, registry });
  t.after(async () => { if (server) await server.close(); recovery.dispose(); intake.dispose(); resourceControl.dispose(); registry.dispose(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { temp, stateDir, workspace, projectRoot, results, sourcePath, registry, project, resource, resourceControl, recovery, start: async () => {
    server = await startAtlasUiServer({ stateDir, registry, intake, rules: {}, runtime: {}, projectRoot: temp, installationRoot: temp, resourceControl }); return server;
  } };
}

async function installEnabledModule(f, server) {
  const modules = new URL('/modules', server.workspace_url);
  const page = await (await fetch(modules)).text(); const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const post = (route, values) => fetch(new URL(route, server.workspace_url), { method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf, ...values }) });
  const packagePath = path.resolve('fixtures/local-module/uppercase-prefix.json');
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const packageSha = crypto.createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex');
  let response = await post('/modules/package-preview', { file_path: packagePath }); assert.equal(response.status, 200);
  let html = await response.text(); const packageToken = html.match(/name="preview_token" value="([^"]+)"/u)?.[1]; assert.ok(packageToken);
  response = await post('/modules/package-install', { preview_token: packageToken, expected_sha256: packageSha, expected_revision: '0', request_key: 'module-install' });
  assert.equal(response.status, 303);
  html = await (await fetch(modules)).text();
  const localRowStart = html.indexOf(`data-module-id="${manifest.module_id}"`); assert.notEqual(localRowStart, -1);
  const localRowEnd = html.indexOf('</article>', localRowStart); assert.notEqual(localRowEnd, -1);
  const localRow = html.slice(localRowStart, localRowEnd);
  const revision = localRow.match(/name="expected_revision" value="(\d+)"/u)?.[1]; assert.ok(revision);
  response = await post('/modules/local-change', { module_id: manifest.module_id, action: 'enable', expected_revision: revision, request_key: 'module-enable' });
  assert.equal(response.status, 303);
  return { csrf, post, moduleId: manifest.module_id };
}

test('Round preview can protect one active TXT Resource and one absent txt output without a Work', (t) => {
  const temp = fs.mkdtempSync(path.resolve('test/.tmp/round-module-slot-'));
  const workspace = path.join(temp, 'workspace'); const projectRoot = path.join(workspace, 'Project');
  fs.mkdirSync(path.join(projectRoot, 'Results'), { recursive: true });
  const sourcePath = path.join(projectRoot, 'note.txt'); fs.writeFileSync(sourcePath, 'source text', 'utf8');
  const stateDir = path.join(temp, 'state'); const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'Project', currentPath: 'Project' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Project', reason: 'Module slot test' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  const resource = control.identify({ filePath: sourcePath, project: { id: project.project_id, name: 'Project' } });
  const recovery = new RoundRecovery({ stateDir, registry });
  t.after(() => { recovery.dispose(); control.dispose(); registry.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const preview = recovery.previewProtect({ projectId: project.project_id, resourceId: resource.resource_id,
    saveTarget: 'Results/output.txt', label: 'Before Module Save' });
  assert.deepEqual(preview.scope.workIds, []);
  assert.deepEqual(preview.scope.resourceIds, [resource.resource_id]);
  assert.deepEqual(preview.scope.saveTargets, ['Results/output.txt']);
  assert.equal(preview.files.find((file) => file.path === 'Results/output.txt').sha256, null);
  fs.writeFileSync(sourcePath, 'changed after registration', 'utf8');
  assert.throws(() => recovery.previewProtect({ projectId: project.project_id, resourceId: resource.resource_id,
    saveTarget: 'Results/output.txt', label: 'Stale registered source' }), /Resource content changed since registration/u);
});

test('Modules preview protects the source and absent output, then Save and Round return keep identity and bytes', async (t) => {
  const f = uiFixture(t); const server = await f.start(); const ui = await installEnabledModule(f, server);
  let response = await ui.post('/modules/local-preview', { module_id: ui.moduleId, project_id: f.project.project_id,
    resource_id: f.resource.resource_id, target: 'Project/Results/module.txt' });
  assert.equal(response.status, 200); let html = await response.text();
  assert.match(html, /REVIEWED: HELLO ATLAS/u);
  const runToken = html.match(/name="module_run_token" value="([^"]+)"/u)?.[1]; assert.ok(runToken);
  response = await ui.post('/modules/local-protect-preview', { module_run_token: runToken, label: 'Before transform Save' });
  assert.equal(response.status, 200); html = await response.text();
  assert.match(html, /note\.txt/u); assert.match(html, new RegExp(f.resource.evidence.sha256, 'u'));
  assert.match(html, /Results\/module\.txt/u);
  assert.match(html, /The local Module package, code, and configuration are not part of this Round\.|本地模组包、代码和配置不属于此回合保护范围。/u);
  const protectionToken = html.match(/name="protection_token" value="([^"]+)"/u)?.[1]; assert.ok(protectionToken);
  const protectionSection = html.match(/<section class="surface" data-local-round-protection-preview>[\s\S]*?<\/section>/u)?.[0]; assert.ok(protectionSection);
  assert.doesNotMatch(protectionSection, /name="resource_id"/u);
  response = await ui.post('/modules/local-protect', { protection_token: protectionToken, project_id: 'TAMPERED' });
  assert.equal(response.status, 303); const roundHref = response.headers.get('location');
  const roundId = roundHref.split('/').at(-1); assert.match(roundHref, new RegExp(`/projects/${f.project.project_id}/rounds/`, 'u'));
  let round = f.recovery.show({ projectId: f.project.project_id, roundId });
  assert.deepEqual(round.work_ids, []); assert.deepEqual(round.resource_ids, [f.resource.resource_id]);
  assert.deepEqual(round.save_targets, ['Results/module.txt']);
  assert.equal(round.current_files.find((file) => file.path === 'Results/module.txt').sha256, null);
  html = await (await fetch(new URL(roundHref, server.workspace_url))).text();
  assert.match(html, /Module code and configuration are not protected/u);
  const continueHref = html.match(/href="(\/modules\?continue_module_preview=[^"]+)"/u)?.[1]; assert.ok(continueHref);
  html = await (await fetch(new URL(continueHref, server.workspace_url))).text();
  assert.match(html, /REVIEWED: HELLO ATLAS/u);
  const runPreviewHtml = html.slice(html.indexOf('data-local-transform-preview'));
  const saveFields = {
    module_id: ui.moduleId, project_id: f.project.project_id,
    resource_id: f.resource.resource_id, target: 'Project/Results/module.txt',
    request_key: runPreviewHtml.match(/name="request_key" value="([^"]+)"/u)[1],
  };
  response = await ui.post('/modules/local-save', saveFields); assert.equal(response.status, 303);
  const saveHref = response.headers.get('location'); const saveId = saveHref.split('/').at(-1);
  html = await (await fetch(new URL(saveHref, server.workspace_url))).text();
  assert.match(html, new RegExp(`href="${roundHref}"`, 'u'));
  const previewRevision = html.match(/name="preview_revision" value="([^"]+)"/u)?.[1]; assert.ok(previewRevision);
  response = await fetch(new URL(`${saveHref}/execute`, server.workspace_url), { method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf: ui.csrf, preview_revision: previewRevision }) });
  assert.equal(response.status, 303);
  html = await (await fetch(new URL(saveHref, server.workspace_url))).text();
  assert.match(html, new RegExp(`href="${roundHref}"`, 'u'));
  const outputPath = path.join(f.projectRoot, 'Results', 'module.txt');
  const outputHash = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex');
  const journalPath = path.join(f.stateDir, 'ui/saved-work.json'); const journal = fs.readFileSync(journalPath);
  const outputResourceId = f.registry.ledger.db.prepare('SELECT resource_id FROM resource_save_links WHERE save_id=?').get(saveId).resource_id;
  assert.equal(f.registry.ledger.resources.byId(outputResourceId).status, 'active'); assert.equal(f.registry.ledger.resources.byId(f.resource.resource_id).status, 'active');
  round = f.recovery.show({ projectId: f.project.project_id, roundId });
  assert.deepEqual(round.save_ids, [saveId]);
  assert.equal(round.current_files.find((file) => file.path === 'Results/module.txt').sha256, outputHash);
  const roundUrl = new URL(roundHref, server.workspace_url);
  const postRound = (values) => fetch(roundUrl, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf: ui.csrf, ...values }) });
  response = await postRound({ action: 'preview_restore', base_revision: String(round.revision), expected_digest: round.current_digest, node_id: round.nodes[0].node_id });
  assert.equal(response.status, 200); html = await response.text();
  const restoreToken = html.match(/name="preview_token" value="([^"]+)"/u)?.[1]; assert.ok(restoreToken);
  response = await postRound({ action: 'restore', preview_token: restoreToken }); assert.equal(response.status, 303);
  assert.equal(fs.existsSync(outputPath), false); assert.equal(f.registry.ledger.resources.byId(outputResourceId).status, 'missing');
  assert.equal(f.registry.ledger.resources.byId(f.resource.resource_id).status, 'active');
  round = f.recovery.show({ projectId: f.project.project_id, roundId });
  response = await postRound({ action: 'preview_return', base_revision: String(round.revision), expected_digest: round.current_digest, restore_id: round.restores.at(-1).restore_id });
  assert.equal(response.status, 200); html = await response.text();
  const returnToken = html.match(/name="preview_token" value="([^"]+)"/u)?.[1]; assert.ok(returnToken);
  response = await postRound({ action: 'return', preview_token: returnToken }); assert.equal(response.status, 303);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex'), outputHash);
  assert.equal(f.registry.ledger.resources.byId(outputResourceId).status, 'active');
  assert.deepEqual(fs.readFileSync(journalPath), journal);
  assert.equal(f.recovery.show({ projectId: f.project.project_id, roundId }).save_ids[0], saveId);
  fs.writeFileSync(f.sourcePath, 'later source edit', 'utf8');
  round = f.recovery.show({ projectId: f.project.project_id, roundId });
  const caller = { actor: 'agent', tool: 'test', client_run_id: 'module-interrupted-return' };
  const rename = fs.renameSync;
  const injected = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).includes('.atlas-restore-') && to === f.sourcePath) throw new Error('Injected Module source restore failure');
    return rename(from, to);
  });
  assert.throws(() => f.recovery.restore({ projectId: f.project.project_id, roundId, baseRevision: round.revision,
    expectedDigest: round.current_digest, nodeId: round.nodes[0].node_id, requestKey: 'module-interrupted', caller }), /Injected Module source restore failure/u);
  injected.mock.restore();
  round = f.recovery.show({ projectId: f.project.project_id, roundId });
  assert.ok(round.pending_restore); assert.equal(fs.existsSync(outputPath), false);
  const reopened = new RoundRecovery({ stateDir: f.stateDir });
  try { reopened.resume({ projectId: f.project.project_id, roundId, restoreId: round.pending_restore, caller }); }
  finally { reopened.dispose(); }
  round = f.recovery.show({ projectId: f.project.project_id, roundId });
  assert.equal(round.pending_restore, null);
  f.recovery.returnToLatest({ projectId: f.project.project_id, roundId, baseRevision: round.revision,
    expectedDigest: round.current_digest, restoreId: round.restores.at(-1).restore_id, requestKey: 'module-return-interrupted', caller });
  assert.equal(fs.readFileSync(f.sourcePath, 'utf8'), 'later source edit');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex'), outputHash);
  assert.equal(f.registry.ledger.resources.byId(outputResourceId).status, 'active');
  assert.deepEqual(fs.readFileSync(journalPath), journal);
  response = await ui.post('/modules/local-protect', { protection_token: protectionToken }); assert.equal(response.status, 303);
  assert.equal(response.headers.get('location').split('/').at(-1), roundId);
});

test('Module protection preview rejects a changed Resource, occupied target and replaced parent', async (t) => {
  const f = uiFixture(t); const server = await f.start(); const ui = await installEnabledModule(f, server);
  const previewModule = async () => {
    const response = await ui.post('/modules/local-preview', { module_id: ui.moduleId, project_id: f.project.project_id,
      resource_id: f.resource.resource_id, target: 'Project/Results/module.txt' });
    assert.equal(response.status, 200); const html = await response.text();
    return html.match(/name="module_run_token" value="([^"]+)"/u)[1];
  };
  let runToken = await previewModule();
  fs.writeFileSync(f.sourcePath, 'changed source');
  let response = await ui.post('/modules/local-protect-preview', { module_run_token: runToken, label: 'Stale source' });
  assert.equal(response.status, 409); assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
  fs.writeFileSync(f.sourcePath, 'hello Atlas');
  runToken = await previewModule(); fs.writeFileSync(path.join(f.results, 'module.txt'), 'occupied');
  response = await ui.post('/modules/local-protect-preview', { module_run_token: runToken, label: 'Occupied output' });
  assert.equal(response.status, 409); assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
  fs.rmSync(path.join(f.results, 'module.txt'));
  runToken = await previewModule();
  response = await ui.post('/modules/local-protect-preview', { module_run_token: runToken, label: 'Moved folder' });
  assert.equal(response.status, 200); let html = await response.text();
  const token = html.match(/name="protection_token" value="([^"]+)"/u)[1];
  fs.renameSync(f.results, `${f.results}-old`); fs.mkdirSync(f.results);
  response = await ui.post('/modules/local-protect', { protection_token: token });
  assert.equal(response.status, 409); assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
});

test('Module protection token is Project-bound and rejects escaped or linked targets', async (t) => {
  const f = uiFixture(t); const server = await f.start(); const ui = await installEnabledModule(f, server);
  let otherRoot = path.join(f.workspace, 'Other'); fs.mkdirSync(otherRoot);
  const rootRecord = f.registry.show(f.project.project_id).location;
  const other = f.registry.create({ name: 'Other', currentPath: 'Other' });
  f.registry.attachRoot(other.project_id, { rootId: rootRecord.root_id, relativePath: 'Other', reason: 'Module token boundary' });
  let response = await ui.post('/modules/local-preview', { module_id: ui.moduleId, project_id: f.project.project_id,
    resource_id: f.resource.resource_id, target: '../outside.txt' });
  assert.equal(response.status, 409); assert.equal(fs.existsSync(path.join(f.temp, 'outside.txt')), false);
  const linkedPath = path.join(f.projectRoot, 'Results', 'linked');
  try { fs.symlinkSync(otherRoot, linkedPath, 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error.code)) { t.diagnostic(`linked target case skipped: ${error.code}`); }
    else throw error;
  }
  if (fs.existsSync(linkedPath)) {
    response = await ui.post('/modules/local-preview', { module_id: ui.moduleId, project_id: f.project.project_id,
      resource_id: f.resource.resource_id, target: 'Project/Results/linked/output.txt' });
    assert.equal(response.status, 200);
    const runToken = (await response.text()).match(/name="module_run_token" value="([^"]+)"/u)[1];
    response = await ui.post('/modules/local-protect-preview', { module_run_token: runToken, label: 'Linked target' });
    assert.equal(response.status, 409);
  }
  response = await ui.post('/modules/local-preview', { module_id: ui.moduleId, project_id: f.project.project_id,
    resource_id: f.resource.resource_id, target: 'Project/Results/ok.txt' });
  assert.equal(response.status, 200); let html = await response.text();
  const runToken = html.match(/name="module_run_token" value="([^"]+)"/u)[1];
  response = await ui.post('/modules/local-protect-preview', { module_run_token: runToken, label: 'Bound token' });
  assert.equal(response.status, 200); html = await response.text();
  const protectionToken = html.match(/name="protection_token" value="([^"]+)"/u)[1];
  const otherRoute = new URL(`/projects/${other.project_id}/rounds`, server.workspace_url);
  response = await fetch(otherRoute, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf: ui.csrf, action: 'protect', protection_token: protectionToken }) });
  assert.equal(response.status, 409);
  assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
  assert.equal(f.recovery.list({ projectId: other.project_id }).length, 0);
});
