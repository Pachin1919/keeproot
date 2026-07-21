import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Bootstrap } from '../src/bootstrap.js';
import { Guarded } from '../src/guarded.js';
import { Registry } from '../src/registry.js';
import { TaskContract } from '../src/task-contract.js';

const tempRoot = path.resolve('test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(root, 'Projects', 'Atlas', 'Sources'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Projects', 'Atlas', 'Working'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Projects', 'Atlas', 'Outputs'), { recursive: true });

  const bootstrap = new Bootstrap({ stateDir });
  const scan = bootstrap.scan({ root, scanMode: 'structure' });
  const contract = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id,
    profileId: 'project-work',
    reason: 'Task Contract fixture.',
  });
  bootstrap.dispose();

  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' });
  registry.dispose();
  return { caseRoot, root, stateDir, projectId: project.project_id };
}

function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
  return absolute;
}

function candidate(caseRoot, name, content) {
  return write(caseRoot, `candidates/${name}`, content);
}

function input(pathname, series, start, end, extra = {}) {
  return {
    path: pathname,
    series,
    temporal_mode: 'snapshot',
    coverage: { start, end },
    required: true,
    ...extra,
  };
}

test('Task Contract selects a verified newer snapshot, fulfills once, records lineage, and rolls back', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('task-supersede');
  const oldText = 'January\nFebruary\nMarch\nApril\nMay\n';
  const newText = `${oldText}June\nJuly\n`;
  write(root, 'Projects/Atlas/Sources/chat-jan-may.txt', oldText);
  write(root, 'Projects/Atlas/Sources/chat-jan-jul.txt', newText);
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());

  const prepared = task.prepare({
    root,
    request: {
      intent: 'Produce the current token-efficient chat record.',
      project_id: projectId,
      inputs: [
        input('Projects/Atlas/Sources/chat-jan-may.txt', 'chat-main', '2026-01-01', '2026-05-31'),
        input('Projects/Atlas/Sources/chat-jan-jul.txt', 'chat-main', '2026-01-01', '2026-07-31'),
      ],
      budget: { max_files: 2, max_bytes: 1024 },
      output: {
        target: 'Projects/Atlas/Outputs/chat-current.txt',
        role: 'canonical',
        data_class: 'temporal_snapshot',
        action: 'auto',
      },
    },
    caller: { actor: 'agent', agent: 'Codex', tool: 'task-test' },
  });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.read.selected.length, 1);
  assert.equal(prepared.read.selected[0].path, 'Projects/Atlas/Sources/chat-jan-jul.txt');
  assert.equal(prepared.read.excluded[0].reason, 'superseded_by_verified_snapshot');
  assert.equal(prepared.temporal_relations[0].type, 'supersedes');
  assert.equal(prepared.write.strategy, 'supersede');
  assert.equal(prepared.write.executor, 'derived_create');
  assert.doesNotMatch(JSON.stringify(prepared), /January|February|June/);

  const outputCandidate = candidate(caseRoot, 'chat-current.txt', 'Current chat record through July.\n');
  const fulfilled = task.fulfill(prepared.task_id, {
    candidateFile: outputCandidate,
    reason: 'The user requested this current governed output.',
  });
  assert.equal(fulfilled.status, 'completed');
  assert.equal(fulfilled.write_run.mode, 'derived');
  assert.equal(fs.readFileSync(path.join(root, prepared.write.target), 'utf8'), 'Current chat record through July.\n');
  const detail = task.show(prepared.task_id);
  assert.equal(detail.run.status, 'completed');
  assert.equal(detail.output.lineage[0].relation_type, 'supersedes');
  assert.equal(detail.output.lineage[0].input_path, 'Projects/Atlas/Sources/chat-jan-jul.txt');
  assert.deepEqual(task.fulfill(prepared.task_id, {
    candidateFile: outputCandidate,
    reason: 'Repeated completion.',
  }), fulfilled);

  const rolledBack = task.rollback(prepared.task_id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(root, prepared.write.target)), false);
  assert.deepEqual(task.rollback(prepared.task_id), rolledBack);
});

