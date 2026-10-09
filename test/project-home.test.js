import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { createProjectHomeService } from '../src/ui/services/project-home-service.js';
import { buildProjectHomeModel } from '../src/ui/read-model/project-home-model.js';
import { renderProjectHomeView } from '../src/ui/views/project-home-view.js';
import { createResourceControl } from '../src/resource-control.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { contentFileFingerprint } from '../src/content-inspection.js';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';

const rootFor = (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'project-home-'));
  return root;
};
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };

function projectFixture(t) {
  const root = rootFor(t); const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'Project'); const file = write(path.join(projectRoot, 'Data', 'input.csv'), 'name\nvalue\n');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const created = registry.create({ name: 'Project', currentPath: 'Project' }); registry.attachRoot(created.project_id, { rootId: adopted.root_id, relativePath: 'Project', reason: 'Home test.' });
  const project = { id: created.project_id, name: 'Project', status: 'active' }; const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const resource = resourceControl.identify({ filePath: file, project });
  const fixture = { root, stateDir, projectRoot, file, resource, project, registry, resourceControl, server: null };
  t.after(async () => { if (fixture.server) { await fixture.server.close(); fixture.server = null; } fixture.resourceControl.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return fixture;
}

test('Project Home service persists pins, Continue, checks, and surfaces corrupt state', (t) => {
  const root = rootFor(t); const stateDir = path.join(root, 'state'); let tick = 0;
  const service = createProjectHomeService({ stateDir, now: () => `2026-09-17T00:00:0${++tick}.000Z` });
  service.pin('p', { kind: 'resource', id: 'r1', resource_id: 'r1', relative_path: 'Data/a.csv' });
  service.pin('p', { kind: 'result', id: 'z1', label: 'Result' });
  service.recordContinue('p', { kind: 'work', id: 'w1', revision: 2, origin: { kind: 'files', folder: 'Data', path: 'Data/a.csv' } });
  service.recordCheck('p', { status: 'complete', scopeLabel: 'Tracked' });
  const fresh = createProjectHomeService({ stateDir });
  assert.deepEqual(fresh.project('p').pinned.map((x) => x.id), ['r1', 'z1']); assert.equal(fresh.project('p').continue.id, 'w1'); assert.equal(fresh.project('p').check.status, 'complete');
  fs.writeFileSync(path.join(stateDir, 'ui', 'project-home.json'), '{"schema":"wrong"}');
  const corrupt = createProjectHomeService({ stateDir }); assert.ok(corrupt.project('p').error); assert.throws(() => corrupt.pin('p', { kind: 'resource', id: 'r2' }), /could not be loaded/u);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
});

test('Home route is rendered and refresh does not mutate Continue', async (t) => {
  const f = projectFixture(t); const work = f.resourceControl.ledger.workSessions.create({ projectId: f.project.id, returnState: { folder: 'Data', path: 'Data/input.csv' }, at: '2026-09-17T00:00:00.000Z' });
  const workService = createDataWorkService({ stateDir: f.stateDir, projectRoot: f.root, installationRoot: f.root, resourceControl: f.resourceControl }); workService.projectSession(f.project);
  f.server = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: f.resourceControl });
  const first = await fetch(`${f.server.workspace_url}projects/${f.project.id}`); const html1 = await first.text(); assert.equal(first.status, 200); assert.match(html1, /PROJECT HOME/u);
  await (await fetch(`${f.server.workspace_url}projects/${f.project.id}/resources?path=Data%2Finput.csv`)).text();
  const before = createProjectHomeService({ stateDir: f.stateDir }).project(f.project.id).continue;
  const second = await fetch(`${f.server.workspace_url}projects/${f.project.id}`); await second.text(); const after = createProjectHomeService({ stateDir: f.stateDir }).project(f.project.id).continue;
  assert.deepEqual(after, before); assert.ok(work.session_id);
});

