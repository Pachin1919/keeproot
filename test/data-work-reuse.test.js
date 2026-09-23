import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { contentFileFingerprint } from '../src/content-inspection.js';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(path.resolve('test', '.tmp'), 'data-work-reuse-r1-')); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'Project'); fs.mkdirSync(path.join(projectRoot, 'Data'), { recursive: true });
  const oldPaths = Array.from({ length: 6 }, (_, index) => { const filePath = path.join(projectRoot, 'Data', `old-${index + 1}.csv`); fs.writeFileSync(filePath, 'name,value\nold,1\n'); return filePath; });
  const newPaths = Array.from({ length: 6 }, (_, index) => { const filePath = path.join(projectRoot, 'Data', `new-${index + 1}.csv`); fs.writeFileSync(filePath, index === 5 ? 'other,value\nnew,1\n' : 'name,value\nnew,1\n'); return filePath; });
  const stateDir = path.join(root, 'state'); const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' }); const created = registry.create({ name: 'Project', currentPath: 'Project' }); registry.attachRoot(created.project_id, { rootId: adopted.root_id, relativePath: 'Project', reason: 'V1.9 reuse R1 fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger }); const project = { id: created.project_id, name: created.name }; const oldResources = oldPaths.map((filePath) => control.identify({ filePath, project })); const newResources = newPaths.map((filePath) => control.identify({ filePath, project })); const service = createDataWorkService({ stateDir, projectRoot: root, installationRoot: root, resourceControl: control, fingerprintFn: async (filePath) => contentFileFingerprint(filePath), runDataWorkFn: async ({ filePath, action }) => { if (action !== 'profile') throw new Error(`Unexpected R1 data action: ${action}`); const [headerLine] = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u); return { status: 'ready', profile: { fields: headerLine.split(',').map((name) => ({ name, inferred_type: 'text' })) }, processor: { version: 'r1-test' } }; } });
  t.after(() => { control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, stateDir, registry, control, service, project, oldPaths, newPaths, oldResources, newResources };
}

function prepareSixSlotWork(f) {
  let work = f.service.createProjectSession(f.project, {}, [], { intent: 'R1 source assignment', caller: { actor: 'agent', tool: 'test', client_run_id: 'r1-source' } });
  for (const resource of f.oldResources) work = f.service.addSource(work.session_id, resource.resource_id, { baseRevision: work.revision });
  for (const [index, source] of work.sources.entries()) f.registry.ledger.workSessions.updateSource(work.session_id, source.source_key, { fingerprint: contentFileFingerprint(f.oldPaths[index]), profile: { profile: { fields: [{ name: 'name' }, { name: 'value' }] } }, processorVersion: 'test', status: 'ready' }, new Date().toISOString());
  const mapping = work.sources.flatMap((source) => [{ source_key: source.source_key, column: 'name', canonical: `field_${source.ordinal + 1}_name` }, { source_key: source.source_key, column: 'value', canonical: `field_${source.ordinal + 1}_value` }]); work = f.service.confirmMapping(work.session_id, mapping, { baseRevision: work.revision }); work = f.service.updateRecipe(work.session_id, { combine: 'concatenate', steps: [{ operation: 'validate' }, { operation: 'select', columns: ['name'] }] }, { baseRevision: work.revision }); f.registry.ledger.workSessions.setLatestSave(work.session_id, 'SAVE-r1-old', new Date().toISOString());
  return f.registry.ledger.workSessions.byId(work.session_id);
}

