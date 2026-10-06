import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { startAtlasUiServer } from '../src/ui-server.js';

const pythonPath = path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe');
function createPdf(target, changed = false) {
  const script = String.raw`
import sys
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
writer=PdfWriter(); page=writer.add_blank_page(width=300,height=400)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}); font_ref=writer._add_object(font)
page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font_ref})})
ops=['0.5 w','50 200 m 250 200 l S','50 250 m 250 250 l S','50 300 m 250 300 l S','50 200 m 50 300 l S','150 200 m 150 300 l S','250 200 m 250 300 l S']
for x,y,value in [(62,282,'North'),(162,282,'11'),(62,232,'South'),(162,232,'21')]: ops.append('BT /F1 12 Tf %s %s Td (%s%s) Tj ET'%(x,y,value,' changed' if sys.argv[2]=='1' and value=='North' else ''))
content=DecodedStreamObject(); content.set_data(('\n'.join(ops)).encode('ascii')); page[NameObject('/Contents')]=writer._add_object(content)
writer.add_blank_page(width=300,height=400)
with open(sys.argv[1],'wb') as stream: writer.write(stream)
`;
  const result = spawnSync(pythonPath, ['-c', script, target, changed ? '1' : '0'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}

test('Project Resources reads PDF region and table-cell Refs and hides both after source changes', async (t) => {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-pdf-region-ui-')); const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '城市表格'); fs.mkdirSync(projectRoot, { recursive: true });
  const filePath = path.join(projectRoot, '公交表格.pdf'); createPdf(filePath); const original = fs.readFileSync(filePath);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市表格', currentPath: '城市表格' }); registry.attachRoot(project.project_id,
    { rootId: adopted.root_id, relativePath: '城市表格', reason: 'PDF region and table UI fixture.' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const intake = new Intake({ stateDir }); const oldPython = process.env.ATLAS_PYTHON; const oldContentPython = process.env.ATLAS_CONTENT_PYTHON;
  process.env.ATLAS_PYTHON = pythonPath; process.env.ATLAS_CONTENT_PYTHON = pythonPath;
  const server = await startAtlasUiServer({ stateDir, registry, intake, resourceControl: control, projectRoot: workspace, installationRoot: workspace });
  t.after(async () => { await server.close(); intake.dispose(); control.dispose(); registry.dispose();
    if (oldPython == null) delete process.env.ATLAS_PYTHON; else process.env.ATLAS_PYTHON = oldPython;
    if (oldContentPython == null) delete process.env.ATLAS_CONTENT_PYTHON; else process.env.ATLAS_CONTENT_PYTHON = oldContentPython;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const projectId = encodeURIComponent(project.project_id);
  const resourcePage = await fetch(new URL(`projects/${projectId}/resources?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url));
  assert.equal(resourcePage.status, 200); assert.match(await resourcePage.text(), /content-location\?resource_id=/u);
  const pageResponse = await fetch(new URL(`projects/${projectId}/content-location?resource_id=${encodeURIComponent(resourceId)}&page=1`, server.workspace_url));
  assert.equal(pageResponse.status, 200);
  assert.doesNotMatch(await pageResponse.text(), /Spatial mapping and table structure are unsupported/u);
  const regionUrl = new URL(`projects/${projectId}/content-location?resource_id=${encodeURIComponent(resourceId)}&page=1&x=50&y=100&width=200&height=100`, server.workspace_url);
  const regionResponse = await fetch(regionUrl); assert.equal(regionResponse.status, 200); const regionHtml = await regionResponse.text();
  assert.match(regionHtml, /data-pdf-region-result/u); assert.match(regionHtml, /North/u); assert.match(regionHtml, /South/u);
  assert.match(regionHtml, /50, 100/u); assert.match(regionHtml, /200 × 100/u); assert.match(regionHtml, /Open this exact location|打开此精确位置/u);
  const regionRef = decodeURIComponent(regionHtml.match(/href="[^"]*content-location\?ref=([^&"]+)/u)[1]);
  const tableUrl = new URL(`projects/${projectId}/content-location?resource_id=${encodeURIComponent(resourceId)}&page=1&tables=1`, server.workspace_url);
  const tableResponse = await fetch(tableUrl); assert.equal(tableResponse.status, 200); const tableHtml = await tableResponse.text();
  assert.match(tableHtml, /data-pdf-table-result/u); assert.match(tableHtml, /Table 1/u);
  const selectedTableHref = decodeURIComponent(tableHtml.match(/href="([^"]*table_index=1[^"]*)"/u)[1].replaceAll('&amp;', '&'));
  const selectedTableResponse = await fetch(new URL(selectedTableHref, server.workspace_url));
  assert.equal(selectedTableResponse.status, 200); const selectedTableHtml = await selectedTableResponse.text();
  assert.match(selectedTableHtml, /data-pdf-table-result/u); assert.match(selectedTableHtml, /North/u); assert.match(selectedTableHtml, /South/u);
  assert.match(selectedTableHtml, /North.*11/u); assert.match(selectedTableHtml, /South.*21/u);
  assert.doesNotMatch(selectedTableHtml, /Paragraph content_location\.undefined|No text was extracted from this page/u);
  const cellRef = decodeURIComponent(selectedTableHtml.match(/href="[^"]*content-location\?ref=([^&"]+)/u)[1]);
  const cellRead = await fetch(new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(cellRef)}`, server.workspace_url));
  assert.equal(cellRead.status, 200); assert.match(await cellRead.text(), /North/u);
  createPdf(filePath, true);
  const staleRegion = await fetch(new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(regionRef)}`, server.workspace_url));
  assert.equal(staleRegion.status, 200); const staleRegionHtml = await staleRegion.text(); assert.match(staleRegionHtml, /expired|过期/u); assert.doesNotMatch(staleRegionHtml, /North/u);
  const staleCell = await fetch(new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(cellRef)}`, server.workspace_url));
  assert.equal(staleCell.status, 200); const staleCellHtml = await staleCell.text(); assert.match(staleCellHtml, /expired|过期/u); assert.doesNotMatch(staleCellHtml, /North/u);
  assert.equal(fs.readFileSync(filePath).equals(original), false);
});
