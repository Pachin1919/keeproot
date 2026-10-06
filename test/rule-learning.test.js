import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Intake } from '../src/intake.js';
import { PreferenceRules } from '../src/preference-rules.js';
import { Registry } from '../src/registry.js';

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

test('a reviewed user instruction becomes an active placement rule with its basis retained', (t) => {
  const { root, stateDir, projectId } = setup('reviewed-user-instruction-rule');
  const rules = new PreferenceRules({ stateDir });
  t.after(() => rules.dispose());
  const request = {
    operation: 'content_work', project_id: projectId,
    artifact_role: 'note', needs: ['placement'],
  };
  const proposal = {
    kind: 'placement',
    scope: { type: 'project', project_id: projectId },
    condition: { artifact_role: 'note' },
    value: { role: 'note', target_subdirectory: '02_会议纪要' },
    summary: '测试参与者明确纠正：会议记录进入02_会议纪要。',
    basis: 'user_instruction', confidence: 1, evidence: [],
  };
  assert.throws(() => rules.propose({ root, proposal: observedProposal(projectId, { evidence: [] }) }), /evidence item/u);
  const before = rules.context({ root, request });
  assert.equal(before.status, 'needs_agent_proposal');
  const proposed = rules.propose({
    root, proposal,
    caller: { actor: 'agent', tool: 'fixture', client_run_id: 'user-instruction-rule' },
  });
  assert.equal(proposed.status, 'prepared');
  assert.equal(rules.active({ root }).length, 0);
  const preview = rules.preview(proposed.rule_change_id);
  assert.equal(preview.root, root);
  assert.equal(preview.candidate.basis, 'user_instruction');
  assert.equal(preview.user_decision_required, true);
  assert.throws(() => rules.approve(proposed.rule_change_id), /requires a reason/u);
  assert.equal(rules.active({ root }).length, 0);
  const approved = rules.approve(proposed.rule_change_id, { reason: 'fixture_user（测试参与者）确认' });
  assert.equal(approved.status, 'active');
  assert.match(approved.rule_version_id, /^RULE-PREF-[A-F0-9]{20}$/u);
  assert.equal(rules.active({ root })[0].basis, 'user_instruction');
  assert.equal(rules.history({ root })[0].basis, 'user_instruction');
  const learned = rules.context({ root, request });
  assert.equal(learned.status, 'learned');
  assert.equal(learned.applied_rules[0].basis, 'user_instruction');
  assert.deepEqual(learned.applied_rules[0].value, proposal.value);
});

test('a specific Project rule outranks a higher-priority Library rule for that Project only', (t) => {
  const { root, stateDir, projectId } = setup('project-rule-beats-library-priority');
  const otherPath = path.join(root, 'Projects', 'Other');
  fs.mkdirSync(otherPath, { recursive: true });
  const registry = new Registry({ stateDir });
  const otherProject = registry.create({ name: 'Other', currentPath: 'Projects/Other' });
  registry.dispose();
  const rules = new PreferenceRules({ stateDir });
  t.after(() => rules.dispose());
  const proposeAndApprove = (scope, target, priority, clientRunId) => {
    const proposal = rules.propose({
      root,
      proposal: {
        kind: 'placement',
        scope,
        condition: { artifact_role: 'note' },
        value: { role: 'note', target_subdirectory: target },
        summary: `User-confirmed note placement for ${target}.`,
        basis: 'user_instruction',
        confidence: 1,
        priority,
        evidence: [],
      },
      caller: { actor: 'agent', tool: 'fixture', client_run_id: clientRunId },
    });
    return rules.approve(proposal.rule_change_id, { reason: 'fixture_user（测试参与者）确认' });
  };
  const libraryRule = proposeAndApprove({ type: 'library' }, '01_文献', 900, 'library-placement');
  const projectRule = proposeAndApprove({ type: 'project', project_id: projectId }, '02_会议纪要', 10, 'project-placement');
  const context = (id) => rules.context({
    root,
    request: { operation: 'content_work', project_id: id, artifact_role: 'note', needs: ['placement'] },
  });

  const ownProject = context(projectId);
  assert.equal(ownProject.applied_rules[0].rule_id, projectRule.rule_id);
  assert.equal(ownProject.applied_rules[0].value.target_subdirectory, '02_会议纪要');
  const otherProjectContext = context(otherProject.project_id);
  assert.equal(otherProjectContext.applied_rules[0].rule_id, libraryRule.rule_id);
  assert.equal(otherProjectContext.applied_rules[0].value.target_subdirectory, '01_文献');
});

