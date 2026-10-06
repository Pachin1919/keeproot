import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fetchPublicDocument } from './public-web-capture.js';
import { RuntimeStorage } from './runtime-storage.js';
import { diffChatGptConversations, inspectChatGptExport, normalizeChatGptConversation, selectChatGptExportConversation, verifyChatGptExportInput } from './chatgpt-export-capture.js';

const PARSER_ID = 'atlas.public-web-source';
const PARSER_VERSION = '1';
const MAX_READ_CHARACTERS = 4_000;

function conflict(message) {
  const error = new Error(message); error.code = 'ATLAS_STATE_CONFLICT'; return error;
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function exportRequired(sourceUrl, facts = {}) {
  const httpStatus = Number.isInteger(facts.http_status) ? facts.http_status : null;
  const unavailable = [401, 403, 404, 410].includes(httpStatus);
  return {
    status: 'export_required', requested_url: sourceUrl,
    final_url: facts.final_url ?? sourceUrl,
    ...(httpStatus === null ? {} : { http_status: httpStatus }),
    reason_code: unavailable ? 'share_unavailable' : 'share_unrecognized',
    reason: unavailable
      ? 'The public share could not be accessed. Export the conversation and capture the export instead.'
      : 'The page was received, but its conversation format was not recognized. Export the conversation and capture the export instead.',
  };
}
function normalizedText(value) {
  return String(value ?? '').replace(/\u0000/gu, '').replace(/\r\n?/gu, '\n').normalize('NFC')
    .split('\n').map((line) => line.replace(/[\t ]+/gu, ' ').trim()).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}
function canonicalUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Capture Source requires one valid public URL.'); }
  url.hash = '';
  return url.toString();
}
function safeRelative(value, label) {
  const input = String(value ?? '').replaceAll('\\', '/');
  const normalized = path.posix.normalize(input);
  if (!input || input === '.' || path.posix.isAbsolute(input) || path.win32.isAbsolute(input) || normalized === '.' || normalized === '..'
      || normalized.startsWith('../') || normalized !== input.replace(/\/$/u, '')) {
    throw conflict(`${label} must be a normalized path inside the Project.`);
  }
  return normalized;
}
function assertNoLinks(root, target) {
  const absoluteRoot = path.resolve(root); const absolute = path.resolve(target);
  const relative = path.relative(absoluteRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw conflict('Capture Source path escapes the Workspace Root.');
  let cursor = absoluteRoot;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw conflict('Capture Source path cannot pass through a symbolic link or junction.');
  }
}
function normalizeCapture(fetched, sourceUrl) {
  const capture = fetched.capture;
  if (capture.capture_mode === 'chatgpt_share') {
    const messages = (capture.messages ?? []).map((item, ordinal) => ({
      message_id: String(item.message_id ?? '').trim() || null,
      parent_message_id: String(item.parent_message_id ?? '').trim() || null,
      ordinal, role: String(item.role ?? '').trim().toLowerCase(), content: normalizedText(item.content),
    })).filter((item) => item.content);
    if (!messages.length) return exportRequired(sourceUrl, fetched);
    const reliable = messages.every((item) => item.message_id)
      && new Set(messages.map((item) => item.message_id)).size === messages.length
      && capture.completeness === 'shared_linear_conversation_complete';
    const readable = messages.map((item) => `## ${item.role === 'user' ? '用户' : item.role === 'assistant' ? 'ChatGPT' : item.role}\n\n${item.content}`).join('\n\n---\n\n');
    return {
      capture_mode: 'chatgpt_share', capture_scope: capture.capture_scope,
      completeness: reliable ? 'complete' : 'partial', stable_message_ids: reliable,
      normalized: { conversation_id: capture.conversation_id ?? null, messages }, readable,
      title: normalizedText(capture.title) || 'ChatGPT shared conversation', source_url: sourceUrl,
    };
  }
  const text = normalizedText(capture.text);
  if (!text) throw new Error('Capture Source found no usable article text in the public response.');
  return {
    capture_mode: 'public_http', capture_scope: capture.capture_scope,
    completeness: 'static_response_complete_dynamic_content_not_proven', stable_message_ids: false,
    normalized: { title: normalizedText(capture.title), text }, readable: `# ${normalizedText(capture.title) || new URL(sourceUrl).hostname}\n\n${text}`,
    title: normalizedText(capture.title) || new URL(sourceUrl).hostname, source_url: sourceUrl,
  };
}
function versionDiff(current, previous) {
  if (!previous) return { kind: 'initial', added_count: 0, edited_count: 0, removed_count: 0, added: [], edited: [], removed: [], previous_save_id: null };
  const before = previous.document;
  if (current.capture_mode !== 'chatgpt_share' || before.capture_mode !== 'chatgpt_share') {
    return { kind: 'article_changed', added_count: 0, edited_count: 0, removed_count: 0, added: [], edited: [], removed: [], previous_save_id: previous.save.save_id };
  }
  if (current.stable_message_ids && before.stable_message_ids
      && current.completeness === 'complete' && before.completeness === 'complete') {
    const old = new Map(before.normalized.messages.map((item) => [item.message_id, item]));
    const next = new Map(current.normalized.messages.map((item) => [item.message_id, item]));
    const added = [...next.keys()].filter((id) => !old.has(id));
    const edited = [...next.keys()].filter((id) => old.has(id) && JSON.stringify({ ...next.get(id), ordinal: 0 }) !== JSON.stringify({ ...old.get(id), ordinal: 0 }));
    const removed = [...old.keys()].filter((id) => !next.has(id));
    return {
      kind: 'message_changes', previous_save_id: previous.save.save_id,
      added_count: added.length, edited_count: edited.length, removed_count: removed.length,
      added: added.slice(0, 100), edited: edited.slice(0, 100), removed: removed.slice(0, 100),
      truncated: added.length > 100 || edited.length > 100 || removed.length > 100,
    };
  }
  return { kind: 'conversation_changed', added_count: null, edited_count: null, removed_count: null, added: [], edited: [], removed: [], previous_save_id: previous.save.save_id };
}
function decodeDocument(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw conflict('Stored Capture Source candidate is not valid JSON.'); }
}

function encodeReadCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeReadCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cursor shape.');
    return value;
  }
  catch { throw conflict('Capture Source read cursor is invalid or belongs to a different version.'); }
}
function messageChanges(current, previous) {
  const reliable = (document) => document.capture_mode === 'chatgpt_share' && document.stable_message_ids
    && document.completeness === 'complete' && Array.isArray(document.normalized?.messages)
    && document.normalized.messages.every((item) => item.message_id);
  if (!reliable(current) || !reliable(previous)) return null;
  const before = new Map(previous.normalized.messages.map((item) => [item.message_id, item]));
  const after = new Map(current.normalized.messages.map((item) => [item.message_id, item]));
  const blocks = [];
  for (const message of current.normalized.messages) {
    const prior = before.get(message.message_id);
    if (!prior) blocks.push({ kind: 'added', id: message.message_id, role: message.role, before_text: null, after_text: message.content, branch_state: message.parent_message_id });
    else if (prior.content !== message.content || prior.role !== message.role || prior.parent_message_id !== message.parent_message_id) {
      blocks.push({ kind: 'edited', id: message.message_id, role: message.role, before_text: prior.content, after_text: message.content, before_role: prior.role, parent_before: prior.parent_message_id, parent_after: message.parent_message_id, branch_state: message.parent_message_id });
    }
  }
  for (const message of previous.normalized.messages) if (!after.has(message.message_id)) {
    blocks.push({ kind: 'removed', id: message.message_id, role: message.role, before_text: message.content, after_text: null, branch_state: message.parent_message_id });
  }
  blocks.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  return { blocks, summary: { kind: 'message_changes', added_count: blocks.filter((item) => item.kind === 'added').length,
    edited_count: blocks.filter((item) => item.kind === 'edited').length, removed_count: blocks.filter((item) => item.kind === 'removed').length } };
}
function exportChanges(current, previous) {
  const beforeNodes = previous.normalized?.nodes; const afterNodes = current.normalized?.nodes;
  if (!Array.isArray(beforeNodes) || !Array.isArray(afterNodes)) return null;
  const before = new Map(beforeNodes.map((item) => [item.node_id, item]));
  const after = new Map(afterNodes.map((item) => [item.node_id, item]));
  const blocks = [];
  const editedFields = ['content', 'unknown_content_fingerprint', 'message_metadata_fingerprint', 'role'];
  for (const node of afterNodes) {
    const prior = before.get(node.node_id);
    if (!prior) blocks.push({ kind: 'added', id: node.node_id, role: node.role, before_text: null, after_text: node.content, branch_state: { parent: node.parent_node_id, children: node.child_node_ids } });
    else {
      if (editedFields.some((key) => node[key] !== prior[key])) blocks.push({ kind: 'edited', id: node.node_id, role: node.role, before_text: prior.content, after_text: node.content, branch_state: { parent: node.parent_node_id, children: node.child_node_ids } });
      if (node.parent_node_id !== prior.parent_node_id) blocks.push({ kind: 'parent_changed', id: node.node_id, role: node.role, before_text: prior.content, after_text: node.content, parent_before: prior.parent_node_id, parent_after: node.parent_node_id, branch_state: { parent: node.parent_node_id, children: node.child_node_ids } });
      if (JSON.stringify(node.child_node_ids) !== JSON.stringify(prior.child_node_ids)) blocks.push({ kind: 'branch_changed', id: node.node_id, role: node.role, before_text: prior.content, after_text: node.content, branch_state: { before: prior.child_node_ids, after: node.child_node_ids } });
    }
  }
  const complete = current.completeness === 'complete';
  const absent = []; const unobserved = [];
  for (const node of beforeNodes) if (!after.has(node.node_id)) {
    const kind = complete ? 'absent_from_export' : 'unobserved';
    (complete ? absent : unobserved).push(node.node_id);
    blocks.push({ kind, id: node.node_id, role: node.role, before_text: node.content, after_text: null, branch_state: { parent: node.parent_node_id, children: node.child_node_ids } });
  }
  blocks.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  return { blocks, summary: { kind: 'node_changes', added_count: blocks.filter((item) => item.kind === 'added').length,
    edited_count: blocks.filter((item) => item.kind === 'edited').length, parent_changed_count: blocks.filter((item) => item.kind === 'parent_changed').length,
    branch_changed_count: blocks.filter((item) => item.kind === 'branch_changed').length,
    absent_from_export_count: absent.length, unobserved_count: unobserved.length,
    active_path_changed: JSON.stringify(current.normalized.active_path) !== JSON.stringify(previous.normalized.active_path) } };
}
function serializeBlocks(blocks) { return blocks.map((block) => JSON.stringify(block)).join('\n'); }

