import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';

test('Table Work aggregate categories expose revision-bound focus and processed-row details', () => {
  const session = {
    session_id: 'DWT-0123456789abcdef0123456789abcdef', project_id: 'PRJ-focus', project_name: 'Traffic',
    revision: 8, preview_revision: 8, intent: 'Review district totals', mapping_complete: true,
    sources: [{ source_key: 'SRC-1', resource_id: 'RES-1', name: 'volume.csv', status: 'ready', fingerprint: { sha256: 'a'.repeat(64) }, profile: { profile: { rows: 62, fields: [{ name: 'district' }, { name: 'amount' }] } } }],
    mapping: [{ source_key: 'SRC-1', column: 'district', canonical: 'district' }, { source_key: 'SRC-1', column: 'amount', canonical: 'amount' }],
    recipe: { version: 3, combine: { operation: 'concatenate' }, steps: [{ operation: 'filter', column: 'district', operator: 'contains', value: '区' }, { operation: 'group-aggregate', dimension: 'district', measure: 'amount', formula: 'sum', unit: 'vehicles', null_policy: 'exclude' }] },
    preview: {
      columns: ['district', 'amount'], rows: [['North', 312.5], ['South', 145], ['East', 60]],
      preview: { rows_shown: 3, total_rows: 3 }, result_summary: { rows: 3, columns: 2 },
      source_summary: { rows: 62, columns: 2 }, validation: { input_rows: 62, output_rows: 3, null_cells: 0, duplicate_rows: 0, conversion_failures: {} },
      aggregation: { dimension: 'district', measure: 'amount', formula: 'sum', unit: 'vehicles', null_policy: 'exclude', input_rows: 62, included_rows: 60, excluded_rows: 2, grand_total: 517.5, groups: [{ value: 'North', sum: 312.5, rows: 25 }, { value: 'South', sum: 145, rows: 20 }, { value: 'East', sum: 60, rows: 15 }] },
    },
    freshness: { label: 'fresh' }, change_review: { status: 'fresh', items: [] },
  };
  const html = renderDataWorkView({ mode: 'sources', session, project: { id: session.project_id, name: 'Traffic' }, back_href: '/projects/PRJ-focus/resources', csrf: 'csrf-focus' }, { locale: 'en' });
  assert.match(html, /data-work-aggregate/u);
  assert.match(html, /517\.5/u);
  assert.match(html, /North/u);
  assert.match(html, /312\.5/u);
  assert.match(html, /name="action" value="focus_category"/u);
  assert.match(html, /name="category" value="North"/u);
  assert.match(html, /name="base_revision" value="8"/u);
  assert.match(html, /name="filter_value" value="区"/u);
  const focusedSession = {
    ...session, revision: 9, preview_revision: 9,
    recipe: { ...session.recipe, steps: [session.recipe.steps[0], { operation: 'filter', column: 'district', operator: 'equals', value: 'North', focus: true }, session.recipe.steps[1]] },
    preview: { ...session.preview, aggregation: { ...session.preview.aggregation, included_rows: 25, excluded_rows: 0, grand_total: 312.5, groups: [{ value: 'North', sum: 312.5, rows: 25 }] } },
  };
  const focusedHtml = renderDataWorkView({ mode: 'sources', session: focusedSession, project: { id: session.project_id, name: 'Traffic' }, back_href: '/projects/PRJ-focus/resources', csrf: 'csrf-focus' }, { locale: 'en' });
  assert.match(focusedHtml, /312\.5/u);
  assert.match(focusedHtml, /name="action" value="clear_focus"/u);
  assert.match(focusedHtml, /\/work\/DWT-0123456789abcdef0123456789abcdef\/details\?offset=0/u);
  assert.match(focusedHtml, /Processed input rows/u);
  assert.match(focusedHtml, /name="filter_value" value="区"/u);
  const emptySession = {
    ...focusedSession,
    recipe: { ...focusedSession.recipe, steps: [session.recipe.steps[0], { operation: 'filter', column: 'district', operator: 'is_empty', value: '', focus: true }, session.recipe.steps[1]] },
    preview: { ...focusedSession.preview, aggregation: { ...focusedSession.preview.aggregation, grand_total: 0, groups: [{ value: '', sum: 0, rows: 1 }] } },
  };
  const emptyHtml = renderDataWorkView({ mode: 'sources', session: emptySession, project: { id: session.project_id, name: 'Traffic' }, back_href: '/projects/PRJ-focus/resources', csrf: 'csrf-focus' }, { locale: 'en' });
  assert.match(emptyHtml, /\(Empty category\)/u);
  assert.match(emptyHtml, /name="category" value=""/u);
  const negativeSession = {
    ...session,
    preview: { ...session.preview, aggregation: { ...session.preview.aggregation, grand_total: 292.5, groups: [
      { value: 'North', sum: 312.5, rows: 25 }, { value: 'Returns', sum: -20, rows: 2 },
    ] } },
  };
  const negativeHtml = renderDataWorkView({ mode: 'sources', session: negativeSession, project: { id: session.project_id, name: 'Traffic' }, back_href: '/projects/PRJ-focus/resources', csrf: 'csrf-focus' }, { locale: 'en' });
  assert.match(negativeHtml, /data-sign="negative"/u);
  assert.match(negativeHtml, /-20 vehicles/u);
});
