import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';

test('Table Work UI exposes date-only trend Recipe fields and draws labeled monthly results', () => {
  const session = {
    session_id: 'DWT-0123456789abcdef0123456789abcdef', project_id: 'PRJ-trend', project_name: 'Traffic',
    revision: 7, preview_revision: 7, intent: 'Monthly trend', mapping_complete: true, caller: { tool: 'fixture' },
    sources: [{ source_key: 'SRC-1', resource_id: 'RES-1', name: 'monthly.csv', file_path: 'C:/fixture/monthly.csv', status: 'ready', fingerprint: { sha256: 'a'.repeat(64) }, profile: { profile: { rows: 73, columns: 2, null_cells: 2, duplicate_rows: 0, fields: [{ name: 'service_date', inferred_type: 'date', missing_count: 0, distinct_count: 4, date_range: { minimum: '2026-01-15', maximum: '2026-04-15' } }, { name: 'amount', inferred_type: 'number', missing_count: 2, distinct_count: 4 }] } } }],
    mapping: [{ source_key: 'SRC-1', column: 'service_date', canonical: 'service_date' }, { source_key: 'SRC-1', column: 'amount', canonical: 'amount' }],
    recipe: { version: 3, combine: { operation: 'concatenate' }, steps: [{ operation: 'trend-aggregate', date_field: 'service_date', measure: 'amount', formula: 'sum', start_month: '2026-01', current_start_month: '2026-03', end_month: '2026-04', unit: 'rides', null_policy: 'exclude' }] },
    preview: { columns: ['month', 'sum'], rows: [['2026-01', 200], ['2026-02', 300], ['2026-03', 250], ['2026-04', 300]], preview: { rows_shown: 4, total_rows: 4 }, result_summary: { rows: 4, columns: 2 }, source_summary: { rows: 73, columns: 2 }, validation: { input_rows: 73, output_rows: 4, null_cells: 0, duplicate_rows: 0, conversion_failures: {} }, trend_aggregation: { date_field: 'service_date', measure: 'amount', unit: 'rides', start_month: '2026-01', current_start_month: '2026-03', end_month: '2026-04', previous_period: { start_month: '2026-01', end_month: '2026-02', total: 500 }, current_period: { start_month: '2026-03', end_month: '2026-04', total: 550 }, delta: 50, growth_percent: 10, included_rows: 70, excluded_empty_rows: 2, out_of_range_rows: 1, monthly_totals: [{ month: '2026-01', sum: 200 }, { month: '2026-02', sum: 300 }, { month: '2026-03', sum: 250 }, { month: '2026-04', sum: 300 }] } },
    freshness: { label: 'fresh', reason: null }, freshness_label: 'fresh', change_review: { status: 'fresh', items: [] }, latest_result: null, reuse_action: null,
  };
  const html = renderDataWorkView({ mode: 'sources', session, project: { id: session.project_id, name: 'Traffic' }, back_href: '/projects/PRJ-trend/resources', csrf: 'csrf-trend' }, { locale: 'en' });
  for (const name of ['trend_date_field', 'trend_measure', 'trend_start_month', 'trend_current_start_month', 'trend_end_month', 'trend_unit', 'trend_null_policy']) assert.match(html, new RegExp(`name="${name}"`, 'u'));
  assert.match(html, /Monthly trend/u); assert.match(html, /2026-01/u); assert.match(html, /2026-04/u);
  assert.match(html, /Previous period 500/u); assert.match(html, /current period 550/u); assert.match(html, /10%/u);
  assert.match(html, /<svg/u); assert.match(html, /aria-label=/u);
  assert.match(html, /same Work revision/u);

  const signed = structuredClone(session);
  signed.preview.trend_aggregation.monthly_totals = [
    { month: '2026-01', sum: -100 }, { month: '2026-02', sum: 0 },
    { month: '2026-03', sum: 50 }, { month: '2026-04', sum: -25 },
  ];
  const signedHtml = renderDataWorkView({ mode: 'sources', session: signed, project: { id: signed.project_id, name: 'Traffic' }, back_href: '/projects/PRJ-trend/resources', csrf: 'csrf-trend' }, { locale: 'en' });
  const chart = signedHtml.match(/<svg class="data-work-trend-chart"[\s\S]*?<\/svg>/u)?.[0];
  assert.ok(chart);
  const points = [...chart.matchAll(/<circle[^>]+cy="([^"]+)"/gu)].map((match) => Number(match[1]));
  assert.equal(points.length, 4);
  assert.ok(points.every((y) => Number.isFinite(y) && y >= 20 && y <= 170), `Chart points outside the canvas: ${points.join(', ')}`);
});
