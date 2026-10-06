import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { startAtlasUiServer } from '../src/ui-server.js';

test('Resources relink requires a same-Project preview and explicit CSRF confirmation', async (t) => {
  const parent = path.resolve('test/.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'resource-relink-ui-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A');
  fs.mkdirSync(projectRoot, { recursive: true });
  const oldPath = path.join(projectRoot, 'old.md');
  const candidatePath = path.join(projectRoot, 'restored', 'same.md');
  fs.writeFileSync(oldPath, 'same original text\n');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'UI relink fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  const server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, projectRoot: workspace, installationRoot: root, resourceControl: control, desktopPickerEnabled: true });
  t.after(async () => {
    await server.close();
    control.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const original = control.identify({ filePath: oldPath, project: { id: project.project_id } });
  fs.rmSync(oldPath);
  control.projectResources(project.project_id, { refresh: true });
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, 'same original text\n');
  const base = new URL(`projects/${project.project_id}`, server.workspace_url);
  let html = await (await fetch(new URL(`resources?resource_id=${encodeURIComponent(original.resource_id)}`, `${base.href}/`))).text();
  assert.match(html, /data-resource-relink-form/u);
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  const registration = await fetch(server.desktop_picker.registration_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-atlas-desktop-token': server.desktop_picker.token },
    body: new URLSearchParams({ kind: 'file', mode: 'single', file_path: candidatePath }),
  });
  assert.equal(registration.status, 200);
  const selection = await registration.json();
  assert.equal(selection.ok, true);
  const badCsrf = await fetch(new URL('resources/actions/relink', `${base.href}/`), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'invalid', resource_id: original.resource_id, selection_id: selection.selection_id }),
  });
  assert.equal(badCsrf.status, 403);
  assert.equal(control.describe(original.resource_id).actions.some((item) => item.action_type === 'relink'), false);
  const previewResponse = await fetch(new URL('resources/actions/relink', `${base.href}/`), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, resource_id: original.resource_id, selection_id: selection.selection_id }),
  });
  assert.equal(previewResponse.status, 200);
  html = await previewResponse.text();
  assert.match(html, /核对同项目重新定位|Review same-Project relink/u);
  assert.match(html, new RegExp(original.evidence.sha256, 'u'));
  assert.match(html, /name="preview_digest" value="([a-f0-9]{64})"/u);
  assert.equal(control.describe(original.resource_id).actions.some((item) => item.action_type === 'relink'), false);
  const digest = html.match(/name="preview_digest" value="([a-f0-9]{64})"/u)?.[1];
  const requestKey = html.match(/name="request_key" value="([^"]+)"/u)?.[1];
  assert.ok(digest && requestKey);
  const confirmResponse = await fetch(new URL('resources/actions/relink-confirm', `${base.href}/`), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, resource_id: original.resource_id, selection_id: selection.selection_id, preview_digest: digest, request_key: requestKey }),
  });
  assert.equal(confirmResponse.status, 303);
  assert.match(confirmResponse.headers.get('location') ?? '', new RegExp(encodeURIComponent(original.resource_id), 'u'));
  const final = control.projectResource(project.project_id, original.resource_id, { refresh: true });
  assert.equal(final.status, 'active');
  assert.equal(path.resolve(final.path), path.resolve(candidatePath));
  assert.equal(final.locations.filter((item) => item.status === 'missing').length, 1);
  assert.equal(fs.readFileSync(candidatePath, 'utf8'), 'same original text\n');
});

