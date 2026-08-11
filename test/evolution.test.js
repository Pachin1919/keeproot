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

test('Evolution removes one verified empty directory and recreates it on safe rollback', (t) => {
  const { root, stateDir } = setup('evolution-remove-empty-directory');
  const emptyDirectory = path.join(root, 'Legacy', 'empty');
  fs.mkdirSync(emptyDirectory, { recursive: true });
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());

  const prepared = evolution.prepare({
    root,
    operation: 'remove_empty_directory',
    source: 'Legacy/empty',
    intent: 'Remove the reviewed empty legacy directory.',
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.operation, 'remove_empty_directory');
  const preview = evolution.preview(prepared.run_id);
  assert.deepEqual(preview.plan.source_changes, [{
    path: 'Legacy/empty',
    change: 'remove_empty_directory',
  }]);
  evolution.approve(prepared.run_id, { reason: 'Remove this exact verified empty directory.' });
  const executed = evolution.execute(prepared.run_id);
  assert.equal(executed.verified, true);
  assert.equal(fs.existsSync(emptyDirectory), false);
  assert.deepEqual(evolution.execute(prepared.run_id), executed);

  const rolledBack = evolution.rollback(prepared.run_id);
  assert.equal(rolledBack.verified, true);
  assert.equal(fs.statSync(emptyDirectory).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(emptyDirectory), []);
});

test('Evolution refuses non-empty directory removal and rollback stops when the path was reclaimed', (t) => {
  const { root, stateDir } = setup('evolution-remove-empty-directory-conflict');
  const emptyDirectory = path.join(root, 'Legacy', 'empty');
  fs.mkdirSync(emptyDirectory, { recursive: true });
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());

  fs.writeFileSync(path.join(emptyDirectory, 'keep.txt'), 'keep\n', 'utf8');
  assert.throws(() => evolution.prepare({
    root,
    operation: 'remove_empty_directory',
    source: 'Legacy/empty',
  }), /must be empty/i);
  fs.rmSync(path.join(emptyDirectory, 'keep.txt'));

  const prepared = evolution.prepare({
    root,
    operation: 'remove_empty_directory',
    source: 'Legacy/empty',
  });
  evolution.approve(prepared.run_id, { reason: 'Remove the empty directory.' });
  evolution.execute(prepared.run_id);
  fs.mkdirSync(emptyDirectory);
  fs.writeFileSync(path.join(emptyDirectory, 'later.txt'), 'later\n', 'utf8');
  assert.throws(
    () => evolution.rollback(prepared.run_id),
    (error) => error.code === 'ATLAS_ROLLBACK_CONFLICT',
  );
  assert.equal(fs.readFileSync(path.join(emptyDirectory, 'later.txt'), 'utf8'), 'later\n');
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

test('Evolution copies, verifies, removes, and safely restores one directory across Roots', (t) => {
  const caseRoot = path.join(tempRoot, 'evolution-cross-root-directory');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const sourceRoot = path.join(caseRoot, 'source-root');
  const targetRoot = path.join(caseRoot, 'target-root');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(sourceRoot, 'Projects', 'Website', 'src'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'Projects', 'Website', 'README.md'), '# Website\n', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'Projects', 'Website', 'src', 'index.js'), 'export {};\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());

  const prepared = evolution.prepare({
    root: sourceRoot,
    targetRoot,
    operation: 'migrate_cross_root',
    source: 'Projects/Website',
    target: 'projects/Website',
    intent: 'Move one exact Project directory between controlled Roots.',
  });
  const preview = evolution.preview(prepared.run_id);
  assert.equal(preview.plan.source_root, path.resolve(sourceRoot));
  assert.equal(preview.plan.target_root, path.resolve(targetRoot));
  assert.equal(preview.plan.transfer_method, 'copy_verify_remove');
  assert.equal(preview.plan.source_manifest.kind, 'directory');
  evolution.approve(prepared.run_id, { reason: 'Approve this exact cross-Root migration.' });

  const executed = evolution.execute(prepared.run_id);
  assert.equal(executed.status, 'executed');
  assert.equal(executed.verified, true);
  assert.equal(executed.transfer_method, 'copy_verify_remove');
  assert.equal(fs.existsSync(path.join(sourceRoot, 'Projects', 'Website')), false);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'projects', 'Website', 'README.md'), 'utf8'), '# Website\n');
  assert.deepEqual(evolution.execute(prepared.run_id), executed);

  const rolledBack = evolution.rollback(prepared.run_id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(sourceRoot, 'Projects', 'Website', 'src', 'index.js'), 'utf8'), 'export {};\n');
  assert.equal(fs.existsSync(path.join(targetRoot, 'projects', 'Website')), false);
});

