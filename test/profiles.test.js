import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Bootstrap } from '../src/bootstrap.js';
import { Derived } from '../src/derived.js';
import { ARTIFACT_ROLES, listLibraryProfiles } from '../src/profiles.js';
import { Registry } from '../src/registry.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = path.join(projectRoot, 'fixtures', 'bootstrap-vault');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const vault = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(caseRoot, { recursive: true });
  fs.cpSync(templateRoot, vault, { recursive: true });
  return { vault, stateDir };
}

test('bundled library profiles are versioned, semantic, and explain their routing', () => {
  const profiles = listLibraryProfiles();
  assert.deepEqual(profiles.map((profile) => profile.id), [
    'mixed-minimal',
    'personal-knowledge',
    'project-work',
    'research-writing',
  ]);
  for (const profile of profiles) {
    assert.match(profile.version, /^\d+\.\d+\.\d+$/u);
    assert.ok(profile.suitable_for.length >= 2);
    assert.ok(profile.areas.length >= 4);
    assert.ok(profile.areas.every((area) => area.purpose && area.durability === 'durable'));
    assert.ok(Object.keys(profile.derived_routes).length >= 5);
    assert.equal(profile.source_mutation_policy, 'recommend_only');
  }
  assert.ok(ARTIFACT_ROLES.some((role) => role.id === 'raw_input'));
  assert.ok(ARTIFACT_ROLES.some((role) => role.id === 'canonical'));
});

test('golden mixed Project Vault maps existing directories and recommends mixed-minimal deterministically', (t) => {
  const { vault, stateDir } = setup('bootstrap-golden-profile');
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  const contract = bootstrap.contract(scan.scan_id);

  assert.equal(contract.profile.id, 'mixed-minimal');
  assert.equal(contract.profile.selection, 'deterministic_recommendation');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'projects').current_path, 'Projects');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'library').current_path, 'Notes');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'archive').current_path, 'Archive');
  assert.equal(contract.status, 'ready');
  assert.ok(contract.questions.length <= 3);
  assert.deepEqual(contract.source_changes, []);
});

test('numbered Chinese personal Vault reuses its semantic zones instead of proposing a generic replacement tree', (t) => {
  const caseRoot = path.join(tempRoot, 'numbered-personal-profile');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const vault = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  for (const directory of [
    '00Templates', '01 就业与生活', '02 海外文案和广告业务', '03 学习',
    '04 工作项目', '05 媒体库', '06 随笔', '07 财务审计',
    '08 AI聊天记录', '09 自媒体选题思考', '10 Reports',
  ]) {
    fs.mkdirSync(path.join(vault, directory), { recursive: true });
    fs.writeFileSync(path.join(vault, directory, 'placeholder.md'), '# fixture\n', 'utf8');
  }
  for (const skill of ['context-budget', 'copy-editing']) {
    fs.mkdirSync(path.join(vault, 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(vault, 'skills', skill, 'SKILL.md'), `# ${skill}\n`, 'utf8');
  }
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  const contract = bootstrap.contract(scan.scan_id);

  assert.equal(contract.profile.id, 'personal-knowledge');
  assert.equal(contract.status, 'ready');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'projects').current_path, '04 工作项目');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'journal').current_path, '06 随笔');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'templates').current_path, '00Templates');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'outputs').current_path, '10 Reports');
  assert.deepEqual(contract.zones.find((zone) => zone.area_role === 'areas').candidates, [
    '01 就业与生活', '02 海外文案和广告业务', '03 学习', '07 财务审计', '09 自媒体选题思考',
  ]);
  assert.deepEqual(contract.zones.find((zone) => zone.area_role === 'resources').candidates, [
    '05 媒体库', '08 AI聊天记录',
  ]);
  assert.equal(contract.review_card.schema, 'atlas-library-contract-review-card.v1');
  assert.equal(contract.review_card.status, 'ready');
  assert.deepEqual(
    contract.review_card.current_map
      .filter((item) => item.role === 'resources')
      .map((item) => item.path),
    ['05 媒体库', '08 AI聊天记录'],
  );
  assert.deepEqual(
    contract.review_card.current_map.find((item) => item.path === '04 工作项目'),
    {
      path: '04 工作项目',
      role: 'projects',
      note: 'Active efforts with a finite outcome.',
      action: 'keep',
    },
  );
  assert.ok(contract.review_card.suggestions.some((item) => (
    item.role === 'inbox' && item.action === 'consider_create'
  )));
  assert.ok(contract.review_card.route_summary.some((item) => (
    item.destination === '04 工作项目'
    && item.roles.includes('draft')
    && item.roles.includes('intermediate')
  )));
  assert.deepEqual(contract.review_card.questions, []);
  assert.equal(contract.review_card.technical.contract_id, contract.contract_id);
  assert.equal(contract.review_card.technical.source_changes, 0);
  const skillCollection = bootstrap.show(scan.scan_id).predictions
    .find((prediction) => prediction.kind === 'agent_skill_collection');
  assert.equal(skillCollection.evidence.scope, 'library_local');
  assert.ok(!contract.suggestions.some((item) => ['Projects', 'Resources', 'Journal', 'Templates', 'Outputs']
    .includes(item.proposed_path)));
  assert.deepEqual(contract.source_changes, []);
});

