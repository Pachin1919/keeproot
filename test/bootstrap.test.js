import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Bootstrap } from '../src/bootstrap.js';
import { sha256File } from '../src/snapshots.js';

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
  return { caseRoot, vault, stateDir };
}

function vaultFingerprint(vault) {
  const rows = [];
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, item.name);
      const relative = path.relative(vault, absolute).split(path.sep).join('/');
      if (item.isDirectory()) walk(absolute);
      else rows.push(`${relative}:${sha256File(absolute)}`);
    }
  }
  walk(vault);
  return rows.join('\n');
}

function openBootstrap(t, stateDir) {
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  return bootstrap;
}

test('Bootstrap scans metadata, records Predictions, and never modifies the Vault', (t) => {
  const { vault, stateDir } = setup('bootstrap-scan');
  const bootstrap = openBootstrap(t, stateDir);
  const before = vaultFingerprint(vault);

  const receipt = bootstrap.scan({ root: vault });
  const detail = bootstrap.show(receipt.scan_id);

  assert.equal(receipt.status, 'scanned');
  assert.equal(receipt.markdown_files, 8);
  assert.equal(vaultFingerprint(vault), before);
  assert.ok(detail.entries.some((entry) => entry.path === '00 Home.md'));
  assert.ok(!detail.entries.some((entry) => entry.path.startsWith('.obsidian/')));
  const home = detail.entries.find((entry) => entry.path === '00 Home.md');
  assert.equal(home.metadata.title, 'Vault Home');
  assert.deepEqual(home.metadata.properties.sort(), ['tags', 'title']);
  assert.ok(home.metadata.tags.includes('moc'));
  assert.ok(home.metadata.links.includes('Missing Note'));
  assert.ok(!home.metadata.links.includes('Not A Real Link'));

  const kinds = new Set(detail.predictions.map((prediction) => prediction.kind));
  for (const kind of [
    'broken_wiki_link',
    'ambiguous_wiki_link',
    'duplicate_title',
    'duplicate_filename',
    'orphan_notes',
    'directory_missing_index',
  ]) {
    assert.ok(kinds.has(kind), `missing Bootstrap prediction kind: ${kind}`);
  }
  const brokenTargets = detail.predictions
    .filter((prediction) => prediction.kind === 'broken_wiki_link')
    .map((prediction) => prediction.evidence.target);
  assert.ok(!brokenTargets.includes('Assets/image.png'));
  for (const prediction of detail.predictions) {
    assert.ok(prediction.summary);
    assert.ok(prediction.confidence > 0 && prediction.confidence <= 1);
    assert.ok(Array.isArray(prediction.affected_paths));
    assert.ok(prediction.evidence);
  }
});

test('repeating an unchanged scan reuses the existing environment baseline', (t) => {
  const { vault, stateDir } = setup('bootstrap-idempotent');
  const bootstrap = openBootstrap(t, stateDir);

  const first = bootstrap.scan({ root: vault });
  const second = bootstrap.scan({ root: vault });

  assert.equal(second.scan_id, first.scan_id);
  assert.equal(second.reused, true);
  assert.equal(bootstrap.status().length, 1);
});

test('structure scan recognizes a local Agent Skill collection instead of reporting note-library defects', (t) => {
  const caseRoot = path.join(tempRoot, 'bootstrap-agent-skill-collection');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const skillsRoot = path.join(caseRoot, 'skills');
  const stateDir = path.join(caseRoot, 'state');
  for (const skill of ['context-budget', 'copy-editing', 'social-content']) {
    fs.mkdirSync(path.join(skillsRoot, skill, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, skill, 'SKILL.md'), `# ${skill}\n`, 'utf8');
    fs.writeFileSync(path.join(skillsRoot, skill, 'references', 'guide.md'), '# Guide\n', 'utf8');
  }
  fs.mkdirSync(path.join(skillsRoot, 'social-content', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, 'social-content', 'agents', 'openai.yaml'), 'name: social\n', 'utf8');
  const bootstrap = openBootstrap(t, stateDir);

  const scan = bootstrap.scan({ root: skillsRoot, scanMode: 'structure' });
  const detail = bootstrap.show(scan.scan_id);
  const collection = detail.predictions.find((item) => item.kind === 'agent_skill_collection');

  assert.ok(collection);
  assert.equal(collection.evidence.scope, 'library_local');
  assert.equal(collection.evidence.package_count, 3);
  assert.deepEqual(collection.evidence.packages, ['context-budget', 'copy-editing', 'social-content']);
  assert.equal(scan.content_files_read, 0);
  assert.equal(scan.content_bytes_read, 0);
  assert.ok(!detail.predictions.some((item) => (
    item.kind === 'duplicate_filename' && item.evidence.paths.every((itemPath) => itemPath.endsWith('/SKILL.md'))
  )));
  assert.ok(!detail.predictions.some((item) => (
    item.kind === 'project_candidate' && collection.evidence.packages.includes(item.evidence.directory)
  )));
  assert.ok(!detail.predictions.some((item) => (
    item.kind === 'directory_missing_index'
    && collection.evidence.packages.includes(item.evidence.directory.split('/')[0])
  )));
});

