import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '../src/registry.js';
import { LATEST_SCHEMA_VERSION } from '../src/ledger.js';
import { createProjectViewService } from '../src/project-view-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { createResourceControl } from '../src/resource-control.js';
import { renderProjectResourcesView } from '../src/ui/views/project-resources-view.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'resource-views-')); const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const aRoot = path.join(workspace, 'A'); const bRoot = path.join(workspace, 'B'); fs.mkdirSync(path.join(aRoot, 'Data'), { recursive: true }); fs.mkdirSync(path.join(bRoot, 'Data'), { recursive: true });
  for (let i = 0; i < 4; i += 1) fs.writeFileSync(path.join(aRoot, 'Data', `file-${i}.txt`), `row ${i}`); fs.writeFileSync(path.join(bRoot, 'Data', 'foreign.txt'), 'foreign');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' }); const a = registry.create({ name: 'A', currentPath: 'A' }); const b = registry.create({ name: 'B', currentPath: 'B' }); registry.attachRoot(a.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'View fixture.' }); registry.attachRoot(b.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'View fixture.' });
  const service = createProjectViewService({ stateDir, registry }); t.after(() => { service.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); }); return { root, stateDir, workspace, a, b, registry, service };
}

test('Saved Views keep stable identity and config revision independent of member changes', (t) => {
  const f = fixture(t); const first = f.service.saveView({ projectId: f.a.project_id, name: 'Text files', mode: 'files', config: { scope: { path: 'Data' }, filters: [{ field: 'extension', operator: 'equals', value: 'txt' }] } }); const listed = f.service.listViews(f.a.project_id).views; assert.equal(listed[0].view_id, first.view_id); assert.equal(listed[0].revision, 1);
  const edited = f.service.saveView({ projectId: f.a.project_id, viewId: first.view_id, name: 'All files', config: { scope: { path: 'Data' } }, baseRevision: 1 }); assert.equal(edited.view_id, first.view_id); assert.equal(edited.revision, 2); const evaluation = f.service.evaluateView({ viewId: edited.view_id, limit: 2 }); assert.equal(evaluation.evaluation_id.startsWith('EVAL-'), true); assert.equal(evaluation.scope.path, 'Data'); assert.equal(evaluation.completeness, 'partial'); assert.ok(evaluation.continuation);
  const secondPage = f.service.evaluateView({ viewId: edited.view_id, limit: 2, continuation: evaluation.continuation }); assert.equal(secondPage.evaluation_id, evaluation.evaluation_id); assert.equal(secondPage.completeness, 'complete');
  fs.writeFileSync(path.join(f.workspace, 'A', 'Data', 'file-4.txt'), 'new'); assert.throws(() => f.service.evaluateView({ viewId: edited.view_id, limit: 2, continuation: secondPage.continuation ?? evaluation.continuation }), /changed|Restart/u);
});

