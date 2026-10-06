import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '../src/registry.js';
import { LATEST_SCHEMA_VERSION } from '../src/ledger.js';
import { createProjectViewService } from '../src/project-view-service.js';
import { Catalog } from '../src/catalog.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { createResourceControl } from '../src/resource-control.js';
import { renderProjectResourcesView } from '../src/ui/views/project-resources-view.js';

function fixture(t, { deferCleanup = false } = {}) {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'resource-views-')); const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const aRoot = path.join(workspace, 'A'); const bRoot = path.join(workspace, 'B'); fs.mkdirSync(path.join(aRoot, 'Data'), { recursive: true }); fs.mkdirSync(path.join(bRoot, 'Data'), { recursive: true });
  for (let i = 0; i < 4; i += 1) fs.writeFileSync(path.join(aRoot, 'Data', `file-${i}.txt`), `row ${i}`); fs.writeFileSync(path.join(bRoot, 'Data', 'foreign.txt'), 'foreign');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' }); const a = registry.create({ name: 'A', currentPath: 'A' }); const b = registry.create({ name: 'B', currentPath: 'B' }); registry.attachRoot(a.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'View fixture.' }); registry.attachRoot(b.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'View fixture.' });
  const service = createProjectViewService({ stateDir, registry }); if (!deferCleanup) t.after(() => { service.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); }); return { root, stateDir, workspace, a, b, registry, service };
}

