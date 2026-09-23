import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installRuntime } from '../src/runtime-install.js';
import { InstalledSkillDriver } from '../test-support/installed-skill-driver.js';

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

test('repository Agent Skill is a complete user-installable source and references the implemented protocol', () => {
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const metadata = fs.readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
  const protocol = fs.readFileSync(path.join(skillRoot, 'references', 'cli-protocol.md'), 'utf8');
  const workflows = fs.readFileSync(path.join(skillRoot, 'references', 'workflows.md'), 'utf8');
  const currentResource = fs.readFileSync(path.join(skillRoot, 'references', 'current-resource.md'), 'utf8');
  const currentSave = fs.readFileSync(path.join(skillRoot, 'references', 'current-save.md'), 'utf8');
  const currentTableWork = fs.readFileSync(path.join(skillRoot, 'references', 'current-table-work.md'), 'utf8');

  assert.match(skill, /^---\r?\nname: atlas-file-governance\r?\ndescription: .+\r?\n---/);
  assert.doesNotMatch(`${skill}\n${metadata}\n${protocol}\n${workflows}\n${currentResource}\n${currentSave}\n${currentTableWork}`, /\bTODO\b|\[TODO/);
  assert.match(metadata, /\$atlas-file-governance/);
  assert.match(metadata, /Atlas File Governance/);
  assert.match(skill, /installed Atlas Runtime/u);
  assert.match(skill, /Do not use for Atlas source development/u);
  assert.doesNotMatch(skill, /Trigger for Atlas/u);
  assert.match(skill, /runtime_required/);
  assert.match(skill, /install-atlas\.ps1 install/);
  assert.match(skill, /15-second timeout/);
  assert.ok(fs.existsSync(path.join(skillRoot, 'scripts', 'locate-atlas.ps1')));
  assert.ok(fs.existsSync(path.join(skillRoot, 'scripts', 'capture-browser-page.mjs')));
  assert.ok(fs.existsSync(path.join(skillRoot, 'scripts', 'intake-attached-file.ps1')));
  assert.match(protocol, /atlas-cli\.v1/);
  assert.match(protocol, /ATLAS_ROLLBACK_CONFLICT/);
  assert.match(protocol, /Current product namespaces/u);
  assert.match(protocol, /`content`/u);
  assert.match(protocol, /`save`/u);
  assert.match(skill, /structured content/u);
  assert.match(skill, /do not ask the model to count rows/iu);
  assert.match(skill, /one review path/u);
  assert.match(skill, /Never fall back/u);
  assert.doesNotMatch(skill, /legacy-compatibility\.md/u);
  assert.match(currentResource, /content inspect/u);
  assert.match(currentResource, /content compare/u);
  assert.match(currentSave, /save prepare/u);
  assert.match(currentSave, /save execute/u);
  assert.match(currentSave, /save undo/u);
  assert.match(currentSave, /save redo/u);
  assert.match(currentSave, /atlas\.save-result\.v1/u);
  assert.match(skill, /current-table-work\.md/u);
  for (const command of ['table-work start', 'table-work prepare', 'table-work align', 'table-work recipe', 'table-work preview', 'table-work save', 'save undo', 'save redo']) {
    assert.match(currentTableWork, new RegExp(command.replace(' ', '\\s+')));
  }
  assert.match(workflows, /supporting reference, not the default route/u);
  for (const command of [
    'save prepare', 'save execute', 'save undo', 'save redo',
    'content inspect', 'content compare', 'project list', 'project show',
    'resource relationships submit',
  ]) {
    assert.match(workflows, new RegExp(command.replace(' ', '\\s+')));
  }
  assert.match(workflows, /Do not route to removed Task, Task Review, Analytics, Agent Lifecycle, SessionStart Hook/u);
  assert.doesNotMatch(`${skill}\n${protocol}\n${workflows}`, /task show|analytics export|agent propose|ui --task/iu);
  assert.ok(Buffer.byteLength(skill, 'utf8') < 3000);
  assert.equal(path.dirname(skillRoot), path.join(projectRoot, '.agents', 'skills'));
});

test('Skill attachment Intake script preserves spaced Chinese paths and returns one compact receipt', {
  skip: process.platform !== 'win32',
}, () => {
  const { caseRoot, vault } = setup('skill-attachment-intake-script');
  const projectPath = path.join(vault, 'Projects', 'PPTgen');
  const targetDirectory = path.join(projectPath, 'input', 'prior-reports');
  fs.mkdirSync(targetDirectory, { recursive: true });

  const candidate = path.join(caseRoot, 'JMC 海外社交媒体 – 2026年第二季度报告V2.pptx');
  fs.writeFileSync(candidate, 'fixture-pptx-bytes', 'utf8');
  const installRoot = path.join(caseRoot, 'installed-atlas');
  const installedSkillRoot = path.join(caseRoot, 'installed-skill', 'atlas-file-governance');
  const installation = installRuntime({
    sourceRoot: projectRoot,
    installRoot,
    skillRoot: installedSkillRoot,
    nodePath: process.execPath,
  });

  const powershell = path.join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'PowerShell', '7', 'pwsh.exe',
  );
  assert.ok(fs.existsSync(powershell), `PowerShell 7 is required for this Windows Skill test: ${powershell}`);
  const script = path.join(installedSkillRoot, 'scripts', 'intake-attached-file.ps1');
  const result = spawnSync(powershell, [
    '-NoProfile', '-File', script,
    '-InstallRoot', installRoot,
    '-CandidateFile', candidate,
    '-Root', vault,
    '-Target', 'Projects/PPTgen/input/prior-reports/JMC 海外社交媒体 – 2026年第二季度报告V2.pptx',
    '-Origin', 'human_submitted',
    '-Kind', 'source',
    '-ProjectName', 'PPTgen',
    '-ProjectPath', 'Projects/PPTgen',
    '-CreateProjectIfMissing',
    '-Intent', 'Keep the coworker revision as a source.',
    '-Reason', 'The current user task authorizes this exact placement.',
    '-Agent', 'Codex',
    '-Model', 'gpt-5.6',
    '-Tool', 'skill-script-test',
    '-ClientRunId', 'attachment-intake-script-001',
  ], {
    cwd: projectRoot,
    windowsHide: true,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, 'executed');
  assert.equal(receipt.project.created, true);
  assert.equal(receipt.hash_match, true);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.rollback_ready, true);
  assert.equal(receipt.atlas_calls, 4);
  assert.equal(receipt.runtime_processes, 2);
  assert.equal(receipt.model_visible_body_bytes, 0);
  assert.equal(receipt.ppt_body_reads, 0);
  assert.equal(
    fs.readFileSync(path.join(vault, receipt.target), 'utf8'),
    'fixture-pptx-bytes',
  );

  agentCli(installation.state_dir, ['save', 'undo', receipt.run_id]);
  assert.equal(fs.existsSync(path.join(vault, receipt.target)), false);
});

