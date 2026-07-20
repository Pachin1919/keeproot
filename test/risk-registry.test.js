import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { evaluateRisk } from '../src/risk.js';
import { Tracker } from '../src/tracker.js';

const tempRoot = path.resolve('test', '.tmp');

function stateFor(name) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  fs.mkdirSync(caseRoot, { recursive: true });
  return path.join(caseRoot, 'state');
}

test('Risk Engine routes low-risk updates, protected operations, and unrecoverable destruction', () => {
  const direct = evaluateRisk({
    operation: 'update',
    paths: ['Notes/draft.md'],
    fileCount: 1,
    recoveryAvailable: true,
  });
  assert.equal(direct.mode, 'tracked_direct');
  assert.equal(direct.rule_version_id, 'RULE-RISK-1');

  const guarded = evaluateRisk({
    operation: 'update',
    paths: ['AGENTS.md'],
    fileCount: 1,
    modifiesRules: true,
    recoveryAvailable: true,
  });
  assert.equal(guarded.mode, 'guarded');
  assert.ok(guarded.reasons.some((reason) => /rule/i.test(reason)));

  const denied = evaluateRisk({
    operation: 'delete',
    paths: ['Projects/Atlas'],
    fileCount: 12,
    recoveryAvailable: false,
  });
  assert.equal(denied.mode, 'deny');

  const explicitlyGuarded = evaluateRisk({
    operation: 'update',
    paths: ['Notes/draft.md'],
    fileCount: 1,
    recoveryAvailable: true,
    requestedMode: 'guarded',
  });
  assert.equal(explicitlyGuarded.mode, 'guarded');
});

test('Registry keeps a stable Project ID while name and path history evolve', (t) => {
  const registry = new Registry({ stateDir: stateFor('registry-history') });
  t.after(() => registry.dispose());

  const created = registry.create({
    name: 'Career and Life',
    currentPath: 'Projects/Career and Life',
    aliases: ['Career'],
  });
  const updated = registry.update(created.project_id, {
    name: 'Career',
    currentPath: 'Projects/Career',
    aliases: ['Work'],
    reason: 'Project was narrowed',
  });

  assert.equal(updated.project_id, created.project_id);
  const detail = registry.show(created.project_id);
  assert.equal(detail.project.name, 'Career');
  assert.equal(detail.project.current_path, 'Projects/Career');
  assert.deepEqual(detail.aliases.sort(), ['Career', 'Work']);
  assert.deepEqual(detail.paths.map((item) => item.path), [
    'Projects/Career and Life',
    'Projects/Career',
  ]);
  assert.ok(detail.paths[0].valid_to);
  assert.equal(detail.paths[1].valid_to, null);
});

test('Registry can express parent, split, and merge lineage without deleting old Projects', (t) => {
  const registry = new Registry({ stateDir: stateFor('registry-lineage') });
  t.after(() => registry.dispose());

  const original = registry.create({ name: 'Life', currentPath: 'Projects/Life' });
  const career = registry.create({
    name: 'Career',
    currentPath: 'Projects/Career',
    splitFrom: [original.project_id],
  });
  const personal = registry.create({
    name: 'Personal',
    currentPath: 'Projects/Personal',
    parentProjectId: original.project_id,
    splitFrom: [original.project_id],
  });
  const combined = registry.create({ name: 'Development', currentPath: 'Projects/Development' });
  registry.merge([career.project_id, personal.project_id], combined.project_id);

  assert.equal(registry.show(career.project_id).project.status, 'merged');
  assert.equal(registry.show(personal.project_id).project.status, 'merged');
  assert.ok(registry.show(career.project_id).relations.some(
    (relation) => relation.relation_type === 'merged_into' && relation.target_project_id === combined.project_id,
  ));
  assert.ok(registry.show(personal.project_id).relations.some(
    (relation) => relation.relation_type === 'parent' && relation.target_project_id === original.project_id,
  ));
  assert.equal(registry.list().length, 4);
});

test('Registry rejects absolute paths and path traversal', (t) => {
  const registry = new Registry({ stateDir: stateFor('registry-path-safety') });
  t.after(() => registry.dispose());

  assert.throws(
    () => registry.create({ name: 'Escape', currentPath: '../outside' }),
    /relative|escape/i,
  );
  assert.throws(
    () => registry.create({ name: 'Absolute', currentPath: path.resolve('outside') }),
    /relative/i,
  );
});

test('Tracked Direct records a low-risk route and refuses declared destructive or rule changes', (t) => {
  const caseRoot = path.join(tempRoot, 'tracked-risk-gate');
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const vault = path.join(caseRoot, 'vault');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'note.md'), '# Note\n', 'utf8');
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# Rules\n', 'utf8');
  const tracker = new Tracker({ stateDir });
  t.after(() => tracker.dispose());

  const direct = tracker.begin({ root: vault, allow: ['note.md'] });
  const riskDecision = tracker.show(direct.run_id).decisions[0];
  assert.equal(riskDecision.decision, 'tracked_direct');
  assert.equal(riskDecision.rule_version_id, 'RULE-RISK-1');
  tracker.abort(direct.run_id);

  assert.throws(
    () => tracker.begin({ root: vault, allow: ['note.md'], operation: 'delete' }),
    /Risk Engine.*guarded/i,
  );
  assert.throws(
    () => tracker.begin({ root: vault, allow: ['AGENTS.md'] }),
    /Risk Engine.*guarded/i,
  );
  assert.equal(tracker.status().length, 1);
});
