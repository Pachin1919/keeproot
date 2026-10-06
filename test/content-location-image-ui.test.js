import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { startAtlasUiServer } from '../src/ui-server.js';

function png(marker = 1) {
  const crc32 = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([length, type, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(120, 0); header.writeUInt32BE(90, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(90 * (120 * 4 + 1)); for (let y = 0; y < 90; y += 1) for (let x = 0; x < 120; x += 1) pixels[y * 481 + 1 + x * 4] = marker;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('Project Resources opens a PNG region Ref and never renders a changed image under the stale region', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-image-ui-')); const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '城市影像'); fs.mkdirSync(projectRoot, { recursive: true });
  const filePath = path.join(projectRoot, '线路.png'); fs.writeFileSync(filePath, png());
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市影像', currentPath: '城市影像' }); registry.attachRoot(project.project_id,
    { rootId: adopted.root_id, relativePath: '城市影像', reason: 'PNG region UI.' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const intake = new Intake({ stateDir }); const server = await startAtlasUiServer({ stateDir, registry, intake, resourceControl: control, projectRoot: workspace, installationRoot: workspace });
  t.after(async () => { await server.close(); intake.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const projectId = encodeURIComponent(project.project_id);
  const resourcesUrl = new URL(`projects/${projectId}/resources?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url);
  const resources = await (await fetch(resourcesUrl)).text(); assert.match(resources, /content-location\?resource_id=/u);
  const locateUrl = new URL(`projects/${projectId}/content-location?resource_id=${encodeURIComponent(resourceId)}&x=10&y=20&width=30&height=40`, server.workspace_url);
  const locateResponse = await fetch(locateUrl); assert.equal(locateResponse.status, 200); const located = await locateResponse.text();
  assert.match(located, /PNG pixel region|PNG 像素区域/u);
  assert.match(located, /Image text was not recognized; no OCR was used\./u);
  assert.doesNotMatch(located, /PDF text extraction only|仅提取PDF文本层/u);
  assert.match(located, /120/u); assert.match(located, /90/u); assert.match(located, /10/u); assert.match(located, /30/u);
  const refMatch = located.match(/href="[^"]*content-location\?ref=([^&"]+)/u); assert.ok(refMatch);
  const ref = decodeURIComponent(refMatch[1]); const readUrl = new URL(`projects/${projectId}/content-location?ref=${encodeURIComponent(ref)}`, server.workspace_url);
  const readResponse = await fetch(readUrl); assert.equal(readResponse.status, 200); const read = await readResponse.text();
  assert.match(read, /data-content-location-region/u); assert.match(read, /x="10"/u); assert.match(read, /width="30"/u);
  const imageUrlMatch = read.match(/src="([^"]*thumbnail[^"]*)"/u); assert.ok(imageUrlMatch);
  const expectedHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const imageUrl = new URL(imageUrlMatch[1].replaceAll('&amp;', '&'), server.workspace_url); assert.equal(imageUrl.searchParams.get('expected_sha256'), expectedHash);
  const preview = await fetch(imageUrl); assert.equal(preview.status, 200); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), fs.readFileSync(filePath));
  fs.writeFileSync(filePath, png(2));
  const oldPreview = await fetch(imageUrl); assert.equal(oldPreview.status, 409);
  const staleResponse = await fetch(readUrl); assert.equal(staleResponse.status, 200);
  const stale = await staleResponse.text(); assert.match(stale, /expired|过期/u);
  assert.match(stale, /prior content or region|先前内容或区域/u); assert.doesNotMatch(stale, /data-content-location-region/u);
  assert.doesNotMatch(stale, /thumbnail/u);
});
