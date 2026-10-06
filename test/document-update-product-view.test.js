import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDocumentUpdateView } from '../src/ui/views/document-update-view.js';

const model = () => ({ project: {id: 'PRJ-review', name: '项目'}, update: {
  update_id: 'UPD-review', resource_id: 'RES-review', resource: {relative_path: '笔记.md'},
  status: 'preview_ready', revision: 3, baseline: {text: '旧文', sha256: 'a'.repeat(64)},
  proposed: {text: '初始建议', sha256: 'b'.repeat(64)}, current: {text: '旧文', sha256: 'a'.repeat(64)},
  source: {save_id: 'SAV-source', version_id: 'VER-source'},
  change: {kind: 'replace', old_text: '旧文', suggested_text: '初始建议', confirmed_text: '<script>修订建议</script>'},
  decision: {kind: 'revise'}, candidate: {text: '修订建议', sha256: 'c'.repeat(64)},
}});

test('source selection uses named versions, requires a choice and preserves a refused draft', () => {
  const input = {project: {id: 'PRJ-review'}, resource_id: 'RES-review', inspect: {baseline: {text: '旧文', sha256: 'a'.repeat(64)}},
    source_options: [{save_id: 'SAV-source', name: '<来源>.md', version_id: 'VER-12345678', saved_at: '2026-10-06T00:00:00Z', href: '/projects/PRJ-review/capture-source/SAV-source'}]};
  let page = renderDocumentUpdateView(input, {csrfToken: 'token', locale: 'zh-CN'});
  assert.match(page, /<select name="source_save_id" required><option value="" selected/u);
  assert.match(page, /&lt;来源&gt;.md · 2026-10-06 · 12345678/u);
  assert.doesNotMatch(page, /<input name="source_save_id"/u);
  input.draft = {source_save_id: 'SAV-gone', old_text: '旧块', new_text: '</textarea><script>正文</script>'};
  page = renderDocumentUpdateView(input, {locale: 'zh-CN'});
  assert.match(page, /原选择已不可用/u);
  assert.match(page, /&lt;\/textarea&gt;&lt;script&gt;正文&lt;\/script&gt;/u);
  assert.doesNotMatch(page, /value="SAV-source" selected/u);
  input.source_options = [];
  page = renderDocumentUpdateView(input, {locale: 'zh-CN'});
  assert.match(page, /请先将网页或分享来源保存/u);
  assert.match(page, /type="submit" disabled/u);
});

test('review forms retain guards, distinct retry keys and the same Resource reader return', () => {
  const page = renderDocumentUpdateView(model(), {csrfToken: 'token', locale: 'zh-CN'});
  const forms = [...page.matchAll(/<form\b[^>]*action="[^"]*\/document-updates\/[^"]+"[^>]*>([\s\S]*?)<\/form>/gu)].map(match => match[1]);
  assert.equal(forms.length, 2);
  for (const form of forms) {
    assert.match(form, /name="csrf" value="token"/u);
    assert.match(form, /name="expected_revision" value="3"/u);
    assert.match(form, /name="expected_current_sha256" value="a{64}"/u);
  }
  const keys = forms.map(form => form.match(/name="request_key"[^>]*value="([^"]+)"/u)[1]);
  assert.equal(new Set(keys).size, 2);
  assert.ok(keys.every(key => /^ui-update-[a-f0-9-]{36}$/u.test(key)));
  const href = page.match(/href="([^"]*resources\/read\?[^"]+)"/u)[1].replaceAll('&amp;', '&');
  const url = new URL(href, 'http://atlas.local');
  assert.equal(url.searchParams.get('resource_id'), 'RES-review');
  assert.equal(url.searchParams.get('return_to'), '/projects/PRJ-review/resources?resource_id=RES-review');
  const block = page.match(/data-document-change>([\s\S]*?)<\/section>/u)[1];
  assert.match(block, /&lt;script&gt;修订建议&lt;\/script&gt;/u);
  assert.doesNotMatch(block, /初始建议|<script>/u);
});

test('conflict and pending recovery stay visible, never expose an apply form', () => {
  const input = model(); input.update.status = 'conflict'; input.update.conflict = {reason: '后改'};
  let page = renderDocumentUpdateView(input);
  assert.match(page, /role="alert"[^>]*>[^<]*后改/u);
  assert.match(page, /document-versions" open/u);
  assert.match(page, /value="accept-suggestion" disabled/u);
  assert.doesNotMatch(page, /action="[^"]*\/execute"/u);
  input.update.pending = {phase: 'interrupted'}; input.update.status = 'pending_recovery';
  page = renderDocumentUpdateView(input);
  assert.match(page, /action="[^"]*\/recover"/u);
  assert.doesNotMatch(page, /action="[^"]*\/(execute|decide)"/u);
});
