import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createHostSessionService } from '../src/host-session-service.js';

test('default-off Host start refuses before any Handoff or process access', async () => {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const stateDir = fs.mkdtempSync(path.resolve('test/.tmp/host-session-disabled-'));
  const service = createHostSessionService({ stateDir, handoffs: { read() { assert.fail('disabled start cannot read Handoff'); } }, resolveProject() { assert.fail('disabled start cannot resolve files'); } });
  await assert.rejects(async () => service.start('PRJ-a', {}), { code: 'ATLAS_HOST_DISABLED' });
  assert.equal(service.availability().enabled, false);
  assert.match(service.availability().access_notice, /do not confine reads/u);
  service.dispose();
});

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/host-session-'));
  const stateDir = path.join(root, 'state'), projectRoot = path.join(root, 'project'), home = path.join(stateDir, 'codex');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(projectRoot);
  const executable = path.join(root, 'trusted-simulation.exe'); fs.writeFileSync(executable, 'simulation only');
  const config = { enabled: true, model_turns: true, actual_access_acknowledged: true, account_authorized: true, executable, executable_sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), cli_version: '0.162.0-alpha.2', codex_home: home };
  const handoff = { project_id: 'PRJ-a', handoff_id: 'HOF-a', digest: 'a'.repeat(64), current_work_revision: 3, status: 'current', goal: 'A checked handoff.' };
  const request = { handoff_id: handoff.handoff_id, expected_digest: handoff.digest, expected_work_revision: 3, request_key: 'request-1', prompt: 'Read the checked Handoff.' };
  let reads = 0; const clients = [];
  class Client extends EventEmitter {
    constructor() { super(); this.calls = []; this.responses = []; this.closed = false; }
    async initialize() { this.calls.push(['initialize']); }
    async request(method, params) {
      this.calls.push([method, params]);
      if (method === 'thread/start' || method === 'thread/resume') {
        if (method === 'thread/start') options.afterThread?.(config);
        return { cwd: projectRoot, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, thread: { id: 'thread-1', cwd: projectRoot, ephemeral: false, turns: method === 'thread/resume' ? [{ id: 'turn-1', items: [], status: options.resumeStatus ?? 'inProgress' }] : [] } };
      }
      if (method === 'turn/start') return { turn: { id: 'turn-1', items: [], status: 'inProgress' } };
      if (method === 'turn/interrupt') { if (!options.noInterruptCompletion) this.complete('interrupted'); return {}; }
      assert.fail(`unexpected method ${method}`);
    }
    respond(...args) { this.responses.push(args); }
    close() { if (!this.closed) { this.closed = true; this.emit('disconnect', { code: 'ATLAS_HOST_PROTOCOL', message: 'simulation closed' }); } }
    delta(text, turnId = 'turn-1') { this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId, itemId: 'item-1', delta: text } }); }
    complete(status = 'completed', turnId = 'turn-1') { this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status, items: [] } } }); }
    permission(method, id = 8) { this.emit('request', { id, method, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', reason: 'Please allow execution.' } }); }
  }
  const dependencies = { stateDir, config, handoffs: { async read() { reads++; if (options.staleSecond && reads > 1) return { ...handoff, status: 'stale' }; return handoff; } }, resolveProject(id) { return id === 'PRJ-a' ? { root: projectRoot, project: { id, status: 'active' } } : null; }, clientFactory() { const client = new Client(); clients.push(client); return client; } };
  const service = createHostSessionService(dependencies);
  t.after(() => service.dispose());
  return { root, stateDir, config, handoff, request, clients, service, dependencies };
}

test('simulated session binds Handoff and Project, streams matching text and never claims a Save', async t => {
  const f = fixture(t); const result = await f.service.start('PRJ-a', f.request);
  assert.match(result.session_id, /^HSE-[a-f0-9-]{36}$/u);
  assert.equal(result.status, 'running'); assert.equal(result.result_available, false);
  const client = f.clients[0]; client.delta('unrelated', 'other'); client.delta('<script>assistant text</script>'); client.complete('completed', 'other');
  assert.equal(f.service.show('PRJ-a', result.session_id).status, 'running');
  const streamed = f.service.events('PRJ-a', result.session_id);
  assert.deepEqual(streamed.events.filter(event => event.kind === 'message').map(event => event.text), ['<script>assistant text</script>']);
  assert.throws(() => f.service.show('PRJ-b', result.session_id), { code: 'ATLAS_PROJECT_MISMATCH' });
  await assert.rejects(f.service.cancel('PRJ-a', result.session_id, { expected_revision: 0 }), { code: 'ATLAS_STATE_CONFLICT' });
  client.complete();
  const complete = f.service.show('PRJ-a', result.session_id); assert.equal(complete.status, 'completed'); assert.equal(complete.result_available, true); assert.equal(complete.save_id, undefined);
  assert.match(f.service.events('PRJ-a', result.session_id).events.at(-1).text, /not an Atlas Save Result/u);
  const replay = await f.service.start('PRJ-a', f.request); assert.equal(replay.session_id, result.session_id); assert.equal(f.clients.length, 1);
  await assert.rejects(f.service.start('PRJ-a', { ...f.request, prompt: 'Different' }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('actual-access acknowledgement is required and stale Handoff is rejected before turn start', async t => {
  const f = fixture(t, { staleSecond: true });
  f.config.account_authorized = false;
  await assert.rejects(f.service.start('PRJ-a', f.request), { code: 'ATLAS_HOST_DISABLED' }); assert.equal(f.clients.length, 0);
  f.config.account_authorized = true;
  await assert.rejects(f.service.start('PRJ-a', f.request), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(f.clients[0].calls.some(([method]) => method === 'turn/start'), false); assert.equal(f.clients[0].closed, true);
});

test('simulated permissions deny only the current request and cancellation requires terminal evidence', async t => {
  const f = fixture(t); const session = await f.service.start('PRJ-a', f.request); const client = f.clients[0];
  for (const [index, method] of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].entries()) {
    client.permission(method, index + 8); const current = f.service.show('PRJ-a', session.session_id);
    assert.equal(current.status, 'awaiting_permission'); assert.equal(current.pending_permission.method, method);
    await assert.rejects(f.service.decide('PRJ-a', session.session_id, { expected_revision: current.revision, request_id: current.pending_permission.request_id, decision: 'accept' }), { code: 'ATLAS_INVALID_ARGUMENT' });
    await assert.rejects(f.service.decide('PRJ-a', session.session_id, { expected_revision: current.revision, request_id: 'wrong', decision: 'deny' }), { code: 'ATLAS_STATE_CONFLICT' });
    await f.service.decide('PRJ-a', session.session_id, { expected_revision: current.revision, request_id: current.pending_permission.request_id, decision: 'deny' });
    assert.deepEqual(client.responses.at(-1)[1], method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn', strictAutoReview: true } : { decision: 'decline' });
  }
  const current = f.service.show('PRJ-a', session.session_id);
  const cancelled = await f.service.cancel('PRJ-a', session.session_id, { expected_revision: current.revision }); assert.equal(cancelled.status, 'interrupted'); assert.equal(cancelled.result_available, false);
});

test('simulated reconnect resumes only its persisted turn without resending; completion replays while disabled', async t => {
  const f = fixture(t); const session = await f.service.start('PRJ-a', f.request); f.clients[0].close();
  const disconnected = f.service.show('PRJ-a', session.session_id); assert.equal(disconnected.status, 'disconnected');
  const resumed = await f.service.reconnect('PRJ-a', session.session_id, { expected_revision: disconnected.revision }); assert.equal(resumed.status, 'running');
  assert.deepEqual(f.clients[1].calls.map(([method]) => method), ['initialize', 'thread/resume']);
  f.clients[1].complete(); f.service.dispose();
  const manifest = path.join(f.stateDir, 'host-sessions', `${session.session_id}.json`); const journal = manifest.replace(/\.json$/u, '.jsonl');
  fs.unlinkSync(manifest); fs.appendFileSync(journal, '{"torn":');
  const readonly = createHostSessionService({ stateDir: f.stateDir, handoffs: null, resolveProject: null }); t.after(() => readonly.dispose());
  assert.equal(readonly.availability().enabled, false); assert.equal(readonly.show('PRJ-a', session.session_id).status, 'completed');
  assert.equal(readonly.events('PRJ-a', session.session_id).events.at(-1).kind, 'status');
});

test('Host session rejects a linked config and mid-file journal corruption', async t => {
  const f = fixture(t); const session = await f.service.start('PRJ-a', f.request); f.clients[0].complete(); f.service.dispose();
  const journal = path.join(f.stateDir, 'host-sessions', `${session.session_id}.jsonl`); fs.writeFileSync(journal, '{broken}\n' + fs.readFileSync(journal, 'utf8'));
  const read = createHostSessionService({ stateDir: f.stateDir }); t.after(() => read.dispose());
  assert.throws(() => read.show('PRJ-a', session.session_id), /mid-file corruption/u);
  const outside = path.join(f.root, 'outside.json'); fs.writeFileSync(outside, '{}'); fs.linkSync(outside, path.join(f.stateDir, 'host-integration.json'));
  assert.equal(read.availability().enabled, false); assert.match(read.availability().reason, /link/u);
});

test('simulated interrupt without terminal evidence stops the owned connection with unknown outcome', async t => {
  const f = fixture(t, { noInterruptCompletion: true }); const session = await f.service.start('PRJ-a', f.request);
  const cancelled = await f.service.cancel('PRJ-a', session.session_id, { expected_revision: session.revision });
  assert.equal(cancelled.status, 'outcome_unknown'); assert.equal(f.clients[0].closed, true); assert.equal(cancelled.result_available, false);
});

test('Host config changes cannot start a turn or reconnect a thread under a different account home', async t => {
  const changed = fixture(t, { afterThread(config) {
    const home = path.join(path.dirname(config.codex_home), 'other-home'); fs.mkdirSync(home); config.codex_home = home;
  } });
  await assert.rejects(changed.service.start('PRJ-a', changed.request), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(changed.clients[0].calls.some(([method]) => method === 'turn/start'), false);
  assert.equal(changed.clients[0].closed, true);
  const resumed = fixture(t); const session = await resumed.service.start('PRJ-a', resumed.request); resumed.clients[0].close();
  const home = path.join(resumed.stateDir, 'another-home'); fs.mkdirSync(home); resumed.config.codex_home = home;
  const current = resumed.service.show('PRJ-a', session.session_id);
  await assert.rejects(resumed.service.reconnect('PRJ-a', session.session_id, { expected_revision: current.revision }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(resumed.clients.length, 1);
});