test('Evolution refuses cross-Root rollback after a legitimate target change', (t) => {
  const caseRoot = path.join(tempRoot, 'evolution-cross-root-conflict');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const sourceRoot = path.join(caseRoot, 'source-root');
  const targetRoot = path.join(caseRoot, 'target-root');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(sourceRoot, 'Incoming'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'Library'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'Incoming', 'note.md'), '# Original\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());

  const prepared = evolution.prepare({
    root: sourceRoot,
    targetRoot,
    operation: 'migrate_cross_root',
    source: 'Incoming/note.md',
    target: 'Library/note.md',
  });
  evolution.approve(prepared.run_id, { reason: 'Move the exact reviewed file.' });
  evolution.execute(prepared.run_id);
  fs.appendFileSync(path.join(targetRoot, 'Library', 'note.md'), 'Later legal change.\n', 'utf8');

  assert.throws(
    () => evolution.rollback(prepared.run_id),
    (error) => error.code === 'ATLAS_ROLLBACK_CONFLICT',
  );
  assert.equal(fs.existsSync(path.join(sourceRoot, 'Incoming', 'note.md')), false);
  assert.match(fs.readFileSync(path.join(targetRoot, 'Library', 'note.md'), 'utf8'), /Later legal change/u);
});

test('Evolution resumes a cross-Root copy after interruption before source removal', (t) => {
  const caseRoot = path.join(tempRoot, 'evolution-cross-root-resume');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const sourceRoot = path.join(caseRoot, 'source-root');
  const targetRoot = path.join(caseRoot, 'target-root');
  const source = path.join(sourceRoot, 'Project');
  const target = path.join(targetRoot, 'Projects', 'Project');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(source, 'data.txt'), 'stable\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root: sourceRoot,
    targetRoot,
    operation: 'migrate_cross_root',
    source: 'Project',
    target: 'Projects/Project',
  });
  evolution.approve(prepared.run_id, { reason: 'Approve the resumable migration.' });

  const originalRemove = fs.rmSync;
  let interrupted = false;
  fs.rmSync = function interruptSourceRemoval(candidate, options) {
    if (!interrupted && path.resolve(candidate) === path.resolve(source)) {
      interrupted = true;
      throw new Error('fixture interruption before source removal');
    }
    return originalRemove.call(fs, candidate, options);
  };
  try {
    assert.throws(() => evolution.execute(prepared.run_id), /fixture interruption/u);
  } finally {
    fs.rmSync = originalRemove;
  }
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.readFileSync(path.join(target, 'data.txt'), 'utf8'), 'stable\n');
  assert.equal(evolution.execute(prepared.run_id).status, 'executed');
  assert.equal(fs.existsSync(source), false);
});