test('Project Home check links an externally changed Resource back to its focused detail', async (t) => {
  const f = projectFixture(t); fs.appendFileSync(f.file, 'changed\n');
  f.server = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: f.resourceControl }); const base = `${f.server.workspace_url}projects/${f.project.id}`;
  let html = await (await fetch(base)).text(); const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const checked = await fetch(`${base}/home/check`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) }); assert.equal(checked.status, 303);
  html = await (await fetch(base)).text(); assert.match(html, /File changed outside Atlas/u); const href = html.match(new RegExp(`href="([^"]*resource_id=${f.resource.resource_id}[^"]*)"`, 'u'))?.[1]; assert.ok(href);
  const focused = await fetch(new URL(href.replaceAll('&amp;', '&'), f.server.workspace_url)); const focusedHtml = await focused.text(); assert.equal(focused.status, 200); assert.match(focusedHtml, new RegExp(f.resource.resource_id, 'u')); assert.match(focusedHtml, /Changed outside Keeproot|Changed since Keeproot last used it/u);
});

test('Project Home archives and restores ordinary Missing records without deleting Resource history', async (t) => {
  const f = projectFixture(t);
  const secondFile = write(path.join(f.projectRoot, 'Data', 'second.md'), 'second\n');
  const secondResource = f.resourceControl.identify({ filePath: secondFile, project: f.project });
  fs.rmSync(f.file);
  fs.rmSync(secondFile);
  f.resourceControl.projectResources(f.project.id, { refresh: true });
  f.server = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: f.resourceControl });
  let base = `${f.server.workspace_url}projects/${f.project.id}`;
  let html = await (await fetch(base)).text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  assert.match(html, /2 unavailable Resource records/u);
  assert.match(html, /Archive unavailable records/u);
  const post = (action, token = csrf) => fetch(`${base}/home/${action}`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token }),
  });
  assert.equal((await post('archive-missing', 'bad')).status, 403);
  assert.equal((await post('archive-missing')).status, 303);
  assert.equal((await post('archive-missing')).status, 303);
  let facts = f.resourceControl.projectResources(f.project.id);
  assert.ok([f.resource.resource_id, secondResource.resource_id].every((id) => facts.find((item) => item.resource_id === id)?.missing_record_archived));
  assert.ok([f.resource.resource_id, secondResource.resource_id].every((id) => f.resourceControl.describe(id).actions.filter((item) => item.action_type === 'archive_missing').length === 1));
  html = await (await fetch(base)).text();
  assert.doesNotMatch(html, /Archive unavailable records/u);
  assert.match(html, /Restore archived records/u);
  await f.server.close(); f.server = null;
  f.resourceControl.dispose();
  f.resourceControl = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  f.server = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: f.resourceControl });
  base = `${f.server.workspace_url}projects/${f.project.id}`;
  facts = f.resourceControl.projectResources(f.project.id);
  assert.ok([f.resource.resource_id, secondResource.resource_id].every((id) => facts.find((item) => item.resource_id === id)?.missing_record_archived));
  html = await (await fetch(base)).text();
  const restartedCsrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const restored = await fetch(`${base}/home/restore-missing`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: restartedCsrf }) });
  assert.equal(restored.status, 303);
  facts = f.resourceControl.projectResources(f.project.id);
  assert.ok([f.resource.resource_id, secondResource.resource_id].every((id) => facts.find((item) => item.resource_id === id)?.missing_record_archived === false));
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(secondFile), false);
});

function serverServicesFor(registry) { return { registry, rules: {}, runtime: {}, projectRoot: path.resolve('.'), installationRoot: path.resolve('.') }; }

test('Resource pin POST is CSRF checked, project contained, and survives restart', async (t) => {
  const f = projectFixture(t); f.server = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: f.resourceControl });
  const page = await (await fetch(`${f.server.workspace_url}projects/${f.project.id}`)).text(); const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const post = (values, token = csrf) => fetch(`${f.server.workspace_url}projects/${f.project.id}/home/pins`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token, action: 'pin', kind: 'resource', id: 'ignored', ...values }) });
  const badCsrf = await post({ path: 'Data/input.csv' }, 'wrong'); assert.equal(badCsrf.status, 400);
  const escaped = await post({ path: '../outside.csv' }); assert.notEqual(escaped.status, 303); assert.equal(createProjectHomeService({ stateDir: f.stateDir }).project(f.project.id).pinned.length, 0);
  const pinned = await post({ path: 'Data/input.csv' }); assert.equal(pinned.status, 303); await f.server.close(); f.server = null;
  const control2 = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); f.resourceControl = control2; f.server = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: control2 });
  const home = await (await fetch(`${f.server.workspace_url}projects/${f.project.id}`)).text(); assert.match(home, /Unpin/u);
});

