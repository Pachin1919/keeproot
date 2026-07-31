import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { TaskContract } from '../src/task-contract.js';

const tempRoot = path.resolve('test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = path.join(caseRoot, 'state');
  const sourceRoot = path.join(caseRoot, 'vault');
  const targetRoot = path.join(caseRoot, 'website');
  fs.mkdirSync(path.join(sourceRoot, 'Career'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'Site'), { recursive: true });
  const sourceFile = path.join(sourceRoot, 'Career', '方向.md');
  fs.writeFileSync(
    sourceFile,
    '# 新求职方向\n\n个人网站需要突出Atlas的数据治理和BA/DA能力。\n',
    'utf8',
  );
  const registry = new Registry({ stateDir });
  const sourceRootReceipt = registry.adoptRoot({
    rootPath: sourceRoot,
    rootType: 'managed_library',
    contentPolicy: 'bounded_content',
  });
  const targetRootReceipt = registry.adoptRoot({
    rootPath: targetRoot,
    rootType: 'project_workspace',
    contentPolicy: 'bounded_content',
  });
  const sourceProject = registry.create({ name: 'Career', currentPath: 'Career' });
  const targetProject = registry.create({ name: 'Website', currentPath: 'Site' });
  registry.attachRoot(sourceProject.project_id, {
    rootId: sourceRootReceipt.root_id,
    reason: 'Bind source Project.',
  });
  registry.attachRoot(targetProject.project_id, {
    rootId: targetRootReceipt.root_id,
    reason: 'Bind target Project.',
  });
  registry.linkContext(targetProject.project_id, {
    sourceProjectId: sourceProject.project_id,
    purpose: 'career_positioning',
    extensions: ['.md'],
    maxCandidates: 10,
    reason: 'Use career direction when updating the website.',
  });
  registry.dispose();
  return {
    caseRoot,
    stateDir,
    sourceRoot,
    targetRoot,
    sourceFile,
    sourceProjectId: sourceProject.project_id,
    targetProjectId: targetProject.project_id,
    sourceRootId: sourceRootReceipt.root_id,
    targetRootId: targetRootReceipt.root_id,
  };
}

function taskRequest(targetProjectId, target = 'Site/plan.md') {
  return {
    intent: 'Create a website direction plan from the reviewed career source.',
    project_id: targetProjectId,
    output: {
      target,
      role: 'report',
      action: 'create',
      data_class: 'generated_output',
    },
    budget: {
      max_files: 5,
      max_bytes: 1024 * 1024,
    },
  };
}

test('cross-Project discovery reports the exact setup gap before Catalog work', (t) => {
  const caseRoot = path.join(tempRoot, 'cross-project-setup-required');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = path.join(caseRoot, 'state');
  const registry = new Registry({ stateDir });
  const targetProject = registry.create({ name: 'Website', currentPath: 'Site' });
  registry.dispose();
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());

  assert.throws(
    () => task.discoverContext({
      projectId: targetProject.project_id,
      purpose: 'career_positioning',
      terms: ['portfolio'],
    }),
    (error) => {
      assert.equal(error.code, 'ATLAS_CONTEXT_SETUP_REQUIRED');
      assert.equal(error.details.schema, 'atlas-context-setup.v1');
      assert.deepEqual(
        error.details.missing,
        ['workspace_root', 'target_project_location', 'context_link'],
      );
      assert.deepEqual(
        error.details.required_actions.map((item) => item.action),
        ['root.adopt', 'project.attach-root', 'project.link-context'],
      );
      return true;
    },
  );
});

