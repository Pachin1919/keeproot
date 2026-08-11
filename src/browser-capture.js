import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeStorage } from './runtime-storage.js';
import { fetchPublicDocument } from './public-web-capture.js';

const CAPTURE_SCHEMA = 'atlas-browser-capture.v1';
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_SAMPLE_CHARACTERS = 4_000;

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u0000/gu, '')
    .replace(/\u200B/gu, '')
    .replace(/\r\n?/gu, '\n')
    .normalize('NFC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{4,}/gu, '\n\n\n')
    .trim();
}
function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function safeTitle(value) {
  const title = normalizeText(value).split('\n')[0].trim();
  return title || '浏览器页面记录';
}

function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function chatRecords(capture) {
  if (!Array.isArray(capture.messages) || capture.messages.length === 0) return null;
  const sourceUrl = String(capture.source_url ?? capture.url ?? '').trim();
  const conversationId = String(capture.conversation_id ?? '').trim()
    || (() => {
      try {
        const last = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
        if (last) return last;
      } catch {
        // Fall back to a deterministic local identifier.
      }
      return `conversation-${crypto.createHash('sha256').update(`${sourceUrl}|${safeTitle(capture.title)}`).digest('hex').slice(0, 20)}`;
    })();
  const records = [];
  const roles = {};
  let generatedIds = 0;
  for (const [index, item] of capture.messages.entries()) {
    const role = String(item?.role ?? '').trim().toLowerCase();
    const content = normalizeText(item?.content);
    if (!role || !content) continue;
    const timestamp = timestampValue(item?.timestamp ?? item?.created_at ?? item?.time);
    let messageId = String(item?.message_id ?? item?.id ?? '').trim();
    if (!messageId) {
      messageId = `message-${crypto.createHash('sha256')
        .update(`${conversationId}|${index}|${role}|${timestamp ?? ''}|${content}`)
        .digest('hex').slice(0, 24)}`;
      generatedIds += 1;
    }
    roles[role] = (roles[role] ?? 0) + 1;
    records.push({
      schema: 'atlas.chat-message.v1',
      conversation_id: conversationId,
      message_id: messageId,
      parent_message_id: String(item?.parent_message_id ?? '').trim() || null,
      ordinal: index,
      timestamp,
      role,
      content,
      source: capture.capture_mode ?? 'chat_capture',
      source_url: sourceUrl || null,
    });
  }
  if (!records.length) return null;
  const timestamps = records.map((record) => record.timestamp).filter(Boolean).sort();
  return {
    records,
    jsonl: `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    conversationId,
    roles,
    generatedIds,
    coverage: timestamps.length ? {
      status: timestamps.length === records.length ? 'complete' : 'partial',
      basis: 'message_timestamps',
      start: timestamps[0],
      end: timestamps.at(-1),
      timestamped_messages: timestamps.length,
      message_count: records.length,
    } : {
      status: 'unavailable',
      reason: 'no_parseable_message_timestamps',
      message_count: records.length,
    },
  };
}

function parseCaptureFile(inputFile) {
  const absolute = path.resolve(inputFile);
  if (!fs.existsSync(absolute)) throw new Error(`Browser capture input does not exist: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Browser capture input must be a regular non-symbolic-link file: ${absolute}`);
  }
  if (stat.size === 0 || stat.size > MAX_CAPTURE_BYTES) {
    throw new Error(`Browser capture input must be between 1 byte and ${MAX_CAPTURE_BYTES} bytes.`);
  }
  const raw = fs.readFileSync(absolute, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      schema: CAPTURE_SCHEMA,
      capture_mode: 'selected_text',
      title: path.basename(absolute, path.extname(absolute)),
      source_url: null,
      captured_at: null,
      text: raw,
    };
  }
  if (!parsed || parsed.schema !== CAPTURE_SCHEMA) {
    throw new Error(`Browser capture input must use schema ${CAPTURE_SCHEMA}.`);
  }
  return { absolute, stat, capture: parsed };
}

function messageMarkdown(capture) {
  if (!Array.isArray(capture.messages) || capture.messages.length === 0) return null;
  const messages = [];
  const counts = {};
  for (const item of capture.messages) {
    const role = String(item?.role ?? '').trim().toLowerCase();
    const content = normalizeText(item?.content);
    if (!role || !content) continue;
    const label = role === 'user' ? '用户'
      : role === 'assistant' ? 'ChatGPT'
        : role;
    counts[role] = (counts[role] ?? 0) + 1;
    messages.push(`## ${label}\n\n${content}`);
  }
  if (messages.length === 0) return null;
  return { body: messages.join('\n\n---\n\n'), counts, count: messages.length };
}

