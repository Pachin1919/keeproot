import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'bin', 'atlas.js');
const skillRoot = path.join(projectRoot, '.agents', 'skills', 'atlas-file-governance');
const fixtureRoot = path.join(projectRoot, 'fixtures', 'vault-template');
const tempRoot = path.join(projectRoot, 'test', '.tmp');

function setup(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const vault = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(caseRoot, { recursive: true });
  fs.cpSync(fixtureRoot, vault, { recursive: true });
  return { caseRoot, vault, stateDir };
}

function agentCli(stateDir, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    cwd: projectRoot,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, ATLAS_STATE_DIR: stateDir },
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.protocol_version, 'atlas-cli.v1');
  assert.equal(envelope.ok, true);
  return envelope.data;
}

const callerArgs = [
  '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5',
  '--tool', 'atlas-skill-test', '--client-run-id', 'skill-e2e-001',
];
const expectedCaller = {
  actor: 'agent',
  agent: 'Codex',
  model: 'gpt-5',
  tool: 'atlas-skill-test',
  client_run_id: 'skill-e2e-001',
};

test('repository Agent Skill is complete, project-local, and references the implemented protocol', () => {
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const metadata = fs.readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
  const protocol = fs.readFileSync(path.join(skillRoot, 'references', 'cli-protocol.md'), 'utf8');
  const workflows = fs.readFileSync(path.join(skillRoot, 'references', 'workflows.md'), 'utf8');

  assert.match(skill, /^---\r?\nname: atlas-file-governance\r?\ndescription: .+\r?\n---/);
  assert.doesNotMatch(`${skill}\n${metadata}\n${protocol}\n${workflows}`, /\bTODO\b|\[TODO/);
  assert.match(metadata, /\$atlas-file-governance/);
  assert.match(metadata, /Atlas 0\.1/);
  assert.match(skill, /runtime_required/);
  assert.match(skill, /does not yet provide an automatic installer/);
  assert.match(protocol, /atlas-cli\.v1/);
  assert.match(protocol, /ATLAS_ROLLBACK_CONFLICT/);
  assert.match(skill, /--scan-mode structure/);
  assert.match(workflows, /--scan-mode structure/);
  for (const command of [
    'bootstrap scan', 'bootstrap profiles', 'bootstrap recommend', 'bootstrap context',
    'bootstrap propose', 'begin', 'close', 'show', 'abort', 'rollback', 'guarded prepare',
    'derive recommend', 'derive prepare', 'derive preview', 'derive revise', 'derive promote',
    'work stage', 'storage plan',
  ]) {
    assert.match(workflows, new RegExp(command.replace(' ', '\\s+')));
  }
  assert.ok(skill.split(/\r?\n/).length < 500);
  assert.equal(path.dirname(skillRoot), path.join(projectRoot, '.agents', 'skills'));
});

test('Skill command sequence completes Agent Bootstrap, Derived, Tracked Direct, and Guarded with JSON-only reconciliation', () => {
  const { caseRoot, vault, stateDir } = setup('skill-agent-e2e');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true });
  const baselineA = fs.readFileSync(path.join(vault, 'allowed-a.md'), 'utf8');
  const baselineB = fs.readFileSync(path.join(vault, 'allowed-b.md'), 'utf8');

  assert.equal(agentCli(stateDir, ['version']).version, '0.1.0');
  assert.equal(agentCli(stateDir, ['doctor']).status, 'ok');
  const capabilities = agentCli(stateDir, ['capabilities']);
  assert.ok(capabilities.workflows.bootstrap.includes('scan'));
  assert.deepEqual(capabilities.bootstrap_scan_modes, ['structure', 'metadata']);
  assert.ok(capabilities.workflows.tracked_direct.includes('rollback'));
  assert.ok(capabilities.workflows.guarded.includes('execute'));
  assert.ok(capabilities.workflows.bootstrap.includes('propose'));
  assert.ok(capabilities.workflows.bootstrap.includes('recommend'));
  assert.ok(capabilities.workflows.derived.includes('execute'));
  assert.ok(capabilities.workflows.derived.includes('promote'));
  assert.ok(capabilities.workflows.work.includes('stage'));
  assert.ok(capabilities.workflows.storage.includes('plan'));
  assert.ok(capabilities.derived_relation_types.includes('summarizes'));
  assert.ok(capabilities.derived_roles.includes('canonical'));

  const scan = agentCli(stateDir, [
    'bootstrap', 'scan', '--root', vault, '--scan-mode', 'structure', ...callerArgs,
  ]);
  assert.equal(scan.scan_mode, 'structure');
  assert.equal(scan.content_files_read, 0);
  const context = agentCli(stateDir, ['bootstrap', 'context', scan.scan_id, '--max-samples', '2']);
  assert.equal(context.content_included, false);
  assert.ok(context.areas.every((area) => area.sample_paths.length <= 2));
  assert.equal(agentCli(stateDir, ['bootstrap', 'profiles']).profiles.length, 4);
  const recommendedProfile = agentCli(stateDir, [
    'bootstrap', 'recommend', scan.scan_id, '--profile', 'project-work',
  ]);
  assert.equal(recommendedProfile.profile_id, 'project-work');
  const proposalPath = path.join(stateDir, 'bootstrap-proposal.json');
  fs.writeFileSync(proposalPath, JSON.stringify({ predictions: [{
    kind: 'routing_rule_candidate',
    summary: 'Route generated Atlas reports to the Atlas Project.',
    confidence: 0.9,
    risk: 'low',
    affected_paths: ['Projects/Atlas'],
    evidence: { role: 'report', target_directory: 'Projects/Atlas' },
    proposed_action: 'Use Projects/Atlas for reviewed report outputs.',
  }] }), 'utf8');
  const proposed = agentCli(stateDir, [
    'bootstrap', 'propose', scan.scan_id, '--proposal-file', proposalPath, ...callerArgs,
  ]);
  assert.equal(proposed.prediction_ids.length, 1);
  let scanDetail = agentCli(stateDir, ['bootstrap', 'show', scan.scan_id]);
  assert.deepEqual(scanDetail.scan.caller, expectedCaller);
  for (const prediction of scanDetail.predictions) {
    agentCli(stateDir, [
      'bootstrap', 'review', prediction.id, '--accept', '--reason', 'Fixture E2E approval',
    ]);
  }
  const initialized = agentCli(stateDir, ['bootstrap', 'initialize', scan.scan_id]);
  assert.equal(initialized.status, 'initialized');
  assert.match(initialized.active_rule_version_id, /^RULE-ENV-/u);
  scanDetail = agentCli(stateDir, ['bootstrap', 'show', scan.scan_id]);
  assert.equal(scanDetail.scan.status, 'initialized');
  assert.equal(scanDetail.predictions.find((item) => item.id === proposed.prediction_ids[0]).source, 'agent');

  const project = agentCli(stateDir, [
    'project', 'create', '--name', 'Atlas', '--path', 'Projects/Atlas',
  ]);
  const candidateDir = path.join(stateDir, 'candidates');
  fs.mkdirSync(candidateDir, { recursive: true });
  const derivedCandidate = path.join(candidateDir, 'generated-report.md');
  fs.writeFileSync(derivedCandidate, '# Skill Derived report\n', 'utf8');
  const staged = agentCli(stateDir, [
    'work', 'stage', '--file', derivedCandidate, '--kind', 'candidate', '--ttl-hours', '24',
  ]);
  const recommendedTarget = agentCli(stateDir, [
    'derive', 'recommend', '--root', vault, '--input', 'allowed-a.md',
    '--project', project.project_id, '--role', 'report', '--filename', 'generated-report.md',
  ]);
  assert.equal(recommendedTarget.target, 'Projects/Atlas/generated-report.md');
  const derived = agentCli(stateDir, [
    'derive', 'prepare', '--root', vault, '--input', 'allowed-a.md',
    '--target', recommendedTarget.target, '--candidate-file', staged.payload_path,
    '--project', project.project_id, '--role', 'report', '--relation', 'summarizes',
    '--intent', 'Skill Derived', ...callerArgs,
  ]);
  let derivedDetail = agentCli(stateDir, ['derive', 'preview', derived.run_id]);
  assert.deepEqual(derivedDetail.run.caller, expectedCaller);
  assert.equal(derivedDetail.placement_prediction.review, null);
  agentCli(stateDir, ['derive', 'approve', derived.run_id, '--reason', 'Fixture placement approval']);
  agentCli(stateDir, ['derive', 'execute', derived.run_id]);
  derivedDetail = agentCli(stateDir, ['derive', 'preview', derived.run_id]);
  assert.equal(derivedDetail.output.role, 'report');
  assert.equal(derivedDetail.lineage[0].relation_type, 'summarizes');
  const promoted = agentCli(stateDir, [
    'derive', 'promote', derived.run_id, '--role', 'canonical', '--reason', 'Fixture formal output',
  ]);
  assert.equal(promoted.content_changed, false);
  assert.equal(agentCli(stateDir, ['derive', 'preview', derived.run_id]).output.role, 'canonical');
  assert.equal(agentCli(stateDir, ['work', 'status', staged.work_id]).status, 'captured');
  assert.ok(agentCli(stateDir, ['storage', 'plan', '--older-than-hours', '0']).work_items
    .some((item) => item.work_id === staged.work_id));
  agentCli(stateDir, ['derive', 'rollback', derived.run_id]);
  assert.equal(fs.existsSync(path.join(vault, 'Projects', 'Atlas', 'generated-report.md')), false);

  const began = agentCli(stateDir, [
    'begin', '--root', vault, '--allow', 'allowed-a.md', '--intent', 'Skill Tracked Direct',
    ...callerArgs,
  ]);
  fs.writeFileSync(path.join(vault, 'allowed-a.md'), `${baselineA}\nSkill edit.\n`, 'utf8');
  const closed = agentCli(stateDir, ['close', began.run_id]);
  assert.equal(closed.policy, 'pass');
  const shown = agentCli(stateDir, ['show', began.run_id]);
  assert.deepEqual(shown.run.caller, expectedCaller);
  assert.equal(shown.changes.length, 1);
  agentCli(stateDir, ['rollback', began.run_id]);
  assert.equal(fs.readFileSync(path.join(vault, 'allowed-a.md'), 'utf8'), baselineA);

  const candidatePath = path.join(candidateDir, 'allowed-b.md');
  fs.writeFileSync(candidatePath, '# Skill Guarded candidate\n', 'utf8');
  const prepared = agentCli(stateDir, [
    'guarded', 'prepare', '--root', vault, '--target', 'allowed-b.md',
    '--candidate-file', candidatePath, '--intent', 'Skill Guarded', ...callerArgs,
  ]);
  const preview = agentCli(stateDir, ['guarded', 'preview', prepared.run_id]);
  assert.deepEqual(preview.run.caller, expectedCaller);
  assert.equal(preview.run.status, 'prepared');
  agentCli(stateDir, ['guarded', 'approve', prepared.run_id, '--reason', 'Fixture E2E approval']);
  const executed = agentCli(stateDir, ['guarded', 'execute', prepared.run_id]);
  assert.equal(executed.verified, true);
  assert.equal(fs.readFileSync(path.join(vault, 'allowed-b.md'), 'utf8'), '# Skill Guarded candidate\n');
  agentCli(stateDir, ['guarded', 'rollback', prepared.run_id]);
  assert.equal(fs.readFileSync(path.join(vault, 'allowed-b.md'), 'utf8'), baselineB);
  assert.equal(fs.existsSync(path.join(caseRoot, 'vault', '.atlas')), false);
});