test('Work open and successful Desktop recipe advance Continue; Host recipe update alone does not', async (t) => {
  const f = projectFixture(t); const workService = createDataWorkService({ stateDir: f.stateDir, projectRoot: f.root, installationRoot: f.root, resourceControl: f.resourceControl }); let session = workService.projectSession(f.project, { folder: 'Data', path: 'Data/input.csv', resource_id: f.resource.resource_id }); session = workService.addSource(session.session_id, f.resource.resource_id);
  f.server = await startAtlasUiServer({ stateDir: f.stateDir, desktopPickerEnabled: true, ...serverServicesFor(f.registry), resourceControl: f.resourceControl });
  const workUrl = `${f.server.workspace_url}work/${session.session_id}`; const open = await fetch(workUrl); assert.equal(open.status, 200); const workHtml = await open.text(); const csrf = workHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const homeState = () => createProjectHomeService({ stateDir: f.stateDir }).project(f.project.id).continue;
  const opened = homeState(); assert.equal(opened.id, session.session_id); f.resourceControl.ledger.workSessions.setRecipe(session.session_id, { schema: 'atlas.table-recipe.v1', version: 1, combine: { operation: 'concatenate' }, steps: [] }, '2026-09-17T00:01:00.000Z'); assert.equal(homeState().revision, opened.revision);
  const refreshedResponse = await fetch(workUrl); const refreshedHtml = await refreshedResponse.text(); assert.equal(refreshedResponse.status, 200); const refreshed = homeState(); assert.ok(refreshed.revision > opened.revision);
  const refreshedCsrf = refreshedHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; const baseRevision = refreshedHtml.match(/name="base_revision" value="(\d+)"/u)?.[1]; assert.equal(Number(baseRevision), refreshed.revision);
  const action = await fetch(`${workUrl}/action`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: refreshedCsrf, action: 'recipe', combine: 'concatenate', base_revision: baseRevision }) }); assert.equal(action.status, 303);
  assert.ok(homeState().revision > refreshed.revision);
});

test('Passive Resources and Home reads do not replace Work Continue', async (t) => {
  const f = projectFixture(t); const home = createProjectHomeService({ stateDir: f.stateDir });
  home.recordContinue(f.project.id, { kind: 'work', id: 'DWT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', revision: 1, label: 'Work', origin: { kind: 'files', folder: 'Data', path: 'Data/input.csv' } });
  f.server = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: f.resourceControl });
  const before = home.project(f.project.id).continue;
  await (await fetch(`${f.server.workspace_url}projects/${f.project.id}/resources?path=Data%2Finput.csv`)).text();
  await (await fetch(`${f.server.workspace_url}projects/${f.project.id}/resources?path=Data%2Finput.csv&fragment=folder-files`)).text();
  await (await fetch(`${f.server.workspace_url}projects/${f.project.id}`)).text();
  assert.deepEqual(home.project(f.project.id).continue, before);
});

