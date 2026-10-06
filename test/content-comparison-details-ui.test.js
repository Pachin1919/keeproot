import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { compareContent } from '../src/content-inspection.js';

test('Project comparison POST reads computed rows, three times and escaped content without modifying sources', async (t) => {
  fs.mkdirSync(path.resolve('test/.tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve('test/.tmp/comparison-details-ui-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, '项目'); fs.mkdirSync(projectPath, { recursive: true });
  const leftPath = path.join(projectPath, '旧.csv'); const rightPath = path.join(projectPath, '新.csv');
  const before = 'ID,期间,日期,值\na,2020-01,2020-01-01,old\na,2020-02,2020-02-01,old2\nb,2020-01,2020-01-02,removed\nc,2020-01,2020-01-03,kept\n';
  const after = '值,日期,期间,ID\n<script>alert(1)</script>,2020-01-01,2020-01,a\nnew2,2020-02-01,2020-02,a\nkept,2020-01-03,2020-01,c\nadded,2020-03-01,2020-03,d\n';
  fs.writeFileSync(leftPath, before); fs.writeFileSync(rightPath, after);
  fs.writeFileSync(path.join(projectPath, 'left.txt'), '唯一旧段\n\n');
  fs.writeFileSync(path.join(projectPath, 'right.txt'), '唯一新段\n\n');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '项目', currentPath: '项目' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '项目', reason: 'Comparison fixture.' });
  const otherPath = path.join(workspace, 'Other'); fs.mkdirSync(otherPath); fs.writeFileSync(path.join(otherPath, 'secret.csv'), before);
  const other = registry.create({ name: 'Other', currentPath: 'Other' });
  registry.attachRoot(other.project_id, { rootId: adopted.root_id, relativePath: 'Other', reason: 'Boundary fixture.' });
  const server = await startAtlasUiServer({ stateDir, registry, projectRoot: path.resolve('.'), installationRoot: path.resolve('.') });
  t.after(async () => { await server.close(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const compareUrl = new URL(`projects/${project.project_id}/compare`, server.workspace_url);
  const choose = await (await fetch(compareUrl)).text();
  assert.match(choose, /name="key_column"/u); assert.match(choose, /name="period_column"/u); assert.match(choose, /name="event_date_column"/u);
  const csrf = choose.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const run = (values) => fetch(`${compareUrl.href}/run`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...values }) });
  const fields = { left: '旧.csv', right: '新.csv', key_column: 'ID', period_column: '期间', event_date_column: '日期' };
  const started = await run(fields); assert.equal(started.status, 303, (await started.clone().text()).slice(-1000));
  const resultUrl = new URL(started.headers.get('location'), server.workspace_url);
  const page = await (await fetch(resultUrl)).text();
  assert.match(page, /data-comparison-details/u); assert.match(page, /Three separate time sources/u);
  assert.match(page, /2020-01-01/u); assert.match(page, /2020-03-01/u);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/u);
  const host = compareContent({ stateDir, projectRoot: path.resolve('.'), leftPath, rightPath, details: true,
    keyColumn: 'ID', periodColumn: '期间', eventDateColumn: '日期' });
  assert.deepEqual(['added', 'removed', 'changed', 'unchanged'].map(key => host.details.summary[key]), [1, 1, 2, 1]);
  for (const [label, count] of [['Added on the right', 1], ['Only on the left', 1], ['Text or row differs', 2], ['Unchanged', 1]]) {
    assert.match(page, new RegExp(`${label}</dt>\\s*<dd[^>]*>${count}</dd>`, 'u'));
  }
  assert.ok(page.includes(host.details.time_sources.file_modified.left));
  assert.ok(page.includes(host.details.time_sources.file_modified.right));
  assert.equal(fs.readFileSync(leftPath, 'utf8'), before); assert.equal(fs.readFileSync(rightPath, 'utf8'), after);
  const rejected = await run({ ...fields, right: '../Other/secret.csv' }); assert.equal(rejected.status, 400);
  const textStarted = await run({ left: 'left.txt', right: 'right.txt', key_column: '', period_column: '', event_date_column: '' });
  assert.equal(textStarted.status, 303);
  const textPage = await (await fetch(new URL(textStarted.headers.get('location'), server.workspace_url))).text();
  assert.match(textPage, /唯一旧段/u); assert.match(textPage, /唯一新段/u); assert.match(textPage, /Equal Hash proves equal content/u);
  const uncertainStart = await run({ left: '旧.csv', right: '新.csv', key_column: '', period_column: '', event_date_column: '' });
  assert.equal(uncertainStart.status, 303);
  assert.match(await (await fetch(new URL(uncertainStart.headers.get('location'), server.workspace_url))).text(), /Matching is uncertain/u);
});
