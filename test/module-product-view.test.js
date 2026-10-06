import assert from 'node:assert/strict';
import test from 'node:test';
import { renderModuleAvailabilityView } from '../src/ui/views/module-availability-view.js';

const modules = [
  { module_id: 'atlas.table-work', module_version: '1', enabled: true, revision: 2, request_key: 'table-state' },
  { module_id: 'atlas.capture-source', module_version: '1', enabled: false, revision: 1, request_key: 'capture-state' },
];

test('built-in capabilities explain usage, preserve state changes and fold identity/local installation', () => {
  const html = renderModuleAvailabilityView({ modules }, { locale: 'zh-CN', csrfToken: 'csrf' });
  assert.match(html, /<h2>处理表格<\/h2>/u);
  assert.match(html, /<h2>网页与聊天材料<\/h2>/u);
  assert.match(html, /暂停处理会保留已有工作和保存的文件/u);
  assert.match(html, /<details class="module-identity"><summary>/u);
  assert.match(html, /name="expected_revision" value="2"/u);
  assert.match(html, /name="request_key" value="table-state"/u);
  assert.match(html, /name="reason" required/u);
  assert.match(html, /<details class="surface module-local-install"><summary>/u);
  assert.match(html, /action="\/modules\/package-preview"/u);
  assert.doesNotMatch(html, /<h2>atlas.table-work<\/h2>/u);
});

test('package review retains explicit trust/permissions/version confirmation and stays above installation controls', () => {
  const html = renderModuleAvailabilityView({ modules, package_preview: { module_id: 'local.test', module_version: '1', sha256: 'a'.repeat(64), permissions: ['read_input', 'write_output'], token: 'token', revision: 3, request_key: 'install-request' } }, { locale: 'en', csrfToken: 'csrf' });
  assert.match(html, /name="preview_token" value="token"/u);
  assert.match(html, /name="expected_sha256" value="a{64}"/u);
  assert.match(html, /name="expected_revision" value="3"/u);
  assert.match(html, /read_input, write_output/u);
  assert.match(html, /<details class="surface module-local-install" open>/u);
  assert.ok(html.indexOf('data-local-package-preview') < html.indexOf('<details class="surface module-local-install"'));
  assert.match(html, /full account permissions/u);
});
