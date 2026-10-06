import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createResourceReaderService } from '../src/resource-reader-service.js';
import { Intake } from '../src/intake.js';
import { startAtlasUiServer } from '../src/ui-server.js';
const python = process.env.ATLAS_TEST_PYTHON ?? 'python';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const conflict = { code: 'ATLAS_STATE_CONFLICT' };
const make = String.raw`
import sys,json,zipfile
from xml.sax.saxutils import escape
x=json.load(sys.stdin)
def p(text): return '<w:p><w:r><w:t>'+escape(text)+'</w:t></w:r></w:p>'
body=p('正文开头')+p('长段落'+('中'*1500)+'完整尾部')+'<w:tbl><w:tr><w:tc>'+p('甲')+'</w:tc><w:tc>'+p('<script>alert(1)</script>')+'</w:tc></w:tr></w:tbl>'+p('正文末尾')
if x.get('large'): body=p('中'*200100)
if x.get('floating'): body+='<w:p><w:r><w:drawing><w:txbxContent>'+p('不可当正文的浮动内容')+'</w:txbxContent></w:drawing></w:r></w:p>'
xml='<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'</w:body></w:document>'
if x.get('doctype'): xml='<!DOCTYPE root [<!ENTITY token "forbidden">]>'+xml.replace('<?xml version="1.0"?>','')
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types/>')
 z.writestr('word/document.xml',xml.encode('utf-16') if x.get('utf16') else xml)
 z.writestr('word/_rels/document.xml.rels','<Relationships><Relationship TargetMode="External" Target="https://example.invalid/private"/></Relationships>')
`;
export function makeDocx(file, options = {}) {
  const result = spawnSync(python, ['-c', make, file], { input: JSON.stringify(options), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}
function fixture(t, deferredCleanup = false) {
  const base = fs.mkdtempSync(path.resolve('test/.tmp/docx-reader-')); const workspace = path.join(base, 'workspace'); const directory = path.join(workspace, '资料');
  fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, '说明.docx'); makeDocx(file);
  const registry = new Registry({ stateDir: path.join(base, 'state') });
  const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: '资料', currentPath: '资料' }); registry.attachRoot(project.project_id, { rootId: root.root_id, relativePath: '资料', reason: 'DOCX reader fixture' });
  const control = new ResourceControl({ stateDir: registry.stateDir, registry }); const resource = control.identify({ filePath: file, project: { id: project.project_id } });
  const service = createResourceReaderService({ registry, resourceControl: control, pythonPath: python });
  const read = options => service.read({ projectId: project.project_id, resourceId: resource.resource_id, ...options });
  const cleanup = () => { control.dispose(); registry.dispose(); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); };
  if (!deferredCleanup) t.after(cleanup);
  return { base, file, registry, control, resource, service, project, read, cleanup };
}
test('DOCX reader retains body order, long paragraph and table text without source or identity writes', t => {
  const f = fixture(t); const bytes = fs.readFileSync(f.file), before = JSON.stringify(f.control.describe(f.resource.resource_id));
  const result = f.read(); assert.equal(result.kind, 'docx'); assert.equal(result.sha256, hash(bytes));
  assert.deepEqual(result.document.blocks.map(block => block.kind), ['paragraph', 'paragraph', 'table', 'paragraph']);
  assert.equal(result.document.blocks[0].text, '正文开头'); assert.ok(result.document.blocks[1].text.endsWith('完整尾部'));
  assert.deepEqual(result.document.blocks[2].rows, [['甲', '<script>alert(1)</script>']]);
  assert.equal(result.document.blocks[3].text, '正文末尾'); assert.equal(result.document.truncated, false);
  assert.equal(JSON.stringify(f.control.describe(f.resource.resource_id)), before); assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.throws(() => f.service.read({ projectId: 'foreign', resourceId: f.resource.resource_id }), conflict);
  makeDocx(f.file, { floating: true }); assert.throws(() => f.read({ expectedSha256: result.sha256 }), conflict);
  const changed = f.read(); assert.ok(changed.document.warnings.includes('floating_objects')); assert.ok(!JSON.stringify(changed.document.blocks).includes('不可当正文'));
});
test('DOCX Resource HTTP reading escapes table content, preserves return and never opens an external application', async t => {
  const f = fixture(t, true); const before = fs.readFileSync(f.file); const intake = new Intake({ stateDir: f.registry.stateDir }); let opens = 0;
  const prior = process.env.ATLAS_CONTENT_PYTHON; process.env.ATLAS_CONTENT_PYTHON = python;
  const server = await startAtlasUiServer({ stateDir: f.registry.stateDir, registry: f.registry, intake, resourceControl: f.control, projectRoot: path.dirname(path.dirname(f.file)), openLocalFileFn: async () => { opens++; } });
  t.after(async () => { await server.close(); intake.dispose(); f.cleanup(); if (prior === undefined) delete process.env.ATLAS_CONTENT_PYTHON; else process.env.ATLAS_CONTENT_PYTHON = prior; });
  const base = `/projects/${f.project.project_id}/resources`;
  const returnTo = `${base}?mode=table&name_contains=docx`;
  const response = await fetch(new URL(`${base}/read?resource_id=${f.resource.resource_id}&return_to=${encodeURIComponent(returnTo)}`, server.workspace_url));
  assert.equal(response.status, 200); const html = await response.text();
  assert.match(html, /reader-docx/u); assert.match(html, /完整尾部/u); assert.match(html, /<td>甲<\/td>/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u); assert.doesNotMatch(html, /<script>alert|example\.invalid/u);
  assert.ok(html.includes(`href="${returnTo.replaceAll('&', '&amp;')}"`));
  assert.equal(opens, 0); assert.deepEqual(fs.readFileSync(f.file), before);
});
test('DOCX reader reports truncation, damaged packages, XML declarations and missing Python', t => {
  const f = fixture(t); makeDocx(f.file, { large: true }); const limited = f.read();
  assert.equal(limited.document.truncated, true); assert.equal(Array.from(limited.document.blocks[0].text).length, 200000);
  makeDocx(f.file, { doctype: true }); assert.throws(() => f.read(), /DOCX|document|XML/u);
  fs.writeFileSync(f.file, '<html>not office</html>'); assert.throws(() => f.read(), /DOCX|document|package/u);
  makeDocx(f.file); const missing = createResourceReaderService({ registry: f.registry, resourceControl: f.control, pythonPath: path.join(f.base, 'missing-python.exe') });
  assert.throws(() => missing.read({ projectId: f.project.project_id, resourceId: f.resource.resource_id }), /Python|DOCX/u);
});
test('DOCX reader rejects DTD declarations even in UTF-16 XML', t => {
  const f = fixture(t); makeDocx(f.file, { doctype: true, utf16: true });
  assert.throws(() => f.read(), /DOCX|document|XML/u);
});