test('R1 reuse assigns six old source slots to new Resources without remapping or mutating the old Work', async (t) => {
  const f = fixture(t); const before = prepareSixSlotWork(f); const oldSnapshot = structuredClone(before); const sourceAssignments = before.sources.map((source, index) => ({ source_key: source.source_key, resource_id: f.newResources[index].resource_id, sheet: source.sheet, required_fields: ['name', 'value'] }));
  const reused = f.service.reuseProjectSession(before.session_id, { baseRevision: before.revision, sourceAssignments, intent: 'R1 assign refreshed materials', caller: { actor: 'agent', tool: 'test', client_run_id: 'r1-reuse' } });
  assert.notEqual(reused.session_id, before.session_id); assert.equal(reused.reused_from_session_id, before.session_id); assert.equal(reused.revision, 1); assert.deepEqual(reused.sources.map((item) => item.source_key), before.sources.map((item) => item.source_key)); assert.deepEqual(reused.sources.map((item) => item.resource_id), f.newResources.map((item) => item.resource_id)); assert.ok(reused.sources.every((item) => item.status === 'pending')); assert.deepEqual(reused.mapping, before.mapping); assert.deepEqual(reused.recipe, before.recipe); assert.equal(reused.latest_save_id, null);
  assert.deepEqual(reused.reused_from_work, { session_id: before.session_id, intent: before.intent, revision: before.revision, desktop_href: `/work/${before.session_id}` });
  fs.writeFileSync(f.newPaths[5], 'name,value\nnew,1\n'); const prepared = await f.service.prepareSources(reused.session_id, { baseRevision: reused.revision }); assert.ok(prepared.sources.every((item) => item.status === 'ready')); assert.equal(prepared.mapping_complete, true); assert.deepEqual(prepared.mapping.map((item) => item.source_sha256), before.mapping.map((item) => contentFileFingerprint(f.newPaths[item.source_key ? before.sources.findIndex((source) => source.source_key === item.source_key) : 0]).sha256));
  assert.deepEqual(f.registry.ledger.workSessions.byId(before.session_id), oldSnapshot); assert.equal(f.registry.ledger.workSessions.listForProject(f.project.id).total, 2);
});

test('R1 reuse accepts compatible same-sheet fields and records only an assigned-slot mismatch', async (t) => {
  const f = fixture(t); const before = prepareSixSlotWork(f); const assignments = before.sources.map((source, index) => ({ source_key: source.source_key, resource_id: f.newResources[index].resource_id, sheet: source.sheet, required_fields: ['name', 'value'] }));
  const reused = f.service.reuseProjectSession(before.session_id, { baseRevision: before.revision, sourceAssignments: assignments, intent: 'R1 validate assigned slots', caller: { actor: 'agent', tool: 'test', client_run_id: 'r1-mismatch' } });
  const prepared = await f.service.prepareSources(reused.session_id, { baseRevision: reused.revision }); assert.equal(prepared.sources.slice(0, 5).every((source) => source.status === 'ready'), true); assert.equal(prepared.sources[5].resource_id, f.newResources[5].resource_id); assert.equal(prepared.sources[5].status, 'failed'); assert.match(prepared.sources[5].error_message ?? '', /field|column|name|value|sheet|mismatch/iu); assert.equal(prepared.mapping_complete, false); assert.equal(prepared.mapping.length, before.mapping.length); assert.deepEqual(prepared.sources.slice(0, 5).map((source) => source.resource_id), f.newResources.slice(0, 5).map((resource) => resource.resource_id)); assert.ok(prepared.mapping.filter((item) => item.source_key !== prepared.sources[5].source_key).every((item) => item.source_sha256 === contentFileFingerprint(f.newPaths[prepared.sources.findIndex((source) => source.source_key === item.source_key)]).sha256));
});

