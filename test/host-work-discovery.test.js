import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'host-work-discovery-')); const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'A', 'Data'), { recursive: true }); fs.mkdirSync(path.join(workspace, 'B', 'Data'), { recursive: true });
  const first = path.join(workspace, 'A', 'Data', 'first.csv'); const second = path.join(workspace, 'A', 'Data', 'second.csv'); const foreign = path.join(workspace, 'B', 'Data', 'foreign.csv');
  fs.writeFileSync(first, 'name,value\na,1\n'); fs.writeFileSync(second, 'name,value\nb,2\n'); fs.writeFileSync(foreign, 'name,value\nc,3\n');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' }); const a = registry.create({ name: 'A', currentPath: 'A' }); const b = registry.create({ name: 'B', currentPath: 'B' });
  registry.attachRoot(a.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'test' }); registry.attachRoot(b.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'test' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger }); const resources = [first, second, foreign].map((filePath, index) => control.identify({ filePath, project: index === 2 ? { id: b.project_id, name: 'B' } : { id: a.project_id, name: 'A' } }));
  const now = new Date().toISOString(); registry.ledger.workSessions.create({ projectId: a.project_id, resourceIds: [resources[0].resource_id], returnState: { folder: 'Data' }, at: now }); registry.ledger.workSessions.create({ projectId: a.project_id, resourceIds: [resources[1].resource_id], returnState: { folder: 'Data' }, at: new Date(Date.now() + 1).toISOString() }); registry.ledger.workSessions.create({ projectId: b.project_id, resourceIds: [resources[2].resource_id], returnState: { folder: 'Data' }, at: new Date(Date.now() + 2).toISOString() });
  t.after(() => { control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); }); return { root, stateDir, a, b };
}

test('Host CLI lists bounded Project Work discovery with pagination and isolation', (t) => {
  const f = fixture(t); const result = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'table-work', 'list', '--project', f.a.project_id, '--limit', '1', '--offset', '0', '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout).data; assert.equal(data.project_id, f.a.project_id); assert.equal(data.works.length, 1); assert.equal(data.total, 2); assert.equal(data.limit, 1); assert.equal(data.offset, 0); assert.equal(data.complete, false); assert.equal(data.next_offset, 1); assert.equal(data.works[0].project_id, f.a.project_id); assert.match(data.works[0].desktop_href, /^\/work\/DWT-/u);
  const isolated = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'table-work', 'list', '--project', f.b.project_id, '--limit', '1', '--offset', '0', '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' });
  assert.equal(isolated.status, 0, isolated.stderr); const other = JSON.parse(isolated.stdout).data; assert.equal(other.total, 1); assert.equal(other.works.length, 1); assert.equal(other.works[0].project_id, f.b.project_id);
});