test('a changed environment produces a new scan while retaining history', (t) => {
  const { vault, stateDir } = setup('bootstrap-rescan');
  const bootstrap = openBootstrap(t, stateDir);
  const first = bootstrap.scan({ root: vault });
  fs.appendFileSync(path.join(vault, 'Loose Note.md'), '\n#changed\n', 'utf8');

  const second = bootstrap.scan({ root: vault });

  assert.notEqual(second.scan_id, first.scan_id);
  assert.equal(second.reused, false);
  assert.equal(bootstrap.status().length, 2);
  assert.deepEqual(bootstrap.show(second.scan_id).summary.changes.modified, ['Loose Note.md']);
  assert.equal(bootstrap.show(second.scan_id).summary.changes.baseline_scan_id, first.scan_id);
});

test('Rescan reports a same-content path change as a move candidate', (t) => {
  const { vault, stateDir } = setup('bootstrap-rescan-move');
  const bootstrap = openBootstrap(t, stateDir);
  const first = bootstrap.scan({ root: vault });
  fs.renameSync(path.join(vault, 'Loose Note.md'), path.join(vault, 'Moved Note.md'));

  const second = bootstrap.scan({ root: vault });
  const changes = bootstrap.show(second.scan_id).summary.changes;
  assert.equal(changes.baseline_scan_id, first.scan_id);
  assert.deepEqual(changes.moved_candidates, [{ from: 'Loose Note.md', to: 'Moved Note.md' }]);
  assert.ok(changes.added.includes('Moved Note.md'));
  assert.ok(changes.deleted.includes('Loose Note.md'));
});

test('Bootstrap marks incomplete frontmatter and ignores inline-code pseudo metadata', (t) => {
  const { vault, stateDir } = setup('bootstrap-markdown-edge-cases');
  fs.writeFileSync(
    path.join(vault, 'Broken Frontmatter.md'),
    '---\ntags: [fake]\n[[Not A Real Link]]\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(vault, 'Inline Code.md'),
    '# Inline Code\n\n`[[Inline Fake]] #fake`\n',
    'utf8',
  );
  const bootstrap = openBootstrap(t, stateDir);
  const scan = bootstrap.scan({ root: vault });
  const detail = bootstrap.show(scan.scan_id);
  const broken = detail.predictions
    .filter((prediction) => prediction.kind === 'broken_wiki_link')
    .map((prediction) => prediction.evidence.target);

  assert.ok(!broken.includes('Not A Real Link'));
  assert.ok(!broken.includes('Inline Fake'));
  assert.ok(detail.predictions.some(
    (prediction) => prediction.kind === 'incomplete_metadata_scan'
      && prediction.affected_paths.includes('Broken Frontmatter.md'),
  ));
  const inline = detail.entries.find((entry) => entry.path === 'Inline Code.md');
  assert.ok(!inline.metadata.tags.includes('fake'));
});

test('Bootstrap supports explicit internal-directory ignores and rejects ignore path escape', (t) => {
  const { vault, stateDir } = setup('bootstrap-custom-ignore');
  const secretDirectory = path.join(vault, 'Private');
  fs.mkdirSync(secretDirectory);
  fs.writeFileSync(path.join(secretDirectory, 'hidden.md'), '# Hidden\n', 'utf8');
  const bootstrap = openBootstrap(t, stateDir);

  const scan = bootstrap.scan({ root: vault, ignore: ['Private'] });
  const detail = bootstrap.show(scan.scan_id);
  assert.ok(!detail.entries.some((entry) => entry.path.startsWith('Private/')));
  assert.ok(detail.summary.ignored_paths.includes('Private'));
  assert.throws(() => bootstrap.scan({ root: vault, ignore: ['../outside'] }), /ignore.*escape/i);
});

