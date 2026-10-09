import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { runHostEvent } from '../src/host-events.js';

test('installed-entry shape separates Agent JSON receipts from documented hook feedback', () => {
  const event = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session', turn_id: 'turn', tool_use_id: 'call', tool_name: 'apply_patch' });
  const args = [path.resolve('bin/atlas-host-events.js'), '--binding', path.resolve('fixtures/host-event-binding.example.json')];
  const json = spawnSync(process.execPath, [...args, '--json'], { input: event, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(json.status, 0); const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.ok, true); assert.equal(envelope.command, 'host_event.run'); assert.equal(envelope.data.reason, 'disabled');
  const hook = spawnSync(process.execPath, args, { input: event, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(hook.status, 0); assert.deepEqual(JSON.parse(hook.stdout), { systemMessage: 'Atlas Host event: skipped (disabled).' });
});
import { installRuntime } from '../src/runtime-install.js';

test('Host event without stable identity skips before any Runtime invocation', async () => {
  const result = await runHostEvent({ bindingFile: path.resolve('fixtures/host-event-binding.example.json'), event: { kind: 'resource_changed', origin: 'codex', tool_name: 'edit' }, invoke() { assert.fail('missing identity cannot invoke Runtime'); } });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'missing_stable_identity');
});

function fixture(t) {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('test/.tmp/host-events-'));
  const installRoot = path.join(root, 'install');
  installRuntime({ sourceRoot: process.cwd(), installRoot, skillRoot: path.join(root, 'skill'), nodePath: process.execPath });
  const stateDir = path.join(installRoot, 'state'); fs.mkdirSync(stateDir, { recursive: true });
  const projectId = 'PRJ-11111111-1111-4111-8111-111111111111'; const resourceId = 'RES-22222222-2222-4222-8222-222222222222';
  const bindingFile = path.join(root, 'binding.json');
  const binding = { schema: 'atlas.host-event-binding.v1', enabled: true, recursion_verified: true, exclude_atlas_origin: true, source_origin: 'codex', known_tool_names: ['apply_patch'], install_root: installRoot, state_dir: stateDir, project_id: projectId, events: { PostToolUse: { kind: 'refresh_resources', resource_ids: [resourceId] } } };
  fs.writeFileSync(bindingFile, JSON.stringify(binding));
  const event = { session_id: 'session-1', hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'apply_patch', tool_use_id: 'tool-1', tool_input: { patch: 'bounded fixture edit' } };
  const calls = [];
  const invoke = (exe, args, options) => {
    calls.push({ exe, args, options });
    return { status: 0, stdout: JSON.stringify({ protocol_version: 'atlas-cli.v1', ok: true, command: 'resource.show', data: { resource_id: resourceId, status: 'active', desktop_href: `/projects/${projectId}/resources?resource_id=${resourceId}` } }) };
  };
  return { root, installRoot, stateDir, projectId, resourceId, bindingFile, binding, event, invoke, calls };
}

test('documented Codex PostToolUse fields refresh the bound Resource using stable tool_use_id', async t => {
  const f = fixture(t);
  const result = await runHostEvent({ bindingFile: f.bindingFile, event: f.event, invoke: f.invoke });
  assert.equal(result.status, 'completed'); assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].args.includes(f.resourceId)); assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[0].options.env.ATLAS_STATE_DIR, f.stateDir);
  const replay = await runHostEvent({ bindingFile: f.bindingFile, event: { ...f.event, timestamp: 'different timestamp' }, invoke: f.invoke });
  assert.equal(replay.event_key, result.event_key); assert.equal(replay.replayed, true); assert.equal(f.calls.length, 1);
});