test('Resource View discovery excludes technical temporary directories from Project Resources', (t) => {
  const f = fixture(t);
  const projectRoot = path.join(f.workspace, 'A');
  fs.mkdirSync(path.join(projectRoot, 'test', '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'test', '.tmp', 'expired.md'), 'temporary');
  fs.mkdirSync(path.join(projectRoot, '.atlas'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.atlas', 'state.md'), 'technical');
  fs.writeFileSync(path.join(projectRoot, 'visible.md'), 'visible');
  const evaluation = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: '' }, limit: 100 });
  assert.ok(evaluation.members.some((item) => item.relative_path === 'visible.md'));
  assert.ok(evaluation.members.every((item) => !item.relative_path.includes('/.tmp/') && !item.relative_path.startsWith('.atlas/')));
  const tracked = f.registry.ledger.resources.locationsForProject(f.a.project_id);
  assert.ok(tracked.every((item) => item.path !== path.join(projectRoot, 'test', '.tmp', 'expired.md') && item.path !== path.join(projectRoot, '.atlas', 'state.md')));
});

test('Properties support text, single, multi atomic batches and version-bound undo', (t) => {
  const f = fixture(t); const files = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' } }).members; const ids = files.slice(0, 2).map((x) => x.resource_id); const text = f.service.defineProperty({ projectId: f.a.project_id, name: 'Note', kind: 'text' }); const single = f.service.defineProperty({ projectId: f.a.project_id, name: 'Status', kind: 'single', options: ['New', 'Done'] }); const multi = f.service.defineProperty({ projectId: f.a.project_id, name: 'Tags', kind: 'multi', options: ['A', 'B', 'C'] });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: ids, propertyId: text.property_id, value: 'hello' }); f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: ids, propertyId: single.property_id, value: 'Done' }); const batch = f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: ids, propertyId: multi.property_id, operation: 'add', value: ['A', 'B'] }); assert.equal(batch.status, 'applied'); f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: ids, propertyId: multi.property_id, operation: 'remove', value: ['A'] }); assert.throws(() => f.service.undoPropertyBatch(batch.batch_id), /changed|conflict|current|later edit/u); const restored = f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: ids, propertyId: multi.property_id, operation: 'replace', value: ['C'] }); const undone = f.service.undoPropertyBatch(restored.batch_id); assert.equal(undone.status, 'undone'); assert.deepEqual(undone.values.map((item) => item.value), [['B'], ['B']]); assert.ok(undone.values.every((item, index) => item.revision > restored.values[index].revision));
  assert.throws(() => f.service.applyPropertyBatch({ projectId: f.b.project_id, resourceIds: ids, propertyId: text.property_id, value: 'foreign' }), /unavailable|Project/u);
});

test('Host property suggestions stay separate until user accept, support Undo, and become review-only when Source changes', (t) => {
  const f = fixture(t);
  const member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'AI topic', kind: 'single', options: ['Local', 'Cloud'] });
  const caller = { tool: 'codex', model: 'gpt-test', client_run_id: 'candidate-test' };
  const preview = f.service.submitPropertyCandidates({
    projectId: f.a.project_id,
    resourceIds: [member.resource_id],
    propertyId: property.property_id,
    candidates: [{ resource_id: member.resource_id, value: 'Local', source_version: member.fact_version, evidence: 'The file discusses local storage.' }],
    caller,
  });
  assert.equal(preview.candidates.length, 1);
  assert.equal(f.registry.ledger.projectViews.value(property.property_id, member.resource_id), undefined);
  let candidate = f.service.listPropertyCandidates(f.a.project_id)[0];
  assert.equal(candidate.status, 'pending'); assert.equal(candidate.can_accept, true);
  const accepted = f.service.decidePropertyCandidate({ projectId: f.a.project_id, candidateId: candidate.candidate_id, action: 'accept', expectedRevision: candidate.revision, expectedSourceVersion: candidate.source_version, caller: { tool: 'atlas-ui', client_run_id: 'user-review' } });
  assert.equal(accepted.property_value.value, 'Local');
  assert.equal(f.service.undoPropertyBatch(accepted.property_batch.batch_id).status, 'undone');

  const current = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const stalePreview = f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [current.resource_id], propertyId: property.property_id, candidates: [{ resource_id: current.resource_id, value: 'Cloud', source_version: current.fact_version, evidence: 'A second bounded suggestion.' }], caller });
  fs.appendFileSync(path.join(f.workspace, 'A', current.relative_path), '\nexternal change');
  candidate = f.service.listPropertyCandidates(f.a.project_id)[0];
  assert.equal(candidate.candidate_id, stalePreview.candidates[0].candidate_id); assert.equal(candidate.status, 'needs_review'); assert.equal(candidate.can_accept, false);
  assert.throws(() => f.service.decidePropertyCandidate({ projectId: f.a.project_id, candidateId: candidate.candidate_id, action: 'accept', expectedRevision: candidate.revision, expectedSourceVersion: candidate.source_version, caller: { tool: 'atlas-ui', client_run_id: 'stale-accept' } }), /needs review|changed/u);
  const edited = f.service.decidePropertyCandidate({ projectId: f.a.project_id, candidateId: candidate.candidate_id, action: 'edit_accept', value: 'Local', expectedRevision: candidate.revision, expectedSourceVersion: candidate.source_version, caller: { tool: 'atlas-ui', client_run_id: 'reviewed-accept' } });
  assert.equal(edited.property_value.value, 'Local');
  const latest = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const rejectedPreview = f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [latest.resource_id], propertyId: property.property_id, candidates: [{ resource_id: latest.resource_id, value: 'Cloud', source_version: latest.fact_version, evidence: 'A suggestion the user rejects.' }], caller });
  const rejected = f.service.decidePropertyCandidate({ projectId: f.a.project_id, candidateId: rejectedPreview.candidates[0].candidate_id, action: 'reject', expectedRevision: 1, expectedSourceVersion: latest.fact_version, caller: { tool: 'atlas-ui', client_run_id: 'reject-candidate' } });
  assert.equal(rejected.status, 'rejected'); assert.equal(f.service.listPropertyCandidates(f.a.project_id).length, 0);
  assert.throws(() => f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [latest.resource_id], propertyId: property.property_id, candidates: Array.from({ length: 11 }, (_, index) => ({ resource_id: `${latest.resource_id}-${index}`, value: 'Local', source_version: latest.fact_version, evidence: 'Too many.' })), caller }), /1 to 10/u);
});

