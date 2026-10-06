import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { Intake } from '../src/intake.js';
import { createResourceControl } from '../src/resource-control.js';
import { createProjectMoveService } from '../src/project-move-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { renderProjectMoveView } from '../src/ui/views/project-move-view.js';

const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`, 'u'))?.[1];
const bindings = html => Object.fromEntries(['expected_revision', 'expected_digest', 'request_key'].map(name => [name, field(html, name)]));

test('Project move UI prepares without writes, confirms stable identity, refuses stale and changed undo, and returns to Project', async t => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/project-move-ui-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const source = path.join(workspace, '项目甲');
  fs.mkdirSync(path.join(source, '资料'), { recursive: true });
  fs.writeFileSync(path.join(source, '资料', '说明.md'), '# 保留内容\n');
  const original = fs.readFileSync(path.join(source, '资料', '说明.md'));
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const created = registry.create({ name: '名称 & 保持', currentPath: '项目甲' });
  const projectId = created.project_id;
  registry.attachRoot(projectId, { rootId: adopted.root_id, relativePath: '项目甲', reason: 'Project move UI fixture.' });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const resource = resourceControl.identify({ filePath: path.join(source, '资料', '说明.md'), project: registry.show(projectId).project });
  const intake = new Intake({ stateDir });
  const service = createProjectMoveService({ stateDir, registry, resourceControl });
  const server = await startAtlasUiServer({ stateDir, registry, intake, resourceControl, rules: {}, runtime: {}, projectRoot: root, installationRoot: root });
  t.after(async () => {
    await server.close(); service.dispose(); intake.dispose(); resourceControl.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const base = `/projects/${projectId}`;
  const get = async route => { const response = await fetch(new URL(route, server.workspace_url)); return { status: response.status, html: await response.text() }; };
  const form = await get(`${base}/move/new`);
  assert.equal(form.status, 200); assert.match(form.html, /名称 &amp; 保持/u);
  assert.ok(form.html.includes(workspace)); assert.match(form.html, /项目甲/u);
  const csrf = field(form.html, 'csrf'); assert.ok(csrf);
  const post = (route, values) => fetch(new URL(route, server.workspace_url), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...values }) });
  assert.equal((await post(`${base}/move/prepare`, { csrf: 'bad', target_relative_path: '目标' })).status, 403);
  const home = await get(base); assert.ok(home.html.includes(`${base}/move/new`)); assert.match(home.html, /project-rename-form/u);
  const invalid = await post(`${base}/move/prepare`, { target_relative_path: '../outside', request_key: 'ui-outside' });
  assert.equal(invalid.status, 400); assert.match(await invalid.text(), /value="\.\.\/outside"/u);
  const prepare = await post(`${base}/move/prepare`, { target_relative_path: '目标 & 新', request_key: 'ui-prepare' });
  assert.equal(prepare.status, 303, await prepare.clone().text());
  const location = prepare.headers.get('location');
  const repeatedPrepare = await post(`${base}/move/prepare`, { target_relative_path: '目标 & 新', request_key: 'ui-prepare' });
  assert.equal(repeatedPrepare.status, 303, await repeatedPrepare.clone().text());
  assert.equal(repeatedPrepare.headers.get('location'), location);
  const moveId = decodeURIComponent(location.split('/').pop());
  assert.equal(fs.existsSync(source), true); assert.equal(fs.existsSync(path.join(workspace, '目标 & 新')), false);
  const preview = await get(location); assert.equal(preview.status, 200);
  assert.ok(preview.html.includes(projectId)); assert.match(preview.html, /目标 &amp; 新/u);
  const prepared = service.show(moveId, { projectId }); assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.summary.files, 1); assert.equal(prepared.can_execute, true);
  const before = bindings(preview.html); assert.ok(before.expected_digest);
  const stale = await post(`${location}/execute`, { ...before, expected_revision: String(Number(before.expected_revision) + 1), request_key: 'ui-stale' });
  assert.equal(stale.status, 409); assert.equal(fs.existsSync(source), true);
  assert.ok((await stale.text()).includes(moveId));
  const applied = await post(`${location}/execute`, { ...before, request_key: 'ui-confirm' });
  assert.equal(applied.status, 303, await applied.clone().text());
  const repeatedApply = await post(`${location}/execute`, { ...before, request_key: 'ui-confirm' });
  assert.equal(repeatedApply.status, 303, await repeatedApply.clone().text());
  assert.equal(repeatedApply.headers.get('location'), location);
  const destination = path.join(workspace, '目标 & 新');
  assert.equal(fs.existsSync(source), false); assert.deepEqual(fs.readFileSync(path.join(destination, '资料', '说明.md')), original);
  const detail = registry.show(projectId); assert.equal(detail.project.id, projectId); assert.equal(detail.project.name, '名称 & 保持');
  assert.equal(detail.location.relative_path, '目标 & 新');
  const appliedPage = await get(location); assert.ok(appliedPage.html.includes(`${base}/resources`)); assert.ok(appliedPage.html.includes(`href="${base}"`));
  assert.equal((await get(base)).status, 200); assert.equal((await get(`${base}/resources?resource_id=${resource.resource_id}`)).status, 200);
  const host = spawnSync(process.execPath, ['bin/atlas.js', 'project', 'show', projectId, '--json'], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, ATLAS_STATE_DIR: stateDir } });
  assert.equal(host.status, 0, host.stderr); const receipt = JSON.parse(host.stdout); assert.equal(receipt.ok, true);
  assert.equal(receipt.data.project.id, projectId); assert.equal(receipt.data.location.relative_path, '目标 & 新');
  const undone = await post(`${location}/undo`, { ...bindings(appliedPage.html), request_key: 'ui-undo' });
  assert.equal(undone.status, 303, await undone.clone().text());
  assert.deepEqual(fs.readFileSync(path.join(source, '资料', '说明.md')), original);
  assert.equal(registry.show(projectId).location.relative_path, '项目甲');
  const next = await post(`${base}/move/prepare`, { target_relative_path: '目标 & 新', request_key: 'ui-prepare-again' });
  assert.equal(next.status, 303, await next.clone().text());
  const nextLocation = next.headers.get('location');
  const nextPreview = await get(nextLocation);
  const nextApply = await post(`${nextLocation}/execute`, { ...bindings(nextPreview.html), request_key: 'ui-confirm-again' });
  assert.equal(nextApply.status, 303, await nextApply.clone().text());
  const nextPage = await get(nextLocation);
  fs.appendFileSync(path.join(destination, '资料', '说明.md'), '外部后改\n');
  const refused = await post(`${nextLocation}/undo`, { ...bindings(nextPage.html), request_key: 'ui-undo-changed' });
  assert.equal(refused.status, 409); assert.match(await refused.text(), /role="alert"/u);
  assert.match(fs.readFileSync(path.join(destination, '资料', '说明.md'), 'utf8'), /外部后改/u);
  fs.mkdirSync(path.join(workspace, '已占用'));
  const occupied = await post(`${base}/move/prepare`, { target_relative_path: '已占用', request_key: 'ui-occupied' });
  assert.equal(occupied.status, 409); assert.match(await occupied.text(), /value="已占用"/u);
  // Use the real writer and interrupt only after its physical move has succeeded.
  const interruptedService = createProjectMoveService({ stateDir, registry, resourceControl,
    afterPhysicalMove: () => { throw new Error('Fixture interruption after real physical move.'); } });
  const interrupted = interruptedService.prepare({ projectId, targetRelativePath: '恢复目标', requestKey: 'ui-recovery-prepare', caller: { tool: 'fixture', client_run_id: 'ui-recovery' } });
  assert.throws(() => interruptedService.execute(interrupted.move_id, { projectId, expectedRevision: interrupted.revision,
    expectedDigest: interrupted.digest, requestKey: 'ui-recovery-interrupt', caller: { tool: 'fixture', client_run_id: 'ui-recovery' } }), /Fixture interruption/u);
  interruptedService.dispose();
  const recoveryLocation = `${base}/move/${interrupted.move_id}`;
  const recoveryPage = await get(recoveryLocation);
  assert.equal(recoveryPage.status, 200); assert.ok(recoveryPage.html.includes(`${recoveryLocation}/recover`));
  assert.equal(fs.existsSync(destination), false);
  const recovered = await post(`${recoveryLocation}/recover`, { ...bindings(recoveryPage.html), request_key: 'ui-recover' });
  assert.equal(recovered.status, 303, await recovered.clone().text());
  assert.equal(registry.show(projectId).location.relative_path, '恢复目标');
  assert.match(fs.readFileSync(path.join(workspace, '恢复目标', '资料', '说明.md'), 'utf8'), /外部后改/u);
  assert.equal((await get(base)).status, 200);

});

test('Interrupted move view exposes only service capabilities and preserves escaped recovery evidence', () => {
  const html = renderProjectMoveView({ project: { id: 'P-identity', name: 'Project' }, move: {
    move_id: 'existing-run-id', project_id: 'P-identity', revision: 4, digest: 'digest', status: 'needs_recovery',
    source: { relative_path: '旧', path: 'Root/旧' }, target: { relative_path: '<目标>', path: 'Root/<目标>' },
    summary: { files: 1 }, conflicts: ['Inspect <conflict>'], warnings: [], can_execute: false, can_undo: false, can_recover: true,
  } }, { csrfToken: 'test', locale: 'en' });
  assert.match(html, /existing-run-id\/recover/u); assert.doesNotMatch(html, /existing-run-id\/(execute|undo)"/u);
  assert.match(html, /name="expected_revision" value="4"/u); assert.match(html, /&lt;目标&gt;/u); assert.match(html, /Inspect &lt;conflict&gt;/u);
  assert.match(html, /<dt>Original folder<\/dt>/u);
  assert.doesNotMatch(html, /<dt>Current folder<\/dt>/u);
});

test('Move status leads with correct current paths and actions while technical details stay closed', () => {
  const move = { move_id: 'receipt', project_id: 'P-identity', revision: 4, digest: 'digest',
    source: { relative_path: 'before', path: 'Root/before' }, target: { relative_path: 'after', path: 'Root/after' },
    summary: { files: 2, resources: 1, works: 1, saves: 1, boards: 1, bytes: 1200 },
    conflicts: [], warnings: ['References in file contents are not rewritten.', 'Unknown <warning>'],
    can_execute: false, can_undo: false, can_recover: false };
  for (const locale of ['en', 'zh-CN']) {
    const render = state => renderProjectMoveView({ project: { id: 'P-identity', name: 'Project' }, move: { ...move, ...state } }, { locale, csrfToken: 'token' });
    const applied = render({ status: 'applied', can_undo: true });
    assert.match(applied, /<details class="project-move-technical"><summary>/u);
    assert.doesNotMatch(applied, /<details[^>]+open/u);
    assert.match(applied, locale === 'en' ? /<dt>Original folder<\/dt><dd>before<\/dd><dt>Current folder<\/dt><dd>after<\/dd>/u : /<dt>原文件夹<\/dt><dd>before<\/dd><dt>当前文件夹<\/dt><dd>after<\/dd>/u);
    assert.ok(applied.indexOf('project-move-actions') < applied.indexOf('project-move-technical'));
    assert.match(applied, /action-button-secondary" type="submit"/u);
    assert.match(applied, /Unknown &lt;warning&gt;/u);
    assert.doesNotMatch(applied, /References in file contents are not rewritten\./u);
    assert.match(applied, locale === 'en' ? /<dt>Resources<\/dt><dd>1/u : /<dt>资源<\/dt><dd>1/u);
    const prepared = render({ status: 'prepared', can_execute: true });
    assert.match(prepared, locale === 'en' ? /<dt>Current folder<\/dt><dd>before<\/dd><dt>Destination folder<\/dt><dd>after<\/dd>/u : /<dt>当前文件夹<\/dt><dd>before<\/dd><dt>目标文件夹<\/dt><dd>after<\/dd>/u);
    assert.match(prepared, /receipt\/execute/u);
    const undone = render({ status: 'undone' });
    assert.match(undone, locale === 'en' ? /<dt>Current folder<\/dt><dd>before<\/dd>/u : /<dt>当前文件夹<\/dt><dd>before<\/dd>/u);
    assert.match(undone, /class="action-button" href="\/projects\/P-identity"/u);
  }
});