test('registered-local Saved Views join bounded Catalog terms with registered properties and links', async (t) => {
  const f = fixture(t, { deferCleanup: true });
  let catalog = null;
  let control = null;
  let server = null;
  t.after(async () => {
    if (server) await server.close();
    control?.dispose();
    catalog?.dispose();
    f.service.dispose();
    f.registry.dispose();
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const targetPath = path.join(f.workspace, 'A', 'Data', 'target.txt');
  fs.writeFileSync(targetPath, '交通材料：适合联合条件查询。');
  const oldTime = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(targetPath, oldTime, oldTime);
  const noisePaths = Array.from({ length: 50 }, (_, index) => {
    const filePath = path.join(f.workspace, 'A', 'Data', `candidate-${String(index).padStart(3, '0')}.txt`);
    fs.writeFileSync(filePath, `通勤材料 ${index}`);
    return filePath;
  });
  const unregisteredPath = path.join(f.workspace, 'A', 'Data', 'unregistered.txt');
  fs.writeFileSync(unregisteredPath, '交通材料：未登记，不可出现在结果中。');
  const unsupportedPath = path.join(f.workspace, 'A', 'Data', 'unsupported.pdf');
  fs.writeFileSync(unsupportedPath, '交通');
  const truncatedPath = path.join(f.workspace, 'A', 'Data', 'truncated.txt');
  const oversizedText = Buffer.alloc((2 * 1024 * 1024) + 16, 0x61);
  Buffer.from('交通').copy(oversizedText, oversizedText.length - Buffer.byteLength('交通'));
  fs.writeFileSync(truncatedPath, oversizedText);
  catalog = new Catalog({ stateDir: f.stateDir, registry: f.registry });
  t.after(() => catalog.dispose());
  const resourceFacts = [targetPath, ...noisePaths].map((filePath) => f.service.resources.identify({
    filePath, project: { id: f.a.project_id, name: 'A' },
  }));
  const resourceIds = resourceFacts.map((item) => item.resource_id);
  f.service.resources.identify({ filePath: unsupportedPath, project: { id: f.a.project_id, name: 'A' } });
  f.service.resources.identify({ filePath: truncatedPath, project: { id: f.a.project_id, name: 'A' } });
  const topic = f.service.defineProperty({ projectId: f.a.project_id, name: 'Topic', kind: 'text' });
  const eventDate = f.service.defineProperty({ projectId: f.a.project_id, name: 'Event date', kind: 'text' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds, propertyId: topic.property_id, value: '交通' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds, propertyId: eventDate.property_id, value: '2026-09-15' });
  const relationships = f.service.resources.submitRelationships({
    candidates: resourceIds.map((resourceId) => ({
      source_resource_id: resourceId,
      target: { kind: 'project', id: f.b.project_id },
      type: 'used_by', evidence: { fixture: 'Registered material is used by Project B.' },
    })),
    caller: { tool: 'project-view-test', client_run_id: 'catalog-combined-terms' },
  });
  const fulltextConfig = {
    membership: 'registered_local',
    scope: { path: 'Data', recursive: true },
    fulltext: { terms: ['交通', '通勤'], match: 'any' },
    filters: [
      { field: `property:${topic.property_id}`, operator: 'equals', value: '交通' },
      { field: `property:${eventDate.property_id}`, operator: 'date_between', value: { from: '2026-09-01', to: '2026-09-30' } },
      { field: 'relationship:used_by', operator: 'equals', value: f.b.project_id },
    ],
  };
  const view = f.service.saveView({ projectId: f.a.project_id, name: 'Traffic materials', mode: 'table', config: fulltextConfig });
  const unavailable = f.service.evaluateView({ viewId: view.view_id, limit: 100 });
  assert.equal(unavailable.fulltext_index.status, 'index_unavailable');
  assert.equal(unavailable.known_total, null);
  assert.deepEqual(unavailable.members, []);

  const generation = catalog.update({ projectId: f.a.project_id, caller: { tool: 'project-view-test', client_run_id: 'catalog-combined-index' } });
  assert.equal(generation.status, 'completed');
  const cappedCandidates = catalog.search({ projectId: f.a.project_id, terms: ['交通', '通勤'], maxCandidates: 50 });
  assert.equal(cappedCandidates.candidate_count, 50);
  assert.equal(cappedCandidates.candidates.some((item) => item.relative_path.endsWith('/target.txt')), false);

  const first = f.service.evaluateView({ viewId: view.view_id, limit: 20 });
  assert.equal(first.view.view_id, view.view_id);
  assert.equal(first.view.revision, view.revision);
  assert.deepEqual(first.view.config.fulltext, fulltextConfig.fulltext);
  assert.equal(first.fulltext_index.status, 'available');
  assert.equal(first.fulltext_index.generation_id, generation.generation_id);
  assert.equal(first.known_total, 51);
  assert.equal(first.members.length, 20);
  assert.ok(first.continuation);
  const complete = f.service.evaluateView({ viewId: view.view_id, limit: 100 });
  assert.equal(complete.known_total, 51);
  assert.deepEqual(complete.members.map((item) => item.resource_id).sort(), [...resourceIds].sort());
  const target = complete.members.find((item) => item.resource_id === resourceIds[0]);
  assert.equal(target.catalog_index.generation_id, generation.generation_id);
  assert.equal(target.catalog_index.registered_content_hash, target.content_hash);
  assert.equal(target.file_verification, 'not_checked');
  assert.equal(complete.members.some((item) => item.relative_path.endsWith('/unregistered.txt')), false);
  assert.equal(complete.fulltext_index.coverage.registered_resources, 53);
  assert.equal(complete.fulltext_index.coverage.unsupported_format, 1);
  assert.equal(complete.fulltext_index.coverage.truncated, 1);

  control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  const base = `${server.workspace_url}projects/${f.a.project_id}`;
  const page = await (await fetch(`${base}/resources?view=${encodeURIComponent(view.view_id)}&mode=table`)).text();
  assert.match(page, /Traffic materials/u);
  assert.match(page, /Matches any keyword/u);
  assert.match(page, /Index last updated/u);
  assert.match(page, /file status is not checked/u);
  assert.match(page, /value="交通 通勤"/u);
  const cardsHref = page.match(/<a class="resource-view-mode[^>]*href="([^"]+)"[^>]*data-resource-view-mode="cards"/u)?.[1];
  assert.ok(cardsHref);
  const cardsUrl = new URL(cardsHref.replaceAll('&amp;', '&'), server.workspace_url);
  assert.equal(cardsUrl.searchParams.get('view'), view.view_id);
  assert.equal(cardsUrl.searchParams.get('mode'), 'cards');
  const cardsPage = await (await fetch(cardsUrl)).text();
  assert.match(cardsPage, /value="交通 通勤"/u);
  const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  const update = await fetch(`${base}/resources/views`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, view_id: view.view_id, base_revision: String(view.revision), name: view.name, mode: 'table', scope_path: 'Data', membership: 'registered_local', fulltext_terms: '交通 通勤', property_filter_id: topic.property_id, property_filter_operator: 'equals', property_filter_value: '交通', date_property_id: eventDate.property_id, date_from: '2026-09-01', date_to: '2026-09-30', used_by_project_id: f.b.project_id }),
  });
  assert.equal(update.status, 303);
  const updatedView = f.service.listViews(f.a.project_id).views.find((item) => item.view_id === view.view_id);
  assert.equal(updatedView.revision, view.revision + 1);
  assert.deepEqual(updatedView.config.fulltext, fulltextConfig.fulltext);
  const updatedPage = f.service.evaluateView({ viewId: view.view_id, limit: 20 });
  assert.equal(updatedPage.view.view_id, view.view_id);
  assert.equal(updatedPage.view.revision, updatedView.revision);
  assert.ok(updatedPage.continuation);

  catalog.invalidate(updatedPage.members[0].catalog_index.entry_id);
  assert.throws(
    () => f.service.evaluateView({ viewId: view.view_id, limit: 20, continuation: updatedPage.continuation }),
    (error) => error.code === 'ATLAS_EVALUATION_CHANGED',
  );
  fs.writeFileSync(noisePaths[0], 'Changed after Resource registration with 通勤 terms.');
  catalog.update({ projectId: f.a.project_id, caller: { tool: 'project-view-test', client_run_id: 'catalog-hash-mismatch' } });
  const afterHashChange = f.service.evaluateView({ viewId: view.view_id, limit: 100 });
  assert.equal(afterHashChange.known_total, 50);
  assert.equal(afterHashChange.fulltext_index.coverage.hash_mismatch, 1);
  assert.equal(afterHashChange.members.some((item) => item.resource_id === resourceIds[1]), false);
});

test('Registered View that becomes fulltext between reads evaluates under the Catalog lock', (t) => {
  const f = fixture(t);
  const view = f.service.saveView({
    projectId: f.a.project_id,
    name: 'Changes to fulltext',
    config: { membership: 'registered_local', scope: { path: 'Data' } },
  });
  const repository = f.service.repository;
  const originalViewById = repository.viewById.bind(repository);
  const originalLatestCatalogGeneration = repository.latestCatalogGeneration.bind(repository);
  const lockPath = path.join(f.stateDir, 'locks', 'runtime.lock');
  let reads = 0;
  repository.viewById = (viewId) => {
    const current = originalViewById(viewId);
    reads += 1;
    if (reads === 1 || !current) return current;
    return { ...current, config: { ...current.config, fulltext: { terms: ['term'], match: 'any' } } };
  };
  repository.latestCatalogGeneration = (...args) => {
    assert.equal(fs.existsSync(lockPath), true, 'fulltext Catalog snapshot must be read under the shared state lock');
    return originalLatestCatalogGeneration(...args);
  };
  try {
    const result = f.service.evaluateView({ viewId: view.view_id, limit: 20 });
    assert.equal(result.fulltext_index.status, 'index_unavailable');
    assert.ok(reads >= 3);
  } finally {
    repository.viewById = originalViewById;
    repository.latestCatalogGeneration = originalLatestCatalogGeneration;
  }
});

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

test('registered-local Saved View combines accepted properties, dates, and active used-by links without file observation', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'A', 'Data', 'file-4.txt'), 'row 4');
  const resourceFacts = Array.from({ length: 5 }, (_, index) => {
    const filePath = path.join(f.workspace, 'A', 'Data', `file-${index}.txt`);
    return f.service.resources.identify({ filePath, project: { id: f.a.project_id, name: 'A' } });
  });
  const resourceIds = resourceFacts.map((item) => item.resource_id);
  const topic = f.service.defineProperty({ projectId: f.a.project_id, name: 'Topic', kind: 'text' });
  const eventDate = f.service.defineProperty({ projectId: f.a.project_id, name: 'Event date', kind: 'text' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds, propertyId: topic.property_id, value: '交通' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [resourceIds[2]], propertyId: topic.property_id, value: '就业' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds, propertyId: eventDate.property_id, value: '2026-09-10' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [resourceIds[1]], propertyId: eventDate.property_id, value: '2026-09-11' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [resourceIds[4]], propertyId: eventDate.property_id, value: '2026-09-15oops' });
  const related = f.service.resources.submitRelationships({
    candidates: [0, 1, 2, 3, 4].map((index) => ({
      source_resource_id: resourceIds[index], target: { kind: 'project', id: f.b.project_id },
      type: 'used_by', evidence: { fixture: `Resource ${index} is used by Project B.` },
    })),
    caller: { tool: 'project-view-test', client_run_id: 'registered-local-relations' },
  });
  f.service.resources.removeReference(related[1].id, {
    caller: { tool: 'project-view-test', client_run_id: 'registered-local-remove' },
  });
  f.service.submitPropertyCandidates({
    projectId: f.a.project_id, resourceIds: [resourceIds[2]], propertyId: topic.property_id,
    candidates: [{
      resource_id: resourceIds[2], value: '交通', source_version: resourceFacts[2].evidence.sha256,
      evidence: 'A pending candidate must not be treated as a confirmed property.',
    }],
    caller: { tool: 'codex', model: 'fixture', client_run_id: 'registered-local-pending' },
  });
  const propertyValue = (propertyId, resourceId) => f.registry.ledger.projectViews.value(propertyId, resourceId);
  const view = f.service.saveView({
    projectId: f.a.project_id,
    name: 'September traffic links',
    config: {
      membership: 'registered_local', scope: { path: 'Data', recursive: true },
      filters: [
        { field: `property:${topic.property_id}`, operator: 'equals', value: '交通' },
        { field: `property:${eventDate.property_id}`, operator: 'date_between', value: { from: '2026-09-01', to: '2026-09-30' } },
        { field: 'relationship:used_by', operator: 'equals', value: f.b.project_id },
      ],
    },
  });
  const baselineLocation = resourceFacts[0].locations.find((item) => item.project_id === f.a.project_id && item.status === 'active');
  const topicRevision = propertyValue(topic.property_id, resourceIds[0]).revision;
  const dateRevision = propertyValue(eventDate.property_id, resourceIds[0]).revision;
  fs.writeFileSync(path.join(f.workspace, 'A', 'Data', 'file-0.txt'), 'changed after Resource registration');
  fs.writeFileSync(path.join(f.workspace, 'A', 'Data', 'unregistered.txt'), 'not in Resource Control');
  f.service.resources.observe = () => { throw new Error('registered_local evaluation must not observe files'); };

  const first = f.service.evaluateView({ viewId: view.view_id, limit: 1 });
  assert.equal(first.view.view_id, view.view_id);
  assert.equal(first.view.revision, view.revision);
  assert.equal(first.completeness, 'registered_local');
  assert.equal(first.members.length, 1);
  assert.equal(first.members[0].resource_id, resourceIds[0]);
  assert.equal(first.members[0].relationship_id, related[0].id);
  assert.equal(first.members[0].properties[topic.property_id].revision, topicRevision);
  assert.equal(first.members[0].properties[eventDate.property_id].revision, dateRevision);
  assert.equal(first.members[0].last_known_location.id, baselineLocation.id);
  assert.equal(first.members[0].content_hash, baselineLocation.content_hash);
  assert.equal(first.members[0].modified_at, baselineLocation.modified_at);
  assert.equal(first.members[0].file_verification, 'not_checked');
  assert.ok(first.continuation);
  assert.equal(first.known_total, 2);
  const second = f.service.evaluateView({ viewId: view.view_id, limit: 1, continuation: first.continuation });
  assert.deepEqual(second.members.map((item) => item.resource_id), [resourceIds[3]]);
  assert.equal(second.view.view_id, view.view_id);

  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [resourceIds[0]], propertyId: eventDate.property_id, value: '2026-09-12' });
  assert.throws(
    () => f.service.evaluateView({ viewId: view.view_id, limit: 1, continuation: first.continuation }),
    (error) => error.code === 'ATLAS_EVALUATION_CHANGED',
  );
  const afterPropertyChange = f.service.evaluateView({ viewId: view.view_id, limit: 1 });
  assert.equal(afterPropertyChange.known_total, 2);
  assert.ok(afterPropertyChange.continuation);

  f.service.resources.removeReference(related[3].id, {
    caller: { tool: 'project-view-test', client_run_id: 'registered-local-remove-second' },
  });
  assert.throws(
    () => f.service.evaluateView({ viewId: view.view_id, limit: 1, continuation: afterPropertyChange.continuation }),
    (error) => error.code === 'ATLAS_EVALUATION_CHANGED',
  );

  const afterRelationshipChange = f.service.evaluateView({ viewId: view.view_id, limit: 1 });
  assert.equal(afterRelationshipChange.known_total, 1);
  assert.equal(afterRelationshipChange.members[0].resource_id, resourceIds[0]);
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [resourceIds[0]], propertyId: topic.property_id, value: '就业' });
  assert.equal(f.service.evaluateView({ viewId: view.view_id, limit: 1 }).known_total, 0);

  assert.throws(
    () => f.service.evaluateConfiguration({ projectId: f.a.project_id, config: { membership: 'registered_local', scope: { path: '../B' } } }),
    /inside its Project/u,
  );
  assert.throws(
    () => f.service.evaluateConfiguration({
      projectId: f.a.project_id,
      config: { membership: 'registered_local', scope: { path: 'Data' }, filters: [
        { field: `property:${f.service.defineProperty({ projectId: f.b.project_id, name: 'Foreign', kind: 'text' }).property_id}`, operator: 'equals', value: 'x' },
      ] },
    }),
    /unavailable in this Project/u,
  );
  assert.throws(
    () => f.service.evaluateConfiguration({
      projectId: f.a.project_id,
      config: { membership: 'registered_local', scope: { path: 'Data' }, filters: [
        { field: `property:${eventDate.property_id}`, operator: 'date_between', value: { from: '2026-02-30', to: '2026-03-01' } },
      ] },
    }),
    /valid YYYY-MM-DD range/u,
  );
});

