import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';

const pythonPath = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));
const pythonSourceRoot = path.resolve('python/src');

function createPdf(target) {
  const script = String.raw`
import sys
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject
writer = PdfWriter()
page = writer.add_blank_page(width=612, height=792)
font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
font_ref = writer._add_object(font)
page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font_ref})})
content = DecodedStreamObject(); content.set_data(b'BT /F1 12 Tf 72 720 Td (Bus schedule page one) Tj ET')
page[NameObject('/Contents')] = writer._add_object(content)
image_page = writer.add_blank_page(width=612, height=792)
image = DecodedStreamObject(); image.set_data(bytes([128]))
image.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'), NameObject('/Width'): NumberObject(1), NameObject('/Height'): NumberObject(1), NameObject('/ColorSpace'): NameObject('/DeviceGray'), NameObject('/BitsPerComponent'): NumberObject(8)})
image_ref = writer._add_object(image)
image_page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): DictionaryObject({NameObject('/Im0'): image_ref})})
with open(sys.argv[1], 'wb') as stream: writer.write(stream)
`;
  const result = spawnSync(pythonPath, ['-c', script, target], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(t) {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-pdf-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '城市研究'); const filePath = path.join(projectRoot, '公交时刻表.pdf');
  fs.mkdirSync(projectRoot, { recursive: true }); createPdf(filePath);
  const sourceBytes = fs.readFileSync(filePath);
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市研究', currentPath: '城市研究' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市研究', reason: 'PDF page reference fixture.' });
  const control = new ResourceControl({ stateDir, registry });
  const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const service = createContentLocationService({ registry, resourceControl: control, pythonPath, pythonSourceRoot });
  t.after(() => { service.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, workspace, projectRoot, filePath, sourceBytes, registry, project, control, resourceId, service };
}

const cliPath = path.resolve('bin/atlas.js');
function cli(stateDir, args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, ATLAS_STATE_DIR: stateDir, ATLAS_PYTHON: pythonPath } });
}

test('Host and service return exact PDF page refs; image-only pages keep their page number and stale refs expose no text', (t) => {
  const f = fixture(t);
  const before = crypto.createHash('sha256').update(f.sourceBytes).digest('hex');
  const listed = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, limit: 50 });
  assert.equal(listed.file.sha256, before);
  assert.equal(listed.page_count, 2);
  assert.equal(listed.pages.length, 2);
  assert.deepEqual(listed.pages.map((page) => [page.page, page.status]), [[1, 'text_layer'], [2, 'image_only']]);
  assert.match(listed.pages[0].text, /Bus schedule page one/u);
  assert.equal(listed.pages[1].text, null);
  assert.ok(listed.pages[0].ref); assert.ok(listed.pages[1].ref);
  assert.equal(fs.readFileSync(f.filePath).equals(f.sourceBytes), true);

  const hostList = cli(f.stateDir, ['content', 'locate', '--project', f.project.project_id, '--resource', f.resourceId, '--json']);
  assert.equal(hostList.status, 0, `${hostList.stderr}\n${hostList.stdout}`);
  const hostData = JSON.parse(hostList.stdout).data;
  assert.equal(hostData.pages[1].page, 2); assert.equal(hostData.pages[1].status, 'image_only');
  const hostRead = cli(f.stateDir, ['content', 'read-ref', '--project', f.project.project_id, '--ref', listed.pages[0].ref, '--json']);
  assert.equal(hostRead.status, 0, `${hostRead.stderr}\n${hostRead.stdout}`);
  assert.equal(JSON.parse(hostRead.stdout).data.text, listed.pages[0].text);
  const imageRead = f.service.readRef({ projectId: f.project.project_id, ref: listed.pages[1].ref });
  assert.equal(imageRead.status, 'image_only'); assert.equal(imageRead.page, 2); assert.equal(imageRead.text, null);

  fs.writeFileSync(f.filePath, Buffer.concat([f.sourceBytes, Buffer.from('\n% changed\n')]));
  const stale = f.service.readRef({ projectId: f.project.project_id, ref: listed.pages[0].ref });
  assert.equal(stale.status, 'stale'); assert.equal(stale.text, null);
});

test('PDF page refs reject a different Project and a Markdown-shaped ref', (t) => {
  const f = fixture(t);
  const listed = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId });
  assert.throws(() => f.service.readRef({ projectId: 'PRJ-other', ref: listed.pages[0].ref }), { code: 'ATLAS_STATE_CONFLICT' });
  const forged = Buffer.from(JSON.stringify({ version: 1, project_id: f.project.project_id,
    resource_id: f.resourceId, file_sha256: listed.file.sha256, start_line: 1, end_line: 1,
    block_sha256: '0'.repeat(64) }), 'utf8').toString('base64url');
  assert.throws(() => f.service.readRef({ projectId: f.project.project_id, ref: forged }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('Damaged PDF cannot produce a page Ref or claim extracted text', (t) => {
  const f = fixture(t);
  const damaged = Buffer.from('%PDF-1.7\nthis is not a readable PDF\n', 'ascii');
  fs.writeFileSync(f.filePath, damaged);
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId }),
    /PDF page extraction failed|PDF changed during extraction|unavailable/iu);
  assert.deepEqual(fs.readFileSync(f.filePath), damaged);
});
