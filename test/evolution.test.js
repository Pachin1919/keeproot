import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Evolution } from '../src/evolution.js';
import { Registry } from '../src/registry.js';

const tempRoot = path.resolve('test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(root, 'Projects', 'Atlas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Projects', 'Atlas', 'note.md'), '# Note\n', 'utf8');
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' });
  registry.dispose();
  return { caseRoot, root, stateDir, projectId: project.project_id };
}

test('Evolution creates one reviewed directory and removes it on safe rollback', (t) => {
  const { root, stateDir } = setup('evolution-create-directory');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root,
    operation: 'create_directory',
    target: 'Projects/Atlas/Working',
    intent: 'Create the accepted Project working area.',
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.operation, 'create_directory');
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas', 'Working')), false);
  const preview = evolution.preview(prepared.run_id);
  assert.equal(preview.plan.source_changes.length, 1);
  assert.equal(preview.plan.requires_approval, true);
  evolution.approve(prepared.run_id, { reason: 'Create this one directory.' });
  const executed = evolution.execute(prepared.run_id);
  assert.equal(executed.verified, true);
  assert.equal(fs.statSync(path.join(root, prepared.target)).isDirectory(), true);
  assert.deepEqual(evolution.execute(prepared.run_id), executed);
  const rolledBack = evolution.rollback(prepared.run_id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(root, prepared.target)), false);
  assert.deepEqual(evolution.rollback(prepared.run_id), rolledBack);
});

test('Evolution moves one file without rewriting it and safely moves it back', (t) => {
  const { root, stateDir } = setup('evolution-move-file');
  fs.mkdirSync(path.join(root, 'Projects', 'Atlas', 'Working'), { recursive: true });
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root,
    operation: 'move_file',
    source: 'Projects/Atlas/note.md',
    target: 'Projects/Atlas/Working/note.md',
  });
  evolution.approve(prepared.run_id, { reason: 'Move the misplaced note.' });
  const executed = evolution.execute(prepared.run_id);
  assert.equal(executed.changed_paths, 2);
  assert.equal(fs.existsSync(path.join(root, prepared.source)), false);
  assert.equal(fs.readFileSync(path.join(root, prepared.target), 'utf8'), '# Note\n');
  evolution.rollback(prepared.run_id);
  assert.equal(fs.readFileSync(path.join(root, prepared.source), 'utf8'), '# Note\n');
  assert.equal(fs.existsSync(path.join(root, prepared.target)), false);
});

test('Evolution migrates one Project directory and updates Registry only after verification', (t) => {
  const { root, stateDir, projectId } = setup('evolution-migrate-project');
  fs.mkdirSync(path.join(root, 'Projects', 'Atlas', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Projects', 'Atlas', 'nested', 'data.json'), '{"ok":true}\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root,
    operation: 'migrate_project',
    projectId,
    target: 'Projects/Atlas-Renamed',
  });
  assert.equal(prepared.source, 'Projects/Atlas');
  assert.equal(prepared.project_id, projectId);
  evolution.approve(prepared.run_id, { reason: 'Migrate this Project directory.' });
  evolution.execute(prepared.run_id);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas')), false);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas-Renamed', 'nested', 'data.json')), true);
  assert.equal(evolution.ledger.getProject(projectId).current_path, 'Projects/Atlas-Renamed');
  evolution.rollback(prepared.run_id);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas', 'nested', 'data.json')), true);
  assert.equal(evolution.ledger.getProject(projectId).current_path, 'Projects/Atlas');
});

test('Evolution invalidates approval on source change or target claim and preserves both states', (t) => {
  const { root, stateDir } = setup('evolution-stale');
  fs.mkdirSync(path.join(root, 'Projects', 'Atlas', 'Working'), { recursive: true });
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const changed = evolution.prepare({
    root,
    operation: 'move_file',
    source: 'Projects/Atlas/note.md',
    target: 'Projects/Atlas/Working/note.md',
  });
  evolution.approve(changed.run_id, { reason: 'Approved before external edit.' });
  fs.appendFileSync(path.join(root, changed.source), 'later\n', 'utf8');
  assert.throws(() => evolution.execute(changed.run_id), /changed after prepare|stale/i);
  assert.equal(evolution.preview(changed.run_id).run.status, 'stale');
  assert.equal(fs.existsSync(path.join(root, changed.target)), false);

  const claimed = evolution.prepare({
    root,
    operation: 'move_file',
    source: 'Projects/Atlas/note.md',
    target: 'Projects/Atlas/Working/claimed.md',
  });
  evolution.approve(claimed.run_id, { reason: 'Approved before target claim.' });
  fs.writeFileSync(path.join(root, claimed.target), 'claimed\n', 'utf8');
  assert.throws(() => evolution.execute(claimed.run_id), /claimed|target/i);
  assert.equal(fs.existsSync(path.join(root, claimed.source)), true);
  assert.equal(fs.readFileSync(path.join(root, claimed.target), 'utf8'), 'claimed\n');
});

test('Evolution rollback refuses later content in a created or migrated directory', (t) => {
  const { root, stateDir, projectId } = setup('evolution-rollback-conflict');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const created = evolution.prepare({
    root, operation: 'create_directory', target: 'Projects/Atlas/Working',
  });
  evolution.approve(created.run_id, { reason: 'Create directory.' });
  evolution.execute(created.run_id);
  fs.writeFileSync(path.join(root, created.target, 'later.md'), 'later\n', 'utf8');
  assert.throws(() => evolution.rollback(created.run_id), /conflict|no longer match/i);
  assert.equal(fs.existsSync(path.join(root, created.target, 'later.md')), true);

  const migrated = evolution.prepare({
    root, operation: 'migrate_project', projectId, target: 'Projects/Atlas-New',
  });
  evolution.approve(migrated.run_id, { reason: 'Migrate Project.' });
  evolution.execute(migrated.run_id);
  fs.writeFileSync(path.join(root, migrated.target, 'later.md'), 'later\n', 'utf8');
  assert.throws(() => evolution.rollback(migrated.run_id), /conflict|no longer match/i);
  assert.equal(evolution.ledger.getProject(projectId).current_path, 'Projects/Atlas-New');
});

