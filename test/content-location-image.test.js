import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';

function png(width = 120, height = 90, marker = 1) {
  const crc32 = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([length, type, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1)); for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels[y * (width * 4 + 1) + 1 + x * 4] = marker;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-image-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '城市影像'); fs.mkdirSync(projectRoot, { recursive: true });
  const filePath = path.join(projectRoot, '公交线路.png'); fs.writeFileSync(filePath, png());
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市影像', currentPath: '城市影像' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市影像', reason: 'PNG region location.' });
  const control = new ResourceControl({ stateDir, registry });
  const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const service = createContentLocationService({ registry, resourceControl: control });
  t.after(() => { service.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, workspace, projectRoot, filePath, registry, project, control, resourceId, service };
}

const cliPath = path.resolve('bin/atlas.js');
function cli(stateDir, args) { return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, ATLAS_STATE_DIR: stateDir } }); }

test('PNG refs bind a bounded source-pixel rectangle and stale refs expose no preview after bytes change', (t) => {
  const f = fixture(t);
  const located = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, x: 10, y: 20, width: 30, height: 40 });
  assert.equal(located.format, 'png'); assert.deepEqual(located.image, { width: 120, height: 90 });
  assert.deepEqual(located.region, { x: 10, y: 20, width: 30, height: 40, coordinate_space: 'source_pixels', origin: 'top_left' });
  assert.equal(located.preview_url != null, true); assert.ok(located.ref);
  const read = f.service.readRef({ projectId: f.project.project_id, ref: located.ref });
  assert.equal(read.status, 'current'); assert.equal(read.region.width, 30); assert.equal(read.file_sha256, located.file.sha256);
  assert.equal(cli(f.stateDir, ['content', 'locate', '--project', f.project.project_id, '--resource', f.resourceId,
    '--x', '10', '--y', '20', '--width', '30', '--height', '40', '--json']).status, 0);
  assert.throws(() => f.service.readRef({ projectId: 'PRJ-foreign', ref: located.ref }), { code: 'ATLAS_STATE_CONFLICT' });
  for (const region of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 119, y: 0, width: 2, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 }, { x: 0.5, y: 0, width: 1, height: 1 }]) {
    assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, ...region }), { code: 'ATLAS_STATE_CONFLICT' });
  }
  fs.writeFileSync(f.filePath, png(120, 90, 2));
  const stale = f.service.readRef({ projectId: f.project.project_id, ref: located.ref });
  assert.equal(stale.status, 'stale'); assert.equal(stale.preview_url, null); assert.equal(stale.text, null); assert.equal(stale.region, null);
  const unsupported = path.join(f.projectRoot, 'unsupported.gif'); fs.writeFileSync(unsupported, Buffer.from('GIF89a'));
  const gifId = f.control.identify({ filePath: unsupported, project: f.registry.show(f.project.project_id).project }).resource_id;
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: gifId, x: 0, y: 0, width: 1, height: 1 }), { code: 'ATLAS_STATE_CONFLICT' });
  const malformed = path.join(f.projectRoot, 'malformed.png'); fs.writeFileSync(malformed, Buffer.from('not a PNG'));
  const malformedId = f.control.identify({ filePath: malformed, project: f.registry.show(f.project.project_id).project }).resource_id;
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: malformedId }), { code: 'ATLAS_STATE_CONFLICT' });
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); const outsidePng = path.join(outside, 'linked.png'); fs.writeFileSync(outsidePng, png());
  const junction = path.join(f.projectRoot, 'linked'); fs.symlinkSync(outside, junction, 'junction');
  const linkedId = f.control.identify({ filePath: path.join(junction, 'linked.png'), project: f.registry.show(f.project.project_id).project }).resource_id;
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: linkedId }), { code: 'ATLAS_STATE_CONFLICT' });
});