test('code-heavy Website workspace selects Project Work even when a top-level skills directory exists', (t) => {
  const caseRoot = path.join(tempRoot, 'website-project-profile');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'root');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  const app = path.join(root, '01个人网站项目', '03 网站代码', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(root, '01个人网站项目', '00 规划文档'), { recursive: true });
  fs.mkdirSync(path.join(root, '01个人网站项目', '01 素材示意'), { recursive: true });
  fs.mkdirSync(path.join(root, '01个人网站项目', '02 动画演示'), { recursive: true });
  fs.mkdirSync(path.join(root, '.tools'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{}', 'utf8');
  for (let index = 0; index < 6; index += 1) {
    fs.writeFileSync(path.join(app, `component-${index}.tsx`), 'export {};\n', 'utf8');
  }
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  const scan = bootstrap.scan({ root, scanMode: 'structure' });
  const contract = bootstrap.contract(scan.scan_id);
  assert.equal(contract.profile.id, 'project-work');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'projects').current_path, '01个人网站项目');
  assert.deepEqual(
    contract.review_card.directory_map
      .filter((item) => item.path.startsWith('01个人网站项目/'))
      .map((item) => [item.path, item.kind]),
    [
      ['01个人网站项目/00 规划文档', 'planning'],
      ['01个人网站项目/01 素材示意', 'sources'],
      ['01个人网站项目/02 动画演示', 'experiments'],
      ['01个人网站项目/03 网站代码', 'implementation'],
    ],
  );
  assert.equal(
    contract.review_card.directory_map.find((item) => item.path === '.tools').kind,
    'local_tooling',
  );
});

test('a code tool repository can map its own root as the Project Work project area', (t) => {
  const caseRoot = path.join(tempRoot, 'tool-root-project-profile');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'root');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(root, 'asset-library'), { recursive: true });
  fs.mkdirSync(path.join(root, 'template-library'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}', 'utf8');
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  const scan = bootstrap.scan({ root, scanMode: 'structure' });
  const contract = bootstrap.contract(scan.scan_id);
  assert.equal(contract.profile.id, 'project-work');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'projects').current_path, '.');
  assert.equal(contract.zones.find((zone) => zone.area_role === 'templates').current_path, 'template-library');
  assert.equal(contract.review_card.directory_map.find((item) => item.path === 'src').kind, 'implementation');
  assert.equal(contract.review_card.directory_map.find((item) => item.path === 'reports').kind, 'outputs');
  assert.equal(contract.review_card.directory_map.find((item) => item.path === 'asset-library').kind, 'reusable_assets');
});

