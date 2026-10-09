import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { contentFileFingerprint } from '../src/content-inspection.js';
import { SaveService } from '../src/save-service.js';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createSavedWorkService } from '../src/ui/services/saved-work-service.js';
import { createTableWorkModule } from '../src/table-work-module.js';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';

const python = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));
const pythonRoot = path.resolve('python');
const pythonSourceRoot = path.resolve('python/src');

function runDataWork(args) {
  const argv = ['-m', 'atlas_content', 'data-work', '--file', args.filePath, '--expected-sha256', args.expectedSha256, '--action', args.action];
  if (args.requestPath) argv.push('--request', args.requestPath);
  if (args.outputPath) argv.push('--output', args.outputPath);
  if (args.sheet) argv.push('--sheet', args.sheet);
  const result = spawnSync(python, argv, { cwd: pythonRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: [pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONUTF8: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Python Data Work exited ${result.status}`);
  return JSON.parse(result.stdout);
}

test('Table Work pivot computes the full matrix, totals, shares and ranks, and saves that same result', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/data-work-pivot-'));
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'Traffic');
  const sourcePath = path.join(projectPath, 'Data', 'volume.csv');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.join(projectPath, 'Results'), { recursive: true });
  const rows = ['district,month,amount'];
  for (let index = 0; index < 30; index += 1) rows.push('North,January,10');
  for (let index = 0; index < 20; index += 1) rows.push('North,February,5');
  for (let index = 0; index < 10; index += 1) rows.push('South,January,7');
  rows.push('North,January,', 'South,February,');
  const original = `${rows.join('\n')}\n`;
  fs.writeFileSync(sourcePath, original, 'utf8');

  const stateDir = path.join(root, 'state');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const created = registry.create({ name: 'Traffic', currentPath: 'Traffic' });
  registry.attachRoot(created.project_id, { rootId: adopted.root_id, relativePath: 'Traffic', reason: 'Pivot fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const project = { id: created.project_id, name: created.name };
  const resource = control.identify({ filePath: sourcePath, project });
  const dataWork = createDataWorkService({ stateDir, projectRoot: root, installationRoot: root, resourceControl: control,
    fingerprintFn: async (filePath) => contentFileFingerprint(filePath), runDataWorkFn: runDataWork });
  const saveService = new SaveService({ stateDir });
  const savedWork = createSavedWorkService({ stateDir, saveService });
  const resolveProject = (projectId) => {
    const item = registry.list().find((candidate) => candidate.id === projectId && candidate.status === 'active');
    if (!item) return null;
    const location = registry.show(projectId).location;
    return location?.root_path ? { project: { id: item.id, name: item.name, status: item.status }, location } : null;
  };
  const tableModule = createTableWorkModule({ dataWork, savedWork, resolveProject });
  t.after(() => { saveService.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  const invoke = (action, parameters = {}, work = null) => tableModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id, ...(work ? { work } : {}), action, parameters });
  let work = (await invoke('start', { resource_ids: [resource.resource_id], caller: { actor: 'agent', tool: 'pivot-fixture', client_run_id: 'pivot-start' } })).data;
  work = (await invoke('prepare', {}, { session_id: work.session_id, base_revision: work.revision })).data;
  assert.equal(work.sources[0].status, 'ready');
  const mapping = work.sources[0].profile.profile.fields.map((field) => ({ source_key: work.sources[0].source_key, column: field.name, canonical: field.name }));
  work = (await invoke('align', { mapping }, { session_id: work.session_id, base_revision: work.revision })).data;
  work = (await invoke('recipe', { combine: 'concatenate', pivot_row_dimension: 'district', pivot_column_dimension: 'month', pivot_measure: 'amount', pivot_formula: 'sum', pivot_unit: 'passengers', pivot_null_policy: 'exclude' }, { session_id: work.session_id, base_revision: work.revision })).data;
  assert.deepEqual(work.recipe.steps.find((step) => step.operation === 'pivot-aggregate'), {
    operation: 'pivot-aggregate', row_dimension: 'district', column_dimension: 'month', measure: 'amount', formula: 'sum', unit: 'passengers', null_policy: 'exclude',
  });
  work = (await invoke('preview', {}, { session_id: work.session_id, base_revision: work.revision })).data;
  const hostPreview = await tableModule.readPreview({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id, work: { session_id: work.session_id, base_revision: work.revision }, preview_revision: work.preview_revision });
  assert.equal(work.preview_revision, work.revision);
  const pivot = hostPreview.preview.pivot_aggregation;
  assert.equal(pivot.input_rows, 62);
  assert.equal(pivot.included_rows, 60);
  assert.equal(pivot.excluded_rows, 2);
  assert.equal(pivot.grand_total, 470);
  assert.equal(hostPreview.preview.rows.at(-1).at(-1), null);
  assert.deepEqual(pivot.column_totals, [{ value: 'January', sum: 370 }, { value: 'February', sum: 100 }]);
  assert.deepEqual(pivot.row_totals, [
    { value: 'North', sum: 400, rows: 50, share_percent: 85.11, rank: 1 },
    { value: 'South', sum: 70, rows: 10, share_percent: 14.89, rank: 2 },
  ]);
  assert.deepEqual(pivot.matrix, [
    { row: 'North', values: [300, 100], total: 400, share_percent: 85.11, rank: 1 },
    { row: 'South', values: [70, 0], total: 70, share_percent: 14.89, rank: 2 },
    { row: '__TOTAL__', values: [370, 100], total: 470, share_percent: 100, rank: null },
  ]);

  const html = renderDataWorkView({ mode: 'sources', session: work, project, back_href: `/projects/${project.id}/resources`, csrf: 'fixture-token' }, { locale: 'en' });
  assert.match(html, /Pivot matrix and totals/u);
  assert.match(html, /January/u); assert.match(html, /February/u);
  assert.match(html, /470/u); assert.match(html, /<tr><td>North<\/td><td>300<\/td><td>100<\/td><td>400<\/td><td>85\.11%<\/td><td>1<\/td><\/tr>/u);

  const savePrep = (await invoke('prepare-save', { folder: 'Results', file_name: 'district-month-pivot.csv', format: 'csv' }, { session_id: work.session_id, base_revision: work.revision })).data;
  const saved = await invoke('confirm-save', { ...savePrep, folder: 'Results', file_name: 'district-month-pivot.csv', format: 'csv', channel: 'work', request_key: 'pivot-save', reason: 'Confirmed matrix.', caller: { actor: 'agent', tool: 'pivot-fixture', client_run_id: 'pivot-save' } }, { session_id: work.session_id, base_revision: work.revision });
  assert.equal(saved.data.status, 'executed');
  const output = fs.readFileSync(path.join(projectPath, 'Results', 'district-month-pivot.csv'), 'utf8');
  assert.match(output, /North/u); assert.match(output, /South/u); assert.match(output, /January/u); assert.match(output, /February/u);
  assert.match(output, /470/u); assert.match(output, /85\.11/u);
  assert.equal(contentFileFingerprint(sourcePath).sha256, resource.evidence.sha256);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
});
