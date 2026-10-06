import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const CHATGPT_EXPORT_MAX_BYTES = 64 * 1024 * 1024;
export const CHATGPT_EXPORT_MAX_CONVERSATIONS = 10_000;
export const CHATGPT_EXPORT_MAX_NODES = 20_000;
export const CHATGPT_EXPORT_MAX_SELECTED_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
const stableJson = (value) => JSON.stringify(stableValue(value));
function conflict(message) { const error = new Error(message); error.code = 'ATLAS_STATE_CONFLICT'; return error; }

function assertLocalRegularPath(inputPath) {
  const raw = String(inputPath ?? '');
  if (!raw.trim() || raw.startsWith('\\\\') || raw.startsWith('//') || /^\\\\[?.]\\/u.test(raw)) {
    throw conflict('ChatGPT export input must be a local regular file path.');
  }
  const absolute = path.resolve(raw);
  const parsed = path.win32.parse(absolute);
  if (!parsed.root || parsed.root.startsWith('\\\\')) throw conflict('ChatGPT export input must be on a local filesystem.');
  const relative = path.win32.relative(parsed.root, absolute);
  if (relative.split(/[\\/]/u).some((part) => part.includes(':'))) throw conflict('ChatGPT export input cannot use an alternate data stream.');
  let cursor = parsed.root;
  for (const part of relative.split(/[\\/]/u).filter(Boolean)) {
    cursor = path.win32.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') throw conflict('ChatGPT export input does not exist.'); throw error; }
    if (stat.isSymbolicLink()) throw conflict('ChatGPT export input cannot traverse a symbolic link or junction.');
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw conflict('ChatGPT export input must be a regular local file.');
  if (stat.size > CHATGPT_EXPORT_MAX_BYTES) throw conflict(`ChatGPT export input exceeds ${CHATGPT_EXPORT_MAX_BYTES} bytes.`);
  return { absolute, stat };
}

function skipWhitespace(bytes, offset) {
  while (offset < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[offset])) offset += 1;
  return offset;
}

function arrayObjectRanges(bytes) {
  let cursor = skipWhitespace(bytes, 0);
  if (bytes[cursor] !== 0x5b) throw new Error('ChatGPT export must be a JSON array of conversations.');
  cursor = skipWhitespace(bytes, cursor + 1);
  const ranges = [];
  if (bytes[cursor] === 0x5d) {
    if (skipWhitespace(bytes, cursor + 1) !== bytes.length) throw new Error('ChatGPT export has content after its conversation array.');
    return ranges;
  }
  while (cursor < bytes.length) {
    if (bytes[cursor] !== 0x7b) throw new Error('Each ChatGPT export conversation must be a JSON object.');
    const start = cursor; let braces = 0; let brackets = 0; let inString = false; let escaped = false;
    for (; cursor < bytes.length; cursor += 1) {
      const byte = bytes[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
        continue;
      }
      if (byte === 0x22) inString = true;
      else if (byte === 0x7b) braces += 1;
      else if (byte === 0x7d) braces -= 1;
      else if (byte === 0x5b) brackets += 1;
      else if (byte === 0x5d) brackets -= 1;
      if (braces < 0 || brackets < 0) throw new Error('ChatGPT export has invalid JSON structure.');
      if (braces + brackets > 128) throw conflict('ChatGPT export JSON nesting exceeds 128 levels.');
      if (braces === 0 && brackets === 0) { cursor += 1; break; }
    }
    if (braces !== 0 || brackets !== 0 || inString) throw new Error('ChatGPT export contains an incomplete conversation object.');
    ranges.push({ start, end: cursor });
    if (ranges.length > CHATGPT_EXPORT_MAX_CONVERSATIONS) throw conflict(`ChatGPT export exceeds ${CHATGPT_EXPORT_MAX_CONVERSATIONS} conversations.`);
    cursor = skipWhitespace(bytes, cursor);
    if (bytes[cursor] === 0x5d) {
      if (skipWhitespace(bytes, cursor + 1) !== bytes.length) throw new Error('ChatGPT export has content after its conversation array.');
      return ranges;
    }
    if (bytes[cursor] !== 0x2c) throw new Error('ChatGPT export conversation array is malformed.');
    cursor = skipWhitespace(bytes, cursor + 1);
    if (bytes[cursor] === 0x5d) throw new Error('ChatGPT export conversation array has a trailing comma.');
  }
  throw new Error('ChatGPT export conversation array is incomplete.');
}