test('Evolution stops a cross-Root migration when the target is claimed after review', (t) => {
  const caseRoot = path.join(tempRoot, 'evolution-cross-root-target-conflict');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const sourceRoot = path.join(caseRoot, 'source-root');
  const targetRoot = path.join(caseRoot, 'target-root');
  const source = path.join(sourceRoot, 'note.md');
  const target = path.join(targetRoot, 'Library', 'note.md');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(source, 'source\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root: sourceRoot,
    targetRoot,
    operation: 'migrate_cross_root',
    source: 'note.md',
    target: 'Library/note.md',
  });
  evolution.approve(prepared.run_id, { reason: 'Approve the exact target.' });
  fs.writeFileSync(target, 'claimed later\n', 'utf8');

  assert.throws(
    () => evolution.execute(prepared.run_id),
    (error) => error.code === 'ATLAS_STATE_CONFLICT',
  );
  assert.equal(fs.readFileSync(source, 'utf8'), 'source\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'claimed later\n');
});

test('Evolution blocks a cross-Root move when an ancestor control file still uses the source path', (t) => {
  const caseRoot = path.join(tempRoot, 'evolution-cross-root-control-reference');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const sourceRoot = path.join(caseRoot, 'source-root');
  const targetRoot = path.join(caseRoot, 'target-root');
  const source = path.join(sourceRoot, 'Projects', 'Website');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"website"}\n', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'AGENTS.md'), 'Use Projects/Website for website work.\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());

  const prepared = evolution.prepare({
    root: sourceRoot,
    targetRoot,
    operation: 'migrate_cross_root',
    source: 'Projects/Website',
    target: 'projects/Website',
  });
  const preview = evolution.preview(prepared.run_id);
  assert.deepEqual(preview.plan.blockers, ['external_control_file_references_source_path']);
  assert.equal(preview.plan.inspection.external_control_references.references[0].path.toLowerCase(), 'agents.md');
  assert.throws(
    () => evolution.approve(prepared.run_id, { reason: 'Do not approve stale control paths.' }),
    /unresolved blockers/u,
  );
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(path.join(targetRoot, 'projects', 'Website')), false);
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