test('Bootstrap excludes conventional dependency stores from library observations', (t) => {
  const { vault, stateDir } = setup('bootstrap-conventional-dependency-ignore');
  for (const directory of ['.venv', '.pnpm-store']) {
    fs.mkdirSync(path.join(vault, directory), { recursive: true });
    fs.writeFileSync(path.join(vault, directory, 'dependency.bin'), 'fixture\n', 'utf8');
  }
  const bootstrap = openBootstrap(t, stateDir);

  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  const detail = bootstrap.show(scan.scan_id);

  assert.ok(detail.summary.ignored_paths.includes('.venv'));
  assert.ok(detail.summary.ignored_paths.includes('.pnpm-store'));
  assert.ok(!detail.entries.some((entry) => /^\.(?:venv|pnpm-store)(?:\/|$)/u.test(entry.path)));
});

test('Initialize requires reviews and writes outputs outside the Vault', (t) => {
  const { vault, stateDir } = setup('bootstrap-review-initialize');
  const bootstrap = openBootstrap(t, stateDir);
  const before = vaultFingerprint(vault);
  const scan = bootstrap.scan({ root: vault });
  const detail = bootstrap.show(scan.scan_id);

  assert.throws(() => bootstrap.initialize(scan.scan_id), /review/i);
  for (const prediction of detail.predictions) {
    const first = bootstrap.review(prediction.id, { decision: 'accepted', reason: 'fixture review' });
    const second = bootstrap.review(prediction.id, { decision: 'accepted', reason: 'fixture review' });
    assert.deepEqual(second, first);
  }

  const initialized = bootstrap.initialize(scan.scan_id);
  const repeated = bootstrap.initialize(scan.scan_id);
  assert.deepEqual(repeated, initialized);
  assert.equal(initialized.status, 'initialized');
  assert.ok(fs.existsSync(path.join(initialized.output_dir, 'vault-map.md')));
  assert.ok(fs.existsSync(path.join(initialized.output_dir, 'setup-report.md')));
  assert.ok(fs.existsSync(path.join(initialized.output_dir, 'environment.json')));
  assert.ok(path.resolve(initialized.output_dir).startsWith(path.resolve(stateDir)));
  assert.equal(vaultFingerprint(vault), before);
  const environment = JSON.parse(fs.readFileSync(path.join(initialized.output_dir, 'environment.json'), 'utf8'));
  assert.ok(environment.projects.length > 0);
  assert.equal(initialized.registered_projects, environment.projects.length);
});

test('Bootstrap stores Observations, Predictions, and Labels separately', (t) => {
  const { vault, stateDir } = setup('bootstrap-foundation-separation');
  const bootstrap = openBootstrap(t, stateDir);
  const scan = bootstrap.scan({ root: vault });
  const prediction = bootstrap.show(scan.scan_id).predictions[0];
  bootstrap.review(prediction.id, { decision: 'rejected', reason: 'not useful' });
  bootstrap.dispose();

  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    const observationCount = db.prepare('SELECT COUNT(*) AS count FROM observations WHERE run_id = ?').get(scan.scan_id).count;
    const predictionCount = db.prepare('SELECT COUNT(*) AS count FROM predictions WHERE run_id = ?').get(scan.scan_id).count;
    const label = db.prepare('SELECT value, subject_prediction_id FROM labels WHERE run_id = ?').get(scan.scan_id);
    assert.ok(observationCount > 0);
    assert.ok(predictionCount > 0);
    assert.equal(label.value, 'rejected');
    assert.equal(label.subject_prediction_id, prediction.id);
  } finally {
    db.close();
  }
});

test('structure-only Bootstrap does not open file content or compute content hashes', (t) => {
  const { vault, stateDir } = setup('bootstrap-structure-only');
  const bootstrap = openBootstrap(t, stateDir);
  const originalOpen = fs.openSync;
  fs.openSync = function rejectVaultContent(filePath, ...args) {
    if (path.resolve(String(filePath)).startsWith(`${path.resolve(vault)}${path.sep}`)) {
      throw new Error(`structure-only scan opened Vault content: ${filePath}`);
    }
    return originalOpen.call(this, filePath, ...args);
  };
  let receipt;
  try {
    receipt = bootstrap.scan({ root: vault, scanMode: 'structure' });
  } finally {
    fs.openSync = originalOpen;
  }

  const detail = bootstrap.show(receipt.scan_id);
  assert.equal(receipt.scan_mode, 'structure');
  assert.equal(receipt.content_files_read, 0);
  assert.equal(detail.summary.scan_mode, 'structure');
  assert.equal(detail.summary.content_files_read, 0);
  assert.ok(detail.entries.filter((entry) => entry.kind === 'file').every(
    (entry) => entry.contentHash === null,
  ));
  const home = detail.entries.find((entry) => entry.path === '00 Home.md');
  assert.equal(home.metadata.scanned_content, false);
  assert.equal(home.metadata.scan_mode, 'structure');
  const kinds = new Set(detail.predictions.map((prediction) => prediction.kind));
  assert.ok(kinds.has('duplicate_filename'));
  assert.ok(kinds.has('project_candidate'));
  assert.ok(!kinds.has('broken_wiki_link'));
  assert.ok(!kinds.has('ambiguous_wiki_link'));
  assert.ok(!kinds.has('orphan_notes'));
  assert.ok(!kinds.has('duplicate_title'));
});

