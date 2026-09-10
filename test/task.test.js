import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Bootstrap } from '../src/bootstrap.js';
import { Guarded } from '../src/guarded.js';
import { Evolution } from '../src/evolution.js';
import { Ledger } from '../src/ledger.js';
import { Registry } from '../src/registry.js';
import { TaskContract } from '../src/task-contract.js';
import { Tracker } from '../src/tracker.js';

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

function setupWithoutLibraryContract(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(root, 'Notes'), { recursive: true });
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Notes', currentPath: 'Notes' });
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

test('Task Contract accepts explicit inputs and bounded Project discovery without a Library Contract', (t) => {
  const { caseRoot, root, stateDir, projectId } = setupWithoutLibraryContract('task-explicit-without-library-contract');
  write(root, 'Notes/source-a.md', 'source A\n');
  write(root, 'Notes/source-b.md', 'source B\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());

  const prepared = task.prepare({
    root,
    request: {
      intent: 'Create one bounded note from two exact sources.',
      project_id: projectId,
      inputs: [
        { path: 'Notes/source-a.md', required: true, priority: 1 },
        { path: 'Notes/source-b.md', required: true, priority: 2 },
      ],
      output: {
        target: 'Notes/reflection.md',
        role: 'note',
        data_class: 'human_writing',
        action: 'auto',
      },
    },
    caller: { actor: 'agent', agent: 'Codex', tool: 'task-test' },
  });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.boundaries.environment_policy_mode, 'task_scoped_explicit');
  assert.deepEqual(prepared.boundaries.allowed_read_paths, ['Notes/source-a.md', 'Notes/source-b.md']);
  assert.deepEqual(prepared.boundaries.allowed_write_paths, ['Notes/reflection.md']);

  const outputCandidate = candidate(caseRoot, 'reflection.md', 'bounded reflection\n');
  const fulfilled = task.fulfill(prepared.task_id, {
    candidateFile: outputCandidate,
    reason: 'The user supplied both exact inputs and requested the exact new output.',
  });
  assert.equal(fulfilled.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'Notes', 'reflection.md'), 'utf8'), 'bounded reflection\n');
  assert.equal(task.rollback(prepared.task_id).status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(root, 'Notes', 'reflection.md')), false);

  const discovered = task.discover({
    root,
    projectId,
    extensions: ['.md'],
    maxCandidates: 1,
  });
  assert.equal(discovered.content_files_read, 0);
  assert.equal(discovered.environment_policy_mode, 'task_scoped_project');
  assert.equal(discovered.candidates.length, 1);
  assert.ok(discovered.candidates[0].path.startsWith('Notes/'));

  const discoveredTask = task.prepare({
    root,
    request: {
      intent: 'Discover one source inside the explicit Project.',
      project_id: projectId,
      inputs: [],
      discovery: { extensions: ['.md'], max_candidates: 1 },
      output: {
        target: 'Notes/discovered.md',
        role: 'note',
        data_class: 'human_writing',
        action: 'auto',
      },
    },
  });
  assert.equal(discoveredTask.status, 'ready');
  assert.equal(discoveredTask.boundaries.environment_policy_mode, 'task_scoped_explicit');
  assert.equal(discoveredTask.read.selected.length, 1);
});

