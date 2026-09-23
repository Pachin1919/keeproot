import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSaveResultView } from '../src/ui/views/save-result-view.js';

test('Saved Result view prioritizes its file, status, and open action over verification details', () => {
  const html = renderSaveResultView({ csrf: 'csrf', save: { save_id: 'SAV-1', status: 'executed', project: { id: 'P-1', name: 'Project' }, target: { relative_path: 'Results/monthly-report.csv' }, resources_href: '/projects/P-1/resources?path=Results%2Fmonthly-report.csv', undo_available: true, caller: { agent: 'Agent', tool: 'atlas' }, verification: { status: 'verified' }, source: { recorded_path: 'Data/input.csv', thread_id: 'DWT-1' } } });
  assert.match(html, /<h1>monthly-report\.csv<\/h1>/u); assert.match(html, /Saved and verified/u); assert.match(html, /Open Saved Result/u); assert.match(html, /<details class="save-result-verification"><summary>Verification details<\/summary>/u); assert.match(html, /Recorded source/u); assert.match(html, /Caller/u);
});