function formatCapture(capture) {
  const title = safeTitle(capture.title);
  const sourceUrl = capture.source_url ?? capture.url ?? '';
  const capturedAt = capture.captured_at ?? '';
  const chat = messageMarkdown(capture);
  const text = chat ? chat.body : normalizeText(capture.text ?? capture.content);
  if (!text) throw new Error('Browser capture contains no usable text.');
  const header = [
    '---',
    `source_url: ${yamlString(sourceUrl)}`,
    `source_title: ${yamlString(title)}`,
    `captured_at: ${yamlString(capturedAt)}`,
    `capture_mode: ${yamlString(capture.capture_mode ?? 'selected_text')}`,
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
  const markdown = `${header}${text}\n`;
  return {
    markdown,
    title,
    sourceUrl,
    captureMode: capture.capture_mode ?? 'selected_text',
    messageCount: chat?.count ?? null,
    roleCounts: chat?.counts ?? null,
    normalizedChat: chatRecords(capture),
  };
}

export class BrowserCapture {
  constructor({ stateDir, storage = null, fetchImpl = globalThis.fetch, lookupHost = undefined }) {
    if (!stateDir) throw new Error('BrowserCapture requires a stateDir.');
    this.stateDir = path.resolve(stateDir);
    this.storage = storage ?? new RuntimeStorage({ stateDir: this.stateDir });
    this._ownsStorage = storage == null;
    this.fetchImpl = fetchImpl;
    this.lookupHost = lookupHost;
  }

  localize({ inputFile, ttlHours = 168 }) {
    const { absolute, stat, capture } = parseCaptureFile(inputFile);
    const formatted = formatCapture(capture);
    const tempDir = path.join(this.stateDir, 'tmp');
    fs.mkdirSync(tempDir, { recursive: true });
    const temporary = path.join(tempDir, `${crypto.randomUUID()}.browser-localized.md`);
    const normalizedTemporary = formatted.normalizedChat
      ? path.join(tempDir, `${crypto.randomUUID()}.chat-normalized.jsonl`)
      : null;
    try {
      fs.writeFileSync(temporary, formatted.markdown, { encoding: 'utf8', flag: 'wx' });
      const staged = this.storage.stage({ source: temporary, kind: 'candidate', ttlHours });
      let normalized = null;
      if (normalizedTemporary) {
        fs.writeFileSync(normalizedTemporary, formatted.normalizedChat.jsonl, { encoding: 'utf8', flag: 'wx' });
        normalized = this.storage.stage({ source: normalizedTemporary, kind: 'intermediate', ttlHours });
      }
      return {
        status: 'localized',
        source_type: formatted.messageCount == null ? 'browser_text' : 'chat_transcript',
        source_url: formatted.sourceUrl || null,
        title: formatted.title,
        capture_mode: formatted.captureMode,
        capture_scope: capture.capture_scope ?? 'selected_or_rendered_content',
        completeness: capture.completeness ?? 'not_proven',
        input_bytes: stat.size,
        output_bytes: staged.byte_size,
        content_hash: staged.content_hash,
        message_count: formatted.messageCount,
        role_counts: formatted.roleCounts,
        conversation_id: formatted.normalizedChat?.conversationId ?? null,
        message_id_generated_count: formatted.normalizedChat?.generatedIds ?? null,
        coverage: formatted.normalizedChat?.coverage ?? null,
        work_id: staged.work_id,
        candidate_path: staged.payload_path,
        normalized_work_id: normalized?.work_id ?? null,
        normalized_path: normalized?.payload_path ?? null,
        normalized_hash: normalized?.content_hash ?? null,
        normalized_bytes: normalized?.byte_size ?? null,
        model_visible_body_bytes: 0,
        next: 'Read only bounded samples, then pass candidate_path to atlas intake prepare.',
        source_file: absolute,
      };
    } finally {
      fs.rmSync(temporary, { force: true });
      if (normalizedTemporary) fs.rmSync(normalizedTemporary, { force: true });
    }
  }

  async fetchPublic({ url, ttlHours = 168 }) {
    const fetched = await fetchPublicDocument(url, {
      fetchImpl: this.fetchImpl,
      ...(this.lookupHost ? { lookupHost: this.lookupHost } : {}),
    });
    const tempDir = path.join(this.stateDir, 'tmp');
    fs.mkdirSync(tempDir, { recursive: true });
    const temporary = path.join(tempDir, `${crypto.randomUUID()}.public-web-capture.json`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(fetched.capture), { encoding: 'utf8', flag: 'wx' });
      const localized = this.localize({ inputFile: temporary, ttlHours });
      return {
        ...localized,
        source_file: null,
        requested_url: fetched.requested_url,
        final_url: fetched.final_url,
        redirect_count: fetched.redirect_count,
        http_status: fetched.http_status,
        content_type: fetched.content_type,
        downloaded_bytes: fetched.downloaded_bytes,
        resolver_mode: fetched.resolver_mode,
        network_used: true,
        browser_used: false,
        external_application_used: false,
      };
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  sample(workId, { startCharacter = 0, characters = 1_200 } = {}) {
    const start = Number(startCharacter);
    const length = Number(characters);
    if (!Number.isInteger(start) || start < 0) {
      throw new Error('Capture sample startCharacter must be a non-negative integer.');
    }
    if (!Number.isInteger(length) || length < 1 || length > MAX_SAMPLE_CHARACTERS) {
      throw new Error(`Capture sample characters must be between 1 and ${MAX_SAMPLE_CHARACTERS}.`);
    }
    const work = this.storage.showWork(workId);
    const text = fs.readFileSync(work.payload_path, 'utf8');
    const excerpt = text.slice(start, start + length);
    return {
      work_id: workId,
      content_hash: work.content_hash,
      total_characters: text.length,
      start_character: start,
      excerpt_characters: excerpt.length,
      has_more: start + excerpt.length < text.length,
      next_start_character: start + excerpt.length < text.length ? start + excerpt.length : null,
      excerpt,
    };
  }

  dispose() {
    if (this._ownsStorage) this.storage.dispose();
  }
}
