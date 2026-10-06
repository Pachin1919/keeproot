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
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, TextStringObject
w=PdfWriter(); p=w.add_blank_page(width=612,height=792); text=('路'*1200)+'🚦'+('公交'*1200)
if sys.argv[2]=='1': text=text[:-1]+'车'
chars=sorted(set(text)); ids={c:i+1 for i,c in enumerate(chars)}
lines=['/CIDInit /ProcSet findresource begin','12 dict begin','begincmap','/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def','/CMapName /Adobe-Identity-UCS def','/CMapType 2 def','1 begincodespacerange','<0000> <FFFF>','endcodespacerange',str(len(chars))+' beginbfchar']
for c,i in ids.items(): lines.append('<%04X> <%s>'%(i,c.encode('utf-16-be').hex().upper()))
lines += ['endbfchar','endcmap','CMapName currentdict /CMap defineresource pop','end','end']
cm=DecodedStreamObject(); cm.set_data(('\n'.join(lines)).encode('ascii')); cmr=w._add_object(cm)
info=DictionaryObject({NameObject('/Registry'):TextStringObject('Adobe'),NameObject('/Ordering'):TextStringObject('Identity'),NameObject('/Supplement'):NumberObject(0)})
cid=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/CIDFontType2'),NameObject('/BaseFont'):NameObject('/AtlasUnicode'),NameObject('/CIDSystemInfo'):info,NameObject('/DW'):NumberObject(500)}); cidr=w._add_object(cid)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type0'),NameObject('/BaseFont'):NameObject('/AtlasUnicode'),NameObject('/Encoding'):NameObject('/Identity-H'),NameObject('/DescendantFonts'):ArrayObject([cidr]),NameObject('/ToUnicode'):cmr}); fr=w._add_object(font)
p[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F0'):fr})})
stream=DecodedStreamObject(); stream.set_data(('BT /F0 10 Tf 1 0 0 1 30 740 Tm <%s> Tj ET'%''.join('%04X'%ids[c] for c in text)).encode('ascii')); p[NameObject('/Contents')]=w._add_object(stream)
impage=w.add_blank_page(width=612,height=792); im=DecodedStreamObject(); im.set_data(bytes([1])); im.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Image'),NameObject('/Width'):NumberObject(1),NameObject('/Height'):NumberObject(1),NameObject('/ColorSpace'):NameObject('/DeviceGray'),NameObject('/BitsPerComponent'):NumberObject(8)}); ir=w._add_object(im); impage[NameObject('/Resources')]=DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Im0'):ir})})
b=w.add_blank_page(width=612,height=792); b[NameObject('/Contents')]=NumberObject(7)
with open(sys.argv[1],'wb') as f: w.write(f)
`;
  const result = spawnSync(pythonPath, ['-c', script, target, changed ? '1' : '0'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}
function linkValues(html, pattern) {
  const match = html.match(pattern); assert.ok(match, 'Expected page link is missing');
  return decodeURIComponent(match[1].replaceAll('&amp;', '&'));
}

test('Project Resources continues the same PDF text Ref and hides stale text after source changes', async (t) => {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-pdf-span-ui-')); const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '城市PDF'); fs.mkdirSync(projectRoot, { recursive: true });
  const filePath = path.join(projectRoot, '长文.pdf'); createPdf(filePath);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市PDF', currentPath: '城市PDF' }); registry.attachRoot(project.project_id,
    { rootId: adopted.root_id, relativePath: '城市PDF', reason: 'PDF span UI.' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const intake = new Intake({ stateDir }); const priorPython = process.env.ATLAS_PYTHON; process.env.ATLAS_PYTHON = pythonPath;
  const server = await startAtlasUiServer({ stateDir, registry, intake, resourceControl: control, projectRoot: workspace, installationRoot: workspace });
  t.after(async () => { await server.close(); intake.dispose(); control.dispose(); registry.dispose();
    if (priorPython == null) delete process.env.ATLAS_PYTHON; else process.env.ATLAS_PYTHON = priorPython;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const projectId = encodeURIComponent(project.project_id);
  const resources = await (await fetch(new URL(`projects/${projectId}/resources?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url))).text();
  assert.match(resources, /content-location\?resource_id=/u);
  const pageList = await (await fetch(new URL(`projects/${projectId}/content-location?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url))).text();
  assert.match(pageList, /Read page text|读取本页提取文本/u);
  const pageUrl = new URL(linkValues(pageList, /href="([^"]*content-location\?resource_id=[^"]*page=1)"/u), server.workspace_url);
  const firstResponse = await fetch(pageUrl); assert.equal(firstResponse.status, 200); const first = await firstResponse.text();
  assert.match(first, /basis|提取文本/u); assert.match(first, /路/u); assert.match(first, /1200/u);
  assert.equal(first.includes('Show more sections') || first.includes('显示更多段落'), false,
    'PDF page text must not expose the generic section cursor');
  const continuation = new URL(linkValues(first, /href="([^"]*content-location\?[^"]*cursor=[^&"]+)/u), server.workspace_url);
  const secondResponse = await fetch(continuation); assert.equal(secondResponse.status, 200); const second = await secondResponse.text();
  assert.match(second, /🚦/u); assert.match(second, /Open this exact location|打开此精确位置/u);
  const ref = linkValues(second, /content-location\?ref=([^&"]+)/u);
  const exactUrl = new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(ref)}`, server.workspace_url);
  const exactResponse = await fetch(exactUrl); assert.equal(exactResponse.status, 200); const exact = await exactResponse.text(); assert.match(exact, /🚦/u);
  const refFacts = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
  for (const [change, message] of [
    [{ pypdf_version: 'changed-version' }, /Extractor changed|提取器已变化/u],
    [{ segment_sha256: '0'.repeat(64) }, /Extracted text changed|提取文本已变化/u],
  ]) {
    const changedRef = Buffer.from(JSON.stringify({ ...refFacts, ...change }), 'utf8').toString('base64url');
    const changedUrl = new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(changedRef)}`, server.workspace_url);
    const response = await fetch(changedUrl); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, message);
    assert.doesNotMatch(html, /This reference matches the current file|此引用与当前文件一致|🚦/u);
  }
  createPdf(filePath, true); const staleResponse = await fetch(exactUrl); assert.equal(staleResponse.status, 200);
  const stale = await staleResponse.text(); assert.match(stale, /expired|过期/u); assert.doesNotMatch(stale, /🚦/u);
});