function latestExecutedVersion(versions) {
  return versions.filter((item) => item.executed_at)
    .sort((left, right) => (Date.parse(right.executed_at) || 0) - (Date.parse(left.executed_at) || 0)
      || String(right.save_id).localeCompare(String(left.save_id)))[0] ?? null;
}

function requireLatestOutputVerified(versions) {
  const latest = latestExecutedVersion(versions);
  if (latest && latest.current_output !== 'verified') {
    throw conflict('The latest saved Capture Source output is changed or missing; review it before preparing another version.');
  }
  return latest;
}

export class CaptureSourceService {
  constructor({ stateDir, registry, saveService, fetchImpl = globalThis.fetch, lookupHost, now = () => new Date().toISOString() }) {
    if (!stateDir || !registry || !saveService) throw new Error('CaptureSourceService requires stateDir, Registry, and SaveService.');
    this.stateDir = path.resolve(stateDir); this.registry = registry; this.saveService = saveService;
    this.fetchImpl = fetchImpl; this.lookupHost = lookupHost; this.now = now;
  }

  #project(projectId) {
    const detail = this.registry.show(projectId);
    if (!detail.project || detail.project.status !== 'active' || !detail.location?.root_path || !detail.location.relative_path) {
      throw conflict('Capture Source requires an active Project with a verified Workspace Root location.');
    }
    const workspaceRoot = path.resolve(detail.location.root_path);
    const projectPath = safeRelative(detail.location.relative_path, 'Project location');
    const projectRoot = path.resolve(workspaceRoot, ...projectPath.split('/'));
    assertNoLinks(workspaceRoot, projectRoot);
    if (!fs.statSync(projectRoot).isDirectory()) throw conflict('Capture Source Project location is not a directory.');
    return { project: detail.project, location: detail.location, workspaceRoot, projectRoot, projectPath };
  }

  #versions(projectId, sourceId) {
    return this.saveService.captureSourceSaves({ projectId, sourceId });
  }

  async prepare({ url, projectId, folder, name, requestKey, caller = {} }) {
    if (!String(requestKey ?? '').trim()) throw new Error('Capture Source prepare requires a request key.');
    if (!String(caller.tool ?? '').trim() || !String(caller.client_run_id ?? '').trim()) throw new Error('Capture Source prepare requires caller tool and client_run_id.');
    const sourceUrl = canonicalUrl(url);
    const project = this.#project(projectId);
    const folderRelative = String(folder ?? '').trim() === '.' ? '.' : safeRelative(folder, 'Capture folder');
    const folderPath = path.resolve(project.projectRoot, ...folderRelative.split('/'));
    assertNoLinks(project.workspaceRoot, folderPath);
    if (!fs.statSync(folderPath).isDirectory()) throw conflict('Capture folder must already exist inside the Project.');
    const baseName = String(name ?? '').trim().replace(/\.source\.json$/iu, '');
    if (!baseName || /[\\/:*?"<>|]/u.test(baseName) || baseName === '.' || baseName === '..') throw conflict('Capture name must be a plain file name.');
    let fetched;
    try {
      fetched = await fetchPublicDocument(sourceUrl, {
        fetchImpl: this.fetchImpl, ...(this.lookupHost ? { lookupHost: this.lookupHost } : {}), includeResponseBytes: true,
      });
    } catch (error) {
      if (error.code === 'ATLAS_CAPTURE_EXPORT_REQUIRED') return exportRequired(sourceUrl, error.capture);
      throw error;
    }
    const raw = Buffer.from(fetched.response_bytes);
    const canonicalFinalUrl = canonicalUrl(fetched.final_url);
    const normalized = normalizeCapture(fetched, sourceUrl);
    if (normalized.status === 'export_required') return normalized;
    const sourceId = `SRC-${hash(sourceUrl).slice(0, 32)}`;
    const versionId = `VER-${hash(JSON.stringify({ parser_id: PARSER_ID, parser_version: PARSER_VERSION, scope: normalized.capture_scope, completeness: normalized.completeness, normalized: normalized.normalized }))}`;
    const versions = this.#versions(projectId, sourceId);
    const latest = requireLatestOutputVerified(versions);
    const same = versions.find((item) => item.parameters?.capture_source?.version_id === versionId);
    if (same) {
      if (same.status === 'executed' && same.current_output === 'verified') {
        return { status: 'unchanged', save_id: same.save_id, resource_id: same.resource_id, source_id: sourceId, version_id: versionId, capture_mode: normalized.capture_mode, capture_scope: normalized.capture_scope, completeness: normalized.completeness, current_output: same.current_output, diff: same.parameters.capture_source.diff ?? null };
      }
      if (same.status === 'prepared') return { status: 'prepared', save_id: same.save_id, resource_id: null, source_id: sourceId, version_id: versionId, capture_mode: normalized.capture_mode, capture_scope: normalized.capture_scope, completeness: normalized.completeness, preview_href: `/saves/${encodeURIComponent(same.save_id)}`, diff: same.parameters.capture_source.diff };
      if (['reserving', 'committing'].includes(same.status)) return { status: same.status, save_id: same.save_id, source_id: sourceId, version_id: versionId };
      throw conflict('This Capture Source version exists but its saved file is not currently verified.');
    }
    const previous = latest;
    let previousDoc = null;
    if (previous) previousDoc = decodeDocument(fs.readFileSync(this.saveService.candidateSnapshot(previous.save_id).path));
    const diff = versionDiff(normalized, previousDoc ? { save: previous, document: previousDoc } : null);
    const document = {
      schema: 'atlas.source-capture.v1', source_id: sourceId, version_id: versionId,
      previous_save_id: previous?.save_id ?? null,
      requested_url: sourceUrl, final_url: canonicalFinalUrl, captured_at: this.now(),
      parser: { id: PARSER_ID, version: PARSER_VERSION }, capture_mode: normalized.capture_mode,
      scope: normalized.capture_scope, completeness: normalized.completeness, stable_message_ids: normalized.stable_message_ids,
      raw: { encoding: 'base64', content_type: fetched.content_type, bytes: raw.length, sha256: hash(raw), base64: raw.toString('base64') },
      normalized: normalized.normalized, readable: normalized.readable,
    };
    const jsonBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const fileHash = hash(jsonBytes);
    const targetName = versions.length > 0
      ? `${baseName}.${versionId.slice(4, 16)}.source.json` : `${baseName}.source.json`;
    const target = path.posix.join(project.projectPath, folderRelative, targetName);
    const candidateDir = path.join(this.stateDir, 'tmp', 'capture-source-candidates');
    fs.mkdirSync(candidateDir, { recursive: true });
    const candidate = path.join(candidateDir, `${crypto.randomUUID()}.source.json`);
    fs.writeFileSync(candidate, jsonBytes, { flag: 'wx' });
    try {
      const staged = new RuntimeStorage({ stateDir: this.stateDir }).stage({ source: candidate, kind: 'candidate' });
      const saveOptions = {
        root: project.workspaceRoot, candidateFile: staged.payload_path, projectId,
        target, origin: 'download', kind: 'source', channel: 'host',
        caller: { tool: 'atlas-capture-source', client_run_id: sourceId },
        requestKey: `capture-${versionId}`,
        source: { kind: 'capture_source', source_id: sourceId, version_id: versionId, sha256: fileHash },
        parameters: { capture_source: { source_id: sourceId, version_id: versionId, requested_url: sourceUrl, request_key: requestKey, requested_by: caller, diff } },
        resultSummary: { capture_mode: normalized.capture_mode, completeness: normalized.completeness },
      };
      const plan = this.saveService.plan(saveOptions);
      if (plan.status !== 'ready' || !plan.plan_revision || plan.target !== target) throw conflict(plan.reason ?? 'Capture Source target is not ready for Save.');
      let saved;
      try { saved = this.saveService.prepare({ ...saveOptions, expectedPlanRevision: plan.plan_revision }); }
      catch (error) {
        const replay = this.#versions(projectId, sourceId).find((item) => item.parameters?.capture_source?.version_id === versionId);
        if (replay?.status === 'executed' && replay.current_output === 'verified') return { status: 'unchanged', save_id: replay.save_id, resource_id: replay.resource_id, source_id: sourceId, version_id: versionId, capture_mode: normalized.capture_mode, capture_scope: normalized.capture_scope, completeness: normalized.completeness, current_output: replay.current_output, diff: replay.parameters.capture_source.diff };
        if (replay && ['prepared', 'reserving', 'committing'].includes(replay.status)) return { status: replay.status, save_id: replay.save_id, source_id: sourceId, version_id: versionId, capture_mode: normalized.capture_mode, capture_scope: normalized.capture_scope, completeness: normalized.completeness, ...(replay.status === 'prepared' ? { preview_href: `/saves/${encodeURIComponent(replay.save_id)}`, diff: replay.parameters.capture_source.diff } : {}) };
        throw error;
      }
      return { status: saved.status, save_id: saved.save_id, resource_id: saved.resource_id ?? null, source_id: sourceId, version_id: versionId, capture_mode: normalized.capture_mode, capture_scope: normalized.capture_scope, completeness: normalized.completeness, preview_href: `/saves/${encodeURIComponent(saved.save_id)}`, diff, current_output: saved.current_output ?? null };
    } finally { fs.rmSync(candidate, { force: true }); }
  }

  inspectExport({ inputPath, limit, cursor = null }) {
    return { ...inspectChatGptExport({ inputPath, ...(limit == null ? {} : { limit }), cursor }), input_path: path.resolve(inputPath) };
  }

  async prepareExport({ inputPath, expectedInputSha256, selection, projectId, folder, name, requestKey, caller = {} }) {
    if (!String(requestKey ?? '').trim()) throw new Error('Capture Source export preparation requires a request key.');
    if (!String(caller.tool ?? '').trim() || !String(caller.client_run_id ?? '').trim()) throw new Error('Capture Source export preparation requires caller tool and client_run_id.');
    const project = this.#project(projectId);
    const folderRelative = String(folder ?? '').trim() === '.' ? '.' : safeRelative(folder, 'Capture folder');
    const folderPath = path.resolve(project.projectRoot, ...folderRelative.split('/'));
    assertNoLinks(project.workspaceRoot, folderPath);
    if (!fs.statSync(folderPath).isDirectory()) throw conflict('Capture folder must already exist inside the Project.');
    const baseName = String(name ?? '').trim().replace(/\.source\.json$/iu, '');
    if (!baseName || /[\\/:*?"<>|]/u.test(baseName) || baseName === '.' || baseName === '..') throw conflict('Capture name must be a plain file name.');

    const selected = selectChatGptExportConversation({ inputPath, expectedInputSha256, selection });
    const normalized = normalizeChatGptConversation(selected.conversation);
    const stableId = selected.provider_id_reliable ? selected.provider_conversation_id?.trim() || null : null;
    const sourceId = `SRC-${hash(stableId ? `chatgpt-export:${projectId}:${stableId}` : `chatgpt-export-anonymous:${projectId}:${selected.selected_sha256}`).slice(0, 32)}`;
    const versionFacts = {
      parser_id: 'atlas.chatgpt-export', parser_version: '1',
      provider_conversation_id: stableId, completeness: normalized.completeness,
      title: normalized.title, nodes: normalized.nodes, active_path: normalized.active_path,
    };
    const versionId = `VER-${hash(JSON.stringify(versionFacts))}`;
    const versions = this.#versions(projectId, sourceId);
    const latest = requireLatestOutputVerified(versions);
    const same = versions.find((item) => item.parameters?.capture_source?.version_id === versionId);
    if (same) {
      if (same.status === 'executed' && same.current_output === 'verified') {
        return { status: 'unchanged', save_id: same.save_id, resource_id: same.resource_id, source_id: sourceId, version_id: versionId, capture_mode: 'chatgpt_export', capture_scope: 'selected_conversation', completeness: normalized.completeness.graph, current_output: same.current_output, diff: same.parameters.capture_source.diff ?? null };
      }
      if (same.status === 'prepared') return { status: 'prepared', save_id: same.save_id, resource_id: null, source_id: sourceId, version_id: versionId, capture_mode: 'chatgpt_export', capture_scope: 'selected_conversation', completeness: normalized.completeness.graph, preview_href: `/saves/${encodeURIComponent(same.save_id)}`, diff: same.parameters.capture_source.diff };
      if (['reserving', 'committing'].includes(same.status)) return { status: same.status, save_id: same.save_id, source_id: sourceId, version_id: versionId };
      throw conflict('This Capture Source version exists but its saved file is not currently verified.');
    }
    const previous = latest;
    let previousDocument = null;
    if (previous) previousDocument = decodeDocument(fs.readFileSync(this.saveService.candidateSnapshot(previous.save_id).path));
    const diff = diffChatGptConversations({ normalized }, previousDocument ? { save: previous, document: previousDocument } : null);
    const rawBytes = Buffer.from(selected.selected_bytes);
    const document = {
      schema: 'atlas.source-capture.v1', source_id: sourceId, version_id: versionId,
      previous_save_id: previous?.save_id ?? null,
      requested_url: null, final_url: null, captured_at: this.now(),
      parser: { id: 'atlas.chatgpt-export', version: '1' }, capture_mode: 'chatgpt_export',
      scope: 'selected_conversation', completeness: normalized.completeness.graph,
      completeness_details: normalized.completeness, stable_message_ids: Boolean(stableId),
      provider_conversation_id: selected.provider_conversation_id, provider_id_reliable: Boolean(stableId),
      raw: { encoding: 'base64', content_type: 'application/json', bytes: rawBytes.length, sha256: hash(rawBytes), base64: rawBytes.toString('base64') },
      container: { sha256: selected.input_sha256, bytes: selected.input_bytes },
      normalized: {
        conversation_id: normalized.conversation_id, title: normalized.title,
        current_node: normalized.current_node, active_path: normalized.active_path, nodes: normalized.nodes,
      },
      readable: `# ${normalized.title || 'ChatGPT conversation'}\n\n${normalized.readable}`,
    };
    const jsonBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const fileHash = hash(jsonBytes);
    const targetName = versions.length > 0 ? `${baseName}.${versionId.slice(4, 16)}.source.json` : `${baseName}.source.json`;
    const target = path.posix.join(project.projectPath, folderRelative, targetName);
    const candidateDir = path.join(this.stateDir, 'tmp', 'capture-source-candidates');
    fs.mkdirSync(candidateDir, { recursive: true });
    const candidate = path.join(candidateDir, `${crypto.randomUUID()}.source.json`);
    fs.writeFileSync(candidate, jsonBytes, { flag: 'wx' });
    const runtimeStorage = new RuntimeStorage({ stateDir: this.stateDir });
    try {
      const staged = runtimeStorage.stage({ source: candidate, kind: 'candidate' });
      const exportInput = { path: selected.input_path, sha256: selected.input_sha256, bytes: selected.input_bytes };
      verifyChatGptExportInput({ inputPath: exportInput.path, expectedInputSha256: exportInput.sha256 });
      const saveOptions = {
        root: project.workspaceRoot, candidateFile: staged.payload_path, projectId,
        target, origin: 'download', kind: 'source', channel: 'host',
        caller: { tool: 'atlas-capture-source', client_run_id: sourceId }, requestKey: `capture-${versionId}`,
        source: { kind: 'capture_source', source_id: sourceId, version_id: versionId, sha256: fileHash, capture_format: 'chatgpt_export', export_input: exportInput },
        parameters: { capture_source: { source_id: sourceId, version_id: versionId, requested_by: caller, diff, capture_format: 'chatgpt_export', provider_conversation_id: stableId, input_sha256: selected.input_sha256, selected_sha256: selected.selected_sha256, selection_index: selected.index } },
        resultSummary: { capture_mode: 'chatgpt_export', completeness: normalized.completeness.graph },
      };
      const plan = this.saveService.plan(saveOptions);
      if (plan.status !== 'ready' || !plan.plan_revision || plan.target !== target) throw conflict(plan.reason ?? 'Capture Source target is not ready for Save.');
      verifyChatGptExportInput({ inputPath: exportInput.path, expectedInputSha256: exportInput.sha256 });
      let saved;
      try { saved = this.saveService.prepare({ ...saveOptions, expectedPlanRevision: plan.plan_revision }); }
      catch (error) {
        const replay = this.#versions(projectId, sourceId).find((item) => item.parameters?.capture_source?.version_id === versionId);
        if (replay?.status === 'executed' && replay.current_output === 'verified') return { status: 'unchanged', save_id: replay.save_id, resource_id: replay.resource_id, source_id: sourceId, version_id: versionId, capture_mode: 'chatgpt_export', capture_scope: 'selected_conversation', completeness: normalized.completeness.graph, current_output: replay.current_output, diff: replay.parameters.capture_source.diff };
        if (replay && ['prepared', 'reserving', 'committing'].includes(replay.status)) return { status: replay.status, save_id: replay.save_id, source_id: sourceId, version_id: versionId, capture_mode: 'chatgpt_export', capture_scope: 'selected_conversation', completeness: normalized.completeness.graph, ...(replay.status === 'prepared' ? { preview_href: `/saves/${encodeURIComponent(replay.save_id)}`, diff: replay.parameters.capture_source.diff } : {}) };
        throw error;
      }
      return { status: saved.status, save_id: saved.save_id, resource_id: saved.resource_id ?? null, source_id: sourceId, version_id: versionId, capture_mode: 'chatgpt_export', capture_scope: 'selected_conversation', completeness: normalized.completeness.graph, preview_href: `/saves/${encodeURIComponent(saved.save_id)}`, diff, current_output: saved.current_output ?? null };
    } finally {
      runtimeStorage.dispose();
      fs.rmSync(candidate, { force: true });
    }
  }

  #document(saveId, projectId) {
    const save = this.saveService.show(saveId);
    if (save.project?.id !== projectId || save.source?.kind !== 'capture_source') throw conflict('Capture Source Save does not belong to this Project.');
    const snapshot = this.saveService.candidateSnapshot(saveId);
    const document = decodeDocument(fs.readFileSync(snapshot.path));
    if (document.schema !== 'atlas.source-capture.v1' || document.version_id !== save.parameters?.capture_source?.version_id) throw conflict('Capture Source receipt does not match its saved version.');
    return { save, document, snapshot };
  }

  show(saveId, { projectId }) {
    const { save, document } = this.#document(saveId, projectId);
    return {
      save_id: save.save_id, resource_id: save.resource_id, project_id: projectId,
      source_id: document.source_id, version_id: document.version_id, previous_save_id: document.previous_save_id,
      requested_url: document.requested_url, final_url: document.final_url, captured_at: document.captured_at,
      parser: document.parser, scope: document.scope, completeness: document.completeness,
      completeness_details: document.completeness_details ?? null, capture_mode: document.capture_mode,
      provider_conversation_id: document.provider_conversation_id ?? null, title: document.normalized?.title ?? null,
      container: document.container ?? null,
      raw_sha256: document.raw.sha256, raw_bytes: document.raw.bytes,
      current_output: save.status === 'undone' ? 'missing' : save.current_output, status: save.status, target: save.target.relative_path,
      diff: save.parameters.capture_source.diff,
    };
  }

  read(saveId, { projectId, cursor = null, characters = MAX_READ_CHARACTERS, mode = 'full' } = {}) {
    if (!Number.isInteger(characters) || characters < 1 || characters > MAX_READ_CHARACTERS) throw new Error(`Capture Source read characters must be between 1 and ${MAX_READ_CHARACTERS}.`);
    if (!['full', 'changes'].includes(mode)) throw new Error('Capture Source read mode must be full or changes.');
    const { save, document, snapshot } = this.#document(saveId, projectId);
    const currentOutput = save.status === 'undone' ? 'missing' : save.current_output;
    if (mode === 'full') {
      let offset = 0;
      if (cursor) {
        const value = decodeReadCursor(cursor);
        if (value.mode != null && value.mode !== 'full') throw conflict('Capture Source read cursor belongs to a different mode.');
        if (value.save_id !== saveId || value.sha256 !== snapshot.sha256 || !Number.isInteger(value.offset) || value.offset < 0) throw conflict('Capture Source read cursor is invalid or belongs to a different version.');
        offset = value.offset;
      }
      const text = document.readable;
      if (offset > text.length) throw conflict('Capture Source read cursor is outside the saved content.');
      const excerpt = text.slice(offset, offset + characters); const nextOffset = offset + excerpt.length;
      return { mode, save_id: saveId, resource_id: save.resource_id, source_id: document.source_id, version_id: document.version_id,
        scope: document.scope, completeness: document.completeness, current_output: currentOutput, start_character: offset, excerpt,
        truncated: nextOffset < text.length, next_cursor: nextOffset < text.length ? encodeReadCursor({ mode, save_id: saveId, sha256: snapshot.sha256, offset: nextOffset }) : null };
    }
    let previous = null;
    if (document.previous_save_id) {
      previous = this.#document(document.previous_save_id, projectId);
      if (previous.document.source_id !== document.source_id || previous.document.capture_mode !== document.capture_mode
          || previous.save.source?.kind !== 'capture_source' || previous.save.parameters?.capture_source?.source_id !== document.source_id
          || previous.document.version_id !== previous.save.parameters?.capture_source?.version_id) {
        throw conflict('Capture Source previous version cannot be proven to share this Project and source.');
      }
    }
    let comparison = null; let reason = null;
    if (!['chatgpt_share', 'chatgpt_export'].includes(document.capture_mode)) reason = 'capture_mode_not_supported_for_changes';
    else if (!previous) reason = 'no_previous_version';
    else if (document.capture_mode === 'chatgpt_share') { comparison = messageChanges(document, previous.document); if (!comparison) reason = 'stable_complete_message_ids_required'; }
    else if (document.capture_mode === 'chatgpt_export') { comparison = exportChanges(document, previous.document); if (!comparison) reason = 'normalized_export_graph_unavailable'; }
    else reason = 'capture_mode_not_supported_for_changes';
    const text = reason ? document.readable : serializeBlocks(comparison.blocks);
    const previousOutput = previous ? (previous.save.status === 'undone' ? 'missing' : previous.save.current_output) : null;
    const binding = { mode, save_id: saveId, sha256: snapshot.sha256, previous_save_id: previous?.save.save_id ?? null, previous_sha256: previous?.snapshot.sha256 ?? null };
    let offset = 0;
    if (cursor) {
      const value = decodeReadCursor(cursor);
      if (value.mode !== mode || value.save_id !== saveId || value.sha256 !== snapshot.sha256
          || value.previous_save_id !== binding.previous_save_id || value.previous_sha256 !== binding.previous_sha256
          || !Number.isInteger(value.offset) || value.offset < 0) throw conflict('Capture Source read cursor is invalid or belongs to a different mode or version.');
      offset = value.offset;
    }
    if (offset > text.length) throw conflict('Capture Source read cursor is outside the saved content.');
    const excerpt = text.slice(offset, offset + characters); const nextOffset = offset + excerpt.length;
    return { mode, save_id: saveId, resource_id: save.resource_id, source_id: document.source_id, version_id: document.version_id,
      previous_save_id: previous?.save.save_id ?? null, previous_resource_id: previous?.save.resource_id ?? null, previous_version_id: previous?.document.version_id ?? null,
      scope: document.scope, completeness: document.completeness, current_output: currentOutput, previous_output: previousOutput,
      comparison: reason ? { status: 'comparison_not_available', reason } : { status: 'available', ...comparison.summary },
      start_character: offset, excerpt, truncated: nextOffset < text.length,
      next_cursor: nextOffset < text.length ? encodeReadCursor({ ...binding, offset: nextOffset }) : null };
  }

  rawAttachment(saveId, { projectId }) {
    const { save, document } = this.#document(saveId, projectId);
    const json = document.capture_mode === 'chatgpt_export';
    return {
      save_id: saveId, resource_id: save.resource_id, sha256: document.raw.sha256,
      content_type: document.raw.content_type, extension: json ? 'json' : 'html',
      bytes: Buffer.from(document.raw.base64, 'base64'),
    };
  }

  dispose() {}
}

export function createCaptureSourceService(options) { return new CaptureSourceService(options); }