test('Task Contract preserves partially overlapping snapshots and explains both selections', (t) => {
  const { root, stateDir, projectId } = setup('task-overlap');
  write(root, 'Projects/Atlas/Sources/chat-jan-may.txt', 'January to May version A\n');
  write(root, 'Projects/Atlas/Sources/chat-may-jul.txt', 'May to July version B\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Compare overlapping chat exports.',
      project_id: projectId,
      inputs: [
        input('Projects/Atlas/Sources/chat-jan-may.txt', 'chat-main', '2026-01-01', '2026-05-31'),
        input('Projects/Atlas/Sources/chat-may-jul.txt', 'chat-main', '2026-05-01', '2026-07-31'),
      ],
      budget: { max_files: 2, max_bytes: 1024 },
      output: {
        target: 'Projects/Atlas/Outputs/chat-overlap.md', role: 'report',
        data_class: 'temporal_snapshot', action: 'auto',
      },
    },
  });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.read.selected.length, 2);
  assert.equal(prepared.read.excluded.length, 0);
  assert.equal(prepared.temporal_relations[0].type, 'overlaps');
  assert.equal(prepared.temporal_relations[0].evidence.content_inclusion, false);
});

test('Task Contract deduplicates identical Materials while retaining both source facts', (t) => {
  const { root, stateDir, projectId } = setup('task-duplicate');
  write(root, 'Projects/Atlas/Sources/export-a.txt', 'same export\n');
  write(root, 'Projects/Atlas/Sources/export-b.txt', 'same export\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Use one copy of an identical export.', project_id: projectId,
      inputs: [
        input('Projects/Atlas/Sources/export-a.txt', 'chat-main', '2026-01-01', '2026-05-31'),
        input('Projects/Atlas/Sources/export-b.txt', 'chat-main', '2026-01-01', '2026-05-31'),
      ],
      output: { target: 'Projects/Atlas/Outputs/dedup.md', role: 'report', data_class: 'generated_output', action: 'auto' },
    },
  });
  assert.equal(prepared.read.selected.length, 1);
  assert.equal(prepared.read.excluded.length, 1);
  assert.equal(prepared.read.excluded[0].reason, 'duplicate_material');
  assert.equal(prepared.temporal_relations[0].type, 'duplicate_of');
  assert.equal(prepared.temporal_relations[0].evidence.same_hash, true);
});

test('Task Contract stops when required input cannot fit the explicit read budget', (t) => {
  const { root, stateDir, projectId } = setup('task-budget');
  write(root, 'Projects/Atlas/Sources/required.txt', 'x'.repeat(200));
  write(root, 'Projects/Atlas/Sources/optional.txt', 'small\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Respect a hard context budget.', project_id: projectId,
      inputs: [
        { path: 'Projects/Atlas/Sources/required.txt', required: true, priority: 1 },
        { path: 'Projects/Atlas/Sources/optional.txt', required: false, priority: 2 },
      ],
      budget: { max_files: 2, max_bytes: 32 },
      output: { target: 'Projects/Atlas/Outputs/budget.md', role: 'report', data_class: 'generated_output', action: 'auto' },
    },
  });
  assert.equal(prepared.status, 'needs_input');
  assert.ok(prepared.questions.some((question) => question.field === 'budget'));
  assert.ok(prepared.read.excluded.some((item) => item.path.endsWith('required.txt') && item.required));
  assert.throws(() => task.fulfill(prepared.task_id, {
    candidateFile: candidate(path.dirname(root), 'blocked.md', 'blocked\n'), reason: 'Must not run.',
  }), /not ready|needs_input/i);
});

test('Append-only Task uses Guarded, verifies append semantics, completes lineage, and restores safely', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('task-append');
  const target = 'Projects/Atlas/Sources/ledger.csv';
  write(root, target, 'date,amount\n2026-01-01,10\n');
  const task = new TaskContract({ stateDir });
  const guarded = new Guarded({ stateDir });
  t.after(() => { task.dispose(); guarded.dispose(); });
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Append one immutable transaction period.', project_id: projectId,
      inputs: [{ path: target, required: true }],
      output: { target, role: 'source', data_class: 'append_only_data', action: 'auto' },
    },
  });
  assert.equal(prepared.write.strategy, 'append');
  assert.equal(prepared.write.executor, 'guarded_update');
  const bad = candidate(caseRoot, 'bad-ledger.csv', 'replacement only\n');
  assert.throws(() => task.fulfill(prepared.task_id, {
    candidateFile: bad, reason: 'Invalid replacement.',
  }), /append|baseline/i);

  const good = candidate(caseRoot, 'ledger.csv', 'date,amount\n2026-01-01,10\n2026-02-01,20\n');
  const staged = task.fulfill(prepared.task_id, {
    candidateFile: good, reason: 'Stage the requested append.',
  });
  assert.equal(staged.status, 'needs_approval');
  assert.equal(staged.write_run.mode, 'guarded');
  guarded.approve(staged.write_run.run_id, { reason: 'Approve the exact append.' });
  guarded.execute(staged.write_run.run_id);
  const completed = task.complete(prepared.task_id, { runId: staged.write_run.run_id });
  assert.equal(completed.status, 'completed');
  const detail = task.show(prepared.task_id);
  assert.equal(detail.output.lineage[0].relation_type, 'appends_to');
  task.rollback(prepared.task_id);
  assert.equal(fs.readFileSync(path.join(root, target), 'utf8'), 'date,amount\n2026-01-01,10\n');
});

