import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';
import { createProjectViewService } from '../src/project-view-service.js';

const pythonPath = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));

function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/csv-row-candidate-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A'); fs.mkdirSync(projectRoot, { recursive: true });
  const file = path.join(projectRoot, 'routes.csv');
  fs.writeFileSync(file, '\uFEFF记录ID,区域,备注\r\n001, 北区 ,"第一行\r\n说明"\r\nK-2,南区,普通\r\n', 'utf8');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'CSV row candidate fixture' });
  const control = new ResourceControl({ stateDir, registry });
  const resourceId = control.identify({ filePath: file, project: registry.show(project.project_id).project }).resource_id;
  const locations = createContentLocationService({ registry, resourceControl: control, pythonPath });
  const service = createProjectViewService({ stateDir, registry, pythonPath });
  t.after(() => { service.dispose(); locations.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, registry, project, file, resourceId, locations, service };
}

test('CSV key value keeps significant surrounding spaces through candidate storage', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '记录ID,区域\r\n 001 ,北区\r\n', 'utf8');
  const snapshot = f.locations.locateCsvRow({ projectId: f.project.project_id, resourceId: f.resourceId,
    key: { column: '记录ID', value: ' 001 ' } });
  assert.equal(snapshot.key.value, ' 001 ');
  const property = f.service.defineProperty({ projectId: f.project.project_id, name: '区域归属', kind: 'text' });
  const batch = f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id,
    promptVersion: 'csv-spaced-key', candidates: [{ format: 'csv', resource_id: f.resourceId,
      key: { column: '记录ID', value: ' 001 ' }, value: '北区', source_version: snapshot.row_sha256,
      evidence: { summary: '区域列', cells: ['区域'] } }],
    caller: { tool: 'codex', model: 'test', client_run_id: 'csv-spaced-key' } });
  assert.equal(batch.candidates[0].locator.value, ' 001 ');
  assert.equal(f.service.rowPropertyCandidateBatch({ projectId: f.project.project_id, batchId: batch.batch_id })
    .candidates[0].status, 'pending');
});

test('CSV row lookup refuses malformed input, positional identity, and another Project', (t) => {
  const f = fixture(t);
  const lookup = () => f.locations.locateCsvRow({ projectId: f.project.project_id, resourceId: f.resourceId,
    key: { column: '记录ID', value: '001' } });
  for (const bytes of [
    '记录ID,记录ID\r\n001,001\r\n',
    '记录ID,区域\r\n001\r\n',
    '记录ID;区域\r\n001;北区\r\n',
    Buffer.from([0xff, 0xfe, 0x0a]),
  ]) {
    fs.writeFileSync(f.file, bytes);
    assert.throws(lookup, { code: 'ATLAS_STATE_CONFLICT' });
  }
  fs.writeFileSync(f.file, '记录ID,区域\r\n001,北区\r\n', 'utf8');
  assert.throws(() => f.locations.locateCsvRow({ projectId: f.project.project_id, resourceId: f.resourceId,
    key: { column: '记录ID', value: '001' }, row: 2 }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.locations.locateCsvRow({ projectId: f.project.project_id, resourceId: f.resourceId,
    key: { column: '记录ID', value: '001' }, sheet: 'CSV' }), { code: 'ATLAS_STATE_CONFLICT' });
  fs.mkdirSync(path.join(path.dirname(f.file), '..', 'B'), { recursive: true });
  const other = f.registry.create({ name: 'B', currentPath: 'B' });
  const root = f.registry.show(f.project.project_id).location.root_id;
  f.registry.attachRoot(other.project_id, { rootId: root, relativePath: 'B', reason: 'CSV Project boundary check' });
  assert.throws(() => f.locations.locateCsvRow({ projectId: other.project_id, resourceId: f.resourceId,
    key: { column: '记录ID', value: '001' } }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('CSV row identity uses the original unique key and hashes row content independent of order', (t) => {
  const f = fixture(t);
  const snapshot = f.locations.locateCsvRow({ projectId: f.project.project_id, resourceId: f.resourceId,
    key: { column: '记录ID', value: '001' } });
  assert.equal(snapshot.format, 'csv');
  assert.equal(snapshot.sheet, null);
  assert.equal(snapshot.key.value, '001');
  assert.equal(snapshot.record_number, 1);
  assert.equal(snapshot.cells.find((cell) => cell.column === '备注').value, '第一行\r\n说明');
  assert.match(snapshot.row_sha256, /^[a-f0-9]{64}$/u);
  const property = f.service.defineProperty({ projectId: f.project.project_id, name: '区域归属', kind: 'text' });
  const batch = f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id,
    promptVersion: 'csv-p1', candidates: [{ format: 'csv', resource_id: f.resourceId,
      key: { column: '记录ID', value: '001' }, value: '北区', source_version: snapshot.row_sha256,
      evidence: { summary: '区域列', cells: ['区域'] } }],
    caller: { tool: 'codex', model: 'test', client_run_id: 'csv-row-1' } });
  assert.equal(batch.candidates.length, 1);
  assert.equal(batch.candidates[0].sheet, null);
  assert.equal(batch.candidates[0].locator.format, 'csv');
  assert.equal(batch.candidates[0].locator.value, '001');
  const reordered = '\uFEFF记录ID,区域,备注\r\nK-2,南区,普通\r\n001, 北区 ,"第一行\r\n说明"\r\n';
  fs.writeFileSync(f.file, reordered, 'utf8');
  const afterReorder = f.service.rowPropertyCandidateBatch({ projectId: f.project.project_id, batchId: batch.batch_id }).candidates[0];
  assert.equal(afterReorder.status, 'pending');
  assert.equal(afterReorder.can_accept, true);
  assert.equal(afterReorder.current_record_number, 2);
  assert.equal(afterReorder.current_row_sha256, snapshot.row_sha256);
  fs.writeFileSync(f.file, '\uFEFF记录ID,区域,备注\r\n001, 东区 ,"第一行\r\n说明"\r\nK-2,南区,普通\r\n', 'utf8');
  const changedRow = f.service.rowPropertyCandidateBatch({ projectId: f.project.project_id, batchId: batch.batch_id }).candidates[0];
  assert.equal(changedRow.status, 'needs_review');
  assert.equal(changedRow.can_accept, false);
  fs.writeFileSync(f.file, '\uFEFF记录ID,区域,备注\r\n001, 北区 ,"第一行\r\n说明"\r\nK-2,南区,普通\r\n', 'utf8');
  assert.throws(() => f.locations.locateCsvRow({ projectId: f.project.project_id, resourceId: f.resourceId,
    key: { column: '记录ID', value: 'missing' } }), /key was not found/u);
  fs.appendFileSync(f.file, '001, 重复 ,再次\r\n', 'utf8');
  assert.throws(() => f.locations.locateCsvRow({ projectId: f.project.project_id, resourceId: f.resourceId,
    key: { column: '记录ID', value: '001' } }), /key is not unique/u);
});
