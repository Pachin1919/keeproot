import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { normalizeUiPreferences, preferenceHtmlAttributes } from '../src/ui/preferences.js';
import { renderSettingsView } from '../src/ui/views/settings-view.js';
import { renderNav } from '../src/ui/components.js';

test('application scale is a bounded integer; legacy preferences and CSS strings remain deterministic', () => {
  assert.equal(normalizeUiPreferences({}).ui_scale, 100);
  for (const [input, expected] of [[20, 85], [160, 125], ['110', 110], [119, 119], ['110px', 100], ['125%;color:red', 100], [100.5, 100], [null, 100]]) {
    const preferences = normalizeUiPreferences({ ui_scale: input }); assert.equal(preferences.ui_scale, expected);
    assert.ok(preferenceHtmlAttributes(preferences).includes(`data-ui-scale="${expected}"`));
  }
  const html = renderSettingsView({ preferences: normalizeUiPreferences({ ui_scale: 110 }), runtime: {} }, { returnHref: '/projects' });
  assert.match(html, /select name="ui_scale"[\s\S]*?value="85"[\s\S]*?value="100"[\s\S]*?value="110" selected[\s\S]*?value="125"/u);
  assert.match(html, /Status examples/u); assert.match(html, /Appearance and actions/u);
  const nav = renderNav('Projects', { interactive: true });
  assert.match(nav, /<svg class="product-mark"[^>]*role="img" aria-label="Keeproot"/u);
  assert.match(nav, /pachin-calligraphy\.png/u);
});

async function serverFixture(t, extra = {}) {
  fs.mkdirSync('test/.tmp', { recursive: true }); const stateDir = fs.mkdtempSync(path.resolve('test/.tmp/ui-feedback-'));
  const registry = new Registry({ stateDir });
  const server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, ...extra });
  t.after(async () => { await server.close(); registry.dispose(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const page = await (await fetch(`${server.workspace_url}settings`)).text(); const csrf = page.match(/name="csrf" value="([^"]+)"/u)[1];
  return { server, csrf };
}

test('Settings save exits to the exact local page and refuses external return destinations', { timeout: 30_000 }, async t => {
  const { server, csrf } = await serverFixture(t);
  for (const [returnHref, expected] of [['/work/DWT-existing/saved?work_id=SAV-existing', '/work/DWT-existing/saved?work_id=SAV-existing'], ['https://evil.test/path', '/projects'], ['//evil.test/path', '/projects']]) {
    const response = await fetch(`${server.workspace_url}settings`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf, action: 'save', locale: 'en', return_to: returnHref, ui_scale: '125' }) });
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), expected);
  }
});

test('failed Settings write remains in the dialog with the draft and original return', { timeout: 30_000 }, async t => {
  const { server, csrf } = await serverFixture(t, { writeUiPreferencesFn: () => { throw new Error('Simulated preference write failure'); } });
  const response = await fetch(`${server.workspace_url}settings`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf, action: 'save', locale: 'en', return_to: '/projects?filter=local', ui_scale: '125' }) });
  assert.equal(response.status, 409); assert.equal(response.headers.get('location'), null);
  const html = await response.text(); assert.match(html, /Simulated preference write failure/u);
  assert.match(html, /value="125" selected/u); assert.match(html, /data-overlay-return-href="\/projects\?filter=local"/u);
});

test('Settings preview scales immediately and discard restores the original attributes', () => {
  const source = fs.readFileSync('src/ui/client.js', 'utf8');
  const code = source.slice(source.indexOf('const settingsForm ='), source.indexOf("document.addEventListener('submit'", source.indexOf('const settingsForm =')));
  const events = new Map(); const dataset = { uiScale: '100', textSize: 'comfortable', theme: 'slate' }; const styles = new Map([['--ui-scale', '1']]);
  const root = { dataset, style: { getPropertyValue: key => styles.get(key) ?? '', setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) } };
  const form = { querySelector: () => null, addEventListener: (name, handler) => events.set(name, handler) };
  class Select { constructor(name, value) { this.name = name; this.value = value; } }
  const context = { document: { documentElement: root, querySelector: () => form }, HTMLSelectElement: Select, HTMLInputElement: class {}, storageRemove() {} };
  vm.createContext(context); vm.runInContext(code, context);
  events.get('change')({ target: new Select('ui_scale', '125') }); assert.equal(styles.get('--ui-scale'), '1.25'); assert.equal(dataset.uiScale, '125');
  events.get('change')({ target: new Select('text_size', 'large') }); assert.equal(dataset.textSize, 'large');
  vm.runInContext('restoreSettingsPreview()', context); assert.equal(dataset.uiScale, '100'); assert.equal(dataset.textSize, 'comfortable'); assert.equal(styles.get('--ui-scale'), '1');
});

test('existing format picker replaces the known Save suffix instead of duplicating it', () => {
  const source = fs.readFileSync('src/ui/client.js', 'utf8');
  const start = source.indexOf("document.querySelectorAll('[data-project-folder-form]')");
  const code = source.slice(start, source.indexOf('const settingsForm =', start));
  const handlers = new Map(); const file = { value: 'work-result.xlsx', addEventListener() {} }; const format = { value: 'csv' };
  const form = { dataset: {}, querySelector: selector => selector === 'input[name="file_name"]' ? file : selector === 'select[name="format"]' ? format : null, querySelectorAll: () => [], addEventListener: (name, handler) => handlers.set(name, handler) };
  vm.runInNewContext(code, { document: { querySelectorAll: () => [form] }, HTMLInputElement: class {}, clientText: (key, fallback) => fallback });
  handlers.get('change')({ target: format }); assert.equal(file.value, 'work-result.csv');
  format.value = 'xlsx'; handlers.get('change')({ target: format }); assert.equal(file.value, 'work-result.xlsx');
  file.value = 'analysis.v2'; format.value = 'csv'; handlers.get('change')({ target: format }); assert.equal(file.value, 'analysis.v2.csv');
});
