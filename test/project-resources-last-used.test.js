import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildProjectResourcesModel } from '../src/ui/read-model/project-resources-model.js';
import { renderProjectResourcesView } from '../src/ui/views/project-resources-view.js';

test('Resources last used includes an existing Table Work for the same Resource', (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'resource-last-used-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const usedPath = path.join(root, '已用.csv');
  const otherPath = path.join(root, '未用.csv');
  fs.writeFileSync(usedPath, '类别,金额\n甲,10\n');
  fs.writeFileSync(otherPath, '类别,金额\n乙,20\n');
  const workedAt = '2026-10-02T05:23:20.011Z';
  const model = buildProjectResourcesModel({
    project: { id: 'PRJ-1', name: '研究项目' }, root, base: '/projects/PRJ-1',
    recentWork: [], savedWork: [],
    resourceFacts: [
      { resource_id: 'RES-used', path: usedPath },
      { resource_id: 'RES-other', path: otherPath },
    ],
    workSessions: [{ session_id: 'DWT-1', updated_at: workedAt, sources: [{ resource_id: 'RES-used' }] }],
  });
  assert.equal(model.other_files.find((item) => item.resource_id === 'RES-used')?.last_worked_at, workedAt);
  assert.equal(model.other_files.find((item) => item.resource_id === 'RES-other')?.last_worked_at, null);
  const html = renderProjectResourcesView(model);
  assert.match(html, /<time class="workspace-resource-last-used" datetime="2026-10-02T05:23:20.011Z">/u);
  assert.match(html, /<span class="workspace-resource-last-used">Not yet worked in Keeproot<\/span>/u);
});