test('Host event skips PreCompact and shell tools, and refuses wrong Project or unverified recursion', async t => {
  const f = fixture(t);
  assert.equal((await runHostEvent({ bindingFile: f.bindingFile, event: { session_id: 's', turn_id: 't', hook_event_name: 'PreCompact', trigger: 'auto' }, invoke: f.invoke })).reason, 'missing_stable_identity');
  for (const tool_name of ['Bash', 'exec_command', 'atlas']) assert.equal((await runHostEvent({ bindingFile: f.bindingFile, event: { ...f.event, tool_name }, invoke: f.invoke })).status, 'skipped');
  await assert.rejects(runHostEvent({ bindingFile: f.bindingFile, event: { ...f.event, project_id: 'PRJ-other' }, invoke: f.invoke }), { code: 'ATLAS_PROJECT_MISMATCH' });
  fs.writeFileSync(f.bindingFile, JSON.stringify({ ...f.binding, recursion_verified: false }));
  await assert.rejects(runHostEvent({ bindingFile: f.bindingFile, event: f.event, invoke: f.invoke }), /exclusion/u);
  assert.equal(f.calls.length, 0);
});

test('Host event validates actual CLI envelopes and keeps failure explicit', async t => {
  const f = fixture(t);
  await assert.rejects(runHostEvent({ bindingFile: f.bindingFile, event: f.event, invoke: () => ({ status: 0, stdout: JSON.stringify({ ok: true, result: {} }) }) }), /invalid envelope/u);
  await assert.rejects(runHostEvent({ bindingFile: f.bindingFile, event: { ...f.event, tool_use_id: 'other' }, invoke: () => ({ status: 0, stdout: JSON.stringify({ protocol_version: 'atlas-cli.v1', ok: true, command: 'resource.show', data: { resource_id: f.resourceId, desktop_href: '/projects/PRJ-other/resources' } }) }) }), { code: 'ATLAS_PROJECT_MISMATCH' });
  const lines = fs.readdirSync(path.join(f.stateDir, 'host-events')).filter(file => file.endsWith('.jsonl'));
  assert.equal(lines.length, 1); assert.match(fs.readFileSync(path.join(f.stateDir, 'host-events', lines[0]), 'utf8'), /"phase":"failed"/u);
});

test('Host event Handoff replay retains reviewed semantics and stable caller/request identity after uncertain failure', async t => {
  const f = fixture(t);
  const reviewed = { schema: 'atlas.handoff.v1', goal: 'Reviewed goal', work_id: 'WORK-a', resource_ids: [f.resourceId], save_ids: [], rule_request: { project_id: f.projectId }, corrections: [{ text: 'Keep correction', source: 'user' }], unfinished: ['Next'], caller: { actor: 'user', tool: 'reviewer', client_run_id: 'reviewed' }, request_key: 'reviewed' };
  const requestFile = path.join(f.root, 'reviewed.json'); fs.writeFileSync(requestFile, JSON.stringify(reviewed));
  f.binding.events.PostToolUse = { kind: 'create_handoff', request_file: requestFile, request_sha256: crypto.createHash('sha256').update(fs.readFileSync(requestFile)).digest('hex') };
  fs.writeFileSync(f.bindingFile, JSON.stringify(f.binding));
  const requests = [];
  const invoke = (exe, args) => {
    const request = JSON.parse(fs.readFileSync(args[args.indexOf('--request-file') + 1], 'utf8')); requests.push(request);
    if (requests.length === 1) return { status: 1, stdout: '' };
    return { status: 0, stdout: JSON.stringify({ protocol_version: 'atlas-cli.v1', ok: true, command: 'handoff.create', data: { project_id: f.projectId, handoff_id: 'HOF-test', digest: 'a'.repeat(64), status: 'current' } }) };
  };
  await assert.rejects(runHostEvent({ bindingFile: f.bindingFile, event: f.event, invoke }), /handoff.create failed/u);
  const result = await runHostEvent({ bindingFile: f.bindingFile, event: f.event, invoke }); assert.equal(result.status, 'completed');
  assert.equal(requests[0].request_key, requests[1].request_key); assert.deepEqual(requests[0].caller, requests[1].caller);
  for (const key of ['goal', 'rule_request', 'corrections', 'unfinished', 'resource_ids']) assert.deepEqual(requests[1][key], reviewed[key]);
  const replay = await runHostEvent({ bindingFile: f.bindingFile, event: f.event, invoke }); assert.equal(replay.replayed, true); assert.equal(requests.length, 2);
});
