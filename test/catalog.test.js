import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Registry } from '../src/registry.js';

const tempRoot = path.resolve('test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = path.join(caseRoot, 'state');
  const vaultRoot = path.join(caseRoot, 'vault');
  const projectPath = path.join(vaultRoot, 'Career');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, '求职方向.md'),
    [
      '---',
      'tags: [求职, 网站]',
      '---',
      '# 新的求职方向',
      '',
      '我重新考虑了荷兰和新西兰的初级数据岗位。',
      '个人网站需要突出数据治理、BA和DA方向。',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectPath, '生活记录.md'),
    '# 生活记录\n\n今天整理了房间，与个人网站方向无关。\n',
    'utf8',
  );
  const registry = new Registry({ stateDir });
  const root = registry.adoptRoot({
    rootPath: vaultRoot,
    rootType: 'managed_library',
    contentPolicy: 'bounded_content',
  });
  const project = registry.create({ name: 'Career', currentPath: 'Career' });
  registry.attachRoot(project.project_id, {
    rootId: root.root_id,
    relativePath: 'Career',
    reason: 'Catalog fixture Project.',
  });
  registry.dispose();
  return { stateDir, vaultRoot, projectPath, projectId: project.project_id };
}

test('Catalog incrementally indexes a bounded Project and reuses unchanged local facts', (t) => {
  const fixture = setup('catalog-incremental');
  const catalog = new Catalog({ stateDir: fixture.stateDir });
  t.after(() => catalog.dispose());

  const first = catalog.update({ projectId: fixture.projectId });
  assert.equal(first.status, 'completed');
  assert.equal(first.observed_files, 2);
  assert.equal(first.changed_files, 2);
  assert.equal(first.reused_files, 0);
  assert.equal(first.content_files_read, 2);
  assert.equal(first.source_changes.length, 0);

  const second = catalog.update({ projectId: fixture.projectId });
  assert.equal(second.observed_files, 2);
  assert.equal(second.changed_files, 0);
  assert.equal(second.reused_files, 2);
  assert.equal(second.content_files_read, 0);
  assert.notEqual(second.generation_id, first.generation_id);
});

test('Catalog excludes Office lock and editor temporary files in the existing walk', (t) => {
  const fixture = setup('catalog-temporary-files');
  fs.writeFileSync(path.join(fixture.projectPath, '~$draft.md'), 'temporary editor state', 'utf8');
  fs.writeFileSync(path.join(fixture.projectPath, '.notes.md.swp'), 'temporary editor state', 'utf8');
  const catalog = new Catalog({ stateDir: fixture.stateDir });
  t.after(() => catalog.dispose());

  const result = catalog.update({ projectId: fixture.projectId });
  assert.equal(result.observed_files, 2);
  assert.equal(result.skipped_temporary_files, 2);
  assert.equal(result.content_files_read, 2);
});

test('Catalog uses local Chinese trigram search and returns bounded candidates instead of bodies', (t) => {
  const fixture = setup('catalog-chinese-search');
  const catalog = new Catalog({ stateDir: fixture.stateDir });
  t.after(() => catalog.dispose());
  catalog.update({ projectId: fixture.projectId });

  const result = catalog.search({
    projectId: fixture.projectId,
    terms: ['求职方向', '个人网站'],
    extensions: ['.md'],
    maxCandidates: 5,
  });
  assert.equal(result.schema, 'atlas-catalog-candidates.v1');
  assert.equal(result.query_mode, 'local_fts5_trigram');
  assert.ok(result.candidates.length >= 1);
  assert.equal(result.candidates[0].relative_path, 'Career/求职方向.md');
  assert.match(result.candidates[0].snippet, /求职|个人网站/u);
  assert.ok(result.candidates[0].snippet.length <= 400);
  assert.equal(Object.hasOwn(result.candidates[0], 'body'), false);
  assert.equal(result.content_files_read, 0);
  assert.deepEqual(result.source_changes, []);
});

test('Catalog can resolve a common two-character Chinese search term', (t) => {
  const fixture = setup('catalog-short-chinese-search');
  const catalog = new Catalog({ stateDir: fixture.stateDir });
  t.after(() => catalog.dispose());
  catalog.update({ projectId: fixture.projectId });

  const result = catalog.search({
    projectId: fixture.projectId,
    terms: ['求职'],
    extensions: ['.md'],
    maxCandidates: 5,
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].relative_path, 'Career/求职方向.md');
});

test('Catalog refreshes changed files and marks missing files without retaining them as candidates', (t) => {
  const fixture = setup('catalog-change-and-missing');
  const catalog = new Catalog({ stateDir: fixture.stateDir });
  t.after(() => catalog.dispose());
  catalog.update({ projectId: fixture.projectId });

  const direction = path.join(fixture.projectPath, '求职方向.md');
  fs.appendFileSync(direction, '\n新增：网站需要增加英文求职案例。\n', 'utf8');
  fs.rmSync(path.join(fixture.projectPath, '生活记录.md'));
  const refreshed = catalog.update({ projectId: fixture.projectId });
  assert.equal(refreshed.observed_files, 1);
  assert.equal(refreshed.changed_files, 1);
  assert.equal(refreshed.missing_files, 1);

  const missing = catalog.search({
    projectId: fixture.projectId,
    terms: ['生活记录'],
    maxCandidates: 5,
  });
  assert.equal(missing.candidates.length, 0);
  const current = catalog.search({
    projectId: fixture.projectId,
    terms: ['英文求职案例'],
    maxCandidates: 5,
  });
  assert.equal(current.candidates.length, 1);
  assert.equal(current.candidates[0].relative_path, 'Career/求职方向.md');
});
