import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { createResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { PreferenceRules } from '../src/preference-rules.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createSavedWorkService } from '../src/ui/services/saved-work-service.js';
import { createTableWorkModule } from '../src/table-work-module.js';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';

async function basicFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'host-session-ui-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'A'), { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const created = registry.create({ name: 'Host UI fixture', currentPath: 'A' });
  registry.attachRoot(created.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Host UI test.' });
  const server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {}, projectRoot: root, installationRoot: root, ...options });
  t.after(async () => { await server.close(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `/projects/${created.project_id}/host-sessions`;
  const html = await (await fetch(new URL(`/projects/${created.project_id}`, server.workspace_url))).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)?.[1];
  return { root, stateDir, registry, server, project: created, base, csrf };
}

test('Host session mutations require CSRF before starting a process', { timeout: 30_000 }, async (t) => {
  const f = await basicFixture(t);
  for (const route of [f.base, `${f.base}/HSE-00000000-0000-4000-8000-000000000001/deny`, `${f.base}/HSE-00000000-0000-4000-8000-000000000001/cancel`, `${f.base}/HSE-00000000-0000-4000-8000-000000000001/reconnect`]) {
    const response = await fetch(new URL(route, f.server.workspace_url), { method: 'POST', body: new URLSearchParams({ csrf: 'invalid' }), redirect: 'manual' });
    assert.equal(response.status, 403);
  }
});

test('default-off Host session start refuses browser executable/config inputs and never enables access', { timeout: 30_000 }, async (t) => {
  const f = await basicFixture(t); assert.ok(f.csrf);
  const response = await fetch(new URL(f.base, f.server.workspace_url), { method: 'POST', body: new URLSearchParams({ csrf: f.csrf, handoff_id: 'HOF-fixture', expected_digest: 'a'.repeat(64), expected_work_revision: '1', request_key: 'UI-fixture', prompt: 'Continue', executable: 'untrusted' }), redirect: 'manual' });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /Session completed|Saved and verified/u);
  const disabled = await fetch(new URL(f.base, f.server.workspace_url), { method: 'POST', body: new URLSearchParams({ csrf: f.csrf, handoff_id: 'HOF-fixture', expected_digest: 'a'.repeat(64), expected_work_revision: '1', request_key: 'UI-fixture', prompt: 'Continue' }), redirect: 'manual' });
  assert.equal(disabled.status, 503);
  assert.match(await disabled.text(), /disabled|not enabled/iu);
});

