import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';
import { createProjectViewService } from '../src/project-view-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';

const pythonPath = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));
function makeBook(file) {
  const script = String.raw`import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="公交排班" sheetId="1" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>线路键</t></is></c><c r="B1" t="inlineStr"><is><t>区域</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>K-1</t></is></c><c r="B2" t="inlineStr"><is><t>North</t></is></c></row></sheetData></worksheet>')`;
  const result = spawnSync(pythonPath, ['-c', script, file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}

test('Project Resources reviews and reads back the same row candidate without changing the XLSX', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/row-candidate-ui-'));
  const priorPython = process.env.ATLAS_PYTHON; process.env.ATLAS_PYTHON = pythonPath;
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'A');
  fs.mkdirSync(projectRoot, { recursive: true }); const book = path.join(projectRoot, 'routes.xlsx'); makeBook(book);
  const original = fs.readFileSync(book); const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' }); registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'row candidate UI' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath: book, project: registry.show(project.project_id).project }).resource_id;
  const service = createProjectViewService({ stateDir, registry }); const property = service.defineProperty({ projectId: project.project_id, name: '区域', kind: 'text' });
  const locations = createContentLocationService({ registry, resourceControl: control, pythonPath });
  const snapshot = locations.locateXlsxRow({ projectId: project.project_id, resourceId, sheet: '公交排班', key: { column: 'A', value: 'K-1' } });
  const batch = service.submitRowPropertyCandidates({ projectId: project.project_id, propertyId: property.property_id, promptVersion: 'p1',
    candidates: [{ resource_id: resourceId, sheet: '公交排班', key: { column: 'A', value: 'K-1' }, value: '北区', source_version: snapshot.row_sha256, evidence: { summary: '单元格B2', cells: ['B2'] } }],
    caller: { tool: 'codex', model: 'test', client_run_id: 'ui-row' } });
  const server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, projectRoot: root, installationRoot: root, resourceControl: control });
  t.after(async () => { await server.close(); locations.dispose(); service.dispose(); control.dispose(); registry.dispose(); if (priorPython == null) delete process.env.ATLAS_PYTHON; else process.env.ATLAS_PYTHON = priorPython; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const pageUrl = new URL(`/projects/${project.project_id}/resources?mode=table`, server.workspace_url);
  const html = await (await fetch(pageUrl)).text(); const candidate = batch.candidates[0];
  assert.match(html, new RegExp(candidate.candidate_id)); assert.match(html, /K-1/u); assert.match(html, /北区/u); assert.match(html, /Spreadsheet row suggestions/u);
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const response = await fetch(new URL(`/projects/${project.project_id}/resources/row-candidates/decide`, server.workspace_url), { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, candidate_id: candidate.candidate_id,
      expected_revision: String(candidate.revision), expected_row_version: candidate.row_sha256, action: 'accept' }) });
  assert.equal(response.status, 303);
  const shown = service.rowPropertyCandidateBatch({ projectId: project.project_id, batchId: batch.batch_id }).candidates[0];
  assert.equal(shown.candidate_id, candidate.candidate_id); assert.equal(shown.status, 'accepted'); assert.equal(shown.accepted_row_value.value, '北区');
  assert.deepEqual(fs.readFileSync(book), original);
});