test('cross-Project Task reuses a persistent Context Link and produces recoverable lineage', (t) => {
  const fixture = setup('cross-project-task');
  const task = new TaskContract({ stateDir: fixture.stateDir });
  t.after(() => task.dispose());

  const candidates = task.discoverContext({
    projectId: fixture.targetProjectId,
    purpose: 'career_positioning',
    terms: ['个人网站', '数据治理'],
  });
  assert.equal(candidates.status, 'ready');
  assert.equal(candidates.context_links.length, 1);
  assert.equal(candidates.candidates.length, 1);
  assert.equal(candidates.candidates[0].root_id, fixture.sourceRootId);
  assert.equal(Object.hasOwn(candidates.candidates[0], 'body'), false);

  const prepared = task.prepareContext({
    candidateSetId: candidates.candidate_set_id,
    selectedEntryIds: [candidates.candidates[0].entry_id],
    request: taskRequest(fixture.targetProjectId),
    caller: {
      actor: 'agent',
      agent: 'Codex',
      model: 'gpt-5',
      tool: 'node-test',
      client_run_id: 'cross-project-task',
    },
  });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.boundaries.write_root_id, fixture.targetRootId);
  assert.deepEqual(prepared.boundaries.read_root_ids, [fixture.sourceRootId]);
  assert.equal(prepared.read.selected[0].source_project_id, fixture.sourceProjectId);
  assert.ok(prepared.source_set_id);

  const candidateFile = path.join(fixture.caseRoot, 'candidate.md');
  fs.writeFileSync(candidateFile, '# 网站方向\n\n展示Atlas的数据治理、BA与DA能力。\n', 'utf8');
  const executed = task.fulfill(prepared.task_id, {
    candidateFile,
    reason: 'The user requested this exact cross-Project content task.',
  });
  assert.equal(executed.status, 'completed');
  assert.equal(executed.verified, true);
  assert.ok(fs.existsSync(path.join(fixture.targetRoot, 'Site', 'plan.md')));

  const detail = task.show(prepared.task_id);
  assert.equal(detail.inputs[0].source_root_id, fixture.sourceRootId);
  assert.equal(detail.inputs[0].source_project_id, fixture.sourceProjectId);
  assert.equal(detail.output.lineage.length, 1);

  const rolledBack = task.rollback(prepared.task_id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(fixture.targetRoot, 'Site', 'plan.md')), false);
});

test('cross-Project Task stops when a selected source changes after prepare', (t) => {
  const fixture = setup('cross-project-task-stale');
  const task = new TaskContract({ stateDir: fixture.stateDir });
  t.after(() => task.dispose());

  const candidates = task.discoverContext({
    projectId: fixture.targetProjectId,
    purpose: 'career_positioning',
    terms: ['个人网站'],
  });
  const prepared = task.prepareContext({
    candidateSetId: candidates.candidate_set_id,
    selectedEntryIds: [candidates.candidates[0].entry_id],
    request: taskRequest(fixture.targetProjectId),
  });
  fs.appendFileSync(fixture.sourceFile, '\n后续合法修改。\n', 'utf8');
  const candidateFile = path.join(fixture.caseRoot, 'stale-candidate.md');
  fs.writeFileSync(candidateFile, '# Stale\n', 'utf8');

  assert.throws(
    () => task.fulfill(prepared.task_id, {
      candidateFile,
      reason: 'Attempt stale fulfillment.',
    }),
    /selected input|stale|changed/i,
  );
  assert.equal(fs.existsSync(path.join(fixture.targetRoot, 'Site', 'plan.md')), false);
  assert.equal(task.show(prepared.task_id).run.status, 'stale');
});

test('Candidate Set keeps its discovery snapshot and refuses a refreshed source', (t) => {
  const fixture = setup('cross-project-candidate-snapshot');
  const task = new TaskContract({ stateDir: fixture.stateDir });
  t.after(() => task.dispose());

  const discovered = task.discoverContext({
    projectId: fixture.targetProjectId,
    purpose: 'career_positioning',
    terms: ['个人网站'],
  });
  const original = discovered.candidates[0];
  fs.writeFileSync(
    fixture.sourceFile,
    '# 已变化的求职方向\n\n网站定位已经改变。\n',
    'utf8',
  );
  task.catalog.update({ projectId: fixture.sourceProjectId });

  const persisted = task.showContextCandidates(discovered.candidate_set_id);
  assert.equal(persisted.candidates[0].content_hash, original.content_hash);
  assert.equal(persisted.candidates[0].title, original.title);
  assert.equal(persisted.candidates[0].snippet, original.snippet);
  assert.throws(
    () => task.prepareContext({
      candidateSetId: discovered.candidate_set_id,
      selectedEntryIds: [original.entry_id],
      request: taskRequest(fixture.targetProjectId),
    }),
    /Candidate Set|changed|stale/i,
  );
  assert.equal(
    task.ledger.db.prepare('SELECT COUNT(*) AS count FROM source_sets').get().count,
    0,
  );
});