test('Bootstrap recommends a reviewable default profile and activates an immutable environment policy', (t) => {
  const { vault, stateDir } = setup('bootstrap-default-profile');
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });

  const first = bootstrap.recommend(scan.scan_id, { profileId: 'project-work' });
  const repeated = bootstrap.recommend(scan.scan_id, { profileId: 'project-work' });
  assert.equal(first.reused, false);
  assert.equal(repeated.reused, true);
  assert.equal(first.profile_id, 'project-work');
  assert.ok(first.prediction_ids.length >= 2);
  assert.equal(first.structure_plan.source_changes.length, 0);
  assert.ok(first.structure_plan.operations.every((operation) => operation.execution === 'not_authorized'));

  const detail = bootstrap.show(scan.scan_id);
  const defaults = detail.predictions.filter((prediction) => prediction.source === 'atlas-default');
  assert.ok(defaults.some((prediction) => prediction.kind === 'library_profile_candidate'));
  assert.ok(defaults.some((prediction) => prediction.kind === 'structure_plan_candidate'));

  for (const prediction of detail.predictions) {
    bootstrap.review(prediction.id, {
      decision: prediction.source === 'atlas-default' ? 'accepted' : 'rejected',
      reason: 'Fixture profile review',
    });
  }
  const initialized = bootstrap.initialize(scan.scan_id);
  assert.equal(initialized.profile_id, 'project-work');
  assert.match(initialized.active_rule_version_id, /^RULE-ENV-/u);
  assert.ok(fs.existsSync(path.join(initialized.output_dir, 'library-profile.json')));
  assert.ok(fs.existsSync(path.join(initialized.output_dir, 'structure-plan.json')));
  assert.equal(bootstrap.show(scan.scan_id).active_policy.profile_id, 'project-work');
  assert.throws(
    () => bootstrap.review(defaults[0].id, { decision: 'rejected', reason: 'too late' }),
    /initialized|new scan/i,
  );
  const nextVersion = bootstrap.scan({ root: vault, scanMode: 'structure', forceNew: true });
  assert.notEqual(nextVersion.scan_id, scan.scan_id);
  assert.equal(nextVersion.forced_new_scan, true);
});

test('Bootstrap compacts Profile evidence into one Library Contract approval without changing the source', (t) => {
  const { vault, stateDir } = setup('bootstrap-library-contract');
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  const before = listVaultPaths(vault);
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });

  const contract = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  assert.equal(contract.schema, 'atlas-library-contract-candidate.v1');
  assert.match(contract.contract_id, /^CONTRACT-[a-f0-9]{16}$/u);
  assert.equal(contract.profile.id, 'project-work');
  assert.equal(contract.status, 'ready');
  assert.ok(contract.zones.some((zone) => zone.area_role === 'projects'));
  assert.ok(contract.routes.some((route) => route.role === 'draft' && route.area === 'projects'));
  assert.ok(contract.questions.length <= 3);
  assert.deepEqual(contract.source_changes, []);
  assert.ok(contract.approval.prediction_ids.length >= 2);
  assert.ok(contract.approval.deferred_prediction_count > 0);

  const initialized = bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id,
    profileId: 'project-work',
    reason: 'Use this Project layout as the first routing contract.',
  });
  assert.equal(initialized.status, 'initialized');
  assert.equal(initialized.contract_id, contract.contract_id);
  assert.equal(initialized.profile_id, 'project-work');
  assert.match(initialized.active_rule_version_id, /^RULE-ENV-/u);
  assert.deepEqual(listVaultPaths(vault), before);

  const detail = bootstrap.show(scan.scan_id);
  const contractPredictions = new Set(contract.approval.prediction_ids);
  assert.ok(detail.predictions
    .filter((prediction) => contractPredictions.has(prediction.id))
    .every((prediction) => prediction.review?.decision === 'accepted'));
  assert.ok(detail.predictions
    .filter((prediction) => !contractPredictions.has(prediction.id))
    .every((prediction) => prediction.review?.decision === 'deferred'));
  assert.equal(detail.active_policy.library_contract.contract_id, contract.contract_id);
  assert.equal(detail.active_policy.library_contract.profile_id, 'project-work');
  assert.deepEqual(detail.active_policy.library_contract.source_changes, []);

  const repeated = bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id,
    profileId: 'project-work',
    reason: 'Use this Project layout as the first routing contract.',
  });
  assert.deepEqual(repeated, initialized);
});

test('Bootstrap refuses a stale or invented Library Contract before recording review Labels', (t) => {
  const { vault, stateDir } = setup('bootstrap-library-contract-stale');
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  bootstrap.contract(scan.scan_id, { profileId: 'project-work' });

  assert.throws(() => bootstrap.adoptContract(scan.scan_id, {
    contractId: 'CONTRACT-0000000000000000',
    profileId: 'project-work',
    reason: 'This must not be accepted.',
  }), /contract.*changed|stale|does not match/i);
  const detail = bootstrap.show(scan.scan_id);
  assert.equal(detail.scan.status, 'scanned');
  assert.ok(detail.predictions.every((prediction) => prediction.review == null));
});

