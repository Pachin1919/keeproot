import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { RoundRecovery } from '../src/round-recovery.js';
import { createResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';

const caller = (id) => ({ actor: 'agent', tool: 'test', client_run_id: id });
const at = () => new Date().toISOString();
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t, id) {
  const tempRoot = path.resolve('test', '.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, `atlas-round-work-${id}-`));
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'Project A');
  const foreignRoot = path.join(workspace, 'Project B');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(foreignRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'rows.csv'), 'name,value\nA,1\n');
  fs.writeFileSync(path.join(projectRoot, 'second.csv'), 'name,value\nB,2\n');
  fs.writeFileSync(path.join(foreignRoot, 'foreign.csv'), 'name,value\nF,9\n');
  const stateDir = path.join(root, 'state');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Project A', currentPath: 'Project A' });
  const foreignProject = registry.create({ name: 'Project B', currentPath: 'Project B' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Project A', reason: 'Round recovery Work fixture.' });
  registry.attachRoot(foreignProject.project_id, { rootId: adopted.root_id, relativePath: 'Project B', reason: 'Round recovery cross-Project fixture.' });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const recovery = new RoundRecovery({ stateDir, registry });
  const extras = [];
  t.after(() => {
    for (const dispose of extras.splice(0)) dispose();
    recovery.dispose();
    resourceControl.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, stateDir, projectRoot, foreignRoot, registry, project, foreignProject, resourceControl, recovery, deferCleanup: (dispose) => extras.push(dispose) };
}

function work(f, projectId, resourceIds, id, returnState = { step: 'source' }) {
  return f.registry.ledger.workSessions.create({ projectId, resourceIds, intent: 'Review source freshness', returnState, caller: caller(id), at: at() });
}

function actions(f, resourceId) {
  return f.registry.ledger.resources.listActions(resourceId);
}

test('protect refuses a Save target while its reservation has no resolved target path yet', (t) => {
  const f = fixture(t, 'save-reservation');
  const candidate = path.join(f.root, 'candidate.txt');
  fs.writeFileSync(candidate, 'pending Save');
  let checked = false;
  const save = new SaveService({ stateDir: f.stateDir, resourceControl: f.resourceControl,
    writeJournalFn: (stateDir, items) => {
      const journal = path.join(stateDir, 'ui', 'saved-work.json');
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      fs.writeFileSync(journal, JSON.stringify({ items }));
      if (!checked && items[0]?.status === 'reserving') {
        checked = true;
        assert.equal(items[0].target.path, null);
        throw new Error('simulated stop after Save reservation');
      }
    },
  });
  try {
    assert.throws(() => save.prepare({ root: f.workspace, candidateFile: candidate, projectId: f.project.project_id,
      target: 'Project A/pending.txt', origin: 'agent_generated', kind: 'intermediate',
      channel: 'host', requestKey: 'pending-save', caller: caller('save-reservation') }), /simulated stop/u);
    assert.equal(checked, true);
    assert.throws(() => f.recovery.protect({ projectId: f.project.project_id, paths: ['pending.txt'],
      label: 'Must refuse in-flight Save', requestKey: 'save-reservation', caller: caller('save-reservation') }), /Save dependency/u);
    assert.equal(f.recovery.list({ projectId: f.project.project_id }).length, 0);
  } finally { save.dispose(); }
});

test('round recovery restores selected Resource baseline and Work recipe/mapping, then returns latest', (t) => {
  const f = fixture(t, 'resource-work-round');
  const projectId = f.project.project_id;
  const file = path.join(f.projectRoot, 'rows.csv');
  const resource = f.resourceControl.identify({ filePath: file, project: { id: projectId } });
  let selectedWork = work(f, projectId, [resource.resource_id], 'resource-work-round');
  selectedWork = f.registry.ledger.workSessions.setMapping(selectedWork.session_id, [{ source_key: selectedWork.sources[0].source_key, column: 'name', canonical: 'label', source_sha256: resource.evidence.sha256 }], at(), selectedWork.revision);
  selectedWork = f.registry.ledger.workSessions.setRecipe(selectedWork.session_id, { schema: 'atlas.table-recipe.v1', version: 2, combine: { operation: 'concatenate' }, steps: [{ operation: 'validate' }, { operation: 'filter', column: 'value' }] }, at(), selectedWork.revision);
  selectedWork = f.registry.ledger.workSessions.setPreview(selectedWork.session_id, { columns: ['label'], rows: [['A']] }, selectedWork.revision, at());
  const initialRecipe = selectedWork.recipe;
  const initialMapping = selectedWork.mapping;
  const initialBytes = fs.readFileSync(file);
  const initialHash = sha256(initialBytes);
  const start = f.recovery.protect({ projectId: projectId, paths: ['rows.csv'], resourceIds: [resource.resource_id], workIds: [selectedWork.session_id], boardIds: [], label: 'Resource and Work baseline', requestKey: 'resource-work-protect', caller: caller('resource-work-round') });
  fs.writeFileSync(file, 'name,value\nA,7\nB,8\n');
  const changed = fs.readFileSync(file);
  const accepted = f.resourceControl.acceptCurrentVersion({ projectId, resourceId: resource.resource_id, expectedCurrentVersion: sha256(changed), caller: caller('resource-accept') });
  let latestWork = f.registry.ledger.workSessions.setMapping(selectedWork.session_id, [{ source_key: selectedWork.sources[0].source_key, column: 'name', canonical: 'name', source_sha256: accepted.content_hash }], at(), selectedWork.revision);
  latestWork = f.registry.ledger.workSessions.setRecipe(latestWork.session_id, { schema: 'atlas.table-recipe.v1', version: 3, combine: { operation: 'concatenate' }, steps: [{ operation: 'validate' }, { operation: 'sort', column: 'value' }] }, at(), latestWork.revision);
  latestWork = f.registry.ledger.workSessions.setPreview(latestWork.session_id, { columns: ['name'], rows: [['B']] }, latestWork.revision, at());
  const beforeCheckpoint = f.recovery.show({ projectId, roundId: start.round_id });
  const checkpoint = f.recovery.checkpoint({ projectId, roundId: start.round_id, baseRevision: beforeCheckpoint.revision, expectedDigest: beforeCheckpoint.current_digest, label: 'Accepted changed Source and Work', requestKey: 'resource-work-checkpoint', caller: caller('resource-work-round') });
  const beforeRestore = f.recovery.show({ projectId, roundId: start.round_id });
  const restored = f.recovery.restore({ projectId, roundId: start.round_id, nodeId: start.head_node_id, baseRevision: beforeRestore.revision, expectedDigest: beforeRestore.current_digest, requestKey: 'resource-work-restore', caller: caller('resource-work-round') });
  assert.deepEqual(fs.readFileSync(file), initialBytes);
  const restoredResource = f.resourceControl.projectResource(projectId, resource.resource_id, { refresh: true });
  assert.equal(restoredResource.content_hash, initialHash);
  const restoredWork = f.registry.ledger.workSessions.byId(selectedWork.session_id);
  assert.deepEqual(restoredWork.recipe, initialRecipe);
  assert.deepEqual(restoredWork.mapping, initialMapping);
  assert.equal(restoredWork.preview, null);
  assert.equal(restoredWork.preview_revision, null);
  assert.ok(restored.revision > checkpoint.revision);
  assert.ok(actions(f, resource.resource_id).some((item) => item.action_type === 'accept_current_version'));
  assert.ok(actions(f, resource.resource_id).some((item) => item.action_type === 'round_restore'));
  const afterRestore = f.recovery.show({ projectId, roundId: start.round_id });
  const returned = f.recovery.returnToLatest({ projectId, roundId: start.round_id, restoreId: restored.restore_id, baseRevision: afterRestore.revision, expectedDigest: afterRestore.current_digest, requestKey: 'resource-work-return', caller: caller('resource-work-round') });
  assert.deepEqual(fs.readFileSync(file), changed);
  assert.equal(f.resourceControl.projectResource(projectId, resource.resource_id, { refresh: true }).content_hash, sha256(changed));
  assert.equal(f.registry.ledger.workSessions.byId(selectedWork.session_id).recipe.version, 3);
  assert.equal(f.registry.ledger.workSessions.byId(selectedWork.session_id).preview, null);
  assert.ok(returned.revision > restored.revision);
});

test('protect rejects omitted Resource and Work Source scope', (t) => {
  const f = fixture(t, 'scope');
  const projectId = f.project.project_id;
  const file = path.join(f.projectRoot, 'rows.csv');
  const resource = f.resourceControl.identify({ filePath: file, project: { id: projectId } });
  const selectedWork = work(f, projectId, [resource.resource_id], 'scope');
  assert.throws(() => f.recovery.protect({ projectId, paths: ['rows.csv'], resourceIds: [], workIds: [], boardIds: [], label: 'missing Resource scope', requestKey: 'scope-resource', caller: caller('scope') }));
  assert.throws(() => f.recovery.protect({ projectId, paths: [], resourceIds: [], workIds: [selectedWork.session_id], boardIds: [], label: 'missing Source scope', requestKey: 'scope-work', caller: caller('scope') }));
});

test('restore is blocked by a later unselected Work consumer without file writes', (t) => {
  const f = fixture(t, 'later-consumer');
  const projectId = f.project.project_id;
  const file = path.join(f.projectRoot, 'rows.csv');
  const resource = f.resourceControl.identify({ filePath: file, project: { id: projectId } });
  const start = f.recovery.protect({ projectId, paths: ['rows.csv'], resourceIds: [resource.resource_id], workIds: [], boardIds: [], label: 'Resource only', requestKey: 'consumer-protect', caller: caller('later-consumer') });
  fs.writeFileSync(file, 'name,value\nA,99\n');
  const current = f.recovery.show({ projectId, roundId: start.round_id });
  work(f, projectId, [resource.resource_id], 'later-consumer-work');
  assert.throws(() => f.recovery.restore({ projectId, roundId: start.round_id, nodeId: start.head_node_id, baseRevision: current.revision, expectedDigest: current.current_digest, requestKey: 'consumer-restore', caller: caller('later-consumer') }), /Work|consumer|dependency/u);
  assert.deepEqual(fs.readFileSync(file), Buffer.from('name,value\nA,99\n'));
  assert.equal(f.recovery.list({ projectId }).find((item) => item.round_id === start.round_id).revision, start.revision);
});

test('interrupted restore blocks Work and Resource writes, then resume completes the selected set', (t) => {
  const f = fixture(t, 'interruption');
  const projectId = f.project.project_id;
  const first = f.resourceControl.identify({ filePath: path.join(f.projectRoot, 'rows.csv'), project: { id: projectId } });
  const second = f.resourceControl.identify({ filePath: path.join(f.projectRoot, 'second.csv'), project: { id: projectId } });
  const selectedWork = work(f, projectId, [first.resource_id], 'interruption');
  const start = f.recovery.protect({ projectId, paths: ['rows.csv', 'second.csv'], resourceIds: [first.resource_id, second.resource_id], workIds: [selectedWork.session_id], boardIds: [], label: 'Two file recovery', requestKey: 'interrupt-protect', caller: caller('interruption') });
  fs.writeFileSync(path.join(f.projectRoot, 'rows.csv'), 'name,value\nA,10\n');
  fs.writeFileSync(path.join(f.projectRoot, 'second.csv'), 'name,value\nB,20\n');
  const current = f.recovery.show({ projectId, roundId: start.round_id });
  const originalRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => {
    const from = String(args[0]); const to = String(args[1]);
    if (from.includes('.atlas-restore-') && to.endsWith(`${path.sep}second.csv`)) { calls += 1; throw new Error('simulated second-file rename failure'); }
    return originalRename(...args);
  };
  try {
    assert.throws(() => f.recovery.restore({ projectId, roundId: start.round_id, nodeId: start.head_node_id, baseRevision: current.revision, expectedDigest: current.current_digest, requestKey: 'interrupt-restore', caller: caller('interruption') }), /simulated second-file rename failure/u);
  } finally { fs.renameSync = originalRename; }
  const pending = f.recovery.show({ projectId, roundId: start.round_id });
  assert.ok(pending.pending_restore);
  assert.throws(() => f.registry.ledger.workSessions.setRecipe(selectedWork.session_id, { version: 99 }, at(), selectedWork.revision), /pending|recovery|incomplete/u);
  assert.throws(() => f.registry.ledger.workSessions.updateSource(selectedWork.session_id, selectedWork.sources[0].source_key, { fingerprint: { sha256: 'f'.repeat(64), file_path: path.join(f.projectRoot, 'rows.csv') }, status: 'ready' }, at()), /pending|recovery|incomplete/u);
  assert.throws(() => f.resourceControl.acceptCurrentVersion({ projectId, resourceId: first.resource_id, expectedCurrentVersion: sha256(fs.readFileSync(path.join(f.projectRoot, 'rows.csv'))), caller: caller('interruption-resource') }), /pending|recovery|incomplete/u);
  const candidate = path.join(f.root, 'pending-save-candidate.csv');
  fs.writeFileSync(candidate, 'name,value\nPending,1\n');
  const saveService = new SaveService({ stateDir: f.stateDir, resourceControl: f.resourceControl });
  f.deferCleanup(() => saveService.dispose());
  const journalPath = path.join(f.stateDir, 'ui', 'saved-work.json');
  const journalBefore = fs.existsSync(journalPath) ? fs.readFileSync(journalPath) : null;
  assert.throws(() => saveService.prepare({
    root: f.workspace, candidateFile: candidate, projectId, target: 'Project A/pending-save.csv', inputs: [path.join(f.projectRoot, 'rows.csv')],
    origin: 'agent_generated', kind: 'intermediate', channel: 'host', requestKey: 'pending-save', caller: caller('interruption-save'),
  }), /ATLAS_RECOVERY_INCOMPLETE|pending|recovery|incomplete/u);
  const journalAfter = fs.existsSync(journalPath) ? fs.readFileSync(journalPath) : null;
  assert.deepEqual(journalAfter, journalBefore);
  const resumed = f.recovery.resume({ projectId, roundId: start.round_id, restoreId: pending.pending_restore, caller: caller('interruption') });
  assert.equal(resumed.pending_restore, null);
  assert.deepEqual(fs.readFileSync(path.join(f.projectRoot, 'rows.csv')), Buffer.from('name,value\nA,1\n'));
  assert.deepEqual(fs.readFileSync(path.join(f.projectRoot, 'second.csv')), Buffer.from('name,value\nB,2\n'));
});

test('protect rejects cross-Project Resource and Work objects', (t) => {
  const f = fixture(t, 'cross-project');
  const local = f.resourceControl.identify({ filePath: path.join(f.projectRoot, 'rows.csv'), project: { id: f.project.project_id } });
  const foreign = f.resourceControl.identify({ filePath: path.join(f.foreignRoot, 'foreign.csv'), project: { id: f.foreignProject.project_id } });
  const foreignWork = work(f, f.foreignProject.project_id, [foreign.resource_id], 'foreign-work');
  const pending = f.recovery.protect({ projectId: f.project.project_id, paths: ['rows.csv'], resourceIds: [local.resource_id], workIds: [], boardIds: [], label: 'Pending local Resource', requestKey: 'foreign-pending-protect', caller: caller('cross-project') });
  fs.writeFileSync(path.join(f.projectRoot, 'rows.csv'), 'name,value\nA,77\n');
  const pendingBasis = f.recovery.show({ projectId: f.project.project_id, roundId: pending.round_id });
  const originalRename = fs.renameSync;
  fs.renameSync = (...args) => { if (String(args[0]).includes('.atlas-restore-')) throw new Error('pending local Resource'); return originalRename(...args); };
  try {
    assert.throws(() => f.recovery.restore({ projectId: f.project.project_id, roundId: pending.round_id, nodeId: pending.head_node_id, baseRevision: pendingBasis.revision, expectedDigest: pendingBasis.current_digest, requestKey: 'foreign-pending-restore', caller: caller('cross-project') }), /pending local Resource/u);
  } finally { fs.renameSync = originalRename; }
  assert.throws(() => work(f, f.foreignProject.project_id, [local.resource_id], 'foreign-pending-work'), /pending|recovery|Project/u);
  assert.throws(() => f.recovery.protect({ projectId: f.project.project_id, paths: ['rows.csv'], resourceIds: [foreign.resource_id], workIds: [], boardIds: [], label: 'foreign Resource', requestKey: 'foreign-resource', caller: caller('cross-project') }));
  assert.throws(() => f.recovery.protect({ projectId: f.project.project_id, paths: ['rows.csv'], resourceIds: [local.resource_id], workIds: [foreignWork.session_id], boardIds: [], label: 'foreign Work', requestKey: 'foreign-work', caller: caller('cross-project') }));
});

test('protect rejects Resources with Save source or output dependencies without changing the Save journal', (t) => {
  const f = fixture(t, 'save-dependency');
  const projectId = f.project.project_id;
  const sourcePath = path.join(f.projectRoot, 'rows.csv');
  const source = f.resourceControl.identify({ filePath: sourcePath, project: { id: projectId } });
  const candidate = path.join(f.root, 'candidate.csv');
  fs.writeFileSync(candidate, 'name,value\nSaved,3\n');
  const saveService = new SaveService({ stateDir: f.stateDir, resourceControl: f.resourceControl });
  f.deferCleanup(() => saveService.dispose());
  const prepared = saveService.prepare({
    root: f.workspace, candidateFile: candidate, projectId, target: 'Project A/derived.csv', inputs: [sourcePath],
    origin: 'agent_generated', kind: 'intermediate', channel: 'host', requestKey: 'save-dependency',
    caller: caller('save-dependency'), source: { path: sourcePath, resource_id: source.resource_id, sources: [{ path: sourcePath, resource_id: source.resource_id }] },
    parameters: { test: 'round-recovery-save-dependency' }, resultSummary: { rows: 1, columns: 2 }, intent: 'Create Save dependency fixture.',
  });
  const saved = saveService.execute(prepared.save_id, { reason: 'Round recovery Save dependency fixture.' });
  const output = f.resourceControl.projectResources(projectId).find((item) => item.path?.endsWith('derived.csv'));
  assert.ok(output?.resource_id ?? saved.resource_id);
  const before = saveService.show(saved.save_id);
  assert.throws(() => f.recovery.protect({ projectId, paths: ['rows.csv'], resourceIds: [source.resource_id], workIds: [], boardIds: [], label: 'Save source dependency', requestKey: 'save-source-protect', caller: caller('save-dependency') }));
  assert.throws(() => f.recovery.protect({ projectId, paths: ['derived.csv'], resourceIds: [output?.resource_id ?? saved.resource_id], workIds: [], boardIds: [], label: 'Save output dependency', requestKey: 'save-output-protect', caller: caller('save-dependency') }));
  assert.deepEqual(saveService.show(saved.save_id), before);
});