test('a Hash mismatch invalidates a same-size same-time Catalog entry for rediscovery', (t) => {
  const fixture = setup('cross-project-catalog-invalidation');
  const task = new TaskContract({ stateDir: fixture.stateDir });
  t.after(() => task.dispose());

  const discovered = task.discoverContext({
    projectId: fixture.targetProjectId,
    purpose: 'career_positioning',
    terms: ['个人网站'],
  });
  const original = fs.readFileSync(fixture.sourceFile, 'utf8');
  const originalStat = fs.statSync(fixture.sourceFile);
  const changed = original.replace('Atlas', 'Store');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
  fs.writeFileSync(fixture.sourceFile, changed, 'utf8');
  fs.utimesSync(fixture.sourceFile, originalStat.atime, originalStat.mtime);
  const changedStat = fs.statSync(fixture.sourceFile);
  task.ledger.db.prepare(`
    UPDATE catalog_entries SET byte_size = ?, modified_ms = ? WHERE id = ?
  `).run(
    changedStat.size,
    changedStat.mtimeMs,
    discovered.candidates[0].entry_id,
  );

  assert.throws(
    () => task.prepareContext({
      candidateSetId: discovered.candidate_set_id,
      selectedEntryIds: [discovered.candidates[0].entry_id],
      request: taskRequest(fixture.targetProjectId),
    }),
    /changed|stale/i,
  );
  const rediscovered = task.discoverContext({
    projectId: fixture.targetProjectId,
    purpose: 'career_positioning',
    terms: ['个人网站'],
  });
  assert.equal(rediscovered.catalog_generations[0].changed_files, 1);
  assert.notEqual(rediscovered.candidates[0].content_hash, discovered.candidates[0].content_hash);
});

test('a disabled Context Link makes its prior Candidate Set stale', (t) => {
  const fixture = setup('cross-project-disabled-link');
  const task = new TaskContract({ stateDir: fixture.stateDir });
  t.after(() => task.dispose());

  const discovered = task.discoverContext({
    projectId: fixture.targetProjectId,
    purpose: 'career_positioning',
    terms: ['个人网站'],
  });
  const link = task.registry.contextLinks(fixture.targetProjectId)[0];
  task.registry.disableContextLink(link.link_id, {
    reason: 'The user revoked this recurring context relationship.',
  });

  assert.throws(
    () => task.prepareContext({
      candidateSetId: discovered.candidate_set_id,
      selectedEntryIds: [discovered.candidates[0].entry_id],
      request: taskRequest(fixture.targetProjectId),
    }),
    /Context Link|stale|changed/i,
  );
  assert.equal(
    task.ledger.db.prepare('SELECT COUNT(*) AS count FROM source_sets').get().count,
    0,
  );
});

test('disabling a Context Link after prepare stops fulfillment', (t) => {
  const fixture = setup('cross-project-disabled-link-after-prepare');
  const task = new TaskContract({ stateDir: fixture.stateDir });
  t.after(() => task.dispose());

  const discovered = task.discoverContext({
    projectId: fixture.targetProjectId,
    purpose: 'career_positioning',
    terms: ['个人网站'],
  });
  const prepared = task.prepareContext({
    candidateSetId: discovered.candidate_set_id,
    selectedEntryIds: [discovered.candidates[0].entry_id],
    request: taskRequest(fixture.targetProjectId),
  });
  const link = task.registry.contextLinks(fixture.targetProjectId)[0];
  task.registry.disableContextLink(link.link_id, {
    reason: 'The user revoked this recurring context relationship.',
  });
  const candidateFile = path.join(fixture.caseRoot, 'revoked-link-candidate.md');
  fs.writeFileSync(candidateFile, '# Must not be written\n', 'utf8');

  assert.throws(
    () => task.fulfill(prepared.task_id, {
      candidateFile,
      reason: 'Attempt a Task after its Context Link was revoked.',
    }),
    /Context Link|stale|changed/i,
  );
  assert.equal(task.show(prepared.task_id).run.status, 'stale');
  assert.equal(fs.existsSync(path.join(fixture.targetRoot, 'Site', 'plan.md')), false);
});

