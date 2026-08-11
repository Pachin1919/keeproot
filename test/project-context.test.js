import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';

const tempRoot = path.resolve('test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = path.join(caseRoot, 'state');
  const vaultRoot = path.join(caseRoot, 'vault');
  const websiteRoot = path.join(caseRoot, 'website');
  fs.mkdirSync(path.join(vaultRoot, 'Career'), { recursive: true });
  fs.mkdirSync(path.join(websiteRoot, 'Site'), { recursive: true });
  return { stateDir, vaultRoot, websiteRoot };
}

test('schema v20 keeps Project context and identity tables outside ledger.js', (t) => {
  const { stateDir } = setup('project-context-schema');
  const registry = new Registry({ stateDir });
  t.after(() => registry.dispose());

  assert.equal(registry.ledger.db.prepare('PRAGMA user_version').get().user_version, 20);
  const tables = new Set(
    registry.ledger.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => row.name),
  );
  assert.ok(tables.has('project_locations'));
  assert.ok(tables.has('project_context_links'));
  assert.ok(tables.has('project_identity_signatures'));
  const rootColumns = new Set(
    registry.ledger.db.prepare('PRAGMA table_info(portfolio_roots)').all().map((row) => row.name),
  );
  assert.ok(rootColumns.has('governance_status'));
  assert.ok(rootColumns.has('root_type'));
  assert.ok(rootColumns.has('content_policy'));
  assert.ok(rootColumns.has('adopted_at'));
});

test('Registry adopts real roots and binds each Project to one active location', (t) => {
  const { stateDir, vaultRoot, websiteRoot } = setup('project-context-roots');
  const registry = new Registry({ stateDir });
  t.after(() => registry.dispose());

  const vault = registry.adoptRoot({
    rootPath: vaultRoot,
    rootType: 'managed_library',
    contentPolicy: 'bounded_content',
  });
  const website = registry.adoptRoot({
    rootPath: websiteRoot,
    rootType: 'project_workspace',
    contentPolicy: 'bounded_content',
  });
  const sameVault = registry.adoptRoot({
    rootPath: vaultRoot,
    rootType: 'managed_library',
    contentPolicy: 'bounded_content',
  });
  assert.equal(sameVault.root_id, vault.root_id);
  assert.equal(registry.listRoots().length, 2);

  const source = registry.create({ name: 'Career', currentPath: 'Career' });
  const target = registry.create({ name: 'Website', currentPath: 'Site' });
  const sourceLocation = registry.attachRoot(source.project_id, {
    rootId: vault.root_id,
    relativePath: 'Career',
    reason: 'Bind the existing Project to its governed Library.',
  });
  const targetLocation = registry.attachRoot(target.project_id, {
    rootId: website.root_id,
    relativePath: 'Site',
    reason: 'Bind the existing Project to its governed workspace.',
  });

  assert.equal(sourceLocation.root_id, vault.root_id);
  assert.equal(targetLocation.root_id, website.root_id);
  assert.equal(registry.show(source.project_id).location.relative_path, 'Career');
  assert.equal(registry.show(target.project_id).location.relative_path, 'Site');
  assert.equal(registry.showRoot(vault.root_id).root.content_policy, 'bounded_content');
});

