import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { createCaptureSourceModule } from '../src/capture-source-module.js';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';
import { startAtlasUiServer } from '../src/ui-server.js';

test('Share fallback preserves access versus format facts through Host and UI without preparing a Save', async (t) => {
  const temp = path.resolve('test/.tmp'); fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, 'capture-fallback-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '分享来源'); fs.mkdirSync(projectRoot, { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '分享来源', currentPath: '分享来源' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '分享来源', reason: 'Isolated fallback fixture.' });
  const save = createSaveService({ stateDir });
  let httpStatus = 403;
  const fetchImpl = async () => new Response('<html><title>Untrusted login page</title><script>untrusted()</script></html>', {
    status: httpStatus, headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  const captureSourceOptions = { fetchImpl, lookupHost: async () => [{ address: '93.184.216.34', family: 4 }] };
  const capture = createCaptureSourceService({ stateDir, registry, saveService: save, ...captureSourceOptions });
  const module = createCaptureSourceModule({ captureSource: capture });
  let server;
  t.after(async () => {
    await server?.close(); capture.dispose(); save.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const journalPath = path.join(stateDir, 'ui', 'saved-work.json');
  const journalBytes = () => fs.existsSync(journalPath) ? fs.readFileSync(journalPath).toString('base64') : null;
  const journalBefore = journalBytes();
  const sourceUrl = 'https://chatgpt.com/share/fallback-fixture';
  for (const status of [403, 401, 404, 410, 200]) {
    httpStatus = status;
    const envelope = await module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source',
      project_id: project.project_id, action: 'capture-url', parameters: {
        url: sourceUrl, folder: '.', name: '公开对话', requestKey: `fallback-${status}`,
        caller: { tool: 'fallback-fixture-host', client_run_id: `fallback-${status}` },
      } });
    const result = envelope.data;
    assert.equal(result.status, 'export_required');
    assert.equal(result.http_status, status);
    assert.equal(result.reason_code, status === 200 ? 'share_unrecognized' : 'share_unavailable');
    assert.equal(result.requested_url, sourceUrl); assert.equal(result.final_url, sourceUrl);
    assert.equal(result.save_id, undefined);
    assert.doesNotMatch(JSON.stringify(result), /Untrusted login page|untrusted\(\)/u);
    assert.equal(journalBytes(), journalBefore);
    assert.deepEqual(fs.readdirSync(projectRoot), []);
  }
  server = await startAtlasUiServer({ stateDir, registry, intake: save.intake, projectRoot: workspace, installationRoot: workspace, captureSourceOptions });
  const home = await (await fetch(`${server.workspace_url}projects/${project.project_id}`)).text();
  const csrf = home.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  for (const status of [403, 200]) {
    httpStatus = status;
    const response = await fetch(`${server.workspace_url}projects/${project.project_id}/capture-source/prepare`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, url: sourceUrl, folder: '.', name: '公开对话' }),
    });
    assert.equal(response.status, 422);
    const html = await response.text();
    assert.match(html, new RegExp(`HTTP ${status}`));
    assert.match(html, status === 403 ? /could not be accessed|无法访问/u : /format was not recognized|无法识别对话格式/u);
    assert.doesNotMatch(html, /Untrusted login page|<script>untrusted/u);
    assert.equal(journalBytes(), journalBefore);
    assert.deepEqual(fs.readdirSync(projectRoot), []);
  }
});
