import assert from 'node:assert/strict';
import { createHash as hashBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';
import { PreferenceRules } from '../src/preference-rules.js';
import { RoundRecovery } from '../src/round-recovery.js';
import { createHandoffService } from '../src/handoff-service.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createSavedWorkService } from '../src/ui/services/saved-work-service.js';
import { createTableWorkModule } from '../src/table-work-module.js';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';

function fixture(t, suffix) {
  const parent = path.resolve('test/.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, `handoff-${suffix}-`));
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'A'); const stateDir = path.join(root, 'state');
  const sourcePath = path.join(projectRoot, 'Data', 'input.csv');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true }); fs.writeFileSync(sourcePath, 'region,value\nNorth,20\nSouth,10\n', 'utf8');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: `Handoff ${suffix}`, currentPath: 'A' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Handoff fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const identified = control.identify({ filePath: sourcePath, project: { id: project.project_id, name: project.name } });
  const dataWork = createDataWorkService({ stateDir, projectRoot: path.resolve('.'), installationRoot: path.resolve('.'), resourceControl: control,
    fingerprintFn: async (filePath) => ({ file_path: filePath, sha256: requireHash(fs.readFileSync(filePath)), bytes: fs.statSync(filePath).size }),
    runDataWorkFn: async ({ filePath, expectedSha256, action }) => {
      const sha256 = requireHash(fs.readFileSync(filePath));
      if (expectedSha256 && expectedSha256 !== sha256) throw Object.assign(new Error('Source changed.'), { code: 'ATLAS_STATE_CONFLICT' });
      if (action === 'profile') return { status: 'ready', source: { sha256 }, processor: { version: 'fixture' }, sheets: [], profile: { rows: 2, columns: 2, fields: [
        { name: 'region', inferred_type: 'text', missing_count: 0, distinct_count: 2 }, { name: 'value', inferred_type: 'number', missing_count: 0, distinct_count: 2 },
      ] } };
      return { processor: { version: 'fixture' }, columns: ['region', 'value'], rows: [['North', '20'], ['South', '10']], preview: { rows_shown: 2, total_rows: 2 },
        aggregation: { dimension: 'region', measure: 'value', formula: 'sum', unit: 'items', groups: [{ value: 'North', sum: '20' }, { value: 'South', sum: '10' }], total: '30' } };
    },
  });
  const saveService = new SaveService({ stateDir });
  const rules = new PreferenceRules({ stateDir, ledger: registry.ledger });
  const recovery = new RoundRecovery({ stateDir, registry });
  const savedWork = createSavedWorkService({ stateDir, saveService });
  const resolveProject = (projectId) => projectId === project.project_id ? { project: { id: project.project_id, name: project.name, status: 'active' }, root: projectRoot, location: registry.show(project.project_id).location } : null;
  const handoffs = createHandoffService({ registry, rules, saveService, dataWork, roundRecovery: recovery, resourceControl: control });
  const module = createTableWorkModule({ dataWork, savedWork, resolveProject, handoffService: handoffs });
  const dispose = () => { recovery.dispose(); saveService.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); };
  t.after(dispose);
  return { root, projectRoot, stateDir, registry, project, control, dataWork, saveService, rules, recovery, handoffs, module, resource: identified };
}

function requireHash(bytes) { return hashBytes('sha256').update(bytes).digest('hex'); }

async function preparedWork(f) {
  const call = (action, parameters = {}, revision = null) => f.module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: f.project.project_id, action, parameters,
    ...(revision == null ? {} : { work: { session_id: work.session_id, base_revision: revision } }) });
  const start = await call('start', { resource_ids: [f.resource.resource_id], caller: { actor: 'agent', tool: 'handoff-test', client_run_id: 'start' } });
  const work = start.data;
  const prep = await call('prepare', {}, work.revision);
  const mapping = [{ source_key: prep.data.sources[0].source_key, column: 'region', canonical: 'region' }, { source_key: prep.data.sources[0].source_key, column: 'value', canonical: 'value' }];
  const aligned = await call('align', { mapping }, prep.data.revision);
  const recipe = await call('recipe', { recipe: { combine: 'concatenate', aggregate_dimension: 'region', aggregate_measure: 'value', aggregate_formula: 'sum', aggregate_unit: 'items', aggregate_null_policy: 'exclude' } }, aligned.data.revision);
  const preview = await call('preview', {}, recipe.data.revision);
  return preview.data;
}

