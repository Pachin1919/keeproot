import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';
import { CAPTURE_SOURCE_MODULE_DESCRIPTOR, createCaptureSourceModule } from '../src/capture-source-module.js';

test('Capture Source Module validates its envelope and delegates bounded source actions', async () => {
  const calls = [];
  const captureSource = {
    inspectExport: (parameters) => { calls.push(['inspect-export', parameters]); return { input_revision: { sha256: 'a'.repeat(64) } }; },
    prepareExport: async (parameters) => { calls.push(['prepare-export', parameters]); return { status: 'prepared', save_id: 'SAV-fixture' }; },
    prepare: async (parameters) => { calls.push(['capture-url', parameters]); return { status: 'export_required' }; },
    show: (saveId, options) => { calls.push(['show', saveId, options]); return { save_id: saveId }; },
    read: (saveId, options) => { calls.push(['read', saveId, options]); return { save_id: saveId, excerpt: 'selected text' }; },
  };
  const module = createCaptureSourceModule({ captureSource });
  assert.equal(module.describe().module_id, 'atlas.capture-source');
  assert.deepEqual(module.describe().actions, ['inspect-export', 'prepare-export', 'capture-url', 'show', 'read']);
  assert.deepEqual(CAPTURE_SOURCE_MODULE_DESCRIPTOR.actions, module.describe().actions);

  const inspected = await module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', action: 'inspect-export', parameters: { inputPath: 'fixture.json', limit: 5 } });
  assert.equal(inspected.data.input_revision.sha256, 'a'.repeat(64));
  assert.equal(inspected.project_id, null);
  const prepared = await module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', project_id: 'PRJ-A', action: 'prepare-export', parameters: { inputPath: 'fixture.json', requestKey: 'key' } });
  assert.equal(prepared.data.save_id, 'SAV-fixture');
  assert.equal(calls[1][1].projectId, 'PRJ-A');
  const captured = await module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', project_id: 'PRJ-A', action: 'capture-url', parameters: { url: 'https://example.test/share', requestKey: 'url-key' } });
  assert.equal(captured.data.status, 'export_required');
  assert.equal(calls[2][1].projectId, 'PRJ-A');
  const shown = await module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', project_id: 'PRJ-A', action: 'show', parameters: { saveId: 'SAV-fixture' } });
  assert.equal(shown.data.save_id, 'SAV-fixture');
  const read = await module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', project_id: 'PRJ-A', action: 'read', parameters: { saveId: 'SAV-fixture', cursor: 'next', characters: 20, mode: 'changes' } });
  assert.equal(read.data.excerpt, 'selected text');
  assert.equal(calls.find(([action]) => action === 'read')[2].mode, 'changes');

  await assert.rejects(module.invoke({ protocol: 'wrong', module_id: 'atlas.capture-source', action: 'inspect-export' }), { code: 'ATLAS_MODULE_PROTOCOL_UNSUPPORTED' });
  await assert.rejects(module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.unknown', action: 'inspect-export' }), { code: 'ATLAS_MODULE_NOT_FOUND' });
  await assert.rejects(module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', action: 'cancel' }), { code: 'ATLAS_MODULE_ACTION_UNSUPPORTED' });
  await assert.rejects(module.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.capture-source', action: 'read', parameters: { saveId: 'SAV-fixture' } }), { code: 'ATLAS_MODULE_PROJECT_REQUIRED' });
});
