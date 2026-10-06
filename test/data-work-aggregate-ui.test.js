import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';

test('Table Work Recipe exposes bounded group-sum controls and the exact aggregate Preview facts', () => {
  const session = {
    session_id: 'DWT-0123456789abcdef0123456789abcdef', project_id: 'PRJ-aggregate', project_name: 'Traffic',
    revision: 7, preview_revision: 7, intent: 'Group traffic totals', mapping_complete: true,
    sources: [{ source_key: 'SRC-1', resource_id: 'RES-1', name: 'volume.csv', status: 'ready',
      fingerprint: { sha256: 'a'.repeat(64) }, profile: { profile: { rows: 62, fields: [{ name: 'district' }, { name: 'amount' }] } } }],
    mapping: [{ source_key: 'SRC-1', column: 'district', canonical: 'district' }, { source_key: 'SRC-1', column: 'amount', canonical: 'amount' }],
    recipe: { version: 2, combine: { operation: 'concatenate' }, steps: [{ operation: 'group-aggregate', dimension: 'district', measure: 'amount', formula: 'sum', unit: 'vehicles', null_policy: 'exclude' }] },
    preview: {
      columns: ['district', 'amount'], rows: [['North', 312.5], ['South', 145], ['East', 60]],
      preview: { rows_shown: 3, total_rows: 3 }, result_summary: { rows: 3, columns: 2 },
      source_summary: { rows: 62, columns: 2 }, validation: { input_rows: 62, output_rows: 3, null_cells: 0, duplicate_rows: 0, conversion_failures: {} },
      aggregation: { dimension: 'district', measure: 'amount', formula: 'sum', unit: 'vehicles', null_policy: 'exclude', input_rows: 62, included_rows: 60, excluded_rows: 2, grand_total: 517.5, groups: [{ value: 'North', sum: 312.5, rows: 25 }, { value: 'South', sum: 145, rows: 20 }, { value: 'East', sum: 60, rows: 15 }] },
    },
    freshness: { label: 'fresh' }, change_review: { status: 'fresh', items: [] },
  };
  const html = renderDataWorkView({ mode: 'sources', session, project: { id: session.project_id, name: 'Traffic' }, back_href: '/projects/PRJ-aggregate/resources', csrf: 'csrf-fixture' }, { locale: 'en' });
  assert.match(html, /name="aggregate_dimension"/u);
  assert.match(html, /name="aggregate_measure"/u);
  assert.match(html, /name="aggregate_formula"/u);
  assert.match(html, /name="aggregate_unit"/u);
  assert.match(html, /name="aggregate_null_policy"/u);
  assert.match(html, /60 rows included/u);
  assert.match(html, /2 rows excluded/u);
  assert.match(html, /517\.5/u);
  assert.match(html, /North/u);
  assert.match(html, /312\.5/u);
  assert.match(html, /vehicles/u);
  assert.match(html, /same Work revision/u);
});
