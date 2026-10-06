import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';

const tempRoot = path.resolve('test/.tmp');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tempRoot, 'relationship-focus-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const aRoot = path.join(workspace, 'A');
  const bRoot = path.join(workspace, 'B');
  fs.mkdirSync(path.join(aRoot, 'Data'), { recursive: true });
  fs.mkdirSync(path.join(bRoot, 'Data'), { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const projectA = registry.create({ name: 'A', currentPath: 'A' });
  const projectB = registry.create({ name: 'B', currentPath: 'B' });
  registry.attachRoot(projectA.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Relationship focus test.' });
  registry.attachRoot(projectB.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'Relationship focus test.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  const resources = {};
  for (const name of ['root', 'middle', 'leaf', 'removed']) {
    const filePath = path.join(aRoot, 'Data', `${name}.md`);
    fs.writeFileSync(filePath, `${name} body`);
    resources[name] = control.identify({ filePath, project: { id: projectA.project_id, name: 'A' } });
  }
  const caller = { tool: 'focus-test', client_run_id: 'relationship-focus' };
  function edge(source, target, reason) {
    const candidate = { project_id: projectA.project_id, source_resource_id: resources[source].resource_id, target: { kind: 'resource', id: resources[target].resource_id }, type: 'linked_to', evidence: { reason } };
    const preview = control.previewLinkedResource({ operation: 'add', candidate, decisionChannel: 'host_command' });
    return control.submitLinkedResource({ operation: 'add', candidate, previewToken: preview.preview_token, requestKey: `add-${source}-${target}`, caller, decisionChannel: 'host_command' }).relationship;
  }
  const first = edge('root', 'middle', 'root to middle');
  const second = edge('middle', 'leaf', 'middle to leaf');
  const third = edge('root', 'removed', 'root to removed');
  const removeCandidate = { project_id: projectA.project_id, source_resource_id: resources.root.resource_id, target: { kind: 'resource', id: resources.removed.resource_id }, type: 'linked_to', relationship_id: third.id, evidence: { reason: 'remove for status filter' } };
  const removePreview = control.previewLinkedResource({ operation: 'remove', candidate: removeCandidate, decisionChannel: 'host_command' });
  control.submitLinkedResource({ operation: 'remove', candidate: removeCandidate, previewToken: removePreview.preview_token, requestKey: 'remove-root-removed', caller, decisionChannel: 'host_command' });
  fs.writeFileSync(path.join(aRoot, 'Data', 'middle.md'), 'middle body accepted at a new version');
  const observed = control.observe({ filePath: path.join(aRoot, 'Data', 'middle.md'), project: { id: projectA.project_id } });
  control.acceptCurrentVersion({ projectId: projectA.project_id, resourceId: resources.middle.resource_id, expectedCurrentVersion: observed.external_change.current.sha256, caller });
  t.after(() => {
    control.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { root, stateDir, workspace, registry, control, projectA, projectB, resources, first, second, third };
}

test('Resource relationship focus bounds hops and status while retaining same-Project edge facts', (t) => {
  const f = fixture(t);
  const rootId = f.resources.root.resource_id;
  const active = f.control.relationshipFocus(f.projectA.project_id, rootId, { depth: 2, status: 'active' });
  assert.deepEqual(active.nodes.map((node) => node.resource_id), [rootId, f.resources.middle.resource_id, f.resources.leaf.resource_id]);
  assert.deepEqual(active.edges.map((edge) => edge.id), [f.first.id, f.second.id]);
  assert.deepEqual(active.edges.map((edge) => edge.hop), [1, 2]);
  assert.equal(active.edges[0].direction, 'outgoing');
  assert.equal(active.edges[0].evidence.reason, 'root to middle');
  assert.equal(active.edges[0].needs_review, true);
  assert.equal(active.file_verification, 'not_checked');
  const removed = f.control.relationshipFocus(f.projectA.project_id, rootId, { depth: 1, status: 'removed' });
  assert.deepEqual(removed.edges.map((edge) => edge.id), [f.third.id]);
  assert.deepEqual(removed.edges[0].evidence.reason, 'remove for status filter');
  const all = f.control.relationshipFocus(f.projectA.project_id, rootId, { depth: 2, status: 'all' });
  assert.deepEqual(new Set(all.edges.map((edge) => edge.id)), new Set([f.first.id, f.second.id, f.third.id]));
  assert.equal(all.edges.find((edge) => edge.id === f.third.id).status, 'removed');
  assert.throws(() => f.control.relationshipFocus(f.projectA.project_id, rootId, { depth: 3 }), /depth must be 1 or 2/u);
  assert.throws(() => f.control.relationshipFocus(f.projectA.project_id, rootId, { status: 'pending' }), /status must be active, removed, or all/u);
  assert.throws(() => f.control.relationshipFocus(f.projectB.project_id, rootId), /active local registered location in the same Project/u);

  const cli = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'resource', 'show', rootId, '--project', f.projectA.project_id, '--relation-depth', '2', '--relation-status', 'all', '--json'], {
    cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  const cliFocus = JSON.parse(cli.stdout).data.relationship_focus;
  assert.equal(cliFocus.root_resource_id, rootId);
  assert.deepEqual(cliFocus.edges.map((edge) => edge.id), all.edges.map((edge) => edge.id));
  assert.deepEqual(cliFocus.edges.map((edge) => edge.evidence), all.edges.map((edge) => edge.evidence));
});
