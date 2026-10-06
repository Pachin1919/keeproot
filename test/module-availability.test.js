import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createModuleAvailabilityService } from '../src/module-availability.js';
import { createCaptureSourceModule } from '../src/capture-source-module.js';
import { createTableWorkModule } from '../src/table-work-module.js';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';

test('module availability persists revisions, replays requests and gates processing while preserving reads', async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'module-availability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const linkedTarget = path.join(root, 'linked-state-target');
  const linkedStateDir = path.join(root, 'linked-state');
  fs.mkdirSync(linkedTarget);
  fs.symlinkSync(linkedTarget, linkedStateDir, 'junction');
  assert.throws(() => createModuleAvailabilityService({ stateDir: linkedStateDir }).list(), { code: 'ATLAS_PATH_BOUNDARY' });
  const stateDir = path.join(root, 'state');
  const projectRoot = path.join(root, 'workspace', 'A');
  fs.mkdirSync(projectRoot, { recursive: true });
  const availability = createModuleAvailabilityService({ stateDir });
  const initial = availability.list();
  assert.deepEqual(initial.map((item) => item.module_id), ['atlas.capture-source', 'atlas.table-work']);
  assert.ok(initial.every((item) => item.enabled && item.revision === 0));

  const disabled = availability.change({ moduleId: 'atlas.capture-source', enabled: false, expectedRevision: 0, requestKey: 'disable-capture', reason: 'Pause source processing for review.' });
  assert.equal(disabled.revision, 1);
  assert.equal(availability.change({ moduleId: 'atlas.capture-source', enabled: false, expectedRevision: 0, requestKey: 'disable-capture', reason: 'Pause source processing for review.' }).revision, 1);
  assert.throws(() => availability.change({ moduleId: 'atlas.capture-source', enabled: true, expectedRevision: 0, requestKey: 'stale', reason: 'Stale revision.' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => availability.change({ moduleId: 'atlas.capture-source', enabled: true, expectedRevision: 1, requestKey: 'disable-capture', reason: 'Changed payload.' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.throws(() => availability.change({ moduleId: 'atlas.unknown', enabled: false, expectedRevision: 0, requestKey: 'unknown', reason: 'Unknown.' }), { code: 'ATLAS_MODULE_NOT_FOUND' });

  let captureCalls = 0;
  const captureSource = {
    inspectExport: () => { captureCalls += 1; return { items: [] }; },
    prepareExport: async () => { captureCalls += 1; return { status: 'prepared' }; },
    prepare: async () => { captureCalls += 1; return { status: 'prepared' }; },
    show: (saveId) => ({ save_id: saveId, status: 'executed' }),
    read: (saveId) => ({ save_id: saveId, excerpt: 'saved source' }),
  };
  const captureModule = createCaptureSourceModule({ captureSource, availability });
  assert.equal(captureModule.describe().enabled, false);
  await assert.rejects(captureModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', action: 'inspect-export', parameters: {} }), { code: 'ATLAS_MODULE_DISABLED' });
  assert.equal((await captureModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', project_id: 'PRJ-A', action: 'show', parameters: { saveId: 'SAV-existing' } })).data.status, 'executed');
  assert.equal((await captureModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', project_id: 'PRJ-A', action: 'read', parameters: { saveId: 'SAV-existing' } })).data.excerpt, 'saved source');
  assert.equal(captureCalls, 0);

  const session = { session_id: 'DWT-existing', project_id: 'PRJ-A', revision: 3, status: 'open', sources: [], mapping_complete: false, preview: null, latest_save_id: 'SAV-existing' };
  let recipeCalls = 0;
  const dataWork = {
    session: () => session,
    discoverProjectSessions: () => ({ sessions: [session] }),
    updateRecipe: () => { recipeCalls += 1; return { session_id: session.session_id }; },
    validateSources: async () => session,
    persistentStage: () => null,
  };
  const tableModule = createTableWorkModule({ dataWork, savedWork: { save: () => {}, find: () => ({ save_id: 'SAV-existing' }) }, resolveProject: () => ({ project: { id: 'PRJ-A', name: 'A', status: 'active' }, location: { root_path: path.dirname(projectRoot), relative_path: 'A' } }), availability });
  const tableDisabled = availability.change({ moduleId: 'atlas.table-work', enabled: false, expectedRevision: 0, requestKey: 'disable-table', reason: 'Pause data processing.' });
  assert.equal(tableDisabled.revision, 1);
  assert.equal(tableModule.describe().enabled, false);
  const existingWork = await tableModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: 'PRJ-A', action: 'list', parameters: {} });
  assert.equal(existingWork.state, null);
  assert.equal(existingWork.data.sessions[0].session_id, session.session_id);
  await assert.rejects(tableModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: 'PRJ-A', work: { session_id: session.session_id, base_revision: session.revision }, action: 'recipe', parameters: {} }), { code: 'ATLAS_MODULE_DISABLED' });
  assert.equal(recipeCalls, 0);

  const cli = (...args) => spawnSync(process.execPath, [path.resolve('bin/atlas.js'), ...args, '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: stateDir }, encoding: 'utf8' });
  const listed = cli('module', 'list');
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).data.modules.map((item) => item.module_id), ['atlas.capture-source', 'atlas.table-work']);
  const blocked = cli('capture', 'source', 'inspect-export', '--input', path.join(root, 'not-read.json'));
  assert.notEqual(blocked.status, 0);
  const blockedEnvelope = JSON.parse(blocked.stdout);
  assert.equal(blockedEnvelope.error.code, 'ATLAS_MODULE_DISABLED');

  const enableTable = cli('module', 'enable', 'atlas.table-work', '--expected-revision', '1', '--request-key', 'enable-table', '--reason', 'Resume table processing.');
  assert.equal(enableTable.status, 0, enableTable.stderr);
  assert.equal(JSON.parse(enableTable.stdout).data.enabled, true);
  const captureEnabled = availability.change({ moduleId: 'atlas.capture-source', enabled: true, expectedRevision: 1, requestKey: 'enable-capture', reason: 'Resume source processing.' });
  assert.equal(captureEnabled.revision, 2);
  assert.equal(availability.list()[0].enabled, true);
  assert.equal(createModuleAvailabilityService({ stateDir }).list()[1].enabled, true);
  assert.equal((await captureModule.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', project_id: 'PRJ-A', action: 'capture-url', parameters: { url: 'https://example.test/source' } })).data.status, 'prepared');
  assert.equal(captureCalls, 1);
});