test('Task Contract reports payload bytes without presenting a byte heuristic as host Token usage', (t) => {
  const { root, stateDir, projectId } = setupWithoutLibraryContract('task-binary-token-estimate');
  write(root, 'Notes/context.md', 'short text context\n');
  const binaryPath = path.join(root, 'Notes', 'deck.pptx');
  fs.writeFileSync(binaryPath, Buffer.alloc(16 * 1024, 7));
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());

  const prepared = task.prepare({
    root,
    request: {
      intent: 'Compare a presentation using local extraction and a short text brief.',
      project_id: projectId,
      inputs: [
        { path: 'Notes/deck.pptx', required: true, priority: 1 },
        { path: 'Notes/context.md', required: true, priority: 2 },
      ],
      budget: { max_files: 2, max_bytes: 32 * 1024 },
      output: {
        target: 'Notes/review.md',
        role: 'report',
        data_class: 'generated_output',
        action: 'auto',
      },
    },
  });

  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.read.selected_binary_bytes, 16 * 1024);
  assert.equal(prepared.read.selected_text_bytes, Buffer.byteLength('short text context\n'));
  assert.equal(prepared.read.estimated_tokens, null);
  assert.deepEqual(prepared.read.requires_local_extraction, ['Notes/deck.pptx']);
  assert.equal(prepared.read.token_estimate_basis, 'unavailable_without_host_usage');
  assert.deepEqual(prepared.read.direct_text_payload_estimate, {
    bytes: Buffer.byteLength('short text context\n'),
    approximate_tokens: Math.ceil(Buffer.byteLength('short text context\n') / 4),
    basis: 'rough_utf8_bytes_divided_by_four',
    excludes_binary_extraction: true,
    is_host_usage: false,
  });
});

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

test('Task Contract preserves same-series inputs and reports when coverage is unknown', (t) => {
  const { root, stateDir, projectId } = setup('task-coverage-unknown');
  write(root, 'Projects/Atlas/Sources/chat-export-a.txt', 'Export A without reliable message dates.\n');
  write(root, 'Projects/Atlas/Sources/chat-export-b.txt', 'Export B without reliable message dates.\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());

  const prepared = task.prepare({
    root,
    request: {
      intent: 'Keep both chat exports when their coverage cannot be proved.',
      project_id: projectId,
      inputs: [
        { path: 'Projects/Atlas/Sources/chat-export-a.txt', series: 'chat-main', temporal_mode: 'snapshot' },
        { path: 'Projects/Atlas/Sources/chat-export-b.txt', series: 'chat-main', temporal_mode: 'snapshot' },
      ],
      budget: { max_files: 2, max_bytes: 1024 },
      output: {
        target: 'Projects/Atlas/Outputs/chat-coverage-review.md',
        role: 'report',
        data_class: 'temporal_snapshot',
        action: 'auto',
      },
    },
  });

  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.read.selected.length, 2);
  assert.equal(prepared.read.excluded.length, 0);
  assert.equal(prepared.temporal_relations[0].type, 'coverage_unknown');
  assert.equal(prepared.temporal_relations[0].decision, 'preserve_both');
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

test('Task Contract discovers a bounded role-filtered candidate set without reading file bodies', (t) => {
  const { root, stateDir, projectId } = setup('task-candidate-discovery');
  write(root, 'Projects/Atlas/Sources/source-a.md', '# Source A\nsecret-source-body\n');
  write(root, 'Projects/Atlas/Working/draft.md', '# Draft\nsecret-draft-body\n');
  write(root, 'Projects/Atlas/Outputs/report.md', '# Report\nsecret-report-body\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const originalOpen = fs.openSync;
  fs.openSync = function rejectDiscoveryBodyRead(filePath, ...args) {
    if (path.resolve(String(filePath)).startsWith(path.join(root, 'Projects', 'Atlas'))) {
      throw new Error(`candidate discovery opened file body: ${filePath}`);
    }
    return originalOpen.call(this, filePath, ...args);
  };
  let discovered;
  try {
    discovered = task.discover({
      root,
      projectId,
      roles: ['source'],
      extensions: ['.md'],
      maxCandidates: 5,
    });
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(discovered.content_files_read, 0);
  assert.deepEqual(discovered.candidates.map((item) => item.path), ['Projects/Atlas/Sources/source-a.md']);

  const prepared = task.prepare({
    root,
    request: {
      intent: 'Build a report from current source candidates.',
      project_id: projectId,
      inputs: [],
      discovery: { roles: ['source'], extensions: ['.md'], max_candidates: 5 },
      output: {
        target: 'Projects/Atlas/Outputs/discovered-report.md',
        role: 'report', data_class: 'generated_output', action: 'auto',
      },
    },
  });
  assert.equal(prepared.status, 'ready');
  assert.deepEqual(prepared.read.selected.map((item) => item.path), ['Projects/Atlas/Sources/source-a.md']);
  assert.deepEqual(prepared.boundaries.allowed_read_paths, ['Projects/Atlas/Sources/source-a.md']);
  assert.equal(prepared.boundaries.forbidden_read_policy, 'all_unlisted_paths');
  assert.equal(prepared.boundaries.formal_target, 'Projects/Atlas/Outputs/discovered-report.md');
  assert.ok(path.resolve(prepared.boundaries.candidate_area).startsWith(path.resolve(stateDir)));
  assert.doesNotMatch(JSON.stringify(prepared), /secret-source-body|secret-draft-body|secret-report-body/);
});

test('Task archive action creates a governed organization plan without moving the source', (t) => {
  const { root, stateDir, projectId } = setup('task-archive-plan');
  const source = 'Projects/Atlas/Sources/old-source.md';
  write(root, source, '# Old source\n');
  fs.mkdirSync(path.join(root, 'Projects', 'Atlas', 'Archive'), { recursive: true });
  const task = new TaskContract({ stateDir });
  const evolution = new Evolution({ stateDir });
  t.after(() => { task.dispose(); evolution.dispose(); });
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Archive one retained source without deleting it.',
      project_id: projectId,
      inputs: [{ path: source, required: true }],
      output: {
        target: 'Projects/Atlas/Archive/old-source.md',
        base_input: source,
        role: 'archive', data_class: 'human_writing', action: 'archive',
      },
    },
  });
  assert.equal(prepared.write.strategy, 'archive');
  assert.equal(prepared.write.executor, 'organization_plan');
  const plan = task.archivePlan(prepared.task_id);
  assert.equal(plan.status, 'prepared');
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].source, source);
  assert.equal(fs.existsSync(path.join(root, source)), true);
  assert.equal(fs.existsSync(path.join(root, prepared.write.target)), false);

  evolution.approvePlan(plan.run_id, { reason: 'Approve this one retained archive move.' });
  evolution.executePlan(plan.run_id);
  assert.equal(fs.existsSync(path.join(root, source)), false);
  assert.equal(fs.existsSync(path.join(root, prepared.write.target)), true);
  evolution.rollbackPlan(plan.run_id);
  assert.equal(fs.existsSync(path.join(root, source)), true);
});

