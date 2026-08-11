import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const cliPath = process.env.ATLAS_TEST_CLI_PATH
  ? path.resolve(process.env.ATLAS_TEST_CLI_PATH)
  : path.resolve('bin', 'atlas.js');
const atlasHome = process.env.ATLAS_TEST_HOME
  ? path.resolve(process.env.ATLAS_TEST_HOME)
  : path.resolve('.');
const externalStateRoot = process.env.ATLAS_TEST_STATE_ROOT
  ? path.resolve(process.env.ATLAS_TEST_STATE_ROOT)
  : null;
const tempRoot = path.resolve('test', '.tmp');

function stateFor(caseRoot, name) {
  const stateDir = externalStateRoot ? path.join(externalStateRoot, name) : path.join(caseRoot, 'state');
  fs.rmSync(stateDir, { recursive: true, force: true });
  return stateDir;
}

if (externalStateRoot) {
  test.after(() => fs.rmSync(externalStateRoot, { recursive: true, force: true }));
}

function call(stateDir, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ATLAS_STATE_DIR: stateDir, ATLAS_HOME: atlasHome },
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = stateFor(caseRoot, name);
  const root = path.join(caseRoot, 'workspace');
  const projectDir = path.join(root, 'Project');
  fs.mkdirSync(projectDir, { recursive: true });
  const target = path.join(projectDir, 'ledger.csv');
  const baseline = 'date,amount\n2026-01-01,10\n';
  fs.writeFileSync(target, baseline, 'utf8');
  const project = call(stateDir, [
    'project', 'create', '--name', 'Project', '--path', 'Project',
  ]).data;
  const workspaceRoot = call(stateDir, [
    'root', 'adopt', '--path', root,
    '--type', 'project_workspace', '--content-policy', 'bounded_content',
  ]).data;
  call(stateDir, [
    'project', 'attach-root', project.project_id,
    '--root', workspaceRoot.root_id, '--reason', 'Bind the lifecycle fixture.',
  ]);
  const requestFile = path.join(caseRoot, 'task.json');
  fs.writeFileSync(requestFile, JSON.stringify({
    intent: 'Append one reviewed period.',
    project_id: project.project_id,
    inputs: [{ path: 'Project/ledger.csv', required: true }],
    budget: { max_files: 1, max_bytes: 1024 * 1024 },
    output: {
      target: 'Project/ledger.csv',
      role: 'source',
      data_class: 'append_only_data',
      action: 'auto',
    },
  }), 'utf8');
  const task = call(stateDir, [
    'task', 'prepare', '--root', root, '--request-file', requestFile,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'agent-lifecycle-test', '--client-run-id', name,
  ]).data;
  const candidate = path.join(caseRoot, 'candidate.csv');
  fs.writeFileSync(candidate, `${baseline}2026-02-01,20\n`, 'utf8');
  return { caseRoot, stateDir, root, projectDir, target, baseline, candidate, taskId: task.task_id };
}

