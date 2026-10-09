import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boundedJson, hostError, plainPath } from './codex-app-server.js';
import { locateInstalledRuntime } from './runtime-install.js';
import { PROTOCOL_VERSION } from './protocol.js';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const safeFailure = error => ({ status: 'failed', error: { code: error.code ?? 'ATLAS_HOST_PROTOCOL', message: String(error.message).slice(0, 2000) } });
export async function runHostEvent({ bindingFile, event, invoke = spawnSync, budgetMs = 15000 } = {}) {
  const started = performance.now();
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 15000) throw hostError('Host event has no remaining aggregate budget.', 'ATLAS_INVALID_ARGUMENT');
  if (Buffer.byteLength(JSON.stringify(event ?? null)) > 65536) throw hostError('Host event exceeds 64 KiB.', 'ATLAS_INVALID_ARGUMENT');
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw hostError('Host event must be an object.', 'ATLAS_INVALID_ARGUMENT');
  const binding = boundedJson(bindingFile);
  if (binding.schema !== 'atlas.host-event-binding.v1') throw hostError('Unsupported Host binding schema.', 'ATLAS_INVALID_ARGUMENT');
  const adapter = binding.input_format === 'atlas.adapter.v1';
  if (binding.input_format && !['codex.hooks.v1', 'atlas.adapter.v1'].includes(binding.input_format)) throw hostError('Unsupported Host event input format.', 'ATLAS_INVALID_ARGUMENT');
  const kind = adapter ? event.kind : event.hook_event_name;
  const identity = adapter
    ? stable(event.event_id) ? { event_id: event.event_id } : ['session_id', 'turn_id', 'tool_call_id'].every(key => stable(event[key])) ? { session_id: event.session_id, turn_id: event.turn_id, tool_call_id: event.tool_call_id } : null
    : kind === 'PostToolUse' && ['session_id', 'turn_id', 'tool_use_id'].every(key => stable(event[key])) ? { session_id: event.session_id, turn_id: event.turn_id, tool_use_id: event.tool_use_id } : null;
  if (!identity) return { status: 'skipped', reason: 'missing_stable_identity' };
  if (binding.enabled !== true) return { status: 'skipped', reason: 'disabled' };
  if (binding.recursion_verified !== true || binding.exclude_atlas_origin !== true) throw hostError('Host binding must verify exclusion of all Atlas-origin calls.', 'ATLAS_INVALID_ARGUMENT');
  if (event.origin === 'atlas' || /atlas|keeproot/iu.test(String(event.tool_name ?? ''))) return { status: 'skipped', reason: 'atlas_origin' };
  const safeTools = new Set(['apply_patch', 'write_file', 'edit_file']);
  if (!Array.isArray(binding.known_tool_names) || !binding.known_tool_names.length || binding.known_tool_names.some(name => !safeTools.has(name))) throw hostError('Binding must select canonical file tools only; shell, Atlas and exec_command tools cannot be bound.', 'ATLAS_INVALID_ARGUMENT');
  if ((adapter && event.origin !== binding.source_origin) || !binding.known_tool_names.includes(event.tool_name)) return { status: 'skipped', reason: 'unknown_origin_or_tool' };
  if (!(adapter ? ['resource_changed', 'turn_completed'] : ['PostToolUse']).includes(kind)) return { status: 'skipped', reason: 'unknown_event' };
  const action = binding.events?.[kind];
  if (!action) return { status: 'skipped', reason: 'unbound_event' };
  if (event.project_id && event.project_id !== binding.project_id) throw hostError('Host event belongs to a different Project.', 'ATLAS_PROJECT_MISMATCH');
  if (!/^PRJ-[a-f0-9-]{36}$/iu.test(binding.project_id ?? '')) throw hostError('Binding requires one Project identity.', 'ATLAS_INVALID_ARGUMENT');
  const installRoot = plainPath(binding.install_root, { directory: true });
  const located = locateInstalledRuntime(installRoot);
  if (located.status !== 'ready' || located.integrity !== 'verified') throw hostError(`Installed Atlas is unavailable: ${located.status}.`);
  const stateDir = plainPath(binding.state_dir, { boundary: installRoot, directory: true });
  if (path.resolve(located.manifest.state_path) !== stateDir) throw hostError('Binding state does not match the trusted installation.', 'ATLAS_INVALID_ARGUMENT');
  const node = plainPath(located.manifest.node_path), cli = plainPath(path.join(located.manifest.runtime_path, 'bin/atlas.js'));
  const bindingHash = hash(fs.readFileSync(bindingFile));
  const eventKey = hash(JSON.stringify({ binding_hash: bindingHash, kind, ...identity }));
  const parent = path.join(stateDir, 'host-events'); plainPath(parent, { boundary: stateDir, directory: true, absent: true }); fs.mkdirSync(parent, { recursive: true });
  const journal = path.join(parent, `${bindingHash}.jsonl`), lock = path.join(parent, `${bindingHash}.lock`);
  plainPath(journal, { boundary: stateDir, absent: true }); plainPath(lock, { boundary: stateDir, absent: true });
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw hostError('This Host binding is already running or its prior lock requires inspection.', 'ATLAS_STATE_CONFLICT'); throw error; }
  const append = row => {
    plainPath(journal, { boundary: stateDir, absent: true });
    const text = JSON.stringify(row) + '\n';
    if ((fs.existsSync(journal) ? fs.statSync(journal).size : 0) + Buffer.byteLength(text) > 4 * 1024 * 1024) throw hostError('Host event journal reached its size limit.');
    fs.appendFileSync(journal, text);
  };
  try {
    if (fs.existsSync(journal)) {
      if (fs.statSync(journal).size > 4 * 1024 * 1024) throw hostError('Host event journal exceeds its size limit.');
      const raw = fs.readFileSync(journal, 'utf8');
      if (raw && !raw.endsWith('\n')) throw hostError('Host event journal has a torn entry; inspect before replay.');
      const rows = raw.trim() ? raw.trim().split('\n').map(line => JSON.parse(line)) : [];
      const completed = rows.findLast(row => row.event_key === eventKey && row.phase === 'completed');
      if (completed) return { ...completed.receipt, replayed: true };
    }
    let resourceIds = [];
    if (action.kind === 'refresh_resources') {
      if (!Array.isArray(action.resource_ids) || !action.resource_ids.length || action.resource_ids.length > 16 || action.resource_ids.some(id => !/^RES-[a-f0-9-]{36}$/iu.test(id))) throw hostError('Binding requires 1..16 known Resource identities.', 'ATLAS_INVALID_ARGUMENT');
      resourceIds = [...new Set(action.resource_ids)];
    } else if (action.kind !== 'create_handoff') throw hostError('Unsupported Host event action.', 'ATLAS_INVALID_ARGUMENT');
    append({ phase: 'intent', event_key: eventKey, action: action.kind });
    const results = []; let outputBytes = 0;
    const call = (args, command) => {
      const remaining = Math.floor(budgetMs - (performance.now() - started));
      if (remaining <= 0) throw hostError('Host event aggregate 15s budget exhausted.');
      const processResult = invoke(node, [...(located.manifest.node_args ?? []), cli, ...args, '--json'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: remaining, maxBuffer: 256 * 1024, env: { ...process.env, ATLAS_HOME: installRoot, ATLAS_STATE_DIR: stateDir } });
      outputBytes += Buffer.byteLength(processResult.stdout ?? '');
      if (outputBytes > 256 * 1024 || processResult.error || processResult.status !== 0) throw hostError(`Atlas ${command} failed: ${processResult.error?.code ?? `exit ${processResult.status}`}.`);
      let envelope; try { envelope = JSON.parse(processResult.stdout); } catch { throw hostError(`Atlas ${command} returned invalid JSON.`); }
      if (!envelope || Array.isArray(envelope) || envelope.protocol_version !== PROTOCOL_VERSION || envelope.ok !== true || envelope.command !== command || !envelope.data || typeof envelope.data !== 'object') throw hostError(`Atlas ${command} returned an invalid envelope.`);
      return envelope.data;
    };
    if (action.kind === 'refresh_resources') {
      for (const id of resourceIds) {
        const result = call(['resource', 'show', id, '--project', binding.project_id], 'resource.show');
        if (result.resource_id !== id || result.desktop_href !== `/projects/${encodeURIComponent(binding.project_id)}/resources?resource_id=${encodeURIComponent(id)}`) throw hostError('Atlas Resource identity or Project did not match the binding.', 'ATLAS_PROJECT_MISMATCH');
        results.push({ resource_id: id, status: result.status ?? null });
      }
    } else {
      const reviewed = boundedJson(action.request_file);
      if (hash(fs.readFileSync(action.request_file)) !== action.request_sha256) throw hostError('Reviewed Handoff request changed.', 'ATLAS_STATE_CONFLICT');
      if (reviewed.rule_request?.project_id !== binding.project_id || reviewed.schema !== 'atlas.handoff.v1') throw hostError('Reviewed Handoff belongs to another Project.', 'ATLAS_PROJECT_MISMATCH');
      const requestFile = path.join(parent, `${eventKey}.request.json`); plainPath(requestFile, { boundary: stateDir, absent: true });
      const request = { ...reviewed, request_key: `host-event:${eventKey}`, caller: { ...reviewed.caller, tool: 'atlas-host-events', client_run_id: eventKey } };
      const contents = JSON.stringify(request);
      if (Buffer.byteLength(contents) > 65536) throw hostError('Reviewed Handoff exceeds its bounded size.', 'ATLAS_INVALID_ARGUMENT');
      if (!fs.existsSync(requestFile)) fs.writeFileSync(requestFile, contents, { flag: 'wx' });
      else if (fs.readFileSync(requestFile, 'utf8') !== contents) throw hostError('Stable Handoff request file changed.', 'ATLAS_STATE_CONFLICT');
      const result = call(['handoff', 'create', '--project', binding.project_id, '--request-file', requestFile], 'handoff.create');
      if (result.project_id !== binding.project_id || result.status !== 'current' || !result.handoff_id) throw hostError('Created Handoff is stale, blocked, or belongs to another Project.', 'ATLAS_STATE_CONFLICT');
      results.push({ handoff_id: result.handoff_id, digest: result.digest, status: result.status });
    }
    const receipt = { status: 'completed', event_key: eventKey, project_id: binding.project_id, action: action.kind, results, replayed: false };
    if (Buffer.byteLength(JSON.stringify(receipt)) > 256 * 1024) throw hostError('Host event receipt exceeded its output bound.');
    append({ phase: 'completed', event_key: eventKey, receipt }); return receipt;
  } catch (error) { append({ phase: 'failed', event_key: eventKey, ...safeFailure(error) }); throw error; }
  finally { fs.closeSync(lockFd); plainPath(lock, { boundary: stateDir }); fs.unlinkSync(lock); }
}
