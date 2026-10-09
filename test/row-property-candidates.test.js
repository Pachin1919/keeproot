import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../src/ledger.js';
import { LATEST_SCHEMA_VERSION } from '../src/storage/ledger-schema.js';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';
import { createProjectViewService } from '../src/project-view-service.js';

const pythonPath = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));
const pythonSourceRoot = path.resolve('python/src');
function makeBook(file, changed = false, duplicate = false) {
  const script = String.raw`import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="公交排班" sheetId="1" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
 xml='''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>线路键</t></is></c><c r="B1" t="inlineStr"><is><t>区域</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>K-1</t></is></c><c r="B2" t="inlineStr"><is><t>North</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>K-2</t></is></c><c r="B3" t="inlineStr"><is><t>South</t></is></c></row></sheetData></worksheet>'''
 if sys.argv[2]=='changed':
  xml=xml.replace('<row r="2"><c r="A2" t="inlineStr"><is><t>K-1</t></is></c><c r="B2" t="inlineStr"><is><t>North</t></is></c></row>','<row r="2"><c r="A2" t="inlineStr"><is><t>K-2</t></is></c><c r="B2" t="inlineStr"><is><t>East</t></is></c></row>')
  xml=xml.replace('<row r="3"><c r="A3" t="inlineStr"><is><t>K-2</t></is></c><c r="B3" t="inlineStr"><is><t>South</t></is></c></row>','<row r="3"><c r="A3" t="inlineStr"><is><t>K-1</t></is></c><c r="B3" t="inlineStr"><is><t>North</t></is></c></row>')
 if sys.argv[3]=='duplicate':
  xml=xml.replace('<t>K-2</t>','<t>K-1</t>')
 z.writestr('xl/worksheets/sheet1.xml',xml)`;
  const result = spawnSync(pythonPath, ['-c', script, file, changed ? 'changed' : 'base', duplicate ? 'duplicate' : 'unique'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/row-property-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A'); fs.mkdirSync(projectRoot, { recursive: true });
  const book = path.join(projectRoot, 'routes.xlsx'); makeBook(book);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' }); registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'row candidate fixture' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath: book, project: registry.show(project.project_id).project }).resource_id;
  const service = createProjectViewService({ stateDir, registry });
  const locations = createContentLocationService({ registry, resourceControl: control, pythonPath });
  const priorPython = process.env.ATLAS_PYTHON; process.env.ATLAS_PYTHON = pythonPath;
  t.after(() => { locations.dispose(); service.dispose(); control.dispose(); registry.dispose(); if (priorPython == null) delete process.env.ATLAS_PYTHON; else process.env.ATLAS_PYTHON = priorPython; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, registry, project, book, resourceId, service, locations };
}

test('row property candidates bind keyed rows and mark only the changed row for review', (t) => {
  const f = fixture(t); const property = f.service.defineProperty({ projectId: f.project.project_id, name: '区域', kind: 'text' });
  const candidates = ['K-1','K-2'].map((keyValue) => { const snapshot = f.locations.locateXlsxRow({ projectId: f.project.project_id, resourceId: f.resourceId, sheet: '公交排班', key: { column: 'A', value: keyValue } }); return { resource_id: f.resourceId, sheet: '公交排班', key: { column: 'A', value: keyValue }, value: keyValue === 'K-1' ? '北区' : '南区', source_version: snapshot.row_sha256, evidence: { summary: '表格B列', cells: [keyValue === 'K-1' ? 'B2' : 'B3'] } }; });
  const batch = f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id, promptVersion: 'p1', candidates, caller: { tool: 'codex', model: 'test', client_run_id: 'row-1' } });
  assert.equal(batch.candidates.length, 2);
  const replay = f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id, promptVersion: 'p1', candidates, caller: { tool: 'codex', model: 'test', client_run_id: 'row-1' } });
  assert.equal(replay.batch_id, batch.batch_id);
  const otherProject = f.registry.create({ name: 'B', currentPath: 'B' });
  assert.throws(() => f.service.rowPropertyCandidateBatch({ projectId: otherProject.project_id, batchId: batch.batch_id }), /unavailable in this Project/u);
  assert.throws(() => f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id, promptVersion: 'p1', candidates: [{ ...candidates[0], value: 'changed' }], caller: { tool: 'codex', model: 'test', client_run_id: 'row-1' } }), { code: 'ATLAS_STATE_CONFLICT' });
  const coordinate = f.locations.locateXlsxRow({ projectId: f.project.project_id, resourceId: f.resourceId, sheet: '公交排班', row: 2 });
  assert.equal(coordinate.row, 2);
  const coordinateBatch = f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id, promptVersion: 'p-coordinate',
    candidates: [{ resource_id: f.resourceId, sheet: '公交排班', row: 2, value: '北区', source_version: coordinate.row_sha256, evidence: { summary: '原第2行', cells: ['B2'] } }],
    caller: { tool: 'codex', model: 'test', client_run_id: 'row-coordinate' } });
  const rowHost = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'content', 'row', '--project', f.project.project_id, '--resource', f.resourceId,
    '--sheet', '公交排班', '--key-column', 'A', '--key-value', 'K-1', '--json'],
  { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, ATLAS_STATE_DIR: f.stateDir, ATLAS_PYTHON: pythonPath } });
  assert.equal(rowHost.status, 0, rowHost.stderr);
  assert.equal(JSON.parse(rowHost.stdout).data.row_sha256, candidates[0].source_version);
  makeBook(f.book, true);
  const refreshed = f.service.rowPropertyCandidateBatch({ projectId: f.project.project_id, batchId: batch.batch_id });
  const movedCoordinate = f.service.rowPropertyCandidateBatch({ projectId: f.project.project_id, batchId: coordinateBatch.batch_id }).candidates[0];
  assert.equal(movedCoordinate.status, 'needs_review'); assert.equal(movedCoordinate.can_accept, false);
  assert.throws(() => f.service.decideRowPropertyCandidate({ projectId: f.project.project_id, candidateId: movedCoordinate.candidate_id,
    action: 'accept', expectedRevision: movedCoordinate.revision, expectedRowVersion: movedCoordinate.current_row_sha256,
    caller: { tool: 'atlas-ui', client_run_id: 'row-coordinate-stale' } }), { code: 'ATLAS_EVALUATION_CHANGED' });
  const first = refreshed.candidates.find((item) => item.locator.value === 'K-1'); const second = refreshed.candidates.find((item) => item.locator.value === 'K-2');
  assert.equal(first.status, 'pending'); assert.equal(first.can_accept, true); assert.equal(second.status, 'needs_review'); assert.equal(second.can_accept, false);
  const decided = f.service.decideRowPropertyCandidate({ projectId: f.project.project_id, candidateId: first.candidate_id, action: 'accept', expectedRevision: first.revision, expectedRowVersion: first.current_row_sha256, caller: { tool: 'atlas-ui', client_run_id: 'row-review' } });
  assert.equal(decided.candidate_id, first.candidate_id);
  f.service.decideRowPropertyCandidate({ projectId: f.project.project_id, candidateId: second.candidate_id, action: 'reject', expectedRevision: second.revision, caller: { tool: 'atlas-ui', client_run_id: 'row-reject' } });
  const after = f.service.rowPropertyCandidateBatch({ projectId: f.project.project_id, batchId: batch.batch_id }).candidates.find((item) => item.candidate_id === first.candidate_id);
  assert.equal(after.status, 'accepted'); assert.equal(after.accepted_row_value.value, '北区');
  assert.throws(() => f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id, promptVersion: 'p1', phase: 'batch', previewBatchId: batch.batch_id,
    candidates: [{ ...candidates[0], source_version: first.current_row_sha256 }], caller: { tool: 'codex', model: 'test', client_run_id: 'row-bulk-stale-evidence' } }), /evidence must reference cells/u);
  const currentK1 = { ...candidates[0], source_version: first.current_row_sha256, evidence: { summary: '表格B列，K-1当前第3行', cells: ['B3'] } };
  const bulk = f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id, promptVersion: 'p1', phase: 'batch', previewBatchId: batch.batch_id,
    candidates: [currentK1], caller: { tool: 'codex', model: 'test', client_run_id: 'row-bulk' } });
  assert.equal(bulk.phase, 'batch'); assert.equal(bulk.candidates.length, 1);
  const host = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'view', 'row-candidates', 'show', batch.batch_id, '--project', f.project.project_id, '--json'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, ATLAS_STATE_DIR: f.stateDir, ATLAS_PYTHON: pythonPath } });
  assert.equal(host.status, 0, host.stderr); const hostCandidate = JSON.parse(host.stdout).data.candidates.find((item) => item.candidate_id === first.candidate_id);
  assert.equal(hostCandidate.candidate_id, first.candidate_id); assert.equal(hostCandidate.accepted_row_value.value, '北区');
  assert.throws(() => f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id, promptVersion: 'p1', candidates: [currentK1, currentK1], caller: { tool: 'codex', model: 'test', client_run_id: 'dup' } }), /unique rows/u);
  const revisedBatch = f.service.submitRowPropertyCandidates({ projectId: f.project.project_id, propertyId: property.property_id, promptVersion: 'p-edit', candidates: [currentK1], caller: { tool: 'codex', model: 'test', client_run_id: 'row-edit' } });
  const revised = f.service.decideRowPropertyCandidate({ projectId: f.project.project_id, candidateId: revisedBatch.candidates[0].candidate_id,
    action: 'edit_accept', value: '北区修正', expectedRevision: revisedBatch.candidates[0].revision,
    expectedRowVersion: first.current_row_sha256, evidence: { summary: '当前B3复核', cells: ['B3'] },
    caller: { tool: 'atlas-ui', client_run_id: 'row-edit-review' } });
  assert.equal(revised.status, 'accepted');
  const revisedReadback = f.service.rowPropertyCandidateBatch({ projectId: f.project.project_id, batchId: revisedBatch.batch_id }).candidates[0];
  assert.equal(revisedReadback.accepted_row_value.value, '北区修正');
  makeBook(f.book, false, true);
  assert.throws(() => f.locations.locateXlsxRow({ projectId: f.project.project_id, resourceId: f.resourceId, sheet: '公交排班', key: { column: 'A', value: 'K-1' } }), /row key is not unique/u);
});