test('Skill command sequence completes Agent Bootstrap, Derived, Tracked Direct, and Guarded with JSON-only reconciliation', () => {
  const { caseRoot, vault, stateDir } = setup('skill-agent-e2e');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true });
  const baselineA = fs.readFileSync(path.join(vault, 'allowed-a.md'), 'utf8');
  const baselineB = fs.readFileSync(path.join(vault, 'allowed-b.md'), 'utf8');

  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  ).version;
  assert.equal(agentCli(stateDir, ['version']).version, packageVersion);
  assert.equal(agentCli(stateDir, ['doctor']).status, 'ok');
  const capabilities = agentCli(stateDir, ['capabilities']);
  assert.ok(capabilities.workflows.bootstrap.includes('scan'));
  assert.deepEqual(capabilities.workflows.content, ['inspect', 'compare', 'branches', 'prepare-data', 'localize-conversation']);
  assert.deepEqual(capabilities.bootstrap_scan_modes, ['structure', 'metadata']);
  assert.ok(capabilities.workflows.tracked_direct.includes('rollback'));
  assert.ok(capabilities.workflows.guarded.includes('execute'));
  assert.ok(capabilities.workflows.guarded.includes('apply-approved'));
  assert.ok(capabilities.workflows.bootstrap.includes('propose'));
  assert.ok(capabilities.workflows.bootstrap.includes('recommend'));
  assert.ok(capabilities.workflows.bootstrap.includes('contract'));
  assert.ok(capabilities.workflows.bootstrap.includes('adopt'));
  assert.deepEqual(capabilities.workflows.save, ['prepare', 'show', 'execute', 'undo', 'redo']);
  assert.deepEqual(capabilities.workflows.table_work, ['start', 'show', 'reuse', 'reconcile', 'reconcile-batch', 'add-source', 'remove-source', 'prepare', 'sheet', 'align', 'recipe', 'preview', 'save', 'list']);
  assert.equal(capabilities.workflows.intake.includes('execute'), false);
  assert.deepEqual(capabilities.workflows.capture, ['fetch', 'localize', 'sample']);
  assert.equal(capabilities.browser_capture.maximum_sample_characters, 4000);
  assert.ok(capabilities.workflows.evolution.includes('execute'));
  assert.deepEqual(capabilities.evolution_operations, [
    'create_directory', 'move_file', 'migrate_project', 'migrate_directory',
    'migrate_cross_root',
    'remove_empty_directory',
  ]);
  assert.ok(capabilities.workflows.registry.includes('evolve'));
  assert.deepEqual(capabilities.intake_origins, [
    'human_submitted', 'human_written', 'agent_generated', 'download',
  ]);
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

test('Skill can adopt one compact Library Contract through the JSON CLI', () => {
  const { vault, stateDir } = setup('skill-library-contract');
  const before = fs.readdirSync(vault, { recursive: true }).sort();
  const scan = agentCli(stateDir, [
    'bootstrap', 'scan', '--root', vault, '--scan-mode', 'structure', ...callerArgs,
  ]);
  const contract = agentCli(stateDir, [
    'bootstrap', 'contract', scan.scan_id, '--profile', 'project-work',
  ]);
  assert.equal(contract.status, 'ready');
  assert.equal(contract.questions.length, 0);
  assert.deepEqual(contract.source_changes, []);

  const adopted = agentCli(stateDir, [
    'bootstrap', 'adopt', scan.scan_id,
    '--contract', contract.contract_id,
    '--profile', 'project-work',
    '--reason', 'Skill fixture accepts the compact Contract.',
  ]);
  assert.equal(adopted.contract_id, contract.contract_id);
  assert.equal(adopted.status, 'initialized');
  assert.deepEqual(fs.readdirSync(vault, { recursive: true }).sort(), before);
});

