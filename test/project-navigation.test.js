import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { renderNav } from '../src/ui/components.js';
import { renderSaveResultView } from '../src/ui/views/save-result-view.js';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';
import { renderResourceReaderView } from '../src/ui/views/resource-reader-view.js';

const shell = (html) => html.match(/<aside class="sidebar"[\s\S]*?<\/aside>/u)?.[0] ?? '';

test('navigation has stable global and unavailable Project controls without URL-inferred authority', () => {
  const nav = renderNav('Projects', { interactive: true, resourcesHref: '/projects/untrusted/resources' });
  assert.match(nav, /data-project-context="none"/u);
  assert.match(nav, /Choose Project/u);
  assert.match(nav, /aria-disabled="true"/u);
  assert.doesNotMatch(nav, /href="\/projects\/untrusted/u);
  for (const route of ['/projects', '/activity', '/files', '/settings']) assert.ok(nav.includes(`href="${route}"`));
});

test('Settings is reachable once at the sidebar bottom and Project tools have distinct symbols', () => {
  const nav = renderNav('Resources', { interactive: true, project: { id: 'A', name: 'Alpha' } });
  const groups = [...nav.matchAll(/<nav\b[\s\S]*?<\/nav>/gu)].map(match => match[0]);
  assert.doesNotMatch(groups[0], /data-settings-nav/u);
  assert.match(groups.at(-1), /class="sidebar-settings"/u);
  assert.match(groups.at(-1), /href="\/settings\?project_id=A"[^>]*data-settings-nav/u);
  assert.equal((nav.match(/data-settings-nav/gu) ?? []).length, 1);
  assert.ok(nav.indexOf('sidebar-settings') > nav.indexOf('sidebar-foot'));
  for (const [route, icon] of [['resources', 'resources'], ['boards', 'boards'], ['rules', 'rules']]) {
    const link = nav.match(new RegExp(`<a href="/projects/A/${route}"[\\s\\S]*?</a>`, 'u'))?.[0];
    assert.ok(link, route);
    assert.ok(link.includes(`data-icon="${icon}"`));
  }
});

test('global context is explicit and verified; a Project route owns its context over a conflicting hint', async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'project-navigation-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace); const registry = new Registry({ stateDir });
  let server;
  t.after(async () => { if (server) await server.close(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const projects = ['A <named>', 'B'].map((name, index) => {
    const folder = `Project-${index}`; fs.mkdirSync(path.join(workspace, folder));
    const created = registry.create({ name, currentPath: folder });
    registry.attachRoot(created.project_id, { rootId: adopted.root_id, relativePath: folder, reason: 'Navigation regression.' });
    return { id: created.project_id, name };
  });
  server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, projectRoot: root, installationRoot: root });
  const get = async (route) => { const response = await fetch(`${server.workspace_url}${route}`); assert.equal(response.status, 200); return response.text(); };
  const [a, b] = projects;
  for (const route of ['projects', 'settings', 'activity']) {
    assert.match(shell(await get(route)), /data-project-context="none"/u);
    assert.match(shell(await get(`${route}?project_id=missing`)), /data-project-context="unavailable"/u);
    const hinted = shell(await get(`${route}?project_id=${a.id}`));
    if (route === 'projects') assert.match(hinted, /aria-current="page"><a href="\/projects\?/u);
    assert.ok(hinted.includes(`data-project-context="${a.id}"`)); assert.match(hinted, /A &lt;named&gt;/u);
    assert.ok(hinted.includes(`href="/projects/${a.id}/resources"`));
  }
  const authoritative = shell(await get(`projects/${a.id}?project_id=${b.id}`));
  assert.ok(authoritative.includes(`data-project-context="${a.id}"`));
  assert.ok(!authoritative.includes(`data-project-context="${b.id}"`));
  assert.match(authoritative, /href="\/projects"[^>]*data-project-switch/u);
  assert.doesNotMatch(await get('projects'), /<[a-z][^>]*\bclass=["'][^"']*\bprojects-home-summary\b/iu);
  assert.match(await get(`projects/${a.id}`), /id="saved-results"/u);
  const concurrent = await Promise.all([get(`activity?project_id=${a.id}`), get(`settings?project_id=${b.id}`), get('projects')]);
  assert.ok(shell(concurrent[0]).includes(`data-project-context="${a.id}"`));
  assert.ok(shell(concurrent[1]).includes(`data-project-context="${b.id}"`));
  assert.match(shell(concurrent[2]), /data-project-context="none"/u);
  const settingsHtml = await get(`settings?project_id=${a.id}`);
  assert.ok(settingsHtml.includes(`<form method="post" action="/settings?project_id=${a.id}"`));
  const csrf = settingsHtml.match(/name="csrf" value="([^"]+)"/u)?.[1];
  assert.ok(csrf);
  const savedSettings = await fetch(`${server.workspace_url}settings?project_id=${a.id}`, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ csrf, action: 'save', locale: 'en', return_to: `/projects/${a.id}/resources` }),
  });
  assert.equal(savedSettings.status, 303);
  const savedSettingsUrl = new URL(savedSettings.headers.get('location'), server.workspace_url);
  assert.equal(savedSettingsUrl.searchParams.get('project_id'), a.id);
  assert.equal(savedSettingsUrl.pathname, `/projects/${a.id}/resources`);
  assert.equal(savedSettingsUrl.searchParams.has('return_to'), false);
  assert.ok(shell(await get(savedSettingsUrl.pathname.slice(1) + savedSettingsUrl.search)).includes(`data-project-context="${a.id}"`));
  const globalReturn = await fetch(`${server.workspace_url}settings?project_id=${a.id}`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf, action: 'save', locale: 'en', return_to: `/activity?project_id=${b.id}&filter=local` }),
  });
  const globalReturnUrl = new URL(globalReturn.headers.get('location'), server.workspace_url);
  assert.equal(globalReturn.status, 303); assert.equal(globalReturnUrl.pathname, '/activity');
  assert.equal(globalReturnUrl.searchParams.get('project_id'), a.id); assert.equal(globalReturnUrl.searchParams.get('filter'), 'local');
  registry.evolve(b.id, { status: 'archived', reason: 'Unavailable navigation regression.' });
  assert.match(shell(await get(`settings?project_id=${b.id}`)), /data-project-context="unavailable"/u);
});