test('Host property suggestion Saved View scope accepts members and rejects Resources outside the View', (t) => {
  const f = fixture(t); const view = f.service.saveView({ projectId: f.a.project_id, name: 'Only file zero', config: { scope: { path: 'Data' }, filters: [{ field: 'name', operator: 'equals', value: 'file-0.txt' }] } });
  const all = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 10 }).members; const inside = all.find((item) => item.name === 'file-0.txt'); const outside = all.find((item) => item.name === 'file-1.txt');
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'View suggestion', kind: 'text' }); const caller = { tool: 'codex', model: 'gpt-test', client_run_id: 'view-scope' };
  const stored = f.service.submitPropertyCandidates({ projectId: f.a.project_id, viewId: view.view_id, propertyId: property.property_id, candidates: [{ resource_id: inside.resource_id, value: 'inside', source_version: inside.fact_version, evidence: 'Member of the Saved View.' }], caller }); assert.equal(stored.candidates.length, 1);
  assert.throws(() => f.service.submitPropertyCandidates({ projectId: f.a.project_id, viewId: view.view_id, propertyId: property.property_id, candidates: [{ resource_id: outside.resource_id, value: 'outside', source_version: outside.fact_version, evidence: 'Not a member.' }], caller }), /outside the declared scope/u);
});

test('Saved View property filters update membership without changing View revision', (t) => {
  const f = fixture(t); const members = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 2 }).members; const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'Visible', kind: 'single', options: ['keep', 'drop'] }); const ids = members.map((item) => item.resource_id); f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: ids, propertyId: property.property_id, value: 'keep' }); const view = f.service.saveView({ projectId: f.a.project_id, name: 'Property filter', config: { scope: { path: 'Data' }, filters: [{ field: `property:${property.property_id}`, operator: 'equals', value: 'keep' }] } }); const before = f.service.evaluateView({ viewId: view.view_id, limit: 10 }); assert.equal(before.members.length, 2); f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [ids[0]], propertyId: property.property_id, value: 'drop' }); const after = f.service.evaluateView({ viewId: view.view_id, limit: 10 }); assert.equal(after.members.length, 1); assert.equal(after.members[0].resource_id, ids[1]); assert.equal(after.view.revision, view.revision);
});

test('Empty property-filtered View exposes keyboard-recoverable clear and show-all actions', async (t) => {
  const f = fixture(t); const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'Visibility', kind: 'single', options: ['keep', 'drop'] });
  const view = f.service.saveView({ projectId: f.a.project_id, name: 'Empty after batch', config: { scope: { path: 'Data' }, filters: [{ field: `property:${property.property_id}`, operator: 'equals', value: 'drop' }] } });
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control }); t.after(async () => { await server.close(); control.dispose(); });
  const response = await fetch(`${server.workspace_url}projects/${f.a.project_id}/resources?view=${view.view_id}&mode=table`); const html = await response.text(); assert.equal(response.status, 200); assert.match(html, /No Resources were returned/u);
  assert.match(html, /data-resource-view-empty-actions/u); assert.match(html, /data-resource-view-clear-filters[^>]*tabindex="0"/u); assert.match(html, /data-resource-view-show-all[^>]*tabindex="0"/u);
});

test('Resource property batch keeps a recoverable resource checkbox focus candidate', () => {
  const client = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  assert.match(client, /resource-property-batch/u);
  assert.match(client, /sessionStorage[\s\S]{0,900}resource-property-batch/u);
  assert.match(client, /resource-property-batch[\s\S]{0,1400}sessionStorage/u);
  assert.match(client, /data-resource-property-focus/u);
  assert.match(client, /data-resource-property-empty-action/u);
  assert.match(client, /nextElementSibling|previousElementSibling/u);
});

test('Undoing a first property assignment removes the value record', (t) => {
  const f = fixture(t); const resource = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0]; const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'First value', kind: 'text' }); const batch = f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [resource.resource_id], propertyId: property.property_id, value: 'temporary' }); assert.equal(f.service.undoPropertyBatch(batch.batch_id).status, 'undone'); const row = f.registry.ledger.db.prepare('SELECT property_id, resource_id FROM resource_property_values WHERE property_id=? AND resource_id=?').get(property.property_id, resource.resource_id); assert.equal(row, undefined);
});