test('Evolution inspects and migrates one governed library with control-file evidence and internal Junction rebasing', (t) => {
  const { root, stateDir } = setup('evolution-migrate-library-directory');
  const source = path.join(root, 'Libraries', 'Pachin');
  const target = path.join(root, 'Studio', 'Obsidian', 'Pachin');
  fs.mkdirSync(path.join(source, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(source, 'attachments'), { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(source, 'AGENTS.md'), '# Personal knowledge Vault\nManaged Obsidian library.\n', 'utf8');
  fs.writeFileSync(path.join(source, 'note.md'), '# Note\n', 'utf8');
  fs.writeFileSync(path.join(source, 'attachments', 'image.txt'), 'image\n', 'utf8');
  try {
    fs.symlinkSync(path.join(source, 'attachments'), path.join(source, 'attachment-link'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root,
    operation: 'migrate_directory',
    source: 'Libraries/Pachin',
    target: 'Studio/Obsidian/Pachin',
    intent: 'Move the reviewed Obsidian library into the personal Studio.',
  });
  const preview = evolution.preview(prepared.run_id);
  assert.equal(preview.plan.inspection.classification.type, 'managed_library');
  assert.ok(preview.plan.inspection.control_files.some((item) => item.path === 'AGENTS.md'
    && item.excerpt.includes('Personal knowledge Vault')));
  assert.equal(preview.plan.inspection.reparse_points.internal, 1);
  assert.equal(preview.plan.requires_approval, true);
  assert.deepEqual(preview.plan.blockers, []);

  evolution.approve(prepared.run_id, { reason: 'Approve this exact Library migration.' });
  const executed = evolution.execute(prepared.run_id);
  assert.equal(executed.operation, 'migrate_directory');
  assert.equal(executed.verified, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8').includes('Personal knowledge Vault'), true);
  assert.equal(path.resolve(fs.readlinkSync(path.join(target, 'attachment-link'))), path.join(target, 'attachments'));

  const rolledBack = evolution.rollback(prepared.run_id);
  assert.equal(rolledBack.verified, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(source, 'note.md'), 'utf8'), '# Note\n');
  assert.equal(path.resolve(fs.readlinkSync(path.join(source, 'attachment-link'))), path.join(source, 'attachments'));
});

test('Evolution blocks a library move when a nested package cache contains a stale Junction', (t) => {
  const { root, stateDir } = setup('evolution-migrate-library-stale-cache');
  const source = path.join(root, 'Libraries', 'Pachin');
  const staleTarget = path.join(source, 'Projects', 'Website');
  const store = path.join(source, '.pnpm-store');
  const staleLink = path.join(store, 'v11', 'projects', 'stale-project');
  fs.mkdirSync(path.join(source, '.obsidian'), { recursive: true });
  fs.mkdirSync(staleTarget, { recursive: true });
  fs.mkdirSync(path.dirname(staleLink), { recursive: true });
  fs.mkdirSync(path.join(root, '.pnpm-store', 'v11'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Studio', 'Obsidian'), { recursive: true });
  try {
    fs.symlinkSync(staleTarget, staleLink, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  fs.rmSync(staleTarget, { recursive: true, force: true });

  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root,
    operation: 'migrate_directory',
    source: 'Libraries/Pachin',
    target: 'Studio/Obsidian/Pachin',
  });
  const preview = evolution.preview(prepared.run_id);
  assert.deepEqual(preview.plan.inspection.generated_caches, [{
    path: '.pnpm-store',
    kind: 'pnpm_store',
    root_level_alternative: '.pnpm-store',
  }]);
  assert.equal(preview.plan.inspection.reparse_points.items[0].target_exists, false);
  assert.ok(preview.plan.blockers.includes('nested_generated_cache_requires_disposition'));
  assert.ok(preview.plan.blockers.includes('stale_internal_reparse_target'));
  assert.throws(
    () => evolution.approve(prepared.run_id, { reason: 'Do not allow a stale cache to move unnoticed.' }),
    /unresolved blockers/i,
  );
});

test('Evolution reports stale absolute paths in source workspaces without reading toolchain text', (t) => {
  const { root, stateDir } = setup('evolution-reference-and-runtime-inspection');
  const tool = path.join(root, 'Legacy', 'tools', 'demo');
  const runtime = path.join(root, 'Legacy', 'toolchains');
  fs.mkdirSync(tool, { recursive: true });
  fs.mkdirSync(path.join(tool, 'obj'), { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.join(root, 'Studio', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Studio', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(tool, 'README.md'), '# Demo\nOld workspace: F:\\MissingWorkspace\\tools\\demo\n', 'utf8');
  fs.writeFileSync(path.join(tool, 'obj', 'generated.json'), '{"path":"F:\\\\GeneratedCache"}\n', 'utf8');
  fs.writeFileSync(path.join(runtime, 'README.md'), 'Runtime docs mention F:\\MissingSdk\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());

  const toolRun = evolution.prepare({
    root,
    operation: 'migrate_directory',
    source: 'Legacy/tools/demo',
    target: 'Studio/tools/demo',
  });
  const toolPreview = evolution.preview(toolRun.run_id);
  assert.equal(toolPreview.plan.inspection.classification.type, 'tool_source_collection');
  assert.ok(toolPreview.plan.inspection.path_references.some((item) => (
    item.reference === 'F:\\MissingWorkspace\\tools\\demo' && item.exists === false
  )));
  assert.ok(toolPreview.plan.warnings.includes('stale_absolute_path_reference'));
  assert.ok(!toolPreview.plan.inspection.path_references.some((item) => item.path.startsWith('obj/')));

  const runtimeRun = evolution.prepare({
    root,
    operation: 'migrate_directory',
    source: 'Legacy/toolchains',
    target: 'Studio/runtime/toolchains',
  });
  const runtimePreview = evolution.preview(runtimeRun.run_id);
  assert.equal(runtimePreview.plan.inspection.classification.type, 'tool_runtime');
  assert.equal(runtimePreview.plan.inspection.content_files_read, 0);
  assert.deepEqual(runtimePreview.plan.inspection.path_references, []);
});

test('Evolution recognizes FFmpeg as a tool runtime and ignores bundled HTML path examples', (t) => {
  const { root, stateDir } = setup('evolution-ffmpeg-runtime-inspection');
  const ffmpeg = path.join(root, 'Legacy', 'ffmpeg');
  fs.mkdirSync(path.join(ffmpeg, 'doc'), { recursive: true });
  fs.mkdirSync(path.join(ffmpeg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Studio', 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(ffmpeg, 'doc', 'faq.html'),
    '<code>C:\\path to your file\\input.mp4</code>\n',
    'utf8',
  );
  fs.writeFileSync(path.join(ffmpeg, 'bin', 'ffmpeg.exe'), 'fixture', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());

  const prepared = evolution.prepare({
    root,
    operation: 'migrate_directory',
    source: 'Legacy/ffmpeg',
    target: 'Studio/runtime/ffmpeg',
  });
  const preview = evolution.preview(prepared.run_id);

  assert.equal(preview.plan.inspection.classification.type, 'tool_runtime');
  assert.deepEqual(preview.plan.warnings, []);
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

test('Evolution organization plan creates a missing area and moves a file with one immutable approval', (t) => {
  const { root, stateDir } = setup('evolution-organization-plan');
  const sourceDir = path.join(root, 'Projects', 'Website', 'Source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'demo.html'), '<main>demo</main>\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());

  const prepared = evolution.preparePlan({
    root,
    intent: 'Separate Website demos from production source.',
    operations: [
      { operation: 'create_directory', target: 'Projects/Website/Demos' },
      {
        operation: 'move_file',
        source: 'Projects/Website/Source/demo.html',
        target: 'Projects/Website/Demos/demo.html',
      },
    ],
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.operations.length, 2);
  const preview = evolution.previewPlan(prepared.run_id);
  assert.equal(preview.plan_hash, prepared.plan_hash);
  assert.equal(preview.user_decisions_required, 1);

  const approved = evolution.approvePlan(prepared.run_id, { reason: 'Use the reviewed Demo separation plan.' });
  assert.equal(approved.status, 'approved');
  const executed = evolution.executePlan(prepared.run_id);
  assert.equal(executed.status, 'executed');
  assert.equal(executed.completed_operations, 2);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Website', 'Source', 'demo.html')), false);
  assert.equal(fs.readFileSync(path.join(root, 'Projects', 'Website', 'Demos', 'demo.html'), 'utf8'), '<main>demo</main>\n');

  const rolledBack = evolution.rollbackPlan(prepared.run_id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(sourceDir, 'demo.html'), 'utf8'), '<main>demo</main>\n');
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Website', 'Demos')), false);
});

test('Evolution organization plan migrates reviewed directories with one approval and safe rollback', (t) => {
  const { root, stateDir } = setup('evolution-organization-directory-plan');
  const source = path.join(root, 'Legacy', 'tools');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(root, 'Studio', 'tools'), { recursive: true });
  fs.writeFileSync(path.join(source, 'README.md'), '# Local tools\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());

  const prepared = evolution.preparePlan({
    root,
    intent: 'Move the reviewed local tool collection into Studio.',
    operations: [{
      operation: 'migrate_directory',
      source: 'Legacy/tools',
      target: 'Studio/tools/local-tools',
    }],
  });
  const preview = evolution.previewPlan(prepared.run_id);
  assert.equal(preview.operations[0].operation, 'migrate_directory');
  assert.equal(preview.operations[0].inspection.classification.type, 'tool_source_collection');
  assert.deepEqual(preview.operations[0].blockers, []);

  evolution.approvePlan(prepared.run_id, { reason: 'Approve this exact directory migration.' });
  const executed = evolution.executePlan(prepared.run_id);
  assert.equal(executed.user_decisions, 1);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(root, 'Studio', 'tools', 'local-tools', 'README.md'), 'utf8'), '# Local tools\n');

  evolution.rollbackPlan(prepared.run_id);
  assert.equal(fs.readFileSync(path.join(source, 'README.md'), 'utf8'), '# Local tools\n');
  assert.equal(fs.existsSync(path.join(root, 'Studio', 'tools', 'local-tools')), false);
});

test('Evolution organization plan preflights every pending operation before its first source write', (t) => {
  const { root, stateDir } = setup('evolution-organization-plan-conflict');
  const sourceDir = path.join(root, 'Projects', 'Website', 'Source');
  fs.mkdirSync(sourceDir, { recursive: true });
  const source = path.join(sourceDir, 'demo.html');
  fs.writeFileSync(source, '<main>baseline</main>\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.preparePlan({
    root,
    operations: [
      { operation: 'create_directory', target: 'Projects/Website/Demos' },
      { operation: 'move_file', source: 'Projects/Website/Source/demo.html', target: 'Projects/Website/Demos/demo.html' },
    ],
  });
  evolution.approvePlan(prepared.run_id, { reason: 'Approve the exact two-step plan.' });
  fs.writeFileSync(source, '<main>later change</main>\n', 'utf8');

  assert.throws(() => evolution.executePlan(prepared.run_id), /source.*changed|plan.*stale/i);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Website', 'Demos')), false);
  assert.equal(fs.readFileSync(source, 'utf8'), '<main>later change</main>\n');
  assert.equal(evolution.previewPlan(prepared.run_id).status, 'stale');
});

test('Evolution organization plan can be explicitly rejected without source changes', (t) => {
  const { root, stateDir } = setup('evolution-organization-plan-reject');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.preparePlan({
    root,
    operations: [{ operation: 'create_directory', target: 'Projects/Rejected' }],
  });

  const rejected = evolution.rejectPlan(prepared.run_id, { reason: 'Inspection rules changed; rebuild the plan.' });

  assert.equal(rejected.status, 'rejected');
  assert.equal(evolution.previewPlan(prepared.run_id).approval.value, 'rejected');
  assert.throws(() => evolution.executePlan(prepared.run_id), /approval|rejected/i);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Rejected')), false);
});

test('Evolution explicitly rejects non-NFC, overlong, and case-only Windows paths before creating a run', (t) => {
  const { root, stateDir } = setup('evolution-portable-path-qualification');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const decomposed = `Projects/Atlas/Cafe\u0301`;
  assert.throws(() => evolution.prepare({
    root, operation: 'create_directory', target: decomposed,
  }), /NFC|normalization/i);
  assert.throws(() => evolution.prepare({
    root, operation: 'create_directory', target: `Projects/Atlas/${'long-'.repeat(50)}`,
  }), /path limit|exceeds|long/i);

  const source = path.join(root, 'Projects', 'Atlas', 'Case.md');
  fs.writeFileSync(source, 'case\n', 'utf8');
  assert.throws(() => evolution.prepare({
    root, operation: 'move_file', source: 'Projects/Atlas/Case.md', target: 'Projects/Atlas/case.md',
  }), /case-only|identical|already claimed/i);
  assert.equal(evolution.ledger.listRuns().filter((run) => run.mode === 'evolution').length, 0);
});

test('Evolution permission failure leaves source intact and can resume the exact approved plan', (t) => {
  const { root, stateDir } = setup('evolution-permission-resume');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.prepare({
    root,
    operation: 'move_file',
    source: 'Projects/Atlas/note.md',
    target: 'Projects/Atlas/moved.md',
  });
  evolution.approve(prepared.run_id, { reason: 'Approve exact move before permission fault.' });
  const originalRename = fs.renameSync;
  fs.renameSync = function denyFirstRename() {
    const error = new Error('fixture permission denied');
    error.code = 'EACCES';
    throw error;
  };
  try {
    assert.throws(() => evolution.execute(prepared.run_id), /permission|EACCES/i);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas', 'note.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas', 'moved.md')), false);
  assert.equal(evolution.execute(prepared.run_id).status, 'executed');
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Atlas', 'moved.md')), true);
});

test('multi-step organization plan resumes after one child completed and the next child was interrupted', (t) => {
  const { root, stateDir } = setup('evolution-plan-partial-resume');
  const sourceDir = path.join(root, 'Projects', 'Website', 'Source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'demo.html'), '<main>demo</main>\n', 'utf8');
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.preparePlan({
    root,
    operations: [
      { operation: 'create_directory', target: 'Projects/Website/Demos' },
      { operation: 'move_file', source: 'Projects/Website/Source/demo.html', target: 'Projects/Website/Demos/demo.html' },
    ],
  });
  evolution.approvePlan(prepared.run_id, { reason: 'Approve one immutable two-step plan.' });
  const originalExecute = evolution.execute.bind(evolution);
  let calls = 0;
  evolution.execute = (runId) => {
    calls += 1;
    if (calls === 2) throw new Error('fixture crash before second child filesystem write');
    return originalExecute(runId);
  };
  assert.throws(() => evolution.executePlan(prepared.run_id), /fixture crash/i);
  evolution.execute = originalExecute;
  const interrupted = evolution.previewPlan(prepared.run_id);
  assert.equal(interrupted.status, 'partially_executed');
  assert.equal(interrupted.items[0].status, 'executed');
  assert.equal(interrupted.items[1].status, 'prepared');
  assert.equal(evolution.executePlan(prepared.run_id).status, 'executed');
  assert.equal(fs.readFileSync(path.join(root, 'Projects', 'Website', 'Demos', 'demo.html'), 'utf8'), '<main>demo</main>\n');
  assert.equal(evolution.rollbackPlan(prepared.run_id).status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'Website', 'Demos')), false);
});

test('Employment to Employment and Life keeps stable Project identity, alias, path history, and a readable migration plan', (t) => {
  const { root, stateDir, projectId } = setup('evolution-employment-life-scenario');
  const registry = new Registry({ stateDir });
  registry.update(projectId, {
    name: 'Employment and Life',
    aliases: ['Atlas', 'Employment'],
    reason: 'The life area expanded after employment changed.',
  });
  registry.dispose();
  const evolution = new Evolution({ stateDir });
  t.after(() => evolution.dispose());
  const prepared = evolution.preparePlan({
    root,
    intent: 'Rename the durable area without losing its digital lineage.',
    operations: [{
      operation: 'migrate_project',
      projectId,
      target: 'Projects/Employment and Life',
    }],
  });
  const preview = evolution.previewPlan(prepared.run_id);
  assert.equal(preview.operations[0].project_id, projectId);
  assert.equal(preview.operations[0].source, 'Projects/Atlas');
  assert.equal(preview.operations[0].target, 'Projects/Employment and Life');
  assert.equal(preview.user_decisions_required, 1);
  evolution.approvePlan(prepared.run_id, { reason: 'Approve the exact identity-preserving migration.' });
  evolution.executePlan(prepared.run_id);
  const project = evolution.ledger.getProjectDetail(projectId);
  assert.equal(project.project.id, projectId);
  assert.equal(project.project.name, 'Employment and Life');
  assert.equal(project.project.current_path, 'Projects/Employment and Life');
  assert.ok(project.aliases.includes('Employment'));
  assert.ok(project.paths.some((item) => item.path === 'Projects/Atlas' && item.valid_to));
  evolution.rollbackPlan(prepared.run_id);
  assert.equal(evolution.ledger.getProject(projectId).current_path, 'Projects/Atlas');
});