test('v31 row-candidate migration preserves a pre-migration backup and existing Project', (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/row-property-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const initial = new Ledger(root);
  initial.db.exec("INSERT INTO projects(id,name,status,created_at) VALUES('PRJ-row-migration','Keep row project','active','2026-09-29')");
  initial.db.exec('DROP TABLE accepted_row_property_values; DROP TABLE row_property_candidates; DROP TABLE row_property_candidate_batches; DELETE FROM schema_migrations WHERE version=32; PRAGMA user_version=31;');
  initial.db.close();
  const migrated = new Ledger(root);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, LATEST_SCHEMA_VERSION);
    assert.equal(migrated.db.prepare("SELECT name FROM projects WHERE id='PRJ-row-migration'").get().name, 'Keep row project');
    assert.deepEqual(migrated.db.prepare('SELECT * FROM row_property_candidate_batches').all(), []);
    const backup = new DatabaseSync(path.join(root, `backups/ledger-pre-migration-v31-to-v${LATEST_SCHEMA_VERSION}.sqlite`), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 31);
      assert.equal(backup.prepare("SELECT name FROM projects WHERE id='PRJ-row-migration'").get().name, 'Keep row project');
      assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='row_property_candidate_batches'").get(), undefined);
    } finally { backup.close(); }
  } finally { migrated.db.close(); }
});