test('Desktop Resources renders view modes, property actions, pinning, Activity, and truthful file fallback', async (t) => {
  const f = fixture(t); const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); let server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.projectRoot, installationRoot: f.root, resourceControl: control }); t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`; let html = await (await fetch(`${base}/resources`)).text(); const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  for (const mode of ['files', 'table', 'cards']) { const response = await fetch(`${base}/resources?mode=${mode}`); assert.equal(response.status, 200); const modeHtml = await response.text(); if (mode === 'files') assert.match(modeHtml, /<a class="resource-view-mode is-active" href="[^"]*mode=files[^"]*"/u); else assert.match(modeHtml, new RegExp(`href="[^"]*mode=${mode}`, 'u')); }
  const saved = await fetch(`${base}/resources/views`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, name: 'Data view', mode: 'cards', scope_path: 'Data' }) }); assert.equal(saved.status, 303); const viewId = new URL(saved.headers.get('location'), server.workspace_url).searchParams.get('view'); assert.ok(viewId); html = await (await fetch(`${base}/resources?view=${viewId}`)).text(); assert.match(html, /Data view/u);
  const property = await fetch(`${base}/resources/properties/define`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, name: 'Label', kind: 'text' }) }); assert.equal(property.status, 303); const definition = f.service.listProperties(f.a.project_id)[0]; const members = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 2 }).members; const applied = await fetch(`${base}/resources/properties/apply`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, property_id: definition.property_id, operation: 'replace', value: 'x', resource_id: members[0].resource_id }) }); assert.equal(applied.status, 303); const activity = await (await fetch(`${server.workspace_url}activity`)).text(); assert.match(activity, /Property|Label/u);
  const home = await (await fetch(base)).text(); const homeCsrf = home.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; const pin = await fetch(`${base}/home/pins`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: homeCsrf, action: 'pin', kind: 'view', id: viewId }) }); assert.equal(pin.status, 303); assert.match(await (await fetch(base)).text(), /Data view|Unpin/u);
  const unsupported = await (await fetch(`${base}/resources?mode=cards`)).text(); assert.doesNotMatch(unsupported, /thumbnail\?path=.*file-0\.txt/u);
  assert.match(unsupported, /<details class="resource-view-settings"><summary>View settings/u);
  assert.match(unsupported, /<details class="surface resource-property-tools"><summary>User properties/u);
  assert.match(unsupported, /class="resource-card-properties"[\s\S]*?<dt>Label<\/dt><dd>x<\/dd>/u);
});

test('Desktop reviews Host property suggestions without writing formal values before acceptance', async (t) => {
  const f = fixture(t); const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  const member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'AI summary', kind: 'text' });
  f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, candidates: [{ resource_id: member.resource_id, value: 'Short local note', source_version: member.fact_version, evidence: 'Bounded preview evidence.' }], caller: { tool: 'codex', model: 'gpt-test', client_run_id: 'desktop-candidate' } });
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control }); t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`; const response = await fetch(`${base}/resources?mode=table&scope_path=Data`); const html = await response.text();
  assert.match(html, /Suggested properties/u); assert.match(html, /Short local note/u); assert.match(html, /Accept/u); assert.match(html, /Edit and accept/u); assert.match(html, /Reject/u);
  assert.equal(f.registry.ledger.projectViews.value(property.property_id, member.resource_id), undefined);
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; const candidate = f.service.listPropertyCandidates(f.a.project_id)[0];
  const accepted = await fetch(`${base}/resources/properties/candidates/decide`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, return_to: `${base}/resources?mode=table`, candidate_id: candidate.candidate_id, expected_revision: String(candidate.revision), expected_source_version: candidate.source_version, action: 'accept' }) });
  assert.equal(accepted.status, 303); assert.equal(f.registry.ledger.projectViews.value(property.property_id, member.resource_id).value, 'Short local note');
});

test('Desktop requires edit-or-reject for stale Host suggestions and routes both decisions', async (t) => {
  const f = fixture(t); const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); let member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'AI review', kind: 'text' }); const caller = { tool: 'codex', model: 'gpt-test', client_run_id: 'stale-ui' };
  f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, candidates: [{ resource_id: member.resource_id, value: 'old suggestion', source_version: member.fact_version, evidence: 'Evidence before the file changed.' }], caller }); fs.appendFileSync(path.join(f.workspace, 'A', member.relative_path), '\nchanged');
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control }); t.after(async () => { await server.close(); control.dispose(); }); const base = `${server.workspace_url}projects/${f.a.project_id}`;
  let html = await (await fetch(`${base}/resources?mode=table&scope_path=Data`)).text(); assert.match(html, /needs review/u); assert.doesNotMatch(html, /name="action" value="accept"/u); assert.match(html, /name="action" value="edit_accept"/u); const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; let candidate = f.service.listPropertyCandidates(f.a.project_id)[0];
  const edited = await fetch(`${base}/resources/properties/candidates/decide`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, return_to: `${base}/resources?mode=table`, candidate_id: candidate.candidate_id, expected_revision: String(candidate.revision), expected_source_version: candidate.source_version, action: 'edit_accept', value: 'reviewed value' }) }); assert.equal(edited.status, 303); assert.equal(f.registry.ledger.projectViews.value(property.property_id, member.resource_id).value, 'reviewed value');
  member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0]; f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, candidates: [{ resource_id: member.resource_id, value: 'reject me', source_version: member.fact_version, evidence: 'A candidate for rejection.' }], caller }); candidate = f.service.listPropertyCandidates(f.a.project_id)[0];
  const rejected = await fetch(`${base}/resources/properties/candidates/decide`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, return_to: `${base}/resources?mode=table`, candidate_id: candidate.candidate_id, expected_revision: String(candidate.revision), expected_source_version: candidate.source_version, action: 'reject' }) }); assert.equal(rejected.status, 303); assert.equal(f.registry.ledger.projectViews.value(property.property_id, member.resource_id).value, 'reviewed value'); assert.equal(f.service.listPropertyCandidates(f.a.project_id).length, 0);
});