test('simulated App Server with real Handoff/session service streams, denies, interrupts and resumes only its recorded thread', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'host-session-chain-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'A');
  fs.mkdirSync(path.join(projectRoot, 'Data'), { recursive: true }); fs.mkdirSync(path.join(workspace, 'B'));
  const sourcePath = path.join(projectRoot, 'Data', 'input.csv'); fs.writeFileSync(sourcePath, 'region,value\nNorth,20\n');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const attach = folder => { const p = registry.create({ name: folder, currentPath: folder }); registry.attachRoot(p.project_id, { rootId: adopted.root_id, relativePath: folder, reason: 'Simulated Host UI test.' }); return p.project_id; };
  const projectId = attach('A'); const otherId = attach('B'); const project = { id: projectId, name: 'A', status: 'active' };
  const control = createResourceControl({ stateDir, ledger: registry.ledger }); const resource = control.identify({ filePath: sourcePath, project });
  const fingerprintFn = async filePath => ({ file_path: filePath, sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), bytes: fs.statSync(filePath).size });
  const dataWork = createDataWorkService({ stateDir, projectRoot: path.resolve('.'), installationRoot: path.resolve('.'), resourceControl: control, fingerprintFn,
    runDataWorkFn: async ({ filePath }) => ({ status: 'ready', source: { sha256: (await fingerprintFn(filePath)).sha256 }, processor: { version: 'simulated-profile' }, sheets: [], profile: { rows: 1, columns: 2, fields: [{ name: 'region', inferred_type: 'text', missing_count: 0, distinct_count: 1 }, { name: 'value', inferred_type: 'number', missing_count: 0, distinct_count: 1 }] } }) });
  const rules = new PreferenceRules({ stateDir, ledger: registry.ledger }); const intake = new Intake({ stateDir });
  const table = createTableWorkModule({ dataWork, savedWork: createSavedWorkService({ stateDir }), resolveProject: () => ({ project, root: projectRoot, location: registry.show(projectId).location }) });
  const work = (await table.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: projectId, action: 'start', parameters: { resource_ids: [resource.resource_id] } })).data;
  await dataWork.prepareSources(work.session_id);
  const executable = path.join(stateDir, 'simulated-host'); fs.writeFileSync(executable, 'SIMULATED CLIENT ONLY; NEVER EXECUTED');
  const codexHome = path.join(stateDir, 'codex-home'); fs.mkdirSync(codexHome);
  const config = { enabled: true, executable, executable_sha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), cli_version: '0.162.0-alpha.2', codex_home: codexHome, model_turns: true, actual_access_acknowledged: true, account_authorized: true };
  const clients = []; const calls = []; const responses = [];
  class SimulatedClient extends EventEmitter {
    constructor(cwd) { super(); this.cwd = cwd; }
    async initialize() { calls.push('initialize'); return { userAgent: 'simulated-host' }; }
    async request(method, parameters) {
      calls.push(method);
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-simulated', cwd: this.cwd, ephemeral: false, turns: method === 'thread/resume' ? [{ id: 'turn-simulated', status: 'completed', items: [] }] : [] }, cwd: this.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } };
      if (method === 'turn/start') return { turn: { id: 'turn-simulated', status: 'inProgress', items: [] } };
      if (method === 'turn/interrupt') { this.emit('notification', { method: 'turn/completed', params: { threadId: parameters.threadId, turn: { id: parameters.turnId, status: 'interrupted', items: [] } } }); return {}; }
      throw new Error('Unexpected simulated RPC');
    }
    respond(...args) { responses.push(args); }
    close() {}
  }
  const options = { stateDir, registry, rules, intake, runtime: {}, projectRoot: path.resolve('.'), installationRoot: path.resolve('.'), dataWorkService: dataWork, resourceControl: control, hostSessionOptions: { config, clientFactory: ({ cwd }) => { const client = new SimulatedClient(cwd); clients.push(client); return client; } } };
  let server = await startAtlasUiServer(options);
  t.after(async () => { if (server) await server.close(); intake.dispose(); control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const get = async route => { const response = await fetch(new URL(route, server.workspace_url)); assert.equal(response.status, 200); return response.text(); };
  const post = (route, fields) => fetch(new URL(route, server.workspace_url), { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual' });
  const home = await get(`/projects/${projectId}`); const csrf = home.match(/name="csrf" value="([^"]+)"/u)[1];
  const created = await post(`/projects/${projectId}/handoffs`, { csrf, request_key: 'Handoff-simulated', goal: 'Continue simulated work', work_id: work.session_id }); assert.equal(created.status, 303);
  const handoffHref = created.headers.get('location'); const handoffHtml = await get(handoffHref);
  const fields = Object.fromEntries([...handoffHtml.matchAll(/name="(handoff_id|expected_digest|expected_work_revision|request_key)" value="([^"]+)"/gu)].map(m => [m[1], m[2]]));
  assert.match(handoffHtml, /Start a new AI session/u); assert.ok(fields.expected_digest);
  const startFields = { ...fields, csrf, prompt: 'Simulated instruction' }; const base = `/projects/${projectId}/host-sessions`;
  const stale = await post(base, { ...startFields, expected_digest: 'f'.repeat(64) }); assert.equal(stale.status, 409); assert.equal(clients.length, 0);
  const started = await post(base, startFields); assert.equal(started.status, 303);
  const sessionHref = started.headers.get('location'); const sessionId = sessionHref.split('/').at(-1);
  const snapshot = async () => { const response = await fetch(new URL(`${sessionHref}/status`, server.workspace_url)); assert.equal(response.status, 200); return (await response.json()).result.session; };
  clients[0].emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-simulated', turnId: 'turn-simulated', itemId: 'item-1', delta: '<script>simulated response</script>' } });
  assert.match(await get(sessionHref), /&lt;script&gt;simulated response&lt;\/script&gt;/u);
  const foreign = await fetch(new URL(`/projects/${otherId}/host-sessions/${sessionId}/events`, server.workspace_url)); assert.equal(foreign.status, 403);
  clients[0].emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-simulated', turnId: 'turn-simulated', itemId: 'item-1', reason: 'Simulated command request' } });
  let current = await snapshot(); assert.equal(current.status, 'awaiting_permission');
  assert.equal((await post(`${sessionHref}/deny`, { csrf, expected_revision: String(current.revision - 1), request_id: '7' })).status, 409);
  assert.equal((await post(`${sessionHref}/deny`, { csrf, expected_revision: String(current.revision), request_id: '7', decision: 'approve' })).status, 400);
  assert.equal((await post(`${sessionHref}/deny`, { csrf, expected_revision: String(current.revision), request_id: '7' })).status, 303);
  assert.equal(responses.at(-1)[1].decision, 'decline');
  current = await snapshot(); assert.equal(current.pending_permission, null);
  assert.equal((await post(`${sessionHref}/cancel`, { csrf, expected_revision: String(current.revision) })).status, 303);
  assert.equal((await snapshot()).status, 'interrupted');
  const second = await post(base, { ...startFields, request_key: 'UI-HOST-second' }); assert.equal(second.status, 303);
  const secondHref = second.headers.get('location');
  clients[1].emit('disconnect', new Error('Simulated transport loss'));
  const disconnected = (await (await fetch(new URL(`${secondHref}/status`, server.workspace_url))).json()).result.session;
  assert.equal(disconnected.status, 'disconnected'); assert.match(await get(secondHref), /Reconnect recorded thread/u);
  const priorTurns = calls.filter(c => c === 'turn/start').length;
  assert.equal((await post(`${secondHref}/reconnect`, { csrf, expected_revision: String(disconnected.revision) })).status, 303);
  assert.equal(calls.filter(c => c === 'turn/start').length, priorTurns);
  const completed = await get(secondHref); assert.match(completed, /Response completed/u); assert.match(completed, /not a saved file/u);
  await server.close(); server = await startAtlasUiServer({ ...options, hostSessionOptions: {} });
  assert.match(await get(secondHref), /Response completed/u);
});
