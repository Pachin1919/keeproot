import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createContentLocationService } from '../src/content-location-service.js';
import { createProjectViewService } from '../src/project-view-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';

test('CSV row candidate uses one identity in Resources review and Host readback without changing the source', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/csv-row-candidate-ui-'));
  const priorPython = process.env.ATLAS_PYTHON;
  if (!priorPython) process.env.ATLAS_PYTHON = (process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe'));
  const installationRoot = path.resolve('test/.tmp/v20-01-isolated-install');
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'A');
  fs.mkdirSync(projectRoot, { recursive: true }); const file = path.join(projectRoot, 'routes.csv');
  fs.writeFileSync(file, '记录ID,区域\r\n001,北区\r\n', 'utf8'); const original = fs.readFileSync(file);
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' }); registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'CSV candidate UI' });
  const control = new ResourceControl({ stateDir, registry });
  const resourceId = control.identify({ filePath: file, project: registry.show(project.project_id).project }).resource_id;
  const locations = createContentLocationService({ registry, resourceControl: control, installationRoot });
  const projectViews = createProjectViewService({ stateDir, registry,
    pythonPath: process.env.ATLAS_TEST_PYTHON ?? process.env.ATLAS_CONTENT_PYTHON ?? path.join(installationRoot, 'desktop-ui/venv/Scripts/python.exe') });
  const property = projectViews.defineProperty({ projectId: project.project_id, name: '区域归属', kind: 'text' });
  const snapshot = locations.locateCsvRow({ projectId: project.project_id, resourceId, key: { column: '记录ID', value: '001' } });
  const batch = projectViews.submitRowPropertyCandidates({ projectId: project.project_id, propertyId: property.property_id,
    promptVersion: 'csv-ui-p1', candidates: [{ format: 'csv', resource_id: resourceId, key: { column: '记录ID', value: '001' },
      value: '北区', source_version: snapshot.row_sha256, evidence: { summary: '区域字段', cells: ['区域'] } }],
    caller: { tool: 'codex', model: 'test', client_run_id: 'csv-ui-1' } });
  const server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, projectRoot: root, installationRoot: root, resourceControl: control });
  t.after(async () => {
    await server.close(); projectViews.dispose(); locations.dispose(); control.dispose(); registry.dispose();
    if (priorPython == null) delete process.env.ATLAS_PYTHON; else process.env.ATLAS_PYTHON = priorPython;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const candidate = batch.candidates[0];
  const page = await (await fetch(new URL(`/projects/${project.project_id}/resources?mode=table`, server.workspace_url))).text();
  assert.match(page, new RegExp(candidate.candidate_id));
  assert.match(page, /CSV record/u);
  assert.match(page, /001/u);
  assert.match(page, /Spreadsheet row suggestions/u);
  const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const response = await fetch(new URL(`/projects/${project.project_id}/resources/row-candidates/decide`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, candidate_id: candidate.candidate_id, expected_revision: String(candidate.revision),
      expected_row_version: candidate.row_sha256, action: 'accept' }) });
  assert.equal(response.status, 303);
  const host = projectViews.rowPropertyCandidateBatch({ projectId: project.project_id, batchId: batch.batch_id }).candidates[0];
  assert.equal(host.candidate_id, candidate.candidate_id);
  assert.equal(host.status, 'accepted');
  assert.equal(host.sheet, null);
  assert.equal(host.locator.format, 'csv');
  assert.equal(host.accepted_row_value.value, '北区');
  assert.equal(host.accepted_row_value.sheet, null);
  assert.deepEqual(fs.readFileSync(file), original);
});
