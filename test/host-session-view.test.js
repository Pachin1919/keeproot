import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderHostSessionStart, renderHostSessionView } from '../src/ui/views/host-session-view.js';
import { renderHandoffView } from '../src/ui/views/handoff-view.js';

const project = { id: 'PRJ-A', name: 'Named <Project>' };
const handoff = { handoff_id: 'HOF-A', work_id: 'DWT-A', status: 'current', work_revision: 4, digest: 'a'.repeat(64), goal: 'Continue selected work', package: {} };
const model = { project, handoff, base: '/projects/PRJ-A', host_request_key: 'UI-HOST-fixture' };
const session = { session_id: 'HSE-00000000-0000-4000-8000-000000000001', project_id: project.id, handoff_id: handoff.handoff_id, revision: 2, status: 'running', thread_id: 'recorded-thread', turn_id: 'recorded-turn', result_available: false, last_sequence: 1, pending_permission: null, error: null };

test('default-off Handoff explains actual account access and retains the external command without start form', () => {
  for (const locale of ['en', 'zh-CN']) {
    const html = renderHandoffView(model, { locale });
    assert.doesNotMatch(html.slice(html.indexOf('<main')), /<form/u);
    assert.match(html, /atlas handoff read HOF-A --project PRJ-A --json/u);
    assert.ok(html.includes(locale === 'en' ? 'do not confine reads' : '不能将读取范围限定'));
    assert.ok(html.includes(locale === 'en' ? 'not enabled' : '尚未启用'));
    assert.ok(html.includes(locale === 'en' ? 'not a saved file' : '并非已保存文件'));
  }
});

test('only explicitly enabled current Handoff gets an exact reviewed start form', () => {
  const options = { csrfToken: 'csrf', locale: 'en' };
  const html = renderHostSessionStart({ ...model, host_availability: { enabled: true } }, options);
  assert.match(html, /action="\/projects\/PRJ-A\/host-sessions"/u);
  assert.match(html, /name="expected_digest" value="a{64}"/u);
  assert.match(html, /name="expected_work_revision" value="4"/u);
  assert.match(html, /textarea name="prompt"[^>]*required/u);
  assert.doesNotMatch(html, /name="(?:executable|config|thread_id|policy)"/u);
  for (const status of ['stale', 'blocked']) {
    assert.doesNotMatch(renderHostSessionStart({ ...model, handoff: { ...handoff, status }, host_availability: { enabled: true } }, options), /<form/u);
  }
});

test('stream and permission text is escaped; denial is the only permission decision', () => {
  const html = renderHostSessionView({ project, session: { ...session, status: 'awaiting_permission', pending_permission: { request_id: 'rpc-<A>', method: 'command', description: '<img src=x>', expires_at: '2026-10-08T08:00:00Z' } }, events: [{ sequence: 1, kind: 'message', text: '<script>source</script>' }] }, { locale: 'zh-CN', csrfToken: 'csrf', project: { id: 'PRJ-B', name: 'Wrong' } });
  assert.match(html, /data-project-context="PRJ-A"/u);
  assert.match(html, /&lt;script&gt;source&lt;\/script&gt;/u);
  assert.match(html, /&lt;img src=x&gt;/u);
  assert.doesNotMatch(html, /<script>source|<img src=x|\/approve|\/grant/u);
  assert.match(html, /name="request_id" value="rpc-&lt;A&gt;"/u);
  assert.match(html, /name="expected_revision" value="2"/u);
  assert.match(html, /权限请求会|请求会自动过期/u);
  assert.match(html, /并非已保存文件/u);
});

test('disconnected session offers explicit reconnect; completion never becomes an Atlas Save', () => {
  const disconnected = renderHostSessionView({ project, session: { ...session, status: 'disconnected' }, events: [] }, { locale: 'en' });
  assert.match(disconnected, /data-host-reconnect>/u);
  assert.match(disconnected, /does not resend an uncertain turn/u);
  const done = renderHostSessionView({ project, session: { ...session, status: 'completed', result_available: true }, events: [{ sequence: 1, kind: 'message', text: 'Response' }] }, { locale: 'en' });
  assert.match(done, /Response completed/u);
  assert.match(done, /Response available/u);
  assert.match(done, /data-host-cancel hidden/u);
  assert.doesNotMatch(done, /action="[^" ]*(?:\/saves\/|\/execute|\/save\/)/u);
});

test('assistant reply joins known chunks while implementation events stay inside closed details', () => {
  const html = renderHostSessionView({ project, session, events: [
    { sequence: 1, kind: 'status', text: 'technical-initialization' },
    { sequence: 2, kind: 'message', item_id: 'reply', text: 'First ' },
    { sequence: 3, kind: 'message', item_id: 'reply', text: 'second' },
  ] }, { locale: 'en' });
  const foreground = html.slice(html.indexOf('class="surface host-session-response"'), html.indexOf('<details class="surface host-session-identity"'));
  assert.match(foreground, /First second/u); assert.doesNotMatch(foreground, /technical-initialization/u);
  assert.match(html.slice(html.indexOf('<details class="surface host-session-identity"')), /technical-initialization/u);
  assert.doesNotMatch(html, /<details class="surface host-session-identity" open/u);
});

test('simulated browser poll inserts streamed text literally and drains terminal event pages', { timeout: 30_000 }, async () => {
  const source = fs.readFileSync('src/ui/client.js', 'utf8');
  const polling = source.slice(source.indexOf('// Read-only event polling'));
  assert.ok(polling.startsWith('// Read-only event polling'));
  const timers = new Map(); let timerId = 0; const reads = [];
  const list = { children: [], append(item) { this.children.push(item); } };
  const nodes = new Map([['[data-host-events]', list]]);
  const surface = { dataset: { hostSession: session.session_id, hostProject: project.id, hostEventsUrl: '/projects/PRJ-A/host-sessions/HSE-fixture/events', hostSequence: '0', hostLastSequence: '0', hostStatus: 'running', hostMessages: JSON.stringify({ completed: 'Complete', result: 'Available', result_pending: 'Pending', poll_failed: 'Interrupted' }) }, querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); }, querySelectorAll() { return []; } };
  const document = { querySelector: () => surface, createElement: () => ({ dataset: {}, children: [], textContent: '', append(child) { this.children.push(child); } }) };
  const window = { location: { href: 'http://atlas.local/session', origin: 'http://atlas.local' }, setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); }, addEventListener() {} };
  const fetch = async href => {
    reads.push(href); const sequence = reads.length;
    return { ok: true, json: async () => ({ ok: true, result: { session: { ...session, status: 'completed', last_sequence: 2, result_available: true }, last_sequence: sequence, events: [{ sequence, kind: 'message', item_id: 'one-response', text: sequence === 1 ? '<script>literal</script>' : 'Final text' }] } }) };
  };
  vm.runInNewContext(polling, { document, window, fetch, URL, AbortController, Set, Number, String, JSON });
  const nextPoll = async () => { const entry = [...timers].find(([, timer]) => timer.delay === 1000); assert.ok(entry); timers.delete(entry[0]); await entry[1].fn(); };
  await nextPoll(); assert.equal(list.children[0].children[0].textContent, '<script>literal</script>');
  await nextPoll(); assert.equal(list.children.length, 1); assert.equal(list.children[0].children[0].textContent, '<script>literal</script>Final text');
  assert.match(reads[1], /after_sequence=1/u);
  assert.equal([...timers.values()].filter(timer => timer.delay === 1000).length, 0);
  assert.equal(nodes.get('[data-host-result-label]').textContent, 'Available');
});
