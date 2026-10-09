import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';

const pythonPath = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));
const pythonSourceRoot = path.resolve('python/src');
function makeXlsx(filePath, changed = false) {
  const script = String.raw`
import sys,zipfile
from xml.sax.saxutils import escape
visible='''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D1001"/><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>公交线路</t></is></c></row>
<row r="2"><c r="B2"><f>1+1</f></c><c r="C2"><f>40+2</f><v>42</v></c><c r="D2"/></row>
<row r="1001"><c r="A1001" t="inlineStr"><is><t>远处坐标命中</t></is></c></row></sheetData></worksheet>'''
hidden='<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>隐藏数据</t></is></c></row></sheetData></worksheet>'
if sys.argv[2]=='1': visible=visible.replace('公交线路','公交线路更新')
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="线路数据" sheetId="1" r:id="rId1"/><sheet name="内部隐藏" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml',visible); z.writestr('xl/worksheets/sheet2.xml',hidden)
`;
  const result = spawnSync(pythonPath, ['-c', script, filePath, changed ? '1' : '0'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}
function fixture(t) {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-xlsx-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '城市研究');
  const filePath = path.join(projectRoot, '公交数据.xlsx'); fs.mkdirSync(projectRoot, { recursive: true }); makeXlsx(filePath);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市研究', currentPath: '城市研究' }); registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市研究', reason: 'XLSX exact cell location.' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const service = createContentLocationService({ registry, resourceControl: control, pythonPath, pythonSourceRoot });
  t.after(() => { service.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, workspace, projectRoot, filePath, registry, project, control, resourceId, service };
}
const cliPath = path.resolve('bin/atlas.js');
function cli(stateDir, args) { return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, ATLAS_STATE_DIR: stateDir, ATLAS_PYTHON: pythonPath } }); }

test('Host reads exact XLSX sheets and distant cells with cached/formula status; old refs stale on workbook changes', (t) => {
  const f = fixture(t); const original = fs.readFileSync(f.filePath); const fileHash = crypto.createHash('sha256').update(original).digest('hex');
  const overview = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId });
  assert.equal(overview.format, 'xlsx'); assert.deepEqual(overview.sheets.map(({ name, visibility }) => [name, visibility]), [['线路数据', 'visible'], ['内部隐藏', 'hidden']]);
  const sample = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, sheet: '线路数据', limit: 50 });
  assert.equal(sample.file.sha256, fileHash);
  assert.deepEqual(sample.selected_sheet, { name: '线路数据', visibility: 'visible', status: 'available' });
  assert.equal(sample.cells.find((cell) => cell.cell === 'B2').status, 'formula_no_cache');
  assert.equal(sample.cells.find((cell) => cell.cell === 'B2').value, null);
  assert.equal(sample.cells.find((cell) => cell.cell === 'C2').status, 'formula_cached');
  assert.equal(sample.cells.find((cell) => cell.cell === 'C2').value, '42');
  assert.equal(sample.cells.find((cell) => cell.cell === 'D2').status, 'empty');
  const distant = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, sheet: '线路数据', cell: 'A1001' });
  assert.equal(distant.cells[0].cell, 'A1001'); assert.equal(distant.cells[0].value, '远处坐标命中'); assert.ok(distant.cells[0].ref);
  const read = f.service.readRef({ projectId: f.project.project_id, ref: distant.cells[0].ref });
  assert.equal(read.status, 'current'); assert.equal(read.sheet, '线路数据'); assert.equal(read.cell, 'A1001'); assert.equal(read.value, '远处坐标命中');
  assert.throws(() => f.service.readRef({ projectId: 'PRJ-foreign', ref: distant.cells[0].ref }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, sheet: '线路数据', cell: 'A0' }), { code: 'ATLAS_STATE_CONFLICT' });
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); const outsideBook = path.join(outside, 'linked.xlsx'); fs.copyFileSync(f.filePath, outsideBook);
  const linkedDir = path.join(f.projectRoot, 'linked'); fs.symlinkSync(outside, linkedDir, 'junction');
  const linkedId = f.control.identify({ filePath: path.join(linkedDir, 'linked.xlsx'), project: f.registry.show(f.project.project_id).project }).resource_id;
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: linkedId }), { code: 'ATLAS_STATE_CONFLICT' });
  const host = cli(f.stateDir, ['content', 'locate', '--project', f.project.project_id, '--resource', f.resourceId, '--sheet', '线路数据', '--cell', 'A1001', '--json']);
  assert.equal(host.status, 0, `${host.stderr}\n${host.stdout}`); assert.equal(JSON.parse(host.stdout).data.cells[0].value, '远处坐标命中');
  const hostRead = cli(f.stateDir, ['content', 'read-ref', '--project', f.project.project_id, '--ref', distant.cells[0].ref, '--json']);
  assert.equal(hostRead.status, 0, `${hostRead.stderr}\n${hostRead.stdout}`); assert.equal(JSON.parse(hostRead.stdout).data.value, read.value);
  makeXlsx(f.filePath, true);
  const stale = f.service.readRef({ projectId: f.project.project_id, ref: distant.cells[0].ref }); assert.equal(stale.status, 'stale'); assert.equal(stale.text, null); assert.equal(stale.value, null);
});