test('pending rules lists only prepared proposals for the requested root and Project', async (t) => {
  const { caseRoot, root, stateDir, projectId } = setup('project-pending-rules');
  const otherProjectPath = path.join(root, 'Projects', 'Other');
  fs.mkdirSync(otherProjectPath, { recursive: true });
  fs.writeFileSync(path.join(otherProjectPath, 'AGENTS.md'), '# Other\n', 'utf8');
  const otherRoot = path.join(caseRoot, 'other-library');
  fs.mkdirSync(path.join(otherRoot, 'Projects', 'OtherRoot'), { recursive: true });
  fs.writeFileSync(path.join(otherRoot, 'Projects', 'OtherRoot', 'AGENTS.md'), '# Other root\n', 'utf8');
  const registry = new Registry({ stateDir });
  const otherProject = registry.create({ name: 'Other', currentPath: 'Projects/Other' });
  const otherRootProject = registry.create({ name: 'OtherRoot', currentPath: 'Projects/OtherRoot' });
  registry.dispose();
  const rules = new PreferenceRules({ stateDir });
  t.after(() => rules.dispose());
  const placement = (scopeProjectId, target, summary) => ({
    kind: 'placement', scope: { type: 'project', project_id: scopeProjectId },
    condition: { artifact_role: 'note' },
    value: { role: 'note', target_subdirectory: target }, summary,
    basis: 'observed', confidence: 0.95,
    evidence: [{ path: scopeProjectId === otherRootProject.project_id
      ? 'Projects/OtherRoot/AGENTS.md'
      : scopeProjectId === otherProject.project_id ? 'Projects/Other/AGENTS.md' : 'Projects/PPTgen/AGENTS.md',
    fact: '项目控制文件中的路由约定。' }],
  });
  const first = rules.propose({ root, proposal: placement(projectId, 'Working', 'first pending placement') });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = rules.propose({ root, proposal: placement(projectId, 'Outputs', 'second pending placement') });
  const otherProjectProposal = rules.propose({ root, proposal: placement(otherProject.project_id, 'Working', 'other Project proposal') });
  const otherRootProposal = rules.propose({ root: otherRoot, proposal: placement(otherRootProject.project_id, 'Outputs', 'other root proposal') });

  const pending = rules.pending({ root, projectId });
  assert.deepEqual(pending.map((item) => item.rule_change_id), [second.rule_change_id, first.rule_change_id]);
  assert.equal(pending.length, 2);
  assert.deepEqual(Object.keys(pending[0]).sort(), ['basis', 'created_at', 'kind', 'rule_change_id', 'status', 'summary']);
  assert.equal(pending[0].status, 'prepared');
  assert.equal(pending[0].basis, 'observed');
  assert.deepEqual(rules.pending({ root, projectId: otherProject.project_id }).map((item) => item.rule_change_id), [otherProjectProposal.rule_change_id]);
  assert.deepEqual(rules.pending({ root: otherRoot, projectId: otherRootProject.project_id }).map((item) => item.rule_change_id), [otherRootProposal.rule_change_id]);

  rules.approve(first.rule_change_id, { reason: 'User approved first proposal.' });
  assert.deepEqual(rules.pending({ root, projectId }).map((item) => item.rule_change_id), [second.rule_change_id]);
  rules.reject(second.rule_change_id, { reason: 'User rejected second proposal.' });
  assert.deepEqual(rules.pending({ root, projectId }), []);
});