test('Opening a Resource records a Files anchor only after the open succeeds', async (t) => {
  const f = projectFixture(t); const home = createProjectHomeService({ stateDir: f.stateDir });
  home.recordContinue(f.project.id, { kind: 'work', id: 'DWT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', revision: 1, label: 'Work', origin: { kind: 'files', folder: 'Data', path: 'Data/input.csv' } });
  const opened = []; f.server = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: f.resourceControl, openLocalFileFn: (filePath) => { opened.push(filePath); } });
  const page = await (await fetch(`${f.server.workspace_url}projects/${f.project.id}/resources?path=Data%2Finput.csv`)).text(); const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const response = await fetch(`${f.server.workspace_url}projects/${f.project.id}/resources/open`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, path: 'Data/input.csv' }) });
  assert.equal(response.status, 303); assert.deepEqual(opened, [f.file]); const openedContinue = home.project(f.project.id).continue; assert.equal(openedContinue.kind, 'files'); assert.equal(openedContinue.id, 'files:Data'); assert.equal(openedContinue.relative_path, 'Data/input.csv'); assert.deepEqual(openedContinue.origin, { kind: 'files', id: null, folder: 'Data', path: 'Data/input.csv' });
  const before = home.project(f.project.id).continue; const failing = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: f.resourceControl, openLocalFileFn: () => { throw new Error('open failed'); } });
  t.after(async () => { await failing.close(); });
  const failed = await fetch(`${failing.workspace_url}projects/${f.project.id}/resources/open`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: (await (await fetch(`${failing.workspace_url}projects/${f.project.id}`)).text()).match(/name="csrf" value="([a-f0-9]+)"/u)?.[1], path: 'Data/input.csv' }) });
  assert.notEqual(failed.status, 303); assert.deepEqual(home.project(f.project.id).continue, before);
});

test('Project Home state and lock junctions are rejected without touching the outside target', (t) => {
  const f = projectFixture(t); const outside = path.join(f.root, 'outside-state'); fs.mkdirSync(outside, { recursive: true }); const sentinel = path.join(outside, 'sentinel.txt'); fs.writeFileSync(sentinel, 'unchanged');
  const ui = path.join(f.stateDir, 'ui'); fs.mkdirSync(f.stateDir, { recursive: true });
  try { fs.rmSync(ui, { recursive: true, force: true }); fs.symlinkSync(outside, ui, 'junction'); } catch (error) { t.skip(`junction unavailable: ${error.code ?? error.message}`); return; }
  const service = createProjectHomeService({ stateDir: f.stateDir }); assert.ok(service.project(f.project.id).error); assert.throws(() => service.pin(f.project.id, { kind: 'resource', id: 'outside' }), /could not be loaded|junction|state/u); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  fs.unlinkSync(ui); fs.mkdirSync(ui, { recursive: true }); const locks = path.join(f.stateDir, 'locks'); fs.rmSync(locks, { recursive: true, force: true });
  try { fs.symlinkSync(outside, locks, 'junction'); } catch (error) { t.skip(`lock junction unavailable: ${error.code ?? error.message}`); return; }
  assert.throws(() => service.recordContinue(f.project.id, { kind: 'files', id: 'f', relative_path: 'Data/a.csv' }), /junction|state|lock/u); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
});

test('Recent Result is not verified when its recorded fingerprint no longer matches', (t) => {
  const root = rootFor(t); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const resultPath = write(path.join(root, 'result.csv'), 'changed');
  const currentHash = contentFileFingerprint(resultPath).sha256;
  const changed = buildProjectHomeModel({ project: { id: 'p', name: 'P' }, root, base: '/projects/p', homeState: { continue: null, pinned: [], check: null }, resourceFacts: [], workSessions: [], savedWork: [{ work_id: 'SAV-1', result_path: resultPath, result_fingerprint: { sha256: 'not-the-current-sha256' }, resource_id: 'RES-r', result_summary: { rows: 1, columns: 1 }, status: 'executed' }], currentActivity: [], hasProjectFiles: true });
  assert.equal(changed.recent_results[0].status, 'changed'); assert.match(changed.changes.items[0].href, /resource_id=RES-r/u);
  const verified = buildProjectHomeModel({ project: { id: 'p', name: 'P' }, root, base: '/projects/p', homeState: { continue: null, pinned: [], check: null }, resourceFacts: [], workSessions: [], savedWork: [{ work_id: 'SAV-1', result_path: resultPath, result_fingerprint: { sha256: currentHash }, result_summary: { rows: 1, columns: 1 }, status: 'executed' }], currentActivity: [], hasProjectFiles: true });
  assert.equal(verified.recent_results[0].status, 'verified'); fs.rmSync(resultPath);
  const missing = buildProjectHomeModel({ project: { id: 'p', name: 'P' }, root, base: '/projects/p', homeState: { continue: null, pinned: [], check: null }, resourceFacts: [], workSessions: [], savedWork: [{ work_id: 'SAV-1', result_path: resultPath, result_fingerprint: { sha256: currentHash }, resource_id: 'RES-r', result_summary: { rows: 1, columns: 1 }, status: 'executed' }], currentActivity: [], hasProjectFiles: true });
  assert.equal(missing.recent_results[0].status, 'missing_source'); assert.match(missing.recent_results[0].href, /resource_id=RES-r/u);
});

