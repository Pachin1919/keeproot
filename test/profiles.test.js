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
