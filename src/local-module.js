import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withStateLock } from './state-lock.js';
import { projectDirectory } from './ui/project-files.js';

const LIMIT_PACKAGE = 256 * 1024;
const LIMIT_TEXT = 64 * 1024;
const ID = /^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const fresh = () => ({ version: 1, revision: 0, packages: [], requests: {} });
const error = (code, message) => Object.assign(new Error(message), { code });
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function inside(root, target) { const rel = path.relative(root, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); }
function parseStrict(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/u.test(text[i])) i += 1; };
  const str = () => {
    const start = i++;
    while (i < text.length) { const ch = text[i++]; if (ch === '"') return JSON.parse(text.slice(start, i)); if (ch === '\\') i += 1; else if (ch.charCodeAt(0) < 32) throw new Error('Control character in string.'); }
    throw new Error('Unclosed string.');
  };
  const val = () => {
    ws();
    if (text[i] === '{') {
      i += 1; ws(); const out = {}; const keys = new Set(); if (text[i] === '}') { i += 1; return out; }
      while (i < text.length) { ws(); const key = str(); if (keys.has(key)) throw new Error(`Duplicate field: ${key}`); keys.add(key); ws(); if (text[i++] !== ':') throw new Error('Expected colon.'); out[key] = val(); ws(); if (text[i] === '}') { i += 1; return out; } if (text[i++] !== ',') throw new Error('Expected comma.'); }
      throw new Error('Unclosed object.');
    }
    if (text[i] === '[') { i += 1; ws(); const out = []; if (text[i] === ']') { i += 1; return out; } while (i < text.length) { out.push(val()); ws(); if (text[i] === ']') { i += 1; return out; } if (text[i++] !== ',') throw new Error('Expected comma.'); } throw new Error('Unclosed array.'); }
    if (text[i] === '"') return str();
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(i));
    if (!m) throw new Error('Invalid value.'); i += m[0].length; return JSON.parse(m[0]);
  };
  const out = val(); ws(); if (i !== text.length) throw new Error('Trailing data.'); return out;
}
function manifestFrom(bytes) {
  if (bytes.length > LIMIT_PACKAGE) throw error('ATLAS_MODULE_PACKAGE_TOO_LARGE', 'Package exceeds 256 KiB.');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw error('ATLAS_MODULE_PACKAGE_INVALID', 'Package must be valid UTF-8 JSON.'); }
  let m; try { m = parseStrict(text); } catch (e) { throw error('ATLAS_MODULE_PACKAGE_INVALID', `Invalid package JSON: ${e.message}`); }
  const fields = ['module_id', 'module_version', 'adapter', 'permissions', 'entry_source'];
  if (!m || Array.isArray(m) || typeof m !== 'object' || Object.keys(m).length !== fields.length || Object.keys(m).some((k) => !fields.includes(k))) throw error('ATLAS_MODULE_PACKAGE_INVALID', 'Package must contain exactly module_id, module_version, adapter, permissions, and entry_source.');
  if (!ID.test(m.module_id) || !VERSION.test(m.module_version) || m.adapter !== 'text_transform_v1'
    || JSON.stringify(m.permissions) !== '["node_full_account"]' || typeof m.entry_source !== 'string' || !m.entry_source.trim()
    || !/\bexport\s+(?:async\s+)?function\s+transform\s*\(/u.test(m.entry_source)) throw error('ATLAS_MODULE_PACKAGE_INVALID', 'Package fields do not satisfy text_transform_v1.');
  return m;
}
function packageFile(filePath) {
  const input = String(filePath ?? '');
  if (!input || input.includes('\0') || input.startsWith('\\\\') || input.startsWith('\\?\\') || (input.length > 2 && input[1] === ':' && input.slice(2).includes(':'))) throw error('ATLAS_PATH_BOUNDARY', 'Package path is not a supported local path.');
  const absolute = path.resolve(input); const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT_PACKAGE || fs.realpathSync.native(absolute).toLowerCase() !== absolute.toLowerCase()) throw error('ATLAS_PATH_BOUNDARY', 'Package must be a bounded regular file with no linked path.');
  const bytes = fs.readFileSync(absolute); return { absolute, bytes, sha256: hash(bytes), manifest: manifestFrom(bytes) };
}

