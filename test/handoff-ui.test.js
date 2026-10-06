import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { PreferenceRules } from '../src/preference-rules.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createSavedWorkService } from '../src/ui/services/saved-work-service.js';
import { createTableWorkModule } from '../src/table-work-module.js';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { renderHandoffView } from '../src/ui/views/handoff-view.js';

test('a recovery-stale Handoff page explains that the current Work must be reread', () => {
  const html = renderHandoffView({
    base: '/projects/PRJ-test', project: { id: 'PRJ-test', name: 'Fixture' },
    handoff: {
      handoff_id: 'HOF-test', work_id: 'DWT-test', work_revision: 4, current_work_revision: 5,
      digest: 'fixture-digest', goal: 'Continue after recovery', status: 'stale',
      reason: 'Recorded facts changed.', changes: ['work', 'recoveries'], package: {},
    },
  }, { locale: 'en' });
  assert.match(html, /A recovery changed this Handoff/);
  assert.match(html, /Read the current Work and create a new Handoff/);
  assert.match(html, /DWT-test · r4 → 5/);
  assert.match(html, /href="\/work\/DWT-test"/);
});

test('Project Home creates and reads a Project-scoped Handoff through CSRF form', async (t) => {
  const parent = path.resolve('test/.tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'handoff-ui-'));
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'A'); const stateDir = path.join(root, 'state');
  const sourcePath = path.join(projectRoot, 'Data', 'input.csv'); fs.mkdirSync(path.dirname(sourcePath), { recursive: true }); fs.writeFileSync(sourcePath, 'region,value\nNorth,20\nSouth,10\n', 'utf8');
  const registry = new Registry({ stateDir }); const rootRecord = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'Handoff UI', currentPath: 'A' }); registry.attachRoot(project.project_id, { rootId: rootRecord.root_id, relativePath: 'A', reason: 'Handoff UI test.' });
  fs.mkdirSync(path.join(workspace, 'B'), { recursive: true });
  const otherProject = registry.create({ name: 'Other Project', currentPath: 'B' }); registry.attachRoot(otherProject.project_id, { rootId: rootRecord.root_id, relativePath: 'B', reason: 'Cross-project Handoff test.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const resource = control.identify({ filePath: sourcePath, project: { id: project.project_id, name: project.name } });
  const fingerprintFn = async (filePath) => ({ file_path: filePath, sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), bytes: fs.statSync(filePath).size });
  const dataWork = createDataWorkService({ stateDir, projectRoot: path.resolve('.'), installationRoot: path.resolve('.'), resourceControl: control, fingerprintFn,
    runDataWorkFn: async ({ filePath, expectedSha256, action }) => {
      const sha256 = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      if (expectedSha256 && expectedSha256 !== sha256) throw new Error('Source changed.');
      if (action === 'profile') return { status: 'ready', source: { sha256 }, processor: { version: 'ui-fixture' }, sheets: [], profile: { rows: 2, columns: 2, fields: [
        { name: 'region', inferred_type: 'text', missing_count: 0, distinct_count: 2 }, { name: 'value', inferred_type: 'number', missing_count: 0, distinct_count: 2 },
      ] } };
      return { processor: { version: 'ui-fixture' }, columns: ['region', 'value'], rows: [['North', '20'], ['South', '10']], preview: { rows_shown: 2, total_rows: 2 },
        aggregation: { dimension: 'region', measure: 'value', formula: 'sum', unit: 'items', groups: [{ value: 'North', sum: '20' }, { value: 'South', sum: '10' }], total: '30' } };
    },
  });
  const rules = new PreferenceRules({ stateDir, ledger: registry.ledger }); const intake = new Intake({ stateDir });
  let server = null;
  t.after(async () => { if (server) await server.close(); intake.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const module = createTableWorkModule({ dataWork, savedWork: createSavedWorkService({ stateDir }), resolveProject: (id) => id === project.project_id ? { project: { id, name: project.name, status: 'active' }, root: projectRoot, location: registry.show(id).location } : null });
  const start = await module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.project_id, action: 'start', parameters: { resource_ids: [resource.resource_id] } });
  const work = start.data;
  await dataWork.prepareSources(work.session_id);
  server = await startAtlasUiServer({ stateDir, registry, rules, intake, runtime: { atlas_version: 'test', node_version: process.versions.node, state_dir: stateDir, ledger: { integrity: 'ok', schema_version: 33, supported_schema_version: 33 } }, projectRoot: path.resolve('.'), installationRoot: path.resolve('.'), port: 0, desktopPickerEnabled: false, dataWorkService: dataWork, resourceControl: control });
  const homeUrl = new URL(`/projects/${encodeURIComponent(project.project_id)}`, server.workspace_url);
  const home = await fetch(homeUrl); const html = await home.text(); assert.equal(home.status, 200); assert.match(html, /handoff-title|Host Handoff/iu); assert.match(html, new RegExp(work.session_id, 'u'));
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)?.[1]; const requestKey = html.match(/name="request_key" value="([^"]+)"/u)?.[1];
  assert.ok(csrf); assert.ok(requestKey);
  const post = (projectId, token) => fetch(new URL(`/projects/${encodeURIComponent(projectId)}/handoffs`, server.workspace_url), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token, request_key: requestKey, goal: 'Continue the regional comparison.', work_id: work.session_id, corrections: 'North uses the confirmed source field.', unfinished: 'Check next period.' }) });
  assert.equal((await post(project.project_id, 'bad')).status, 403);
  const created = await post(project.project_id, csrf);
  const createdHtml = created.status === 303 ? '' : await created.text();
  if (created.status !== 303) console.error('Handoff POST diagnostic:', createdHtml.match(/<p class="callout warn">([^<]+)<\/p>/u)?.[1] ?? createdHtml.slice(0, 300));
  assert.equal(created.status, 303, createdHtml.match(/<p class="callout warn">([^<]+)<\/p>/u)?.[1] ?? 'No Handoff error message was rendered.');
  const handoffUrl = new URL(created.headers.get('location'), server.workspace_url);
  const read = await fetch(handoffUrl); const readHtml = await read.text(); assert.equal(read.status, 200); assert.match(readHtml, /Continue the regional comparison/u); assert.match(readHtml, new RegExp(resource.resource_id, 'u')); assert.match(readHtml, /Open current Work/u); assert.match(readHtml, /Check its status before continuing/u); assert.doesNotMatch(readHtml, /handoff\.notice|region,value\s*North,20/u);
  const foreign = await post(otherProject.project_id, csrf); assert.equal(foreign.status, 403);
  const workHref = readHtml.match(/class="action-button" href="([^"]+)"[^>]*>Open current Work/u)?.[1];
  assert.ok(workHref);
  const openedWork = await fetch(new URL(workHref, server.workspace_url));
  assert.equal(openedWork.status, 200, 'Handoff must open its current Table Work, not the legacy single-file entry.');
  assert.doesNotMatch(await openedWork.text(), /Atlas stopped this action/u);
  assert.match(readHtml, /href="\/projects\/[^" ]+\/resources\?resource_id=[^" ]+">input.csv<\/a>/u);
  fs.appendFileSync(sourcePath, 'East,40\n');
  const blocked = await fetch(handoffUrl);
  assert.equal(blocked.status, 200);
  const blockedHtml = await blocked.text();
  assert.match(blockedHtml, /This package cannot authorize continuation/u);
  assert.doesNotMatch(blockedHtml, /give the command below to the next Host/u);
});