test('Desktop shows and accepts an externally changed image Resource version', async (t) => {
  const f = fixture(t); const imagePath = path.join(f.workspace, 'A', 'Data', 'image.png'); fs.writeFileSync(imagePath, Buffer.from('first-image-version'));
  const first = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data', extensions: ['png'] }, limit: 10 }).members[0];
  fs.writeFileSync(imagePath, Buffer.from('second-image-version'));
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control }); t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`; const page = await (await fetch(`${base}/resources?resource_id=${first.resource_id}`)).text();
  assert.match(page, /Changed outside Atlas|Changed since Atlas last used it/u); assert.match(page, /Accept current file version/u);
  const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; const currentVersion = page.match(/name="expected_current_version" value="([a-f0-9]+)"/u)?.[1]; assert.ok(currentVersion);
  const accepted = await fetch(`${base}/resources/actions/accept-current`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, resource_id: first.resource_id, expected_current_version: currentVersion }) }); assert.equal(accepted.status, 303);
  assert.equal(control.projectResource(f.a.project_id, first.resource_id, { refresh: true }).external_change.status, 'unchanged');
});

test('Host JSON view list/evaluate/files and Resource show expose bounded access and the same external-change fact', (t) => {
  const f = fixture(t); const view = f.service.saveView({ projectId: f.a.project_id, name: 'Files', config: { scope: { path: 'Data' } } }); const resource = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0]; const cliPath = path.resolve('bin/atlas.js'); const invoke = (args) => { const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); const envelope = JSON.parse(result.stdout); assert.equal(envelope.ok, true); return envelope.data; }; const listed = invoke(['view', 'list', '--project', f.a.project_id]); assert.equal(listed.host_access, 'read_write_views_and_submit_bounded_candidates'); assert.equal(listed.views[0].view_id, view.view_id); const evaluated = invoke(['view', 'evaluate', view.view_id, '--limit', '2']); assert.match(evaluated.completeness, /complete|partial/u); assert.equal(evaluated.semantic_property_write, 'candidate_preview_with_user_decision'); const files = invoke(['view', 'files', '--project', f.a.project_id, '--scope', 'Data', '--limit', '2']); assert.ok(['complete', 'partial'].includes(files.completeness)); assert.equal(files.host_access, 'read_only'); fs.appendFileSync(path.join(f.workspace, 'A', resource.relative_path), '\nchanged'); const shown = invoke(['resource', 'show', resource.resource_id, '--project', f.a.project_id]); assert.equal(shown.resource_id, resource.resource_id); assert.equal(shown.desktop_href, `/projects/${f.a.project_id}/resources?resource_id=${resource.resource_id}`); assert.equal(shown.external_change.status, 'changed'); const changedView = invoke(['view', 'evaluate', view.view_id, '--limit', '2']); assert.equal(changedView.members.find((item) => item.resource_id === resource.resource_id)?.external_change.status, 'changed');
});

test('Host CLI can submit a bounded candidate Preview without directly writing a user property value', (t) => {
  const f = fixture(t); const member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const requestPath = path.join(f.root, 'candidate-request.json'); fs.writeFileSync(requestPath, JSON.stringify({ scope: { resource_ids: [member.resource_id] }, property: { name: 'Host topic', kind: 'single', options: ['Research', 'Other'] }, candidates: [{ resource_id: member.resource_id, value: 'Research', source_version: member.fact_version, evidence: 'The bounded file sample is about research.' }] }));
  const result = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'view', 'candidates', 'submit', '--project', f.a.project_id, '--request-file', requestPath, '--tool', 'codex', '--model', 'gpt-test', '--client-run-id', 'cli-candidate', '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout).data; assert.equal(data.candidates.length, 1); assert.equal(data.host.tool, 'codex');
  const definition = f.service.listProperties(f.a.project_id).find((item) => item.name === 'Host topic'); assert.ok(definition); assert.equal(f.registry.ledger.projectViews.value(definition.property_id, member.resource_id), undefined);
});

test('Saved View revision conflicts and property batches are atomic', (t) => {
  const f = fixture(t); const view = f.service.saveView({ projectId: f.a.project_id, name: 'Conflict', config: {} });
  assert.throws(() => f.service.saveView({ projectId: f.a.project_id, viewId: view.view_id, name: 'Conflict', config: {}, baseRevision: 0 }), /changed|revision|conflict|current/u);
  const ids = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 2 }).members.map((item) => item.resource_id);
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'Atomic', kind: 'text' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: ids, propertyId: property.property_id, value: 'before' });
  const before = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 2 }).members.map((item) => item.properties[property.property_id]);
  assert.throws(() => f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: ids, propertyId: property.property_id, value: 'after', expectedVersions: { [ids[0]]: before[0].revision, [ids[1]]: before[1].revision - 1 } }), /changed|conflict|revision|current/u);
  const after = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 2 }).members.map((item) => item.properties[property.property_id]);
  assert.deepEqual(after, before);
});

test('Desktop temporary and Saved View configuration filters resources and serves PNG thumbnails', async (t) => {
  const f = fixture(t); const pngPath = path.join(f.workspace, 'A', 'Data', 'pixel.png'); const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'); fs.writeFileSync(pngPath, png);
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.projectRoot, installationRoot: f.root, resourceControl: control }); t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`; let html = await (await fetch(`${base}/resources?mode=cards&scope_path=Data&name_contains=file-1&sort_field=name&sort_direction=desc&group_by=type&visible_fields=Name`)).text(); assert.match(html, /file-1\.txt/u); assert.doesNotMatch(html, /file-0\.txt/u); assert.match(html, /name="visible_fields" value="Name"/u); assert.match(html, /resource-view-group-title/u);
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; const saved = await fetch(`${base}/resources/views`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, name: 'Only one', mode: 'files', scope_path: 'Data', name_contains: 'file-0', sort_field: 'name', sort_direction: 'asc', group_by: 'type', visible_fields: 'Name' }) }); assert.equal(saved.status, 303); const viewId = new URL(saved.headers.get('location'), server.workspace_url).searchParams.get('view'); html = await (await fetch(`${base}/resources?view=${viewId}`)).text(); assert.match(html, /file-0\.txt/u); assert.doesNotMatch(html, /file-1\.txt/u); assert.match(html, /value="Name"/u);
  const cards = await (await fetch(`${base}/resources?mode=cards&scope_path=Data`)).text(); const thumbPath = `/projects/${f.a.project_id}/resources/thumbnail?path=${encodeURIComponent('Data/pixel.png')}`; const thumbSrc = cards.match(/src="([^"]*thumbnail[^"]*)"/u)?.[1]; const thumb = await fetch(new URL(thumbSrc ?? thumbPath, server.workspace_url)); assert.equal(thumb.status, 200); assert.match(thumb.headers.get('content-type') ?? '', /image\/png/u); const txtThumb = await fetch(new URL(`/projects/${f.a.project_id}/resources/thumbnail?path=${encodeURIComponent('Data/file-0.txt')}`, server.workspace_url)); assert.notEqual(txtThumb.status, 200);
});

