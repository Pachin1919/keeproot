import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Evolution } from '../src/evolution.js';
import { Registry } from '../src/registry.js';

function fixture(t) {
  const base = fs.mkdtempSync(path.resolve('test/.tmp/evolution-project-compat-'));
  const root = path.join(base, 'workspace'); const stateDir = path.join(base, 'state');
  fs.mkdirSync(path.join(root, 'A'), { recursive: true }); fs.writeFileSync(path.join(root, 'A/note.md'), '# unchanged\n');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: root, rootType: 'project_workspace' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Legacy compatibility fixture.' });
  const evolution = new Evolution({ stateDir });
  t.after(() => { evolution.dispose(); registry.dispose(); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, stateDir, projectId: project.project_id, evolution };
}
const guidance = /project move prepare --request-file.*active.*same Root.*preview.*confirm/iu;
test('Project legacy prepare and organization prepare refuse before persistent changes', (t) => {
  const f = fixture(t); const { evolution, root, projectId } = f;
  const before = evolution.ledger.db.prepare('SELECT * FROM runs').all();
  assert.throws(() => evolution.prepare({ root, operation: 'migrate_project', projectId, target: 'B' }), guidance);
  assert.throws(() => evolution.preparePlan({ root, operations: [{ operation: 'create_directory', target: 'new' }, { operation: 'migrate_project', projectId, target: 'B' }] }), guidance);
  assert.deepEqual(evolution.ledger.db.prepare('SELECT * FROM runs').all(), before);
  assert.equal(fs.readFileSync(path.join(root, 'A/note.md'), 'utf8'), '# unchanged\n');
  assert.equal(fs.existsSync(path.join(root, 'B')), false);
});

function seed(f, runId) {
  f.evolution.ledger.createEvolutionRun({ runId, root: f.root, operation: 'migrate_project', sourcePath: 'A', targetPath: 'B',
    projectId: f.projectId, intent: 'Historical migration fixture', baseline: { source_manifest_hash: 'old-hash', project_path: 'A' },
    plan: { summary: 'Historical plan', blockers: [], source_changes: [] }, planHash: 'old-plan', diffText: 'A -> B', diffHash: 'old-diff', caller: {}, startedAt: new Date().toISOString() });
}
test('Project historical rollback refusal leaves Ledger events unchanged', (t) => {
  const f = fixture(t); const id = 'RUN-legacy-rollback-compat'; seed(f, id);
  const before = f.evolution.ledger.db.prepare('SELECT * FROM operation_events WHERE run_id=?').all(id);
  assert.throws(() => f.evolution.rollback(id), { code: 'ATLAS_STATE_CONFLICT' });
  assert.deepEqual(f.evolution.ledger.db.prepare('SELECT * FROM operation_events WHERE run_id=?').all(id), before);
});
test('Project historical organization preview stays readable and review execute rollback refuse without writes', (t) => {
  const f = fixture(t); const id = 'RUN-legacy-organization-compat';
  f.evolution.ledger.createOrganizationPlan({ runId: id, root: f.root, intent: 'Historical Project plan',
    operations: [{ ordinal: 0, operation: 'migrate_project', project_id: f.projectId, source: 'A', target: 'B', baseline: {}, blockers: [] }],
    planHash: 'old-plan', createdAt: new Date().toISOString() });
  const before = f.evolution.previewPlan(id);
  assert.equal(before.operations[0].operation, 'migrate_project');
  assert.match(before.project_migration_compatibility.guidance, guidance);
  assert.throws(() => f.evolution.approvePlan(id, { reason: 'Do not approve unsupported migration.' }), guidance);
  assert.throws(() => f.evolution.executePlan(id), guidance);
  assert.throws(() => f.evolution.rollbackPlan(id), guidance);
  assert.deepEqual(f.evolution.previewPlan(id), before);
});
test('Project historical preview keeps receipts and legacy approval execute rollback do not write', (t) => {
  const f = fixture(t); const id = 'RUN-legacy-project-compat'; seed(f, id);
  const prepared = f.evolution.preview(id);
  assert.throws(() => f.evolution.approve(id, { reason: 'Old approval must not imply execution.' }), guidance);
  assert.deepEqual(f.evolution.preview(id), prepared);
  const receipt = { run_id: id, status: 'executed', operation: 'migrate_project', verified: true, historical: true,
    before_manifest_hash: 'old-hash', after_manifest_hash: 'old-hash' };
  f.evolution.ledger.reviewEvolution(id, { decision: 'accepted', reason: 'Historical approval.', reviewedAt: new Date().toISOString() });
  f.evolution.ledger.finishEvolutionExecution(id, { receipt, executedAt: new Date().toISOString() });
  const before = f.evolution.preview(id);
  assert.deepEqual(before.execution_receipt, receipt);
  assert.match(before.project_migration_compatibility.guidance, guidance);
  assert.equal(before.project_migration_compatibility.legacy_undo_supported, false);
  assert.throws(() => f.evolution.execute(id), guidance);
  assert.throws(() => f.evolution.rollback(id), /historical.*cannot.*Project Move Undo/iu);
  assert.deepEqual(f.evolution.preview(id), before);
});