test('pending rule pages retain an initial watermark while proposals change between pages', (t) => {
  const { root, stateDir, projectId } = setup('project-pending-rule-pages');
  const rules = new PreferenceRules({ stateDir });
  t.after(() => rules.dispose());
  const registry = new Registry({ stateDir });
  const otherProjectId = registry.create({ name: 'Other', currentPath: 'Projects/Other' }).project_id;
  registry.dispose();
  const proposal = (index) => ({
    kind: 'placement', scope: { type: 'project', project_id: projectId },
    condition: { artifact_role: 'note' },
    value: { role: 'note', target_subdirectory: `Folder-${index}` },
    summary: `Pending page proposal ${index}`, basis: 'observed', confidence: 0.9,
    evidence: [{ path: 'Projects/PPTgen/AGENTS.md', fact: `Fixture routing evidence ${index}.` }],
  });
  const ids = Array.from({ length: 53 }, (_, index) => rules.propose({ root, proposal: proposal(index) }).rule_change_id);
  const first = rules.pendingPage({ root, projectId, limit: 50 });
  assert.equal(first.items.length, 50);
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor);
  assert.deepEqual(first.items.map((item) => item.rule_change_id), ids.slice().reverse().slice(0, 50));
  assert.throws(
    () => rules.pendingPage({ root, projectId: otherProjectId, limit: 50, cursor: first.next_cursor }),
    (error) => error.code === 'ATLAS_STATE_CONFLICT',
  );
  rules.approve(first.items[0].rule_change_id, { reason: 'fixture_user approved an item on page one.' });
  const newest = rules.propose({ root, proposal: proposal(100) });
  const second = rules.pendingPage({ root, projectId, limit: 50, cursor: first.next_cursor });
  assert.deepEqual(second.items.map((item) => item.rule_change_id), ids.slice().reverse().slice(50));
  assert.equal(second.has_more, false);
  const refreshed = rules.pendingPage({ root, projectId, limit: 50 });
  assert.equal(refreshed.items[0].rule_change_id, newest.rule_change_id);
  assert.equal(refreshed.items.some((item) => item.rule_change_id === first.items[0].rule_change_id), false);
  assert.equal(rules.preview(first.items[0].rule_change_id).status, 'approved');
});

