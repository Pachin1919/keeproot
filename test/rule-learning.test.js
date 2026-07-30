import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Intake } from '../src/intake.js';
import { PreferenceRules } from '../src/preference-rules.js';
import { Registry } from '../src/registry.js';
import { TaskContract } from '../src/task-contract.js';

const tempRoot = path.resolve('test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'library');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(root, 'Projects', 'PPTgen', 'Sources'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Projects', 'PPTgen', 'Working'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Projects', 'PPTgen', 'Outputs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Projects', 'PPTgen', 'AGENTS.md'),
    '# PPTgen\n\n报告输出使用中文名称；最终报告进入 Outputs。\n',
    'utf8',
  );
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'PPTgen', currentPath: 'Projects/PPTgen' });
  registry.dispose();
  return { caseRoot, root, stateDir, projectId: project.project_id };
}

function observedProposal(projectId, overrides = {}) {
  return {
    kind: 'naming',
    scope: { type: 'project', project_id: projectId },
    condition: { artifact_role: 'report' },
    value: {
      language: 'zh-CN',
      date_policy: 'semantic_only',
      date_format: 'YYYY-MM',
      rename_on_content_edit: false,
    },
    summary: 'PPTgen 报告沿用中文名称，只在时间语义需要时加入年月。',
    basis: 'observed',
    confidence: 0.95,
    priority: 100,
    evidence: [{
      path: 'Projects/PPTgen/AGENTS.md',
      fact: '控制文件要求报告输出使用中文名称。',
    }],
    ...overrides,
  };
}

test('general rule context offers defaults, learns one reviewed rule, and supersedes it without replaying history', (t) => {
  const { root, stateDir, projectId } = setup('general-rule-learning');
  const rules = new PreferenceRules({ stateDir });
  t.after(() => rules.dispose());

  const initial = rules.context({
    root,
    request: {
      operation: 'content_task',
      project_id: projectId,
      artifact_role: 'report',
      needs: ['naming'],
    },
  });
  assert.equal(initial.status, 'advice_available');
  assert.deepEqual(initial.gaps, ['naming']);
  assert.equal(initial.default_advice[0].kind, 'naming');

  const proposed = rules.propose({
    root,
    proposal: observedProposal(projectId),
    caller: { actor: 'agent', agent: 'Codex', tool: 'rule-test' },
  });
  assert.equal(proposed.status, 'prepared');
  const preview = rules.preview(proposed.rule_change_id);
  assert.equal(preview.current_rule, null);
  assert.ok(preview.impact.consumers.includes('task'));
  assert.ok(preview.impact.consumers.includes('intake'));

  const approved = rules.approve(proposed.rule_change_id, {
    reason: '用户确认 PPTgen 报告命名习惯。',
  });
  assert.equal(approved.status, 'active');
  const learned = rules.context({
    root,
    request: {
      operation: 'content_task',
      project_id: projectId,
      artifact_role: 'report',
      needs: ['naming'],
    },
  });
  assert.equal(learned.status, 'learned');
  assert.deepEqual(learned.gaps, []);
  assert.equal(learned.applied_rules[0].rule_id, approved.rule_id);
  assert.equal(learned.applied_rules[0].value.language, 'zh-CN');

  const replacement = rules.propose({
    root,
    proposal: observedProposal(projectId, {
      value: {
        language: 'zh-CN',
        date_policy: 'semantic_only',
        date_format: 'YYYY-MM-DD',
        rename_on_content_edit: false,
      },
      summary: '有明确事件日期的 PPTgen 报告使用完整日期。',
    }),
  });
  assert.equal(rules.preview(replacement.rule_change_id).current_rule.rule_id, approved.rule_id);
  const replaced = rules.approve(replacement.rule_change_id, {
    reason: '用户确认事件型报告改用完整日期。',
  });
  const active = rules.active({ root });
  assert.equal(active.length, 1);
  assert.equal(active[0].rule_id, replaced.rule_id);
  assert.equal(active[0].value.date_format, 'YYYY-MM-DD');
  assert.equal(rules.history({ root }).filter((item) => item.kind === 'naming').length, 2);
});

test('a reviewed placement preference routes repeated Intake without a Library Contract', (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('general-rule-intake-reuse');
  const rules = new PreferenceRules({ stateDir });
  const proposal = rules.propose({
    root,
    proposal: {
      kind: 'placement',
      scope: { type: 'project', project_id: projectId },
      condition: { origin: 'agent_generated', kind: 'report' },
      value: { role: 'report', target_subdirectory: 'Outputs' },
      summary: 'PPTgen 的 Agent 报告进入 Outputs。',
      basis: 'observed',
      confidence: 0.98,
      priority: 100,
      evidence: [{
        path: 'Projects/PPTgen/AGENTS.md',
        fact: '控制文件要求最终报告进入 Outputs。',
      }],
    },
  });
  const approved = rules.approve(proposal.rule_change_id, {
    reason: '用户确认 PPTgen Agent 报告路由。',
  });
  rules.dispose();

  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  for (const name of ['review-a.md', 'review-b.md']) {
    const candidate = path.join(caseRoot, name);
    fs.writeFileSync(candidate, `# ${name}\n`, 'utf8');
    const prepared = intake.prepare({
      root,
      candidateFile: candidate,
      origin: 'agent_generated',
      kind: 'report',
      projectId,
    });
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.target, `Projects/PPTgen/Outputs/${name}`);
    assert.equal(prepared.classification.basis, 'preference_rule');
    assert.equal(prepared.attention.applied_rules[0].rule_id, approved.rule_id);
    assert.deepEqual(prepared.questions, []);
  }
});

