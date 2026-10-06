import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { compareContent } from '../src/content-inspection.js';

const projectRoot = path.resolve('.');
function fixture(t) {
  fs.mkdirSync(path.resolve('test/.tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve('test/.tmp/comparison-details-'));
  const stateDir = path.join(root, 'state');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, text) => { const target = path.join(root, name); fs.writeFileSync(target, text); return target; };
  const compare = (leftPath, rightPath, options = {}) => compareContent({ stateDir, projectRoot, leftPath, rightPath, details: true, ...options });
  return { root, stateDir, put, compare };
}

test('Host --details returns bounded Chinese paragraph differences', (t) => {
  const f = fixture(t); const left = f.put('旧.md', '共同\n\n旧段\n'); const right = f.put('新.md', '共同\n\n新段\n');
  const done = spawnSync(process.execPath, ['bin/atlas.js', 'content', 'compare', '--left', left, '--right', right, '--details', '--json'],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, ATLAS_STATE_DIR: f.stateDir } });
  assert.equal(done.status, 0, done.stderr);
  const result = JSON.parse(done.stdout).data;
  assert.equal(result.details.kind, 'text_blocks');
  assert.equal(result.details.summary.changed, 1);
  assert.ok(result.details.entries.some(entry => entry.before === '旧段\n' && entry.after === '新段\n'));
});

test('text details preserve whitespace, report insert/delete/replace/repetition and keep equal files distinct', (t) => {
  const f = fixture(t);
  const left = f.put('left.txt', '共同\n\n删除\n\n锚点\n\n旧\n\n重复\n\n重复\n\n');
  const right = f.put('right.txt', '共同\n\n锚点\n\n新\n\n重复\n\n重复\n\n新增\n\n');
  const result = f.compare(left, right);
  assert.deepEqual(['added', 'removed', 'changed', 'unchanged', 'repeated'].map(key => result.details.summary[key]), [1, 1, 1, 4, 1]);
  assert.ok(result.details.entries.some(e => e.type === 'repeated' && e.left_count === 2 && e.right_count === 2));
  const whitespace = f.compare(f.put('space-a.md', '中文\n\n'), f.put('space-b.md', '中文 \n\n'));
  assert.equal(whitespace.details.byte_equal, false); assert.equal(whitespace.details.summary.changed, 1);
  const copy = f.put('copy.txt', fs.readFileSync(left)); const equal = f.compare(left, copy);
  assert.equal(equal.identity.same_content, true); assert.equal(equal.identity.same_path, false); assert.equal(equal.identity.merge_performed, false);
  assert.notEqual(equal.sources.left.path, equal.sources.right.path);
  assert.throws(() => f.compare(left, right, { keyColumn: 'ID' }), /CSV\/TSV/u);
  assert.throws(() => f.compare(f.put('bad.txt', Buffer.from([0xff])), right));
});

test('CSV/TSV explicit key plus literal period handles reordered fields and separates three time sources', (t) => {
  const f = fixture(t);
  const left = f.put('old.csv', '线路,期间,值,日期\nA,2020-01,10,2020-01-01\nA,2020-02,20,2020-02-01\nB,2020-01,30,2020-01-02\nC,2020-01,40,2020-01-03\n');
  const right = f.put('new.tsv', '日期\t值\t期间\t线路\n2020-01-01\t11\t2020-01\tA\n2020-02-01\t22\t2020-02\tA\n2020-01-03\t40\t2020-01\tC\n2020-03-01\t50\t2020-03\tD\n');
  const options = { keyColumn: '线路', periodColumn: '期间', eventDateColumn: '日期' };
  const result = f.compare(left, right, options); const d = result.details;
  assert.equal(d.status, 'available'); assert.deepEqual(['added', 'removed', 'changed', 'unchanged'].map(k => d.summary[k]), [1, 1, 2, 1]);
  assert.ok(d.entries.some(e => e.type === 'changed' && e.key[0] === 'A' && e.key[1] === '2020-02' && e.before['值'] === '20' && e.after['值'] === '22'));
  assert.equal(d.time_sources.event_dates.left.start, '2020-01-01'); assert.equal(d.time_sources.event_dates.right.end, '2020-03-01');
  assert.notEqual(d.time_sources.file_modified.left.slice(0, 10), d.time_sources.event_dates.left.start);
  assert.deepEqual(d.time_sources.business_period.right_values, ['2020-01', '2020-02', '2020-03']);
  const noPeriod = f.compare(left, right, { keyColumn: '线路' });
  assert.equal(noPeriod.details.status, 'uncertain'); assert.equal(noPeriod.details.summary.left_duplicate_keys, 1);
  assert.equal(noPeriod.details.summary.left_duplicate_key_records, 2); assert.equal(noPeriod.details.summary.changed, null);
  assert.notEqual(noPeriod.relationship_id, result.relationship_id);
  assert.equal(f.compare(left, right).details.status, 'uncertain');
  assert.equal(f.compare(left, right, options).cache_hit, true);
  const defaultResult = f.compare(left, right, { details: false }); assert.equal(defaultResult.details, undefined);
  assert.throws(() => f.compare(left, right, { details: false, keyColumn: '线路' }), /details/u);
  const oldTime = result.sources.left.modified_at; const later = new Date('2030-01-01T00:00:00Z'); fs.utimesSync(left, later, later);
  const refreshed = f.compare(left, right, options);
  assert.notEqual(refreshed.sources.left.modified_at, oldTime); assert.equal(refreshed.sources.left.modified_at, later.toISOString());
  assert.equal(refreshed.details.time_sources.file_modified.left, later.toISOString());
  assert.equal(refreshed.sources.left.sha256, result.sources.left.sha256);
});

