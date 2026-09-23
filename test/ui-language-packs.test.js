import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as languagePacks from '../src/ui/language-packs.js';
import { translateModuleUi, translateUi } from '../src/ui/i18n.js';
import { normalizeUiPreferences } from '../src/ui/preferences.js';
import { renderSettingsView } from '../src/ui/views/settings-view.js';

function pack(overrides = {}) {
  return {
    schema: 'atlas.language-pack.v1',
    id: 'example.french',
    locale: 'fr',
    name: 'Français',
    namespace: 'atlas',
    messages: { 'nav.projects': 'Projets' },
    ...overrides,
  };
}

function stateFixture(t) {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const stateDir = fs.mkdtempSync(path.resolve('test/.tmp/ui-language-packs-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test('language pack installation API is available', () => {
  assert.equal(typeof languagePacks.installLanguagePack, 'function');
});

test('installs isolated atlas and module packs with English fallbacks', (t) => {
  const stateDir = stateFixture(t);
  const atlas = languagePacks.installLanguagePack(stateDir, pack());
  const modulePack = languagePacks.installLanguagePack(stateDir, pack({
    id: 'example.module', namespace: 'module.example', messages: { 'tool.label': 'Outil' },
  }));
  assert.equal(atlas.file, 'example.french.json');
  assert.equal(modulePack.file, 'example.module.json');
  const catalog = languagePacks.loadLanguageCatalog(stateDir);
  assert.equal(catalog.errors.length, 0);
  assert.equal(catalog.packs.length, 2);
  assert.equal(translateUi('fr', 'nav.projects', catalog), 'Projets');
  assert.equal(translateUi('fr', 'nav.settings', catalog), 'Settings');
  assert.equal(translateModuleUi('fr', 'module.example', 'tool.label', catalog, { 'tool.label': 'Tool' }), 'Outil');
  assert.equal(translateModuleUi('fr', 'module.example', 'missing.label', catalog, { 'missing.label': 'Missing' }), 'Missing');
  assert.throws(() => translateModuleUi('fr', 'atlas', 'nav.projects', catalog), /non-atlas namespace/u);
});

test('rejects invalid JSON-shaped packs before installation', () => {
  assert.throws(() => languagePacks.inspectLanguagePack(pack({ extra: 'no' })), /unknown metadata/u);
  const polluted = JSON.parse('{"schema":"atlas.language-pack.v1","id":"example.polluted","locale":"fr","name":"François","namespace":"atlas","messages":{"__proto__":"bad"}}');
  assert.throws(() => languagePacks.inspectLanguagePack(polluted), /message key/u);
  const oversized = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`nav.item${index}`, 'x'.repeat(1500)]));
  assert.throws(() => languagePacks.inspectLanguagePack(pack({ messages: oversized })), /serialize/u);
});

test('duplicate ids and message conflicts leave installed files unchanged', (t) => {
  const stateDir = stateFixture(t);
  languagePacks.installLanguagePack(stateDir, pack());
  const filePath = path.join(stateDir, 'ui', 'languages', 'example.french.json');
  const original = fs.readFileSync(filePath, 'utf8');
  assert.throws(() => languagePacks.installLanguagePack(stateDir, pack({ name: 'Changed' })), /already installed/u);
  assert.throws(() => languagePacks.installLanguagePack(stateDir, pack({ id: 'example.other' })), /conflicts/u);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  assert.equal(languagePacks.loadLanguageCatalog(stateDir).packs.length, 1);
});

test('rejects a language directory junction and keeps states isolated', (t) => {
  const linkedState = stateFixture(t);
  const separateState = stateFixture(t);
  const outside = fs.mkdtempSync(path.resolve('test/.tmp/ui-language-packs-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(linkedState, 'ui'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(linkedState, 'ui', 'languages'), 'junction');
  } catch (error) {
    t.skip(`junction fixture is unavailable: ${error.code ?? error.message}`);
    return;
  }
  assert.throws(() => languagePacks.installLanguagePack(linkedState, pack()), /symbolic link or junction/u);
  languagePacks.installLanguagePack(separateState, pack({ id: 'example.separate' }));
  assert.equal(languagePacks.loadLanguageCatalog(linkedState).packs.length, 0);
  assert.equal(languagePacks.loadLanguageCatalog(separateState).packs.length, 1);
});

test('settings retains the saved locale and does not call a module-only locale English', () => {
  const moduleOnlyCatalog = { packs: [pack({ id: 'example.module-only', namespace: 'module.example', messages: { 'tool.label': 'Outil' } })], errors: [] };
  const french = renderSettingsView({ preferences: normalizeUiPreferences({ locale: 'fr' }), runtime: {} }, { languageCatalog: moduleOnlyCatalog });
  assert.match(french, /<option value="fr" selected>fr<\/option>/u);
  assert.doesNotMatch(french, /<option value="fr" selected>English<\/option>/u);
  const missingCatalog = renderSettingsView({ preferences: normalizeUiPreferences({ locale: 'de' }), runtime: {} }, { languageCatalog: { packs: [], errors: [] } });
  assert.match(missingCatalog, /<option value="de" selected>de<\/option>/u);
});
