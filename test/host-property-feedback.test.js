import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Registry } from '../src/registry.js';
import { createProjectViewService } from '../src/project-view-service.js';
import { createResourceControl } from '../src/resource-control.js';
import { startAtlasUiServer } from '../src/ui-server.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'host-feedback-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const aRoot = path.join(workspace, 'A'); const bRoot = path.join(workspace, 'B');
  fs.mkdirSync(path.join(aRoot, 'Data'), { recursive: true }); fs.mkdirSync(path.join(bRoot, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(aRoot, 'Data', 'note.txt'), 'local note'); fs.writeFileSync(path.join(bRoot, 'Data', 'foreign.txt'), 'foreign');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const a = registry.create({ name: 'A', currentPath: 'A' }); const b = registry.create({ name: 'B', currentPath: 'B' });
  registry.attachRoot(a.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'test' }); registry.attachRoot(b.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'test' });
  const service = createProjectViewService({ stateDir, registry });
  t.after(() => { service.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, stateDir, workspace, a, b, registry, service };
}

function cli(f, args) {
  return spawnSync(process.execPath, [path.resolve('bin/atlas.js'), ...args, '--json'], {
    cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8',
  });
}

test('Host CLI reads project property definitions and an accepted candidate after a Desktop decision', async (t) => {
  const f = fixture(t); const member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'Topic', kind: 'text' });
  const stored = f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, candidates: [{ resource_id: member.resource_id, value: 'Local', source_version: member.fact_version, evidence: 'bounded' }], caller: { tool: 'codex', model: 'test', client_run_id: 'feedback' } });
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`; const html = await (await fetch(`${base}/resources?mode=table`)).text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; const candidate = f.service.listPropertyCandidates(f.a.project_id)[0];
  const decision = await fetch(`${base}/resources/properties/candidates/decide`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, return_to: `${base}/resources`, candidate_id: candidate.candidate_id, expected_revision: String(candidate.revision), expected_source_version: candidate.source_version, action: 'accept' }) });
  assert.equal(decision.status, 303);
  const properties = cli(f, ['view', 'properties', '--project', f.a.project_id]); assert.equal(properties.status, 0, properties.stderr);
  assert.deepEqual(JSON.parse(properties.stdout).data, { project_id: f.a.project_id, properties: [property] });
  const shown = cli(f, ['view', 'candidates', 'show', stored.batch_id, '--project', f.a.project_id]); assert.equal(shown.status, 0, shown.stderr);
  const batch = JSON.parse(shown.stdout).data; assert.equal(batch.batch_id, stored.batch_id); assert.equal(batch.project_id, f.a.project_id); assert.equal(batch.candidates.length, 1);
  const accepted = batch.candidates[0]; assert.equal(accepted.stored_status, 'accepted'); assert.equal(accepted.status, 'accepted'); assert.equal(accepted.decision.action, 'accept'); assert.equal(accepted.current_value.value, 'Local'); assert.equal(accepted.applied_value.value, 'Local'); assert.equal(accepted.application_status, 'current'); assert.equal(accepted.source_status, 'current'); assert.equal(accepted.can_accept, false);
  f.service.undoPropertyBatch(accepted.property_batch_id ?? accepted.property_batch?.batch_id ?? candidate.property_batch_id);
  const undone = JSON.parse(cli(f, ['view', 'candidates', 'show', stored.batch_id, '--project', f.a.project_id]).stdout).data.candidates[0];
  assert.equal(undone.decision.action, 'accept'); assert.equal(undone.application_status, 'undone'); assert.equal(undone.current_value, null);
});

test('Host CLI marks changed pending candidates for review and rejects foreign or unknown batches', (t) => {
  const f = fixture(t); const member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'Review', kind: 'text' });
  const batch = f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, candidates: [{ resource_id: member.resource_id, value: 'old', source_version: member.fact_version, evidence: 'bounded' }], caller: { tool: 'codex', model: 'test', client_run_id: 'stale' } });
  fs.appendFileSync(path.join(f.workspace, 'A', member.relative_path), '\nchanged');
  const shown = cli(f, ['view', 'candidates', 'show', batch.batch_id, '--project', f.a.project_id]); assert.equal(shown.status, 0, shown.stderr);
  const candidate = JSON.parse(shown.stdout).data.candidates[0]; assert.equal(candidate.stored_status, 'pending'); assert.equal(candidate.status, 'needs_review'); assert.equal(candidate.source_status, 'changed'); assert.equal(candidate.application_status, 'not_applied'); assert.equal(candidate.can_accept, false);
  for (const projectId of [f.b.project_id, f.a.project_id]) {
    const id = projectId === f.b.project_id ? batch.batch_id : 'PCBAT-unknown'; const result = cli(f, ['view', 'candidates', 'show', id, '--project', projectId]);
    assert.notEqual(result.status, 0); assert.equal(JSON.parse(result.stdout).ok, false);
  }
});

test('Property decision history keeps edit, rejection, and later supersession visible', async (t) => {
  const f = fixture(t); let member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'Decision history', kind: 'text' });
  const caller = { tool: 'codex', model: 'test', client_run_id: 'history' };
  const first = f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, candidates: [{ resource_id: member.resource_id, value: 'stale proposal', source_version: member.fact_version, evidence: 'bounded' }], caller });
  fs.appendFileSync(path.join(f.workspace, 'A', member.relative_path), '\nchanged');
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`;
  let html = await (await fetch(`${base}/resources?mode=table`)).text(); let csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  let candidate = f.service.listPropertyCandidates(f.a.project_id)[0];
  let response = await fetch(`${base}/resources/properties/candidates/decide`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, return_to: `${base}/resources`, candidate_id: candidate.candidate_id, expected_revision: String(candidate.revision), expected_source_version: candidate.source_version, action: 'edit_accept', value: 'reviewed' }) });
  assert.equal(response.status, 303); member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  assert.equal(f.service.recentPropertyDecisions(f.a.project_id)[0].decision.action, 'edit_accept'); assert.equal(f.service.recentPropertyDecisions(f.a.project_id)[0].source_status, 'current'); assert.equal(f.service.recentPropertyDecisions(f.a.project_id)[0].basis_source_version, f.service.recentPropertyDecisions(f.a.project_id)[0].decision.reviewed_source_version);
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, value: 'later value' });
  const rejectedBatch = f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, candidates: [{ resource_id: member.resource_id, value: 'reject me', source_version: member.fact_version, evidence: 'bounded' }], caller });
  html = await (await fetch(`${base}/resources?mode=table`)).text(); csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; candidate = f.service.listPropertyCandidates(f.a.project_id)[0];
  response = await fetch(`${base}/resources/properties/candidates/decide`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, return_to: `${base}/resources`, candidate_id: candidate.candidate_id, expected_revision: String(candidate.revision), expected_source_version: candidate.source_version, action: 'reject' }) });
  assert.equal(response.status, 303); const decisions = f.service.recentPropertyDecisions(f.a.project_id); assert.deepEqual(decisions.map((item) => item.decision.action).sort(), ['edit_accept', 'reject']);
  const edited = decisions.find((item) => item.batch_id === first.batch_id); assert.equal(edited.application_status, 'superseded'); assert.equal(edited.current_value.value, 'later value');
  assert.equal(rejectedBatch.batch_id, candidate.batch_id);
  html = await (await fetch(`${base}/resources?mode=table`)).text(); assert.match(html, /Recent decision history/u); assert.match(html, /Edited and accepted/u); assert.match(html, /Rejected/u); assert.match(html, /Later changed/u);
});