test('Task fulfillment claim is exclusive across Ledger connections and can be resumed from the staged run', (t) => {
  const { root, stateDir, projectId } = setup('task-exclusive-claim');
  write(root, 'Projects/Atlas/Sources/source.md', '# source\n');
  const task = new TaskContract({ stateDir });
  const secondLedger = new Ledger(stateDir);
  t.after(() => {
    secondLedger.close();
    task.dispose();
  });
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Create one output exactly once.',
      project_id: projectId,
      inputs: [{ path: 'Projects/Atlas/Sources/source.md' }],
      output: {
        target: 'Projects/Atlas/Outputs/result.md',
        role: 'report',
        data_class: 'generated_output',
        action: 'create',
      },
    },
  });

  assert.equal(task.ledger.claimTaskFulfillment(prepared.task_id, 'claim-a', process.pid, '2026-07-21T00:00:00.000Z').status, 'acquired');
  assert.throws(
    () => secondLedger.claimTaskFulfillment(prepared.task_id, 'claim-b', 202, '2026-07-21T00:00:01.000Z'),
    /already being fulfilled/,
  );
  task.ledger.recordTaskUnderlyingRun(prepared.task_id, prepared.task_id, '2026-07-21T00:00:02.000Z', 'claim-a');
  assert.deepEqual(
    secondLedger.claimTaskFulfillment(prepared.task_id, 'claim-c', 303, '2026-07-21T00:00:03.000Z'),
    { status: 'staged', write_run_id: prepared.task_id },
  );
});