test('zero registered Projects leaves the workspace visible and unavailable', async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'navigation-empty-'));
  const registry = new Registry({ stateDir: root });
  const server = await startAtlasUiServer({ stateDir: root, registry, rules: {}, runtime: {}, projectRoot: root, installationRoot: root });
  t.after(async () => { await server.close(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const response = await fetch(`${server.workspace_url}projects`);
  assert.equal(response.status, 200); const nav = shell(await response.text());
  assert.match(nav, /data-project-context="none"/u);
  assert.match(nav, /Choose Project/u);
  assert.equal((nav.match(/aria-disabled="true"/gu) ?? []).length, 5);
});

test('Save context overrides hints and offers the original Work and canonical materials', () => {
  const project = { id: 'A', name: 'Alpha' };
  const html = renderSaveResultView({ save: { save_id: 'SAV-1', status: 'executed', project, source: {}, parameters: { work_session_id: 'DWT-origin' }, resources_href: '/projects/A/resources?folder=Data&resource_id=RES-result', target: { relative_path: 'Data/result.csv' } } }, { project: { id: 'B', name: 'Beta' } });
  assert.match(shell(html), /data-project-context="A"/u);
  assert.match(html, /href="\/work\/DWT-origin"/u);
  assert.match(shell(html), /href="\/projects\/A\/resources"/u);
  assert.match(html, /folder=Data&amp;resource_id=RES-result/u);
});

test('Reader and Work keep their service Project and the exact materials return separate from navigation', () => {
  const project = { id: 'A', name: 'Alpha' }; const options = { project: { id: 'B', name: 'Beta' } };
  const returnHref = '/projects/A/resources?folder=Data&resource_id=RES-source';
  const reader = renderResourceReaderView({ project, returnHref, resources: [], reader: { resource_id: 'RES-source', project_id: 'A', name: 'Source.md', relative_path: 'Data/Source.md', kind: 'markdown', sha256: 'a'.repeat(64), text: '# Source' } }, options);
  assert.match(shell(reader), /data-project-context="A"/u);
  assert.ok(reader.includes(`href="${returnHref.replaceAll('&', '&amp;')}"`));
  assert.match(shell(reader), /href="\/projects\/A\/resources"/u);
  const work = renderDataWorkView({ mode: 'unavailable', project, session: { project_id: 'A' } }, options);
  assert.match(shell(work), /data-project-context="A"/u);
  assert.doesNotMatch(shell(work), /data-project-context="B"/u);
});