test('empty or duplicate composite keys stay uncertain; strict tables and ISO date coverage are explicit', (t) => {
  const f = fixture(t);
  const left = f.put('keys.csv', 'ID,期间,日期\na,,2020-01-01\na,x,invalid\n,x,\na,x,2020-02-30\n');
  const right = f.put('keys-new.csv', 'ID,期间,日期\na,x,2020-01-02\n');
  const details = f.compare(left, right, { keyColumn: 'ID', periodColumn: '期间', eventDateColumn: '日期' }).details;
  assert.equal(details.status, 'uncertain'); assert.equal(details.summary.left_empty_key_records, 2);
  assert.equal(details.summary.left_duplicate_keys, 1); assert.equal(details.summary.added, null);
  assert.equal(details.time_sources.event_dates.left.valid_count, 1); assert.equal(details.time_sources.event_dates.left.invalid_count, 2);
  assert.equal(details.time_sources.event_dates.left.missing_count, 1);
  assert.ok(details.entries.some(e => e.type === 'empty_key')); assert.ok(details.entries.some(e => e.type === 'duplicate_key' && e.count === 2));
  for (const [name, body] of [['duplicate.csv', 'ID,ID\na,b\n'], ['empty.csv', 'ID,\na,b\n'], ['ragged.csv', 'ID,期间\na\n'], ['columns.csv', 'ID,other\na,x\n']]) {
    assert.throws(() => f.compare(f.put(name, body), right, { keyColumn: 'ID' }));
  }
});

test('sample and computation bounds are explicit; long CSV header names remain intact', (t) => {
  const f = fixture(t); const empty = f.put('empty.txt', '');
  const many = f.put('many.txt', Array.from({ length: 125 }, (_, i) => `新增 ${i}\n\n`).join(''));
  const details = f.compare(empty, many).details;
  assert.equal(details.summary.added, 125); assert.equal(details.entries.length, 100); assert.equal(details.truncated, true);
  assert.throws(() => f.compare(empty, f.put('huge.txt', 'a'.repeat(262145))));
  assert.throws(() => f.compare(empty, f.put('blocks.txt', '块\n\n'.repeat(2001))));
  const header = '长列'.repeat(550); const row = '值'.repeat(1200);
  const a = f.put('long-a.csv', `ID,${header}\na,${row}\n`);
  const b = f.put('long-b.csv', `ID,${header}\na,${'新'.repeat(1200)}\n`);
  const bounded = f.compare(a, b, { keyColumn: 'ID' }).details;
  assert.equal(bounded.summary.changed, 1); assert.equal(bounded.truncated, true);
  assert.ok(bounded.columns.includes(header));
  for (const entry of bounded.entries) {
    assert.equal(entry.type, 'changed'); assert.ok(!Object.hasOwn(entry, ''));
    for (const cells of [entry.before, entry.after].filter(Boolean)) assert.ok(Object.keys(cells).every(key => key === 'ID' || key === header));
  }
  const big = f.compare(empty, f.put('long-blocks.txt', Array.from({ length: 20 }, (_, i) => `${i}:${'文'.repeat(2100)}\n\n`).join(''))).details;
  assert.equal(big.truncated, true);
  const allStrings = value => typeof value === 'string' ? value.length : value && typeof value === 'object' ? Object.values(value).reduce((sum, v) => sum + allStrings(v), 0) : 0;
  assert.ok(allStrings(big) <= 24000);
});

test('JSONL details preserve message facts and decline reliable changed counts for duplicate IDs', (t) => {
  const f = fixture(t); const records = rows => rows.map(v => JSON.stringify(v)).join('\n') + '\n';
  const left = f.put('old.jsonl', records([{ message_id: 'a', content: 'old', timestamp: '2020-01-01T00:00:00Z' }]));
  const right = f.put('new.jsonl', records([{ message_id: 'a', content: 'new', timestamp: '2020-01-01T00:00:00Z' }, { message_id: 'b', content: 'added' }]));
  const result = f.compare(left, right);
  assert.equal(result.details.kind, 'message_facts'); assert.equal(result.details.summary.changed, 1); assert.equal(result.details.summary.added, 1);
  assert.ok(result.details.entries.some(e => e.type === 'changed' && e.message_id === 'a'));
  const dup = f.put('duplicate.jsonl', records([{ message_id: 'a', content: 'old' }, { message_id: 'a', content: 'new' }]));
  const uncertain = f.compare(left, dup).details;
  assert.equal(uncertain.status, 'uncertain'); assert.equal(uncertain.summary.changed, null); assert.equal(uncertain.summary.unchanged, null);
  assert.ok(uncertain.entries.some(e => e.type === 'duplicate_id' && e.message_id === 'a'));
  assert.throws(() => f.compare(left, f.put('oversized.jsonl', ' '.repeat(262145))), /256 KiB/u);
});

test('Node rejects source changes after the processor returns', (t) => {
  const f = fixture(t); const left = f.put('left.md', 'before'); const right = f.put('right.md', 'after');
  assert.throws(() => f.compare(left, right, { runProcess: (executable, args, options) => {
    const result = spawnSync(executable, args, options); fs.appendFileSync(left, 'changed outside processor'); return result;
  } }), { code: 'ATLAS_STATE_CONFLICT' });
});
