import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';

const pythonPath = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));
const pythonSourceRoot = path.resolve('python/src');
function createPdf(target, changed = false) {
  const script = String.raw`
import sys
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
writer=PdfWriter(); page=writer.add_blank_page(width=300,height=400)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}); font_ref=writer._add_object(font)
page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font_ref})})
ops=['0.5 w','50 200 m 250 200 l S','50 250 m 250 250 l S','50 300 m 250 300 l S','50 200 m 50 300 l S','150 200 m 150 300 l S','250 200 m 250 300 l S']
for x,y,value in [(62,282,'North'),(162,282,'11'),(62,232,'South'),(162,232,'21')]:
    ops.append('BT /F1 12 Tf %s %s Td (%s%s) Tj ET'%(x,y,value,' changed' if sys.argv[2]=='1' and value=='North' else ''))
content=DecodedStreamObject(); content.set_data(('\n'.join(ops)).encode('ascii')); page[NameObject('/Contents')]=writer._add_object(content)
writer.add_blank_page(width=300,height=400)
with open(sys.argv[1],'wb') as stream: writer.write(stream)
`;
  const result = spawnSync(pythonPath, ['-c', script, target, changed ? '1' : '0'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}
function fixture(t) {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-pdf-region-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '城市表格');
  fs.mkdirSync(projectRoot, { recursive: true }); const filePath = path.join(projectRoot, '公交表格.pdf'); createPdf(filePath);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市表格', currentPath: '城市表格' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市表格', reason: 'PDF region and table location fixture.' });
  const control = new ResourceControl({ stateDir, registry });
  const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const service = createContentLocationService({ registry, resourceControl: control, pythonPath, pythonSourceRoot });
  t.after(() => { service.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, workspace, projectRoot, filePath, registry, project, control, resourceId, service };
}
const cliPath = path.resolve('bin/atlas.js');
function cli(stateDir, args) { return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, ATLAS_STATE_DIR: stateDir, ATLAS_CONTENT_PYTHON: pythonPath, ATLAS_PYTHON: pythonPath } }); }

test('PDF region and detected table return bound exact refs through Host and expire after source changes', (t) => {
  const f = fixture(t); const original = fs.readFileSync(f.filePath);
  const region = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 1, x: 50, y: 100, width: 200, height: 100 });
  assert.equal(region.location_kind, 'pdf_region');
  assert.deepEqual(region.bbox, [50, 100, 250, 200]);
  assert.match(region.text, /North/u); assert.match(region.text, /South/u); assert.ok(region.ref);
  const exactRegion = f.service.readRef({ projectId: f.project.project_id, ref: region.ref });
  assert.equal(exactRegion.status, 'current'); assert.equal(exactRegion.text, region.text); assert.deepEqual(exactRegion.bbox, region.bbox);
  const host = cli(f.stateDir, ['content', 'locate', '--project', f.project.project_id, '--resource', f.resourceId, '--page', '1', '--x', '50', '--y', '100', '--width', '200', '--height', '100', '--json']);
  assert.equal(host.status, 0, `${host.stderr}\n${host.stdout}`); assert.equal(JSON.parse(host.stdout).data.text, region.text);
  const hostRead = cli(f.stateDir, ['content', 'read-ref', '--project', f.project.project_id, '--ref', region.ref, '--json']);
  assert.equal(hostRead.status, 0, `${hostRead.stderr}\n${hostRead.stdout}`); assert.equal(JSON.parse(hostRead.stdout).data.text, region.text);

  const tables = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 1, tables: true });
  assert.equal(tables.location_kind, 'pdf_tables'); assert.equal(tables.tables.length, 1); assert.deepEqual(tables.tables[0].bbox, [50, 100, 250, 200]);
  const selected = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 1, tableIndex: 1 });
  assert.equal(selected.location_kind, 'pdf_table'); assert.equal(selected.cells.length, 4);
  const cell = selected.cells.find((item) => item.text === 'North'); assert.ok(cell?.ref);
  const cellFacts = JSON.parse(Buffer.from(cell.ref, 'base64url').toString('utf8'));
  assert.match(cellFacts.table_structure_sha256 ?? '', /^[a-f0-9]{64}$/u);
  const exactCell = f.service.readRef({ projectId: f.project.project_id, ref: cell.ref });
  assert.equal(exactCell.status, 'current'); assert.equal(exactCell.text, 'North'); assert.equal(exactCell.table_index, 1);
  const wrongStructureRef = Buffer.from(JSON.stringify({ ...cellFacts, table_structure_sha256: '0'.repeat(64) }), 'utf8').toString('base64url');
  const wrongStructure = f.service.readRef({ projectId: f.project.project_id, ref: wrongStructureRef });
  assert.equal(wrongStructure.status, 'extraction_changed'); assert.equal(wrongStructure.text, null);
  assert.throws(() => f.service.readRef({ projectId: 'PRJ-other', ref: cell.ref }), { code: 'ATLAS_STATE_CONFLICT' });
  const hostTables = cli(f.stateDir, ['content', 'locate', '--project', f.project.project_id, '--resource', f.resourceId, '--page', '1', '--tables', '--json']);
  assert.equal(hostTables.status, 0, `${hostTables.stderr}\n${hostTables.stdout}`); assert.equal(JSON.parse(hostTables.stdout).data.tables.length, 1);
  const hostCell = cli(f.stateDir, ['content', 'read-ref', '--project', f.project.project_id, '--ref', cell.ref, '--json']);
  assert.equal(hostCell.status, 0, `${hostCell.stderr}\n${hostCell.stdout}`); assert.equal(JSON.parse(hostCell.stdout).data.text, 'North');
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 1, x: 50, y: 100 }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.service.locate({ projectId: 'PRJ-other', resourceId: f.resourceId, page: 1, x: 50, y: 100, width: 200, height: 100 }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 1, x: -1, y: 100, width: 200, height: 100 }), { code: 'ATLAS_STATE_CONFLICT' });
  const noTables = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 2, tables: true });
  assert.equal(noTables.tables.length, 0); assert.equal(noTables.status, 'no_tables');
  assert.equal(fs.readFileSync(f.filePath).equals(original), true);
  createPdf(f.filePath, true);
  const staleRegion = f.service.readRef({ projectId: f.project.project_id, ref: region.ref }); assert.equal(staleRegion.status, 'stale'); assert.equal(staleRegion.text, null);
  const staleCell = f.service.readRef({ projectId: f.project.project_id, ref: cell.ref }); assert.equal(staleCell.status, 'stale'); assert.equal(staleCell.text, null);
});