test('Desktop resource View pagination keeps first members and completes on Show more', async (t) => {
  const f = fixture(t); for (let index = 0; index < 151; index += 1) fs.writeFileSync(path.join(f.workspace, 'A', 'Data', `bulk-${String(index).padStart(3, '0')}.txt`), `bulk ${index}`);
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.projectRoot, installationRoot: f.root, resourceControl: control }); t.after(async () => { await server.close(); control.dispose(); }); const base = `${server.workspace_url}projects/${f.a.project_id}/resources`;
  const first = await (await fetch(`${base}?mode=table&scope_path=Data`)).text(); assert.match(first, /150 returned/u); assert.match(first, /partial/u); const moreHref = first.match(/<a class="text-link" href="([^"]+)">Show more<\/a>/u)?.[1]; assert.ok(moreHref); assert.equal((first.match(/name="resource_id"/gu) ?? []).length, 150); assert.match(first, /bulk-000\.txt/u);
  const second = await (await fetch(new URL(moreHref.replaceAll('&amp;', '&'), server.workspace_url))).text(); assert.match(second, /155 returned/u); assert.match(second, /complete/u); assert.doesNotMatch(second, /Show more/u); assert.equal((second.match(/name="resource_id"/gu) ?? []).length, 155); assert.match(second, /bulk-000\.txt/u); assert.match(second, /file-3\.txt/u);
});

