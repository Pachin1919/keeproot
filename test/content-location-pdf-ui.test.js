import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { startAtlasUiServer } from '../src/ui-server.js';

const pythonPath = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));
function createPdf(target) {
  const script = String.raw`
import sys
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject
writer=PdfWriter(); page=writer.add_blank_page(width=612,height=792)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}); font_ref=writer._add_object(font)
page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font_ref})})
content=DecodedStreamObject(); content.set_data(b'BT /F1 12 Tf 72 720 Td (HTML PDF page one) Tj ET'); page[NameObject('/Contents')]=writer._add_object(content)
image_page=writer.add_blank_page(width=612,height=792); image=DecodedStreamObject(); image.set_data(bytes([128]))
image.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Image'),NameObject('/Width'):NumberObject(1),NameObject('/Height'):NumberObject(1),NameObject('/ColorSpace'):NameObject('/DeviceGray'),NameObject('/BitsPerComponent'):NumberObject(8)})
image_ref=writer._add_object(image); image_page[NameObject('/Resources')]=DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Im0'):image_ref})})
with open(sys.argv[1],'wb') as stream: writer.write(stream)
`;
  const result = spawnSync(pythonPath, ['-c', script, target], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}

test('Project Resources opens a PDF page ref and shows stale after PDF bytes change', async (t) => {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-pdf-ui-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '研究项目');
  fs.mkdirSync(projectRoot, { recursive: true });
  const filePath = path.join(projectRoot, '公交.pdf'); createPdf(filePath); const original = fs.readFileSync(filePath);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '研究项目', currentPath: '研究项目' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '研究项目', reason: 'PDF page location UI fixture.' });
  const control = new ResourceControl({ stateDir, registry });
  const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const intake = new Intake({ stateDir }); const priorPython = process.env.ATLAS_PYTHON;
  process.env.ATLAS_PYTHON = pythonPath;
  const server = await startAtlasUiServer({ stateDir, registry, intake, resourceControl: control, projectRoot: workspace, installationRoot: workspace });
  t.after(async () => {
    await server.close(); intake.dispose(); control.dispose(); registry.dispose();
    if (priorPython == null) delete process.env.ATLAS_PYTHON; else process.env.ATLAS_PYTHON = priorPython;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const projectId = encodeURIComponent(project.project_id);
  const resourcesResponse = await fetch(new URL(`projects/${projectId}/resources?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url));
  assert.equal(resourcesResponse.status, 200); const resources = await resourcesResponse.text();
  assert.match(resources, /content-location\?resource_id=/u);
  const pageResponse = await fetch(new URL(`projects/${projectId}/content-location?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url));
  assert.equal(pageResponse.status, 200); const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /HTML PDF page one/u); assert.match(pageHtml, /Image-only page|图像页/u);
  const refs = [...pageHtml.matchAll(/href="[^"]*content-location\?ref=([^&"]+)/gu)].map((item) => decodeURIComponent(item[1]));
  assert.equal(refs.length, 2);
  const cliRead = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'content', 'read-ref', '--project', project.project_id,
    '--ref', refs[1], '--json'], { encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, ATLAS_STATE_DIR: stateDir, ATLAS_PYTHON: pythonPath } });
  assert.equal(cliRead.status, 0, `${cliRead.stderr}\n${cliRead.stdout}`);
  const hostPage = JSON.parse(cliRead.stdout).data;
  assert.equal(hostPage.page, 2); assert.equal(hostPage.status, 'image_only'); assert.equal(hostPage.text, null);
  const exactResponse = await fetch(new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(refs[1])}`, server.workspace_url));
  assert.equal(exactResponse.status, 200); const exactHtml = await exactResponse.text();
  assert.match(exactHtml, /Image-only page|图像页/u); assert.doesNotMatch(exactHtml, /HTML PDF page one/u);

  fs.writeFileSync(filePath, Buffer.concat([original, Buffer.from('\n% changed\n')]));
  const staleResponse = await fetch(new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(refs[0])}`, server.workspace_url));
  assert.equal(staleResponse.status, 200); const stale = await staleResponse.text();
  assert.match(stale, /expired|过期/u); assert.doesNotMatch(stale, /HTML PDF page one/u);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), crypto.createHash('sha256').update(Buffer.concat([original, Buffer.from('\n% changed\n')])).digest('hex'));
});