test('moving the target Project to another Root stops a prepared Task', (t) => {
  const fixture = setup('cross-project-target-root-change');
  const task = new TaskContract({ stateDir: fixture.stateDir });
  t.after(() => task.dispose());

  const discovered = task.discoverContext({
    projectId: fixture.targetProjectId,
    purpose: 'career_positioning',
    terms: ['个人网站'],
  });
  const prepared = task.prepareContext({
    candidateSetId: discovered.candidate_set_id,
    selectedEntryIds: [discovered.candidates[0].entry_id],
    request: taskRequest(fixture.targetProjectId),
  });
  const newTargetRoot = path.join(fixture.caseRoot, 'website-new');
  fs.mkdirSync(path.join(newTargetRoot, 'Site'), { recursive: true });
  const newRoot = task.registry.adoptRoot({
    rootPath: newTargetRoot,
    rootType: 'project_workspace',
    contentPolicy: 'bounded_content',
  });
  task.registry.attachRoot(fixture.targetProjectId, {
    rootId: newRoot.root_id,
    relativePath: 'Site',
    reason: 'Move the target Project to a new Workspace Root.',
  });
  const candidateFile = path.join(fixture.caseRoot, 'moved-target-candidate.md');
  fs.writeFileSync(candidateFile, '# Must not be written to the old Root\n', 'utf8');

  assert.throws(
    () => task.fulfill(prepared.task_id, {
      candidateFile,
      reason: 'Attempt a Task after target Root relocation.',
    }),
    /target.*Root|write Root|stale|changed/i,
  );
  assert.equal(task.show(prepared.task_id).run.status, 'stale');
  assert.equal(fs.existsSync(path.join(fixture.targetRoot, 'Site', 'plan.md')), false);
  assert.equal(fs.existsSync(path.join(newTargetRoot, 'Site', 'plan.md')), false);
});

test('moving a selected source Project to another Root stops a prepared Task', (t) => {
  const fixture = setup('cross-project-source-root-change');
  const task = new TaskContract({ stateDir: fixture.stateDir });
  t.after(() => task.dispose());

  const discovered = task.discoverContext({
    projectId: fixture.targetProjectId,
    purpose: 'career_positioning',
    terms: ['个人网站'],
  });
  const prepared = task.prepareContext({
    candidateSetId: discovered.candidate_set_id,
    selectedEntryIds: [discovered.candidates[0].entry_id],
    request: taskRequest(fixture.targetProjectId),
  });
  const newSourceRoot = path.join(fixture.caseRoot, 'vault-new');
  fs.mkdirSync(path.join(newSourceRoot, 'Career'), { recursive: true });
  fs.copyFileSync(
    fixture.sourceFile,
    path.join(newSourceRoot, 'Career', '方向.md'),
  );
  const newRoot = task.registry.adoptRoot({
    rootPath: newSourceRoot,
    rootType: 'managed_library',
    contentPolicy: 'bounded_content',
  });
  task.registry.attachRoot(fixture.sourceProjectId, {
    rootId: newRoot.root_id,
    relativePath: 'Career',
    reason: 'Move the source Project to a new Workspace Root.',
  });
  const candidateFile = path.join(fixture.caseRoot, 'moved-source-candidate.md');
  fs.writeFileSync(candidateFile, '# Must not use the old source Root\n', 'utf8');

  assert.throws(
    () => task.fulfill(prepared.task_id, {
      candidateFile,
      reason: 'Attempt a Task after source Root relocation.',
    }),
    /source.*location|stale|changed/i,
  );
  assert.equal(task.show(prepared.task_id).run.status, 'stale');
  assert.equal(fs.existsSync(path.join(fixture.targetRoot, 'Site', 'plan.md')), false);
});
