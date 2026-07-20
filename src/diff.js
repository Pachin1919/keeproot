import fs from 'node:fs';
import { sha256Buffer } from './snapshots.js';

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}
function splitText(value) {
  if (value === '') return { lines: [], hasFinalNewline: false };
  const lines = value.split('\n');
  const hasFinalNewline = lines.at(-1) === '';
  if (hasFinalNewline) lines.pop();
  return {
    lines: lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line),
    hasFinalNewline,
  };
}

function fileDiff(change) {
  const beforeBuffer = change.before ? fs.readFileSync(change.before.blobPath) : Buffer.alloc(0);
  const afterBuffer = change.after ? fs.readFileSync(change.after.blobPath) : Buffer.alloc(0);
  const beforeText = decodeText(beforeBuffer);
  const afterText = decodeText(afterBuffer);
  const beforeLabel = change.before ? `a/${change.path}` : '/dev/null';
  const afterLabel = change.after ? `b/${change.path}` : '/dev/null';
  const header = [
    `diff --atlas ${beforeLabel} ${afterLabel}`,
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
  ];

  if (beforeText === null || afterText === null) {
    return [
      ...header,
      `Binary content changed (before=${change.before?.contentHash ?? 'absent'}, after=${change.after?.contentHash ?? 'absent'})`,
    ].join('\n');
  }

  const before = splitText(beforeText);
  const after = splitText(afterText);
  header.push(`@@ -1,${before.lines.length} +1,${after.lines.length} @@`);
  for (const line of before.lines) header.push(`-${line}`);
  if (before.lines.length && !before.hasFinalNewline) header.push('\\ No newline at end of file');
  for (const line of after.lines) header.push(`+${line}`);
  if (after.lines.length && !after.hasFinalNewline) header.push('\\ No newline at end of file');
  return header.join('\n');
}

export function buildCompleteDiff(changes) {
  const diffText = changes.map(fileDiff).join('\n\n') + (changes.length ? '\n' : '');
  return {
    diffText,
    diffHash: sha256Buffer(Buffer.from(diffText, 'utf8')),
  };
}
