import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve('.');
const fixtureRoot = path.join(projectRoot, 'fixtures', 'analytics', 'v1.2-golden');
const tempRoot = path.join(projectRoot, 'test', '.tmp', 'analytics-v1.2-golden');
const managedPython = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Atlas',
  'python',
  'venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const pythonPath = process.env.ATLAS_TEST_PYTHON
  ?? (fs.existsSync(managedPython) ? managedPython : null);

function invoke(stateDir, ...args) {
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'bin', 'atlas.js'),
    ...args,
    '--json',
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ATLAS_STATE_DIR: stateDir,
      ATLAS_PYTHON: pythonPath,
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

test('the single V1.2 Golden Export passes evaluate/show with fixed answers', {
  skip: pythonPath ? false : `No local Pandas-capable Python is available on ${os.platform()}.`,
}, () => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  const stateDir = path.join(tempRoot, 'state');
  const exportRoot = path.join(stateDir, 'analytics', 'exports', 'v1.2-golden');
  fs.mkdirSync(path.dirname(exportRoot), { recursive: true });
  fs.cpSync(fixtureRoot, exportRoot, { recursive: true });
  const expected = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, 'expected.json'), 'utf8'),
  );

  const first = invoke(
    stateDir,
    'analytics',
    'evaluate',
    '--export',
    'v1.2-golden',
    '--name',
    'EVAL-GOLDEN-A',
  );
  const shown = invoke(stateDir, 'analytics', 'show', 'EVAL-GOLDEN-A');
  const second = invoke(
    stateDir,
    'analytics',
    'evaluate',
    '--export',
    'v1.2-golden',
    '--name',
    'EVAL-GOLDEN-B',
  );

  assert.equal(first.quality_status, expected.quality.status);
  assert.equal(shown.quality.critical_errors, expected.quality.critical_errors);
  assert.equal(shown.quality.warnings, expected.quality.warnings);
  assert.equal(first.metrics_hash, second.metrics_hash);
  assert.equal(first.metrics_hash, shown.metrics_hash);

  const metrics = new Map(
    shown.official_metrics.map((metric) => [metric.metric_id, metric]),
  );
  const context = metrics.get('context_selection_text_byte_rate');
  assert.equal(context.numerator, expected.context_selection_text_byte_rate.numerator);
  assert.equal(context.denominator, expected.context_selection_text_byte_rate.denominator);
  assert.equal(context.value, expected.context_selection_text_byte_rate.value);
  assert.deepEqual(
    context.eligible_task_ids,
    expected.context_selection_text_byte_rate.eligible_task_ids,
  );
  assert.equal(
    context.exclusion_counts.pure_binary_extraction_tasks,
    expected.context_selection_text_byte_rate.pure_binary_extraction_tasks,
  );
  assert.deepEqual(
    context.exclusion_details.filter(
      (item) => item.reason === expected.context_selection_text_byte_rate.pure_binary_reason,
    ).map((item) => item.task_id),
    expected.context_selection_text_byte_rate.pure_binary_task_ids,
  );

  const recovery = metrics.get('recovery_outcome_distribution');
  assert.equal(recovery.denominator, expected.recovery_outcome_distribution.denominator);
  assert.deepEqual(
    recovery.outcome_counts,
    expected.recovery_outcome_distribution.outcome_counts,
  );
  assert.equal(
    recovery.duplicate_events_deduplicated,
    expected.recovery_outcome_distribution.duplicate_events_deduplicated,
  );
  for (const [outcome, runIds] of Object.entries(
    expected.recovery_outcome_distribution.run_ids,
  )) {
    assert.deepEqual(recovery.outcomes[outcome].run_ids, runIds);
  }

  const ruleReuse = metrics.get('rule_reuse_rate');
  assert.equal(ruleReuse.numerator, expected.rule_reuse_rate.numerator);
  assert.equal(ruleReuse.denominator, expected.rule_reuse_rate.denominator);
  assert.equal(ruleReuse.value, expected.rule_reuse_rate.value);
  assert.deepEqual(
    ruleReuse.denominator_task_ids,
    expected.rule_reuse_rate.eligible_task_ids,
  );
  assert.deepEqual(
    ruleReuse.numerator_task_ids,
    expected.rule_reuse_rate.matched_task_ids,
  );
  assert.deepEqual(
    ruleReuse.corrected_task_ids,
    expected.rule_reuse_rate.corrected_task_ids,
  );
  assert.deepEqual(ruleReuse.excluded_task_ids, expected.rule_reuse_rate.excluded_task_ids);

  const unavailable = shown.measurement_candidates.find(
    (item) => item.metric_id === expected.unavailable.metric_id,
  );
  assert.equal(unavailable.availability, expected.unavailable.availability);
  assert.equal(Object.hasOwn(unavailable, 'value'), false);
  assert.deepEqual(
    shown.anomalies.map((item) => ({
      anomaly_type: item.anomaly_type,
      ...(item.task_id ? { task_id: item.task_id } : {}),
      ...(item.run_id ? { run_id: item.run_id } : {}),
    })),
    expected.anomalies,
  );
});