test('Evolution rejects path escape, nested Project targets, and symbolic-link sources', (t) => {
  const { root, stateDir, projectId } = setup('evolution-boundaries');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  assert.throws(() => evolution.prepare({
    root, operation: 'create_directory', target: '../outside',
  }), /escape|outside/i);
  assert.throws(() => evolution.prepare({
    root, operation: 'migrate_project', projectId, target: 'Projects/Atlas/nested',
  }), /inside itself|nested/i);
  const link = path.join(root, 'Projects', 'Atlas', 'link.md');
  try {
    fs.symlinkSync(path.join(root, 'Projects', 'Atlas', 'note.md'), link, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
    throw error;
  }
  assert.throws(() => evolution.prepare({
    root, operation: 'move_file', source: 'Projects/Atlas/link.md', target: 'Projects/link.md',
  }), /symbolic/i);
});

test('Project migration stops before filesystem mutation when Registry changed after approval', (t) => {
  const { root, stateDir, projectId } = setup('evolution-registry-execute-conflict');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root, operation: 'migrate_project', projectId, target: 'Projects/Atlas-New',
  });
  evolution.approve(prepared.run_id, { reason: 'Approve the original Registry state.' });
  const project = evolution.ledger.getProject(projectId);
  evolution.ledger.updateProject(projectId, {
    name: project.name,
    currentPath: 'Projects/Registry-Changed',
    aliases: [],
    status: project.status,
    reason: 'Simulate a later legitimate Registry edit.',
    updatedAt: new Date().toISOString(),
  });
  assert.throws(() => evolution.execute(prepared.run_id), /Registry changed/i);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas', 'note.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas-New')), false);
});

test('Project rollback stops before filesystem mutation when Registry changed after execution', (t) => {
  const { root, stateDir, projectId } = setup('evolution-registry-rollback-conflict');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root, operation: 'migrate_project', projectId, target: 'Projects/Atlas-New',
  });
  evolution.approve(prepared.run_id, { reason: 'Migrate the Project.' });
  evolution.execute(prepared.run_id);
  const project = evolution.ledger.getProject(projectId);
  evolution.ledger.updateProject(projectId, {
    name: project.name,
    currentPath: 'Projects/Registry-Changed',
    aliases: [],
    status: project.status,
    reason: 'Simulate a later legitimate Registry edit.',
    updatedAt: new Date().toISOString(),
  });
  assert.throws(() => evolution.rollback(prepared.run_id), /Registry changed/i);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas')), false);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas-New', 'note.md')), true);
});

test('Evolution rejects Windows reserved targets before creating a run', (t) => {
  const { root, stateDir } = setup('evolution-windows-paths');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  assert.throws(() => evolution.prepare({
    root, operation: 'create_directory', target: 'Projects/Atlas/CON',
  }), /reserved|Windows|portable/i);
  assert.throws(() => evolution.prepare({
    root, operation: 'create_directory', target: 'Projects/Atlas/trailing.',
  }), /trailing|Windows|portable/i);
});

test('Evolution rejects a source or target that traverses an in-root junction', (t) => {
  const { root, stateDir } = setup('evolution-junction-ancestor');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const actual = path.join(root, 'Projects', 'Atlas', 'actual');
  const nested = path.join(actual, 'nested');
  const junction = path.join(root, 'Projects', 'Atlas', 'junction');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'source.md'), 'source\n', 'utf8');
  try {
    fs.symlinkSync(actual, junction, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => evolution.prepare({
    root,
    operation: 'move_file',
    source: 'Projects/Atlas/junction/nested/source.md',
    target: 'Projects/Atlas/moved.md',
  }), /symbolic|junction/i);
  assert.throws(() => evolution.prepare({
    root,
    operation: 'create_directory',
    target: 'Projects/Atlas/junction/nested/new-directory',
  }), /symbolic|junction/i);
});

test('Project migration and rollback resume after filesystem mutation but before Registry finalization', (t) => {
  const { root, stateDir, projectId } = setup('evolution-project-resume');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root, operation: 'migrate_project', projectId, target: 'Projects/Atlas-New',
  });
  evolution.approve(prepared.run_id, { reason: 'Migrate with simulated interruption.' });

  evolution.ledger.startEvolutionExecution(prepared.run_id, new Date().toISOString());
  fs.renameSync(
    path.join(root, 'Projects', 'Atlas'),
    path.join(root, 'Projects', 'Atlas-New'),
  );
  const executed = evolution.execute(prepared.run_id);
  assert.equal(executed.status, 'executed');
  assert.equal(evolution.ledger.getProject(projectId).current_path, 'Projects/Atlas-New');

  evolution.ledger.recordEvent(prepared.run_id, 'evolution_rollback_started', {
    source: 'Projects/Atlas', target: 'Projects/Atlas-New',
  });
  fs.renameSync(
    path.join(root, 'Projects', 'Atlas-New'),
    path.join(root, 'Projects', 'Atlas'),
  );
  const rolledBack = evolution.rollback(prepared.run_id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(evolution.ledger.getProject(projectId).current_path, 'Projects/Atlas');
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas', 'note.md')), true);
});
