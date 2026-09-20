import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Registry } from '../src/registry.js';
import { createProjectViewService } from '../src/project-view-service.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'host-view-write-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'A', 'Data'), { recursive: true }); fs.mkdirSync(path.join(workspace, 'B', 'Data'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'A', 'Data', 'note.txt'), 'local');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const a = registry.create({ name: 'A', currentPath: 'A' }); const b = registry.create({ name: 'B', currentPath: 'B' });
  registry.attachRoot(a.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'test' }); registry.attachRoot(b.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'test' });
  const service = createProjectViewService({ stateDir, registry });
  t.after(() => { service.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, stateDir, a, b, service };
}

function run(f, args) {
  return spawnSync(process.execPath, [path.resolve('bin/atlas.js'), ...args, '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' });
}

function writeRequest(f, name, request) {
  const file = path.join(f.root, name); fs.writeFileSync(file, JSON.stringify(request)); return file;
}

test('Host CLI creates and updates a Saved View with revision and project boundaries', (t) => {
  const f = fixture(t); const createFile = writeRequest(f, 'create.json', { name: 'Data files', mode: 'files', config: { scope: { path: 'Data' } } });
  const created = run(f, ['view', 'save', '--project', f.a.project_id, '--request-file', createFile, '--tool', 'Codex', '--client-run-id', 'view-create']);
  assert.equal(created.status, 0, created.stderr); const createdData = JSON.parse(created.stdout).data; assert.equal(createdData.name, 'Data files'); assert.equal(createdData.revision, 1); assert.equal(createdData.project_id, f.a.project_id); assert.equal(createdData.desktop_href, `/projects/${f.a.project_id}/resources?view=${createdData.view_id}`);
  const fresh = createProjectViewService({ stateDir: f.stateDir }); assert.equal(fresh.listViews(f.a.project_id).views[0].view_id, createdData.view_id); fresh.dispose();
  const updateFile = writeRequest(f, 'update.json', { name: 'All files', mode: 'table', config: { scope: { path: 'Data' } }, view_id: createdData.view_id, base_revision: 1 });
  const updated = run(f, ['view', 'save', '--project', f.a.project_id, '--request-file', updateFile, '--tool', 'Codex', '--client-run-id', 'view-update']);
  assert.equal(updated.status, 0, updated.stderr); const updatedData = JSON.parse(updated.stdout).data; assert.equal(updatedData.view_id, createdData.view_id); assert.equal(updatedData.revision, 2); assert.equal(updatedData.name, 'All files');
  const staleFile = writeRequest(f, 'stale.json', { name: 'Stale write', mode: 'files', config: { scope: { path: 'Data' } }, view_id: createdData.view_id, base_revision: 1 });
  const stale = run(f, ['view', 'save', '--project', f.a.project_id, '--request-file', staleFile, '--tool', 'Codex', '--client-run-id', 'view-stale']);
  assert.notEqual(stale.status, 0); assert.equal(JSON.parse(stale.stdout).ok, false); assert.equal(f.service.listViews(f.a.project_id).views[0].name, 'All files'); assert.equal(f.service.listViews(f.a.project_id).views[0].revision, 2);
  const foreignFile = writeRequest(f, 'foreign.json', { name: 'Foreign write', mode: 'files', config: { scope: { path: 'Data' } }, view_id: createdData.view_id, base_revision: 2 });
  const foreign = run(f, ['view', 'save', '--project', f.b.project_id, '--request-file', foreignFile, '--tool', 'Codex', '--client-run-id', 'view-foreign']);
  assert.notEqual(foreign.status, 0); assert.equal(JSON.parse(foreign.stdout).ok, false);
  const escapeFile = writeRequest(f, 'escape.json', { name: 'Escape', mode: 'files', config: { scope: { path: '../outside' } } });
  const escaped = run(f, ['view', 'save', '--project', f.a.project_id, '--request-file', escapeFile, '--tool', 'Codex', '--client-run-id', 'view-escape']);
  assert.notEqual(escaped.status, 0); assert.equal(JSON.parse(escaped.stdout).ok, false);
});
