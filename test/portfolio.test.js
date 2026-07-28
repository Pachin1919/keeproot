import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Portfolio, PORTFOLIO_ROOT_TYPES } from '../src/portfolio.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(projectRoot, 'test', '.tmp');
const cliPath = path.join(projectRoot, 'bin', 'atlas.js');

function touch(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const drive = path.join(caseRoot, 'drive');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(drive, { recursive: true });

  fs.mkdirSync(path.join(drive, 'Obisidian', 'Pachin', '.obsidian'), { recursive: true });
  touch(path.join(drive, 'Obisidian', 'Pachin', 'note.md'), '# private body must not be read');

  fs.mkdirSync(path.join(drive, 'Pachin-projects', 'Atlas', '.git'), { recursive: true });
  touch(path.join(drive, 'Pachin-projects', 'Atlas', 'package.json'), '{ invalid on purpose');
  touch(path.join(drive, 'Pachin-projects', 'Atlas', 'AGENTS.md'), 'do not read me');

  touch(path.join(drive, 'PachinApp', 'uninstall.exe'));
  for (let index = 0; index < 8; index += 1) {
    touch(path.join(drive, 'PachinApp', `component-${index}.dll`));
  }

  touch(path.join(drive, 'MaybeTool', 'tool.exe'));
  fs.mkdirSync(path.join(drive, 'MixedWorkspace', '.git'), { recursive: true });
  fs.mkdirSync(path.join(drive, 'MixedWorkspace', '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(drive, '$RECYCLE.BIN'), { recursive: true });
  fs.mkdirSync(path.join(drive, '.pnpm-store', 'v10', 'files'), { recursive: true });
  touch(path.join(drive, '_backup', 'secret.md'), 'must not be observed');
  return { drive, stateDir };
}

function openPortfolio(t, stateDir) {
  const portfolio = new Portfolio({ stateDir });
  t.after(() => portfolio.dispose());
  return portfolio;
}

test('Portfolio inventory is structure-only and conservatively separates software from work roots', (t) => {
  const { drive, stateDir } = setup('portfolio-classification');
  const portfolio = openPortfolio(t, stateDir);

  const receipt = portfolio.inventory({
    root: drive, depth: 2, expand: ['Obisidian', 'Pachin-projects'], exclude: ['_backup'],
  });
  const detail = portfolio.show(receipt.inventory_id);
  const byPath = new Map(detail.roots.map((item) => [item.relative_path, item]));

  assert.equal(receipt.content_files_read, 0);
  assert.equal(receipt.content_bytes_read, 0);
  assert.equal(receipt.truncated, false);
  assert.ok(PORTFOLIO_ROOT_TYPES.includes('installed_application'));
  assert.equal(byPath.get('Obisidian/Pachin').predicted_type, 'managed_library');
  assert.equal(byPath.get('Pachin-projects/Atlas').predicted_type, 'source_repository');
  assert.equal(byPath.get('Obisidian').predicted_type, 'workspace_container');
  assert.equal(byPath.get('Pachin-projects').predicted_type, 'workspace_container');
  assert.equal(byPath.get('PachinApp').predicted_type, 'installed_application');
  assert.equal(byPath.get('PachinApp').predicted_relation, 'infrastructure');
  assert.equal(byPath.get('.pnpm-store').predicted_type, 'package_store');
  assert.equal(byPath.get('MaybeTool').predicted_type, 'unknown');
  assert.ok(byPath.get('MaybeTool').candidate_types.includes('portable_application'));
  assert.equal(byPath.get('MixedWorkspace').predicted_type, 'unknown');
  assert.deepEqual(
    byPath.get('MixedWorkspace').candidate_types.sort(),
    ['managed_library', 'project_workspace', 'source_repository'],
  );
  assert.equal(byPath.get('$RECYCLE.BIN').predicted_type, 'system_managed');
  assert.equal(byPath.get('$RECYCLE.BIN').predicted_relation, 'infrastructure');
  assert.ok(!detail.roots.some((item) => item.relative_path.startsWith('_backup')));
  assert.deepEqual(detail.inventory.excluded, ['_backup']);
  assert.ok(detail.roots.every((item) => item.direct_names.length <= 30));
});

test('Portfolio inventory is idempotent and reuses stable root identities', (t) => {
  const { drive, stateDir } = setup('portfolio-idempotent');
  const portfolio = openPortfolio(t, stateDir);

  const first = portfolio.inventory({
    root: drive, depth: 2, expand: ['Obisidian', 'Pachin-projects'], exclude: ['_backup'],
  });
  const firstRoots = portfolio.show(first.inventory_id).roots;
  const second = portfolio.inventory({
    root: drive, depth: 2, expand: ['Obisidian', 'Pachin-projects'], exclude: ['_backup'],
  });
  const secondRoots = portfolio.show(second.inventory_id).roots;

  assert.equal(second.reused, true);
  assert.equal(second.inventory_id, first.inventory_id);
  assert.deepEqual(
    secondRoots.map((item) => [item.current_path, item.root_id]),
    firstRoots.map((item) => [item.current_path, item.root_id]),
  );
});

test('Portfolio review persists user Labels and plan never moves uncertain or software roots', (t) => {
  const { drive, stateDir } = setup('portfolio-review-plan');
  const portfolio = openPortfolio(t, stateDir);
  const scan = portfolio.inventory({
    root: drive, depth: 2, expand: ['Obisidian', 'Pachin-projects'], exclude: ['_backup'],
  });
  const atlasRoot = portfolio.show(scan.inventory_id).roots
    .find((item) => item.relative_path === 'Pachin-projects/Atlas');

  const review = portfolio.review(scan.inventory_id, {
    rootId: atlasRoot.root_id,
    rootType: 'tool_source',
    relation: 'related',
    reason: 'Atlas is user-maintained tool source.',
  });
  assert.equal(review.status, 'reviewed');

  const target = path.join(drive, 'PachinStudio');
  assert.throws(
    () => portfolio.plan(scan.inventory_id, { target: path.join(path.dirname(drive), 'outside') }),
    /must remain inside/i,
  );
  const plan = portfolio.plan(scan.inventory_id, { target });
  const byPath = new Map(plan.items.map((item) => [item.relative_path, item]));
  assert.equal(byPath.get('Pachin-projects/Atlas').effective_type, 'tool_source');
  assert.equal(byPath.get('Pachin-projects/Atlas').effective_relation, 'related');
  assert.equal(byPath.get('Pachin-projects/Atlas').suggested_target, path.join(target, 'tools', 'Atlas'));
  assert.equal(byPath.get('Pachin-projects/Atlas').disposition, 'blocked');
  assert.ok(byPath.get('Pachin-projects/Atlas').blockers.includes('path_dependency_report_required'));
  assert.equal(byPath.get('PachinApp').disposition, 'keep');
  assert.equal(byPath.get('PachinApp').suggested_target, null);
  assert.equal(byPath.get('MaybeTool').disposition, 'blocked');
  assert.ok(byPath.get('MaybeTool').blockers.includes('classification_review_required'));

  const detail = portfolio.show(scan.inventory_id);
  const reviewed = detail.roots.find((item) => item.root_id === atlasRoot.root_id);
  assert.equal(reviewed.review.root_type, 'tool_source');
  assert.equal(reviewed.review.relation, 'related');
});

test('Portfolio rejects exclusion escape and does not follow junction candidates', (t) => {
  const { drive, stateDir } = setup('portfolio-boundaries');
  const portfolio = openPortfolio(t, stateDir);
  assert.throws(
    () => portfolio.inventory({ root: drive, depth: 2, exclude: ['../outside'] }),
    /exclude path escapes/i,
  );

  const external = path.join(path.dirname(drive), 'external');
  fs.mkdirSync(external, { recursive: true });
  touch(path.join(external, 'uninstall.exe'));
  const link = path.join(drive, 'LinkedSoftware');
  try {
    fs.symlinkSync(external, link, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return;
    throw error;
  }

  const scan = portfolio.inventory({
    root: drive, depth: 2, expand: ['Obisidian', 'Pachin-projects'], exclude: ['_backup'],
  });
  const linked = portfolio.show(scan.inventory_id).roots
    .find((item) => item.relative_path === 'LinkedSoftware');
  assert.equal(linked.predicted_type, 'unknown');
  assert.equal(linked.special_path, true);
  assert.equal(linked.predicted_relation, 'unresolved');
  assert.ok(linked.evidence.some((item) => item.code === 'reparse_point_not_followed'));
});

test('Portfolio depth two requires an explicit expansion allowlist and never expands software branches implicitly', (t) => {
  const { drive, stateDir } = setup('portfolio-expansion-boundary');
  const portfolio = openPortfolio(t, stateDir);
  touch(path.join(drive, 'SoftwareFarm', 'DeepApp', 'uninstall.exe'));
  for (let index = 0; index < 5; index += 1) {
    touch(path.join(drive, 'SoftwareFarm', 'DeepApp', `library-${index}.dll`));
  }

  assert.throws(
    () => portfolio.inventory({ root: drive, depth: 2, exclude: ['_backup'] }),
    /requires at least one --expand/i,
  );
  const scan = portfolio.inventory({
    root: drive, depth: 2, expand: ['Pachin-projects'], exclude: ['_backup'],
  });
  const detail = portfolio.show(scan.inventory_id);
  assert.ok(detail.roots.some((item) => item.relative_path === 'SoftwareFarm'));
  assert.ok(!detail.roots.some((item) => item.relative_path === 'SoftwareFarm/DeepApp'));
  assert.deepEqual(detail.inventory.expanded, ['Pachin-projects']);
});

test('Portfolio refuses to inventory a root that contains its own Ledger state', () => {
  const caseRoot = path.join(tempRoot, 'portfolio-state-self-observation');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const drive = path.join(caseRoot, 'drive');
  const stateDir = path.join(drive, '.atlas-state');
  fs.mkdirSync(drive, { recursive: true });
  const portfolio = new Portfolio({ stateDir });
  try {
    assert.throws(
      () => portfolio.inventory({ root: drive, depth: 1 }),
      /state must remain outside the inventoried root/i,
    );
  } finally {
    portfolio.dispose();
  }
});

test('Portfolio preserves the evidence kind when a directory cannot be inspected', (t) => {
  const { drive, stateDir } = setup('portfolio-access-evidence');
  const denied = path.join(drive, 'DeniedRoot');
  fs.mkdirSync(denied, { recursive: true });
  const originalRead = fs.readdirSync;
  fs.readdirSync = function denySelectedDirectory(directory, ...rest) {
    if (path.resolve(String(directory)) === path.resolve(denied)) {
      const error = new Error('fixture access denied');
      error.code = 'EACCES';
      throw error;
    }
    return originalRead.call(this, directory, ...rest);
  };
  const portfolio = openPortfolio(t, stateDir);
  try {
    const scan = portfolio.inventory({ root: drive, depth: 1, exclude: ['_backup'] });
    const observed = portfolio.show(scan.inventory_id).roots
      .find((item) => item.relative_path === 'DeniedRoot');
    assert.ok(observed.evidence.some((item) => item.code === 'directory_unreadable'
      && item.error_code === 'EACCES'));
  } finally {
    fs.readdirSync = originalRead;
  }
});

test('Portfolio CLI exposes strict JSON inventory, review, show, and read-only plan commands', () => {
  const { drive, stateDir } = setup('portfolio-cli');
  const runCli = (args) => spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    cwd: projectRoot,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, ATLAS_STATE_DIR: stateDir },
  });
  const inventoryResult = runCli([
    'portfolio', 'inventory', '--root', drive, '--depth', '2',
    '--expand', 'Pachin-projects', '--exclude', '_backup',
    '--actor', 'agent', '--agent', 'codex', '--model', 'test-model',
    '--tool', 'test', '--client-run-id', 'portfolio-cli-test',
  ]);
  assert.equal(inventoryResult.status, 0, inventoryResult.stderr);
  assert.equal(inventoryResult.stderr, '');
  const inventory = JSON.parse(inventoryResult.stdout);
  assert.equal(inventory.ok, true);
  assert.equal(inventory.command, 'portfolio.inventory');
  assert.equal(inventory.data.content_files_read, 0);

  const showResult = runCli(['portfolio', 'show', inventory.data.inventory_id]);
  assert.equal(showResult.status, 0, showResult.stderr);
  const show = JSON.parse(showResult.stdout);
  const atlas = show.data.roots.find((item) => item.relative_path === 'Pachin-projects/Atlas');
  assert.ok(atlas);

  const reviewResult = runCli([
    'portfolio', 'review', inventory.data.inventory_id, '--root-id', atlas.root_id,
    '--type', 'tool_source', '--relation', 'related', '--reason', 'Fixture user tool.',
  ]);
  assert.equal(reviewResult.status, 0, reviewResult.stderr);
  assert.equal(JSON.parse(reviewResult.stdout).data.status, 'reviewed');

  const planResult = runCli([
    'portfolio', 'plan', inventory.data.inventory_id, '--target', path.join(drive, 'PachinStudio'),
  ]);
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout).data;
  assert.deepEqual(plan.source_changes, []);
  assert.equal(plan.policy, 'read_only_plan_no_migration_authority');
});