test('Handoff persists a bounded digest and guards one Table Work focus transaction', async (t) => {
  const f = fixture(t, 'service');
  const work = await preparedWork(f);
  assert.ok(f.registry.ledger.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'").get());
  const request = { schema: 'atlas.handoff.v1', goal: 'Compare the two regional sums.', work_id: work.session_id,
    resource_ids: [f.resource.resource_id], save_ids: [], rule_request: { operation: 'content_work', project_id: f.project.project_id, needs: ['placement'] },
    corrections: [{ text: 'Use the checked region field.', source: 'user_self_report' }], unfinished: ['Check the next reporting period.'],
    caller: { actor: 'agent', tool: 'host-a', client_run_id: 'handoff-create-1' }, request_key: 'handoff-1' };
  const handoff = await f.handoffs.create({ projectId: f.project.project_id, request });
  assert.equal(handoff.status, 'current'); assert.match(handoff.digest, /^[a-f0-9]{64}$/u); assert.equal(handoff.work_revision, work.revision);
  const replay = await f.handoffs.create({ projectId: f.project.project_id, request });
  assert.equal(replay.handoff_id, handoff.handoff_id); assert.equal(replay.replayed, true);
  await assert.rejects(f.handoffs.create({ projectId: f.project.project_id, request: { ...request, goal: 'Different goal.' } }), { code: 'ATLAS_STATE_CONFLICT' });
  await assert.rejects(f.handoffs.read({ projectId: 'PRJ-other', handoffId: handoff.handoff_id }), { code: 'ATLAS_NOT_FOUND' });
  await assert.rejects(f.handoffs.create({ projectId: f.project.project_id, request: { ...request, request_key: 'too-many', resource_ids: Array(17).fill('RES-x') } }), { code: 'ATLAS_INVALID_ARGUMENT' });

  const focused = await f.module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: f.project.project_id,
    work: { session_id: work.session_id, base_revision: work.revision }, action: 'focus', parameters: {
      category: 'North', handoff_id: handoff.handoff_id, handoff_digest: handoff.digest,
    } });
  assert.equal(focused.data.revision, work.revision + 1);
  assert.deepEqual(focused.data.focus, { field: 'region', value: 'North' });
  assert.equal((await f.handoffs.read({ projectId: f.project.project_id, handoffId: handoff.handoff_id })).status, 'stale');
  await assert.rejects(f.module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: f.project.project_id,
    work: { session_id: work.session_id, base_revision: focused.data.revision }, action: 'focus', parameters: {
      category: 'South', handoff_id: handoff.handoff_id, handoff_digest: handoff.digest,
    } }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('a restored Round makes its former Handoff stale before another Work focus', async (t) => {
  const f = fixture(t, 'round-restore');
  const work = await preparedWork(f);
  const projectId = f.project.project_id;
  const caller = (clientRunId) => ({ actor: 'agent', tool: 'handoff-round-test', client_run_id: clientRunId });
  const round = f.recovery.protect({ projectId, paths: ['Data/input.csv'], resourceIds: [f.resource.resource_id],
    workIds: [work.session_id], boardIds: [], label: 'Work before focus', requestKey: 'handoff-round-protect', caller: caller('protect') });
  const firstRequest = { schema: 'atlas.handoff.v1', goal: 'Check the regional result.', work_id: work.session_id,
    resource_ids: [f.resource.resource_id], save_ids: [], rule_request: { operation: 'content_work', project_id: projectId, needs: ['placement'] },
    corrections: [], unfinished: ['Review the next region.'], caller: caller('first-handoff'), request_key: 'first-handoff' };
  const first = await f.handoffs.create({ projectId, request: firstRequest });
  const focused = await f.module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: projectId,
    work: { session_id: work.session_id, base_revision: work.revision }, action: 'focus', parameters: {
      category: 'North', handoff_id: first.handoff_id, handoff_digest: first.digest,
    } });
  assert.equal(focused.data.revision, work.revision + 1);
  const beforeCheckpoint = f.recovery.show({ projectId, roundId: round.round_id });
  f.recovery.checkpoint({ projectId, roundId: round.round_id, baseRevision: beforeCheckpoint.revision,
    expectedDigest: beforeCheckpoint.current_digest, label: 'Focused North', requestKey: 'handoff-round-checkpoint', caller: caller('checkpoint') });
  const currentRequest = { ...firstRequest, caller: caller('current-handoff'), request_key: 'current-handoff' };
  const current = await f.handoffs.create({ projectId, request: currentRequest });
  assert.equal(current.status, 'current');
  const beforeRestore = f.recovery.show({ projectId, roundId: round.round_id });
  const restored = f.recovery.restore({ projectId, roundId: round.round_id, nodeId: round.head_node_id,
    baseRevision: beforeRestore.revision, expectedDigest: beforeRestore.current_digest, requestKey: 'handoff-round-restore', caller: caller('restore') });
  assert.equal(restored.pending_restore, null);
  const old = await f.handoffs.read({ projectId, handoffId: current.handoff_id });
  assert.equal(old.status, 'stale');
  assert.ok(old.changes.includes('recoveries'));
  const restoredWork = f.registry.ledger.workSessions.byId(work.session_id);
  await assert.rejects(f.module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: projectId,
    work: { session_id: work.session_id, base_revision: restoredWork.revision }, action: 'focus', parameters: {
      category: 'South', handoff_id: current.handoff_id, handoff_digest: current.digest,
    } }), { code: 'ATLAS_STATE_CONFLICT' });
  const renewed = await f.handoffs.create({ projectId, request: { ...firstRequest, caller: caller('renewed-handoff'), request_key: 'renewed-handoff' } });
  assert.equal(renewed.status, 'current');
  assert.notEqual(renewed.handoff_id, current.handoff_id);
});

