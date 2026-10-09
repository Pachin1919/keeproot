import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { startAtlasUiServer } from '../src/ui-server.js';

const pythonPath = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));
function makeXlsx(filePath, changed = false) {
  const script = String.raw`
import sys,zipfile
visible='<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>HTML单元格</t></is></c></row><row r="1001"><c r="A1001" t="inlineStr"><is><t>远处HTML值</t></is></c></row></sheetData></worksheet>'
if sys.argv[2]=='1': visible=visible.replace('远处HTML值','更新后的HTML值')
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="公交表" sheetId="1" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'); z.writestr('xl/worksheets/sheet1.xml',visible)
`;
  const result = spawnSync(pythonPath, ['-c', script, filePath, changed ? '1' : '0'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }); assert.equal(result.status, 0, result.stderr);
}

test('Project Resources opens the same XLSX Sheet/cell ref and hides old values after workbook changes', async (t) => {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-xlsx-ui-')); const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '城市项目'); fs.mkdirSync(projectRoot, { recursive: true });
  const filePath = path.join(projectRoot, '公交数据.xlsx'); makeXlsx(filePath);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市项目', currentPath: '城市项目' }); registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市项目', reason: 'XLSX content location UI.' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const intake = new Intake({ stateDir }); const priorPython = process.env.ATLAS_PYTHON; process.env.ATLAS_PYTHON = pythonPath;
  const server = await startAtlasUiServer({ stateDir, registry, intake, resourceControl: control, projectRoot: workspace, installationRoot: workspace });
  t.after(async () => { await server.close(); intake.dispose(); control.dispose(); registry.dispose(); if (priorPython == null) delete process.env.ATLAS_PYTHON; else process.env.ATLAS_PYTHON = priorPython; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const projectId = encodeURIComponent(project.project_id); const resources = await (await fetch(new URL(`projects/${projectId}/resources?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url))).text();
  assert.match(resources, /content-location\?resource_id=/u);
  const listUrl = new URL(`projects/${projectId}/content-location?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url);
  const listResponse = await fetch(listUrl); assert.equal(listResponse.status, 200); const list = await listResponse.text();
  assert.match(list, /公交表/u); assert.match(list, /select|选择/u); assert.match(list, /cell|单元格/u);
  const directUrl = new URL(listUrl); directUrl.searchParams.set('sheet', '公交表'); directUrl.searchParams.set('cell', 'A1001');
  const directResponse = await fetch(directUrl); assert.equal(directResponse.status, 200); const direct = await directResponse.text();
  assert.match(direct, /远处HTML值/u); const refMatch = direct.match(/href="[^"]*content-location\?ref=([^&"]+)/u); assert.ok(refMatch);
  const ref = decodeURIComponent(refMatch[1]); const exact = await fetch(new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(ref)}`, server.workspace_url));
  assert.equal(exact.status, 200); const exactHtml = await exact.text();
  assert.match(exactHtml, /远处HTML值/u); assert.match(exactHtml, /公交表 · A1001/u);
  assert.doesNotMatch(exactHtml, /\[object Object\]/u);
  makeXlsx(filePath, true); const stale = await fetch(new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(ref)}`, server.workspace_url));
  assert.equal(stale.status, 200); const staleHtml = await stale.text(); assert.match(staleHtml, /expired|过期/u); assert.doesNotMatch(staleHtml, /远处HTML值/u);
});
