import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUiPreferences } from '../src/ui/preferences.js';
import { renderSettingsView } from '../src/ui/views/settings-view.js';

test('Settings labels state that successful Save closes the dialog in both bundled languages', () => {
  for (const [locale, label] of [['en', 'Save and close'], ['zh-CN', '保存并退出']]) {
    const html = renderSettingsView({ preferences: normalizeUiPreferences({ locale }), runtime: {} });
    assert.ok(html.includes(`name="action" value="save">${label}</button>`));
  }
});
