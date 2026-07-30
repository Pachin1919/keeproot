import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyTaskContractContextBytes,
  exportAnalytics,
} from '../src/analytics-export.js';
import { Tracker } from '../src/tracker.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('analytics export separates direct-text bytes from binary extraction inputs', () => {
  const result = classifyTaskContractContextBytes({
    read: {
      selected: [
        { path: 'notes/context.md', byte_size: 80 },
        { path: 'slides/source.pptx', byte_size: 2400 },
      ],
      excluded: [
        { path: 'notes/older.md', byte_size: 20 },
        { path: 'documents/source.pdf', byte_size: 600 },
      ],
    },
  });

  assert.deepEqual(result, {
    input_text_bytes: 100,
    selected_text_bytes: 80,
    input_binary_bytes: 3000,
    selected_binary_bytes: 2400,
    selected_extraction_inputs: 1,
  });
});

test('analytics export publishes a versioned consistent JSONL/CSV dataset and manifest', (t) => {
  const caseRoot = path.join(tempRoot, 'analytics-export');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'library');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'note.md'), 'before\n', 'utf8');

  const tracker = new Tracker({ stateDir });
  t.after(() => tracker.dispose());
  const run = tracker.begin({
    root,
    allow: ['note.md'],
    intent: 'Create representative analytics evidence.',
    caller: {
      actor: 'agent',
      agent: 'Codex',
      model: 'test-model',
      tool: 'node:test',
      client_run_id: 'analytics-fixture',
    },
  });
  fs.appendFileSync(path.join(root, 'note.md'), 'after\n', 'utf8');
  tracker.close(run.run_id);

  const receipt = exportAnalytics({
    ledger: tracker.ledger,
    stateDir,
    exportName: 'fixture-export',
  });
  const manifest = JSON.parse(fs.readFileSync(receipt.manifest_path, 'utf8'));
  const jsonlPath = path.join(receipt.output_dir, 'records.jsonl');
  const csvPath = path.join(receipt.output_dir, 'records.csv');
  const records = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').map(JSON.parse);

  assert.equal(receipt.export_schema, 'atlas.analytics.v1');
  assert.equal(manifest.export_schema, 'atlas.analytics.v1');
  assert.equal(manifest.record_count, records.length);
  assert.ok(records.some((record) => record.record_type === 'run' && record.run_id === run.run_id));
  assert.ok(records.some((record) => (
    record.record_type === 'operation_event'
    && record.run_id === run.run_id
    && record.event_type === 'close_completed'
  )));
  assert.equal(manifest.files['records.jsonl'].sha256, sha256(jsonlPath));
  assert.equal(manifest.files['records.csv'].sha256, sha256(csvPath));
  assert.match(fs.readFileSync(csvPath, 'utf8').split(/\r?\n/u)[0], /^export_schema,record_type,/u);
  assert.equal(path.dirname(receipt.output_dir), path.join(stateDir, 'analytics', 'exports'));

  const repeated = exportAnalytics({
    ledger: tracker.ledger,
    stateDir,
    exportName: 'fixture-export-repeat',
  });
  assert.equal(repeated.content_hash, receipt.content_hash);
});

test('Tracked rollback records one explicit idempotent outcome per logical attempt', (t) => {
  const caseRoot = path.join(tempRoot, 'analytics-recovery-outcomes');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'library');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, 'note.md');
  fs.writeFileSync(target, 'baseline\n', 'utf8');

  const tracker = new Tracker({ stateDir });
  t.after(() => tracker.dispose());

  const completedRun = tracker.begin({
    root,
    allow: ['note.md'],
    intent: 'Record one completed rollback outcome.',
  });
  fs.writeFileSync(target, 'first change\n', 'utf8');
  tracker.close(completedRun.run_id);
  tracker.rollback(completedRun.run_id);

  const conflictRun = tracker.begin({
    root,
    allow: ['note.md'],
    intent: 'Record one conflict-safe rollback outcome.',
  });
  fs.writeFileSync(target, 'second change\n', 'utf8');
  tracker.close(conflictRun.run_id);
  fs.writeFileSync(target, 'later legitimate change\n', 'utf8');
  assert.throws(
    () => tracker.rollback(conflictRun.run_id),
    (error) => error.code === 'ATLAS_ROLLBACK_CONFLICT',
  );
  assert.throws(
    () => tracker.rollback(conflictRun.run_id),
    (error) => error.code === 'ATLAS_ROLLBACK_CONFLICT',
  );

  const source = tracker.ledger.readAnalyticsSource();
  const outcomes = source.operationEvents
    .filter((event) => event.event_type === 'rollback_outcome_recorded')
    .map((event) => ({ run_id: event.run_id, ...JSON.parse(event.payload_json) }));
  assert.deepEqual(
    outcomes.map((item) => ({
      run_id: item.run_id,
      operation: item.operation,
      outcome: item.outcome,
      reason_code: item.reason_code,
    })),
    [
      {
        run_id: completedRun.run_id,
        operation: 'rollback',
        outcome: 'completed',
        reason_code: 'restored_and_verified',
      },
      {
        run_id: conflictRun.run_id,
        operation: 'rollback',
        outcome: 'conflict_safe_stop',
        reason_code: 'later_file_state_conflict',
      },
    ],
  );
  assert.ok(outcomes.every((item) => /^RBK-[A-F0-9]{20}$/u.test(item.attempt_id)));
});

test('analytics export is callable through the JSON CLI protocol', () => {
  const caseRoot = path.join(tempRoot, 'analytics-export-cli');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'library');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'note.md'), 'unchanged\n', 'utf8');

  const tracker = new Tracker({ stateDir });
  const run = tracker.begin({
    root,
    allow: ['note.md'],
    intent: 'Create a CLI export fixture.',
    caller: {
      actor: 'agent',
      agent: 'Codex',
      model: 'test-model',
      tool: 'node:test',
      client_run_id: 'analytics-cli-fixture',
    },
  });
  tracker.close(run.run_id);
  tracker.dispose();

  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'bin', 'atlas.js'),
    'analytics',
    'export',
    '--name',
    'cli-export',
    '--json',
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ATLAS_STATE_DIR: stateDir,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, 'analytics.export');
  assert.equal(envelope.data.export_schema, 'atlas.analytics.v1');
  assert.ok(fs.existsSync(envelope.data.manifest_path));
});
