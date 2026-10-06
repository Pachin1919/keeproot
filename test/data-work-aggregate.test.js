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

const python = path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe');
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

test('Table Work group aggregate uses all rows, shares the Host totals with HTML, and saves the full result', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/data-work-aggregate-'));
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'Traffic');
  const sourcePath = path.join(projectPath, 'Data', 'volume.csv');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.join(projectPath, 'Results'), { recursive: true });
  const rows = ['district,amount'];
  for (let index = 0; index < 25; index += 1) rows.push(`North,12.50`);
  for (let index = 0; index < 20; index += 1) rows.push(`South,7.25`);
  for (let index = 0; index < 15; index += 1) rows.push(`East,4.00`);
  rows.push('North,', 'South,');
  const original = `${rows.join('\n')}\n`;
  fs.writeFileSync(sourcePath, original, 'utf8');

  const stateDir = path.join(root, 'state');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const created = registry.create({ name: 'Traffic', currentPath: 'Traffic' });
  registry.attachRoot(created.project_id, { rootId: adopted.root_id, relativePath: 'Traffic', reason: 'Aggregate fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const project = { id: created.project_id, name: created.name };
  const resource = control.identify({ filePath: sourcePath, project });
  const dataWork = createDataWorkService({
    stateDir, projectRoot: root, installationRoot: root, resourceControl: control,
    fingerprintFn: async (filePath) => contentFileFingerprint(filePath), runDataWorkFn: runDataWork,
  });
  const saveService = new SaveService({ stateDir });
  const savedWork = createSavedWorkService({ stateDir, saveService });
  const resolveProject = (projectId) => {
    const item = registry.list().find((candidate) => candidate.id === projectId && candidate.status === 'active');
    if (!item) return null;
    const location = registry.show(projectId).location;
    return location?.root_path ? { project: { id: item.id, name: item.name, status: item.status }, location } : null;
  };
  const tableModule = createTableWorkModule({ dataWork, savedWork, resolveProject });
  t.after(() => {
    saveService.dispose();
    control.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  let result = await tableModule.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id,
    action: 'start', parameters: { resource_ids: [resource.resource_id], caller: { actor: 'agent', tool: 'aggregate-fixture', client_run_id: 'aggregate-start' } },
  });
  let work = result.data;
  work = (await tableModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id, work: { session_id: work.session_id, base_revision: work.revision }, action: 'prepare', parameters: {} })).data;
  assert.equal(work.sources[0].status, 'ready');
  const mapping = work.sources[0].profile.profile.fields.map((field) => ({ source_key: work.sources[0].source_key, column: field.name, canonical: field.name }));
  work = (await tableModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id, work: { session_id: work.session_id, base_revision: work.revision }, action: 'align', parameters: { mapping } })).data;
  work = (await tableModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id, work: { session_id: work.session_id, base_revision: work.revision }, action: 'recipe', parameters: { combine: 'concatenate', aggregate_dimension: 'district', aggregate_measure: 'amount', aggregate_formula: 'sum', aggregate_unit: 'vehicles', aggregate_null_policy: 'exclude' } })).data;
  const recipe = work.recipe.steps.find((step) => step.operation === 'group-aggregate');
  assert.deepEqual(recipe, { operation: 'group-aggregate', dimension: 'district', measure: 'amount', formula: 'sum', unit: 'vehicles', null_policy: 'exclude' });
  work = (await tableModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id, work: { session_id: work.session_id, base_revision: work.revision }, action: 'preview', parameters: {} })).data;
  const hostPreview = await tableModule.readPreview({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id, work: { session_id: work.session_id, base_revision: work.revision }, preview_revision: work.preview_revision });
  assert.equal(work.preview_revision, work.revision);
  assert.equal(hostPreview.preview.result_summary.rows, 3);
  assert.deepEqual(hostPreview.preview.aggregation, {
    dimension: 'district', measure: 'amount', formula: 'sum', unit: 'vehicles', null_policy: 'exclude',
    input_rows: 62, included_rows: 60, excluded_rows: 2, grand_total: 517.5,
    groups: [
      { value: 'North', sum: 312.5, rows: 25 },
      { value: 'South', sum: 145, rows: 20 },
      { value: 'East', sum: 60, rows: 15 },
    ],
  });

  const html = renderDataWorkView({ mode: 'sources', session: work, project, back_href: `/projects/${project.id}/resources`, csrf: 'fixture-token' }, { locale: 'en' });
  assert.match(html, /Group aggregate/u);
  assert.match(html, /517\.5/u);
  assert.match(html, /312\.5/u);
  assert.match(html, /145/u);
  assert.match(html, /60/u);
  assert.match(html, /60 rows included/u);
  assert.match(html, /2 rows excluded/u);

  const savePrep = (await tableModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id, work: { session_id: work.session_id, base_revision: work.revision }, action: 'prepare-save', parameters: { folder: 'Results', file_name: 'district-totals.csv', format: 'csv' } })).data;
  const saved = await tableModule.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id,
    work: { session_id: work.session_id, base_revision: work.revision }, action: 'confirm-save',
    parameters: { ...savePrep, folder: 'Results', file_name: 'district-totals.csv', format: 'csv', channel: 'work', request_key: 'aggregate-save', reason: 'Confirmed grouped totals.', caller: { actor: 'agent', tool: 'aggregate-fixture', client_run_id: 'aggregate-save' } },
  });
  assert.equal(saved.data.status, 'executed');
  const output = fs.readFileSync(path.join(projectPath, 'Results', 'district-totals.csv'), 'utf8');
  assert.match(output, /district,amount/u);
  assert.match(output, /North,312\.5/u);
  assert.match(output, /South,145/u);
  assert.match(output, /East,60/u);
  assert.equal(contentFileFingerprint(sourcePath).sha256, resource.evidence.sha256);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);

  fs.appendFileSync(sourcePath, 'North,99\n', 'utf8');
  await assert.rejects(tableModule.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id,
    work: { session_id: work.session_id, base_revision: work.revision }, action: 'preview', parameters: {},
  }), { code: 'ATLAS_STATE_CONFLICT' });
  await assert.rejects(tableModule.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.id,
    work: { session_id: work.session_id, base_revision: work.revision }, action: 'prepare-save',
    parameters: { folder: 'Results', file_name: 'stale-district-totals.csv', format: 'csv' },
  }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.existsSync(path.join(projectPath, 'Results', 'stale-district-totals.csv')), false);
});
