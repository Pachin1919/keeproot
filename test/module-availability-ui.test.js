import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { contentFileFingerprint } from '../src/content-inspection.js';
import { createResourceControl } from '../src/resource-control.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createModuleAvailabilityService } from '../src/module-availability.js';
import { startAtlasUiServer } from '../src/ui-server.js';

test('Projects entry opens module management and CSRF-protected status changes share persisted revisions', async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'module-availability-ui-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'A');
  fs.mkdirSync(projectPath, { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Module availability test.' });
  let server = null;
  t.after(async () => {
    if (server) await server.close();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, projectRoot: root, installationRoot: root });
  const projectsPage = await (await fetch(new URL('/projects', server.workspace_url))).text();
  assert.match(projectsPage, /href="\/modules"/u);

  const modulesUrl = new URL('/modules', server.workspace_url);
  let response = await fetch(modulesUrl);
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.match(html, /atlas\.capture-source/u);
  assert.match(html, /atlas\.table-work/u);
  assert.match(html, /Enabled/u);
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  const post = (fields) => fetch(new URL('/modules/change', server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, ...fields }),
  });
  response = await fetch(new URL('/modules/change', server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'invalid', module_id: 'atlas.capture-source', action: 'disable', expected_revision: '0', request_key: 'ui-invalid-csrf', reason: 'Should not be accepted.' }),
  });
  assert.equal(response.status, 403);
  html = await (await fetch(modulesUrl)).text();
  assert.match(html, /Enabled/u);
  assert.match(html, /Revision 0/u);
  response = await post({ module_id: 'atlas.capture-source', action: 'disable', expected_revision: '0', request_key: 'ui-disable-capture', reason: 'Pause source processing.' });
  assert.equal(response.status, 303);
  html = await (await fetch(modulesUrl)).text();
  assert.match(html, /Disabled/u);
  assert.match(html, /atlas\.capture-source/u);
  let home = await (await fetch(new URL(`/projects/${project.project_id}`, server.workspace_url))).text();
  assert.match(home, /Capture Source processing is paused/u);
  assert.doesNotMatch(home, /action="[^"]*\/capture-source\/prepare"/u);
  assert.match(home, /href="\/modules"/u);
  response = await post({ module_id: 'atlas.capture-source', action: 'enable', expected_revision: '0', request_key: 'ui-stale-enable', reason: 'Stale form.' });
  assert.equal(response.status, 409);
  response = await post({ module_id: 'atlas.capture-source', action: 'enable', expected_revision: '1', request_key: 'ui-enable-capture', reason: 'Resume source processing.' });
  assert.equal(response.status, 303);
  html = await (await fetch(modulesUrl)).text();
  assert.match(html, /Enabled/u);
  assert.match(html, /Revision 2/u);
  home = await (await fetch(new URL(`/projects/${project.project_id}`, server.workspace_url))).text();
  assert.match(home, /action="[^"]*\/capture-source\/prepare"/u);
});