test('two processes cannot create parallel fulfillment claims for one Task', async (t) => {
  const { root, stateDir, projectId } = setup('task-cross-process-claim');
  write(root, 'Projects/Atlas/Sources/source.md', '# source\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Prove one cross-process claim.', project_id: projectId,
      inputs: [{ path: 'Projects/Atlas/Sources/source.md' }],
      output: {
        target: 'Projects/Atlas/Outputs/result.md', role: 'report',
        data_class: 'generated_output', action: 'create',
      },
    },
  });
  task.dispose();
  const worker = path.resolve('test-support', 'task-claim-worker.js');
  const owner = spawn(process.execPath, [worker, stateDir, prepared.task_id, 'owner-token', '750'], {
    cwd: path.resolve('.'), windowsHide: true, encoding: 'utf8',
  });
  const [firstChunk] = await once(owner.stdout, 'data');
  assert.equal(JSON.parse(String(firstChunk).trim()).status, 'acquired');

  const contender = spawnSync(process.execPath, [worker, stateDir, prepared.task_id, 'contender-token', '0'], {
    cwd: path.resolve('.'), windowsHide: true, encoding: 'utf8',
  });
  assert.equal(contender.status, 2);
  assert.match(JSON.parse(contender.stdout.trim()).error, /already being fulfilled/);
  const [ownerExit] = await once(owner, 'exit');
  assert.equal(ownerExit, 0);

  const ledger = new Ledger(stateDir);
  try {
    assert.deepEqual(
      ledger.claimTaskFulfillment(prepared.task_id, 'after-token', process.pid, new Date().toISOString()),
      { status: 'staged', write_run_id: prepared.task_id },
    );
  } finally {
    ledger.close();
  }
});

test('a fulfillment claim owned by a dead process is reclaimed without creating a second write run', (t) => {
  const { root, stateDir, projectId } = setup('task-dead-claim');
  write(root, 'Projects/Atlas/Sources/source.md', '# source\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Recover a dead claim.', project_id: projectId,
      inputs: [{ path: 'Projects/Atlas/Sources/source.md' }],
      output: {
        target: 'Projects/Atlas/Outputs/result.md', role: 'report',
        data_class: 'generated_output', action: 'create',
      },
    },
  });
  task.ledger.claimTaskFulfillment(prepared.task_id, 'dead-token', 2147483647, '2026-07-21T00:00:00.000Z');
  assert.deepEqual(
    task.ledger.claimTaskFulfillment(prepared.task_id, 'replacement-token', process.pid, '2026-07-21T00:00:01.000Z'),
    { status: 'acquired', planned_write_run_id: null },
  );
  assert.equal(
    task.show(prepared.task_id).events.some((event) => event.type === 'task_fulfillment_claim_reclaimed'),
    true,
  );
});

test('a crash after child-run creation is reconciled from the planned claim without an orphan replacement', (t) => {
  const { root, stateDir, projectId } = setup('task-created-run-claim');
  write(root, 'Projects/Atlas/Sources/source.md', '# source\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Reconcile the already-created claimed run.', project_id: projectId,
      inputs: [{ path: 'Projects/Atlas/Sources/source.md' }],
      output: {
        target: 'Projects/Atlas/Outputs/result.md', role: 'report',
        data_class: 'generated_output', action: 'create',
      },
    },
  });
  task.ledger.claimTaskFulfillment(
    prepared.task_id, 'crashed-owner', 2147483647, '2026-07-21T00:00:00.000Z', prepared.task_id,
  );
  assert.deepEqual(
    task.ledger.claimTaskFulfillment(
      prepared.task_id, 'replacement', process.pid, '2026-07-21T00:00:01.000Z', 'DRV-must-not-be-used',
    ),
    { status: 'staged', write_run_id: prepared.task_id },
  );
  assert.equal(task.show(prepared.task_id).underlying_run_id, prepared.task_id);
  assert.equal(
    task.show(prepared.task_id).events.some((event) => event.type === 'task_write_reconciled_from_claim'),
    true,
  );
});

