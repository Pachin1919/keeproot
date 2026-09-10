import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isPathInside } from './paths.js';

export const CONVERSATION_SELECTION_SCHEMA = 'atlas.conversation-selection.v1';
export const CONVERSATION_LOCALIZATION_SCHEMA = 'atlas.conversation-localization.v1';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertExistingRegularFile(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} does not exist: ${filePath}`);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

function assertNoLinkTraversal(existingPath) {
  let cursor = path.resolve(existingPath);
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Conversation localization cannot traverse a link: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function cleanText(value, label, { oneLine = false, maximum = 20_000 } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  let result = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '');
  if (oneLine) result = result.replace(/\s+/gu, ' ').trim();
  else result = result.trim();
  if (!result) throw new Error(`${label} must not be empty.`);
  if (result.length > maximum) throw new Error(`${label} exceeds ${maximum} characters.`);
  return result;
}

function cleanList(value, label, maximum = 100) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be a bounded list.`);
  return value.map((item, index) => cleanText(item, `${label}[${index}]`, { maximum: 4000 }));
}

function markdownSafeHeading(value) {
  return cleanText(value, 'heading', { oneLine: true, maximum: 200 })
    .replace(/[<>]/gu, '')
    .replace(/^#+\s*/u, '');
}

function renderList(title, items) {
  if (!items.length) return '';
  return `\n## ${title}\n\n${items.map((item) => `- ${item}`).join('\n')}\n`;
}

function normalizedSelection(raw) {
  if (!raw || raw.schema !== CONVERSATION_SELECTION_SCHEMA) {
    throw new Error(`Conversation selection must use ${CONVERSATION_SELECTION_SCHEMA}.`);
  }
  if (!Array.isArray(raw.decisions) || raw.decisions.length < 1) {
    throw new Error('Conversation localization requires at least one selected decision; raw conversation dumps are not accepted.');
  }
  if (raw.decisions.length > 100) throw new Error('Conversation selection has too many decisions.');
  const decisions = raw.decisions.map((item, index) => ({
    title: markdownSafeHeading(item?.title ?? ''),
    content: cleanText(item?.content, `decisions[${index}].content`, { maximum: 12_000 }),
  }));
  const source = raw.source ?? {};
  const task = raw.task_packet ?? null;
  return {
    title: markdownSafeHeading(raw.title),
    source: {
      host: cleanText(source.host, 'source.host', { oneLine: true, maximum: 80 }),
      thread_id: cleanText(source.thread_id, 'source.thread_id', { oneLine: true, maximum: 200 }),
      selected_at: cleanText(source.selected_at, 'source.selected_at', { oneLine: true, maximum: 80 }),
    },
    purpose: cleanText(raw.purpose, 'purpose', { maximum: 2000 }),
    decisions,
    completed: cleanList(raw.completed, 'completed'),
    pending: cleanList(raw.pending, 'pending'),
    task_packet: task ? {
      objective: cleanText(task.objective, 'task_packet.objective', { maximum: 4000 }),
      files: cleanList(task.files, 'task_packet.files', 50),
      acceptance: cleanList(task.acceptance, 'task_packet.acceptance', 50),
      prohibited: cleanList(task.prohibited, 'task_packet.prohibited', 50),
    } : null,
  };
}

function renderMarkdown(selection) {
  const lines = [
    `# ${selection.title}`,
    '',
    selection.purpose,
    '',
    '## Source',
    '',
    `- Host: ${selection.source.host}`,
    `- Thread: ${selection.source.thread_id}`,
    `- Selected: ${selection.source.selected_at}`,
    '',
    '## Confirmed decisions',
    '',
  ];
  for (const decision of selection.decisions) {
    lines.push(`### ${decision.title}`, '', decision.content, '');
  }
  let markdown = `${lines.join('\n').trimEnd()}\n`;
  markdown += renderList('Completed facts', selection.completed);
  markdown += renderList('Open work', selection.pending);
  if (selection.task_packet) {
    markdown += '\n## Subagent task packet\n\n';
    markdown += `### Objective\n\n${selection.task_packet.objective}\n`;
    markdown += renderList('Files', selection.task_packet.files).replace('\n## Files', '\n### Files');
    markdown += renderList('Acceptance', selection.task_packet.acceptance).replace('\n## Acceptance', '\n### Acceptance');
    markdown += renderList('Prohibited', selection.task_packet.prohibited).replace('\n## Prohibited', '\n### Prohibited');
  }
  return `${markdown.trimEnd()}\n`;
}

export function localizeConversationSelection({ inputPath, outputPath, projectRoot }) {
  const input = path.resolve(inputPath ?? '');
  const project = path.resolve(projectRoot ?? '');
  const output = path.resolve(outputPath ?? '');
  assertExistingRegularFile(input, 'Conversation selection input');
  assertNoLinkTraversal(input);
  if (!fs.existsSync(project) || !fs.lstatSync(project).isDirectory()) throw new Error('Selected Project root is unavailable.');
  assertNoLinkTraversal(project);
  if (!isPathInside(project, output)) throw new Error('Conversation Markdown output must remain inside the selected Project.');
  if (path.extname(output).toLowerCase() !== '.md') throw new Error('Conversation localization output must use the .md extension.');
  if (fs.existsSync(output)) throw new Error('Conversation localization output must not already exist.');
  const parent = path.dirname(output);
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory()) throw new Error('Conversation localization output directory must already exist.');
  assertNoLinkTraversal(parent);

  const inputBytes = fs.readFileSync(input);
  if (inputBytes.length > 2 * 1024 * 1024) throw new Error('Conversation selection input exceeds 2 MiB.');
  let raw;
  try {
    raw = JSON.parse(inputBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Conversation selection is not valid UTF-8 JSON: ${error.message}`);
  }
  const selected = normalizedSelection(raw);
  const markdown = renderMarkdown(selected);
  const outputBytes = Buffer.from(markdown, 'utf8');
  if (outputBytes.length > 512 * 1024) throw new Error('Localized conversation exceeds 512 KiB.');
  if (sha256(fs.readFileSync(input)) !== sha256(inputBytes)) {
    const error = new Error('Conversation selection changed during localization.');
    error.code = 'ATLAS_STATE_CONFLICT';
    throw error;
  }

  const temporary = path.join(parent, `.${path.basename(output)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, outputBytes, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return {
    schema: CONVERSATION_LOCALIZATION_SCHEMA,
    source: { path: input, sha256: sha256(inputBytes), bytes: inputBytes.length },
    output: { path: output, sha256: sha256(outputBytes), bytes: outputBytes.length, format: 'markdown' },
    thread_id: selected.source.thread_id,
    decision_count: selected.decisions.length,
    completed_count: selected.completed.length,
    pending_count: selected.pending.length,
    verified: fs.existsSync(output) && sha256(fs.readFileSync(output)) === sha256(outputBytes),
  };
}
