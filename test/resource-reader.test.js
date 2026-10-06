import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createResourceReaderService } from '../src/resource-reader-service.js';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const conflict = { code: 'ATLAS_STATE_CONFLICT' };
function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/resource-reader-'));
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'reading');
  fs.mkdirSync(projectRoot, { recursive: true });
  const registry = new Registry({ stateDir: path.join(root, 'state') });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'reading', currentPath: 'reading' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'reading', reason: 'Reader fixture.' });
  const control = new ResourceControl({ stateDir: path.join(root, 'state'), registry });
  const service = createResourceReaderService({ registry, resourceControl: control });
  function add(name, bytes) {
    const file = path.join(projectRoot, name); fs.writeFileSync(file, bytes);
    const id = control.identify({ filePath: file, project: registry.show(project.project_id).project }).resource_id;
    return { file, id, read: (options = {}) => service.read({ projectId: project.project_id, resourceId: id, ...options }) };
  }
  t.after(() => { control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, projectRoot, registry, control, service, project, add };
}

test('registered Markdown and captured text return exact bytes and hash without baseline writes', (t) => {
  const f = fixture(t);
  for (const [name, kind] of [['capture.md', 'markdown'], ['chat.txt', 'text']]) {
    const bytes = Buffer.from('# 中文\n<script>alert(1)</script>\n'); const item = f.add(name, bytes);
    const before = JSON.stringify(f.control.describe(item.id));
    const result = item.read({ expectedSha256: hash(bytes) });
    assert.equal(result.kind, kind); assert.equal(result.text, bytes.toString('utf8'));
    assert.equal(result.sha256, hash(bytes)); assert.equal(result.bytes, bytes.length);
    assert.equal(result.relative_path, name); assert.equal(result.name, name);
    assert.deepEqual(fs.readFileSync(item.file), bytes);
    assert.equal(JSON.stringify(f.control.describe(item.id)), before);
  }
});

