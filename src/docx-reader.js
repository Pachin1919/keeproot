import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { locateContentPython } from './python-runtime.js';

export function readDocxBytes(bytes, { sha256, installationRoot, pythonPath, pythonSourceRoot = fileURLToPath(new URL('../python/src/', import.meta.url)) } = {}) {
  const fail = message => Object.assign(new Error(message), { code: 'ATLAS_STATE_CONFLICT' });
  const executable = pythonPath ?? locateContentPython({ installationRoot });
  if (!executable || !fs.existsSync(executable)) throw Object.assign(new Error('DOCX reading requires the Atlas Python component.'), { code: 'ATLAS_CAPABILITY_UNAVAILABLE' });
  const result = spawnSync(executable, ['-m', 'atlas_content', 'docx-read'], {
    input: bytes, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: pythonSourceRoot, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    cwd: path.resolve(pythonSourceRoot, '..'),
  });
  if (result.error || result.status !== 0) throw fail('DOCX package could not be read within the supported format and limits.');
  let document;
  try { document = JSON.parse(result.stdout); } catch { throw fail('DOCX reader returned an invalid document.'); }
  if (document.schema !== 'atlas.docx-reader.v1' || document.sha256 !== sha256 || !Array.isArray(document.blocks) || document.blocks.length > 1000
    || typeof document.truncated !== 'boolean' || !Array.isArray(document.warnings)
    || document.warnings.some(value => !['floating_objects', 'headers_footers', 'nested_tables', 'merged_cells', 'unsupported_blocks'].includes(value))) throw fail('DOCX reader returned inconsistent document facts.');
  let characters = 0, cells = 0;
  const text = value => { if (typeof value !== 'string') throw fail('DOCX text is invalid.'); characters += Array.from(value).length; };
  for (const block of document.blocks) {
    if (block.kind === 'paragraph' && Number.isInteger(block.heading) && block.heading >= 0 && block.heading <= 6) text(block.text);
    else if (block.kind === 'table' && Array.isArray(block.rows) && block.rows.length <= 1000) {
      for (const row of block.rows) { if (!Array.isArray(row) || row.length > 100) throw fail('DOCX table exceeds the reading limit.'); for (const value of row) { text(value); cells++; } }
    } else throw fail('DOCX block is unsupported.');
  }
  if (characters !== document.characters || characters > 200000 || cells > 10000) throw fail('DOCX document exceeds the reading limit.');
  return document;
}
