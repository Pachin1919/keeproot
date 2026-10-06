import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { startAtlasUiServer } from '../src/ui-server.js';

function twoPagePdf() {
  const stream = text => { const body = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`; return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`; };
  const page = content => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${content} 0 R >>`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>', page(4), stream('Page one'), page(6), stream('Page two'), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let document = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

test('Registered PDF opens a local canvas reader and serves only current bound bytes and fixed assets', async t => {
  const fixture = fs.mkdtempSync(path.resolve('test/.tmp/reader-pdf-ui-')); const workspace = path.join(fixture, 'workspace'); const directory = path.join(workspace, '阅读');
  fs.mkdirSync(directory, { recursive: true }); const stateDir = path.join(fixture, 'state');
  const file = path.join(directory, '报告.pdf'); const bytes = twoPagePdf(); fs.writeFileSync(file, bytes);
  const registry = new Registry({ stateDir }); const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: '阅读', currentPath: '阅读' }); registry.attachRoot(project.project_id, { rootId: root.root_id, relativePath: '阅读', reason: 'PDF UI fixture' });
  const control = new ResourceControl({ stateDir, registry }); const resource = control.identify({ filePath: file, project: registry.show(project.project_id).project });
  const before = JSON.stringify(control.describe(resource.resource_id)); const intake = new Intake({ stateDir }); let externalOpens = 0;
  const server = await startAtlasUiServer({ stateDir, registry, intake, resourceControl: control, projectRoot: workspace, installationRoot: workspace, openLocalFileFn: async () => { externalOpens++; } });
  t.after(async () => { await server.close(); intake.dispose(); control.dispose(); registry.dispose(); });
  const get = href => fetch(new URL(href, server.workspace_url)); const base = `/projects/${project.project_id}/resources`;
  const returnTo = `${base}?mode=table&name_contains=报告`; const readerResponse = await get(`${base}/read?resource_id=${resource.resource_id}&return_to=${encodeURIComponent(returnTo)}`);
  assert.equal(readerResponse.status, 200); const html = await readerResponse.text();
  assert.match(html, /data-pdf-reader/u); assert.match(html, /data-pdf-prev disabled/u); assert.match(html, /data-pdf-next disabled/u);
  assert.doesNotMatch(html, /<iframe|<object|<embed|data:application\/pdf/u);
  const normalizedReturn = new URL(returnTo, 'http://atlas.local');
  assert.ok(html.includes(`href="${(normalizedReturn.pathname + normalizedReturn.search).replaceAll('&', '&amp;')}"`));
  assert.equal(normalizedReturn.searchParams.get('name_contains'), '报告'); assert.equal(externalOpens, 0);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const pdfHref = `${base}/read-pdf?resource_id=${resource.resource_id}&expected_sha256=${sha}`;
  assert.ok(html.includes(pdfHref.replaceAll('&', '&amp;')));
  const pdfResponse = await get(pdfHref); assert.equal(pdfResponse.status, 200);
  assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf'); assert.equal(pdfResponse.headers.get('cache-control'), 'no-store'); assert.equal(pdfResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await pdfResponse.arrayBuffer()), bytes); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(JSON.stringify(control.describe(resource.resource_id)), before);
  assert.equal((await get(`${base}/read-pdf?resource_id=${resource.resource_id}`)).status, 409);
  const script = await get('/ui/pdf-reader.js'); assert.equal(script.status, 200); const code = await script.text();
  assert.match(code, /\/assets\/pdfjs\/build\/pdf\.mjs/u); assert.match(code, /annotationMode: library\.AnnotationMode\.DISABLE/u); assert.match(code, /enableXfa: false/u); assert.match(code, /pending\?\.cancel\(\)/u);
  assert.doesNotMatch(code, /isEvalSupported|\/\/cdn\.|app:\/\//u);
  for (const asset of ['/assets/pdfjs/build/pdf.mjs', '/assets/pdfjs/build/pdf.worker.mjs', '/assets/pdfjs/cmaps/Adobe-GB1-0.bcmap', '/assets/pdfjs/standard_fonts/FoxitSerif.pfb', '/assets/pdfjs/wasm/openjpeg.wasm', '/assets/pdfjs/iccs/CGATS001Compat-v2-micro.icc']) {
    const response = await get(asset); assert.equal(response.status, 200, asset); assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  for (const asset of ['/assets/pdfjs/no-such-file', '/assets/pdfjs/build/pdf.sandbox.mjs', '/assets/pdfjs/%2e%2e%2fREADME.md', '/assets/pdfjs/build/pdf.mjs?path=outside', '/assets/pdfjs/standard_fonts/LiberationSans-Regular.ttf']) assert.equal((await get(asset)).status, 404, asset);
  const foreignDir = path.join(workspace, '其他'); fs.mkdirSync(foreignDir); const foreign = registry.create({ name: '其他', currentPath: '其他' }); registry.attachRoot(foreign.project_id, { rootId: root.root_id, relativePath: '其他', reason: 'PDF boundary fixture' });
  const refused = await get(`/projects/${foreign.project_id}/resources/read-pdf?resource_id=${resource.resource_id}&expected_sha256=${sha}`); assert.equal(refused.status, 409); assert.doesNotMatch(await refused.text(), /%PDF/u);
  fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from('\nchanged')]));
  const stale = await get(pdfHref); assert.equal(stale.status, 409); assert.doesNotMatch(await stale.text(), /%PDF/u);
  assert.equal(externalOpens, 0);
});