test('Missing Resource can be relinked by Project-relative path without the desktop picker', async (t) => {
  const parent = path.resolve('test/.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'resource-relink-text-ui-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A');
  fs.mkdirSync(projectRoot, { recursive: true });
  const oldPath = path.join(projectRoot, 'old.md');
  const candidatePath = path.join(projectRoot, 'restored', 'same.md');
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(oldPath, 'same original text\n');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'UI relink fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  const server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, projectRoot: workspace, installationRoot: root, resourceControl: control, desktopPickerEnabled: false });
  t.after(async () => {
    await server.close();
    control.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const original = control.identify({ filePath: oldPath, project: { id: project.project_id } });
  fs.rmSync(oldPath);
  control.projectResources(project.project_id, { refresh: true });
  fs.writeFileSync(candidatePath, 'same original text\n');
  const beforeBytes = fs.readFileSync(candidatePath);
  const base = new URL(`projects/${project.project_id}`, server.workspace_url);
  let html = await (await fetch(new URL(`resources?resource_id=${encodeURIComponent(original.resource_id)}`, `${base.href}/`))).text();
  assert.match(html, /name="relative_path"/u);
  const textForm = html.match(/<form\b[^>]*data-resource-relink-text-form[^>]*>[\s\S]*?<\/form>/u)?.[0];
  assert.ok(textForm, 'Missing Resource must provide a standalone relative-path form.');
  assert.match(textForm, /name="relative_path"/u);
  assert.match(textForm, /<button[^>]*type="submit"[^>]*>/u);
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  for (const invalid of ['', path.resolve(candidatePath), 'C:\\outside.md', '../outside.md']) {
    const rejected = await fetch(new URL('resources/actions/relink', `${base.href}/`), {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, resource_id: original.resource_id, relative_path: invalid }),
    });
    assert.notEqual(rejected.status, 200, `expected ${JSON.stringify(invalid)} to be rejected`);
  }
  const changedPath = path.join(projectRoot, 'restored', 'changed.md');
  fs.writeFileSync(changedPath, 'different bytes\n');
  const changedPreview = await fetch(new URL('resources/actions/relink', `${base.href}/`), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, resource_id: original.resource_id, relative_path: 'restored/changed.md' }),
  });
  assert.notEqual(changedPreview.status, 200);
  const previewResponse = await fetch(new URL('resources/actions/relink', `${base.href}/`), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, resource_id: original.resource_id, relative_path: 'restored/same.md' }),
  });
  assert.equal(previewResponse.status, 200);
  html = await previewResponse.text();
  assert.match(html, new RegExp(original.resource_id, 'u'));
  assert.match(html, new RegExp(original.evidence.sha256, 'u'));
  assert.match(html, /restored[\\/]same\.md/u);
  assert.match(html, /name="preview_digest" value="([a-f0-9]{64})"/u);
  assert.match(html, /name="request_key" value="([^"]+)"/u);
  assert.equal(control.projectResource(project.project_id, original.resource_id, { refresh: true }).status, 'missing');
  assert.deepEqual(fs.readFileSync(candidatePath), beforeBytes);

  const digest = html.match(/name="preview_digest" value="([a-f0-9]{64})"/u)?.[1];
  const requestKey = html.match(/name="request_key" value="([^"]+)"/u)?.[1];
  assert.ok(digest && requestKey);
  const confirm = () => fetch(new URL('resources/actions/relink-confirm', `${base.href}/`), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, resource_id: original.resource_id, relative_path: 'restored/same.md', preview_digest: digest, request_key: requestKey }),
  });
  assert.equal((await confirm()).status, 303);
  const final = control.projectResource(project.project_id, original.resource_id, { refresh: true });
  assert.equal(final.status, 'active');
  assert.equal(path.resolve(final.path), path.resolve(candidatePath));
  assert.equal(final.locations.filter((item) => item.status === 'missing').length, 1);
  assert.deepEqual(fs.readFileSync(candidatePath), beforeBytes);
  assert.equal((await confirm()).status, 303);
  assert.deepEqual(fs.readFileSync(candidatePath), beforeBytes);

});

test('registered candidate shown by a dynamic Table is a visible relink conflict', async (t) => {
  const parent = path.resolve('test/.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'resource-relink-ui-registered-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A');
  fs.mkdirSync(projectRoot, { recursive: true });
  const oldPath = path.join(projectRoot, 'old.md');
  const candidatePath = path.join(projectRoot, 'current.md');
  const bytes = 'same bytes, separate Resource identities\n';
  fs.writeFileSync(oldPath, bytes);
  fs.writeFileSync(candidatePath, bytes);
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Dynamic Table relink conflict fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  const server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, projectRoot: workspace, installationRoot: root, resourceControl: control, desktopPickerEnabled: false });
  t.after(async () => { await server.close(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  const missing = control.identify({ filePath: oldPath, project: { id: project.project_id } });
  fs.rmSync(oldPath);
  control.projectResources(project.project_id, { refresh: true });
  const base = new URL(`projects/${project.project_id}`, server.workspace_url);
  const tableResponse = await fetch(new URL('resources?mode=table', `${base.href}/`));
  assert.equal(tableResponse.status, 200);
  const candidate = control.projectResource(project.project_id, control.ledger.resources.byPath(candidatePath).id);
  assert.notEqual(candidate.resource_id, missing.resource_id);
  assert.equal(control.projectResource(project.project_id, missing.resource_id, { refresh: true }).status, 'missing');
  const html = await tableResponse.text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(csrf);
  const conflict = await fetch(new URL('resources/actions/relink', `${base.href}/`), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, resource_id: missing.resource_id, relative_path: 'current.md' }),
  });
  assert.equal(conflict.status, 409);
  const conflictHtml = await conflict.text();
  assert.match(conflictHtml, /此路径已属于另一个资源|This path belongs to another Resource/u);
  assert.match(conflictHtml, new RegExp(missing.resource_id, 'u'));
  assert.match(conflictHtml, new RegExp(candidate.resource_id, 'u'));
  assert.match(conflictHtml, /旧资源仍然缺失|old Resource is still missing/u);
  assert.match(conflictHtml, new RegExp(`resources\\?resource_id=${encodeURIComponent(candidate.resource_id)}`, 'u'));
  assert.match(conflictHtml, new RegExp(`resources\\?resource_id=${encodeURIComponent(missing.resource_id)}`, 'u'));
  assert.doesNotMatch(conflictHtml, /name="(?:preview_digest|request_key)"|resources\.relink_confirm/u);
  assert.equal(control.describe(missing.resource_id).actions.some((item) => item.action_type === 'relink'), false);
  assert.equal(fs.readFileSync(candidatePath, 'utf8'), bytes);
});
