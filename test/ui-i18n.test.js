import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { translateUi, normalizeUiLocale } from '../src/ui/i18n.js';
import { FILE_WORK_MESSAGES } from '../src/ui/file-work-messages.js';
import { normalizeUiPreferences, writeUiPreferences, readUiPreferences } from '../src/ui/preferences.js';
import { renderNav, renderTopbar } from '../src/ui/components.js';
import { renderProjectHomeView } from '../src/ui/views/project-home-view.js';
import { renderProjectsHomeView, renderProjectOnboardingView } from '../src/ui/views/projects-home-view.js';
import { renderSearchView } from '../src/ui/views/search-view.js';
import { renderActivityView } from '../src/ui/views/activity-view.js';
import { renderWorkTargetView } from '../src/ui/views/work-target-view.js';
import { renderBatchWorkView } from '../src/ui/views/batch-work-view.js';
import { renderFileCompareView } from '../src/ui/views/file-compare-view.js';
import { renderFileWorkView } from '../src/ui/views/file-work-view.js';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';
import { renderBoardView } from '../src/ui/views/board-view.js';
import { renderSaveResultView } from '../src/ui/views/save-result-view.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { Registry } from '../src/registry.js';

test('locale interface falls back to English and keeps names and route identity intact', () => {
  assert.equal(normalizeUiLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeUiLocale('<script>'), 'en');
  assert.equal(translateUi('unknown', 'nav.projects'), 'Projects');
  assert.equal(translateUi('zh-CN', 'nav.projects'), '项目');
  assert.equal(translateUi('zh-CN', 'unmapped.key'), 'unmapped.key');
  assert.equal(normalizeUiPreferences({}).locale, 'en');
  const nav = renderNav('Resources', { locale: 'zh-CN', interactive: true, resourcesHref: '/projects/P/resources' });
  assert.match(nav, /aria-current="page"/u);
  assert.match(nav, /href="\/projects\/P\/resources"/u);
  assert.match(nav, />材料与阅读<\/span>/u);
  assert.match(nav, /状态说明/u);
  assert.doesNotMatch(nav, /Status guide/u);
  const projects = renderProjectsHomeView({ projects: [{ id: 'PRJ-1', name: 'User <Project>', folder_available: true,
    recent_resource: { name: 'budget.csv' } }], selected_project_id: 'PRJ-1' }, { locale: 'zh-CN' });
  assert.match(projects, /本地项目/u);
  assert.match(projects, /最近资源/u);
  assert.match(projects, /User &lt;Project&gt;/u);
  assert.doesNotMatch(projects, /<Project>/u);
  const onboarding = renderProjectOnboardingView({ mode: 'new', name: 'Original <name>' }, { locale: 'zh-CN' });
  assert.match(onboarding, /选择名称和上级文件夹/u);
  assert.match(onboarding, /Original &lt;name&gt;/u);
  assert.match(onboarding, /name="name"/u);
  const search = renderSearchView({ query: 'budget', items: [] }, { locale: 'zh-CN' });
  assert.match(search, /没有本地结果/u);
  assert.match(search, /搜索项目和资源/u);
  const activity = renderActivityView({ current_activity: [], recent_work: [] }, { locale: 'zh-CN' });
  assert.match(activity, /没有进行中的工作/u);
  assert.match(activity, /状态说明/u);
  const target = renderWorkTargetView({ project: { id: 'PRJ-1', name: 'User <Project>' },
    selection: { count: 1, resources: [{ resource_id: 'RES-1', name: 'Budget.csv', relative_path: 'Data/Budget.csv' }] },
    works: [], back_href: '/projects/PRJ-1/resources', commit_action: '/work/commit', cancel_action: '/work/cancel' }, { locale: 'zh-CN' });
  assert.match(target, /选择这些文件要用于哪项工作/u);
  assert.match(target, /name="target" value="new"/u);
  assert.match(target, /User &lt;Project&gt;/u);
  const importHome = renderBatchWorkView({ mode: 'empty-selection' }, { locale: 'zh-CN' });
  assert.match(importHome, /本次选择/u);
  assert.match(importHome, /添加文件夹/u);
  assert.match(importHome, /data-import-messages=/u);
  assert.match(importHome, /data-desktop-picker-enabled="false"/u);
  assert.match(importHome, /要选择本地文件入库，请打开已安装的 Atlas Desktop/u);
  assert.match(importHome, /href="\/projects">浏览项目/u);
  const desktopImport = renderBatchWorkView({ mode: 'empty-selection', desktop_picker_enabled: true }, { locale: 'en' });
  assert.match(desktopImport, /data-desktop-picker-enabled="true"/u);
  assert.doesNotMatch(desktopImport, /This HTML preview can read/u);
  assert.match(importHome, /桌面文件选择器尚未就绪/u);
  assert.doesNotMatch(importHome, /data-import-messages="\{&quot;picker_unavailable&quot;:&quot;The Desktop/u);
  const importSelection = renderBatchWorkView({ mode: 'selection-set', items: [], projects: [], queue_id: 'QUE-1' }, { locale: 'zh-CN' });
  assert.match(importSelection, /目标位置/u);
  assert.match(importSelection, /取消导入/u);
  assert.match(importSelection, /name="queue_id" value="QUE-1"/u);
  const importResult = renderBatchWorkView({ mode: 'batch-result', items: [], inspected_count: 0, batch_id: 'BAT-1' }, { locale: 'zh-CN' });
  assert.match(importResult, /文件已就绪/u);
  const comparison = renderFileCompareView({ mode: 'choose', desktop_picker_enabled: false }, { locale: 'zh-CN' });
  assert.match(comparison, /比较文件仅可在 Atlas Desktop 使用/u);
  assert.match(comparison, /选择第一个文件/u);
  const html = renderProjectHomeView({ base: '/projects/P', project: { name: 'Original 文件名 <test>' }, empty_project: true }, { locale: 'zh-CN' });
  assert.match(html, /lang="zh-CN"/u);
  assert.match(html, /项目主页/u);
  assert.match(html, /从这里开始/u);
  assert.doesNotMatch(html, /START HERE/u);
  assert.match(html, /Original 文件名 &lt;test&gt;/u);
  assert.doesNotMatch(html, /<test>/u);
  const continuing = renderProjectHomeView({ base: '/projects/P', project: { name: '原项目' },
    continue_item: { title: 'Original 工作名', href: '/work/DWT-original', position: 'Confirm field alignment' },
  }, { locale: 'zh-CN' });
  assert.match(continuing, /状态: 确认字段对应/u);
  assert.doesNotMatch(continuing, /Confirm field alignment/u);
  assert.match(continuing, /Original 工作名/u);
  assert.match(continuing, /href="\/work\/DWT-original"/u);
  const attention = renderProjectHomeView({ base: '/projects/P', project: { name: 'Project' }, empty_project: false,
    continue_item: null, other_work: [], pinned: [], recent_results: [],
    changes: { state: 'attention', scope_label: 'Known Project facts', items: [
      { title: 'plan.md', detail: 'Atlas local content inspection requires the installed Desktop Python component.', status: 'failed', href: '/activity?selected=A1' },
    ] } }, { locale: 'zh-CN' });
  assert.match(attention, /已知项目状态/u);
  assert.match(attention, /检查已停止；可重试或在活动中查看相关原因/u);
  assert.match(attention, /失败/u);
  assert.doesNotMatch(attention, /Atlas local content inspection requires/u);
  assert.match(renderTopbar({ project: { id: 'P', name: '一个很长的项目名称' }, locale: 'zh-CN' }), /搜索项目和资源/u);
});

test('single-file Import translates states and keeps Project, file and form identity', () => {
  assert.deepEqual(Object.keys(FILE_WORK_MESSAGES.en).sort(), Object.keys(FILE_WORK_MESSAGES['zh-CN']).sort());
  const options = { locale: 'zh-CN', csrfToken: 'csrf', fileBackHref: '/files', projectBasePath: '/projects/' };
  const work = { work_id: 'FW-1', file_path: 'C:/sample/User <report>.csv', inspect: { purpose: 'data' } };
  const selected = renderFileWorkView({ mode: 'selected', selected: { name: 'User <report>.csv',
    file_path: work.file_path, selection_id: 'SEL-1', purpose: 'data' } }, options);
  assert.match(selected, /可以检查此本地文件/u);
  assert.match(selected, /User &lt;report&gt;\.csv/u);
  assert.match(selected, /name="selection_id" value="SEL-1"/u);
  const ready = renderFileWorkView({ mode: 'ready', work, inspection: { source: { path: work.file_path, bytes: 42 },
    extraction: { profile: { row_count: 2, column_count: 1, columns: [{ name: 'amount' }] }, sheets: [{ name: 'Sheet1' }] } } }, options);
  assert.match(ready, /检查完成/u);
  assert.match(ready, /选择工作表/u);
  assert.match(ready, /表格有 2 行、1 个字段/u);
  assert.match(ready, /name="sheet"/u);
  assert.match(ready, /value="Sheet1"/u);
  const localRead = renderFileWorkView({ mode: 'ready', work, inspection: {
    source: { path: work.file_path, bytes: 42 }, extraction: { kind: 'text', status: 'complete', text: 'abc', sample_line_count: 1 },
    next_action: { mode: 'use_local_extraction', reason: 'The local result is sufficient for structure or content reasoning; do not open a browser or desktop application.' },
  } }, options);
  assert.match(localRead, /本地提取结果足以用于结构或内容处理/u);
  assert.doesNotMatch(localRead, /The local result is sufficient/u);
  const changed = renderFileWorkView({ mode: 'changed', work }, options);
  assert.match(changed, /文件已变化/u);
  assert.match(changed, /更新本地结果/u);
  const missing = renderFileWorkView({ mode: 'missing', work }, options);
  assert.match(missing, /找不到文件/u);
  assert.doesNotMatch(missing, /Open in default app/u);
  const add = renderFileWorkView({ mode: 'add-to-project', work, projects: [{ id: 'PRJ-1', name: 'User <Project>', available: true,
    folders: [{ relative_path: 'Data', name: 'Data', depth: 0 }] }] }, options);
  assert.match(add, /检查目标位置/u);
  assert.match(add, /User &lt;Project&gt;/u);
  assert.match(add, /name="project_id"/u);
  assert.match(add, /name="folder" value="Data"/u);
  const review = renderFileWorkView({ mode: 'project-review', work, project: { name: 'User Project' }, import_id: 'IMP-1',
    prepared: { target_path: 'C:/sample/Data/report.csv' } }, options);
  assert.match(review, /不会覆盖已有文件/u);
  assert.match(review, /name="import_id" value="IMP-1"/u);
  const conflict = renderFileWorkView({ mode: 'project-conflict', work, project: { name: 'User Project' },
    reason: 'Already exists', target_path: 'C:/sample/Data/report.csv', file_name: 'report-2.csv', import_id: 'IMP-1',
    folders: [{ relative_path: 'Data' }] }, options);
  assert.match(conflict, /选择其他目标位置/u);
  assert.match(conflict, /Atlas 无法保存到当前目标/u);
  assert.match(conflict, /原始原因/u);
  assert.match(conflict, /name="file_name" value="report-2\.csv"/u);
  const failed = renderFileWorkView({ mode: 'read-failed', work, failure: { kind: 'permission', retry_supported: true } }, options);
  assert.match(failed, /没有访问权限/u);
  assert.match(failed, /允许访问后重试/u);
  const injected = renderFileWorkView({ mode: 'selected', selected: { name: 'file.txt', selection_id: 'SEL-1', purpose: 'text' } }, {
    ...options, languageCatalog: { packs: [{ locale: 'zh-CN', namespace: 'atlas', messages: { 'filework.inspect': '<img src=x onerror=alert(1)>' } }] },
  });
  assert.doesNotMatch(injected, /<img src=x onerror=alert\(1\)>/u);
});

test('Work, Board and Save receipt translate controls without translating protocol values or user content', () => {
  const project = { id: 'PRJ-1', name: 'Original Project <name>' };
  const work = renderDataWorkView({
    mode: 'sources', back_href: '/projects/PRJ-1/resources', csrf: 'csrf', project,
    session: { session_id: 'DWT-1', project_id: 'PRJ-1', revision: 2, intent: 'Budget <draft>',
      sources: [], mapping: [], mapping_complete: false, change_review: { status: 'fresh' },
      reuse_action: '/work/DWT-1/reuse' },
  }, { locale: 'zh-CN' });
  assert.match(work, /复用的工作|已有工作/u);
  assert.match(work, /检查来源/u);
  assert.match(work, /name="action" value="prepare_sources"/u);
  assert.match(work, /base_revision" value="2"/u);
  assert.match(work, /Budget &lt;draft&gt;/u);
  assert.doesNotMatch(work, /<draft>/u);
  const injectedWork = renderDataWorkView({
    mode: 'sources', back_href: '/projects/PRJ-1/resources', csrf: 'csrf', project,
    session: { session_id: 'DWT-1', project_id: 'PRJ-1', revision: 2,
      sources: [], mapping: [], mapping_complete: false, change_review: { status: 'fresh' } },
  }, { locale: 'zh-CN', languageCatalog: { packs: [{ locale: 'zh-CN', namespace: 'atlas', messages: { 'work.check_sources': '<img src=x onerror=alert(1)>' } }] } });
  assert.doesNotMatch(injectedWork, /<img src=x onerror=alert\(1\)>/u);

  const boardModel = { mode: 'detail', base: '/projects/PRJ-1', project,
    board: { board_id: 'BRD-1', revision: 5, title: 'Board <original>', freshness: { status: 'fresh' },
      blocks: [{ block_id: 'BLK-1', type: 'text', text: 'User text <unchanged>' }] },
    resources: [{ resource_id: 'RES-1', resource: { display_name: 'Material <name>' } }],
    results: [], folders: [{ relative_path: 'Delivery' }] };
  const board = renderBoardView(boardModel, { locale: 'zh-CN', csrfToken: 'csrf' });
  assert.match(board, /添加内容/u);
  assert.match(board, /可携带交付/u);
  assert.match(board, /value="material_reference"/u);
  assert.match(board, /name="base_revision" value="5"/u);
  assert.match(board, /User text &lt;unchanged&gt;/u);
  assert.match(board, /Board &lt;original&gt;/u);
  const injected = renderBoardView(boardModel, { locale: 'zh-CN', languageCatalog: { packs: [{ locale: 'zh-CN', namespace: 'atlas', messages: { 'work.add_block': '<script>alert(1)</script>' } }] } });
  assert.match(injected, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(injected, /<script>alert\(1\)<\/script>/u);

  const saved = renderSaveResultView({ csrf: 'csrf', save: { save_id: 'SAV-1', status: 'executed', project,
    target: { relative_path: 'Delivery/report.csv' }, resources_href: '/projects/PRJ-1/resources',
    verification: { status: 'verified' }, source: { recorded_path: 'Data/input.csv' } } }, { locale: 'zh-CN' });
  assert.match(saved, /验证详情/u);
  assert.match(saved, /打开已保存成果/u);
  assert.match(saved, /Delivery\/report.csv/u);
});

test('Settings persists language through the real form and another server start', async (t) => {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const stateDir = fs.mkdtempSync(path.resolve('test/.tmp/ui-language-'));
  const registry = new Registry({ stateDir });
  let server;
  t.after(async () => { if (server) await server.close(); registry.dispose(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  writeUiPreferences(stateDir, { theme: 'graphite', text_size: 'large', locale: 'en' });
  server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {} });
  const returnHref = '/work/DWT-original/saved?work_id=SAV-original';
  const response = await fetch(`${server.workspace_url}settings?return_to=${encodeURIComponent(returnHref)}`); const html = await response.text();
  assert.ok(html.includes(`name="return_to" value="${returnHref}"`));
  for (const candidate of ['/saves/SAV-original', '/projects/P/boards/B']) {
    const page = await (await fetch(`${server.workspace_url}settings?return_to=${encodeURIComponent(candidate)}`)).text();
    assert.ok(page.includes(`name="return_to" value="${candidate}"`));
  }
  for (const candidate of ['//evil.example/work/x', '/\\evil.example/work/x', 'https://evil.example/work/x', '/workshop/not-a-route']) {
    const page = await (await fetch(`${server.workspace_url}settings?return_to=${encodeURIComponent(candidate)}`)).text();
    assert.ok(page.includes('name="return_to" value="/projects"'));
  }
  const token = html.match(/name="csrf" value="([^"]+)"/u)[1];
  const body = new URLSearchParams({ csrf: token, locale: 'zh-CN', action: 'save', selected_theme: 'graphite', text_size: 'large', return_to: returnHref });
  const posted = await fetch(`${server.workspace_url}settings`, { method: 'POST', body, redirect: 'manual' });
  assert.equal(posted.status, 303);
  assert.equal(new URL(posted.headers.get('location'), server.workspace_url).searchParams.get('return_to'), returnHref);
  assert.equal(readUiPreferences(stateDir).locale, 'zh-CN');
  assert.equal(readUiPreferences(stateDir).theme, 'graphite');
  assert.equal(readUiPreferences(stateDir).text_size, 'large');
  await server.close(); server = null;
  server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {} });
  const reopened = await (await fetch(`${server.workspace_url}settings`)).text();
  assert.match(reopened, /lang="zh-CN"/u);
  assert.match(reopened, /保存设置/u);
  assert.match(reopened, /value="zh-CN" selected/u);
  const csrf = reopened.match(/name="csrf" value="([^"]+)"/u)[1];
  const pack = { schema: 'atlas.language-pack.v1', id: 'demo.french', locale: 'fr', name: 'Français', namespace: 'atlas', messages: { 'nav.projects': 'Projets', 'settings.title': '<Langue>' } };
  const post = (action, data = {}) => fetch(`${server.workspace_url}settings`, { method: 'POST', body: new URLSearchParams({ csrf, action, language_pack: JSON.stringify(pack), ...data }), redirect: 'manual' });
  assert.equal((await post('preview_language_pack')).status, 200);
  assert.equal(fs.existsSync(path.join(stateDir, 'ui/languages/demo.french.json')), false);
  assert.equal((await post('install_language_pack', { csrf: 'wrong' })).status, 403);
  assert.equal((await post('install_language_pack')).status, 200);
  assert.equal(readUiPreferences(stateDir).locale, 'zh-CN');
  assert.equal((await post('install_language_pack')).status, 409);
  assert.equal((await post('save', { locale: 'fr' })).status, 303);
  const french = await (await fetch(`${server.workspace_url}settings`)).text();
  assert.match(french, />Projets<\/span>/u);
  assert.match(french, /&lt;Langue&gt;/u);
  assert.doesNotMatch(french, /<Langue>/u);
});