test('Library Contract adoption resumes after a partial review and preserves accepted custom rules', (t) => {
  const { vault, stateDir } = setup('bootstrap-library-contract-resume');
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  bootstrap.propose(scan.scan_id, {
    caller: { actor: 'agent', agent: 'Codex', tool: 'test' },
    predictions: [{
      kind: 'routing_rule_candidate',
      summary: 'Keep Atlas reports in the Atlas Project root.',
      confidence: 0.9,
      risk: 'low',
      affected_paths: ['Projects/Atlas'],
      evidence: { role: 'report', target_directory: 'Projects/Atlas' },
      proposed_action: 'Use this route only after explicit review.',
    }],
  });
  const contract = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  const detail = bootstrap.show(scan.scan_id);
  const custom = detail.predictions.find((prediction) => prediction.source === 'agent');
  bootstrap.review(custom.id, { decision: 'accepted', reason: 'Keep the reviewed custom route.' });
  bootstrap.review(contract.approval.prediction_ids[0], {
    decision: 'accepted',
    reason: 'Simulate a partially completed Contract adoption.',
  });

  const rebuilt = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  assert.equal(rebuilt.contract_id, contract.contract_id);
  const initialized = bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id,
    profileId: 'project-work',
    reason: 'Resume and adopt the same Contract.',
  });
  assert.equal(initialized.accepted_agent_predictions, 1);
  const finalDetail = bootstrap.show(scan.scan_id);
  assert.equal(finalDetail.predictions.find((prediction) => prediction.id === custom.id).review.decision, 'accepted');
  assert.equal(finalDetail.active_policy.policy.custom_routing_rules.length, 1);
});

test('Library Contract asks instead of guessing when one semantic area has multiple directory candidates', (t) => {
  const { vault, stateDir } = setup('bootstrap-library-contract-ambiguous');
  fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(vault, '项目'), { recursive: true });
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  const contract = bootstrap.contract(scan.scan_id, { profileId: 'project-work' });
  assert.equal(contract.status, 'needs_input');
  assert.ok(contract.questions.some((question) => question.area_role === 'projects'));
  assert.ok(contract.questions.length <= 3);
  assert.throws(() => bootstrap.adoptContract(scan.scan_id, {
    contractId: contract.contract_id,
    profileId: 'project-work',
    reason: 'Atlas must not guess this mapping.',
  }), /needs input/i);
  assert.equal(bootstrap.show(scan.scan_id).scan.status, 'scanned');
});

test('Derived uses the active profile for placement recommendations and warns on a route mismatch', (t) => {
  const { vault, stateDir } = setup('derived-profile-routing');
  const registry = new Registry({ stateDir });
  registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' });
  registry.dispose();
  const bootstrap = new Bootstrap({ stateDir });
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  bootstrap.recommend(scan.scan_id, { profileId: 'project-work' });
  for (const prediction of bootstrap.show(scan.scan_id).predictions) {
    bootstrap.review(prediction.id, {
      decision: prediction.source === 'atlas-default' ? 'accepted' : 'rejected',
      reason: 'Fixture profile review',
    });
  }
  bootstrap.initialize(scan.scan_id);
  bootstrap.dispose();

  const derived = new Derived({ stateDir });
  t.after(() => derived.dispose());
  const projects = derived.ledger.listProjects();
  const project = projects.find((item) => item.current_path === 'Projects/Atlas');
  assert.ok(project);
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Outputs'), { recursive: true });

  const recommendation = derived.recommend({
    root: vault,
    inputs: ['Projects/Atlas/Overview.md'],
    role: 'report',
    filename: 'summary.md',
  });
  assert.equal(recommendation.status, 'ready');
  assert.equal(recommendation.project_id, project.id);
  assert.equal(recommendation.target, 'Projects/Atlas/Outputs/summary.md');
  assert.equal(recommendation.rule_version_id, bootstrapPolicyRuleId(derived, vault));

  const prepared = derived.prepare({
    root: vault,
    inputs: ['Projects/Atlas/Overview.md'],
    target: 'Projects/Atlas/manual-summary.md',
    candidateContent: '# Summary\n',
    projectId: project.id,
    role: 'report',
  });
  assert.equal(prepared.placement_policy.decision, 'warn');
  assert.equal(derived.preview(prepared.run_id).placement.policy.decision, 'warn');
  assert.throws(() => derived.prepare({
    root: vault,
    inputs: ['Projects/Atlas/Overview.md'],
    target: 'Projects/Atlas/unknown.md',
    candidateContent: 'x',
    projectId: project.id,
    role: 'made_up_role',
  }), /supported role/i);
});