test('create, delta, new_version, and supersede strategies execute through Derived with exact lineage', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('task-strategy-matrix');
  const source = 'Projects/Atlas/Sources/source.md';
  write(root, source, '# source\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const cases = [
    ['create', 'derived_from'],
    ['delta', 'delta_of'],
    ['new_version', 'transforms'],
    ['supersede', 'supersedes'],
  ];
  const taskIds = [];
  for (const [strategy, relation] of cases) {
    const prepared = task.prepare({
      root,
      request: {
        intent: `Execute ${strategy}.`, project_id: projectId,
        inputs: [{ path: source }],
        output: {
          target: `Projects/Atlas/Outputs/${strategy}.md`, role: 'report',
          data_class: strategy === 'new_version' ? 'human_writing' : 'generated_output', action: strategy,
        },
      },
    });
    assert.equal(prepared.write.strategy, strategy);
    assert.equal(prepared.write.relation_type, relation);
    assert.equal(prepared.registration.required, true);
    assert.ok(prepared.registration.records.includes('input_material_lineage'));
    const completed = task.fulfill(prepared.task_id, {
      candidateFile: candidate(caseRoot, `${strategy}.md`, `# ${strategy}\n`),
      reason: `Authorize exact ${strategy} strategy.`,
    });
    assert.equal(completed.status, 'completed');
    assert.equal(task.show(prepared.task_id).output.lineage[0].relation_type, relation);
    taskIds.push(prepared.task_id);
  }
  for (const taskId of taskIds.reverse()) {
    assert.equal(task.rollback(taskId).status, 'rolled_back');
  }
});

test('Task budget distinguishes one oversized file, file-count exhaustion, and total-byte exhaustion', (t) => {
  const { root, stateDir, projectId } = setup('task-budget-reasons');
  write(root, 'Projects/Atlas/Sources/large.txt', 'x'.repeat(100));
  write(root, 'Projects/Atlas/Sources/a.txt', 'a'.repeat(30));
  write(root, 'Projects/Atlas/Sources/b.txt', 'b'.repeat(30));
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepare = (name, inputs, budget) => task.prepare({
    root,
    request: {
      intent: `Budget ${name}.`, project_id: projectId, inputs, budget,
      output: { target: `Projects/Atlas/Outputs/${name}.md`, role: 'report', data_class: 'generated_output', action: 'create' },
    },
  });
  const single = prepare('single', [{ path: 'Projects/Atlas/Sources/large.txt' }], { max_files: 2, max_bytes: 50 });
  assert.equal(single.read.excluded[0].budget_reason, 'single_file_too_large');
  const count = prepare('count', [
    { path: 'Projects/Atlas/Sources/a.txt' }, { path: 'Projects/Atlas/Sources/b.txt' },
  ], { max_files: 1, max_bytes: 100 });
  assert.equal(count.read.excluded[0].budget_reason, 'file_count_limit');
  const total = prepare('total', [
    { path: 'Projects/Atlas/Sources/a.txt' }, { path: 'Projects/Atlas/Sources/b.txt' },
  ], { max_files: 2, max_bytes: 50 });
  assert.equal(total.read.excluded[0].budget_reason, 'total_byte_limit');
  assert.ok([single, count, total].every((item) => item.status === 'needs_input'));
});

