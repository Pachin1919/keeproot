import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withStateLock } from '../src/state-lock.js';

test('state lock retries when an incompletely written owner disappears during inspection', (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/state-lock-race-'));
  const lock = path.join(root, 'locks', 'runtime.lock');
  fs.mkdirSync(path.dirname(lock));
  fs.writeFileSync(lock, '{');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const readFile = fs.readFileSync;
  let released = false;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const result = readFile.call(fs, file, ...args);
    if (file === lock && !released) {
      released = true;
      fs.unlinkSync(lock);
    }
    return result;
  });
  let called = 0;
  const result = withStateLock(root, () => { called += 1; return 'acquired'; });
  assert.equal(result, 'acquired');
  assert.equal(called, 1);
  assert.equal(released, true);
  assert.equal(fs.existsSync(lock), false);
});
