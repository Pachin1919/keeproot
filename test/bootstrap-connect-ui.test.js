import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Bootstrap } from '../src/bootstrap.js';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';

const temporaryRoot = path.resolve('test', '.tmp');

function sourceFingerprint(root) {
  const rows = [];
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, item.name);
      if (item.isDirectory()) visit(filePath);
      else rows.push(`${path.relative(root, filePath).replaceAll('\\', '/')}:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`);
    }
  };
  visit(root);
  return rows.join('\n');
}

test('Projects connects initialized Bootstrap Projects through a read-only preview and confirmed UI action', async (t) => {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'bootstrap-connect-ui-'));
  const root = path.join(temporary, '中文资料库');
  const stateDir = path.join(temporary, 'state');
  const relativePaths = ['城市研究', '社区档案'];
  for (const relativePath of relativePaths) {
    const directory = path.join(root, relativePath);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'README.md'), `# ${relativePath}\n\nProject notes.\n`, 'utf8');
    fs.writeFileSync(path.join(directory, '记录.md'), `# 记录\n\n内容保持不变。\n`, 'utf8');
  }

  const registry = new Registry({ stateDir });
  const bootstrap = new Bootstrap({ stateDir });
  let server;
  t.after(async () => {
    if (server) await server.close();
    bootstrap.dispose();
    registry.dispose();
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const initialScan = bootstrap.scan({ root, scanMode: 'structure' });
  for (const prediction of bootstrap.show(initialScan.scan_id).predictions) {
    bootstrap.review(prediction.id, {
      decision: prediction.kind === 'project_candidate' ? 'accepted' : 'rejected',
      reason: 'fixture_user reviewed this Project candidate.',
    });
  }
  bootstrap.initialize(initialScan.scan_id);
  const initialProjects = registry.list().filter((project) => relativePaths.includes(project.current_path));
  assert.equal(initialProjects.length, 2);
  const originalIds = new Map(initialProjects.map((project) => [project.current_path, project.id]));
  assert.ok(initialProjects.every((project) => registry.show(project.id).location == null));
  assert.equal(registry.listRoots().length, 0);
  const before = sourceFingerprint(root);

  const uninitialized = bootstrap.scan({ root, scanMode: 'structure', forceNew: true });
  server = await startAtlasUiServer({ stateDir, registry, runtime: {} });
  const baseUrl = server.workspace_url;
  const projectsResponse = await fetch(`${baseUrl}projects`);
  assert.equal(projectsResponse.status, 200);
  const projectsHtml = await projectsResponse.text();
  const previewPath = `/projects/bootstrap/${initialScan.scan_id}/connect`;
  assert.ok(projectsHtml.includes(previewPath), 'Projects should list the initialized Bootstrap scan');

  const uninitializedResponse = await fetch(`${baseUrl}projects/bootstrap/${uninitialized.scan_id}/connect`);
  assert.equal(uninitializedResponse.status, 409);
  assert.equal(registry.listRoots().length, 0);

  const previewResponse = await fetch(new URL(previewPath, baseUrl));
  assert.equal(previewResponse.status, 200);
  const previewHtml = await previewResponse.text();
  for (const projectId of originalIds.values()) assert.ok(previewHtml.includes(projectId));
  assert.match(previewHtml, /workspace_container/u);
  assert.match(previewHtml, /structure_only/u);
  assert.match(previewHtml, /控制文件|control files/iu);
  const csrf = previewHtml.match(/name="csrf" value="([^"]+)"/u)?.[1];
  const previewToken = previewHtml.match(/name="preview_token" value="([^"]+)"/u)?.[1];
  assert.ok(csrf);
  assert.ok(previewToken);
  assert.equal(registry.listRoots().length, 0);
  for (const project of initialProjects) assert.equal(registry.show(project.id).location, null);
  assert.equal(sourceFingerprint(root), before);

  const post = (fields) => fetch(new URL(previewPath, baseUrl), {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
  });
  assert.equal((await post({ csrf: 'invalid', preview_token: previewToken })).status, 403);
  assert.equal(registry.listRoots().length, 0);
  assert.equal(sourceFingerprint(root), before);

  const movedPath = path.join(temporary, '暂存中的项目');
  const linkedProjectPath = path.join(root, relativePaths[1]);
  fs.renameSync(linkedProjectPath, movedPath);
  fs.symlinkSync(movedPath, linkedProjectPath, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await post({ csrf, preview_token: previewToken })).status, 409);
  fs.unlinkSync(linkedProjectPath);
  fs.renameSync(movedPath, linkedProjectPath);
  assert.equal(registry.listRoots().length, 0);

  const refreshedResponse = await fetch(new URL(previewPath, baseUrl));
  assert.equal(refreshedResponse.status, 200);
  const refreshedHtml = await refreshedResponse.text();
  const refreshedCsrf = refreshedHtml.match(/name="csrf" value="([^"]+)"/u)?.[1];
  const refreshedToken = refreshedHtml.match(/name="preview_token" value="([^"]+)"/u)?.[1];
  const connectedResponse = await post({ csrf: refreshedCsrf, preview_token: refreshedToken });
  assert.equal(connectedResponse.status, 200);
  const connectedHtml = await connectedResponse.text();
  assert.match(connectedHtml, /connected|已连接/iu);
  const connectedRoot = registry.listRoots().find((item) => path.resolve(item.current_path) === path.resolve(root));
  assert.ok(connectedRoot);
  assert.equal(connectedRoot.root_type, 'workspace_container');
  assert.equal(connectedRoot.content_policy, 'structure_only');
  for (const [relativePath, projectId] of originalIds) {
    const detail = registry.show(projectId);
    assert.equal(detail.location.root_id, connectedRoot.id);
    assert.equal(detail.location.relative_path, relativePath);
    assert.equal(path.resolve(detail.location.root_path), path.resolve(root));
  }
  const repeated = await post({ csrf: refreshedCsrf, preview_token: refreshedToken });
  assert.equal(repeated.status, 200);
  assert.equal(registry.listRoots().length, 1);
  assert.deepEqual(new Map(registry.list().filter((project) => relativePaths.includes(project.current_path)).map((project) => [project.current_path, project.id])), originalIds);
  assert.equal(sourceFingerprint(root), before);
});