function assertSelectedObjectHasUniqueKeys(bytes) {
  const stack = [];
  let inString = false; let escaped = false; let stringStart = -1;
  for (let offset = 0; offset < bytes.length; offset += 1) {
    const byte = bytes[offset];
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) {
        inString = false;
        const frame = stack.at(-1);
        if (frame?.kind === 'object' && frame.expectsKey) {
          const key = JSON.parse(bytes.subarray(stringStart, offset + 1).toString('utf8'));
          if (frame.keys.has(key)) throw conflict(`Selected ChatGPT conversation has a duplicate JSON key: ${key}.`);
          frame.keys.add(key);
          frame.expectsKey = false;
        }
      }
      continue;
    }
    if (byte === 0x22) { inString = true; stringStart = offset; }
    else if (byte === 0x7b) stack.push({ kind: 'object', keys: new Set(), expectsKey: true });
    else if (byte === 0x5b) stack.push({ kind: 'array' });
    else if (byte === 0x7d || byte === 0x5d) stack.pop();
    else if (byte === 0x2c && stack.at(-1)?.kind === 'object') stack.at(-1).expectsKey = true;
  }
}

function loadContainer(inputPath) {
  const { absolute, stat } = assertLocalRegularPath(inputPath);
  const bytes = fs.readFileSync(absolute);
  if (bytes.length > CHATGPT_EXPORT_MAX_BYTES) throw conflict(`ChatGPT export input exceeds ${CHATGPT_EXPORT_MAX_BYTES} bytes.`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('ChatGPT export input must be valid UTF-8.'); }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('ChatGPT export input is not valid JSON.'); }
  if (!Array.isArray(parsed)) throw new Error('ChatGPT export must be a JSON array of conversations.');
  const ranges = arrayObjectRanges(bytes);
  if (ranges.length !== parsed.length) throw new Error('ChatGPT export conversation boundaries are inconsistent.');
  return { absolute, bytes, sha256: sha256(bytes), stat, parsed, ranges };
}

function providerConversationId(conversation) {
  const exported = typeof conversation?.conversation_id === 'string' ? conversation.conversation_id.trim() : '';
  const legacy = typeof conversation?.id === 'string' ? conversation.id.trim() : '';
  if (exported && legacy && exported !== legacy) throw conflict('ChatGPT export conversation identity fields disagree.');
  return exported || legacy || null;
}

function inspectConversation(conversation, index) {
  const mapping = conversation?.mapping;
  const nodeCount = mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? Object.keys(mapping).length : 0;
  if (nodeCount > CHATGPT_EXPORT_MAX_NODES) throw conflict(`Conversation ${index} exceeds ${CHATGPT_EXPORT_MAX_NODES} nodes.`);
  const id = providerConversationId(conversation);
  return { provider_conversation_id: id, title: typeof conversation?.title === 'string' ? conversation.title : '', node_count: nodeCount };
}

export function inspectChatGptExport({ inputPath, limit = DEFAULT_LIMIT, cursor = null }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`Export inspect limit must be between 1 and ${MAX_LIMIT}.`);
  const container = loadContainer(inputPath);
  let offset = 0;
  if (cursor) {
    try {
      const token = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (token.sha256 !== container.sha256 || token.limit !== limit || !Number.isInteger(token.offset) || token.offset < 0 || token.offset > container.parsed.length) throw new Error();
      offset = token.offset;
    } catch { throw conflict('ChatGPT export cursor is stale or invalid for this input.'); }
  }
  const end = Math.min(container.parsed.length, offset + limit);
  const items = [];
  for (let index = offset; index < end; index += 1) {
    const range = container.ranges[index];
    const selectedBytes = container.bytes.subarray(range.start, range.end);
    const detail = inspectConversation(container.parsed[index], index);
    const selectedSha256 = sha256(selectedBytes);
    items.push({ selection: { index, selected_sha256: selectedSha256 }, selection_token: `${index}:${selectedSha256}`, ...detail });
  }
  const next = end < container.parsed.length
    ? Buffer.from(JSON.stringify({ sha256: container.sha256, limit, offset: end })).toString('base64url') : null;
  return { input_revision: { sha256: container.sha256, bytes: container.bytes.length }, items, next_cursor: next, has_more: Boolean(next) };
}