test('disabled Table Work blocks legacy single-file processing before state or stage changes', async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'module-disabled-data-work-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'A');
  const dataFolder = path.join(projectPath, 'Data');
  const resultsFolder = path.join(projectPath, 'Results');
  const sourcePath = path.join(dataFolder, 'input.csv');
  fs.mkdirSync(dataFolder, { recursive: true });
  fs.mkdirSync(resultsFolder, { recursive: true });
  fs.writeFileSync(sourcePath, 'name,value\nalpha,1\nbeta,2\n', 'utf8');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const created = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(created.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Module disabled UI test.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const project = { id: created.project_id, name: created.name, status: 'active' };
  const resource = control.identify({ filePath: sourcePath, project });
  let previewCalls = 0;
  let exportCalls = 0;
  const preview = {
    status: 'ready', processor: { version: 'module-disabled-ui-fixture' },
    columns: ['name', 'value'], rows: [['alpha', '1'], ['beta', '2']],
    column_types: { name: 'text', value: 'number' },
    source_summary: { rows: 2, columns: 2 }, result_summary: { rows: 2, columns: 2 },
    preview: { rows_shown: 2, total_rows: 2 },
  };
  const dataWorkService = createDataWorkService({
    stateDir, projectRoot: root, installationRoot: root, resourceControl: control,
    fingerprintFn: async (filePath) => contentFileFingerprint(filePath),
    runDataWorkFn: async ({ filePath, expectedSha256, action, outputPath }) => {
      const fingerprint = contentFileFingerprint(filePath);
      assert.equal(fingerprint.sha256, expectedSha256);
      if (action === 'profile') return {
        status: 'ready', source: fingerprint, processor: { version: 'module-disabled-ui-fixture' }, sheets: [],
        profile: { rows: 2, columns: 2, null_cells: 0, duplicate_rows: 0,
          fields: [{ name: 'name', inferred_type: 'text', missing_count: 0 }, { name: 'value', inferred_type: 'number', missing_count: 0 }] },
      };
      if (action === 'preview') { previewCalls += 1; return preview; }
      if (action === 'export') {
        exportCalls += 1;
        fs.writeFileSync(outputPath, 'name,value\nalpha,1\nbeta,2\n', 'utf8');
        const staged = contentFileFingerprint(outputPath);
        return { ...preview, staged: { path: staged.file_path, sha256: staged.sha256, bytes: staged.bytes } };
      }
      throw new Error(`Unexpected fixture action: ${action}`);
    },
  });
  const single = await dataWorkService.begin({ filePath: sourcePath, project });
  const multi = dataWorkService.createProjectSession(project, {}, [resource.resource_id], { intent: 'Existing multi-source Work' });
  let server = null;
  t.after(async () => {
    if (server) await server.close();
    control.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, projectRoot: root, installationRoot: root, resourceControl: control, dataWorkService });
  const modulePage = await (await fetch(new URL('/modules', server.workspace_url))).text();
  const csrf = modulePage.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  const availability = createModuleAvailabilityService({ stateDir });
  availability.change({ moduleId: 'atlas.table-work', enabled: false, expectedRevision: 0, requestKey: 'disable-table-ui-route', reason: 'Pause Table Work in this test.' });

  let response = await fetch(new URL(`/work/${multi.session_id}`, server.workspace_url));
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.match(html, /module-paused/u);
  assert.match(html, /href="\/modules"/u);
  assert.doesNotMatch(html, /action="\/work\/[^"]+\/action"/u);
  const multiRevision = dataWorkService.session(multi.session_id).revision;
  response = await fetch(new URL(`/work/${multi.session_id}/action`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, action: 'recipe', base_revision: String(multiRevision), combine: 'concatenate' }),
  });
  assert.equal(response.status, 303);
  assert.equal(dataWorkService.session(multi.session_id).revision, multiRevision);

  const multiSaveId = dataWorkService.session(multi.session_id).latest_save_id;
  for (const operation of ['save/review', 'save/confirm']) {
    response = await fetch(new URL(`/work/${multi.session_id}/${operation}`, server.workspace_url), {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, project_id: project.id, folder: 'Results', file_name: 'multi.csv', format: 'csv' }),
    });
    assert.equal(response.status, 303);
    assert.equal(dataWorkService.session(multi.session_id).revision, multiRevision);
    assert.equal(dataWorkService.session(multi.session_id).latest_save_id, multiSaveId);
    assert.equal(exportCalls, 0);
    assert.equal(fs.existsSync(path.join(resultsFolder, 'multi.csv')), false);
  }

  const before = dataWorkService.session(single.session_id);
  const beforeOperations = structuredClone(before.operations);
  const beforeSaveId = before.latest_save_id;
  const beforePreviewCalls = previewCalls;
  response = await fetch(new URL(`/data-work/${single.session_id}/action`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, action: 'clean', remove_empty_rows: 'yes' }),
  });
  assert.equal(response.status, 303);
  assert.deepEqual(dataWorkService.session(single.session_id).operations, beforeOperations);
  assert.equal(previewCalls, beforePreviewCalls);

  response = await fetch(new URL(`/data-work/${single.session_id}/save/review`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, project_id: project.id, folder: 'Results', file_name: 'result.csv' }),
  });
  assert.equal(response.status, 303);
  assert.equal(exportCalls, 0);
  assert.equal(dataWorkService.session(single.session_id).staged_path, null);
  assert.equal(fs.existsSync(path.join(resultsFolder, 'result.csv')), false);

  response = await fetch(new URL(`/data-work/${single.session_id}/save/confirm`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, project_id: project.id, folder: 'Results', file_name: 'result.csv' }),
  });
  assert.equal(response.status, 303);
  assert.equal(exportCalls, 0);
  assert.equal(dataWorkService.session(single.session_id).latest_save_id, beforeSaveId);
  assert.equal(fs.existsSync(path.join(resultsFolder, 'result.csv')), false);

  availability.change({ moduleId: 'atlas.table-work', enabled: true, expectedRevision: 1, requestKey: 'enable-table-ui-route', reason: 'Resume Table Work in this test.' });
  response = await fetch(new URL(`/data-work/${single.session_id}/action`, server.workspace_url), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, action: 'clean', remove_empty_rows: 'yes' }),
  });
  assert.equal(response.status, 303);
  assert.notDeepEqual(dataWorkService.session(single.session_id).operations, beforeOperations);
});
