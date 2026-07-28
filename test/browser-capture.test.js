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
  assert.equal(JSON.stringify(receipt).includes('Question'), false);
  assert.match(fs.readFileSync(receipt.candidate_path, 'utf8'), /## 用户\n\nQuestion[\s\S]+## ChatGPT\n\nAnswer/u);
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