test('reader link resolution binds source hash and refuses unsafe or unregistered paths', (t) => {
  const f = fixture(t); const target = f.add('目标.md', '# 中文标题');
  const raw = ['目标.md#中文标题', 'java\nscript:alert', '//evil/a', 'data:text/plain,a', '../outside.md', 'missing.md'];
  const source = f.add('index.md', raw.map(value => `[open](${value})`).join('\n') + '\n[[reading/目标#中文标题|中文]]');
  const before = JSON.stringify(f.control.describe(target.id));
  const result = f.service.resolveLinks({ projectId: f.project.project_id, resourceId: source.id,
    expectedSha256: source.read().sha256, targets: raw.map(raw => ({ syntax: 'relative_markdown', raw })).concat({ syntax: 'wikilink', raw: 'reading/目标#中文标题|中文' }) });
  assert.equal(result[0].resource_id, target.id); assert.match(result[0].href, /#reader-heading-中文标题$/u);
  assert.equal(result.at(-1).resource_id, target.id);
  for (const item of result.slice(1, -1)) { assert.equal(item.status, 'unresolved'); assert.equal(item.href, undefined); }
  assert.equal(JSON.stringify(f.control.describe(target.id)), before);
  fs.writeFileSync(source.file, 'changed');
  assert.throws(() => f.service.resolveLinks({ projectId: f.project.project_id, resourceId: source.id, expectedSha256: hash('old'), targets: [] }), conflict);
});

test('reader resolves registered same Root cross-Project links without opening targets and refuses linked files', t => {
  const f = fixture(t); const workspace = path.dirname(f.projectRoot);
  const otherRoot = path.join(workspace, 'other'); fs.mkdirSync(otherRoot);
  const other = f.registry.create({ name: 'other', currentPath: 'other' });
  f.registry.attachRoot(other.project_id, { rootId: f.registry.show(f.project.project_id).location.root_id, relativePath: 'other', reason: 'Reader link fixture' });
  const file = path.join(otherRoot, 'note.md'); fs.writeFileSync(file, '# Section');
  const target = f.control.identify({ filePath: file, project: f.registry.show(other.project_id).project });
  const source = f.add('index.md', '[Cross](../other/note.md#Section)\n[[other/note|Other]]\n[[note]]\n[bad](javascript:alert)\n[bad](%2f%2fevil)\n[bad](linked/note.md)\n`[code](note.md)`\n```\n[[other/note]]\n```');
  const linkedDirectory = path.resolve(f.projectRoot, 'linked'); fs.mkdirSync(linkedDirectory);
  const linkedFile = f.add('linked/note.md', '# Before link');
  for (const candidate of [linkedDirectory, linkedFile.file]) {
    const relative = path.relative(f.root, path.resolve(candidate));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Fixture removal stays within its root');
  }
  fs.unlinkSync(linkedFile.file); fs.rmdirSync(linkedDirectory);
  fs.symlinkSync(otherRoot, linkedDirectory, 'junction');
  const sha = source.read().sha256; const before = JSON.stringify(f.control.describe(target.resource_id));
  const open = fs.openSync; fs.openSync = (filename, ...args) => { assert.notEqual(path.resolve(String(filename)), file, 'Resolver must not open target content'); return open(filename, ...args); };
  let resolved;
  try { resolved = f.service.resolveLinks({ projectId: f.project.project_id, resourceId: source.id, expectedSha256: sha, targets: [
    { syntax: 'relative_markdown', raw: '../other/note.md#Section' }, { syntax: 'wikilink', raw: 'other/note|Other' },
    { syntax: 'wikilink', raw: 'note' }, { syntax: 'relative_markdown', raw: 'javascript:alert' },
    { syntax: 'relative_markdown', raw: '%2f%2fevil' }, { syntax: 'relative_markdown', raw: 'linked/note.md' },
    { syntax: 'relative_markdown', raw: 'note.md' }, { syntax: 'wikilink', raw: 'other/note' },
  ] }); } finally { fs.openSync = open; }
  for (const item of resolved.slice(0, 2)) { assert.equal(item.project_id, other.project_id); assert.equal(item.resource_id, target.resource_id); assert.ok(item.href.startsWith(`/projects/${other.project_id}/resources/read?`)); }
  for (const item of resolved.slice(2)) assert.equal(item.status, 'unresolved');
  assert.equal(resolved[5].reason, 'unavailable');
  assert.equal(JSON.stringify(f.control.describe(target.resource_id)), before);
  assert.throws(() => f.service.resolveLinks({ projectId: f.project.project_id, resourceId: source.id, expectedSha256: sha, targets: Array(101).fill({}) }), conflict);
});

test('stale expected versions, missing files, invalid UTF8 and limits refuse content', (t) => {
  const f = fixture(t); const item = f.add('a.md', 'original');
  fs.writeFileSync(item.file, 'changed'); assert.throws(() => item.read({ expectedSha256: hash('original') }), conflict);
  assert.equal(item.read().text, 'changed');
  fs.writeFileSync(item.file, Buffer.from([0xc3, 0x28])); assert.throws(() => item.read(), conflict);
  fs.writeFileSync(item.file, Buffer.alloc(256 * 1024 + 1)); assert.throws(() => item.read(), conflict);
  fs.unlinkSync(item.file); assert.throws(() => item.read(), conflict);
  const image = f.add('large.png', Buffer.alloc(8 * 1024 * 1024 + 1)); assert.throws(() => image.read(), conflict);
});

test('foreign identity, outside path, ambiguous location and linked ancestors refuse reads', (t) => {
  const f = fixture(t); const item = f.add('a.txt', 'local');
  assert.throws(() => f.service.read({ projectId: 'foreign', resourceId: item.id }), conflict);
  const detail = f.registry.show(f.project.project_id);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'a.txt'), 'outside');
  const location = { project_id: f.project.project_id, status: 'active', path: path.join(outside, 'a.txt') };
  const custom = (locations) => createResourceReaderService({ registry: { show: () => detail }, resourceControl: { projectResource: () => ({ locations }) } });
  assert.throws(() => custom([location]).read({ projectId: f.project.project_id, resourceId: item.id }), conflict);
  location.path = item.file;
  assert.throws(() => custom([location, location]).read({ projectId: f.project.project_id, resourceId: item.id }), conflict);
  const junction = path.join(f.projectRoot, 'linked'); fs.symlinkSync(outside, junction, 'junction');
  location.path = path.join(junction, 'a.txt');
  assert.throws(() => custom([location]).read({ projectId: f.project.project_id, resourceId: item.id }), conflict);
});

