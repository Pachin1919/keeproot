import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeStorage } from './runtime-storage.js';

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
  };
}

export class BrowserCapture {
  constructor({ stateDir, storage = null }) {
    if (!stateDir) throw new Error('BrowserCapture requires a stateDir.');
    this.stateDir = path.resolve(stateDir);
    this.storage = storage ?? new RuntimeStorage({ stateDir: this.stateDir });
    this._ownsStorage = storage == null;
  }

  localize({ inputFile, ttlHours = 168 }) {
    const { absolute, stat, capture } = parseCaptureFile(inputFile);
    const formatted = formatCapture(capture);
    const tempDir = path.join(this.stateDir, 'tmp');
    fs.mkdirSync(tempDir, { recursive: true });
    const temporary = path.join(tempDir, `${crypto.randomUUID()}.browser-localized.md`);
    try {
      fs.writeFileSync(temporary, formatted.markdown, { encoding: 'utf8', flag: 'wx' });
      const staged = this.storage.stage({ source: temporary, kind: 'candidate', ttlHours });
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
        work_id: staged.work_id,
        candidate_path: staged.payload_path,
        next: 'Read only bounded samples, then pass candidate_path to atlas intake prepare.',
        source_file: absolute,
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