test('general rule context offers defaults, learns one reviewed rule, and supersedes it without replaying history', (t) => {
  const { root, stateDir, projectId } = setup('general-rule-learning');
  const rules = new PreferenceRules({ stateDir });
  t.after(() => rules.dispose());

  const initial = rules.context({
    root,
    request: {
      operation: 'content_work',
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
  assert.ok(preview.impact.consumers.includes('save'));
  assert.ok(preview.impact.consumers.includes('intake'));

  const approved = rules.approve(proposed.rule_change_id, {
    reason: '用户确认 PPTgen 报告命名习惯。',
  });
  assert.equal(approved.status, 'active');
  const learned = rules.context({
    root,
    request: {
      operation: 'content_work',
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

test('CLI exposes the compact propose, preview, approve, and effective-context flow', () => {
  const { caseRoot, root, stateDir, projectId } = setup('general-rule-cli');
  const proposalFile = path.join(caseRoot, 'proposal.json');
  const contextFile = path.join(caseRoot, 'context.json');
  fs.writeFileSync(proposalFile, JSON.stringify(observedProposal(projectId)), 'utf8');
  fs.writeFileSync(contextFile, JSON.stringify({
    operation: 'content_work',
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
  const pending = invoke('rule', 'pending', '--root', root, '--project', projectId);
  assert.equal(pending.command, 'rule.pending');
  assert.ok(pending.data.items.some((item) => item.rule_change_id === changeId));
  assert.equal(invoke('rule', 'preview', changeId).data.user_decision_required, true);
  assert.equal(
    invoke('rule', 'approve', changeId, '--reason', '用户确认命名规则。').data.status,
    'active',
  );
  const context = invoke('rule', 'context', '--root', root, '--request-file', contextFile);
  assert.equal(context.command, 'rule.context');
  assert.equal(context.data.status, 'learned');
  assert.equal(context.data.applied_rules.length, 1);
  const ruleId = context.data.applied_rules[0].rule_id;
  const disablePreview = invoke('rule', 'disable-preview', ruleId);
  assert.equal(disablePreview.command, 'rule.disable-preview');
  assert.equal(disablePreview.data.rule_version_id, invoke('rule', 'active', '--root', root).data[0].rule_version_id);
  const disabled = invoke(
    'rule', 'disable', ruleId,
    '--expected-preview-revision', disablePreview.data.preview_revision,
    '--reason', 'fixture_user disabled the old naming rule.',
    '--actor', 'user', '--tool', 'rule-cli-test', '--client-run-id', 'disable-cli',
  );
  assert.equal(disabled.command, 'rule.disable');
  assert.equal(disabled.data.status, 'disabled');
  assert.equal(invoke('rule', 'context', '--root', root, '--request-file', contextFile).data.applied_rules.length, 0);
});

test('confirmed preference rules can be previewed and disabled with revision-bound repeat receipts', (t) => {
  const { root, stateDir, projectId } = setup('rule-disable');
  const rules = new PreferenceRules({ stateDir });
  t.after(() => rules.dispose());
  const proposal = rules.propose({ root, proposal: observedProposal(projectId) });
  const approved = rules.approve(proposal.rule_change_id, { reason: 'fixture_user confirmed the rule.' });
  const request = { operation: 'content_work', project_id: projectId, artifact_role: 'report', needs: ['naming'] };
  assert.equal(rules.context({ root, request }).applied_rules[0].rule_id, approved.rule_id);

  const disablePreview = rules.previewDisable(approved.rule_id);
  assert.equal(disablePreview.rule_id, approved.rule_id);
  assert.equal(disablePreview.rule_version_id, approved.rule_version_id);
  assert.ok(disablePreview.impact.consumers.includes('rule.context'));
  assert.match(disablePreview.preview_revision, /^[a-f0-9]{64}$/u);
  const replacementProposal = observedProposal(projectId, {
    value: { language: 'zh-CN', date_policy: 'event_date', date_format: 'YYYY-MM-DD', rename_on_content_edit: false },
    summary: 'PPTgen event reports use full dates.',
  });
  const replacement = rules.propose({ root, proposal: replacementProposal });
  rules.approve(replacement.rule_change_id, { reason: 'fixture_user confirmed replacement.' });
  assert.throws(
    () => rules.disable(approved.rule_id, { expectedPreviewRevision: disablePreview.preview_revision, reason: 'stale review' }),
    (error) => error.code === 'ATLAS_STATE_CONFLICT',
  );

  const fresh = rules.previewDisable(rules.active({ root })[0].rule_id);
  const disabled = rules.disable(fresh.rule_id, {
    expectedPreviewRevision: fresh.preview_revision,
    reason: 'fixture_user（测试参与者）停用',
    caller: { actor: 'user', tool: 'fixture', client_run_id: 'disable-rule-1' },
  });
  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(rules.disable(fresh.rule_id, {
    expectedPreviewRevision: fresh.preview_revision, reason: 'repeat confirmation',
  }), disabled);
  assert.equal(rules.context({ root, request }).applied_rules.length, 0);
  assert.equal(rules.history({ root }).find((item) => item.rule_id === fresh.rule_id).status, 'disabled');
  const neverSupersededProposal = observedProposal(projectId, {
    condition: { artifact_role: 'note' },
    summary: 'PPTgen notes preserve established Chinese naming.',
  });
  const neverSuperseded = rules.propose({ root, proposal: neverSupersededProposal });
  const neverSupersededRule = rules.approve(neverSuperseded.rule_change_id, {
    reason: 'fixture_user confirmed the independent note rule.',
  });
  const neverSupersededPreview = rules.previewDisable(neverSupersededRule.rule_id);
  const neverSupersededReceipt = rules.disable(neverSupersededRule.rule_id, {
    expectedPreviewRevision: neverSupersededPreview.preview_revision,
    reason: 'fixture_user disabled the independent note rule.',
  });
  assert.equal(neverSupersededReceipt.status, 'disabled');
  const identical = rules.propose({ root, proposal: neverSupersededProposal });
  assert.throws(
    () => rules.approve(identical.rule_change_id, { reason: 'do not revive disabled rule' }),
    (error) => error.code === 'ATLAS_STATE_CONFLICT'
      && /disabled preference rule with this definition already exists/u.test(error.message),
  );
  const retained = rules.history({ root }).find((item) => item.rule_id === neverSupersededRule.rule_id);
  assert.equal(retained.status, 'disabled');
  assert.equal(retained.rule_version_id, neverSupersededRule.rule_version_id);
  assert.equal(rules.active({ root }).some((item) => item.rule_id === neverSupersededRule.rule_id), false);
});
