import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isPathInside } from './paths.js';

export const hostError = (message, code = 'ATLAS_HOST_PROTOCOL') => Object.assign(new Error(message), { code });
export function plainPath(input, { boundary, directory = false, absent = false } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw hostError('A trusted absolute path is required.', 'ATLAS_INVALID_ARGUMENT');
  const absolute = path.resolve(input);
  if (boundary && !isPathInside(path.resolve(boundary), absolute)) throw hostError('Host state path escapes its root.', 'ATLAS_INVALID_ARGUMENT');
  let cursor = path.parse(absolute).root;
  let stat;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (absent && error.code === 'ENOENT') return absolute; throw error; }
    if (stat.isSymbolicLink()) throw hostError('Host paths cannot traverse a link or junction.', 'ATLAS_INVALID_ARGUMENT');
  }
  if (directory ? !stat?.isDirectory() : !stat?.isFile()) throw hostError('Host path has the wrong file type.', 'ATLAS_INVALID_ARGUMENT');
  if (!directory && stat.nlink > 1) throw hostError('Host files cannot have multiple hard links.', 'ATLAS_INVALID_ARGUMENT');
  return absolute;
}
export function boundedJson(file, max = 65536) {
  plainPath(file);
  if (fs.statSync(file).size > max) throw hostError('Host configuration exceeds its size limit.', 'ATLAS_INVALID_ARGUMENT');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw hostError('Host configuration must be an object.', 'ATLAS_INVALID_ARGUMENT');
  return value;
}
export function validateHostConfig(config, stateDir, { probe = true } = {}) {
  if (!config?.enabled) throw hostError('Host integration is disabled.', 'ATLAS_HOST_DISABLED');
  const executable = plainPath(config.executable);
  if (!/^[a-f0-9]{64}$/u.test(config.executable_sha256 ?? '') || crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== config.executable_sha256) throw hostError('Trusted Host executable hash does not match.');
  if (config.cli_version !== '0.162.0-alpha.2') throw hostError('This Host client requires CLI version 0.162.0-alpha.2.');
  const home = plainPath(config.codex_home, { boundary: stateDir, directory: true });
  if (probe) {
    const version = spawnSync(executable, ['--version'], { shell: false, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536, env: { ...process.env, CODEX_HOME: home } });
    if (version.status !== 0 || version.error || version.stdout.trim() !== `codex-cli ${config.cli_version}`) throw hostError('Host executable version probe did not match the pinned version.');
  }
  return { executable, home };
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
export function validateHostResponse(method, result) {
  if (!object(result)) throw hostError(`Invalid ${method} response.`);
  if (method === 'initialize' && typeof result.userAgent !== 'string') throw hostError('Invalid initialize response.');
  if (['thread/start', 'thread/resume'].includes(method)) {
    if (!object(result.thread) || typeof result.thread.id !== 'string' || typeof result.cwd !== 'string' || typeof result.thread.cwd !== 'string' || !Array.isArray(result.thread.turns) || !object(result.sandbox) || !['user', 'auto_review', 'guardian_subagent'].includes(result.approvalsReviewer)) throw hostError(`Invalid ${method} thread response.`);
  }
  if (method === 'turn/start' && (!object(result.turn) || typeof result.turn.id !== 'string' || !Array.isArray(result.turn.items) || !['inProgress', 'completed', 'interrupted', 'failed'].includes(result.turn.status))) throw hostError('Invalid turn/start response.');
  return result;
}

// Lifecycle and rejection patterns were inspected in Apache-2.0 ACP reference
// commit 17720e4d24d89af34a05f11d1fe77d1d70b97dd6; no SDK/file handler code copied.
export class CodexAppServerClient extends EventEmitter {
  constructor({ config, stateDir, cwd, spawnProcess = spawn, verify = validateHostConfig, rpcTimeoutMs = 10000 }) {
    super();
    const trusted = verify(config, stateDir);
    this.pending = new Map(); this.nextId = 1; this.closed = false; this.initialized = false; this.buffer = Buffer.alloc(0); this.stderrBytes = 0; this.rpcTimeoutMs = rpcTimeoutMs;
    this.child = spawnProcess(trusted.executable, ['app-server', '--listen', 'stdio://'], { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: trusted.home } });
    this.child.stdout.on('data', chunk => this.#receive(chunk));
    this.child.stderr.on('data', chunk => { this.stderrBytes += chunk.length; if (this.stderrBytes > 128 * 1024) this.#fail(hostError('Host stderr exceeded 128 KiB.')); });
    this.child.on('error', () => this.#fail(hostError('Host process could not start.')));
    this.child.on('close', () => this.#fail(hostError('Host connection closed.')));
  }
  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.child.kill();
    this.emit('disconnect', { code: error.code, message: error.message });
  }
  #receive(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) { if (this.buffer.length > 1024 * 1024) this.#fail(hostError('Host JSON line exceeded 1 MiB.')); return; }
      if (newline > 1024 * 1024) { this.#fail(hostError('Host JSON line exceeded 1 MiB.')); return; }
      const line = this.buffer.subarray(0, newline).toString('utf8'); this.buffer = this.buffer.subarray(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { this.#fail(hostError('Malformed Host JSON.')); return; }
      if (!object(message) || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) { this.#fail(hostError('Host batches or invalid JSON-RPC objects are unsupported.')); return; }
      if (typeof message.method === 'string') {
        if (!object(message.params ?? {})) { this.#fail(hostError('Invalid Host message parameters.')); return; }
        if (message.id !== undefined) {
          if (!['string', 'number'].includes(typeof message.id)) { this.#fail(hostError('Invalid Host request identity.')); return; }
          if (!this.listenerCount('request')) this.respond(message.id, null, { code: -32601, message: 'Unsupported client request.' });
          else this.emit('request', message);
        } else this.emit('notification', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) { this.#fail(hostError('Unexpected Host response identity or shape.')); return; }
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(hostError(`Host ${pending.method} request failed.`));
        else { try { pending.resolve(validateHostResponse(pending.method, message.result)); } catch (error) { pending.reject(error); this.#fail(error); } }
      }
    }
  }
  #write(message) {
    if (this.closed) throw hostError('Host connection is closed.');
    const data = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(data) > 1024 * 1024 || this.child.stdin.writableLength + Buffer.byteLength(data) > 1024 * 1024) throw hostError('Host outbound backpressure limit exceeded.');
    this.child.stdin.write(data, error => { if (error) this.#fail(hostError('Host input stream closed.')); });
  }
  request(method, params, { timeoutMs = this.rpcTimeoutMs } = {}) {
    if (this.closed || this.pending.size >= 16 || (!this.initialized && method !== 'initialize')) return Promise.reject(hostError('Host is closed, uninitialized, or has 16 pending requests.'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(hostError(`Host ${method} request timed out.`)); this.#fail(hostError('Host RPC timeout; outcome may be unknown.')); }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.#write({ id, method, params }); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); this.#fail(error); }
    });
  }
  respond(id, result, error) { this.#write(error ? { id, error } : { id, result }); }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'atlas_host', title: 'Atlas', version: '2.0' }, capabilities: { experimentalApi: false } });
    this.#write({ method: 'initialized', params: {} }); this.initialized = true; return result;
  }
  close() { this.#fail(hostError('Atlas closed its Host connection.')); }
}
export function createCodexAppServerClient(options) { return new CodexAppServerClient(options); }
