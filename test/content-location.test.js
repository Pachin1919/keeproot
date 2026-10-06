import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '城市研究'); const filePath = path.join(projectRoot, '资料.md');
  fs.mkdirSync(projectRoot, { recursive: true });
  const original = '# 公交方案\n\n第一段内容。\n\n# 公交方案\n\n第二段内容。\n\n```md\n# 围栏内不是标题\n```\n\n> 引用块不定位。\n';
  fs.writeFileSync(filePath, original, 'utf8');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市研究', currentPath: '城市研究' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市研究', reason: 'Content location fixture.' });
  const control = new ResourceControl({ stateDir, registry });
  const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const service = createContentLocationService({ registry, resourceControl: control });
  t.after(() => { service.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, workspace, projectRoot, filePath, original, registry, project, control, resourceId, service };
}

const cliPath = path.resolve('bin/atlas.js');
function cli(stateDir, args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ATLAS_STATE_DIR: stateDir } });
}

test('Host and Project HTML use exact Resource refs; stale refs reveal no changed text', async (t) => {
  const f = fixture(t);
  const page = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, limit: 2 });
  assert.equal(page.file.sha256, crypto.createHash('sha256').update(f.original).digest('hex'));
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items.map((item) => item.text), ['公交方案', '第一段内容。']);
  assert.equal(page.items[0].start_line, 1);
  assert.equal(page.items[0].end_line, 1);
  assert.ok(page.items[0].ref);
  assert.ok(page.next_cursor);
  const continuation = f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, limit: 2, cursor: page.next_cursor });
  assert.equal(continuation.items[0].text, '公交方案');
  assert.notEqual(continuation.items[0].ref, page.items[0].ref);
  assert.equal(continuation.items.some((item) => item.text.includes('围栏内不是标题')), false);

  const read = f.service.readRef({ projectId: f.project.project_id, ref: page.items[0].ref });
  assert.equal(read.status, 'current');
  assert.equal(read.text, '公交方案');
  const command = cli(f.stateDir, ['content', 'read-ref', '--project', f.project.project_id, '--ref', page.items[0].ref, '--json']);
  assert.equal(command.status, 0, `${command.stderr}\n${command.stdout}`);
  assert.equal(JSON.parse(command.stdout).data.text, read.text);

  const changed = `插入的新段落。\n\n${f.original}`;
  fs.writeFileSync(f.filePath, changed, 'utf8');
  const stale = f.service.readRef({ projectId: f.project.project_id, ref: page.items[0].ref });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.text, null);
  assert.equal(stale.current_sha256, crypto.createHash('sha256').update(changed).digest('hex'));
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId, limit: 2, cursor: page.next_cursor }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), changed);
});

test('Content location rejects foreign and linked Resources', (t) => {
  const f = fixture(t);
  const otherProject = f.registry.create({ name: '另一个项目', currentPath: '另一个项目' });
  fs.mkdirSync(path.join(f.workspace, '另一个项目'), { recursive: true });
  f.registry.attachRoot(otherProject.project_id, { rootId: f.registry.show(f.project.project_id).location.root_id,
    relativePath: '另一个项目', reason: 'Foreign Resource fixture.' });
  const foreignPath = path.join(f.workspace, '另一个项目', 'foreign.md');
  fs.mkdirSync(path.dirname(foreignPath), { recursive: true }); fs.writeFileSync(foreignPath, '# 外部');
  const foreignId = f.control.identify({ filePath: foreignPath, project: f.registry.show(otherProject.project_id).project }).resource_id;
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: foreignId }), { code: 'ATLAS_STATE_CONFLICT' });

  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); const outsideFile = path.join(outside, 'linked.md'); fs.writeFileSync(outsideFile, '# linked');
  const junction = path.join(f.projectRoot, 'linked'); fs.symlinkSync(outside, junction, 'junction');
  const linkedId = f.control.identify({ filePath: path.join(junction, 'linked.md'), project: f.registry.show(f.project.project_id).project }).resource_id;
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: linkedId }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('Markdown location rejects invalid UTF-8 and files beyond its bounded read limit', (t) => {
  const f = fixture(t);
  const invalid = Buffer.from([0x23, 0x20, 0xc3, 0x28]);
  fs.writeFileSync(f.filePath, invalid);
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId }),
    { code: 'ATLAS_STATE_CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.filePath), invalid);

  const oversized = Buffer.alloc(256 * 1024 + 1, 0x61);
  fs.writeFileSync(f.filePath, oversized);
  assert.throws(() => f.service.locate({ projectId: f.project.project_id, resourceId: f.resourceId }),
    { code: 'ATLAS_STATE_CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.filePath), oversized);
});