test('structure-only rescan detects stat changes and does not reuse a metadata scan', (t) => {
  const { vault, stateDir } = setup('bootstrap-structure-rescan');
  const bootstrap = openBootstrap(t, stateDir);
  const metadataScan = bootstrap.scan({ root: vault });
  const structureScan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  assert.notEqual(structureScan.scan_id, metadataScan.scan_id);

  fs.appendFileSync(path.join(vault, 'Loose Note.md'), '\nstructure change\n', 'utf8');
  const changed = bootstrap.scan({ root: vault, scanMode: 'structure' });
  const detail = bootstrap.show(changed.scan_id);
  assert.notEqual(changed.scan_id, structureScan.scan_id);
  assert.ok(detail.summary.changes.modified.includes('Loose Note.md'));
  assert.deepEqual(detail.summary.changes.moved_candidates, []);
});

test('Bootstrap rejects a mixed metadata baseline when a file changes during metadata extraction', (t) => {
  const { vault, stateDir } = setup('bootstrap-scan-mutation');
  const bootstrap = openBootstrap(t, stateDir);
  const target = path.join(vault, '00 Home.md');
  const originalRead = fs.readSync;
  let injected = false;
  fs.readSync = function mutateAfterMetadataRead(descriptor, buffer, offset, length, position, ...rest) {
    const bytes = originalRead.call(this, descriptor, buffer, offset, length, position, ...rest);
    if (!injected && position === 0 && length < 1024 * 1024) {
      injected = true;
      fs.appendFileSync(target, '\nmutation during metadata read\n', 'utf8');
    }
    return bytes;
  };
  try {
    assert.throws(() => bootstrap.scan({ root: vault, scanMode: 'metadata' }), /changed while Bootstrap was scanning/i);
  } finally {
    fs.readSync = originalRead;
  }
  assert.equal(injected, true);
  assert.deepEqual(bootstrap.status(), []);
});

test('forced scans of the same evidence keep a deterministic fingerprint and Library Contract', (t) => {
  const { vault, stateDir } = setup('bootstrap-deterministic-contract');
  const bootstrap = openBootstrap(t, stateDir);
  const first = bootstrap.scan({ root: vault, scanMode: 'structure', forceNew: true });
  const firstContract = bootstrap.contract(first.scan_id);
  const second = bootstrap.scan({ root: vault, scanMode: 'structure', forceNew: true });
  const secondContract = bootstrap.contract(second.scan_id);

  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(secondContract.contract_id, firstContract.contract_id);
  assert.deepEqual(secondContract.profile, firstContract.profile);
  assert.deepEqual(secondContract.zones, firstContract.zones);
  assert.deepEqual(secondContract.questions, firstContract.questions);
});

test('Bootstrap provides bounded Agent context without file bodies', (t) => {
  const { vault, stateDir } = setup('bootstrap-agent-context');
  const bootstrap = openBootstrap(t, stateDir);
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });

  const context = bootstrap.context(scan.scan_id, { maxSamples: 2 });

  assert.equal(context.scan_id, scan.scan_id);
  assert.equal(context.scan_mode, 'structure');
  assert.equal(context.content_included, false);
  assert.ok(context.areas.length > 0);
  assert.ok(context.areas.every((area) => area.sample_paths.length <= 2));
  assert.ok(context.areas.every((area) => !Object.hasOwn(area, 'content')));
  assert.ok(context.prediction_counts.some((item) => item.kind === 'project_candidate'));
  assert.equal(context.area_limit, 100);
  assert.ok(context.areas.length <= context.area_limit);
  assert.ok(context.summary.ignored_paths.sample.length <= 2);
  assert.ok(context.summary.changes.modified.sample.length <= 2);
  assert.doesNotMatch(JSON.stringify(context), /# Atlas Overview|This link is intentionally broken/);
});