function hiddenValue(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`, 'u'));
  assert.ok(match, `Missing hidden UI field: ${name}`);
  return match[1];
}

function waitForReviewUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for UI server. Output: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Atlas Task Review: (http:\/\/127\.0\.0\.1:\d+\/)/u);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`UI server exited before startup with ${code}. Output: ${output}`));
    });
  });
}

test('Agent lifecycle prepares one review, consumes one approval token, and rolls back', () => {
  const fixture = setup('agent-lifecycle-complete');
  const prepared = call(fixture.stateDir, [
    'agent', 'prepare', fixture.taskId,
    '--candidate-file', fixture.candidate,
    '--reason', 'Stage the requested append.',
  ]).data;
  assert.equal(prepared.schema, 'atlas-agent-operation.v1');
  assert.equal(prepared.status, 'needs_approval');
  assert.equal(prepared.approval.required, true);
  assert.equal(fs.existsSync(prepared.approval.review_path), true);
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.baseline);

  const approval = call(fixture.stateDir, [
    'agent', 'approve', fixture.taskId,
    '--reason', 'The user approved this exact candidate.',
  ]).data;
  assert.equal(approval.status, 'approved');
  assert.match(approval.approval_token, /^ATOK-[a-f0-9]{64}$/u);
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.baseline);

  const wrong = call(fixture.stateDir, [
    'agent', 'fulfill', fixture.taskId, '--approval-token', 'ATOK-wrong',
  ], 1);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'ATLAS_STATE_CONFLICT');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.baseline);

  const completed = call(fixture.stateDir, [
    'agent', 'fulfill', fixture.taskId,
    '--approval-token', approval.approval_token,
  ]).data;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.verification.verified, true);
  assert.equal(completed.rollback.available, true);
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), `${fixture.baseline}2026-02-01,20\n`);

  const repeated = call(fixture.stateDir, [
    'agent', 'fulfill', fixture.taskId,
    '--approval-token', approval.approval_token,
  ]).data;
  assert.equal(repeated.status, 'completed');

  const rolledBack = call(fixture.stateDir, [
    'agent', 'rollback', fixture.taskId,
  ]).data;
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.baseline);
});

test('UI operation snapshot exposes the existing review, receipt, and rollback facts', () => {
  const fixture = setup('ui-operation-lifecycle');
  const prepared = call(fixture.stateDir, [
    'agent', 'prepare', fixture.taskId,
    '--candidate-file', fixture.candidate,
    '--reason', 'Stage one exact append for UI review.',
  ]).data;

  const review = call(fixture.stateDir, ['ui', 'operation', '--task', fixture.taskId]).data;
  assert.equal(review.status, 'ready');
  assert.equal(review.write_mode, 'guarded');
  assert.equal(review.write_status, 'prepared');
  assert.equal(review.next_action.kind, 'approve_or_reject');
  assert.deepEqual(review.allowed_actions, ['approve', 'reject']);
  assert.equal(fs.existsSync(review.view_path), true);
  assert.equal(review.model_visible_body_bytes, 0);
  const reviewModel = JSON.parse(fs.readFileSync(review.operation_path, 'utf8'));
  assert.equal(reviewModel.schema, 'atlas-ui-operation.v1');
  assert.equal(reviewModel.proposal.strategy, 'append');
  assert.equal(reviewModel.write.candidate.review_path, prepared.approval.review_path);
  assert.match(reviewModel.write.candidate.diff_text, /2026-02-01,20/u);
  assert.equal(reviewModel.rollback.available, false);

  const approval = call(fixture.stateDir, [
    'ui', 'action', '--task', fixture.taskId,
    '--action', 'approve', '--snapshot', review.operation_path,
    '--reason', 'Approve the exact append shown in the review.',
  ]).data;
  assert.equal(approval.ui_state, 'approved');
  assert.match(approval.approval_token, /^ATOK-[a-f0-9]{64}$/u);
  const staleReview = call(fixture.stateDir, [
    'ui', 'action', '--task', fixture.taskId,
    '--action', 'approve', '--snapshot', review.operation_path,
    '--reason', 'Try the stale page again.',
  ], 1);
  assert.equal(staleReview.error.code, 'ATLAS_STATE_CONFLICT');

  const approved = call(fixture.stateDir, ['ui', 'operation', '--task', fixture.taskId]).data;
  assert.deepEqual(approved.allowed_actions, ['execute']);
  call(fixture.stateDir, [
    'ui', 'action', '--task', fixture.taskId,
    '--action', 'execute', '--snapshot', approved.operation_path,
    '--approval-token', approval.approval_token,
  ]);
  const completed = call(fixture.stateDir, ['ui', 'operation', '--task', fixture.taskId]).data;
  const completedModel = JSON.parse(fs.readFileSync(completed.operation_path, 'utf8'));
  assert.equal(completed.status, 'completed');
  assert.equal(completed.rollback.available, true);
  assert.equal(completedModel.write.execution_receipt.verified, true);
  assert.equal(completedModel.next_action.kind, 'rollback');

  call(fixture.stateDir, [
    'ui', 'action', '--task', fixture.taskId,
    '--action', 'rollback', '--snapshot', completed.operation_path,
  ]);
  const rolledBack = call(fixture.stateDir, ['ui', 'operation', '--task', fixture.taskId]).data;
  const rolledBackModel = JSON.parse(fs.readFileSync(rolledBack.operation_path, 'utf8'));
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.rollback.available, false);
  assert.equal(rolledBackModel.rollback.status, 'completed');
});

test('Local Task Review completes approve, execute, and rollback through one loopback session', async (t) => {
  const fixture = setup('ui-operation-loopback');
  call(fixture.stateDir, [
    'agent', 'prepare', fixture.taskId,
    '--candidate-file', fixture.candidate,
    '--reason', 'Stage the Candidate shown in the local Task Review.',
  ]);
  const child = spawn(process.execPath, [cliPath, 'ui', 'serve', '--task', fixture.taskId], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ATLAS_STATE_DIR: fixture.stateDir, ATLAS_HOME: atlasHome },
  });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });
  const url = await waitForReviewUrl(child);

  let page = await (await fetch(url)).text();
  let form = new URLSearchParams({
    csrf: hiddenValue(page, 'csrf'),
    binding: hiddenValue(page, 'binding'),
    action: 'approve',
    reason: 'The user approved the exact Candidate displayed here.',
  });
  let response = await fetch(`${url}action`, { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.baseline);

  page = await (await fetch(url)).text();
  form = new URLSearchParams({
    csrf: hiddenValue(page, 'csrf'),
    binding: hiddenValue(page, 'binding'),
    action: 'execute',
  });
  response = await fetch(`${url}action`, { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), `${fixture.baseline}2026-02-01,20\n`);

  page = await (await fetch(url)).text();
  form = new URLSearchParams({
    csrf: hiddenValue(page, 'csrf'),
    binding: hiddenValue(page, 'binding'),
    action: 'rollback',
  });
  response = await fetch(`${url}action`, { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.baseline);
});

test('UI action bridge records rejection without changing the target', () => {
  const fixture = setup('ui-operation-reject');
  call(fixture.stateDir, [
    'agent', 'prepare', fixture.taskId,
    '--candidate-file', fixture.candidate,
    '--reason', 'Stage a Candidate for rejection.',
  ]);
  const snapshot = call(fixture.stateDir, ['ui', 'operation', '--task', fixture.taskId]).data;
  const rejected = call(fixture.stateDir, [
    'ui', 'action', '--task', fixture.taskId,
    '--action', 'reject', '--snapshot', snapshot.operation_path,
    '--reason', 'The user rejected this exact Candidate.',
  ]).data;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.ui_state, 'rejected');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.baseline);
});

test('UI action bridge stops stale execution after an external target change', () => {
  const fixture = setup('ui-operation-stale-execute');
  call(fixture.stateDir, [
    'agent', 'prepare', fixture.taskId,
    '--candidate-file', fixture.candidate,
    '--reason', 'Stage a Candidate for conflict validation.',
  ]);
  const review = call(fixture.stateDir, ['ui', 'operation', '--task', fixture.taskId]).data;
  const approval = call(fixture.stateDir, [
    'ui', 'action', '--task', fixture.taskId,
    '--action', 'approve', '--snapshot', review.operation_path,
    '--reason', 'Approve the exact reviewed Candidate.',
  ]).data;
  const approved = call(fixture.stateDir, ['ui', 'operation', '--task', fixture.taskId]).data;
  fs.writeFileSync(fixture.target, `${fixture.baseline}external-change\n`, 'utf8');
  const stopped = call(fixture.stateDir, [
    'ui', 'action', '--task', fixture.taskId,
    '--action', 'execute', '--snapshot', approved.operation_path,
    '--approval-token', approval.approval_token,
  ], 1);
  assert.equal(stopped.error.code, 'ATLAS_STATE_CONFLICT');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), `${fixture.baseline}external-change\n`);
});

test('Agent lifecycle stops when the target changes after approval', () => {
  const fixture = setup('agent-lifecycle-conflict');
  call(fixture.stateDir, [
    'agent', 'prepare', fixture.taskId,
    '--candidate-file', fixture.candidate,
    '--reason', 'Stage the requested append.',
  ]);
  const approval = call(fixture.stateDir, [
    'agent', 'approve', fixture.taskId,
    '--reason', 'The user approved this exact candidate.',
  ]).data;
  fs.writeFileSync(fixture.target, `${fixture.baseline}external-change\n`, 'utf8');

  const stopped = call(fixture.stateDir, [
    'agent', 'fulfill', fixture.taskId,
    '--approval-token', approval.approval_token,
  ], 1);
  assert.equal(stopped.error.code, 'ATLAS_STATE_CONFLICT');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), `${fixture.baseline}external-change\n`);
});

test('Agent lifecycle does not add an approval when an exact new output is already authorized', () => {
  const caseRoot = path.join(tempRoot, 'agent-lifecycle-create');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = stateFor(caseRoot, 'agent-lifecycle-create');
  const root = path.join(caseRoot, 'workspace');
  fs.mkdirSync(path.join(root, 'Project'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Project', 'source.md'), '# Source\n', 'utf8');
  const project = call(stateDir, [
    'project', 'create', '--name', 'Project', '--path', 'Project',
  ]).data;
  const requestFile = path.join(caseRoot, 'task.json');
  fs.writeFileSync(requestFile, JSON.stringify({
    intent: 'Create one exact reviewed output.',
    project_id: project.project_id,
    inputs: [{ path: 'Project/source.md', required: true }],
    budget: { max_files: 1, max_bytes: 1024 * 1024 },
    output: {
      target: 'Project/output.md', role: 'report',
      data_class: 'generated_output', action: 'create',
    },
  }), 'utf8');
  const task = call(stateDir, [
    'task', 'prepare', '--root', root, '--request-file', requestFile,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'agent-lifecycle-test', '--client-run-id', 'agent-lifecycle-create',
  ]).data;
  const candidate = path.join(caseRoot, 'candidate.md');
  fs.writeFileSync(candidate, '# Output\n', 'utf8');

  const completed = call(stateDir, [
    'agent', 'prepare', task.task_id,
    '--candidate-file', candidate,
    '--reason', 'The exact Task already authorizes this new output.',
  ]).data;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.approval.required, false);
  assert.equal(fs.readFileSync(path.join(root, 'Project', 'output.md'), 'utf8'), '# Output\n');

  const view = call(stateDir, ['ui', 'operation', '--task', task.task_id]).data;
  const model = JSON.parse(fs.readFileSync(view.operation_path, 'utf8'));
  assert.equal(view.write_mode, 'derived');
  assert.equal(view.rollback.available, true);
  assert.equal(model.write.execution_receipt.verified, true);
  assert.equal(model.proposal.target, 'Project/output.md');

  const rolledBack = call(stateDir, ['agent', 'rollback', task.task_id]).data;
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(root, 'Project', 'output.md')), false);
});

test('Agent status and resume continue one approved operation without rebuilding it', () => {
  const fixture = setup('agent-lifecycle-resume');
  const before = call(fixture.stateDir, ['agent', 'status', '--path', fixture.projectDir]).data;
  assert.equal(before.status, 'pending');
  assert.equal(before.pending[0].task_id, fixture.taskId);
  assert.equal(before.pending[0].next_action, 'prepare_candidate');

  call(fixture.stateDir, [
    'agent', 'prepare', fixture.taskId,
    '--candidate-file', fixture.candidate,
    '--reason', 'Stage the requested append.',
  ]);
  const review = call(fixture.stateDir, ['agent', 'resume', fixture.taskId]).data;
  assert.equal(review.status, 'needs_approval');
  assert.equal(fs.existsSync(review.approval.review_path), true);

  call(fixture.stateDir, [
    'agent', 'approve', fixture.taskId,
    '--reason', 'The user approved this exact candidate.',
  ]);
  const pending = call(fixture.stateDir, ['agent', 'status', '--path', fixture.projectDir]).data;
  assert.equal(pending.pending[0].next_action, 'resume');

  const resumed = call(fixture.stateDir, ['agent', 'resume', fixture.taskId]).data;
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.verification.verified, true);
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), `${fixture.baseline}2026-02-01,20\n`);
  assert.equal(call(fixture.stateDir, ['agent', 'status', '--path', fixture.projectDir]).data.status, 'idle');
});

test('Agent status does not present a blocked historical Task as resumable work', () => {
  const fixture = setup('agent-lifecycle-blocked-history');
  const projectId = call(fixture.stateDir, ['agent', 'status', '--path', fixture.projectDir]).data.project.id;
  const blockedRequest = path.join(fixture.caseRoot, 'blocked-task.json');
  fs.writeFileSync(blockedRequest, JSON.stringify({
    intent: 'Attempt one unsupported delete.',
    project_id: projectId,
    inputs: [{ path: 'Project/ledger.csv', required: true }],
    output: {
      target: 'Project/ledger.csv', role: 'archive',
      data_class: 'human_writing', action: 'delete',
    },
  }), 'utf8');
  const blocked = call(fixture.stateDir, [
    'task', 'prepare', '--root', fixture.root, '--request-file', blockedRequest,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'agent-lifecycle-test', '--client-run-id', 'blocked-history',
  ]).data;
  assert.equal(blocked.status, 'blocked');

  const status = call(fixture.stateDir, ['agent', 'status', '--path', fixture.projectDir]).data;
  assert.deepEqual(status.pending.map((item) => item.task_id), [fixture.taskId]);
});

test('Agent start resolves the current Project and prepares one compact Task', () => {
  const caseRoot = path.join(tempRoot, 'agent-lifecycle-start');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const stateDir = stateFor(caseRoot, 'agent-lifecycle-start');
  const root = path.join(caseRoot, 'workspace');
  const projectDir = path.join(root, 'Project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'source.md'), '# Source\n', 'utf8');
  const project = call(stateDir, ['project', 'create', '--name', 'Project', '--path', 'Project']).data;
  const workspaceRoot = call(stateDir, [
    'root', 'adopt', '--path', root,
    '--type', 'project_workspace', '--content-policy', 'bounded_content',
  ]).data;
  call(stateDir, [
    'project', 'attach-root', project.project_id,
    '--root', workspaceRoot.root_id, '--reason', 'Bind the start fixture.',
  ]);
  const requestFile = path.join(caseRoot, 'start.json');
  fs.writeFileSync(requestFile, JSON.stringify({
    intent: 'Create a governed report.',
    inputs: [{ path: 'Project/source.md', required: true }],
    budget: { max_files: 1, max_bytes: 1024 * 1024 },
    output: {
      target: 'Project/output.md', role: 'report',
      data_class: 'generated_output', action: 'create',
    },
  }), 'utf8');

  const started = call(stateDir, [
    'agent', 'start', '--path', projectDir, '--request-file', requestFile,
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
    '--tool', 'agent-lifecycle-test', '--client-run-id', 'agent-start',
  ]).data;
  assert.equal(started.status, 'ready');
  assert.equal(started.project.id, project.project_id);
  assert.deepEqual(started.read.selected_paths, ['Project/source.md']);
  assert.equal(started.write.target, 'Project/output.md');
  assert.match(started.next_action.command, new RegExp(started.task_id, 'u'));
  assert.ok(JSON.stringify(started).length < 5000);
});