test('Registry persists one reusable context link and keeps superseded versions', (t) => {
  const { stateDir, vaultRoot, websiteRoot } = setup('project-context-link');
  const registry = new Registry({ stateDir });
  t.after(() => registry.dispose());

  const vault = registry.adoptRoot({
    rootPath: vaultRoot,
    rootType: 'managed_library',
    contentPolicy: 'bounded_content',
  });
  const website = registry.adoptRoot({
    rootPath: websiteRoot,
    rootType: 'project_workspace',
    contentPolicy: 'bounded_content',
  });
  const source = registry.create({ name: 'Career', currentPath: 'Career' });
  const target = registry.create({ name: 'Website', currentPath: 'Site' });
  registry.attachRoot(source.project_id, {
    rootId: vault.root_id,
    relativePath: 'Career',
    reason: 'Bind source Project.',
  });
  registry.attachRoot(target.project_id, {
    rootId: website.root_id,
    relativePath: 'Site',
    reason: 'Bind target Project.',
  });

  const first = registry.linkContext(target.project_id, {
    sourceProjectId: source.project_id,
    purpose: 'career_positioning',
    extensions: ['.md'],
    maxCandidates: 20,
    reason: 'The website should reuse reviewed career direction sources.',
  });
  const repeated = registry.linkContext(target.project_id, {
    sourceProjectId: source.project_id,
    purpose: 'career_positioning',
    extensions: ['.md'],
    maxCandidates: 20,
    reason: 'The website should reuse reviewed career direction sources.',
  });
  assert.equal(repeated.link_id, first.link_id);
  assert.equal(registry.contextLinks(target.project_id).length, 1);

  const revised = registry.linkContext(target.project_id, {
    sourceProjectId: source.project_id,
    purpose: 'career_positioning',
    extensions: ['.md', '.txt'],
    maxCandidates: 12,
    reason: 'Include reviewed plain-text direction notes.',
  });
  assert.notEqual(revised.link_id, first.link_id);
  const active = registry.contextLinks(target.project_id);
  assert.equal(active.length, 1);
  assert.equal(active[0].link_id, revised.link_id);
  assert.deepEqual(active[0].filters.extensions, ['.md', '.txt']);
  assert.equal(registry.contextLinkHistory(target.project_id).length, 2);

  registry.disableContextLink(revised.link_id, {
    reason: 'Stop using this source Project for future website tasks.',
  });
  assert.equal(registry.contextLinks(target.project_id).length, 0);
  assert.equal(registry.contextLinkHistory(target.project_id).at(-1).status, 'disabled');
});

test('Context Link rejects role filters until the Catalog can enforce them', (t) => {
  const { stateDir, vaultRoot, websiteRoot } = setup('project-context-role-filter');
  const registry = new Registry({ stateDir });
  t.after(() => registry.dispose());
  const vault = registry.adoptRoot({
    rootPath: vaultRoot,
    rootType: 'managed_library',
    contentPolicy: 'bounded_content',
  });
  const website = registry.adoptRoot({
    rootPath: websiteRoot,
    rootType: 'project_workspace',
    contentPolicy: 'bounded_content',
  });
  const source = registry.create({ name: 'Career', currentPath: 'Career' });
  const target = registry.create({ name: 'Website', currentPath: 'Site' });
  registry.attachRoot(source.project_id, {
    rootId: vault.root_id,
    reason: 'Bind source Project.',
  });
  registry.attachRoot(target.project_id, {
    rootId: website.root_id,
    reason: 'Bind target Project.',
  });

  assert.throws(
    () => registry.linkContext(target.project_id, {
      sourceProjectId: source.project_id,
      purpose: 'career_positioning',
      extensions: ['.md'],
      roles: ['source'],
      reason: 'Do not persist an unenforced role filter.',
    }),
    /role filter.*not supported/i,
  );
});

test('Root adoption rejects files and Project binding rejects paths outside the adopted root', (t) => {
  const { stateDir, vaultRoot } = setup('project-context-boundaries');
  const rootInsideState = path.join(stateDir, 'not-a-library');
  fs.mkdirSync(rootInsideState, { recursive: true });
  const registry = new Registry({ stateDir });
  t.after(() => registry.dispose());

  const regularFile = path.join(path.dirname(vaultRoot), 'not-a-root.txt');
  fs.writeFileSync(regularFile, 'x', 'utf8');
  assert.throws(
    () => registry.adoptRoot({
      rootPath: regularFile,
      rootType: 'managed_library',
      contentPolicy: 'bounded_content',
    }),
    /real directory/i,
  );
  assert.throws(
    () => registry.adoptRoot({
      rootPath: rootInsideState,
      rootType: 'project_workspace',
      contentPolicy: 'bounded_content',
    }),
    /state|overlap/i,
  );
  assert.throws(
    () => registry.adoptRoot({
      rootPath: path.dirname(stateDir),
      rootType: 'workspace_container',
      contentPolicy: 'structure_only',
    }),
    /state|overlap/i,
  );

  const root = registry.adoptRoot({
    rootPath: vaultRoot,
    rootType: 'managed_library',
    contentPolicy: 'bounded_content',
  });
  assert.throws(
    () => registry.adoptRoot({
      rootPath: path.join(vaultRoot, 'Career'),
      rootType: 'project_workspace',
      contentPolicy: 'bounded_content',
    }),
    /overlap/i,
  );
  const project = registry.create({ name: 'Escape', currentPath: 'Missing' });
  assert.throws(
    () => registry.attachRoot(project.project_id, {
      rootId: root.root_id,
      relativePath: '../outside',
      reason: 'Invalid escape.',
    }),
    /escape|relative/i,
  );
});