test('Temporary Resource View mode links preserve the current scope and filters', async (t) => {
  const f = fixture(t); const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.projectRoot ?? f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}/resources`;
  const html = await (await fetch(`${base}?mode=table&scope_path=Data&extensions=txt&name_contains=file-1`)).text();
  for (const mode of ['files', 'table', 'cards']) {
    const href = html.match(new RegExp(`href="([^"]*mode=${mode}[^"]*)"`, 'u'))?.[1];
    assert.ok(href, `${mode} mode link should be present`);
    const query = new URLSearchParams(href.replaceAll('&amp;', '&').split('?')[1]);
    assert.equal(query.get('scope_path'), 'Data', `${mode} should preserve scope_path`);
    if (mode === 'files') assert.equal(query.get('folder'), 'Data', 'Files should select the scoped directory');
    assert.equal(query.get('extensions'), 'txt', `${mode} should preserve extensions`);
    assert.equal(query.get('name_contains'), 'file-1', `${mode} should preserve name filter`);
  }
});

test('Files folder selection exposes controls that the client can keep aligned with the selected scope', async (t) => {
  const f = fixture(t); const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.projectRoot ?? f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); });
  const html = await (await fetch(`${server.workspace_url}projects/${f.a.project_id}/resources?mode=files&scope_path=Data&folder=Data`)).text();
  assert.match(html, /data-resource-view-mode="table"/u);
  assert.match(html, /data-resource-view-scope-label>Data</u);
  assert.match(html, /name="scope_path" value="Data"[^>]*data-resource-view-scope-input/u);
  assert.match(html, /data-resource-view-files-link/u);
  const client = fs.readFileSync(path.resolve('src/ui/client.js'), 'utf8');
  assert.match(client, /target\.searchParams\.set\('scope_path', selectedPath\)/u);
  assert.match(client, /link\.dataset\.resourceViewMode === 'files'/u);
  assert.match(client, /new URLSearchParams\(\{ mode: 'files', scope_path: selectedPath, folder: selectedPath \}\)/u);
});

test('Table and Cards expose Work selection for CSV and XLSX members identified by extension', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'A', 'Data', 'work.csv'), 'name,value\nA,1\n');
  fs.writeFileSync(path.join(f.workspace, 'A', 'Data', 'notes.md'), '# Notes\n');
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.projectRoot ?? f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); });
  for (const mode of ['table', 'cards']) {
    const html = await (await fetch(`${server.workspace_url}projects/${f.a.project_id}/resources?mode=${mode}&scope_path=Data`)).text();
    assert.match(html, /data-resource-path="Data\/work\.csv"/u);
    assert.doesNotMatch(html, /data-resource-path="Data\/notes\.md"/u);
  }
});

test('Cards use a 24-item first page and expose Show more while Table keeps 150', async (t) => {
  const f = fixture(t); for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(f.workspace, 'A', 'Data', `card-${String(index).padStart(2, '0')}.txt`), `card ${index}`);
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); }); const base = `${server.workspace_url}projects/${f.a.project_id}/resources`;
  const cards = await (await fetch(`${base}?mode=cards&scope_path=Data`)).text();
  assert.match(cards, /24 returned/u); assert.match(cards, /Show more/u); assert.equal((cards.match(/class="resource-view-card"/gu) ?? []).length, 24);
  const table = await (await fetch(`${base}?mode=table&scope_path=Data`)).text();
  assert.match(table, /34 returned/u); assert.equal((table.match(/name="resource_id"/gu) ?? []).length, 34);
});

test('Partial Resource View receipts show counts with a folded finite issue sample', () => {
  const unchecked = Array.from({ length: 12 }, (_, index) => `folder-${index}`); const failed = Array.from({ length: 8 }, (_, index) => ({ path: `failed-${index}`, error: 'Permission denied' }));
  const html = renderProjectResourcesView({
    mode: 'list', project: { id: 'P-1', name: 'Project' }, base: '/projects/P-1', selected_folder_path: 'Data', work_selection: { count: 0, review_href: '#' },
    resource_view: { mode: 'table', saved_views: [], active_view: null, temporary_config: { scope: { path: 'Data', extensions: [] }, filters: [], sort: [] }, members: [], property_definitions: [], evaluation: { completeness: 'partial', returned_count: 3, known_total: null, unchecked_scopes: unchecked, failed_scopes: failed, more_href: '/projects/P-1/resources?mode=table&scope_path=Data' } },
  });
  assert.match(html, /3 returned/u); assert.match(html, /Show more/u); assert.match(html, /data-resource-view-issues/u); assert.match(html, /Unchecked[^<]*12/u); assert.match(html, /Failed[^<]*8/u);
  assert.doesNotMatch(html, /folder-11/u); assert.doesNotMatch(html, /failed-7/u);
});

test('Files view gives a current scope summary and a directory-selection guide', async (t) => {
  const f = fixture(t); const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); }); const html = await (await fetch(`${server.workspace_url}projects/${f.a.project_id}/resources?mode=files&scope_path=Data`)).text();
  assert.match(html, /Current scope/u); assert.match(html, /Choose a folder|Select a folder|directory/u); assert.match(html, /Data/u);
});

test('Temporary Resource View property actions retain scope, extension, and filter in return_to', async (t) => {
  const f = fixture(t); const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'Label', kind: 'text' }); const member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, value: 'existing' });
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); }); const html = await (await fetch(`${server.workspace_url}projects/${f.a.project_id}/resources?mode=table&scope_path=Data&extensions=txt&name_contains=file-`)).text();
  const returns = [...html.matchAll(/name="return_to" value="([^"]+)"/gu)].map((match) => match[1].replaceAll('&amp;', '&'));
  assert.ok(returns.length >= 3, 'Add property, Apply, and Undo forms should each carry return_to');
  for (const returnTo of returns) { const query = new URL(returnTo, server.workspace_url).searchParams; assert.equal(query.get('scope_path'), 'Data'); assert.equal(query.get('extensions'), 'txt'); assert.equal(query.get('name_contains'), 'file-'); }
});

test('Schema 24 migration preserves Project, Resource, and WorkSession rows', (t) => {
  const f = fixture(t); const filePath = path.join(f.workspace, 'A', 'Data', 'file-0.txt'); const resource = f.service.resources.identify({ filePath, project: { id: f.a.project_id, name: 'A' } }); const sessionId = 'DWT-migration-fixture'; const now = new Date().toISOString(); f.registry.ledger.db.prepare('INSERT INTO work_sessions (id, project_id, status, revision, return_state_json, mapping_json, recipe_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(sessionId, f.a.project_id, 'open', 1, '{}', '[]', '{"schema":"atlas.table-recipe.v1","steps":[]}', now, now); f.service.dispose(); f.registry.dispose();
  const db = new DatabaseSync(path.join(f.stateDir, 'ledger.sqlite')); db.exec('PRAGMA foreign_keys=OFF; DROP TABLE IF EXISTS resource_property_batch_items; DROP TABLE IF EXISTS resource_property_batches; DROP TABLE IF EXISTS resource_property_values; DROP TABLE IF EXISTS resource_property_definitions; DROP TABLE IF EXISTS saved_resource_views; DELETE FROM schema_migrations WHERE version=25; PRAGMA user_version=24;'); db.close();
  const migrated = new Registry({ stateDir: f.stateDir }); try { assert.ok(migrated.list().some((item) => item.id === f.a.project_id)); assert.ok(migrated.ledger.resources.byId(resource.resource_id)); assert.equal(migrated.ledger.workSessions.byId(sessionId).session_id, sessionId); assert.ok(migrated.ledger.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_resource_views'").get()); } finally { migrated.dispose(); }
});

test('Schema 25 migration adds property candidate storage without losing existing View data', (t) => {
  const f = fixture(t); const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'Existing property', kind: 'text' }); const view = f.service.saveView({ projectId: f.a.project_id, name: 'Existing View', config: { scope: { path: 'Data' } } }); f.service.dispose(); f.registry.dispose();
  const db = new DatabaseSync(path.join(f.stateDir, 'ledger.sqlite')); db.exec('PRAGMA foreign_keys=OFF; DROP TABLE IF EXISTS resource_property_candidates; DROP TABLE IF EXISTS resource_property_candidate_batches; DELETE FROM schema_migrations WHERE version=26; PRAGMA user_version=25;'); db.close();
  const migrated = new Registry({ stateDir: f.stateDir }); try { assert.equal(migrated.ledger.db.prepare('PRAGMA user_version').get().user_version, LATEST_SCHEMA_VERSION); assert.ok(migrated.ledger.projectViews.propertyById(property.property_id)); assert.ok(migrated.ledger.projectViews.viewById(view.view_id)); assert.ok(migrated.ledger.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_property_candidate_batches'").get()); assert.ok(migrated.ledger.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_property_candidates'").get()); } finally { migrated.dispose(); }
});

test('Missing Project root reports unknown scope and CLI continuation invalidates after file change', (t) => {
  const f = fixture(t); const view = f.service.saveView({ projectId: f.a.project_id, name: 'Paged', config: { scope: { path: 'Data' } } }); const cliPath = path.resolve('bin/atlas.js'); const run = (args) => spawnSync(process.execPath, [cliPath, ...args, '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' }); const first = run(['view', 'evaluate', view.view_id, '--limit', '1']); assert.equal(first.status, 0, first.stderr); const firstData = JSON.parse(first.stdout).data; assert.ok(firstData.continuation); const second = run(['view', 'evaluate', view.view_id, '--limit', '1', '--continuation', firstData.continuation]); assert.equal(second.status, 0, second.stderr); const secondData = JSON.parse(second.stdout).data; assert.equal(secondData.evaluation_id, firstData.evaluation_id); fs.writeFileSync(path.join(f.workspace, 'A', 'Data', 'file-4.txt'), 'changed'); const invalid = run(['view', 'evaluate', view.view_id, '--limit', '1', '--continuation', firstData.continuation]); assert.notEqual(invalid.status, 0); fs.rmSync(path.join(f.workspace, 'A'), { recursive: true, force: true }); const unknown = f.service.evaluateConfiguration({ projectId: f.a.project_id, config: { scope: { path: 'Data' } } }); assert.equal(unknown.completeness, 'unknown'); assert.ok(unknown.failed_scopes.length); assert.ok(unknown.unchecked_scopes.length);
});