test('Skill completes one reviewed physical Evolution and reconciles through Preview', () => {
  const { vault, stateDir } = setup('skill-evolution');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true });
  const prepared = agentCli(stateDir, [
    'evolve', 'prepare', '--root', vault, '--operation', 'create_directory',
    '--target', 'Projects/Atlas/Working', '--intent', 'Create the missing Contract area.',
    ...callerArgs,
  ]);
  assert.equal(prepared.requires_approval, true);
  let preview = agentCli(stateDir, ['evolve', 'preview', prepared.run_id]);
  assert.deepEqual(preview.run.caller, expectedCaller);
  assert.equal(preview.plan.source_changes[0].change, 'create_directory');
  assert.equal(fs.existsSync(path.join(vault, prepared.target)), false);
  agentCli(stateDir, [
    'evolve', 'approve', prepared.run_id, '--reason', 'Accept this one structural change.',
  ]);
  assert.equal(agentCli(stateDir, ['evolve', 'execute', prepared.run_id]).verified, true);
  preview = agentCli(stateDir, ['evolve', 'preview', prepared.run_id]);
  assert.equal(preview.run.status, 'executed');
  assert.equal(fs.statSync(path.join(vault, prepared.target)).isDirectory(), true);
  agentCli(stateDir, ['evolve', 'rollback', prepared.run_id]);
  assert.equal(fs.existsSync(path.join(vault, prepared.target)), false);
});

test('Skill receives a stable state-conflict error for an invented Library Contract ID', () => {
  const { vault, stateDir } = setup('skill-library-contract-conflict');
  const scan = agentCli(stateDir, [
    'bootstrap', 'scan', '--root', vault, '--scan-mode', 'structure', ...callerArgs,
  ]);
  agentCli(stateDir, ['bootstrap', 'contract', scan.scan_id, '--profile', 'project-work']);
  const result = spawnSync(process.execPath, [
    cliPath, 'bootstrap', 'adopt', scan.scan_id,
    '--contract', 'CONTRACT-0000000000000000', '--profile', 'project-work',
    '--reason', 'Must fail.', '--json',
  ], {
    cwd: projectRoot,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, ATLAS_STATE_DIR: stateDir },
  });
  assert.equal(result.status, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'ATLAS_STATE_CONFLICT');
  assert.equal(agentCli(stateDir, ['bootstrap', 'show', scan.scan_id]).scan.status, 'scanned');
});

test('Skill routes and saves a high-confidence Agent result without another user pause', () => {
  const { caseRoot, vault, stateDir } = setup('skill-intake');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas', 'Working'), { recursive: true });
  const scan = agentCli(stateDir, [
    'bootstrap', 'scan', '--root', vault, '--scan-mode', 'structure', ...callerArgs,
  ]);
  const contract = agentCli(stateDir, [
    'bootstrap', 'contract', scan.scan_id, '--profile', 'project-work',
  ]);
  agentCli(stateDir, [
    'bootstrap', 'adopt', scan.scan_id, '--contract', contract.contract_id,
    '--profile', 'project-work', '--reason', 'Use the Project Work Contract.',
  ]);
  const project = agentCli(stateDir, [
    'project', 'create', '--name', 'Atlas', '--path', 'Projects/Atlas',
  ]);
  const candidateFile = path.join(caseRoot, 'agent-animation-demo.html');
  fs.writeFileSync(candidateFile, '<main>agent demo</main>\n', 'utf8');
  const prepared = agentCli(stateDir, [
    'save', 'prepare', '--root', vault, '--candidate-file', candidateFile,
    '--origin', 'agent_generated', '--kind', 'demo', '--project', project.project_id,
    '--intent', 'Keep the demo outside website source code.', '--channel', 'host',
    '--request-key', 'skill-intake-demo', ...callerArgs,
  ]);
  assert.equal(prepared.schema, 'atlas.save-result.v1');
  assert.equal(prepared.target.relative_path, 'Projects/Atlas/Working/agent-animation-demo.html');
  const executed = agentCli(stateDir, [
    'save', 'execute', prepared.save_id,
    '--reason', 'The user asked Atlas to organize generated project files.',
  ]);
  assert.equal(executed.status, 'executed');
  const shown = agentCli(stateDir, ['intake', 'show', prepared.save_id]);
  assert.equal(shown.placement.policy.intake.kind, 'demo');
  assert.equal(shown.inputs.length, 0);
  agentCli(stateDir, ['save', 'undo', prepared.save_id]);
  assert.equal(fs.existsSync(path.join(vault, prepared.target.relative_path)), false);
});