export function selectChatGptExportConversation({ inputPath, expectedInputSha256, selection }) {
  const container = loadContainer(inputPath);
  if (container.sha256 !== expectedInputSha256) throw conflict('ChatGPT export changed since its conversation list was inspected.');
  const index = Number(selection?.index);
  if (!Number.isInteger(index) || index < 0 || index >= container.parsed.length) throw conflict('Selected conversation is no longer present in this ChatGPT export.');
  const range = container.ranges[index];
  const rawBytes = container.bytes.subarray(range.start, range.end);
  const selectedSha256 = sha256(rawBytes);
  if (selection?.selected_sha256 !== selectedSha256) throw conflict('Selected conversation bytes changed since inspection.');
  if (rawBytes.length > CHATGPT_EXPORT_MAX_SELECTED_BYTES) throw conflict(`Selected conversation exceeds ${CHATGPT_EXPORT_MAX_SELECTED_BYTES} bytes.`);
  assertSelectedObjectHasUniqueKeys(rawBytes);
  const conversation = container.parsed[index];
  const detail = inspectConversation(conversation, index);
  const providerIdCount = detail.provider_conversation_id
    ? container.parsed.filter((item) => providerConversationId(item) === detail.provider_conversation_id).length : 0;
  const { absolute } = assertLocalRegularPath(inputPath);
  return {
    input_path: absolute, input_sha256: container.sha256, input_bytes: container.bytes.length,
    index, selected_sha256: selectedSha256, selected_bytes: rawBytes, conversation, ...detail,
    provider_id_reliable: providerIdCount === 1,
  };
}

export function verifyChatGptExportInput({ inputPath, expectedInputSha256 }) {
  const { absolute } = assertLocalRegularPath(inputPath);
  const bytes = fs.readFileSync(absolute);
  if (bytes.length > CHATGPT_EXPORT_MAX_BYTES || sha256(bytes) !== expectedInputSha256) {
    throw conflict('ChatGPT export changed after Save preparation; prepare the selected conversation again.');
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw conflict('ChatGPT export is no longer valid UTF-8.'); }
  return { input_path: absolute, sha256: expectedInputSha256, bytes: bytes.length };
}

export function normalizeChatGptConversation(conversation) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Selected ChatGPT conversation has no valid node mapping.');
  const entries = Object.entries(mapping);
  if (entries.length > CHATGPT_EXPORT_MAX_NODES) throw conflict(`Selected conversation exceeds ${CHATGPT_EXPORT_MAX_NODES} nodes.`);
  const keyToId = new Map(entries.map(([key, node]) => [key, String(node?.id ?? key)]));
  if (new Set(keyToId.values()).size !== entries.length) throw conflict('Selected ChatGPT conversation has duplicate node identities.');
  const nodes = entries.map(([key, node]) => {
    const message = node?.message ?? null;
    const contentValue = message?.content;
    const parts = Array.isArray(contentValue?.parts) ? contentValue.parts : [];
    const textParts = parts.filter((part) => typeof part === 'string');
    const content = textParts.length ? textParts.join('\n').replace(/\r\n?/gu, '\n') : '';
    const identity = String(node?.id ?? key);
    const unknownParts = parts.filter((part) => typeof part !== 'string');
    const unknownFields = contentValue && typeof contentValue === 'object'
      ? Object.fromEntries(Object.entries(contentValue).filter(([name]) => name !== 'parts' && name !== 'content_type')) : contentValue;
    const unknownPayload = contentValue && typeof contentValue === 'object'
      ? { content_type: contentValue.content_type ?? null, parts: unknownParts, fields: unknownFields }
      : contentValue == null ? null : { unrecognized_content: contentValue };
    const unknown = unknownPayload ? sha256(Buffer.from(stableJson(unknownPayload))) : null;
    const attachmentRefs = [];
    if (contentValue && typeof contentValue === 'object') {
      for (const [name, value] of Object.entries(contentValue)) {
        if (/image|audio|video|file|attachment/iu.test(name) && value != null) attachmentRefs.push({ field: name, fingerprint: sha256(Buffer.from(stableJson(value))) });
      }
    }
    return {
      node_id: identity, message_id: message?.id == null ? null : String(message.id),
      parent_node_id: node?.parent == null ? null : (keyToId.get(String(node.parent)) ?? String(node.parent)),
      child_node_ids: Array.isArray(node?.children) ? node.children.map((id) => keyToId.get(String(id)) ?? String(id)) : [],
      role: String(message?.author?.role ?? 'unknown'), content, unknown_content_fingerprint: unknown,
      message_metadata_fingerprint: message ? sha256(Buffer.from(stableJson({
        metadata: message.metadata ?? null, recipient: message.recipient ?? null,
        status: message.status ?? null, author_id: message.author?.id ?? null,
      }))) : null,
      attachment_refs: attachmentRefs,
    };
  }).sort((left, right) => left.node_id.localeCompare(right.node_id));
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const parentState = new Map();
  for (const node of nodes) {
    if (parentState.get(node.node_id) === 2) continue;
    const visited = [];
    let parent = node.node_id;
    while (parent && byId.has(parent) && parentState.get(parent) !== 2) {
      if (parentState.get(parent) === 1) throw conflict('Selected ChatGPT conversation has a cyclic parent graph.');
      parentState.set(parent, 1);
      visited.push(parent);
      parent = byId.get(parent).parent_node_id;
    }
    for (const id of visited) parentState.set(id, 2);
  }
  const activeIds = []; const seen = new Set(); let cursor = conversation.current_node == null ? null : (keyToId.get(String(conversation.current_node)) ?? String(conversation.current_node));
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor); activeIds.unshift(cursor); cursor = byId.get(cursor).parent_node_id;
  }
  const graphComplete = Boolean(conversation.current_node && byId.has(String(conversation.current_node)))
    && nodes.every((node) => !node.parent_node_id || byId.has(node.parent_node_id))
    && nodes.every((node) => node.child_node_ids.every((id) => byId.has(id))) && activeIds.length > 0;
  const hasAttachments = nodes.some((node) => node.attachment_refs.length > 0);
  const readable = activeIds.map((id) => {
    const node = byId.get(id);
    return node.content ? `## ${node.role}\n\n${node.content}` : '';
  }).filter(Boolean).join('\n\n---\n\n');
  return {
    title: typeof conversation.title === 'string' ? conversation.title : '',
    conversation_id: providerConversationId(conversation),
    current_node: conversation.current_node == null ? null : String(conversation.current_node),
    active_path: activeIds, nodes,
    completeness: {
      graph: graphComplete ? 'complete' : 'partial',
      attachments: hasAttachments ? 'references_only' : 'not_present',
      pagination: 'complete',
    },
    readable: readable || '(No readable text was found on the selected active branch.)',
  };
}