test('Saved Result details do not call unavailable output states Verified', () => {
  const record = { work_id: 'SAV-test', sources: [], recipe: { version: 1 }, project: { id: 'p' }, result_path: 'result.csv', result_summary: { rows: 1, columns: 1 }, write: {} };
  for (const [output_status, heading] of [['changed', 'Result changed'], ['unknown', 'Result not checked'], ['undone', 'Save undone'], ['missing_source', 'Result missing']]) {
    const html = renderDataWorkView({ mode: 'saved', csrf: 'csrf', session: { session_id: 'DWT-test', sources: [] }, record: { ...record, output_status } });
    assert.doesNotMatch(html, /<h1>Verified<\/h1>/u); assert.match(html, new RegExp(`<h1>${heading}</h1>`, 'u'));
  }
  const verified = renderDataWorkView({ mode: 'saved', csrf: 'csrf', session: { session_id: 'DWT-test', sources: [] }, record: { ...record, output_status: 'verified' } });
  assert.match(verified, /<h1>Verified<\/h1>/u);
});

test('Home model and view cover fallbacks, change states, and empty-card rules', () => {
  const base = '/projects/p'; const project = { id: 'p', name: 'P' }; const baseArgs = { project, root: process.cwd(), base, resourceFacts: [], workSessions: [], savedWork: [], currentActivity: [], hasProjectFiles: true };
  const fallback = buildProjectHomeModel({ ...baseArgs, homeState: { continue: { kind: 'work', id: 'DWT-missing', label: 'Old Work', origin: { kind: 'files', folder: 'Data', path: 'Data/a.csv' } }, pinned: [], check: null } }); assert.equal(fallback.continue_item.kind, 'files'); assert.match(fallback.continue_item.notice, /no longer available/u); assert.match(fallback.continue_item.href, /folder=Data/u);
  for (const [check, expected] of [[{}, 'not_checked'], [{ status: 'complete', checked_at: '2026-09-17', scope_label: 'x' }, 'clear'], [{ status: 'failed', checked_at: '2026-09-17', scope_label: 'x', error_message: 'bad' }, 'failed']]) assert.equal(buildProjectHomeModel({ ...baseArgs, homeState: { continue: null, pinned: [], check } }).changes.state, expected);
  const missing = buildProjectHomeModel({ ...baseArgs, homeState: { continue: null, pinned: [{ kind: 'resource', id: 'r', resource_id: 'r', relative_path: 'Data/missing.csv' }], check: null }, resourceFacts: [{ resource_id: 'r', path: 'Data/missing.csv', resource: { display_name: 'Missing', status: 'missing' } }] }); assert.match(missing.pinned[0].href, /resource_id=r/u);
  const current = { title: 'Current import', href: '/work/DWT-current', revision: 3, recipe_label: 'Recipe 2', result_label: 'No saved Result', freshness_label: 'Current', updated_at: '2026-09-21T10:00:00.000Z' }; const previous = { title: 'Earlier import', href: '/work/DWT-earlier', revision: 2, reuse_action: '/work/DWT-earlier/reuse', recipe_label: 'Recipe 1' };
  const rendered = renderProjectHomeView({ ...baseArgs, empty_project: false, continue_item: current, other_work: [previous], pinned: [], changes: { state: 'not_checked', items: [] }, recent_results: [] }, { csrfToken: 'x' }); assert.match(rendered, /<h1>P<\/h1>/u); assert.doesNotMatch(rendered, /CURRENT WORK|Continue where you left off/u); assert.match(rendered, /PREVIOUS WORK/u); assert.match(rendered, /Continue work/u); assert.match(rendered, /Resources/u); assert.match(rendered, /Boards/u); assert.match(rendered, /Reuse/u);
  assert.equal((rendered.match(/class="action-button" href="\/work\/DWT-current"/gu) ?? []).length, 1);
  assert.match(rendered, /<details class="project-home-work-details"><summary>Work details<\/summary>[\s\S]*Recipe 2/u);
  const localized = renderProjectHomeView({ ...baseArgs, continue_item: { ...current, position: 'Saved result ready', notice: 'Attention is required' }, pinned: [{ title: 'Input.csv', kind: 'resource', id: 'r', status: 'verified' }], changes: { state: 'not_checked', scope_label: 'Tracked Project Resources', items: [] }, recent_results: [{ title: 'Saved.csv', detail: 'Output matches the verified saved result', kind: 'result', id: 'SAV-1', href: '/saves/SAV-1', status: 'verified' }] }, { locale: 'zh-CN' }); assert.match(localized, /项目主页/u); assert.match(localized, /资源/u); assert.match(localized, /看板/u); assert.match(localized, /href="\/projects\/p\/boards"/u);
  assert.match(localized, /继续工作/u);
  assert.match(localized, /状态: 结果已保存/u); assert.match(localized, /尚未检查/u); assert.match(localized, /Keeproot 尚未检查此范围。 已跟踪的项目资源/u); assert.match(localized, /检查已跟踪的资源/u); assert.match(localized, /最近结果/u); assert.match(localized, /输出与已验证的保存结果一致。/u); assert.match(localized, /已验证/u); assert.match(localized, />固定<\/button>/u);
  assert.match(localized, /Attention is required[\s\S]*<details class="project-home-work-details">/u);
  const previousOnly = renderProjectHomeView({ ...baseArgs, empty_project: false, continue_item: null, other_work: [previous], pinned: [], changes: { state: 'not_checked', items: [] }, recent_results: [] }, { csrfToken: 'x' });
  assert.doesNotMatch(previousOnly, /CURRENT WORK|Continue where you left off/u);
  assert.equal((previousOnly.match(/<h2[^>]*>Previous Work<\/h2>/gu) ?? []).length, 1);
  assert.match(previousOnly, /Earlier import/u);
  const empty = renderProjectHomeView({ ...baseArgs, empty_project: false, continue_item: null, other_work: [], pinned: [], changes: { state: 'not_checked', items: [] }, recent_results: [] }, { csrfToken: 'x' }); assert.doesNotMatch(empty, /aria-labelledby="project-home-continue-title"/u); assert.doesNotMatch(empty, /aria-labelledby="project-home-pinned-title"/u); assert.match(empty, /CHANGES/u); assert.match(empty, /RECENT RESULTS/u); const start = renderProjectHomeView({ ...baseArgs, empty_project: true, continue_item: null, other_work: [], pinned: [], changes: { state: 'not_checked', items: [] }, recent_results: [] }); assert.match(start, /START HERE/u); assert.doesNotMatch(start, /CHANGES/u);
});

