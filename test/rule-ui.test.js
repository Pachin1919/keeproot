import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PreferenceRules } from '../src/preference-rules.js';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';

test('Project HTML reviews a Host rule, records a fixture user correction, then activates only the corrected rule', async (t) => {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('test/.tmp/rule-ui-'));
  const root = path.join(temp, 'library');
  const stateDir = path.join(temp, 'state');
  const projectPath = path.join(root, '城市研究');
  fs.mkdirSync(path.join(projectPath, '01_文献'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, '02_会议纪要'), { recursive: true });
  fs.mkdirSync(path.join(root, '其他项目'), { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: root, rootType: 'managed_library', contentPolicy: 'bounded_content' });
  const projectId = registry.create({ name: '城市研究', currentPath: '城市研究' }).project_id;
  registry.attachRoot(projectId, { rootId: adopted.root_id, relativePath: '城市研究', reason: 'Isolated UI rule fixture.' });
  const otherProjectId = registry.create({ name: '其他项目', currentPath: '其他项目' }).project_id;
  registry.attachRoot(otherProjectId, { rootId: adopted.root_id, relativePath: '其他项目', reason: 'Isolated cross-Project rule fixture.' });
  const rules = new PreferenceRules({ stateDir });
  let server;
  t.after(async () => {
    if (server) await server.close();
    rules.dispose(); registry.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const hostProposal = rules.propose({
    root,
    proposal: {
      kind: 'placement', scope: { type: 'project', project_id: projectId },
      condition: { artifact_role: 'note' },
      value: { role: 'note', target_subdirectory: '01_文献' },
      summary: 'Host 建议会议摘记进入文献目录。', basis: 'observed', confidence: 0.9,
      evidence: [{ path: '城市研究/01_文献', fact: '库内存在文献目录。' }],
    },
    caller: { actor: 'agent', tool: 'fixture-host', client_run_id: 'rule-ui-host' },
  });
  server = await startAtlasUiServer({ stateDir, registry, rules, runtime: {} });
  const base = `${server.workspace_url}projects/${projectId}/rules`;
  const originalUrl = `${base}/${hostProposal.rule_change_id}`;
  const listing = await fetch(base);
  assert.equal(listing.status, 200);
  assert.match(await listing.text(), new RegExp(hostProposal.rule_change_id, 'u'));
  assert.equal((await fetch(`${server.workspace_url}projects/${otherProjectId}/rules/${hostProposal.rule_change_id}`)).status, 403);
  const originalPage = await fetch(originalUrl);
  assert.equal(originalPage.status, 200);
  const html = await originalPage.text();
  assert.match(html, /01_文献/u);
  assert.match(html, /observed/u);
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)?.[1];
  assert.ok(csrf);
  const post = (url, fields) => fetch(url, {
    method: 'POST', body: new URLSearchParams({ csrf, ...fields }), redirect: 'manual',
  });
  assert.equal((await post(originalUrl, { csrf: 'wrong', action: 'approve', reason: 'fixture_user（测试参与者）' })).status, 403);
  const correction = await post(originalUrl, {
    action: 'correct', target_subdirectory: '02_会议纪要',
    summary: '测试参与者纠正：会议记录进入会议纪要目录。',
    reason: 'fixture_user（测试参与者）纠正目录职责。',
  });
  assert.equal(correction.status, 303);
  const correctedUrl = new URL(correction.headers.get('location'), server.workspace_url).href;
  const correctedPage = await fetch(correctedUrl);
  assert.equal(correctedPage.status, 200);
  const correctedHtml = await correctedPage.text();
  assert.match(correctedHtml, /02_会议纪要/u);
  assert.match(correctedHtml, /user_instruction/u);
  assert.equal(rules.preview(hostProposal.rule_change_id).status, 'rejected');
  assert.equal(rules.active({ root }).length, 0);
  const confirmation = await post(correctedUrl, {
    action: 'approve', reason: 'fixture_user（测试参与者）确认新规则。',
  });
  assert.equal(confirmation.status, 303);
  const active = rules.active({ root });
  assert.equal(active.length, 1);
  assert.equal(active[0].basis, 'user_instruction');
  assert.equal(active[0].value.target_subdirectory, '02_会议纪要');
  const disableUrl = `${base}/${active[0].rule_id}`;
  assert.equal((await fetch(`${server.workspace_url}projects/${otherProjectId}/rules/${active[0].rule_id}`)).status, 403);
  const disablePage = await fetch(disableUrl);
  assert.equal(disablePage.status, 200);
  const disableHtml = await disablePage.text();
  assert.match(disableHtml, /02_会议纪要/u);
  assert.match(disableHtml, new RegExp(active[0].rule_version_id, 'u'));
  assert.match(disableHtml, /rule\.context/u);
  const disableRevision = disableHtml.match(/name="expected_preview_revision" value="([a-f0-9]{64})"/u)?.[1];
  assert.ok(disableRevision);
  const disableResponse = await post(disableUrl, {
    action: 'disable', expected_preview_revision: disableRevision,
    reason: 'fixture_user（测试参与者）停用错误去向规则。',
  });
  assert.equal(disableResponse.status, 303);
  assert.equal(rules.active({ root }).filter((rule) => rule.scope.key === projectId).length, 0);
  const naming = rules.propose({
    root,
    proposal: {
      kind: 'naming', scope: { type: 'project', project_id: projectId },
      condition: { artifact_role: 'note' },
      value: { language: 'zh-CN', date_policy: 'semantic_only', date_format: 'YYYY-MM', rename_on_content_edit: false },
      summary: 'Host 建议只用年月。', basis: 'observed', confidence: 0.9,
      evidence: [{ path: '城市研究/02_会议纪要', fact: '存在会议纪要目录。' }],
    },
    caller: { actor: 'agent', tool: 'fixture-host', client_run_id: 'rule-ui-naming' },
  });
  const namingUrl = `${base}/${naming.rule_change_id}`;
  const namingCorrection = await post(namingUrl, {
    action: 'correct', language: 'zh-CN', date_policy: 'event_date', date_format: 'YYYY-MM-DD',
    summary: '测试参与者纠正：会议记录按事件日期使用完整年月日。',
    reason: 'fixture_user（测试参与者）纠正命名习惯。',
  });
  assert.equal(namingCorrection.status, 303);
  const correctedNamingUrl = new URL(namingCorrection.headers.get('location'), server.workspace_url).href;
  assert.equal(rules.preview(naming.rule_change_id).status, 'rejected');
  assert.equal((await post(correctedNamingUrl, {
    action: 'approve', reason: 'fixture_user（测试参与者）确认命名。',
  })).status, 303);
  const activeNaming = rules.active({ root }).find((rule) => rule.kind === 'naming');
  assert.equal(activeNaming.basis, 'user_instruction');
  assert.equal(activeNaming.value.date_policy, 'event_date');
  assert.equal(activeNaming.value.date_format, 'YYYY-MM-DD');

  const libraryRuleProposal = rules.propose({
    root,
    proposal: {
      kind: 'naming', scope: { type: 'library' },
      condition: { artifact_role: 'note' },
      value: { language: 'zh-CN', date_policy: 'semantic_only', date_format: 'YYYY-MM', rename_on_content_edit: false },
      summary: '测试参与者确认的库级命名规则', basis: 'user_instruction', confidence: 1,
      evidence: [],
    },
    caller: { actor: 'user', tool: 'fixture-user', client_run_id: 'library-rule-ui' },
  });
  assert.equal(rules.preview(libraryRuleProposal.rule_change_id).status, 'prepared');
  const libraryApproval = rules.approve(libraryRuleProposal.rule_change_id, {
    reason: 'fixture_user（测试参与者）确认作用范围',
  });
  const activeLibraryRule = rules.active({ root }).find((rule) => rule.rule_id === libraryApproval.rule_id);
  assert.ok(activeLibraryRule);
  assert.equal(activeLibraryRule.scope.type, 'library');
  const projectRulesPage = await (await fetch(base)).text();
  const otherProjectRulesPage = await (await fetch(`${server.workspace_url}projects/${otherProjectId}/rules`)).text();
  for (const page of [projectRulesPage, otherProjectRulesPage]) {
    assert.match(page, new RegExp(activeLibraryRule.rule_id, 'u'));
    assert.match(page, new RegExp(activeLibraryRule.rule_version_id, 'u'));
    assert.match(page, /Library/u);
    assert.match(page, /artifact_role/u);
    assert.match(page, /note/u);
    assert.match(page, /priority/u);
    assert.match(page, /request conditions and priority determine whether a rule matches/u);
    assert.match(page, new RegExp(`<dt>Priority<\\/dt><dd>${activeLibraryRule.priority}<\\/dd>`, 'u'));
    assert.match(page, /date_policy/u);
    assert.match(page, /YYYY-MM/u);
    assert.doesNotMatch(page, new RegExp(`href="[^"]*rules/${activeLibraryRule.rule_id}"`, 'u'));
  }
  assert.match(projectRulesPage, new RegExp(activeNaming.rule_id, 'u'));
  assert.match(projectRulesPage, new RegExp(activeNaming.rule_version_id, 'u'));
  assert.match(projectRulesPage, /artifact_role/u);
  assert.match(projectRulesPage, /date_policy/u);
  assert.match(projectRulesPage, /Priority/u);
  assert.doesNotMatch(otherProjectRulesPage, new RegExp(activeNaming.rule_id, 'u'));
  const libraryRuleUrl = `${base}/${activeLibraryRule.rule_id}`;
  assert.equal((await fetch(libraryRuleUrl)).status, 403);
  assert.equal((await fetch(libraryRuleUrl, {
    method: 'POST', body: new URLSearchParams({
      csrf, action: 'disable', expected_preview_revision: 'not-a-preview', reason: 'fixture_user test',
    }), redirect: 'manual',
  })).status, 403);
  assert.ok(rules.active({ root }).some((rule) => rule.rule_id === activeLibraryRule.rule_id));

  assert.equal(fs.readdirSync(path.join(projectPath, '01_文献')).length, 0);
  assert.equal(fs.readdirSync(path.join(projectPath, '02_会议纪要')).length, 0);

  const pageProposal = (index) => ({
    kind: 'placement', scope: { type: 'project', project_id: projectId },
    condition: { artifact_role: 'note' },
    value: { role: 'note', target_subdirectory: `目录-${index}` },
    summary: `HTML pending proposal ${index}`, basis: 'observed', confidence: 0.9,
    evidence: [{ path: '城市研究/01_文献', fact: `Fixture directory evidence ${index}.` }],
  });
  for (let index = 0; index < 52; index += 1) rules.propose({ root, proposal: pageProposal(index) });
  const firstPageResponse = await fetch(base);
  const firstPage = await firstPageResponse.text();
  assert.equal(firstPageResponse.status, 200);
  assert.match(firstPage, /HTML pending proposal 51(?!\d)/u);
  assert.match(firstPage, /HTML pending proposal 2(?!\d)/u);
  assert.doesNotMatch(firstPage, /HTML pending proposal 1(?!\d)/u);
  assert.match(firstPage, /Refresh latest/u);
  const cursorHref = firstPage.match(/href="([^"]*cursor=[^"]+)"/u)?.[1];
  assert.ok(cursorHref);
  const olderUrl = new URL(cursorHref.replaceAll('&amp;', '&'), server.workspace_url).href;
  const olderResponse = await fetch(olderUrl);
  const olderPage = await olderResponse.text();
  assert.equal(olderResponse.status, 200);
  assert.match(olderPage, /HTML pending proposal 1(?!\d)/u);
  assert.match(olderPage, /HTML pending proposal 0(?!\d)/u);
  assert.doesNotMatch(olderPage, /HTML pending proposal 2(?!\d)/u);
  rules.propose({ root, proposal: pageProposal(52) });
  const stableOlderPage = await (await fetch(olderUrl)).text();
  assert.match(stableOlderPage, /HTML pending proposal 1(?!\d)/u);
  assert.doesNotMatch(stableOlderPage, /HTML pending proposal 52(?!\d)/u);
  const refreshedPage = await (await fetch(base)).text();
  assert.match(refreshedPage, /HTML pending proposal 52(?!\d)/u);
});
