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

const DIFF_CONTEXT_LINES = 3;
const MAX_LCS_CELLS = 4_000_000;

function fallbackOperations(beforeLines, afterLines) {
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) {
    suffix += 1;
  }
  return [
    ...beforeLines.slice(0, prefix).map((line, index) => ({ type: 'equal', line, oldIndex: index, newIndex: index })),
    ...beforeLines.slice(prefix, beforeLines.length - suffix)
      .map((line, offset) => ({ type: 'delete', line, oldIndex: prefix + offset, newIndex: null })),
    ...afterLines.slice(prefix, afterLines.length - suffix)
      .map((line, offset) => ({ type: 'insert', line, oldIndex: null, newIndex: prefix + offset })),
    ...beforeLines.slice(beforeLines.length - suffix).map((line, offset) => ({
      type: 'equal',
      line,
      oldIndex: beforeLines.length - suffix + offset,
      newIndex: afterLines.length - suffix + offset,
    })),
  ];
}

function lineOperations(beforeLines, afterLines) {
  const rows = beforeLines.length + 1;
  const columns = afterLines.length + 1;
  if (rows * columns > MAX_LCS_CELLS) return fallbackOperations(beforeLines, afterLines);
  const table = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex][afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? table[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(table[beforeIndex + 1][afterIndex], table[beforeIndex][afterIndex + 1]);
    }
  }
  const operations = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (beforeIndex < beforeLines.length && afterIndex < afterLines.length
      && beforeLines[beforeIndex] === afterLines[afterIndex]) {
      operations.push({
        type: 'equal', line: beforeLines[beforeIndex], oldIndex: beforeIndex, newIndex: afterIndex,
      });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (afterIndex >= afterLines.length
      || (beforeIndex < beforeLines.length
        && table[beforeIndex + 1][afterIndex] >= table[beforeIndex][afterIndex + 1])) {
      operations.push({ type: 'delete', line: beforeLines[beforeIndex], oldIndex: beforeIndex, newIndex: null });
      beforeIndex += 1;
    } else {
      operations.push({ type: 'insert', line: afterLines[afterIndex], oldIndex: null, newIndex: afterIndex });
      afterIndex += 1;
    }
  }
  return operations;
}

function accountForFinalNewline(operations, before, after) {
  if (before.hasFinalNewline === after.hasFinalNewline || !before.lines.length || !after.lines.length) {
    return operations;
  }
  const finalEqual = operations.findLastIndex((operation) => (
    operation.type === 'equal'
    && operation.oldIndex === before.lines.length - 1
    && operation.newIndex === after.lines.length - 1
  ));
  if (finalEqual < 0) return operations;
  const line = operations[finalEqual].line;
  return operations.toSpliced(
    finalEqual,
    1,
    { type: 'delete', line, oldIndex: before.lines.length - 1, newIndex: null },
    { type: 'insert', line, oldIndex: null, newIndex: after.lines.length - 1 },
  );
}

function numberedOperations(operations) {
  let oldLine = 1;
  let newLine = 1;
  return operations.map((operation) => {
    const numbered = { ...operation, oldLine, newLine };
    if (operation.type !== 'insert') oldLine += 1;
    if (operation.type !== 'delete') newLine += 1;
    return numbered;
  });
}

function unifiedHunks(operations, before, after) {
  const changed = operations
    .map((operation, index) => operation.type === 'equal' ? null : index)
    .filter((index) => index !== null);
  if (!changed.length) return [];
  const hunks = [];
  let cursor = 0;
  while (cursor < changed.length) {
    const firstChange = changed[cursor];
    let lastChange = firstChange;
    while (cursor + 1 < changed.length
      && changed[cursor + 1] - lastChange <= (DIFF_CONTEXT_LINES * 2) + 1) {
      cursor += 1;
      lastChange = changed[cursor];
    }
    const start = Math.max(0, firstChange - DIFF_CONTEXT_LINES);
    const end = Math.min(operations.length, lastChange + DIFF_CONTEXT_LINES + 1);
    const slice = operations.slice(start, end);
    const oldCount = slice.filter((operation) => operation.type !== 'insert').length;
    const newCount = slice.filter((operation) => operation.type !== 'delete').length;
    const oldStart = slice[0]?.oldLine ?? 1;
    const newStart = slice[0]?.newLine ?? 1;
    const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
    for (const operation of slice) {
      const prefix = operation.type === 'equal' ? ' ' : operation.type === 'delete' ? '-' : '+';
      lines.push(`${prefix}${operation.line}`);
      if (operation.type === 'delete' && operation.oldIndex === before.lines.length - 1
        && !before.hasFinalNewline) lines.push('\\ No newline at end of file');
      if (operation.type === 'insert' && operation.newIndex === after.lines.length - 1
        && !after.hasFinalNewline) lines.push('\\ No newline at end of file');
    }
    hunks.push(lines.join('\n'));
    cursor += 1;
  }
  return hunks;
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
  const operations = numberedOperations(accountForFinalNewline(
    lineOperations(before.lines, after.lines), before, after,
  ));
  const hunks = unifiedHunks(operations, before, after);
  if (!hunks.length && beforeText !== afterText) header.push('Text encoding or line endings changed.');
  else header.push(...hunks);
  return header.join('\n');
}

export function buildCompleteDiff(changes) {
  const diffText = changes.map(fileDiff).join('\n\n') + (changes.length ? '\n' : '');
  return {
    diffText,
    diffHash: sha256Buffer(Buffer.from(diffText, 'utf8')),
  };
}
