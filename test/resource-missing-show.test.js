import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';

test('Missing Resource remains readable by its Project and ID without granting a foreign Project access', (t) => {
  const parent = path.resolve('test/.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'resource-missing-show-'));
  assert.equal(path.dirname(root), parent);
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A');
  const otherRoot = path.join(workspace, 'B');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(otherRoot, { recursive: true });
  const file = path.join(projectRoot, 'sample.txt');
  fs.writeFileSync(file, 'last known bytes');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'Missing show', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Missing Resource test.' });
  const other = registry.create({ name: 'Other', currentPath: 'B' });
  registry.attachRoot(other.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'Cross-Project test.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  t.after(() => { control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const identified = control.identify({ filePath: file, project: { id: project.project_id, name: project.name } });
  fs.rmSync(file);
  assert.equal(control.projectResource(project.project_id, identified.resource_id, { refresh: true }).status, 'missing');
  assert.equal(control.linkedResourceRelationships(project.project_id, identified.resource_id).length, 0);
  assert.throws(() => control.linkedResourceRelationships(other.project_id, identified.resource_id), /unavailable in this Project/u);
  const shown = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'resource', 'show', identified.resource_id, '--project', project.project_id, '--json'], {
    cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: stateDir }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(shown.status, 0, shown.stderr);
  const result = JSON.parse(shown.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data.resource_id, identified.resource_id);
  assert.equal(result.data.status, 'missing');
  assert.equal(result.data.last_known_location.path, file);
  assert.equal(fs.existsSync(file), false);
});
