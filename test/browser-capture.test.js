import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BrowserCapture } from '../src/browser-capture.js';
import { captureBrowserPage } from '../.agents/skills/atlas-file-governance/scripts/capture-browser-page.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'bin', 'atlas.js');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function setup(name) {
  const root = path.join(tempRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return { root, stateDir: path.join(root, 'state') };
}

function writeCapture(root, value) {
  const input = path.join(root, 'browser-capture.json');
  fs.writeFileSync(input, JSON.stringify({ schema: 'atlas-browser-capture.v1', ...value }), 'utf8');
  return input;
}

function chatGptShareHtml(messages) {
  const table = [];
  function reference(value) {
    const index = table.length;
    table.push(null);
    if (Array.isArray(value)) table[index] = value.map(reference);
    else if (value && typeof value === 'object') {
      table[index] = Object.fromEntries(Object.entries(value).map(([key, child]) => [
        `_${reference(key)}`,
        reference(child),
      ]));
    } else table[index] = value;
    return index;
  }
  reference({
    og_title: 'Shared branch',
    backing_conversation_id: 'mother-conversation',
    linear_conversation: messages.map((message, index) => ({
      id: message.id,
      parent: index ? messages[index - 1].id : 'root',
      message: {
        id: message.id,
        author: { role: message.role },
        create_time: message.timestamp,
        content: { content_type: 'text', parts: [message.content] },
      },
    })),
  });
  const payload = JSON.stringify(JSON.stringify(table));
  return `<html><body><script>window.__reactRouterContext.streamController.enqueue(${payload});</script></body></html>`;
}

test('Browser capture localizes selected text into managed Work without returning the body', (t) => {
  const { root, stateDir } = setup('browser-capture-text');
  const input = writeCapture(root, {
    capture_mode: 'selected_text',
    capture_scope: 'user_selection',
    completeness: 'selection_only',
    source_url: 'https://example.com/article',
    title: 'Example article',
    captured_at: '2026-07-27T00:00:00.000Z',
    text: 'First line.  \r\n\r\n\r\n\r\nSecond line.\u200B',
  });
  const capture = new BrowserCapture({ stateDir });
  t.after(() => capture.dispose());
  const receipt = capture.localize({ inputFile: input });
  assert.equal(receipt.status, 'localized');
  assert.equal(receipt.capture_scope, 'user_selection');
  assert.equal(JSON.stringify(receipt).includes('First line'), false);
  const saved = fs.readFileSync(receipt.candidate_path, 'utf8');
  assert.match(saved, /^---\nsource_url: "https:\/\/example.com\/article"/u);
  assert.match(saved, /First line\.\n\n\nSecond line\.\n$/u);
  const sample = capture.sample(receipt.work_id, { startCharacter: 0, characters: 80 });
  assert.equal(sample.excerpt.length <= 80, true);
  assert.equal(sample.has_more, true);
});

test('Browser bridge writes page content locally and returns metadata only', async () => {
  const { stateDir } = setup('browser-capture-bridge');
  fs.mkdirSync(stateDir, { recursive: true });
  const tab = {
    playwright: {
      evaluate: async () => ({
        schema: 'atlas-browser-capture.v1',
        capture_mode: 'page_text',
        capture_scope: 'rendered_document_text',
        completeness: 'not_proven',
        source_url: 'https://example.com/',
        title: 'Example Domain',
        captured_at: '2026-07-27T00:00:00.000Z',
        text: 'This body must not cross the model-visible receipt.',
      }),
    },
  };
  const receipt = await captureBrowserPage({ tab, stateDir, mode: 'page_text' });
  assert.equal(receipt.status, 'captured_locally');
  assert.equal(JSON.stringify(receipt).includes('This body'), false);
  assert.equal(fs.existsSync(receipt.capture_file), true);
  assert.match(fs.readFileSync(receipt.capture_file, 'utf8'), /This body must not cross/u);
});

