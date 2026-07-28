import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildCompleteDiff } from '../src/diff.js';

test('text diff shows a local unified hunk instead of replacing the whole file', () => {
  const root = path.resolve('test', '.tmp', 'diff-local-hunk');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const beforePath = path.join(root, 'before.txt');
  const afterPath = path.join(root, 'after.txt');
  const before = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
  const after = [...before];
  after.splice(7, 1, 'changed line 8', 'inserted after 8');
  fs.writeFileSync(beforePath, `${before.join('\n')}\n`, 'utf8');
  fs.writeFileSync(afterPath, `${after.join('\n')}\n`, 'utf8');

  const result = buildCompleteDiff([{
    path: 'note.txt',
    before: { blobPath: beforePath, contentHash: 'before' },
    after: { blobPath: afterPath, contentHash: 'after' },
  }]);

  assert.match(result.diffText, /@@ -5,7 \+5,8 @@/u);
  assert.match(result.diffText, /\n-line 8\n\+changed line 8\n\+inserted after 8\n/u);
  assert.ok(!result.diffText.includes('\n-line 1\n'));
  assert.ok(!result.diffText.includes('\n+line 14\n'));
});