export function diffChatGptConversations(current, previous) {
  if (!previous) return { kind: 'initial', added_count: 0, edited_count: 0, parent_changed_count: 0, branch_changed_count: 0, active_path_changed: false, absent_from_export: [], unobserved: [], previous_save_id: null };
  const oldNodes = new Map(previous.document.normalized.nodes.map((node) => [node.node_id, node]));
  const newNodes = new Map(current.normalized.nodes.map((node) => [node.node_id, node]));
  const added = [...newNodes.keys()].filter((id) => !oldNodes.has(id));
  const edited = [...newNodes.keys()].filter((id) => oldNodes.has(id)
    && ['content', 'unknown_content_fingerprint', 'message_metadata_fingerprint', 'role']
      .some((key) => newNodes.get(id)[key] !== oldNodes.get(id)[key]));
  const parentChanged = [...newNodes.keys()].filter((id) => oldNodes.has(id) && newNodes.get(id).parent_node_id !== oldNodes.get(id).parent_node_id);
  const branchChanged = [...newNodes.keys()].filter((id) => oldNodes.has(id) && JSON.stringify(newNodes.get(id).child_node_ids) !== JSON.stringify(oldNodes.get(id).child_node_ids));
  const missing = [...oldNodes.keys()].filter((id) => !newNodes.has(id));
  const complete = current.normalized.completeness.graph === 'complete';
  return {
    kind: 'node_changes', previous_save_id: previous.save.save_id,
    added_count: added.length, edited_count: edited.length, parent_changed_count: parentChanged.length,
    branch_changed_count: branchChanged.length, active_path_changed: JSON.stringify(current.normalized.active_path) !== JSON.stringify(previous.document.normalized.active_path),
    absent_from_export: complete ? missing.slice(0, 100) : [], unobserved: complete ? [] : missing.slice(0, 100),
    truncated: added.length > 100 || edited.length > 100 || parentChanged.length > 100 || branchChanged.length > 100 || missing.length > 100,
    added: added.slice(0, 100), edited: edited.slice(0, 100), parent_changed: parentChanged.slice(0, 100), branch_changed: branchChanged.slice(0, 100),
  };
}

export const CHATGPT_EXPORT_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const CHATGPT_EXPORT_MAX_LIMIT = MAX_LIMIT;