test('Task becomes stale when the active Library Contract RuleVersion changes', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('task-rule-version-stale');
  write(root, 'Projects/Atlas/Sources/source.md', '# source\n');
  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Use the current Contract only.', project_id: projectId,
      inputs: [{ path: 'Projects/Atlas/Sources/source.md' }],
      output: { target: 'Projects/Atlas/Outputs/result.md', role: 'report', data_class: 'generated_output', action: 'create' },
    },
  });
  fs.mkdirSync(path.join(root, 'Archive'));
  const bootstrap = new Bootstrap({ stateDir });
  const scan = bootstrap.scan({ root, scanMode: 'structure', forceNew: true });
  const contract = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id, profileId: 'project-work', reason: 'Activate the changed environment version.',
  });
  bootstrap.dispose();
  assert.throws(() => task.fulfill(prepared.task_id, {
    candidateFile: candidate(caseRoot, 'result.md', '# result\n'), reason: 'Old Contract must be stale.',
  }), /stale|environment_rule_changed|changed/i);
  assert.equal(task.show(prepared.task_id).run.status, 'stale');
  assert.equal(fs.existsSync(path.join(root, prepared.write.target)), false);
});

test('append preserves UTF-8 BOM and CRLF, and later changes to the external Candidate cannot alter staged Material', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('task-append-encoding');
  const target = 'Projects/Atlas/Sources/ledger.csv';
  const baseline = '\ufeffdate,amount\r\n2026-01-01,10\r\n';
  const expected = `${baseline}2026-02-01,20\r\n`;
  write(root, target, baseline);
  const task = new TaskContract({ stateDir });
  const guarded = new Guarded({ stateDir });
  t.after(() => { guarded.dispose(); task.dispose(); });
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Append without normalizing encoding or newline style.', project_id: projectId,
      inputs: [{ path: target }],
      output: { target, role: 'source', data_class: 'append_only_data', action: 'append' },
    },
  });
  const candidateFile = candidate(caseRoot, 'encoded-ledger.csv', expected);
  const staged = task.fulfill(prepared.task_id, { candidateFile, reason: 'Stage exact encoded append.' });
  fs.writeFileSync(candidateFile, 'external Candidate changed after staging\n', 'utf8');
  guarded.approve(staged.write_run.run_id, { reason: 'Approve captured immutable Candidate.' });
  guarded.execute(staged.write_run.run_id);
  task.complete(prepared.task_id, { runId: staged.write_run.run_id });
  assert.equal(fs.readFileSync(path.join(root, target), 'utf8'), expected);
  task.rollback(prepared.task_id);
  assert.equal(fs.readFileSync(path.join(root, target), 'utf8'), baseline);
});

test('a non-compliant content process writing outside the Task target is exposed by the Tracked boundary', (t) => {
  const { root, stateDir, projectId } = setup('task-content-boundary');
  write(root, 'Projects/Atlas/Sources/source.md', '# source\n');
  const task = new TaskContract({ stateDir });
  const tracker = new Tracker({ stateDir });
  t.after(() => { tracker.dispose(); task.dispose(); });
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Give a content Skill an exact handoff.', project_id: projectId,
      inputs: [{ path: 'Projects/Atlas/Sources/source.md' }],
      output: { target: 'Projects/Atlas/Outputs/result.md', role: 'report', data_class: 'generated_output', action: 'create' },
    },
  });
  assert.deepEqual(prepared.boundaries.allowed_read_paths, ['Projects/Atlas/Sources/source.md']);
  assert.deepEqual(prepared.boundaries.allowed_write_paths, ['Projects/Atlas/Outputs/result.md']);
  const tracked = tracker.begin({ root, allow: ['Projects/Atlas/Outputs'], intent: 'Observe external content Skill writes.' });
  write(root, 'Projects/Atlas/Working/unapproved-demo.html', '<main>wrong place</main>\n');
  const receipt = tracker.close(tracked.run_id);
  assert.equal(receipt.policy, 'violation');
  assert.deepEqual(receipt.scope_violations, ['Projects/Atlas/Working/unapproved-demo.html']);
});
