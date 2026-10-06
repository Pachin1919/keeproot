import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createResourceControl } from '../src/resource-control.js';
import { Registry } from '../src/registry.js';

test('same-Project relink previews and confirms only the identical missing Resource bytes', (t) => {
  const base = path.resolve('test/.tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'resource-relink-project-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A');
  const otherRoot = path.join(workspace, 'B');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(otherRoot, { recursive: true });
  const foreignPath = path.join(otherRoot, 'foreign.md');
  fs.writeFileSync(foreignPath, 'same original bytes\n');
  const oldPath = path.join(projectRoot, 'old.md');
  const candidatePath = path.join(projectRoot, 'restored', 'same.md');
  const bytes = Buffer.from('same original bytes\n');
  fs.writeFileSync(oldPath, bytes);
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Relink fixture.' });
  const other = registry.create({ name: 'B', currentPath: 'B' });
  registry.attachRoot(other.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'Relink boundary fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  t.after(() => {
    control.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const original = control.identify({ filePath: oldPath, project: { id: project.project_id } });
  fs.rmSync(oldPath);
  assert.equal(control.projectResource(project.project_id, original.resource_id, { refresh: true }).status, 'missing');
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes);

  const preview = control.previewProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: candidatePath });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.project_id, project.project_id);
  assert.equal(preview.resource_id, original.resource_id);
  assert.equal(preview.old_location.status, 'missing');
  assert.equal(preview.old_sha256, original.evidence.sha256);
  assert.equal(preview.candidate_path, path.resolve(candidatePath));
  assert.equal(preview.candidate_sha256, original.evidence.sha256);
  assert.equal(preview.file_verification, 'not_checked');
  assert.equal(preview.writes_files, false);
  assert.equal(control.describe(original.resource_id).actions.some((item) => item.action_type === 'relink'), false);
  assert.throws(() => control.previewProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: foreignPath }), /outside this Project/u);
  const changedPath = path.join(projectRoot, 'changed.md');
  fs.writeFileSync(changedPath, 'different bytes');
  assert.throws(() => control.previewProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: changedPath }), /match|version/u);
  assert.throws(() => control.previewProjectRelink({ projectId: other.project_id, resourceId: original.resource_id, filePath: candidatePath }), /Project|Resource|location/u);
  fs.writeFileSync(oldPath, bytes);
  assert.throws(() => control.confirmProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: candidatePath, previewDigest: preview.preview_digest, requestKey: 'same-bytes-relocation', caller: { tool: 'test', client_run_id: 'relink-project' } }), /reappeared|stale/u);
  fs.rmSync(oldPath);
  fs.writeFileSync(candidatePath, 'changed after preview');
  assert.throws(() => control.confirmProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: candidatePath, previewDigest: preview.preview_digest, requestKey: 'same-bytes-relocation', caller: { tool: 'test', client_run_id: 'relink-project' } }), /match|changed|stale/u);
  fs.writeFileSync(candidatePath, bytes);
  const freshPreview = control.previewProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: candidatePath });

  const confirmed = control.confirmProjectRelink({
    projectId: project.project_id,
    resourceId: original.resource_id,
    filePath: candidatePath,
    previewDigest: freshPreview.preview_digest,
    requestKey: 'same-bytes-relocation',
    caller: { tool: 'test', client_run_id: 'relink-project' },
  });
  assert.equal(confirmed.resource_id, original.resource_id);
  assert.equal(confirmed.location.status, 'active');
  assert.equal(confirmed.location.project_id, project.project_id);
  assert.equal(fs.readFileSync(candidatePath).compare(bytes), 0);
  const detail = control.describe(original.resource_id);
  assert.equal(detail.locations.filter((item) => item.status === 'missing').length, 1);
  assert.equal(detail.locations.filter((item) => item.status === 'active').length, 1);

  const retry = control.confirmProjectRelink({
    projectId: project.project_id,
    resourceId: original.resource_id,
    filePath: candidatePath,
    previewDigest: freshPreview.preview_digest,
    requestKey: 'same-bytes-relocation',
    caller: { tool: 'test', client_run_id: 'relink-project' },
  });
  assert.equal(retry.action.id, confirmed.action.id);
  assert.equal(control.describe(original.resource_id).actions.filter((item) => item.action_type === 'relink').length, 1);
  assert.throws(() => control.confirmProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: changedPath, previewDigest: freshPreview.preview_digest, requestKey: 'same-bytes-relocation', caller: { tool: 'test', client_run_id: 'relink-project' } }), /request key|different facts/u);
  assert.throws(() => control.previewProjectRelink({ projectId: other.project_id, resourceId: original.resource_id, filePath: candidatePath }), /Project|Resource|location/u);
});

