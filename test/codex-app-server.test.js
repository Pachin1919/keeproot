import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexAppServerClient } from '../src/codex-app-server.js';

function fixture(t) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false; child.kill = () => { child.killed = true; };
  let invocation;
  const client = new CodexAppServerClient({ config: {}, stateDir: 'simulated', cwd: 'simulated', verify: () => ({ executable: 'trusted-simulated', home: 'isolated-simulated' }), spawnProcess(...args) { invocation = args; return child; } });
  t.after(() => client.close());
  const wire = message => child.stdout.write(JSON.stringify(message) + '\n');
  return { client, child, wire, get invocation() { return invocation; } };
}

test('simulated App Server initializes before requests and uses explicit isolated home without shell', async t => {
  const f = fixture(t);
  await assert.rejects(f.client.request('thread/start', {}), /uninitialized/u);
  const init = f.client.initialize(); f.wire({ id: 1, result: { userAgent: 'simulation' } }); await init;
  assert.equal(f.invocation[2].shell, false); assert.equal(f.invocation[2].windowsHide, true); assert.equal(f.invocation[2].env.CODEX_HOME, 'isolated-simulated');
  const request = f.client.request('turn/interrupt', { threadId: 't', turnId: 'u' }); f.wire({ id: 2, result: {} }); await request;
});

test('simulated App Server rejects malformed, batch and oversized lines and closes pending readers', async t => {
  for (const value of ['not json\n', '[]\n', 'x'.repeat(1024 * 1024 + 1)]) {
    const f = fixture(t); const pending = f.client.initialize();
    const rejected = assert.rejects(pending, /Malformed|batches|1 MiB/u);
    f.child.stdout.write(value); await rejected; assert.equal(f.child.killed, true);
  }
});

test('simulated App Server denies unsupported requests and rejects incomplete thread responses', async t => {
  const f = fixture(t); const initialized = f.client.initialize(); f.wire({ id: 1, result: { userAgent: 'simulation' } }); await initialized;
  f.child.stdin.read(); // Drain initialization bytes before inspecting this request's reply.
  f.wire({ id: 'server-1', method: 'unrecognized', params: {} });
  const reply = JSON.parse(f.child.stdin.read().toString('utf8'));
  assert.deepEqual(reply, { id: 'server-1', error: { code: -32601, message: 'Unsupported client request.' } });
  const pending = f.client.request('thread/start', {}); const rejected = assert.rejects(pending, /Invalid thread\/start/u);
  f.wire({ id: 2, result: { thread: { id: 't' } } }); await rejected; assert.equal(f.client.closed, true);
});

test('simulated App Server caps pending requests and close rejects every waiter', async t => {
  const f = fixture(t); const initialized = f.client.initialize(); f.wire({ id: 1, result: { userAgent: 'simulation' } }); await initialized;
  const waiters = Array.from({ length: 16 }, () => assert.rejects(f.client.request('turn/interrupt', {}), /closed/u));
  await assert.rejects(f.client.request('turn/interrupt', {}), /16 pending/u); f.client.close(); await Promise.all(waiters);
});