test('Task Contract becomes stale when a selected input changes before fulfillment', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('task-stale');
  const source = 'Projects/Atlas/Sources/source.md';
  write(root, source, 'baseline\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Generate from one exact source.', project_id: projectId,
      inputs: [{ path: source, required: true }],
      output: { target: 'Projects/Atlas/Outputs/result.md', role: 'report', data_class: 'generated_output', action: 'auto' },
    },
  });
  fs.appendFileSync(path.join(root, source), 'later\n', 'utf8');
  assert.throws(() => task.fulfill(prepared.task_id, {
    candidateFile: candidate(caseRoot, 'result.md', 'result\n'), reason: 'Must be stale.',
  }), /changed|stale/i);
  assert.equal(task.show(prepared.task_id).run.status, 'stale');
  assert.equal(fs.existsSync(path.join(root, prepared.write.target)), false);
});

test('Task Contract becomes stale when an absent output is claimed before fulfillment', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('task-target-claimed');
  write(root, 'Projects/Atlas/Sources/source.md', 'baseline\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const request = {
    intent: 'Create one exact output.', project_id: projectId,
    inputs: [{ path: 'Projects/Atlas/Sources/source.md', required: true }],
    output: { target: 'Projects/Atlas/Outputs/result.md', role: 'report', data_class: 'generated_output', action: 'auto' },
  };
  const prepared = task.prepare({ root, request });
  assert.equal(task.prepare({ root, request }).task_id, prepared.task_id);
  write(root, prepared.write.target, 'claimed by another writer\n');
  assert.throws(() => task.fulfill(prepared.task_id, {
    candidateFile: candidate(caseRoot, 'result.md', 'candidate\n'), reason: 'Must stop.',
  }), /claimed|stale|target/i);
  assert.equal(task.show(prepared.task_id).run.status, 'stale');
});

test('Task Contract marks a replaced non-file input stale instead of hashing it', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('task-input-kind-changed');
  const source = write(root, 'Projects/Atlas/Sources/source.md', 'baseline\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Use one regular input.', project_id: projectId,
      inputs: [{ path: 'Projects/Atlas/Sources/source.md', required: true }],
      output: { target: 'Projects/Atlas/Outputs/result.md', role: 'report', data_class: 'generated_output', action: 'auto' },
    },
  });
  fs.rmSync(source);
  fs.mkdirSync(source);
  assert.throws(() => task.fulfill(prepared.task_id, {
    candidateFile: candidate(caseRoot, 'result.md', 'candidate\n'), reason: 'Must stop.',
  }), /changed|stale/i);
  assert.equal(task.show(prepared.task_id).run.status, 'stale');
});

test('Task Contract denies delete/archive execution and rejects path or date escape', (t) => {
  const { root, stateDir, projectId } = setup('task-deny-boundary');
  write(root, 'Projects/Atlas/Sources/source.md', 'source\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const denied = task.prepare({
    root,
    request: {
      intent: 'Try to delete source material.', project_id: projectId,
      inputs: [{ path: 'Projects/Atlas/Sources/source.md', required: true }],
      output: { target: 'Projects/Atlas/Sources/source.md', role: 'archive', data_class: 'human_writing', action: 'delete' },
    },
  });
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.write.strategy, 'deny');
  assert.equal(denied.write.decision, 'deny');
  assert.throws(() => task.prepare({
    root,
    request: {
      intent: 'Escape.', project_id: projectId,
      inputs: [{ path: '../outside.md', required: true }],
      output: { target: 'Projects/Atlas/Outputs/no.md', role: 'report', data_class: 'generated_output', action: 'auto' },
    },
  }), /escape|outside/i);
  assert.throws(() => task.prepare({
    root,
    request: {
      intent: 'Invalid coverage.', project_id: projectId,
      inputs: [input('Projects/Atlas/Sources/source.md', 'bad', '2026-07-31', '2026-01-01')],
      output: { target: 'Projects/Atlas/Outputs/no.md', role: 'report', data_class: 'generated_output', action: 'auto' },
    },
  }), /coverage|date/i);
});