test('an accepted custom routing Prediction overrides the bundled Profile route inside the same Project', (t) => {
  const { vault, stateDir } = setup('derived-custom-routing');
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' });
  registry.dispose();
  const bootstrap = new Bootstrap({ stateDir });
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  bootstrap.recommend(scan.scan_id, { profileId: 'project-work' });
  bootstrap.propose(scan.scan_id, {
    caller: { actor: 'agent', agent: 'Codex', tool: 'test' },
    predictions: [{
      kind: 'routing_rule_candidate',
      summary: 'Keep reviewed reports in the Atlas Project root.',
      confidence: 0.9,
      risk: 'medium',
      affected_paths: ['Projects/Atlas'],
      evidence: { role: 'report', target_directory: 'Projects/Atlas' },
      proposed_action: 'Override the bundled Outputs subdirectory for this Project route.',
    }],
  });
  for (const prediction of bootstrap.show(scan.scan_id).predictions) {
    bootstrap.review(prediction.id, {
      decision: ['atlas-default', 'agent'].includes(prediction.source) ? 'accepted' : 'rejected',
      reason: 'Fixture custom routing review',
    });
  }
  bootstrap.initialize(scan.scan_id);
  bootstrap.dispose();

  const derived = new Derived({ stateDir });
  t.after(() => derived.dispose());
  const recommendation = derived.recommend({
    root: vault,
    inputs: ['Projects/Atlas/Overview.md'],
    projectId: project.project_id,
    role: 'report',
    filename: 'custom.md',
  });
  assert.equal(recommendation.status, 'ready');
  assert.equal(recommendation.target, 'Projects/Atlas/custom.md');
  assert.equal(recommendation.route.source, 'reviewed_custom_routing_prediction');
});

test('conflicting accepted custom routes stay unresolved instead of silently choosing one', (t) => {
  const { vault, stateDir } = setup('derived-routing-conflict');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Outputs'), { recursive: true });
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' });
  registry.dispose();
  const bootstrap = new Bootstrap({ stateDir });
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  bootstrap.recommend(scan.scan_id, { profileId: 'project-work' });
  bootstrap.propose(scan.scan_id, {
    caller: { actor: 'agent', agent: 'Codex', tool: 'test' },
    predictions: ['Projects/Atlas', 'Projects/Atlas/Outputs'].map((targetDirectory) => ({
      kind: 'routing_rule_candidate',
      summary: `Route reports to ${targetDirectory}.`,
      confidence: 0.8,
      risk: 'medium',
      affected_paths: [targetDirectory],
      evidence: { role: 'report', target_directory: targetDirectory },
      proposed_action: 'Review this competing route.',
    })),
  });
  for (const prediction of bootstrap.show(scan.scan_id).predictions) {
    bootstrap.review(prediction.id, {
      decision: ['atlas-default', 'agent'].includes(prediction.source) ? 'accepted' : 'rejected',
      reason: 'Fixture conflict setup',
    });
  }
  bootstrap.initialize(scan.scan_id);
  bootstrap.dispose();

  const derived = new Derived({ stateDir });
  t.after(() => derived.dispose());
  const recommendation = derived.recommend({
    root: vault,
    inputs: ['Projects/Atlas/Overview.md'],
    projectId: project.project_id,
    role: 'report',
    filename: 'conflict.md',
  });
  assert.equal(recommendation.status, 'unresolved');
  assert.match(recommendation.reason, /conflict/i);
  assert.equal(recommendation.route_candidates.length, 2);
});

function bootstrapPolicyRuleId(derived, vault) {
  return derived.ledger.getActiveEnvironmentPolicy(path.resolve(vault)).rule_version_id;
}

function listVaultPaths(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}
