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
function makeDocx(filePath, changed = false) {
  const script = String.raw`
import sys,zipfile
from xml.sax.saxutils import escape
def p(s): return '<w:p><w:r><w:t>'+escape(s)+'</w:t></w:r></w:p>'
cell='<w:tc>'+p('表格定位内容')+'<w:p/></w:tc>'
body=p('HTML正文一')+p('HTML正文二')+'<w:tbl><w:tr>'+cell+'<w:tc>'+p('右侧单元格')+'</w:tc></w:tr></w:tbl>'
xml='<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'</w:body></w:document>'
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'); z.writestr('word/document.xml',xml.replace('HTML正文二','修改后的段落') if sys.argv[2]=='1' else xml)
`;
  const result = spawnSync(pythonPath, ['-c', script, filePath, changed ? '1' : '0'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}

test('Project Resources opens the same DOCX paragraph and table-cell refs; stale refs show no old text', async (t) => {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-docx-ui-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '城市项目');
  fs.mkdirSync(projectRoot, { recursive: true }); const filePath = path.join(projectRoot, '会议.docx'); makeDocx(filePath);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市项目', currentPath: '城市项目' }); registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市项目', reason: 'DOCX UI location.' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const intake = new Intake({ stateDir }); const priorPython = process.env.ATLAS_PYTHON; process.env.ATLAS_PYTHON = pythonPath;
  const server = await startAtlasUiServer({ stateDir, registry, intake, resourceControl: control, projectRoot: workspace, installationRoot: workspace });
  t.after(async () => { await server.close(); intake.dispose(); control.dispose(); registry.dispose(); if (priorPython == null) delete process.env.ATLAS_PYTHON; else process.env.ATLAS_PYTHON = priorPython; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const projectId = encodeURIComponent(project.project_id);
  const resources = await (await fetch(new URL(`projects/${projectId}/resources?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url))).text();
  assert.match(resources, /content-location\?resource_id=/u);
  const listResponse = await fetch(new URL(`projects/${projectId}/content-location?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url));
  assert.equal(listResponse.status, 200); const listHtml = await listResponse.text(); assert.match(listHtml, /HTML正文一/u); assert.match(listHtml, /表格定位内容/u);
  const refs = [...listHtml.matchAll(/href="[^"]*content-location\?ref=([^&"]+)/gu)].map((m) => decodeURIComponent(m[1])); assert.equal(refs.length, 4);
  const exactResponse = await fetch(new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(refs[2])}`, server.workspace_url));
  assert.equal(exactResponse.status, 200); const exactHtml = await exactResponse.text(); assert.match(exactHtml, /表格定位内容/u); assert.match(exactHtml, /row|行/u); assert.match(exactHtml, /column|列/u);
  makeDocx(filePath, true);
  const staleResponse = await fetch(new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(refs[0])}`, server.workspace_url));
  assert.equal(staleResponse.status, 200); const staleHtml = await staleResponse.text(); assert.match(staleHtml, /expired|过期/u); assert.doesNotMatch(staleHtml, /HTML正文一/u);
});