export function createLocalModuleService({ stateDir, registry = null, resourceControl = null, saveService = null } = {}) {
  if (!stateDir) throw new Error('Local Module service requires stateDir.');
  const root = path.resolve(stateDir); const home = path.join(root, 'local-modules'); const packages = path.join(home, 'packages');
  const statePath = path.join(home, 'state.json');
  const ensureDir = (target, create = false) => {
    const absolute = path.resolve(target); let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { const s = fs.lstatSync(current); if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) throw error('ATLAS_PATH_BOUNDARY', 'Local Module state path contains a link or non-directory.'); }
      catch (e) { if (e.code !== 'ENOENT' || !create) throw e; fs.mkdirSync(current); }
    }
  };
  const read = () => {
    if (!fs.existsSync(home)) return fresh();
    ensureDir(home);
    try { const s = fs.lstatSync(statePath); if (!s.isFile() || s.isSymbolicLink() || s.size > 1024 * 1024) throw error('ATLAS_MODULE_STATE_INVALID', 'Local Module state file is unsafe.'); const v = JSON.parse(fs.readFileSync(statePath, 'utf8')); if (v.version !== 1 || !Number.isSafeInteger(v.revision) || !Array.isArray(v.packages) || !v.requests) throw error('ATLAS_MODULE_STATE_INVALID', 'Local Module state is invalid.'); return v; }
    catch (e) { if (e.code === 'ENOENT') return fresh(); throw e; }
  };
  const write = (state) => {
    ensureDir(home, true); const tmp = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); if (fs.existsSync(statePath) && (!fs.lstatSync(statePath).isFile() || fs.lstatSync(statePath).isSymbolicLink())) throw error('ATLAS_PATH_BOUNDARY', 'Local Module state file changed type.'); fs.renameSync(tmp, statePath); }
    finally { fs.rmSync(tmp, { force: true }); }
  };
  const locked = (fn) => { ensureDir(home, true); return withStateLock(root, fn); };
  const ensureKey = (key) => { if (typeof key !== 'string' || !key.trim() || key.length > 200) throw error('ATLAS_INVALID_ARGUMENT', 'A request key of 1 to 200 characters is required.'); return key.trim(); };
  const checkReplay = (state, key, digest) => { const previous = state.requests[key]; if (!previous) return null; if (previous.digest !== digest) throw error('ATLAS_STATE_CONFLICT', 'Request key was already used for different Local Module input.'); return { ...previous.receipt, replayed: true }; };
  const previewPackage = ({ filePath }) => { const p = packageFile(filePath); return { module_id: p.manifest.module_id, module_version: p.manifest.module_version, adapter: p.manifest.adapter, permissions: [...p.manifest.permissions], sha256: p.sha256, bytes: p.bytes.length, revision: read().revision, default_enabled: false, executes_code: false }; };
  const install = ({ filePath, expectedSha256, expectedRevision, requestKey }) => {
    const p = packageFile(filePath); if (expectedSha256 !== p.sha256) throw error('ATLAS_STATE_CONFLICT', 'Package SHA-256 changed after preview.');
    const key = ensureKey(requestKey); const inputDigest = hash(JSON.stringify({ sha256: p.sha256, module_id: p.manifest.module_id, module_version: p.manifest.module_version, expectedRevision }));
    return locked(() => {
      const state = read(); const replay = checkReplay(state, key, inputDigest); if (replay) return replay;
      if (state.revision !== expectedRevision) throw error('ATLAS_STATE_CONFLICT', 'Install state revision changed; preview the package again.');
      const prior = state.packages.find((x) => x.module_id === p.manifest.module_id && x.module_version === p.manifest.module_version);
      if (prior && prior.sha256 !== p.sha256) throw error('ATLAS_STATE_CONFLICT', 'This Module ID/version is already installed with different bytes.');
      let row = prior;
      if (!row) {
        ensureDir(packages, true); const dir = path.join(packages, p.manifest.module_id); ensureDir(dir, true);
        const target = path.join(dir, `${p.manifest.module_version}-${p.sha256}.json`);
        if (fs.existsSync(target)) { if (hash(fs.readFileSync(target)) !== p.sha256) throw error('ATLAS_STATE_CONFLICT', 'Immutable package path contains different bytes.'); }
        else fs.writeFileSync(target, p.bytes, { flag: 'wx', mode: 0o600 });
        row = { module_id: p.manifest.module_id, module_version: p.manifest.module_version, adapter: p.manifest.adapter, permissions: p.manifest.permissions, sha256: p.sha256, package_path: target, enabled: false };
        state.packages.push(row);
      }
      state.revision += 1; const receipt = { ...row, enabled: false, revision: state.revision, replayed: false };
      state.requests[key] = { digest: inputDigest, receipt }; write(state); return receipt;
    });
  };
  const list = () => read().packages.map((x) => ({ ...x }));
  const setEnabled = ({ moduleId, enabled, expectedRevision, requestKey }) => {
    const key = ensureKey(requestKey); if (typeof enabled !== 'boolean') throw error('ATLAS_INVALID_ARGUMENT', 'enabled must be boolean.');
    return locked(() => { const state = read(); const row = state.packages.find((x) => x.module_id === moduleId); if (!row) throw error('ATLAS_MODULE_NOT_FOUND', 'Local Module is not installed.');
      const inputDigest = hash(JSON.stringify({ moduleId, enabled, expectedRevision })); const replay = checkReplay(state, key, inputDigest); if (replay) return replay;
      if (state.revision !== expectedRevision) throw error('ATLAS_STATE_CONFLICT', 'Local Module state revision changed.');
      row.enabled = enabled; state.revision += 1; const receipt = { module_id: moduleId, enabled, revision: state.revision, replayed: false }; state.requests[key] = { digest: inputDigest, receipt }; write(state); return receipt; });
  };
  const getInstalled = (moduleId) => {
    const row = read().packages.find((x) => x.module_id === moduleId); if (!row) throw error('ATLAS_MODULE_NOT_FOUND', `Local Module is not installed: ${moduleId}`);
    if (!row.enabled) throw error('ATLAS_MODULE_DISABLED', `${moduleId} is disabled; enable it before processing.`);
    const p = packageFile(row.package_path); if (p.sha256 !== row.sha256) throw error('ATLAS_MODULE_PACKAGE_TAMPERED', `${moduleId} package bytes changed; execution was refused.`); return { row, manifest: p.manifest };
  };
  const transform = async (moduleId, text) => {
    const { row, manifest } = getInstalled(moduleId);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMIT_TEXT) throw error('ATLAS_MODULE_INPUT_LIMIT', 'Input text exceeds 64 KiB.');
    const url = `data:text/javascript;base64,${Buffer.from(manifest.entry_source).toString('base64')}#${row.sha256}`;
    const implementation = await import(url); const output = implementation.transform(text);
    if (output && typeof output.then === 'function') throw error('ATLAS_MODULE_INVALID_RESULT', 'transform(text) must be synchronous.');
    if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > LIMIT_TEXT) throw error('ATLAS_MODULE_OUTPUT_LIMIT', 'Output must be a string no larger than 64 KiB.');
    return { text: output, module_id: row.module_id, module_version: row.module_version, module_sha256: row.sha256 };
  };
  const readProjectText = (projectId, resourceId) => {
    if (!registry || !resourceControl) throw error('ATLAS_MODULE_UNAVAILABLE', 'Verified Project and Resource services are required.');
    const entry = registry.show(projectId); if (!entry?.project || entry.project.status !== 'active' || !entry.location) throw error('ATLAS_MODULE_PROJECT_UNAVAILABLE', 'Active Project location is unavailable.');
    const resource = resourceControl.projectResource(projectId, resourceId); const location = resource.locations.find((x) => x.project_id === projectId && x.status === 'active');
    if (!location) throw error('ATLAS_MODULE_RESOURCE_UNAVAILABLE', 'Resource has no active location in this Project.');
    const projectRoot = projectDirectory(entry.location); const target = path.resolve(location.path);
    if (!inside(projectRoot, target) || path.extname(target).toLowerCase() !== '.txt') throw error('ATLAS_PATH_BOUNDARY', 'Input must be a .txt file inside the selected Project.');
    const st = fs.lstatSync(target); if (!st.isFile() || st.isSymbolicLink() || fs.realpathSync.native(target).toLowerCase() !== target.toLowerCase() || st.size > LIMIT_TEXT) throw error('ATLAS_PATH_BOUNDARY', 'Input must be a regular, non-linked file no larger than 64 KiB.');
    const bytes = fs.readFileSync(target); const sha = hash(bytes); if (sha !== location.content_hash) throw error('ATLAS_STATE_CONFLICT', 'Resource changed since registration; refresh and review it before processing.');
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw error('ATLAS_MODULE_INPUT_INVALID', 'Resource is not valid UTF-8 text.'); }
    return { text, sha256: sha, path: target, root: entry.location.root_path };
  };
  const previewTransform = async ({ moduleId, projectId, resourceId, text }) => {
    getInstalled(moduleId);
    const source = projectId && resourceId ? readProjectText(projectId, resourceId) : null; const input = source?.text ?? text;
    const output = await transform(moduleId, input); return { status: 'preview_ready', project_id: projectId ?? null, resource_id: resourceId ?? null, input_sha256: source?.sha256 ?? hash(Buffer.from(String(input ?? ''), 'utf8')), output_text: output.text, output_sha256: hash(Buffer.from(output.text, 'utf8')), module_id: output.module_id, module_version: output.module_version, module_sha256: output.module_sha256, writes_files: false };
  };
  const prepareSave = async ({ moduleId, projectId, resourceId, target, requestKey, caller }) => {
    if (!saveService) throw error('ATLAS_MODULE_UNAVAILABLE', 'Existing Save service is unavailable.');
    getInstalled(moduleId);
    const source = readProjectText(projectId, resourceId); const output = await transform(moduleId, source.text);
    ensureDir(path.join(home, 'candidates'), true); const candidateFile = path.join(home, 'candidates', `${crypto.randomUUID()}.txt`);
    fs.writeFileSync(candidateFile, output.text, { flag: 'wx', mode: 0o600 });
    return saveService.prepare({ root: source.root, candidateFile, projectId, target, origin: 'agent_generated', kind: 'intermediate', inputs: [path.relative(source.root, source.path).replaceAll('\\', '/')], channel: 'host', caller, requestKey, source: { kind: 'local_module', module_id: output.module_id, module_version: output.module_version, module_sha256: output.module_sha256, resource_id: resourceId, input_sha256: source.sha256 }, resultSummary: { module_id: output.module_id, module_version: output.module_version, input_sha256: source.sha256, output_sha256: hash(Buffer.from(output.text, 'utf8')) } });
  };
  return { stateDir: root, previewPackage, install, list, revision: () => read().revision, setEnabled, previewTransform, prepareSave, readProjectText };
}