test('R1 Host reuse persists assigned Resource identity and UI renders the same new Work', async (t) => {
  const f = fixture(t); const before = prepareSixSlotWork(f); const requestFile = path.join(f.root, 'r1-host-reuse.json'); fs.writeFileSync(requestFile, JSON.stringify({ sources: before.sources.map((source, index) => ({ source_key: source.source_key, source: `Data/new-${index + 1}.csv` })) }));
  const host = spawnSync(process.execPath, [path.resolve('bin', 'atlas.js'), 'table-work', 'reuse', before.session_id, '--base-revision', String(before.revision), '--request-file', requestFile, '--tool', 'test', '--client-run-id', 'r1-host-reuse', '--json'], { cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true, env: { ...process.env, ATLAS_STATE_DIR: f.stateDir } });
  assert.equal(host.status, 0, host.stderr || host.stdout); const reused = JSON.parse(host.stdout).data; assert.notEqual(reused.session_id, before.session_id); assert.equal(reused.revision, 1); assert.deepEqual(reused.sources.map((item) => item.resource_id), f.newResources.map((item) => item.resource_id)); assert.deepEqual(f.registry.ledger.workSessions.byId(before.session_id), before);
  const uiRegistry = new Registry({ stateDir: f.stateDir }); const uiControl = createResourceControl({ stateDir: f.stateDir, ledger: uiRegistry.ledger }); let server = null; try { server = await startAtlasUiServer({ stateDir: f.stateDir, registry: uiRegistry, resourceControl: uiControl, projectRoot: f.root, installationRoot: f.root, rules: {}, runtime: {} }); const page = await (await fetch(`${server.workspace_url}work/${reused.session_id}`)).text(); assert.match(page, new RegExp(reused.session_id, 'u')); assert.match(page, /Revision 1|revision 1/iu); } finally { if (server) await server.close(); uiControl.dispose(); uiRegistry.dispose(); }
});

test('Reused Work view keeps the source Work readable and the fresh summary compact', () => {
  const html = renderDataWorkView({ mode: 'sources', csrf: 'csrf', back_href: '/projects/P/resources', session: { session_id: 'DWT-new', intent: 'Refresh monthly figures', revision: 2, reused_from_work: { session_id: 'DWT-old', intent: 'Existing monthly figures', revision: 4, desktop_href: '/work/DWT-old' }, reuse_action: '/work/DWT-new/reuse', latest_result: { name: 'monthly.csv', href: '/work/DWT-new/saved' }, freshness_label: 'Fresh', freshness_reason: 'Recorded sources are current.', change_review: { status: 'fresh', items: [] }, sources: [{ source_key: 'source-1', name: 'input.csv', status: 'ready', profile: { profile: { fields: [] } } }], mapping: [], recipe: { version: 1, combine: { operation: 'concatenate' }, steps: [] } } });
  assert.match(html, /<h1>Refresh monthly figures<\/h1>/u); assert.match(html, /Reused Work/u); assert.match(html, /Reused from[\s\S]*Existing monthly figures/u); assert.match(html, /href="\/work\/DWT-old"/u); assert.match(html, /Sources are fresh\. No source changes need review\./u); assert.doesNotMatch(html, /<section class="surface"><h2>Source changes<\/h2>/u); assert.match(html, /Reuse as new Work/u); assert.match(html, /Open Latest Result/u); assert.match(html, /href="\/projects\/P">Project Home<\/a>/u);
});

test('Single-source aligned Work avoids empty differences and only labels actual reuse', () => {
  const session = { session_id: 'DWT-single', intent: 'Budget', revision: 2, mapping_complete: true,
    sources: [{ source_key: 'one', name: 'budget.csv', status: 'ready', profile: { profile: { fields: [{ name: 'amount', inferred_type: 'number' }] } } }],
    mapping: [{ source_key: 'one', column: 'amount', canonical: 'amount' }],
    recipe: { version: 1, combine: { operation: 'concatenate' }, steps: [] } };
  const render = (value) => renderDataWorkView({ mode: 'sources', csrf: 'csrf', session: value });
  const plain = render(session);
  assert.match(plain, /Field alignment is ready\./u);
  assert.doesNotMatch(plain, /Reused field alignment|Field differences|No unique fields/u);
  assert.match(render({ ...session, reused_from_session_id: 'DWT-old' }), /Reused field alignment is ready\./u);
  assert.match(render({ ...session, mapping_complete: false }), /Field differences/u);
});