test('registered candidate path is reported as a separate Resource identity and cannot be relinked', (t) => {
  const base = path.resolve('test/.tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'resource-relink-registered-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A');
  const otherRoot = path.join(workspace, 'B');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(otherRoot, { recursive: true });
  const oldPath = path.join(projectRoot, 'old.md');
  const candidatePath = path.join(projectRoot, 'current.md');
  const bytes = Buffer.from('same bytes, distinct identities\n');
  fs.writeFileSync(oldPath, bytes);
  fs.writeFileSync(candidatePath, bytes);
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Registered candidate fixture.' });
  const other = registry.create({ name: 'B', currentPath: 'B' });
  registry.attachRoot(other.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'Cross-Project owner fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  t.after(() => { control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  const missing = control.identify({ filePath: oldPath, project: { id: project.project_id } });
  fs.rmSync(oldPath);
  control.projectResources(project.project_id, { refresh: true });
  const current = control.observe({ filePath: candidatePath, project: { id: project.project_id } });
  assert.notEqual(current.resource_id, missing.resource_id);
  assert.equal(control.projectResource(project.project_id, missing.resource_id, { refresh: true }).status, 'missing');

  const assertConflict = (error, expectedCandidate) => {
    assert.equal(error.code, 'ATLAS_STATE_CONFLICT');
    assert.equal(error.details.reason, 'candidate_path_registered');
    assert.equal(error.details.project_id, project.project_id);
    assert.equal(error.details.missing_resource_id, missing.resource_id);
    assert.equal(error.details.old_location.status, 'missing');
    assert.equal(error.details.old_location.content_hash, missing.evidence.sha256);
    assert.equal(error.details.candidate_relative_path, expectedCandidate.relativePath);
    assert.equal(error.details.candidate_sha256, expectedCandidate.sha256);
    assert.equal(error.details.registration_status, 'active');
    assert.equal(error.details.same_bytes, true);
    assert.equal(error.details.candidate_resource_id, expectedCandidate.resourceId);
  };
  assert.throws(() => control.previewProjectRelink({ projectId: project.project_id, resourceId: missing.resource_id, filePath: candidatePath }), (error) => { assertConflict(error, { relativePath: 'current.md', sha256: current.evidence.sha256, resourceId: current.resource_id }); return true; });
  assert.equal(control.describe(missing.resource_id).actions.some((item) => item.action_type === 'relink'), false);
  assert.equal(control.describe(current.resource_id).actions.some((item) => item.action_type === 'relink'), false);
  assert.equal(fs.readFileSync(candidatePath).compare(bytes), 0);

  const latePath = path.join(projectRoot, 'later.md');
  fs.writeFileSync(latePath, bytes);
  const preview = control.previewProjectRelink({ projectId: project.project_id, resourceId: missing.resource_id, filePath: latePath });
  const later = control.observe({ filePath: latePath, project: { id: project.project_id } });
  assert.notEqual(later.resource_id, missing.resource_id);
  assert.throws(() => control.confirmProjectRelink({ projectId: project.project_id, resourceId: missing.resource_id, filePath: latePath, previewDigest: preview.preview_digest, requestKey: 'registered-after-preview', caller: { tool: 'test', client_run_id: 'registered-after-preview' } }), (error) => { assertConflict(error, { relativePath: 'later.md', sha256: later.evidence.sha256, resourceId: later.resource_id }); return true; });
  assert.equal(control.describe(missing.resource_id).actions.some((item) => item.action_type === 'relink'), false);
  assert.equal(fs.readFileSync(latePath).compare(bytes), 0);

  const foreignPath = path.join(projectRoot, 'foreign.md');
  fs.writeFileSync(foreignPath, bytes);
  const foreign = control.observe({ filePath: foreignPath, project: { id: other.project_id } });
  const requestFile = path.join(root, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify({ project_id: project.project_id, resource_id: missing.resource_id, file_path: foreignPath }));
  const cli = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'resource', 'relink', 'preview', '--request-file', requestFile, '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: stateDir }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(cli.status, 1, cli.stderr);
  const envelope = JSON.parse(cli.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'ATLAS_STATE_CONFLICT');
  assert.equal(envelope.error.details.reason, 'candidate_path_registered');
  assert.equal(envelope.error.details.registration_status, 'active');
  assert.equal(envelope.error.details.same_bytes, true);
  assert.equal(Object.hasOwn(envelope.error.details, 'candidate_resource_id'), false);
  assert.notEqual(foreign.resource_id, missing.resource_id);
});

test('same-Project relink accepts a vanished old parent directory without losing Resource identity', (t) => {
  const base = path.resolve('test/.tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'resource-relink-vanished-parent-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A');
  const oldParent = path.join(projectRoot, 'old-folder');
  const oldPath = path.join(oldParent, 'old.md');
  const candidatePath = path.join(projectRoot, 'current.md');
  fs.mkdirSync(oldParent, { recursive: true });
  fs.writeFileSync(oldPath, 'same bytes after folder removal');
  fs.writeFileSync(candidatePath, 'same bytes after folder removal');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Vanished old parent fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  t.after(() => { control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const original = control.identify({ filePath: oldPath, project: { id: project.project_id } });
  fs.rmSync(oldPath);
  fs.rmdirSync(oldParent);
  assert.equal(control.projectResource(project.project_id, original.resource_id, { refresh: true }).status, 'missing');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, oldParent, 'junction');
  assert.throws(() => control.previewProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: candidatePath }), /linked paths|symbolic link|junction/u);
  fs.unlinkSync(oldParent);
  const preview = control.previewProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: candidatePath });
  assert.equal(preview.candidate_sha256, original.evidence.sha256);
  fs.symlinkSync(outside, oldParent, 'junction');
  assert.throws(() => control.confirmProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: candidatePath, previewDigest: preview.preview_digest, requestKey: 'vanished-old-parent', caller: { tool: 'test', client_run_id: 'vanished-old-parent' } }), /linked paths|symbolic link|junction/u);
  fs.unlinkSync(oldParent);
  const confirmed = control.confirmProjectRelink({ projectId: project.project_id, resourceId: original.resource_id, filePath: candidatePath, previewDigest: preview.preview_digest, requestKey: 'vanished-old-parent', caller: { tool: 'test', client_run_id: 'vanished-old-parent' } });
  assert.equal(confirmed.resource_id, original.resource_id);
  assert.equal(control.projectResource(project.project_id, original.resource_id, { refresh: true }).path, candidatePath);
  assert.equal(fs.existsSync(oldParent), false);
});

