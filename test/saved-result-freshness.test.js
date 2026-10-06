import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { contentFileFingerprint } from '../src/content-inspection.js';
import { savedResultFreshness } from '../src/ui/services/saved-work-service.js';

test('saved result checks its own recorded sources after the Work accepts newer versions', t => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/result-freshness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.csv'); const output = path.join(root, 'result.csv');
  fs.writeFileSync(source, 'amount\n30\n'); fs.writeFileSync(output, 'total\n30\n');
  const record = { status: 'executed', result_path: output, result_fingerprint: contentFileFingerprint(output),
    version_policy: 'follow_latest', sources: [{ path: source, fingerprint: contentFileFingerprint(source), version_policy: 'follow_latest' }] };
  assert.equal(savedResultFreshness(record).status, 'fresh');
  fs.writeFileSync(source, 'amount\n40\n');
  assert.equal(savedResultFreshness(record, { sourceFreshness: { status: 'fresh' } }).status, 'needs_review');
  const currentWork = { sourceFreshness: { status: 'fresh' }, versionPolicy: 'pinned_version' };
  assert.equal(savedResultFreshness(record, currentWork).status, 'needs_review', 'a newer Work policy and baseline cannot relabel the saved output');
  assert.equal(savedResultFreshness({ ...record, version_policy: 'pinned_version', sources: record.sources.map(s => ({ ...s, version_policy: 'pinned_version' })) }, { versionPolicy: 'follow_latest' }).status, 'pinned');
  assert.equal(savedResultFreshness({ ...record, sources: [{ ...record.sources[0], fingerprint: contentFileFingerprint(source) }] }).status, 'fresh');
  fs.renameSync(source, `${source}.held`);
  assert.equal(savedResultFreshness(record).status, 'needs_review');
  assert.equal(savedResultFreshness({ ...record, sources: [] }).status, 'not_checked');
  assert.equal(contentFileFingerprint(output).sha256, record.result_fingerprint.sha256);
});

test('mixed saved results ignore pinned source changes but check followed source versions', t => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/result-freshness-mixed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pinned = path.join(root, 'pinned.csv'); const followed = path.join(root, 'followed.csv'); const output = path.join(root, 'out.csv');
  for (const file of [pinned, followed, output]) fs.writeFileSync(file, 'v\n1\n');
  const record = { status: 'executed', result_path: output, result_fingerprint: contentFileFingerprint(output), version_policy: 'mixed', sources: [
    { path: pinned, fingerprint: contentFileFingerprint(pinned), version_policy: 'pinned_version' },
    { path: followed, fingerprint: contentFileFingerprint(followed), version_policy: 'follow_latest' },
  ] };
  fs.writeFileSync(pinned, 'v\n2\n');
  assert.equal(savedResultFreshness(record, { sourceFreshness: { status: 'needs_review' } }).status, 'fresh');
  fs.writeFileSync(followed, 'v\n2\n');
  assert.equal(savedResultFreshness(record).status, 'needs_review');
});