test('PDF bytes are version-bound, bounded and never interpreted as HTML', (t) => {
  const f = fixture(t); const bytes = Buffer.from('%PDF-1.7\nfixture body\n%%EOF\n');
  const item = f.add('paper.pdf', bytes); const result = item.read();
  assert.equal(result.kind, 'pdf'); assert.equal(result.sha256, hash(bytes));
  assert.equal(result.pdf_bytes, undefined);
  const response = f.service.readPdf({ projectId: f.project.project_id, resourceId: item.id, expectedSha256: result.sha256 });
  assert.deepEqual(response.data, bytes); assert.equal(response.mime, 'application/pdf');
  assert.throws(() => f.service.readPdf({ projectId: f.project.project_id, resourceId: item.id }), conflict);
  fs.appendFileSync(item.file, 'changed');
  assert.throws(() => f.service.readPdf({ projectId: f.project.project_id, resourceId: item.id, expectedSha256: result.sha256 }), conflict);
  fs.writeFileSync(item.file, '<html>not a PDF</html>'); assert.throws(() => item.read(), conflict);
  fs.writeFileSync(item.file, Buffer.alloc(20 * 1024 * 1024 + 1)); assert.throws(() => item.read(), conflict);
});

test('unsupported SVG and HTML return metadata without opening the content', (t) => {
  const f = fixture(t);
  for (const name of ['a.svg', 'a.html']) {
    const item = f.add(name, '<script>secret</script>');
    const original = fs.openSync; fs.openSync = () => { throw new Error('Unexpected content open'); };
    try { const result = item.read(); assert.equal(result.kind, 'unsupported'); assert.equal(result.text, undefined); assert.equal(result.image_data_url, undefined); }
    finally { fs.openSync = original; }
  }
});

test('PNG, JPEG, WebP and GIF readers return matching MIME and captured buffer', (t) => {
  const f = fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=', 'base64');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const jpeg = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]);
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16);
  for (const [name, mime, bytes] of [['a.png','image/png',png], ['a.jpg','image/jpeg',jpeg], ['a.webp','image/webp',webp], ['a.gif','image/gif',gif]]) {
    const result = f.add(name, bytes).read(); assert.equal(result.kind, 'image'); assert.equal(result.mime, mime);
    assert.equal(result.image_data_url, `data:${mime};base64,${bytes.toString('base64')}`); assert.equal(result.sha256, hash(bytes));
  }
  assert.throws(() => f.add('wrong.png', gif).read(), conflict);
  const huge = Buffer.from(png); huge.writeUInt32BE(100001, 16); assert.throws(() => f.add('huge.png', huge).read(), conflict);
});

test('concurrent growth and path replacement are rejected and descriptors closed', (t) => {
  const f = fixture(t); const item = f.add('a.txt', 'before');
  const originalRead = fs.readSync; const originalClose = fs.closeSync; let changed = false; let closed = 0;
  fs.closeSync = (...args) => { closed += 1; return originalClose(...args); };
  fs.readSync = (...args) => { const n = originalRead(...args); if (!changed) { changed = true; fs.appendFileSync(item.file, 'growth'); } return n; };
  try { assert.throws(() => item.read(), conflict); assert.ok(closed > 0); }
  finally { fs.readSync = originalRead; fs.closeSync = originalClose; }
  changed = false; fs.readSync = (...args) => { const n = originalRead(...args); if (!changed) { changed = true; fs.renameSync(item.file, `${item.file}.old`); fs.writeFileSync(item.file, 'replacement'); } return n; };
  try { assert.throws(() => item.read(), conflict); } finally { fs.readSync = originalRead; }
});
