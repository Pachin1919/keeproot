import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { startAtlasUiServer } from '../src/ui-server.js';

test('Project Resources opens an exact content reference and shows stale without old text', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/content-location-ui-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, '研究项目');
  fs.mkdirSync(projectRoot, { recursive: true });
  const filePath = path.join(projectRoot, '公交.md'); const original = '# 标题\n\n可定位段落。\n'; fs.writeFileSync(filePath, original, 'utf8');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '研究项目', currentPath: '研究项目' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '研究项目', reason: 'Content location UI fixture.' });
  const control = new ResourceControl({ stateDir, registry }); const resourceId = control.identify({ filePath, project: registry.show(project.project_id).project }).resource_id;
  const intake = new Intake({ stateDir });
  const server = await startAtlasUiServer({ stateDir, registry, intake, resourceControl: control, projectRoot: workspace, installationRoot: workspace });
  t.after(async () => { await server.close(); intake.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  const resources = await (await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/resources?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url))).text();
  assert.match(resources, /content-location\?resource_id=/u);
  const locatedUrl = new URL(`projects/${encodeURIComponent(project.project_id)}/content-location?resource_id=${encodeURIComponent(resourceId)}`, server.workspace_url);
  const locatedResponse = await fetch(locatedUrl); assert.equal(locatedResponse.status, 200);
  const located = await locatedResponse.text();
  assert.match(located, /可定位段落/u);
  const refs = [...located.matchAll(/href="[^"]*content-location\?ref=([^&"]+)/gu)].map((item) => item[1]);
  assert.equal(refs.length, 2);
  const refValue = refs[1];
  const ref = decodeURIComponent(refValue);
  const exact = await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/content-location?ref=${encodeURIComponent(ref)}`, server.workspace_url));
  assert.equal(exact.status, 200); assert.match(await exact.text(), /可定位段落/u);

  const changed = '# 标题\n\n新段落插入。\n\n可定位段落。\n'; fs.writeFileSync(filePath, changed, 'utf8');
  const stale = await fetch(new URL(`projects/${encodeURIComponent(project.project_id)}/content-location?ref=${encodeURIComponent(ref)}`, server.workspace_url));
  assert.equal(stale.status, 200); const staleHtml = await stale.text();
  assert.match(staleHtml, /expired|已过期/u);
  assert.doesNotMatch(staleHtml, /可定位段落/u);
  assert.equal(fs.readFileSync(filePath, 'utf8'), changed);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), crypto.createHash('sha256').update(changed).digest('hex'));
});