test('Agent semantic Predictions are path-validated, idempotent, reviewable, and initialized separately', (t) => {
  const { vault, stateDir } = setup('bootstrap-agent-predictions');
  const bootstrap = openBootstrap(t, stateDir);
  const scan = bootstrap.scan({ root: vault, scanMode: 'structure' });
  const caller = {
    actor: 'agent', agent: 'Codex', model: 'gpt-5', tool: 'codex-desktop', client_run_id: 'bootstrap-semantic-1',
  };
  const predictions = [
    {
      kind: 'folder_role',
      summary: 'Projects is the durable project area.',
      confidence: 0.92,
      risk: 'low',
      affected_paths: ['Projects'],
      evidence: { path: 'Projects', role: 'projects', basis: ['folder name', 'contained notes'] },
      proposed_action: 'Use Projects as the root for durable project outputs.',
    },
    {
      kind: 'artifact_role',
      summary: 'Projects/Atlas/Overview.md is a canonical project overview.',
      confidence: 0.88,
      risk: 'low',
      affected_paths: ['Projects/Atlas/Overview.md'],
      evidence: { path: 'Projects/Atlas/Overview.md', role: 'canonical' },
      proposed_action: 'Treat it as the canonical overview instead of a raw input.',
    },
    {
      kind: 'routing_rule_candidate',
      summary: 'Atlas reports should route under Projects/Atlas.',
      confidence: 0.84,
      risk: 'medium',
      affected_paths: ['Projects/Atlas'],
      evidence: { role: 'report', target_directory: 'Projects/Atlas' },
      proposed_action: 'Route future Atlas reports to Projects/Atlas after review.',
    },
    {
      kind: 'structure_improvement',
      summary: 'Give Projects an explicit entry note.',
      confidence: 0.76,
      risk: 'medium',
      affected_paths: ['Projects'],
      evidence: { issue: 'missing explicit area overview', target_directory: 'Projects' },
      proposed_action: 'Preview a new Projects/README.md before creating it.',
    },
  ];

  const first = bootstrap.propose(scan.scan_id, { predictions, caller });
  const second = bootstrap.propose(scan.scan_id, { predictions, caller });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.proposal_id, first.proposal_id);
  assert.deepEqual(second.prediction_ids, first.prediction_ids);

  const detail = bootstrap.show(scan.scan_id);
  const agentPredictions = detail.predictions.filter((prediction) => prediction.source === 'agent');
  assert.equal(agentPredictions.length, predictions.length);
  assert.ok(agentPredictions.every((prediction) => prediction.proposed_by.client_run_id === 'bootstrap-semantic-1'));
  assert.ok(agentPredictions.every((prediction) => prediction.review === null));

  assert.throws(() => bootstrap.propose(scan.scan_id, {
    caller,
    predictions: [{
      ...predictions[0],
      affected_paths: ['../escape'],
      evidence: { ...predictions[0].evidence, path: '../escape' },
    }],
  }), /path|escape|observed/i);
  assert.throws(() => bootstrap.propose(scan.scan_id, {
    caller,
    predictions: [{ ...predictions[0], affected_paths: ['not-observed.md'] }],
  }), /observed/i);

  for (const prediction of bootstrap.show(scan.scan_id).predictions) {
    bootstrap.review(prediction.id, {
      decision: prediction.source === 'agent' ? 'accepted' : 'rejected',
      reason: prediction.source === 'agent' ? 'Fixture semantic review' : 'Fixture deterministic rejection',
    });
  }
  const initialized = bootstrap.initialize(scan.scan_id);
  assert.equal(initialized.accepted_agent_predictions, predictions.length);
  assert.ok(fs.existsSync(path.join(initialized.output_dir, 'routing-rules.json')));
  assert.ok(fs.existsSync(path.join(initialized.output_dir, 'artifact-classifications.json')));
  const routing = JSON.parse(fs.readFileSync(path.join(initialized.output_dir, 'routing-rules.json'), 'utf8'));
  const classifications = JSON.parse(fs.readFileSync(
    path.join(initialized.output_dir, 'artifact-classifications.json'),
    'utf8',
  ));
  assert.ok(routing.some((item) => item.kind === 'routing_rule_candidate'));
  assert.ok(classifications.some((item) => item.kind === 'artifact_role'));

  bootstrap.dispose();
  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bootstrap_proposals').get().count, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM predictions
      WHERE json_extract(payload_json, '$.source') = 'agent'
    `).get().count, predictions.length);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM labels l
      JOIN predictions p ON p.id = l.subject_prediction_id
      WHERE json_extract(p.payload_json, '$.source') = 'agent'
    `).get().count, predictions.length);
  } finally {
    db.close();
  }
});