test('Host resource relink preview and confirm use the same ID and digest boundary', (t) => {
  const base = path.resolve('test/.tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'resource-relink-host-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A');
  fs.mkdirSync(projectRoot, { recursive: true });
  const oldPath = path.join(projectRoot, 'old.md');
  const candidatePath = path.join(projectRoot, 'restored.md');
  const requestFile = path.join(root, 'request.json');
  fs.writeFileSync(oldPath, 'identical bytes');
  fs.writeFileSync(candidatePath, 'identical bytes');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Host relink fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  t.after(() => { control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const original = control.identify({ filePath: oldPath, project: { id: project.project_id } });
  fs.rmSync(oldPath);
  control.projectResources(project.project_id, { refresh: true });
  fs.writeFileSync(requestFile, JSON.stringify({ project_id: project.project_id, resource_id: original.resource_id, file_path: candidatePath }));
  const cli = (...args) => spawnSync(process.execPath, [path.resolve('bin/atlas.js'), ...args, '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: stateDir }, encoding: 'utf8', timeout: 30_000 });
  const previewResult = cli('resource', 'relink', 'preview', '--request-file', requestFile);
  assert.equal(previewResult.status, 0, previewResult.stderr);
  const preview = JSON.parse(previewResult.stdout);
  assert.equal(preview.ok, true);
  assert.equal(preview.data.resource_id, original.resource_id);
  assert.equal(preview.data.candidate_sha256, original.evidence.sha256);
  const confirm = cli('resource', 'relink', 'confirm', '--request-file', requestFile, '--preview-digest', preview.data.preview_digest, '--request-key', 'host-relink-once', '--tool', 'host-test', '--client-run-id', 'host-relink-1');
  assert.equal(confirm.status, 0, confirm.stderr);
  const receipt = JSON.parse(confirm.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.data.resource_id, original.resource_id);
  assert.equal(receipt.data.location.path, candidatePath);
  const retry = cli('resource', 'relink', 'confirm', '--request-file', requestFile, '--preview-digest', preview.data.preview_digest, '--request-key', 'host-relink-once', '--tool', 'host-test', '--client-run-id', 'host-relink-1');
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).data.action.id, receipt.data.action.id);
  const shown = cli('resource', 'show', original.resource_id, '--project', project.project_id);
  assert.equal(shown.status, 0, shown.stderr);
  const shownResource = JSON.parse(shown.stdout).data;
  assert.equal(shownResource.resource_id, original.resource_id);
  assert.equal(shownResource.status, 'active');
  assert.equal(path.resolve(shownResource.last_known_location.path), path.resolve(candidatePath));
});
