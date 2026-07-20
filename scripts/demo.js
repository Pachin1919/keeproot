import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tracker } from '../src/tracker.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = path.join(projectRoot, '.atlas', 'demo');
const vault = path.join(demoRoot, 'vault');
const stateDir = path.join(demoRoot, 'state');
const source = path.join(projectRoot, 'fixtures', 'demo-vault');

fs.rmSync(demoRoot, { recursive: true, force: true });
fs.mkdirSync(demoRoot, { recursive: true });
fs.cpSync(source, vault, { recursive: true });

const note = path.join(vault, 'note-a.md');
const baseline = fs.readFileSync(note, 'utf8');
const tracker = new Tracker({ stateDir });

try {
  console.log('1. atlas begin');
  const run = tracker.begin({
    root: vault,
    allow: ['note-a.md'],
    intent: 'Atlas V1 first vertical-slice demo',
  });
  console.log(JSON.stringify(run, null, 2));

  console.log('\n2. external file modification');
  fs.appendFileSync(note, 'tracked demo change\n', 'utf8');
  console.log('Appended one line to note-a.md');

  console.log('\n3. atlas close');
  const closeReceipt = tracker.close(run.run_id);
  console.log(JSON.stringify(closeReceipt, null, 2));

  console.log('\n4. atlas show');
  const detail = tracker.show(run.run_id);
  console.log(JSON.stringify({
    run: detail.run,
    changes: detail.changes,
    policy: detail.decisions.at(-1),
    diff: detail.change_set.diff_text,
  }, null, 2));

  console.log('\n5. atlas rollback');
  const rollbackReceipt = tracker.rollback(run.run_id);
  console.log(JSON.stringify(rollbackReceipt, null, 2));

  assert.equal(fs.readFileSync(note, 'utf8'), baseline);
  console.log('\nDemo verified: note-a.md matches its original baseline.');
} finally {
  tracker.dispose();
}
