import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';

const pythonPath = path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe');
const pythonSourceRoot = path.resolve('python/src');
function makeDocx(filePath, changed = false, floating = false) {
  const script = String.raw`
import sys, zipfile
from xml.sax.saxutils import escape
def p(text): return '<w:p><w:r><w:t xml:space="preserve">'+escape(text)+'</w:t></w:r></w:p>'
cell = '<w:tc>'+p('第一行单元格')+p('第二段单元格')+'<w:tcPr/><w:p/></w:tc>'
rows = '<w:tr>'+cell+'<w:tc>'+p('右上')+'</w:tc></w:tr><w:tr><w:tc>'+p('左下')+'</w:tc><w:tc>'+p('右下')+'</w:tc></w:tr>'
floating = '<w:p><w:r><w:t>可定位正文</w:t><w:drawing><w:txbxContent><w:p><w:r><w:t>浮动框秘密</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>' if sys.argv[3]=='1' else ''
body = p('正文段落一')+p('更改后的正文段落' if sys.argv[2]=='1' else '正文段落二')+floating+'<w:tbl>'+rows+'</w:tbl>'
xml = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'</w:body></w:document>'
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
 z.writestr('word/document.xml',xml)
`;
  const result = spawnSync(pythonPath, ['-c', script, filePath, changed ? '1' : '0', floating ? '1' : '0'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}
function fixture(t) {
  assert.equal(fs.existsSync(pythonPath), true, `Managed test Python is missing: ${pythonPath}`);
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-docx-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '城市研究'); const filePath = path.join(projectRoot, '公交方案.docx');
  fs.mkdirSync(projectRoot, { recursive: true }); makeDocx(filePath); const bytes = fs.readFileSync(filePath);
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市研究', currentPath: '城市研究' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市研究', reason: 'DOCX content location.' });
  const control = new ResourceControl({ stateDir, registry });
  const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const service = createContentLocationService({ registry, resourceControl: control, pythonPath, pythonSourceRoot });
  t.after(() => { service.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, workspace, projectRoot, filePath, bytes, registry, project, control, resourceId, service };
}
const cliPath = path.resolve('bin/atlas.js');
function cli(stateDir, args) { return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, ATLAS_STATE_DIR: stateDir, ATLAS_PYTHON: pythonPath } }); }

test('Host and Project HTML locate exact DOCX body paragraphs and table cells, with stale refs returning no old text', async (t) => {
  const f = fixture(t); const before = crypto.createHash('sha256').update(f.bytes).digest('hex');
  const located = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId });
  assert.equal(located.format, 'docx'); assert.equal(located.file.sha256, before);
  assert.deepEqual(located.items.map((item) => [item.kind, item.text, item.paragraph_index, item.table_index, item.row, item.column]), [
    ['paragraph', '正文段落一', 1, undefined, undefined, undefined],
    ['paragraph', '正文段落二', 2, undefined, undefined, undefined],
    ['table_cell', '第一行单元格\n第二段单元格', undefined, 1, 1, 1],
    ['table_cell', '右上', undefined, 1, 1, 2],
    ['table_cell', '左下', undefined, 1, 2, 1],
    ['table_cell', '右下', undefined, 1, 2, 2],
  ]);
  const exact = f.service.readRef({ projectId: f.project.project_id, ref: located.items[2].ref });
  assert.equal(exact.text, '第一行单元格\n第二段单元格'); assert.deepEqual([exact.table_index, exact.row, exact.column], [1, 1, 1]);
  assert.throws(() => f.service.readRef({ projectId: 'PRJ-foreign', ref: located.items[0].ref }), { code: 'ATLAS_STATE_CONFLICT' });
  const host = cli(f.stateDir, ['content', 'locate', '--project', f.project.project_id, '--resource', f.resourceId, '--json']);
  assert.equal(host.status, 0, `${host.stderr}\n${host.stdout}`); assert.deepEqual(JSON.parse(host.stdout).data.items.map((item) => item.text), located.items.map((item) => item.text));
  const hostRead = cli(f.stateDir, ['content', 'read-ref', '--project', f.project.project_id, '--ref', located.items[2].ref, '--json']);
  assert.equal(hostRead.status, 0, `${hostRead.stderr}\n${hostRead.stdout}`); assert.equal(JSON.parse(hostRead.stdout).data.text, exact.text);
  makeDocx(f.filePath, true);
  const stale = f.service.readRef({ projectId: f.project.project_id, ref: located.items[0].ref });
  assert.equal(stale.status, 'stale'); assert.equal(stale.text, null);
});

test('DOCX floating text does not become an exact body paragraph', (t) => {
  const f = fixture(t);
  makeDocx(f.filePath, false, true);
  const located = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId });
  assert.equal(located.unsupported.floating_objects, 1);
  assert.deepEqual(located.items.filter((item) => item.kind === 'paragraph').map((item) => item.text),
    ['正文段落一', '正文段落二', '可定位正文']);
  assert.equal(located.items.some((item) => item.text.includes('浮动框秘密')), false);
});