test('Handoff CLI create awaits a persisted result and replays the same request key', async (t) => {
  const f = fixture(t, 'cli');
  const work = await preparedWork(f);
  const requestPath = path.join(f.root, 'handoff-request.json');
  fs.writeFileSync(requestPath, JSON.stringify({
    schema: 'atlas.handoff.v1', goal: 'Continue this checked comparison.', work_id: work.session_id,
    resource_ids: [f.resource.resource_id], save_ids: [],
    rule_request: { operation: 'content_work', project_id: f.project.project_id, needs: ['placement'] },
    corrections: [], unfinished: ['Check the next period.'],
    caller: { actor: 'agent', tool: 'host-b', client_run_id: 'cli-handoff-1' }, request_key: 'cli-handoff-1',
  }), 'utf8');
  const invoke = () => spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'handoff', 'create', '--project', f.project.project_id, '--request-file', requestPath, '--json'], {
    cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir, ATLAS_HOME: path.resolve('.') }, encoding: 'utf8', timeout: 15000,
  });
  const first = invoke();
  assert.equal(first.status, 0, first.stderr);
  const created = JSON.parse(first.stdout);
  assert.equal(created.ok, true);
  assert.match(created.data.handoff_id, /^HOF-/u);
  assert.equal(created.data.status, 'current');
  const replay = invoke();
  assert.equal(replay.status, 0, replay.stderr);
  const replayed = JSON.parse(replay.stdout);
  assert.equal(replayed.data.handoff_id, created.data.handoff_id);
  assert.equal(replayed.data.replayed, true);
  assert.equal((await f.handoffs.read({ projectId: f.project.project_id, handoffId: created.data.handoff_id })).status, 'current');
});
