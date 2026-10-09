import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { boundedJson, createCodexAppServerClient, hostError, plainPath, validateHostConfig, validateHostResponse } from './codex-app-server.js';

const TERMINAL = new Set(['completed', 'interrupted', 'failed', 'cancelled', 'outcome_unknown']);
const ACCESS_NOTICE = 'Read-only sandbox and Project cwd do not confine reads to selected files. Model turns use the configured process account and account authorization; Atlas cannot guarantee selected-file read confinement.';
const text = (value, label, max = 4096) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw hostError(`${label} must be bounded nonempty text.`, 'ATLAS_INVALID_ARGUMENT');
  return value.trim();
};
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeError = error => ({ code: error.code ?? 'ATLAS_HOST_PROTOCOL', message: String(error.message ?? 'Host failed.').slice(0, 2000) });
const idPattern = /^HSE-[a-f0-9-]{36}$/u;
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

export function createHostSessionService({ stateDir, handoffs, resolveProject, config, clientFactory = createCodexAppServerClient } = {}) {
  stateDir = plainPath(path.resolve(stateDir), { directory: true });
  const sessionsRoot = path.join(stateDir, 'host-sessions');
  const loaded = new Map(); const clients = new Map(); const permissions = new Map(); const leases = new Map();
  let disposed = false; let busy = false; let lockOwned = false;
  const configNow = () => {
    if (config !== undefined) return config;
    const file = path.join(stateDir, 'host-integration.json');
    return fs.existsSync(file) ? boundedJson(file) : null;
  };
  function availability() {
    try {
      const current = configNow();
      if (!current?.enabled) return { enabled: false, reason: 'disabled', access_notice: ACCESS_NOTICE };
      validateHostConfig(current, stateDir, { probe: false });
      if (current.model_turns !== true || current.actual_access_acknowledged !== true || current.account_authorized !== true) return { enabled: false, reason: 'actual_access_and_account_authorization_required', access_notice: ACCESS_NOTICE };
      return { enabled: true, reason: null, access_notice: ACCESS_NOTICE };
    } catch (error) { return { enabled: false, reason: safeError(error).message, access_notice: ACCESS_NOTICE }; }
  }
  function requireEnabled() {
    if (disposed || !availability().enabled) throw hostError('Host model turns are disabled. Configure a pinned executable, isolated Codex home, actual process-access acknowledgement and account authorization before use.', 'ATLAS_HOST_DISABLED');
  }
  function scopeFingerprint(root) {
    const selected = configNow();
    const trusted = validateHostConfig(selected, stateDir, { probe: false });
    return sha({ root: path.resolve(root), executable: trusted.executable, executable_sha256: selected.executable_sha256,
      cli_version: selected.cli_version, codex_home: trusted.home, model_turns: selected.model_turns,
      actual_access_acknowledged: selected.actual_access_acknowledged, account_authorized: selected.account_authorized });
  }
  function requireSameScope(session) {
    if (session.scope_fingerprint !== scopeFingerprint(session.root)) throw hostError('Host executable, account home or authorization changed; this session cannot continue under a different configuration.', 'ATLAS_STATE_CONFLICT');
  }
  function fileFor(id, suffix) {
    if (!idPattern.test(id ?? '')) throw hostError('Invalid Host session identity.', 'ATLAS_INVALID_ARGUMENT');
    plainPath(sessionsRoot, { boundary: stateDir, directory: true, absent: true });
    const file = path.join(sessionsRoot, `${id}.${suffix}`);
    plainPath(file, { boundary: stateDir, absent: true }); return file;
  }
  function ensureRoot() { plainPath(sessionsRoot, { boundary: stateDir, directory: true, absent: true }); fs.mkdirSync(sessionsRoot, { recursive: true }); }
  function acquire() {
    if (lockOwned) return;
    ensureRoot();
    const file = path.join(sessionsRoot, 'service.lock'); plainPath(file, { boundary: stateDir, absent: true });
    if (fs.existsSync(file)) {
      const owner = boundedJson(file);
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw hostError('Host session lock requires inspection.', 'ATLAS_STATE_CONFLICT');
      try { process.kill(owner.pid, 0); throw hostError('Another Host session service owns this state.', 'ATLAS_STATE_CONFLICT'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.unlinkSync(file);
    }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); lockOwned = true;
  }
  function atomic(file, value) {
    plainPath(file, { boundary: stateDir, absent: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' });
    try { fs.renameSync(temporary, file); } catch (error) { fs.unlinkSync(temporary); throw error; }
  }
  function record(session, kind, content, extra = {}) {
    acquire();
    const event = { sequence: session.last_sequence + 1, kind, text: String(content).slice(0, 16384), ...extra };
    const updated = { ...session, revision: session.revision + 1, last_sequence: event.sequence };
    const row = JSON.stringify({ sequence: event.sequence, event, session: updated }) + '\n';
    const journal = fileFor(session.session_id, 'jsonl');
    const bytes = fs.existsSync(journal) ? fs.statSync(journal).size : 0;
    if (bytes + Buffer.byteLength(row) > 4 * 1024 * 1024) throw hostError('Host event journal reached its 4 MiB limit.');
    fs.appendFileSync(journal, row, { flag: 'a' });
    Object.assign(session, updated);
    atomic(fileFor(session.session_id, 'json'), session);
    return event;
  }
  function read(id) {
    if (loaded.has(id)) return loaded.get(id);
    const manifest = fileFor(id, 'json'), journal = fileFor(id, 'jsonl');
    if (!fs.existsSync(journal)) throw hostError('Host session is unavailable.', 'ATLAS_NOT_FOUND');
    if (fs.statSync(journal).size > 4 * 1024 * 1024) throw hostError('Host event journal exceeds 4 MiB.');
    const bytes = fs.readFileSync(journal); const lines = bytes.toString('utf8').split('\n');
    let session, sequence = 0, validBytes = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      let row; try { row = JSON.parse(lines[i]); } catch { throw hostError('Host journal has mid-file corruption.'); }
      if (row.sequence !== ++sequence || row.event?.sequence !== sequence || row.session?.session_id !== id || row.session.last_sequence !== sequence || !Number.isInteger(row.session.revision)) throw hostError('Host journal sequence or identity is corrupt.');
      session = row.session; validBytes += Buffer.byteLength(lines[i] + '\n');
    }
    if (!session) throw hostError('Host journal has no durable session intent.');
    if (fs.existsSync(manifest)) {
      const stored = boundedJson(manifest, 65536);
      if (stored.session_id !== id || stored.last_sequence > sequence || stored.project_id !== session.project_id) throw hostError('Host manifest and journal identity disagree.');
    }
    const overflow = fileFor(id, 'error.json');
    if (fs.existsSync(overflow)) {
      const stopped = boundedJson(overflow);
      if (stopped.session_id !== id || stopped.last_sequence !== sequence || stopped.status !== 'outcome_unknown') throw hostError('Host limit-stop identity does not match its journal.');
      session.status = 'outcome_unknown'; session.error = stopped.error; session.result_available = false;
    }
    session._torn_bytes = bytes.length !== validBytes ? validBytes : null;
    if (!TERMINAL.has(session.status)) { session.status = 'disconnected'; session.pending_permission = null; }
    loaded.set(id, session); return session;
  }
  function prepareWrite(session) {
    acquire();
    if (session._torn_bytes !== null && session._torn_bytes !== undefined) fs.truncateSync(fileFor(session.session_id, 'jsonl'), session._torn_bytes);
    delete session._torn_bytes;
  }
  function view(session) {
    return Object.fromEntries(['session_id', 'project_id', 'handoff_id', 'revision', 'status', 'thread_id', 'turn_id', 'last_sequence', 'pending_permission', 'result_available', 'error'].map(key => [key, session[key] ?? null]));
  }
  function scoped(projectId, id, revision) {
    const session = read(id);
    if (session.project_id !== projectId) throw hostError('Host session belongs to another Project.', 'ATLAS_PROJECT_MISMATCH');
    if (revision !== undefined && (!Number.isInteger(revision) || session.revision !== revision)) throw hostError('Host session revision changed. Read the current session before continuing.', 'ATLAS_STATE_CONFLICT');
    return session;
  }
  function touch(session) { if (!TERMINAL.has(session.status)) leases.set(session.session_id, Date.now()); }
  function show(projectId, id) { const session = scoped(projectId, id); touch(session); return view(session); }
  function events(projectId, id, afterSequence = 0) {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw hostError('Event cursor must be a nonnegative integer.', 'ATLAS_INVALID_ARGUMENT');
    const session = scoped(projectId, id); touch(session);
    const rows = fs.readFileSync(fileFor(id, 'jsonl'), 'utf8').split('\n'); const result = []; let bytes = 0;
    for (const line of rows.slice(0, -1)) {
      const event = JSON.parse(line).event;
      if (event.sequence <= afterSequence) continue;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (result.length >= 128 || bytes + size > 256 * 1024) break;
      result.push(event); bytes += size;
    }
    return { session: view(session), events: result, last_sequence: result.at(-1)?.sequence ?? afterSequence };
  }
  async function currentHandoff(projectId, request) {
    const handoff = await handoffs.read({ projectId, handoffId: request.handoff_id });
    if (handoff.project_id !== projectId) throw hostError('Handoff belongs to another Project.', 'ATLAS_PROJECT_MISMATCH');
    if (handoff.status !== 'current' || handoff.digest !== request.expected_digest || handoff.current_work_revision !== request.expected_work_revision) throw hostError('Handoff or Work changed; create or read a current Handoff.', 'ATLAS_STATE_CONFLICT');
    const entry = resolveProject(projectId);
    if (!entry?.root || entry.project?.status !== 'active') throw hostError('Host requires an active attached Project.', 'ATLAS_PROJECT_MISMATCH');
    const root = plainPath(entry.root, { directory: true }); return { handoff, root };
  }
  function failure(session, error, status = 'failed') {
    session.status = status; session.error = safeError(error); session.pending_permission = null;
    try { record(session, 'error', session.error.message); }
    catch (writeError) {
      if (/4 MiB/u.test(writeError.message)) {
        session.status = 'outcome_unknown'; session.result_available = false;
        atomic(fileFor(session.session_id, 'error.json'), { session_id: session.session_id, last_sequence: session.last_sequence, status: session.status, error: session.error });
      }
      // A path-boundary failure permits no further state writes.
    }
    clients.get(session.session_id)?.close(); clients.delete(session.session_id);
  }
  function finish(session, turn) {
    if (turn.id !== session.turn_id || !['completed', 'failed', 'interrupted'].includes(turn.status)) return;
    session.status = turn.status; session.result_available = turn.status === 'completed'; session.pending_permission = null;
    if (turn.error) session.error = { code: 'ATLAS_HOST_PROTOCOL', message: String(turn.error.message ?? 'Host turn failed.').slice(0, 2000) };
    record(session, 'status', `Host turn ${turn.status}. Assistant output is not an Atlas Save Result.`);
    const permission = permissions.get(session.session_id); if (permission) clearTimeout(permission.timer);
    permissions.delete(session.session_id); leases.delete(session.session_id);
  }
  function responseFor(method, decision) { return method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn', strictAutoReview: true } : { decision: decision === 'cancel' ? 'cancel' : 'decline' }; }
  function attach(session, client) {
    clients.set(session.session_id, client);
    const backlog = []; let ready = false;
    const notification = message => {
      const { method, params = {} } = message;
      if (params.threadId !== session.thread_id || TERMINAL.has(session.status)) return;
      if (method === 'turn/completed') { if (params.turn?.id === session.turn_id) finish(session, params.turn); }
      else if (method === 'item/agentMessage/delta' && params.turnId === session.turn_id && typeof params.itemId === 'string' && typeof params.delta === 'string') {
        for (let offset = 0; offset < params.delta.length; offset += 16384) record(session, 'message', params.delta.slice(offset, offset + 16384), { item_id: params.itemId.slice(0, 256) });
      }
    };
    client.on('notification', message => {
      try { if (!ready) { if (backlog.length >= 128) throw hostError('Host startup notification buffer exceeded its limit.'); backlog.push(message); } else notification(message); }
      catch (error) { failure(session, error, 'outcome_unknown'); }
    });
    client.on('request', message => {
      try {
        const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(message.method);
        const params = message.params ?? {};
        if (!supported || !ready || params.threadId !== session.thread_id || params.turnId !== session.turn_id || typeof params.itemId !== 'string' || permissions.has(session.session_id)) {
          client.respond(message.id, null, { code: -32601, message: 'Atlas denies unsupported or unbound client requests.' });
          if (!supported) failure(session, hostError('Unsupported Host client request was denied.'), 'outcome_unknown');
          return;
        }
        const requestId = String(message.id);
        session.pending_permission = { request_id: requestId, method: message.method, description: String(params.reason ?? 'Host requests execution, file changes, or additional permissions. Atlas supports denial only.').slice(0, 2000), expires_at: new Date(Date.now() + 120000).toISOString() };
        session.status = 'awaiting_permission'; record(session, 'permission', session.pending_permission.description);
        const timer = setTimeout(() => { if (permissions.get(session.session_id)?.requestId === requestId) denyCurrent(session, 'deny'); }, 120000); timer.unref();
        permissions.set(session.session_id, { requestId, rpcId: message.id, method: message.method, timer });
        if (!leases.has(session.session_id)) denyCurrent(session, 'deny');
      } catch (error) { failure(session, error, 'outcome_unknown'); }
    });
    client.on('disconnect', error => {
      if (!TERMINAL.has(session.status) && session.status !== 'disconnected') {
        session.status = 'disconnected'; session.error = safeError(error); session.pending_permission = null;
        const pending = permissions.get(session.session_id); if (pending) clearTimeout(pending.timer);
        permissions.delete(session.session_id);
        try { record(session, 'error', 'Host disconnected. Reconnect explicitly; Atlas will not resend the turn.'); } catch { /* Preserve the last durable intent. */ }
      }
    });
    return () => { ready = true; for (const message of backlog) notification(message); backlog.length = 0; };
  }
  function denyCurrent(session, decision) {
    const pending = permissions.get(session.session_id); if (!pending) throw hostError('Permission request is no longer current.', 'ATLAS_STATE_CONFLICT');
    clearTimeout(pending.timer); permissions.delete(session.session_id);
    clients.get(session.session_id).respond(pending.rpcId, responseFor(pending.method, decision));
    session.pending_permission = null; session.status = 'running'; record(session, 'permission', `Permission ${decision === 'cancel' ? 'cancelled' : 'denied'}; no command or root expansion was granted.`);
  }
  function checkThread(result, root, id = null) {
    if (!samePath(result.cwd, root) || !samePath(result.thread.cwd, root) || result.approvalPolicy !== 'on-request' || result.approvalsReviewer !== 'user' || result.sandbox.type !== 'readOnly' || result.sandbox.networkAccess === true || result.thread.ephemeral !== false || (id && result.thread.id !== id)) throw hostError('Host returned a different thread, cwd, or permission policy.');
  }
  async function start(projectId, request = {}) {
    requireEnabled();
    if (busy) throw hostError('A Host session mutation is in progress.', 'ATLAS_STATE_CONFLICT');
    const allowed = ['handoff_id', 'expected_digest', 'expected_work_revision', 'request_key', 'prompt'];
    if (Object.keys(request).some(key => !allowed.includes(key))) throw hostError('Unsupported Host start field.', 'ATLAS_INVALID_ARGUMENT');
    text(request.handoff_id, 'handoff_id', 128); text(request.expected_digest, 'expected_digest', 64); text(request.request_key, 'request_key', 256); text(request.prompt, 'prompt', 16000);
    if (!Number.isInteger(request.expected_work_revision)) throw hostError('A Work revision is required.', 'ATLAS_INVALID_ARGUMENT');
    busy = true; let session;
    try {
      acquire();
      const requestHash = sha({ projectId, ...request });
      for (const file of fs.readdirSync(sessionsRoot).filter(file => /^HSE-[a-f0-9-]{36}\.jsonl$/u.test(file))) {
        const existing = read(file.slice(0, -6));
        if (existing.request_key === request.request_key && existing.project_id === projectId) {
          if (existing.request_hash !== requestHash) throw hostError('Host request key was used for different content.', 'ATLAS_STATE_CONFLICT');
          touch(existing); return view(existing);
        }
        if (!TERMINAL.has(existing.status)) throw hostError('Another active or disconnected Host session must be resolved first.', 'ATLAS_STATE_CONFLICT');
      }
      const current = await currentHandoff(projectId, request);
      session = { session_id: `HSE-${crypto.randomUUID()}`, project_id: projectId, handoff_id: request.handoff_id, revision: 0, status: 'starting', thread_id: null, turn_id: null, last_sequence: 0, pending_permission: null, result_available: false, error: null, request_key: request.request_key, request_hash: requestHash, root: current.root, scope_fingerprint: scopeFingerprint(current.root), expected_digest: request.expected_digest, expected_work_revision: request.expected_work_revision };
      loaded.set(session.session_id, session); touch(session); record(session, 'status', 'New Host session intent recorded.');
      const client = clientFactory({ config: configNow(), stateDir, cwd: current.root }); const flush = attach(session, client);
      await client.initialize();
      const started = validateHostResponse('thread/start', await client.request('thread/start', { cwd: current.root, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', ephemeral: false }));
      checkThread(started, current.root); session.thread_id = started.thread.id; record(session, 'status', 'New Atlas-owned Host thread recorded.');
      const reread = await currentHandoff(projectId, request);
      if (!samePath(reread.root, current.root)) throw hostError('Project root changed before starting the Host turn.', 'ATLAS_STATE_CONFLICT');
      requireSameScope(session);
      session.status = 'starting'; record(session, 'status', 'Host turn intent recorded; interrupted starts are never resent.');
      const prompt = `Atlas Handoff (current local facts, not file-read confinement):\n${JSON.stringify(current.handoff)}\n\nUser request:\n${request.prompt}`;
      const turned = validateHostResponse('turn/start', await client.request('turn/start', { threadId: session.thread_id, clientUserMessageId: sha({ session_id: session.session_id, request_key: request.request_key }), input: [{ type: 'text', text: prompt, text_elements: [] }] }));
      session.turn_id = turned.turn.id; session.status = 'running'; record(session, 'status', 'Host turn recorded; assistant output is not an Atlas Save Result.'); flush();
      return view(session);
    } catch (error) { if (session) failure(session, error, session.thread_id ? 'outcome_unknown' : 'failed'); throw error; }
    finally { busy = false; }
  }
  async function cancel(projectId, id, { expected_revision } = {}) {
    const session = scoped(projectId, id, expected_revision);
    if (TERMINAL.has(session.status)) return view(session);
    prepareWrite(session);
    if (permissions.has(id)) denyCurrent(session, 'cancel');
    const client = clients.get(id);
    if (!client || !session.turn_id) { failure(session, hostError('Host turn outcome is unknown; no resend was attempted.'), 'outcome_unknown'); return view(session); }
    session.status = 'cancelling'; record(session, 'status', 'Host interrupt requested.');
    const deadline = Date.now() + 5000;
    try { await client.request('turn/interrupt', { threadId: session.thread_id, turnId: session.turn_id }, { timeoutMs: 5000 }); } catch { /* Require a matching terminal notification. */ }
    while (!TERMINAL.has(session.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!TERMINAL.has(session.status)) failure(session, hostError('Interrupt had no matching terminal notification; outcome remains unknown.'), 'outcome_unknown');
    return view(session);
  }
  async function decide(projectId, id, { request_id, expected_revision, decision } = {}) {
    const session = scoped(projectId, id, expected_revision);
    if (!['deny', 'cancel'].includes(decision)) throw hostError('Atlas supports denial or cancellation only.', 'ATLAS_INVALID_ARGUMENT');
    if (session.pending_permission?.request_id !== request_id) throw hostError('Permission request changed.', 'ATLAS_STATE_CONFLICT');
    prepareWrite(session); denyCurrent(session, decision);
    return decision === 'cancel' ? cancel(projectId, id, { expected_revision: session.revision }) : view(session);
  }
  async function reconnect(projectId, id, { expected_revision } = {}) {
    requireEnabled(); const session = scoped(projectId, id, expected_revision);
    if (session.status !== 'disconnected' || !session.thread_id) throw hostError('Only a disconnected persisted Atlas thread can reconnect.', 'ATLAS_STATE_CONFLICT');
    if (busy) throw hostError('A Host mutation is in progress.', 'ATLAS_STATE_CONFLICT');
    busy = true;
    try {
      const current = await currentHandoff(projectId, { handoff_id: session.handoff_id, expected_digest: session.expected_digest, expected_work_revision: session.expected_work_revision });
      if (!samePath(current.root, session.root)) throw hostError('Project root changed.', 'ATLAS_STATE_CONFLICT');
      requireSameScope(session);
      prepareWrite(session);
      const client = clientFactory({ config: configNow(), stateDir, cwd: session.root }); const flush = attach(session, client);
      await client.initialize();
      requireSameScope(session);
      const resumed = validateHostResponse('thread/resume', await client.request('thread/resume', { threadId: session.thread_id, cwd: session.root, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', excludeTurns: false }));
      checkThread(resumed, session.root, session.thread_id);
      const turn = resumed.thread.turns.find(turn => turn.id === session.turn_id);
      session.error = null;
      if (!turn) { failure(session, hostError('Persisted turn was not returned by resume; Atlas will not resend it.'), 'outcome_unknown'); }
      else if (['completed', 'failed', 'interrupted'].includes(turn.status)) { finish(session, turn); }
      else if (turn.status === 'inProgress') { session.status = 'running'; record(session, 'status', 'Existing Host turn resumed; no turn was resent.'); touch(session); }
      else throw hostError('Invalid resumed turn status.');
      flush(); return view(session);
    } catch (error) { failure(session, error, 'outcome_unknown'); throw error; }
    finally { busy = false; }
  }
  const monitor = setInterval(() => {
    for (const [id, at] of leases) {
      const session = loaded.get(id);
      if (session && !TERMINAL.has(session.status) && session.status !== 'disconnected' && Date.now() - at > 30000) { leases.delete(id); cancel(session.project_id, id, { expected_revision: session.revision }).catch(error => failure(session, error, 'outcome_unknown')); }
    }
  }, 1000); monitor.unref();
  function dispose() {
    disposed = true; clearInterval(monitor);
    for (const pending of permissions.values()) clearTimeout(pending.timer);
    permissions.clear();
    for (const client of clients.values()) client.close(); clients.clear();
    if (lockOwned) { const file = path.join(sessionsRoot, 'service.lock'); plainPath(file, { boundary: stateDir }); if (boundedJson(file).pid === process.pid) fs.unlinkSync(file); lockOwned = false; }
  }
  return { availability, start, show, events, decide, cancel, reconnect, dispose };
}