test('Project check persists changed Resources as actionable Home items', (t) => {
  const root = rootFor(t); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state'); const service = createProjectHomeService({ stateDir, now: () => '2026-09-19T10:00:00.000Z' });
  service.recordCheck('p', { status: 'complete', scopeLabel: '2 tracked Project Resources', changedResources: [{ resource_id: 'RES-1', title: 'image.png', baseline_version: 'a'.repeat(64), current_version: 'b'.repeat(64) }] });
  const homeState = createProjectHomeService({ stateDir }).project('p'); assert.equal(homeState.check.changed_resources.length, 1);
  const model = buildProjectHomeModel({ project: { id: 'p', name: 'P' }, root, base: '/projects/p', homeState, resourceFacts: [], workSessions: [], savedWork: [], savedViews: [], currentActivity: [], hasProjectFiles: true });
  assert.equal(model.changes.state, 'attention'); assert.equal(model.changes.items[0].status, 'changed'); assert.match(model.changes.items[0].href, /resource_id=RES-1/u);
});

test('Project Home aggregates unrelated missing traces into one bounded attention item', () => {
  const missingFacts = Array.from({ length: 24 }, (_, index) => ({
    resource_id: `RES-missing-${index}`,
    resource: { display_name: `old-${index}.md`, status: 'missing' },
    status: 'missing',
    path: `F:/deleted/old-${index}.md`,
    content_hash: `hash-${index}`,
    relationships: [],
  }));
  const model = buildProjectHomeModel({
    project: { id: 'project-1', name: 'Project One' }, root: process.cwd(), base: '/projects/project-1',
    homeState: { continue: null, pinned: [], check: null }, resourceFacts: missingFacts,
  });
  assert.equal(model.changes.state, 'attention');
  assert.equal(model.changes.items.length, 1);
  assert.match(model.changes.items[0].detail, /missing|unavailable|review/iu);
  assert.match(model.changes.items[0].href, /\/resources(?:\?|$)/u);
});

