import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';

test('Table Work UI selects distinct pivot dimensions and renders the Host matrix from the current Preview', () => {
  const session = {
    session_id: 'DWT-0123456789abcdef0123456789abcdef', project_id: 'PRJ-pivot', project_name: 'Traffic',
    revision: 4, preview_revision: 4, intent: 'Traffic matrix', mapping_complete: true,
    sources: [{ source_key: 'SRC-1', resource_id: 'RES-1', name: 'volume.csv', status: 'ready', fingerprint: { sha256: 'a'.repeat(64) }, profile: { profile: { rows: 62, fields: [{ name: 'district' }, { name: 'month' }, { name: 'amount' }] } } }],
    mapping: ['district', 'month', 'amount'].map((column) => ({ source_key: 'SRC-1', column, canonical: column })),
    recipe: { version: 3, combine: { operation: 'concatenate' }, steps: [{ operation: 'pivot-aggregate', row_dimension: 'district', column_dimension: 'month', measure: 'amount', formula: 'sum', unit: 'passengers', null_policy: 'exclude' }] },
    preview: { columns: ['district', 'January', 'February'], rows: [['North', 300, 100]], preview: { rows_shown: 1, total_rows: 3 }, result_summary: { rows: 3, columns: 3 }, source_summary: { rows: 62, columns: 3 }, validation: { input_rows: 62, output_rows: 3, null_cells: 0, duplicate_rows: 0, conversion_failures: {} }, pivot_aggregation: { row_dimension: 'district', column_dimension: 'month', measure: 'amount', formula: 'sum', unit: 'passengers', included_rows: 60, excluded_rows: 2, grand_total: 470, output_columns: ['row:district', 'column:1:January', 'column:2:February', 'total:amount', 'share_percent', 'dense_rank'], row_totals: [{ value: 'North', sum: 400, rows: 50, share_percent: 85.11, rank: 1 }], column_totals: [{ value: 'January', sum: 370 }, { value: 'February', sum: 100 }], matrix: [{ row: 'North', values: [300, 100], total: 400, share_percent: 85.11, rank: 1 }] } },
    freshness: { label: 'fresh' }, change_review: { status: 'fresh', items: [] },
  };
  const html = renderDataWorkView({ mode: 'sources', session, project: { id: session.project_id, name: 'Traffic' }, back_href: '/projects/PRJ-pivot/resources', csrf: 'csrf-fixture' }, { locale: 'en' });
  for (const name of ['pivot_row_dimension', 'pivot_column_dimension', 'pivot_measure', 'pivot_formula', 'pivot_unit', 'pivot_null_policy']) assert.match(html, new RegExp(`name="${name}"`, 'u'));
  assert.match(html, /North/u); assert.match(html, /January/u); assert.match(html, /February/u);
  assert.match(html, /470/u); assert.match(html, /<tr><td>North<\/td><td>300<\/td><td>100<\/td><td>400<\/td><td>85\.11%<\/td><td>1<\/td><\/tr>/u);
  assert.match(html, /same Work revision/u);
});