test('Public HTTP capture localizes static text without browser automation or body output', async (t) => {
  const { stateDir } = setup('public-http-capture');
  const capture = new BrowserCapture({
    stateDir,
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => new Response(
      '<html><head><title>Public page</title><script>hidden()</script></head><body><main><h1>Heading</h1><p>Useful &amp; local.</p></main></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  });
  t.after(() => capture.dispose());
  const receipt = await capture.fetchPublic({ url: 'https://example.com/article' });
  assert.equal(receipt.status, 'localized');
  assert.equal(receipt.network_used, true);
  assert.equal(receipt.browser_used, false);
  assert.equal(receipt.external_application_used, false);
  assert.equal(receipt.model_visible_body_bytes, 0);
  assert.equal(JSON.stringify(receipt).includes('Useful & local'), false);
  const saved = fs.readFileSync(receipt.candidate_path, 'utf8');
  assert.match(saved, /# Public page[\s\S]+Heading[\s\S]+Useful & local\./u);
  assert.doesNotMatch(saved, /hidden\(\)/u);
});

test('Public HTTP capture refuses a hostname that resolves to a private address', async (t) => {
  const { stateDir } = setup('public-http-private-stop');
  const capture = new BrowserCapture({
    stateDir,
    lookupHost: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => {
      throw new Error('fetch must not run');
    },
  });
  t.after(() => capture.dispose());
  await assert.rejects(
    capture.fetchPublic({ url: 'https://internal.example/report' }),
    /private|local|multicast/u,
  );
});

test('Public HTTPS capture accepts a proxy fake-IP hostname and normalizes ChatGPT share messages', async (t) => {
  const { stateDir } = setup('public-http-chatgpt-proxy');
  const capture = new BrowserCapture({
    stateDir,
    lookupHost: async () => [{ address: '198.18.0.11', family: 4 }],
    fetchImpl: async () => new Response(chatGptShareHtml([
      { id: 'm1', role: 'user', timestamp: 1_700_000_000, content: 'Question' },
      { id: 'm2', role: 'assistant', timestamp: 1_700_000_001, content: 'Answer' },
    ]), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  t.after(() => capture.dispose());
  const receipt = await capture.fetchPublic({ url: 'https://chatgpt.com/share/share-one' });
  assert.equal(receipt.resolver_mode, 'https_proxy_fake_ip');
  assert.equal(receipt.capture_mode, 'chatgpt_share');
  assert.equal(receipt.message_count, 2);
  assert.equal(receipt.conversation_id, 'mother-conversation');
  assert.equal(receipt.completeness, 'shared_linear_conversation_complete');
  assert.equal(receipt.model_visible_body_bytes, 0);
  const normalized = fs.readFileSync(receipt.normalized_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(normalized.map((item) => item.message_id), ['m1', 'm2']);
  assert.equal(normalized[1].parent_message_id, 'm1');

  await assert.rejects(
    capture.fetchPublic({ url: 'http://chatgpt.com/share/share-one' }),
    /private|local|multicast/u,
  );
  await assert.rejects(
    capture.fetchPublic({ url: 'https://198.18.0.11/share/share-one' }),
    /private|local|multicast/u,
  );
});

test('Browser capture formats rendered ChatGPT messages and reports only counts and hashes', (t) => {
  const { root, stateDir } = setup('browser-capture-chat');
  const input = writeCapture(root, {
    capture_mode: 'chatgpt_share',
    capture_scope: 'rendered_message_dom',
    completeness: 'not_proven',
    source_url: 'https://chatgpt.com/share/example',
    title: 'Shared conversation',
    messages: [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ],
  });
  const capture = new BrowserCapture({ stateDir });
  t.after(() => capture.dispose());
  const receipt = capture.localize({ inputFile: input });
  assert.equal(receipt.message_count, 2);
  assert.deepEqual(receipt.role_counts, { user: 1, assistant: 1 });
  assert.equal(receipt.completeness, 'not_proven');
  assert.equal(receipt.model_visible_body_bytes, 0);
  assert.equal(receipt.coverage.status, 'unavailable');
  assert.equal(receipt.message_id_generated_count, 2);
  assert.equal(JSON.stringify(receipt).includes('Question'), false);
  assert.match(fs.readFileSync(receipt.candidate_path, 'utf8'), /## 用户\n\nQuestion[\s\S]+## ChatGPT\n\nAnswer/u);
  const normalized = fs.readFileSync(receipt.normalized_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].schema, 'atlas.chat-message.v1');
  assert.equal(normalized[0].conversation_id, 'example');
  assert.match(normalized[0].message_id, /^message-[a-f0-9]{24}$/u);
  assert.equal(normalized[1].role, 'assistant');
});

test('CLI capture localize stays compact and sample enforces a hard character cap', () => {
  const { root, stateDir } = setup('browser-capture-cli');
  const secret = 'private-body-'.repeat(2_000);
  const input = writeCapture(root, {
    capture_mode: 'selected_text',
    title: 'Long local capture',
    text: secret,
  });
  const localizedResult = spawnSync(process.execPath, [
    cliPath, 'capture', 'localize', '--input-file', input, '--json',
  ], {
    cwd: projectRoot,
    env: { ...process.env, ATLAS_STATE_DIR: stateDir },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(localizedResult.status, 0, localizedResult.stderr);
  assert.equal(localizedResult.stdout.includes('private-body'), false);
  assert.equal(Buffer.byteLength(localizedResult.stdout) < 4_096, true);
  const receipt = JSON.parse(localizedResult.stdout).data;
  const sampleResult = spawnSync(process.execPath, [
    cliPath, 'capture', 'sample', receipt.work_id, '--characters', '4001', '--json',
  ], {
    cwd: projectRoot,
    env: { ...process.env, ATLAS_STATE_DIR: stateDir },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(sampleResult.status, 0);
  assert.match(JSON.parse(sampleResult.stdout).error.message, /between 1 and 4000/u);
});