test('Project Home keeps Work Missing actionable while archived ordinary records stay quiet', () => {
  const model = buildProjectHomeModel({
    project: { id: 'project-1', name: 'Project One' }, root: process.cwd(), base: '/projects/project-1',
    homeState: { continue: null, pinned: [], check: null },
    resourceFacts: [
      { resource_id: 'RES-work', resource: { display_name: 'work.csv', status: 'missing' }, status: 'missing' },
      { resource_id: 'RES-old', resource: { display_name: 'old.md', status: 'missing' }, status: 'missing', missing_record_archived: true },
    ],
    workSessions: [{ session_id: 'DWT-work', sources: [{ resource_id: 'RES-work', name: 'work.csv', status: 'missing' }], revision: 1 }],
  });
  assert.equal(model.missing_records.count, 1);
  assert.equal(model.missing_records.archived_count, 1);
  assert.equal(model.changes.items.length, 1);
  assert.equal(model.changes.items[0].key, 'work:DWT-work');
  assert.match(model.changes.items[0].href, /\/work\/DWT-work/u);
  const archived = buildProjectHomeModel({
    project: { id: 'project-1', name: 'Project One' }, root: process.cwd(), base: '/projects/project-1',
    homeState: { continue: null, pinned: [], check: null },
    resourceFacts: [{ resource_id: 'RES-work', resource: { display_name: 'work.csv', status: 'missing' }, status: 'missing', missing_record_archived: true }],
    workSessions: [{ session_id: 'DWT-work', sources: [{ resource_id: 'RES-work', name: 'work.csv', status: 'missing' }], revision: 1 }],
  });
  assert.equal(archived.changes.items.length, 0);
  assert.equal(archived.missing_records.archived_count, 1);
  const archivedResult = buildProjectHomeModel({
    project: { id: 'project-1', name: 'Project One' }, root: process.cwd(), base: '/projects/project-1',
    homeState: { continue: null, pinned: [], check: null },
    resourceFacts: [{ resource_id: 'RES-result', resource: { display_name: 'old-result.csv', status: 'missing' }, status: 'missing', missing_record_archived: true }],
    savedWork: [{ work_id: 'SAV-old', resource_id: 'RES-result', result_path: path.join(process.cwd(), 'missing-old-result.csv'), status: 'executed' }],
  });
  assert.equal(archivedResult.recent_results.length, 0);
  assert.equal(archivedResult.changes.items.length, 0);
});


test('UI refuses Fetch-restricted port 6679 before opening the listener', async (t) => {
  const f = projectFixture(t);
  await assert.rejects(async () => {
    f.server = await startAtlasUiServer({ stateDir: f.stateDir, ...serverServicesFor(f.registry), resourceControl: f.resourceControl, port: 6679 });
  }, /port 6679.*blocks/u);
});