test('registered-local Saved View intersects linked_to, properties, dates, used_by, and Catalog terms', (t) => {
  const f = fixture(t, { deferCleanup: true });
  let catalog = null;
  t.after(() => { catalog?.dispose(); f.service.dispose(); f.registry.dispose(); fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const resourceFacts = Array.from({ length: 4 }, (_, index) => {
    const filePath = path.join(f.workspace, 'A', 'Data', `file-${index}.txt`);
    fs.writeFileSync(filePath, `交通材料 ${index}`);
    return f.service.resources.identify({ filePath, project: { id: f.a.project_id, name: 'A' } });
  });
  const resourceIds = resourceFacts.map((item) => item.resource_id);
  const topic = f.service.defineProperty({ projectId: f.a.project_id, name: 'Link topic', kind: 'text' });
  const eventDate = f.service.defineProperty({ projectId: f.a.project_id, name: 'Link date', kind: 'text' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds, propertyId: topic.property_id, value: '交通' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds, propertyId: eventDate.property_id, value: '2026-09-15' });
  f.service.resources.submitRelationships({
    candidates: [0, 1, 3].map((index) => ({ source_resource_id: resourceIds[index], target: { kind: 'project', id: f.b.project_id }, type: 'used_by', evidence: { reason: 'Used in Project B.' } })),
    caller: { tool: 'project-view-test', client_run_id: 'linked-view-used-by' },
  });
  const link = (operation, sourceIndex, key, relationshipId = null) => {
    const candidate = { project_id: f.a.project_id, source_resource_id: resourceIds[sourceIndex], target: { kind: 'resource', id: resourceIds[2] }, type: 'linked_to', evidence: { reason: 'Explicit fixture link.' } };
    if (operation === 'remove') candidate.relationship_id = relationshipId;
    const preview = f.service.resources.previewLinkedResource({ operation, candidate, decisionChannel: 'host_command' });
    return f.service.resources.submitLinkedResource({ operation, candidate, previewToken: preview.preview_token, requestKey: key, caller: { tool: 'project-view-test', client_run_id: key }, decisionChannel: 'host_command' });
  };
  const firstLink = link('add', 0, 'linked-view-add-0');
  const secondLink = link('add', 1, 'linked-view-add-1');
  catalog = new Catalog({ stateDir: f.stateDir, registry: f.registry });
  catalog.update({ projectId: f.a.project_id, caller: { tool: 'project-view-test', client_run_id: 'linked-view-index' } });
  const config = {
    membership: 'registered_local', scope: { path: 'Data', recursive: true },
    fulltext: { terms: ['交通'], match: 'any' },
    filters: [
      { field: `property:${topic.property_id}`, operator: 'equals', value: '交通' },
      { field: `property:${eventDate.property_id}`, operator: 'date_between', value: { from: '2026-09-01', to: '2026-09-30' } },
      { field: 'relationship:used_by', operator: 'equals', value: f.b.project_id },
      { field: 'relationship:linked_to', operator: 'equals', value: resourceIds[2] },
    ],
  };
  const view = f.service.saveView({ projectId: f.a.project_id, name: 'Confirmed linked materials', config });
  const first = f.service.evaluateView({ viewId: view.view_id, limit: 1 });
  assert.equal(first.view.view_id, view.view_id);
  assert.equal(first.view.revision, view.revision);
  assert.equal(first.known_total, 2);
  assert.equal(first.members.length, 1);
  assert.equal(first.members[0].resource_id, resourceIds[0]);
  assert.equal(first.members[0].linked_relationship_id, firstLink.relationship.id);
  assert.equal(first.members[0].linked_relationship_target_id, resourceIds[2]);
  assert.equal(first.members[0].file_verification, 'not_checked');
  assert.ok(first.continuation);
  const cli = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'view', 'evaluate', view.view_id, '--limit', '1', '--json'], {
    cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  const cliData = JSON.parse(cli.stdout).data;
  assert.equal(cliData.view.view_id, view.view_id);
  assert.equal(cliData.view.revision, view.revision);
  assert.equal(cliData.members[0].resource_id, resourceIds[0]);
  assert.equal(cliData.members[0].linked_relationship_id, firstLink.relationship.id);

  link('remove', 1, 'linked-view-remove-1', secondLink.relationship.id);
  assert.throws(() => f.service.evaluateView({ viewId: view.view_id, limit: 1, continuation: first.continuation }), (error) => error.code === 'ATLAS_EVALUATION_CHANGED');
  const restored = link('add', 1, 'linked-view-readd-1');
  assert.equal(restored.relationship.id, secondLink.relationship.id);
  const beforeTargetChange = f.service.evaluateView({ viewId: view.view_id, limit: 1 });
  assert.equal(beforeTargetChange.known_total, 2);
  assert.ok(beforeTargetChange.continuation);
  const missingTarget = { ...config, filters: config.filters.map((filter) => filter.field === 'relationship:linked_to' ? { ...filter, value: 'RES-MISSING' } : filter) };
  assert.throws(() => f.service.evaluateConfiguration({ projectId: f.a.project_id, config: missingTarget }), /target Resource is unavailable in this Project/u);
  const targetPath = path.join(f.workspace, 'A', 'Data', 'file-2.txt');
  fs.writeFileSync(targetPath, 'accepted target version changed');
  const observed = f.service.resources.observe({ filePath: targetPath, project: { id: f.a.project_id } });
  f.service.resources.acceptCurrentVersion({ projectId: f.a.project_id, resourceId: resourceIds[2], expectedCurrentVersion: observed.external_change.current.sha256, caller: { tool: 'project-view-test', client_run_id: 'linked-target-version' } });
  assert.throws(() => f.service.evaluateView({ viewId: view.view_id, limit: 1, continuation: beforeTargetChange.continuation }), (error) => error.code === 'ATLAS_EVALUATION_CHANGED');
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

test('Focused Project Resource scroll stays inside the file list', () => {
  const client = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  assert.match(client, /closest\('\.workspace-resource-list-scroll'\)/u);
  assert.match(client, /scrollContainer\.scrollTop/u);
  assert.doesNotMatch(client, /focusedRow\.scrollIntoView/u);
});

test('Resources HTML previews and confirms same-Project linked_to edges and reads/removes the same edge', async (t) => {
  const f = fixture(t, { deferCleanup: true });
  const sourcePath = path.join(f.workspace, 'A', 'Data', 'link-source.txt');
  const targetPath = path.join(f.workspace, 'A', 'Data', 'link-target.txt');
  const foreignPath = path.join(f.workspace, 'B', 'Data', 'foreign-link-target.txt');
  fs.writeFileSync(sourcePath, 'source material');
  fs.writeFileSync(targetPath, 'target material');
  fs.writeFileSync(foreignPath, 'foreign target');
  const source = f.service.resources.identify({ filePath: sourcePath, project: { id: f.a.project_id, name: 'A' } });
  const target = f.service.resources.identify({ filePath: targetPath, project: { id: f.a.project_id, name: 'A' } });
  const foreign = f.service.resources.identify({ filePath: foreignPath, project: { id: f.b.project_id, name: 'B' } });
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger, registry: f.registry });
  let server = null;
  t.after(async () => {
    if (server) await server.close();
    control.dispose();
    f.service.dispose();
    f.registry.dispose();
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  const pageUrl = new URL(`/projects/${f.a.project_id}/resources?resource_id=${encodeURIComponent(source.resource_id)}`, server.workspace_url);
  const sourcePage = await (await fetch(pageUrl)).text();
  const csrf = sourcePage.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  const previewUrl = new URL(`/projects/${f.a.project_id}/resources/links/preview`, server.workspace_url);
  const submitUrl = new URL(`/projects/${f.a.project_id}/resources/links/submit`, server.workspace_url);
  const sourceCandidate = { operation: 'add', source_resource_id: source.resource_id, target_resource_id: target.resource_id, reason: 'The user linked these materials in Resources.' };
  const post = (url, fields) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const initialRows = f.registry.ledger.db.prepare("SELECT COUNT(*) AS count FROM resource_relationships WHERE type='linked_to'").get().count;
  const badCsrf = await post(previewUrl, { ...sourceCandidate, csrf: 'invalid' });
  assert.notEqual(badCsrf.status, 200);
  assert.equal(f.registry.ledger.db.prepare("SELECT COUNT(*) AS count FROM resource_relationships WHERE type='linked_to'").get().count, initialRows);

  const preview = await post(previewUrl, { ...sourceCandidate, csrf });
  assert.equal(preview.status, 200);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /link-source\.txt/u);
  assert.match(previewHtml, /link-target\.txt/u);
  assert.match(previewHtml, /not_checked/u);
  assert.equal(f.registry.ledger.resources.linkedRelationship(f.a.project_id, source.resource_id, target.resource_id), undefined);
  const previewToken = previewHtml.match(/name="preview_token" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(previewToken);
  const addedResponse = await post(submitUrl, { ...sourceCandidate, csrf, preview_token: previewToken, request_key: 'ui-link-add-source-target' });
  assert.equal(addedResponse.status, 303);
  const relation = f.registry.ledger.resources.linkedRelationship(f.a.project_id, source.resource_id, target.resource_id);
  assert.equal(relation.status, 'active');
  const sourceAfter = await (await fetch(pageUrl)).text();
  const edgeId = relation.id;
  assert.match(sourceAfter, new RegExp(`data-resource-link-id="${edgeId}"`, 'u'));
  assert.match(sourceAfter, new RegExp(`href="[^"]*resource_id=${encodeURIComponent(target.resource_id)}"`, 'u'));
  const targetPage = await (await fetch(new URL(`/projects/${f.a.project_id}/resources?resource_id=${encodeURIComponent(target.resource_id)}`, server.workspace_url))).text();
  assert.match(targetPage, new RegExp(`data-resource-link-id="${edgeId}"`, 'u'));
  assert.match(targetPage, /incoming/u);

  const savedView = f.service.saveView({ projectId: f.a.project_id, name: 'Linked to target', mode: 'table', config: {
    membership: 'registered_local', scope: { path: 'Data' },
    filters: [{ field: 'relationship:linked_to', operator: 'equals', value: target.resource_id }],
  } });
  const viewPage = await (await fetch(new URL(`/projects/${f.a.project_id}/resources?view=${encodeURIComponent(savedView.view_id)}&mode=table`, server.workspace_url))).text();
  const resultSection = viewPage.match(/<section class="surface resource-view-results">([\s\S]*?)<\/section>/u)?.[1];
  assert.ok(resultSection);
  assert.match(resultSection, new RegExp(`data-resource-property-focus="${source.resource_id}"`, 'u'));
  assert.doesNotMatch(resultSection, new RegExp(`data-resource-property-focus="${target.resource_id}"`, 'u'));

  const crossProject = await post(previewUrl, { ...sourceCandidate, target_resource_id: foreign.resource_id, csrf });
  assert.notEqual(crossProject.status, 200);
  const unregistered = await post(previewUrl, { ...sourceCandidate, target_resource_id: 'RES-NOT-REGISTERED', csrf });
  assert.notEqual(unregistered.status, 200);
  assert.equal(f.registry.ledger.resources.relationshipById(edgeId).status, 'active');

  const removeCandidate = { operation: 'remove', source_resource_id: source.resource_id, target_resource_id: target.resource_id, relationship_id: edgeId, reason: 'The user removed this link in Resources.' };
  const removePreview = await post(previewUrl, { ...removeCandidate, csrf });
  assert.equal(removePreview.status, 200);
  const removeHtml = await removePreview.text();
  const removeToken = removeHtml.match(/name="preview_token" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(removeToken);
  const removed = await post(submitUrl, { ...removeCandidate, csrf, preview_token: removeToken, request_key: 'ui-link-remove-source-target' });
  assert.equal(removed.status, 303);
  assert.equal(f.registry.ledger.resources.relationshipById(edgeId).status, 'removed');
  const emptyViewPage = await (await fetch(new URL(`/projects/${f.a.project_id}/resources?view=${encodeURIComponent(savedView.view_id)}&mode=table`, server.workspace_url))).text();
  const emptyResults = emptyViewPage.match(/<section class="surface resource-view-results">([\s\S]*?)<\/section>/u)?.[1];
  assert.ok(emptyResults);
  assert.doesNotMatch(emptyResults, new RegExp(`data-resource-property-focus="${source.resource_id}"`, 'u'));
});

test('Resources GET preserves external and missing links and link previews reject blank reasons', async (t) => {
  const f = fixture(t, { deferCleanup: true });
  const sourcePath = path.join(f.workspace, 'A', 'Data', 'linked-source.txt');
  const targetPath = path.join(f.workspace, 'A', 'Data', 'linked-target-missing.txt');
  const blankReasonTargetPath = path.join(f.workspace, 'A', 'Data', 'blank-reason-target.txt');
  const externalPath = path.join(f.workspace, 'B', 'Data', 'foreign.txt');
  fs.writeFileSync(sourcePath, 'source');
  fs.writeFileSync(targetPath, 'target');
  fs.writeFileSync(blankReasonTargetPath, 'valid local target for reason validation');
  const source = f.service.resources.identify({ filePath: sourcePath, project: { id: f.a.project_id, name: 'A' } });
  const target = f.service.resources.identify({ filePath: targetPath, project: { id: f.a.project_id, name: 'A' } });
  const blankReasonTarget = f.service.resources.identify({ filePath: blankReasonTargetPath, project: { id: f.a.project_id, name: 'A' } });
  const external = f.service.resources.identify({ filePath: externalPath, project: { id: f.b.project_id, name: 'B' } });
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger, registry: f.registry });
  let server = null;
  t.after(async () => {
    if (server) await server.close();
    control.dispose();
    f.service.dispose();
    f.registry.dispose();
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  const base = new URL(`/projects/${f.a.project_id}`, server.workspace_url);
  const home = await (await fetch(base)).text();
  const csrf = home.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  const previewUrl = new URL(`/projects/${f.a.project_id}/resources/links/preview`, server.workspace_url);
  const post = (url, fields) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });

  control.submitRelationships({
    candidates: [{ source_resource_id: external.resource_id, target: { kind: 'project', id: f.a.project_id }, type: 'used_by', evidence: { reason: 'External material is used by Project A.' } }],
    caller: { tool: 'resource-view-html-test', client_run_id: 'external-used-by' },
  });
  const candidate = {
    project_id: f.a.project_id,
    source_resource_id: source.resource_id,
    target: { kind: 'resource', id: target.resource_id },
    type: 'linked_to',
    evidence: { reason: 'User connected these Resources.' },
  };
  const preview = control.previewLinkedResource({ operation: 'add', candidate, decisionChannel: 'ui_confirm' });
  const receipt = control.submitLinkedResource({
    operation: 'add', candidate, previewToken: preview.preview_token, requestKey: 'missing-target-link',
    caller: { tool: 'resource-view-html-test', client_run_id: 'missing-target-link' }, decisionChannel: 'ui_confirm',
  });
  fs.rmSync(targetPath);

  const resourcesResponse = await fetch(new URL(`${base.pathname}/resources`, server.workspace_url));
  assert.equal(resourcesResponse.status, 200);
  const resourcesHtml = await resourcesResponse.text();
  assert.match(resourcesHtml, /foreign\.txt/u);
  assert.match(resourcesHtml, /linked-target-missing\.txt/u);

  const sourcePage = await (await fetch(new URL(`${base.pathname}/resources?resource_id=${encodeURIComponent(source.resource_id)}`, server.workspace_url))).text();
  assert.match(sourcePage, new RegExp(`data-resource-link-id="${receipt.relationship.id}"`, 'u'));
  assert.match(sourcePage, /Registration changed; review this link/u);
  const missingTargetPage = await fetch(new URL(`${base.pathname}/resources?resource_id=${encodeURIComponent(target.resource_id)}`, server.workspace_url));
  assert.equal(missingTargetPage.status, 200);

  const beforeBlankReason = f.registry.ledger.db.prepare("SELECT COUNT(*) AS count FROM resource_relationships WHERE type='linked_to'").get().count;
  const blankReason = await post(previewUrl, {
    csrf, operation: 'add', source_resource_id: source.resource_id, target_resource_id: blankReasonTarget.resource_id, reason: '   ',
  });
  assert.notEqual(blankReason.status, 200);
  assert.equal(f.registry.ledger.db.prepare("SELECT COUNT(*) AS count FROM resource_relationships WHERE type='linked_to'").get().count, beforeBlankReason);
  assert.equal(f.registry.ledger.resources.relationshipById(receipt.relationship.id).status, 'active');
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

test('Desktop Resources previews and saves the same registered-local combination and continues bounded results', async (t) => {
  const f = fixture(t);
  const resourceFacts = Array.from({ length: 4 }, (_, index) => f.service.resources.identify({
    filePath: path.join(f.workspace, 'A', 'Data', `file-${index}.txt`),
    project: { id: f.a.project_id, name: 'A' },
  }));
  const resourceIds = resourceFacts.map((item) => item.resource_id);
  const topic = f.service.defineProperty({ projectId: f.a.project_id, name: 'Topic', kind: 'text' });
  const eventDate = f.service.defineProperty({ projectId: f.a.project_id, name: 'Event date', kind: 'text' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds, propertyId: topic.property_id, value: '交通' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [resourceIds[2]], propertyId: topic.property_id, value: '就业' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds, propertyId: eventDate.property_id, value: '2026-09-10' });
  f.service.applyPropertyBatch({ projectId: f.a.project_id, resourceIds: [resourceIds[3]], propertyId: eventDate.property_id, value: '2026-10-02' });
  f.service.resources.submitRelationships({
    candidates: resourceIds.map((resourceId, index) => ({
      source_resource_id: resourceId,
      target: { kind: 'project', id: f.b.project_id },
      type: 'used_by', evidence: { fixture: `Resource ${index} is used by Project B.` },
    })),
    caller: { tool: 'project-resource-view-test', client_run_id: 'registered-local-ui-relations' },
  });
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`;
  const params = new URLSearchParams({
    mode: 'table', membership: 'registered_local', scope_path: 'Data',
    property_filter_id: topic.property_id, property_filter_operator: 'equals', property_filter_value: '交通',
    date_property_id: eventDate.property_id, date_from: '2026-09-01', date_to: '2026-09-30',
    used_by_project_id: f.b.project_id, view_items: '1',
  });
  const resultResourceIds = (pageHtml) => {
    const results = pageHtml.match(/<section class="surface resource-view-results">([\s\S]*?)<\/section>/u)?.[1];
    assert.ok(results, 'registered-local members render inside the Resource results section');
    return [...results.matchAll(/<(?:tr|article)\b[^>]*\bdata-resource-property-focus="([^"]+)"/gu)].map((match) => match[1]);
  };
  const response = await fetch(`${base}/resources?${params}`);
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.match(html, /Registered local Resources/u);
  assert.match(html, /not checked/u);
  assert.match(html, /Show more/u);
  assert.deepEqual(resultResourceIds(html), [resourceIds[0]]);
  const moreHref = html.match(/<a class="text-link" href="([^"]+)"[^>]*>Show more<\/a>/u)?.[1];
  assert.ok(moreHref);
  assert.equal(new URL(moreHref.replaceAll('&amp;', '&'), server.workspace_url).searchParams.get('view_items'), '100');
  const moreResponse = await fetch(new URL(moreHref.replaceAll('&amp;', '&'), server.workspace_url));
  assert.equal(moreResponse.status, 200);
  const moreHtml = await moreResponse.text();
  assert.deepEqual(resultResourceIds(moreHtml), [resourceIds[0], resourceIds[1]]);
  const cardsHref = html.match(/<a class="resource-view-mode[^>]*href="([^"]+)"[^>]*data-resource-view-mode="cards"/u)?.[1];
  assert.ok(cardsHref);
  const cardsUrl = new URL(cardsHref.replaceAll('&amp;', '&'), server.workspace_url);
  for (const [key, value] of params) {
    if (key !== 'mode' && key !== 'view_items') assert.equal(cardsUrl.searchParams.get(key), value, `mode switch preserves ${key}`);
  }

  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  const post = new URLSearchParams({
    csrf, name: 'September traffic links', mode: 'table', membership: 'registered_local', scope_path: 'Data',
    property_filter_id: topic.property_id, property_filter_operator: 'equals', property_filter_value: '交通',
    date_property_id: eventDate.property_id, date_from: '2026-09-01', date_to: '2026-09-30',
    used_by_project_id: f.b.project_id,
  });
  const saved = await fetch(`${base}/resources/views`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: post });
  assert.equal(saved.status, 303);
  const viewId = new URL(saved.headers.get('location'), server.workspace_url).searchParams.get('view');
  assert.ok(viewId);
  const stored = f.service.listViews(f.a.project_id).views.find((item) => item.view_id === viewId);
  assert.ok(stored);
  assert.deepEqual(stored.config, {
    membership: 'registered_local',
    scope: { path: 'Data', recursive: true, extensions: [] },
    filters: [
      { field: `property:${topic.property_id}`, operator: 'equals', value: '交通' },
      { field: `property:${eventDate.property_id}`, operator: 'date_between', value: { from: '2026-09-01', to: '2026-09-30' } },
      { field: 'relationship:used_by', operator: 'equals', value: f.b.project_id },
    ],
    sort: [], group_by: null, visible_fields: [],
  });
  const defaultSavedViewResponse = await fetch(`${base}/resources?view=${encodeURIComponent(viewId)}`);
  assert.equal(defaultSavedViewResponse.status, 200);
  html = await defaultSavedViewResponse.text();
  assert.match(html, /September traffic links/u);
  assert.match(html, /Registered local Resources/u);
  assert.deepEqual(resultResourceIds(html), [resourceIds[0], resourceIds[1]]);

  html = await (await fetch(`${base}/resources?view=${encodeURIComponent(viewId)}&view_items=1`)).text();
  assert.match(html, /Show more/u);
  const savedMoreHref = html.match(/<a class="text-link" href="([^"]+)"[^>]*>Show more<\/a>/u)?.[1];
  assert.ok(savedMoreHref);
  assert.equal(new URL(savedMoreHref.replaceAll('&amp;', '&'), server.workspace_url).searchParams.get('view_items'), '100');
  const savedMoreResponse = await fetch(new URL(savedMoreHref.replaceAll('&amp;', '&'), server.workspace_url));
  assert.equal(savedMoreResponse.status, 200);
  assert.deepEqual(resultResourceIds(await savedMoreResponse.text()), [resourceIds[0], resourceIds[1]]);
  assert.equal(stored.view_id, viewId);

  const topicOnlyView = f.service.saveView({
    projectId: f.a.project_id,
    name: 'Topic only display',
    mode: 'table',
    config: {
      membership: 'registered_local', scope: { path: 'Data' },
      filters: [{ field: `property:${topic.property_id}`, operator: 'equals', value: '交通' }],
    },
  });
  const topicEvaluation = f.service.evaluateView({ viewId: topicOnlyView.view_id, limit: 100 });
  assert.deepEqual(topicEvaluation.members.map((item) => item.resource_id), [resourceIds[0], resourceIds[1], resourceIds[3]]);
  const dateValue = f.registry.ledger.projectViews.value(eventDate.property_id, resourceIds[3]);
  const displayedThirdResource = topicEvaluation.members.find((item) => item.resource_id === resourceIds[3]);
  assert.ok(displayedThirdResource.display_properties, 'registered result includes current Project display properties');
  assert.deepEqual(displayedThirdResource.display_properties[eventDate.property_id], {
    value: '2026-10-02', revision: dateValue.revision, updated_at: dateValue.updated_at,
  });
  for (const mode of ['table', 'cards']) {
    const displayResponse = await fetch(`${base}/resources?view=${encodeURIComponent(topicOnlyView.view_id)}&mode=${mode}`);
    assert.equal(displayResponse.status, 200);
    const displayHtml = await displayResponse.text();
    assert.deepEqual(resultResourceIds(displayHtml), [resourceIds[0], resourceIds[1], resourceIds[3]]);
    const displaySection = displayHtml.match(/<section class="surface resource-view-results">([\s\S]*?)<\/section>/u)?.[1];
    assert.ok(displaySection);
    const thirdResourcePattern = mode === 'table'
      ? new RegExp(`<tr data-resource-property-focus="${resourceIds[3]}"[^>]*>([\\s\\S]*?)<\\/tr>`, 'u')
      : new RegExp(`<article class="resource-view-card" data-resource-property-focus="${resourceIds[3]}"[^>]*>([\\s\\S]*?)<\\/article>`, 'u');
    const thirdResourceHtml = displaySection.match(thirdResourcePattern)?.[1];
    assert.ok(thirdResourceHtml, 'the exact Resource row remains present with its reader attributes');
    assert.match(thirdResourceHtml, /2026-10-02/u);
  }
});

test('Desktop reviews Host property suggestions without writing formal values before acceptance', async (t) => {
  const f = fixture(t); const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  const member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: 'AI summary', kind: 'text' });
  f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [member.resource_id], propertyId: property.property_id, candidates: [{ resource_id: member.resource_id, value: 'Short local note', source_version: member.fact_version, evidence: 'Bounded preview evidence.' }], caller: { tool: 'codex', model: 'gpt-test', client_run_id: 'desktop-candidate' } });
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control }); t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`; const response = await fetch(`${base}/resources?mode=table&scope_path=Data`); const html = await response.text();
  assert.match(html, /Suggested properties/u); assert.match(html, /Short local note/u); assert.match(html, /Prompt version/u); assert.match(html, /Not recorded/u); assert.match(html, /Accept/u); assert.match(html, /Edit and accept/u); assert.match(html, /Reject/u);
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
  const f = fixture(t, { deferCleanup: true }); const imagePath = path.join(f.workspace, 'A', 'Data', 'image.png'); fs.writeFileSync(imagePath, Buffer.from('first-image-version'));
  const first = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data', extensions: ['png'] }, limit: 10 }).members[0];
  fs.writeFileSync(imagePath, Buffer.from('second-image-version'));
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control }); t.after(async () => { await server.close(); control.dispose(); f.service.dispose(); f.registry.dispose(); fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`; const page = await (await fetch(`${base}/resources?resource_id=${first.resource_id}`)).text();
  assert.match(page, /Changed outside Atlas|Changed since Atlas last used it/u); assert.match(page, /Accept current file version/u);
  const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; const currentVersion = page.match(/name="expected_current_version" value="([a-f0-9]+)"/u)?.[1]; assert.ok(currentVersion);
  const accepted = await fetch(`${base}/resources/actions/accept-current`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, resource_id: first.resource_id, expected_current_version: currentVersion }) }); assert.equal(accepted.status, 303);
  assert.equal(control.projectResource(f.a.project_id, first.resource_id, { refresh: true }).external_change.status, 'unchanged');
});

test('Host JSON view list/evaluate/files and Resource show expose bounded access and the same external-change fact', (t) => {
  const f = fixture(t); const view = f.service.saveView({ projectId: f.a.project_id, name: 'Files', config: { scope: { path: 'Data' } } }); const resource = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0]; const cliPath = path.resolve('bin/atlas.js'); const invoke = (args) => { const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); const envelope = JSON.parse(result.stdout); assert.equal(envelope.ok, true); return envelope.data; }; const listed = invoke(['view', 'list', '--project', f.a.project_id]); assert.equal(listed.host_access, 'read_write_views_and_submit_bounded_candidates'); assert.equal(listed.views[0].view_id, view.view_id); const evaluated = invoke(['view', 'evaluate', view.view_id, '--limit', '2']); assert.match(evaluated.completeness, /complete|partial/u); assert.equal(evaluated.semantic_property_write, 'candidate_preview_with_user_decision'); const files = invoke(['view', 'files', '--project', f.a.project_id, '--scope', 'Data', '--limit', '2']); assert.ok(['complete', 'partial'].includes(files.completeness)); assert.equal(files.host_access, 'read_only'); fs.appendFileSync(path.join(f.workspace, 'A', resource.relative_path), '\nchanged'); const shown = invoke(['resource', 'show', resource.resource_id, '--project', f.a.project_id]); assert.equal(shown.resource_id, resource.resource_id); assert.equal(shown.desktop_href, `/projects/${f.a.project_id}/resources?resource_id=${resource.resource_id}`); assert.equal(shown.external_change.status, 'changed'); const changedView = invoke(['view', 'evaluate', view.view_id, '--limit', '2']); assert.equal(changedView.members.find((item) => item.resource_id === resource.resource_id)?.external_change.status, 'changed');
});

test('Host CLI uses the Saved View membership default while honoring explicit limits', (t) => {
  const f = fixture(t);
  const resourceIds = [];
  for (let index = 0; index < 21; index += 1) {
    const filePath = path.join(f.workspace, 'A', 'Data', `file-${index}.txt`);
    if (index >= 4) fs.writeFileSync(filePath, `row ${index}`);
    resourceIds.push(f.service.resources.identify({ filePath, project: { id: f.a.project_id, name: 'A' } }).resource_id);
  }
  assert.equal(resourceIds.length, 21);
  const registeredView = f.service.saveView({
    projectId: f.a.project_id,
    name: 'All registered local files',
    config: { membership: 'registered_local', scope: { path: 'Data' } },
  });
  const directoryView = f.service.saveView({
    projectId: f.a.project_id,
    name: 'Directory files',
    config: { scope: { path: 'Data' } },
  });
  const cliPath = path.resolve('bin/atlas.js');
  const invoke = (args) => {
    const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
      cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    return envelope.data;
  };

  const registeredDefault = invoke(['view', 'evaluate', registeredView.view_id]);
  assert.equal(registeredDefault.returned_count, 20);
  assert.equal(registeredDefault.known_total, 21);
  assert.ok(registeredDefault.continuation);
  const registeredExplicit = invoke(['view', 'evaluate', registeredView.view_id, '--limit', '100']);
  assert.equal(registeredExplicit.returned_count, 21);
  assert.equal(registeredExplicit.known_total, 21);
  assert.equal(registeredExplicit.continuation, null);

  const directoryDefault = invoke(['view', 'evaluate', directoryView.view_id]);
  assert.equal(directoryDefault.returned_count, 21);
  assert.equal(directoryDefault.completeness, 'complete');
});

test('Host CLI can submit a bounded candidate Preview without directly writing a user property value', (t) => {
  const f = fixture(t); const member = f.service.listProjectFiles({ projectId: f.a.project_id, scope: { path: 'Data' }, limit: 1 }).members[0];
  const requestPath = path.join(f.root, 'candidate-request.json'); fs.writeFileSync(requestPath, JSON.stringify({ scope: { resource_ids: [member.resource_id] }, property: { name: 'Host topic', kind: 'single', options: ['Research', 'Other'] }, candidates: [{ resource_id: member.resource_id, value: 'Research', source_version: member.fact_version, evidence: 'The bounded file sample is about research.' }] }));
  const result = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'view', 'candidates', 'submit', '--project', f.a.project_id, '--request-file', requestPath, '--tool', 'codex', '--model', 'gpt-test', '--client-run-id', 'cli-candidate', '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout).data; assert.equal(data.candidates.length, 1); assert.equal(data.host.tool, 'codex'); assert.equal(data.prompt_version, null); assert.equal(data.candidates[0].prompt_version, null);
  const definition = f.service.listProperties(f.a.project_id).find((item) => item.name === 'Host topic'); assert.ok(definition); assert.equal(f.registry.ledger.projectViews.value(definition.property_id, member.resource_id), undefined);
});

test('PNG Host tag candidate keeps its prompt version through CLI and HTML review', async (t) => {
  const f = fixture(t);
  const imagePath = path.join(f.workspace, 'A', 'Data', 'tag.png');
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger });
  const resource = control.identify({ filePath: imagePath, project: f.registry.show(f.a.project_id).project });
  const sourceVersion = control.projectResource(f.a.project_id, resource.resource_id, { refresh: true }).external_change.current.sha256;
  const property = f.service.defineProperty({ projectId: f.a.project_id, name: '图片主题', kind: 'single', options: ['印章', '手写字样'] });
  const requestPath = path.join(f.root, 'image-tag-request.json');
  fs.writeFileSync(requestPath, JSON.stringify({ scope: { resource_ids: [resource.resource_id] }, property: { property_id: property.property_id },
    prompt_version: 'image-topic-v1', candidates: [{ resource_id: resource.resource_id, value: '印章', source_version: sourceVersion,
      evidence: '文件名提示印章；未使用OCR，需用户审阅图像' }] }));
  const cli = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'view', 'candidates', 'submit', '--project', f.a.project_id,
    '--request-file', requestPath, '--tool', 'codex', '--model', 'gpt-test', '--client-run-id', 'cli-image-tag', '--json'], {
    cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const hostPreview = JSON.parse(cli.stdout).data;
  assert.equal(hostPreview.prompt_version, 'image-topic-v1');
  assert.equal(hostPreview.host.tool, 'codex');
  assert.equal(hostPreview.candidates[0].prompt_version, 'image-topic-v1');
  assert.equal(hostPreview.candidates[0].source_version, sourceVersion);
  assert.match(hostPreview.candidates[0].evidence, /未使用OCR/u);
  assert.equal(f.registry.ledger.projectViews.value(property.property_id, resource.resource_id), undefined);
  for (const [index, invalidPromptVersion] of ['', '  ', 'v'.repeat(121)].entries()) {
    assert.throws(() => f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [resource.resource_id], propertyId: property.property_id,
      promptVersion: invalidPromptVersion, candidates: [{ resource_id: resource.resource_id, value: '印章', source_version: sourceVersion, evidence: 'Invalid version.' }],
      caller: { tool: 'codex', model: 'gpt-test', client_run_id: `invalid-prompt-${index}` } }), /prompt version/u);
  }

  const uiPreview = f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [resource.resource_id], propertyId: property.property_id,
    promptVersion: 'image-topic-v2', candidates: [{ resource_id: resource.resource_id, value: '印章', source_version: sourceVersion, evidence: 'Host reviewed the PNG; OCR was not used.' }],
    caller: { tool: 'codex', model: 'gpt-test', client_run_id: 'ui-image-tag' } });
  const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); });
  const base = `${server.workspace_url}projects/${f.a.project_id}`;
  const html = await (await fetch(`${base}/resources?mode=table`)).text();
  assert.match(html, /image-topic-v2/u);
  assert.match(html, /Prompt version/u);
  assert.match(html, /Host reviewed the PNG; OCR was not used\./u);
  assert.equal(f.registry.ledger.projectViews.value(property.property_id, resource.resource_id), undefined);
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const candidate = uiPreview.candidates[0];
  const accepted = await fetch(`${base}/resources/properties/candidates/decide`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, return_to: `${base}/resources?mode=table`,
      candidate_id: candidate.candidate_id, expected_revision: String(candidate.revision), expected_source_version: sourceVersion,
      action: 'edit_accept', value: '手写字样' }) });
  assert.equal(accepted.status, 303);
  const shown = f.service.propertyCandidateBatch({ projectId: f.a.project_id, batchId: uiPreview.batch_id });
  const hostReadback = shown.candidates.find((item) => item.candidate_id === candidate.candidate_id);
  assert.equal(hostReadback.candidate_id, candidate.candidate_id);
  assert.equal(hostReadback.prompt_version, 'image-topic-v2');
  assert.equal(hostReadback.host.tool, 'codex');
  assert.equal(hostReadback.status, 'accepted');
  assert.equal(f.registry.ledger.projectViews.value(property.property_id, resource.resource_id).value, '手写字样');

  const stale = f.service.submitPropertyCandidates({ projectId: f.a.project_id, resourceIds: [resource.resource_id], propertyId: property.property_id,
    promptVersion: 'image-topic-stale', candidates: [{ resource_id: resource.resource_id, value: '印章', source_version: sourceVersion, evidence: 'Stale source preview.' }],
    caller: { tool: 'codex', model: 'gpt-test', client_run_id: 'stale-image-tag' } }).candidates[0];
  fs.appendFileSync(imagePath, Buffer.from('changed'));
  assert.throws(() => f.service.decidePropertyCandidate({ projectId: f.a.project_id, candidateId: stale.candidate_id, action: 'accept',
    expectedRevision: stale.revision, expectedSourceVersion: stale.source_version, caller: { tool: 'atlas-ui', client_run_id: 'stale-image-accept' } }),
  { code: 'ATLAS_EVALUATION_CHANGED' });
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

test('Resources keeps Project Home and concise resource context ahead of folded details', () => {
  const html = renderProjectResourcesView({
    mode: 'list', project: { id: 'P-1', name: 'Project' }, base: '/projects/P-1', selected_folder_path: 'Data', tree: { folders: [], files: [] }, work_selection: { count: 0, review_href: '#' }, boards: [],
    focused_resource: { resource_id: 'RES-1', name: 'input.csv', type: 'CSV', relative_path: 'Data/input.csv', state: 'unchanged', related_work: [{ session_id: 'DWT-1', href: '/work/DWT-1', recipe_label: 'Recipe 1' }], board_references: [] },
    resource_view: { mode: 'files', saved_views: [], active_view: null, temporary_config: { scope: { path: 'Data', extensions: [] }, filters: [], sort: [] }, members: [], property_definitions: [] },
  }, { csrfToken: 'csrf' });
  assert.match(html, /href="\/projects\/P-1">Project Home<\/a>/u); assert.match(html, /<details class="resource-view-settings"><summary>View settings/u); assert.match(html, /No files selected for Work/u); assert.match(html, /<h2>input\.csv<\/h2>[\s\S]*?Current/u); assert.match(html, /Work with data/u); assert.match(html, /Related Work/u); assert.match(html, /Referenced by Boards/u); assert.match(html, /<details class="workspace-focus-details"><summary>Project and file details/u);
});

test('Files view gives a current scope summary and a directory-selection guide', async (t) => {
  const f = fixture(t); const control = createResourceControl({ stateDir: f.stateDir, ledger: f.registry.ledger }); const server = await startAtlasUiServer({ stateDir: f.stateDir, registry: f.registry, rules: {}, runtime: {}, projectRoot: f.root, installationRoot: f.root, resourceControl: control });
  t.after(async () => { await server.close(); control.dispose(); }); const html = await (await fetch(`${server.workspace_url}projects/${f.a.project_id}/resources?mode=files&scope_path=Data`)).text();
  assert.match(html, /Current scope/u); assert.match(html, /Choose a folder|Select a folder|directory/u); assert.match(html, /Data/u);
});

test('Resources retains compact directory links when the full folder tree is hidden', () => {
  const html = renderProjectResourcesView({
    mode: 'explorer', project: { id: 'P-1', name: 'Project' }, base: '/projects/P-1', selected_folder_path: '', selected_folder_loaded: true,
    tree: { files: [], folders: [{ name: 'Results', relative_path: 'Results', files: [], folders: [{ name: 'Archive', relative_path: 'Results/Archive', files: [], folders: [] }] }] },
    work_selection: { count: 0, review_href: '#' }, boards: [], resource_view: { mode: 'files', saved_views: [], active_view: null, temporary_config: { scope: { path: '', extensions: [] }, filters: [], sort: [] }, members: [], property_definitions: [] },
  }, { csrfToken: 'csrf' });
  assert.match(html, /workspace-compact-folder-nav/u);
  assert.match(html, /href="\/projects\/P-1\/resources\?folder="[^>]*>Project root/u);
  assert.match(html, /href="\/projects\/P-1\/resources\?folder=Results"[^>]*>Results/u);
  assert.match(html, /href="\/projects\/P-1\/resources\?folder=Results%2FArchive"[^>]*>Results \/ Archive/u);
});

test('Related Work keeps one status and folds its recipe and result metadata', () => {
  const html = renderProjectResourcesView({
    mode: 'explorer', project: { id: 'P-1', name: 'Project' }, base: '/projects/P-1', selected_folder_path: '', selected_folder_loaded: true,
    tree: { files: [], folders: [] }, work_selection: { count: 0, review_href: '#' }, boards: [],
    focused_resource: { name: 'input.csv', type: 'CSV', relative_path: 'input.csv', state: 'unchanged', related_work: [{ intent: 'Prepare report', freshness_label: 'Fresh', recipe_label: 'Recipe v2', result_label: 'report.csv · Fresh', revision: 4, updated_at: '2026-09-22T00:00:00.000Z', session_id: 'DWT-1', href: '/work/DWT-1', reuse_action: '/work/DWT-1/reuse' }], board_references: [] },
    resource_view: { mode: 'files', saved_views: [], active_view: null, temporary_config: { scope: { path: '', extensions: [] }, filters: [], sort: [] }, members: [], property_definitions: [] },
  }, { csrfToken: 'csrf', locale: 'zh-CN' });
  assert.match(html, /相关工作/u); assert.match(html, /状态: 当前/u); assert.match(html, /打开/u); assert.match(html, /复用/u);
  assert.match(html, /<details><summary>工作详情<\/summary>[\s\S]*?Recipe v2/u);
  assert.doesNotMatch(html, /Freshness:/u);
});

test('Related Work keeps an abnormal saved Result visible before folded metadata', () => {
  const html = renderProjectResourcesView({
    mode: 'explorer', project: { id: 'P-1', name: 'Project' }, base: '/projects/P-1', selected_folder_path: '', selected_folder_loaded: true,
    tree: { files: [], folders: [] }, work_selection: { count: 0, review_href: '#' }, boards: [],
    focused_resource: { name: 'input.csv', type: 'CSV', relative_path: 'input.csv', state: 'unchanged', related_work: [{ intent: 'Prepare report', freshness_label: 'Fresh', result_freshness: 'Result missing', recipe_label: 'Recipe v2', result_label: 'report.csv', revision: 4, session_id: 'DWT-1', href: '/work/DWT-1' }], board_references: [] },
    resource_view: { mode: 'files', saved_views: [], active_view: null, temporary_config: { scope: { path: '', extensions: [] }, filters: [], sort: [] }, members: [], property_definitions: [] },
  }, { csrfToken: 'csrf', locale: 'zh-CN' });
  assert.match(html, /状态: 结果缺失[\s\S]*?<details><summary>工作详情<\/summary>[\s\S]*?report\.csv/u);
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