test('Projects connection preview and confirmation preserve settings from an already adopted Root', async (t) => {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'bootstrap-connect-existing-root-'));
  const root = path.join(temporary, '已有工作区');
  const relativePath = '研究项目';
  const projectPath = path.join(root, relativePath);
  const stateDir = path.join(temporary, 'state');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'README.md'), '# 研究项目\n\nProject notes.\n', 'utf8');
  fs.writeFileSync(path.join(projectPath, '记录.md'), '# 记录\n\n保留原有内容。\n', 'utf8');

  const registry = new Registry({ stateDir });
  const bootstrap = new Bootstrap({ stateDir });
  let server;
  t.after(async () => {
    if (server) await server.close();
    bootstrap.dispose();
    registry.dispose();
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const scan = bootstrap.scan({ root, scanMode: 'structure' });
  for (const prediction of bootstrap.show(scan.scan_id).predictions) {
    bootstrap.review(prediction.id, {
      decision: prediction.kind === 'project_candidate' ? 'accepted' : 'rejected',
      reason: 'fixture_user reviewed the initialized Project.',
    });
  }
  bootstrap.initialize(scan.scan_id);
  const projectsBefore = registry.list();
  assert.equal(projectsBefore.length, 1);
  const originalProjectId = projectsBefore[0].id;
  assert.equal(projectsBefore[0].current_path, relativePath);
  const originalLocation = registry.show(originalProjectId).location;
  assert.equal(originalLocation, null);
  const adopted = registry.adoptRoot({
    rootPath: root,
    rootType: 'managed_library',
    contentPolicy: 'bounded_content',
  });
  const rootId = adopted.root_id;
  const existingRoot = registry.listRoots().find((item) => item.id === rootId);
  assert.ok(existingRoot);
  const before = sourceFingerprint(root);

  server = await startAtlasUiServer({ stateDir, registry, runtime: {}, desktopPickerEnabled: false });
  const baseUrl = server.workspace_url;
  const previewPath = `/projects/bootstrap/${scan.scan_id}/connect`;
  const projectsResponse = await fetch(new URL('/projects', baseUrl));
  assert.equal(projectsResponse.status, 200);
  assert.ok((await projectsResponse.text()).includes(previewPath));

  const previewResponse = await fetch(new URL(previewPath, baseUrl));
  assert.equal(previewResponse.status, 200);
  const previewHtml = await previewResponse.text();
  assert.ok(previewHtml.includes(originalProjectId));
  assert.match(previewHtml, /managed_library/u);
  assert.match(previewHtml, /bounded_content/u);
  assert.equal(registry.listRoots().length, 1);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.show(originalProjectId).location, null);
  assert.equal(sourceFingerprint(root), before);
  const csrf = previewHtml.match(/name="csrf" value="([^"]+)"/u)?.[1];
  const previewToken = previewHtml.match(/name="preview_token" value="([^"]+)"/u)?.[1];
  assert.ok(csrf);
  assert.ok(previewToken);

  const confirmed = await fetch(new URL(previewPath, baseUrl), {
    method: 'POST',
    body: new URLSearchParams({ csrf, preview_token: previewToken }),
    redirect: 'manual',
  });
  assert.equal(confirmed.status, 200);
  assert.match(await confirmed.text(), /connected|已连接/iu);
  const rootsAfter = registry.listRoots();
  assert.equal(rootsAfter.length, 1);
  const rootAfter = rootsAfter[0];
  assert.equal(rootAfter.id, rootId);
  assert.equal(rootAfter.root_type, 'managed_library');
  assert.equal(rootAfter.content_policy, 'bounded_content');
  const projectsAfter = registry.list();
  assert.equal(projectsAfter.length, 1);
  assert.equal(projectsAfter[0].id, originalProjectId);
  const location = registry.show(originalProjectId).location;
  assert.equal(location.root_id, rootId);
  assert.equal(path.resolve(location.root_path), path.resolve(root));
  assert.equal(location.relative_path, relativePath);
  assert.equal(sourceFingerprint(root), before);
  assert.equal(registry.listRoots().find((item) => item.id === rootId).root_type, existingRoot.root_type);
  assert.equal(registry.listRoots().find((item) => item.id === rootId).content_policy, existingRoot.content_policy);
});