test('Task applies a learned version strategy and becomes stale when the effective rule changes', (t) => {
  const { root, stateDir, projectId } = setup('general-rule-task-stale');
  fs.writeFileSync(path.join(root, 'Projects', 'PPTgen', 'Sources', 'base.md'), '# Base\n', 'utf8');
  const rules = new PreferenceRules({ stateDir });
  const first = rules.propose({
    root,
    proposal: {
      kind: 'content_versioning',
      scope: { type: 'project', project_id: projectId },
      condition: { data_class: 'temporal_snapshot' },
      value: { strategy: 'new_version', preserve_prior: true, date_basis: 'coverage' },
      summary: 'PPTgen 时间快照保留旧版并创建新版本。',
      basis: 'observed',
      confidence: 0.9,
      priority: 100,
      evidence: [{
        path: 'Projects/PPTgen/AGENTS.md',
        fact: '项目要求保留历史报告，不覆盖来源。',
      }],
    },
  });
  rules.approve(first.rule_change_id, { reason: '确认保留时间快照旧版。' });

  const task = new TaskContract({ stateDir });
  t.after(() => task.dispose());
  const prepared = task.prepare({
    root,
    request: {
      intent: 'Create the next governed report snapshot.',
      project_id: projectId,
      inputs: [{ path: 'Projects/PPTgen/Sources/base.md', required: true, priority: 1 }],
      output: {
        target: 'Projects/PPTgen/Outputs/current.md',
        role: 'report',
        data_class: 'temporal_snapshot',
        action: 'auto',
      },
    },
  });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.write.strategy, 'new_version');
  assert.equal(prepared.attention.status, 'advice_available');
  assert.deepEqual(
    prepared.attention.applied_rules.map((item) => item.kind),
    ['content_versioning'],
  );
  assert.deepEqual(
    prepared.attention.eligible_rules.map((item) => item.rule_id),
    prepared.attention.applied_rules.map((item) => item.rule_id),
  );
  assert.deepEqual(prepared.attention.gaps, ['naming', 'agent_output']);
  assert.deepEqual(
    prepared.attention.default_advice.map((item) => item.kind),
    ['naming', 'agent_output'],
  );
  const evaluated = task.show(prepared.task_id).events.find(
    (event) => event.type === 'task_rule_evaluated',
  );
  assert.deepEqual(evaluated.payload, {
    task_id: prepared.task_id,
    eligible_rule_ids: [prepared.attention.applied_rules[0].rule_id],
    applied_rule_ids: [prepared.attention.applied_rules[0].rule_id],
    rule_version_ids: [prepared.attention.applied_rules[0].rule_version_id],
    evaluated_at: evaluated.occurred_at,
  });
  const review = task.reviewRule(prepared.task_id, {
    ruleId: prepared.attention.applied_rules[0].rule_id,
    decision: 'corrected',
    reason: 'The existing rule was eligible and applied, but the user corrected this Task.',
  });
  assert.equal(review.task_id, prepared.task_id);
  assert.equal(review.decision, 'corrected');
  assert.equal(
    task.show(prepared.task_id).rule_application_reviews[0].rule_id,
    prepared.attention.applied_rules[0].rule_id,
  );

  const replacement = rules.propose({
    root,
    proposal: {
      kind: 'content_versioning',
      scope: { type: 'project', project_id: projectId },
      condition: { data_class: 'temporal_snapshot' },
      value: { strategy: 'delta', preserve_prior: true, date_basis: 'coverage' },
      summary: 'PPTgen 时间快照改为保存增量。',
      basis: 'observed',
      confidence: 0.9,
      priority: 100,
      evidence: [{
        path: 'Projects/PPTgen/AGENTS.md',
        fact: '用户修正规则：后续只保存明确增量。',
      }],
    },
  });
  rules.approve(replacement.rule_change_id, { reason: '确认后续使用增量策略。' });
  rules.dispose();

  const candidate = path.join(stateDir, 'candidate.md');
  fs.writeFileSync(candidate, '# Candidate\n', 'utf8');
  assert.throws(
    () => task.fulfill(prepared.task_id, { candidateFile: candidate, reason: 'Current task authorization.' }),
    /effective rule context changed/i,
  );
  assert.equal(fs.existsSync(path.join(root, 'Projects', 'PPTgen', 'Outputs', 'current.md')), false);
});

test('CLI exposes the compact propose, preview, approve, and effective-context flow', () => {
  const { caseRoot, root, stateDir, projectId } = setup('general-rule-cli');
  const proposalFile = path.join(caseRoot, 'proposal.json');
  const contextFile = path.join(caseRoot, 'context.json');
  fs.writeFileSync(proposalFile, JSON.stringify(observedProposal(projectId)), 'utf8');
  fs.writeFileSync(contextFile, JSON.stringify({
    operation: 'content_task',
    project_id: projectId,
    artifact_role: 'report',
    needs: ['naming'],
  }), 'utf8');
  const cli = path.resolve('bin', 'atlas.js');
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
      cwd: path.resolve('.'),
      env: { ...process.env, ATLAS_STATE_DIR: stateDir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };

  const proposed = invoke(
    'rule', 'propose', '--root', root, '--proposal-file', proposalFile,
    '--actor', 'agent', '--agent', 'Codex', '--tool', 'rule-cli-test',
  );
  assert.equal(proposed.command, 'rule.propose');
  const changeId = proposed.data.rule_change_id;
  assert.equal(invoke('rule', 'preview', changeId).data.user_decision_required, true);
  assert.equal(
    invoke('rule', 'approve', changeId, '--reason', '用户确认命名规则。').data.status,
    'active',
  );
  const context = invoke('rule', 'context', '--root', root, '--request-file', contextFile);
  assert.equal(context.command, 'rule.context');
  assert.equal(context.data.status, 'learned');
  assert.equal(context.data.applied_rules.length, 1);
});
