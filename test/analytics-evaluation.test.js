import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  evaluateAnalytics,
  showAnalyticsEvaluation,
} from '../src/analytics-evaluation.js';
import { exportAnalytics } from '../src/analytics-export.js';
import { Tracker } from '../src/tracker.js';

const tempRoot = path.resolve('test', '.tmp', 'analytics-evaluation');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('analytics evaluation stops cleanly when the optional Python component is unavailable', (t) => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  const stateDir = path.join(tempRoot, 'state');
  const root = path.join(tempRoot, 'library');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'note.md'), 'baseline\n', 'utf8');
  const tracker = new Tracker({ stateDir });
  t.after(() => tracker.dispose());
  tracker.begin({ root, allow: ['note.md'], intent: 'Analytics gap fixture.' });
  exportAnalytics({ ledger: tracker.ledger, stateDir, exportName: 'fixture-export' });

  assert.throws(
    () => evaluateAnalytics({
      stateDir,
      projectRoot: path.resolve('.'),
      installationRoot: path.join(tempRoot, 'missing-installation'),
      exportName: 'fixture-export',
    }),
    (error) => error.code === 'ATLAS_CAPABILITY_UNAVAILABLE',
  );
  assert.equal(fs.existsSync(path.join(stateDir, 'analytics', 'evaluations')), false);
});

test('analytics show verifies published file Hashes and returns official metrics', () => {
  const stateDir = path.join(tempRoot, 'show-state');
  const evaluationId = 'EVAL-FIXTURE';
  const outputDir = path.join(stateDir, 'analytics', 'evaluations', evaluationId);
  fs.mkdirSync(outputDir, { recursive: true });
  const gapsPath = path.join(outputDir, 'measurement-gaps.json');
  fs.writeFileSync(gapsPath, `${JSON.stringify({
    schema: 'atlas.measurement-gaps.v1',
    availability_counts: { available: 1, partial: 0, unavailable: 0 },
    metrics: [{ metric_id: 'context_selection', availability: 'available' }],
  })}\n`, 'utf8');
  const metricsPath = path.join(outputDir, 'metrics.json');
  fs.writeFileSync(metricsPath, `${JSON.stringify({
    schema: 'atlas.analytics.metrics.v1',
    metrics: [{
      metric_id: 'context_selection_text_byte_rate',
      numerator: 80,
      denominator: 100,
      value: 0.8,
    }],
  })}\n`, 'utf8');
  const reportPath = path.join(outputDir, 'report.md');
  fs.writeFileSync(reportPath, '# Report\n', 'utf8');
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
    evaluation_schema: 'atlas.analytics.evaluation.v1',
    evaluation_id: evaluationId,
    status: 'metrics_ready',
    complete: false,
    source_export: { content_hash: 'a'.repeat(64), record_count: 1 },
    measurement_gaps_hash: sha256(gapsPath),
    metrics_hash: sha256(metricsPath),
    files: {
      'measurement-gaps.json': { sha256: sha256(gapsPath) },
      'metrics.json': { sha256: sha256(metricsPath) },
      'report.md': { sha256: sha256(reportPath) },
    },
    next_required: ['pandas_cross_check_and_report'],
  })}\n`, 'utf8');

  const result = showAnalyticsEvaluation({ stateDir, evaluationId });
  assert.equal(result.evaluation_id, evaluationId);
  assert.deepEqual(result.availability_counts, { available: 1, partial: 0, unavailable: 0 });
  assert.equal(result.official_metrics[0].value, 0.8);
  assert.equal(result.report_path, reportPath);

  fs.appendFileSync(gapsPath, 'tampered\n', 'utf8');
  assert.throws(
    () => showAnalyticsEvaluation({ stateDir, evaluationId }),
    /does not match its manifest Hash/u,
  );
});
