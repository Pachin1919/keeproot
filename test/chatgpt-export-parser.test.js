import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspectChatGptExport, selectChatGptExportConversation, normalizeChatGptConversation } from '../src/chatgpt-export-capture.js';

function fixture(t, body) {
  const tempRoot = path.resolve('test/.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempRoot, 'chatgpt-export-parser-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'conversations.json');
  fs.writeFileSync(inputPath, body, 'utf8');
  return inputPath;
}

test('selected export rejects duplicate JSON keys before assigning source identity', (t) => {
  const inputPath = fixture(t, '[{"conversation_id":"first","conversation_id":"second","title":"x","mapping":{}}]');
  const inspected = inspectChatGptExport({ inputPath });
  assert.throws(() => selectChatGptExportConversation({
    inputPath, expectedInputSha256: inspected.input_revision.sha256, selection: inspected.items[0].selection,
  }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('export rejects JSON nesting beyond the frozen 128 level limit', (t) => {
  const nested = '{"x":'.repeat(129) + '0' + '}'.repeat(129);
  const inputPath = fixture(t, `[${nested}]`);
  assert.throws(() => inspectChatGptExport({ inputPath }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('export rejects a cyclic parent graph instead of calling it complete', () => {
  const conversation = {
    conversation_id: 'cycle', current_node: 'a', mapping: {
      a: { id: 'a', parent: 'b', children: ['b'], message: null },
      b: { id: 'b', parent: 'a', children: ['a'], message: null },
    },
  };
  assert.throws(() => normalizeChatGptConversation(conversation), { code: 'ATLAS_STATE_CONFLICT' });
});
