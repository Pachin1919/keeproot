import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { renderNav } from '../src/ui/components.js';
import { translateModuleUi, translateUi } from '../src/ui/i18n.js';
import { renderProjectHomeView } from '../src/ui/views/project-home-view.js';
import { renderResourceReaderView } from '../src/ui/views/resource-reader-view.js';
import { renderSettingsView } from '../src/ui/views/settings-view.js';
import { normalizeUiPreferences } from '../src/ui/preferences.js';

test('display branding preserves Atlas technical routes, user names and escaped document titles', () => {
  const project = { id: 'PRJ-Atlas-source', name: 'Atlas <Project>', folder_available: true };
  const resourcesHref = `/projects/${project.id}/resources`;
  const nav = renderNav('Resources', { interactive: true, project, resourcesHref, settingsHref: '/settings' });
  assert.match(nav, /class="brand-mark"><svg class="product-mark"[^>]*role="img" aria-label="Keeproot"/u);
  assert.match(nav, /class="brand-copy">Keeproot<small>/u);
  assert.ok(nav.includes(`href="${resourcesHref}"`));
  const home = renderProjectHomeView({ project, resources: [], recent_work: [], saved_results: [] }, { locale: 'en' });
  assert.match(home, /<title>Atlas &lt;Project&gt; · Keeproot<\/title>/u);
  assert.match(home, /Atlas &lt;Project&gt;/u);
  const reader = renderResourceReaderView({ project, returnHref: resourcesHref, resources: [], reader: { resource_id: 'RES-Atlas-source', project_id: project.id, name: 'Atlas notes.md', relative_path: 'Atlas notes.md', kind: 'markdown', sha256: 'a'.repeat(64), text: '# Atlas paper\n\nKeep the author name Atlas.' } }, { locale: 'en' });
  assert.match(reader, /<title>Atlas notes.md · Keeproot<\/title>/u);
  assert.match(reader, /Keep the author name Atlas\./u);
  assert.match(reader, /RES-Atlas-source/u);
  assert.equal(PROTOCOL_VERSION, 'atlas-cli.v1');
});

test('only owned default UI copy is branded; authored language packs and Module namespaces are preserved', () => {
  assert.equal(translateUi('en', 'settings.atlas_version'), 'Keeproot version');
  assert.equal(translateUi('zh-CN', 'settings.atlas_version'), 'Keeproot 版本');
  const catalog = { packs: [{ locale: 'en', namespace: 'atlas', messages: { 'nav.projects': 'Atlas custom label' } }] };
  assert.equal(translateUi('en', 'nav.projects', catalog), 'Atlas custom label');
  assert.equal(translateModuleUi('en', 'local.example', 'help', null, { help: 'Atlas authored help' }), 'Atlas authored help');
});

test('served Projects and Settings share the display name without changing installation diagnostics or preference schema', async (t) => {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const stateDir = fs.mkdtempSync(path.resolve('test/.tmp/ui-brand-'));
  const registry = new Registry({ stateDir });
  let server;
  t.after(async () => { if (server) await server.close(); registry.dispose(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: { atlas_version: '1.9.0-rc.1', installed_build: 'a'.repeat(64) } });
  const projects = await (await fetch(`${server.workspace_url}projects`)).text();
  assert.match(projects, /<title>Keeproot Projects<\/title>/u);
  const settings = await (await fetch(`${server.workspace_url}settings`)).text();
  assert.match(settings, /<title>Keeproot Settings<\/title>/u);
  assert.match(settings, /Keeproot version 1\.9\.0-rc\.1/u);
  assert.match(settings, /Source working tree/u);
  assert.doesNotMatch(settings, /aaaaaaaaaaaa/u, 'server reads installation provenance instead of trusting an injected build');
  const installedLabel = renderSettingsView({ preferences: normalizeUiPreferences({}), runtime: { atlas_version: '1.9.0-rc.1', installed_build: 'a'.repeat(64) } });
  assert.match(installedLabel, /Keeproot version 1\.9\.0-rc\.1/u);
  assert.match(installedLabel, /aaaaaaaaaaaa/u);
  assert.match(settings, /name="reading_font"/u);
  assert.match(settings, /method="post" action="\/settings"/u);
});

test('owned signature and paper assets remain available through the shared UI consumer', async (t) => {
  const stateDir = fs.mkdtempSync(path.resolve('test/.tmp/ui-art-'));
  const registry = new Registry({ stateDir });
  const server = await startAtlasUiServer({ stateDir, registry, rules: {} });
  t.after(async () => { await server.close(); registry.dispose(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const page = await (await fetch(`${server.workspace_url}projects`)).text();
  for (const name of ['pachin-calligraphy.png', 'pachin-seal.png', 'atlas-paper-texture.png']) {
    assert.ok(page.includes(`/ui/${name}`), `shared chrome references ${name}`);
    const response = await fetch(`${server.workspace_url}ui/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/png/u);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.resolve('src/ui/assets', name)));
  }
});
