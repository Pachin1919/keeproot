import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = 'atlas-browser-capture.v1';
const MAX_BYTES = 32 * 1024 * 1024;

function assertStateDirectory(stateDir) {
  if (!stateDir) throw new Error('Atlas stateDir is required.');
  const absolute = path.resolve(stateDir);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Atlas stateDir must be a real directory: ${absolute}`);
  }
  return absolute;
}
export async function captureBrowserPage({ tab, stateDir, mode = 'auto' }) {
  if (!tab?.playwright?.evaluate) throw new Error('A controlled Browser tab is required.');
  if (!['auto', 'selection', 'page_text', 'chatgpt_share'].includes(mode)) {
    throw new Error('Browser capture mode must be auto, selection, page_text, or chatgpt_share.');
  }
  const state = assertStateDirectory(stateDir);
  const record = await tab.playwright.evaluate((requestedMode) => {
    const sourceUrl = location.href;
    const host = location.hostname.toLowerCase();
    const selected = window.getSelection?.()?.toString() ?? '';
    const useChat = requestedMode === 'chatgpt_share'
      || (requestedMode === 'auto' && host === 'chatgpt.com' && sourceUrl.includes('/share/'));
    if (requestedMode === 'selection' && !selected.trim()) {
      throw new Error('No browser text is selected.');
    }
    if (useChat) {
      const nodes = [...document.querySelectorAll('[data-message-author-role]')];
      const messages = nodes.map((node) => ({
        role: node.getAttribute('data-message-author-role') ?? 'unknown',
        content: node.innerText ?? node.textContent ?? '',
      })).filter((item) => item.content.trim());
      if (messages.length) {
        return {
          schema: 'atlas-browser-capture.v1',
          capture_mode: 'chatgpt_share',
          capture_scope: 'rendered_message_dom',
          completeness: 'not_proven',
          source_url: sourceUrl,
          title: document.title,
          captured_at: new Date().toISOString(),
          messages,
        };
      }
    }
    return {
      schema: 'atlas-browser-capture.v1',
      capture_mode: selected.trim() ? 'selected_text' : 'page_text',
      capture_scope: selected.trim() ? 'user_selection' : 'rendered_document_text',
      completeness: selected.trim() ? 'selection_only' : 'not_proven',
      source_url: sourceUrl,
      title: document.title,
      captured_at: new Date().toISOString(),
      text: selected.trim() || document.body?.innerText || '',
    };
  }, mode, { timeoutMs: 120_000 });
  const serialized = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.byteLength(serialized);
  if (bytes === 0 || bytes > MAX_BYTES) {
    throw new Error(`Browser capture must be between 1 byte and ${MAX_BYTES} bytes.`);
  }
  const tempDir = path.join(state, 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });
  const output = path.join(tempDir, `${crypto.randomUUID()}.browser-capture.json`);
  fs.writeFileSync(output, serialized, { encoding: 'utf8', flag: 'wx' });
  return {
    status: 'captured_locally',
    capture_file: output,
    source_url: record.source_url,
    title: record.title,
    capture_mode: record.capture_mode,
    capture_scope: record.capture_scope,
    completeness: record.completeness,
    message_count: Array.isArray(record.messages) ? record.messages.length : null,
    bytes,
  };
}
