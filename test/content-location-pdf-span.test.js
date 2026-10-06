import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';

const pythonPath = path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe');
const pythonSourceRoot = path.resolve('python/src');
function createPdf(target, changed = false) {
  const script = String.raw`
import sys
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, EncodedStreamObject, NameObject, NumberObject, TextStringObject
writer=PdfWriter(); page=writer.add_blank_page(width=612,height=792)
source=('路'*1200)+'🚦'+('公交'*1200)
if sys.argv[2]=='1': source=source[:-1]+'车'
chars=sorted(set(source)); ids={char:index+1 for index,char in enumerate(chars)}
parts=['/CIDInit /ProcSet findresource begin','12 dict begin','begincmap','/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def','/CMapName /Adobe-Identity-UCS def','/CMapType 2 def','1 begincodespacerange','<0000> <FFFF>','endcodespacerange',str(len(chars))+' beginbfchar']
for char,cid in ids.items(): parts.append('<%04X> <%s>'%(cid,char.encode('utf-16-be').hex().upper()))
parts += ['endbfchar','endcmap','CMapName currentdict /CMap defineresource pop','end','end']
cmap=DecodedStreamObject(); cmap.set_data(('\n'.join(parts)).encode('ascii')); cmap_ref=writer._add_object(cmap)
info=DictionaryObject({NameObject('/Registry'):TextStringObject('Adobe'),NameObject('/Ordering'):TextStringObject('Identity'),NameObject('/Supplement'):NumberObject(0)})
cidfont=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/CIDFontType2'),NameObject('/BaseFont'):NameObject('/AtlasUnicode'),NameObject('/CIDSystemInfo'):info,NameObject('/DW'):NumberObject(500)})
cid_ref=writer._add_object(cidfont)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type0'),NameObject('/BaseFont'):NameObject('/AtlasUnicode'),NameObject('/Encoding'):NameObject('/Identity-H'),NameObject('/DescendantFonts'):ArrayObject([cid_ref]),NameObject('/ToUnicode'):cmap_ref})
font_ref=writer._add_object(font); page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F0'):font_ref})})
content=DecodedStreamObject(); content.set_data(('BT /F0 10 Tf 1 0 0 1 30 740 Tm <%s> Tj ET'%''.join('%04X'%ids[c] for c in source)).encode('ascii')); page[NameObject('/Contents')]=writer._add_object(content)
image_page=writer.add_blank_page(width=612,height=792)
img=DecodedStreamObject(); img.set_data(bytes([128])); img.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Image'),NameObject('/Width'):NumberObject(1),NameObject('/Height'):NumberObject(1),NameObject('/ColorSpace'):NameObject('/DeviceGray'),NameObject('/BitsPerComponent'):NumberObject(8)})
image_ref=writer._add_object(img); image_page[NameObject('/Resources')]=DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Im0'):image_ref})})
broken=writer.add_blank_page(width=612,height=792)
broken[NameObject('/Resources')]=page[NameObject('/Resources')]
broken_stream=EncodedStreamObject(); broken_stream._data=b'BT ET'; broken_stream[NameObject('/Filter')]=NameObject('/AtlasUnsupported')
broken[NameObject('/Contents')]=writer._add_object(broken_stream)
with open(sys.argv[1],'wb') as stream: writer.write(stream)
`;
  const result = spawnSync(pythonPath, ['-c', script, target, changed ? '1' : '0'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}
function fixture(t) {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-pdf-span-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '交通资料');
  fs.mkdirSync(projectRoot, { recursive: true }); const filePath = path.join(projectRoot, '长文字.pdf'); createPdf(filePath);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '交通资料', currentPath: '交通资料' }); registry.attachRoot(project.project_id,
    { rootId: adopted.root_id, relativePath: '交通资料', reason: 'PDF page text continuation.' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const service = createContentLocationService({ registry, resourceControl: control, pythonPath, pythonSourceRoot });
  t.after(() => { service.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, workspace, projectRoot, filePath, registry, project, control, resourceId, service };
}
const cliPath = path.resolve('bin/atlas.js');
function cli(stateDir, args) { return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, ATLAS_STATE_DIR: stateDir, ATLAS_CONTENT_PYTHON: pythonPath, ATLAS_PYTHON: pythonPath } }); }

test('Host and service continue exact Unicode PDF page spans and invalidate refs after source change', (t) => {
  const f = fixture(t);
  const first = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 1 });
  assert.equal(first.format, 'pdf'); assert.equal(first.status, 'text_layer'); assert.equal(first.basis, 'extracted_text');
  assert.equal(first.reading_order, 'unverified'); assert.equal(first.spatial_mapping, 'unsupported'); assert.equal(first.table_structure, 'unsupported'); assert.equal(first.ocr_used, false);
  assert.equal([...first.text].length, 1200); assert.equal(first.start_codepoint, 0); assert.equal(first.end_codepoint, 1200);
  assert.ok(first.next_cursor); assert.ok(first.ref);
  const second = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 1, cursor: first.next_cursor });
  assert.equal(second.start_codepoint, 1200); assert.equal([...second.text][0], '🚦'); assert.equal([...second.text].length, 1200); assert.notEqual(second.ref, first.ref);
  const third = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 1, cursor: second.next_cursor });
  assert.equal(third.start_codepoint, 2400); assert.equal([...third.text].length, 1200); assert.ok(third.next_cursor);
  const fourth = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 1, cursor: third.next_cursor });
  assert.equal(fourth.start_codepoint, 3600); assert.equal([...fourth.text].length, 1); assert.equal(fourth.next_cursor, null);
  const exact = f.service.readRef({ projectId: f.project.project_id, ref: second.ref });
  assert.equal(exact.status, 'current'); assert.equal(exact.text, second.text); assert.equal(exact.start_codepoint, 1200);
  assert.throws(() => f.service.readRef({ projectId: 'PRJ-other', ref: second.ref }), { code: 'ATLAS_STATE_CONFLICT' });
  const host = cli(f.stateDir, ['content', 'locate', '--project', f.project.project_id, '--resource', f.resourceId, '--page', '1', '--json']);
  assert.equal(host.status, 0, `${host.stderr}\n${host.stdout}`); assert.equal(JSON.parse(host.stdout).data.text, first.text);
  const hostRead = cli(f.stateDir, ['content', 'read-ref', '--project', f.project.project_id, '--ref', second.ref, '--json']);
  assert.equal(hostRead.status, 0, `${hostRead.stderr}\n${hostRead.stdout}`); assert.equal(JSON.parse(hostRead.stdout).data.text, second.text);
  const image = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 2 });
  assert.equal(image.status, 'image_only'); assert.equal(image.text, null); assert.equal(image.ref, null);
  const failed = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, page: 3 });
  assert.equal(failed.status, 'extraction_failed'); assert.equal(failed.text, null); assert.equal(failed.ref, null);
  createPdf(f.filePath, true);
  const stale = f.service.readRef({ projectId: f.project.project_id, ref: second.ref }); assert.equal(stale.status, 'stale'); assert.equal(stale.text, null);
});
