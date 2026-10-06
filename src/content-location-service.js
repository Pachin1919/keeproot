import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { contentFileFingerprint, contentFilePath } from './content-inspection.js';
import { locateContentPython } from './python-runtime.js';
import { projectDirectory, projectPath } from './ui/project-files.js';

const MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_PDF_PAGE_CODEPOINTS = 100_000;
const PDF_TEXT_PROFILE = 'atlas.pdf-page-text.v1';
const PDF_SPATIAL_PROFILE = 'atlas.pdf-spatial.v1';
const MAX_PDF_SPATIAL_TEXT_CODEPOINTS = 1200;
const MAX_PDF_TABLES = 20;
const MAX_PDF_TABLE_CELLS = 100;
const MAX_DOCX_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_LOCATIONS = 2_000;
const MAX_DOCX_TEXT_CHARS = 1_200;
const MAX_XLSX_BYTES = 64 * 1024 * 1024;
const MAX_XLSX_CELLS = 50;
const MAX_XLSX_CELL_TEXT = 1_200;
const MAX_CSV_ROW_BYTES = 256 * 1024;
const CSV_ROW_SHEET = '__ATLAS_CSV_SINGLE_TABLE_V1_RESERVED__';
const MAX_PNG_BYTES = 25 * 1024 * 1024;
const MAX_PNG_DIMENSION = 50_000;
const MAX_PNG_PIXELS = 100_000_000;
const DECODER = new TextDecoder('utf-8', { fatal: true });
const DEFAULT_PYTHON_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'python', 'src');

function conflict(message) {
  const error = new Error(message); error.code = 'ATLAS_STATE_CONFLICT'; return error;
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function pdfTableStructureHash(extracted) {
  return sha256(Buffer.from(JSON.stringify({ bbox: extracted.bbox,
    cells: extracted.cells.map(({ row, column, text_sha256: textHash }) => ({ row, column, text_sha256: textHash })) }), 'utf8'));
}
function pngHeader(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13
    || bytes.toString('ascii', 12, 16) !== 'IHDR') throw conflict('The Resource does not contain a valid PNG header.');
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (!width || !height || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION || width * height > MAX_PNG_PIXELS) {
    throw conflict('PNG dimensions exceed the supported image limits.');
  }
  return { width, height };
}
function b64(value) { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function unb64(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw conflict('Content reference or page cursor is invalid.');
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw conflict('Content reference or page cursor is invalid.'); }
}

function normalizeXlsxCell(value) {
  if (typeof value !== 'string') throw conflict('XLSX cell must use a valid A1 coordinate.');
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/u.exec(value.trim().toUpperCase());
  if (!match) throw conflict('XLSX cell must use a valid A1 coordinate.');
  let column = 0;
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
  if (column > 16_384 || Number(match[2]) > 1_048_576) {
    throw conflict('XLSX cell coordinate exceeds the supported worksheet bounds.');
  }
  return `${match[1]}${match[2]}`;
}

function headingValue(line) { return line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u); }
function fenceValue(line) { return line.match(/^ {0,3}(`{3,}|~{3,})/u); }
function unsupportedLine(line) {
  return /^ {0,3}(?:>|[-*+]\s|\d+[.)]\s|(?:---+|\*\*\*+|___+)$|<\w|\$\$)/u.test(line) || /^\s*\|.*\|\s*$/u.test(line);
}

function parseBlocks(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const blocks = []; let paragraph = []; let paragraphStart = 0; let fenced = null; let unsupportedCount = 0;
  const flush = () => {
    if (!paragraph.length) return;
    const raw = paragraph.join('\n');
    blocks.push({ kind: 'paragraph', start_line: paragraphStart, end_line: paragraphStart + paragraph.length - 1, raw, text: raw });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]; const lineNumber = index + 1;
    if (fenced) {
      if (new RegExp(`^ {0,3}${fenced.marker[0]}{${fenced.marker.length},}\\s*$`, 'u').test(line)) fenced = null;
      continue;
    }
    const fence = fenceValue(line);
    if (fence) { flush(); fenced = { marker: fence[1] }; unsupportedCount += 1; continue; }
    if (!line.trim()) { flush(); continue; }
    const heading = headingValue(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, start_line: lineNumber, end_line: lineNumber,
        raw: line, text: heading[2].trim() });
      continue;
    }
    if (unsupportedLine(line)) { flush(); unsupportedCount += 1; continue; }
    if (!paragraph.length) paragraphStart = lineNumber;
    paragraph.push(line);
  }
  flush();
  return { blocks, unsupported_count: unsupportedCount };
}

export class ContentLocationService {
  constructor({ registry, resourceControl, pythonPath = null, pythonSourceRoot = DEFAULT_PYTHON_SOURCE_ROOT, installationRoot = null }) {
    if (!registry || !resourceControl) throw new Error('Content location requires Registry and ResourceControl.');
    this.registry = registry; this.resourceControl = resourceControl;
    this.pythonPath = pythonPath; this.pythonSourceRoot = path.resolve(pythonSourceRoot); this.installationRoot = installationRoot;
  }

  #current(projectId, resourceId) {
    let detail;
    try { detail = this.registry.show(projectId); } catch { throw conflict('The Project is unavailable.'); }
    if (!detail.project || detail.project.status !== 'active' || !detail.location?.root_path) throw conflict('Content location requires an active Project with an attached Root.');
    let fact;
    try { fact = this.resourceControl.projectResource(projectId, resourceId); } catch { throw conflict('The Resource is not registered in this Project.'); }
    const active = (fact.locations ?? []).filter((item) => item.project_id === projectId && item.status === 'active');
    if (active.length !== 1) throw conflict('Content location requires exactly one active Resource location in this Project.');
    const root = projectDirectory(detail.location);
    const registeredPath = path.resolve(active[0].path);
    const relative = path.relative(root, registeredPath);
    let checked;
    try {
      checked = projectPath(root, relative);
      checked = contentFilePath(checked);
    } catch { throw conflict('The Resource path is outside the Project or passes through a link.'); }
    const extension = path.extname(checked).toLowerCase();
    if (path.resolve(checked) !== registeredPath || !['.md', '.pdf', '.docx', '.xlsx', '.csv', '.png'].includes(extension)) {
      throw conflict('Content location supports only registered Markdown, PDF, DOCX, XLSX, CSV row identity, or PNG Resources inside this Project.');
    }
    let before;
    try { before = fs.lstatSync(checked); } catch { throw conflict('The registered Markdown Resource is unavailable.'); }
    const maxBytes = extension === '.pdf' ? MAX_PDF_BYTES : ['.docx', '.xlsx'].includes(extension) ? MAX_DOCX_BYTES
      : extension === '.png' ? MAX_PNG_BYTES : MAX_FILE_BYTES;
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw conflict(`Resource must be a regular file no larger than ${maxBytes} bytes.`);
    let bytes = null; let text = null; let fileHash; let image = null;
    try {
      if (extension === '.md') {
        bytes = fs.readFileSync(checked);
        text = DECODER.decode(bytes);
        fileHash = sha256(bytes);
      } else if (extension === '.png') {
        bytes = fs.readFileSync(checked);
        image = pngHeader(bytes);
        fileHash = sha256(bytes);
      } else {
        fileHash = contentFileFingerprint(checked).sha256;
      }
    } catch (error) {
      if (extension === '.md' && error instanceof TypeError) throw conflict('The registered Markdown Resource is not valid UTF-8.');
      if (error.code === 'ATLAS_CONTENT_INPUT_MISSING') throw conflict('The registered file is unavailable.');
      throw error;
    }
    let after;
    try { contentFilePath(checked); after = fs.lstatSync(checked); } catch { throw conflict('The Markdown Resource changed during the read.'); }
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || (bytes && bytes.length !== after.size)) {
      throw conflict('The Markdown Resource changed during the read.');
    }
    return { project_id: projectId, resource_id: resourceId, path: checked,
      relative_path: relative.replaceAll('\\', '/'), sha256: fileHash, bytes: before.size,
      registered_sha256: active[0].content_hash ?? null, text, extension, file_hash: fileHash,
      image,
      byte_length: before.size, stat: { dev: before.dev, ino: before.ino, mtime_ms: before.mtimeMs } };
  }

  #verifyPdfSnapshot(current, { verifyHash = true } = {}) {
    try {
      const checked = contentFilePath(current.path);
      const stat = fs.lstatSync(checked);
      const fingerprint = verifyHash ? contentFileFingerprint(checked) : null;
      if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== current.stat.dev || stat.ino !== current.stat.ino
        || stat.size !== current.byte_length || stat.mtimeMs !== current.stat.mtime_ms
        || (fingerprint && fingerprint.sha256 !== current.sha256)) {
        throw conflict('PDF changed during local page extraction; retry with the current file.');
      }
    } catch (error) {
      if (error.code === 'ATLAS_STATE_CONFLICT') throw error;
      throw conflict('The PDF Resource became unavailable during page extraction.');
    }
  }

  #extractPdf(current) {
    if (current.byte_length > MAX_PDF_BYTES) throw conflict(`PDF Resource must not exceed ${MAX_PDF_BYTES} bytes.`);
    this.#verifyPdfSnapshot(current, { verifyHash: false });
    const executable = this.pythonPath ?? locateContentPython({ installationRoot: this.installationRoot });
    if (!executable) {
      const error = new Error('PDF page location requires the installed Atlas Python PDF component.');
      error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
      throw error;
    }
    const result = spawnSync(executable, ['-m', 'atlas_content', 'pdf-pages', '--file', current.path,
      '--expected-sha256', current.sha256], {
      cwd: path.resolve(this.pythonSourceRoot, '..', '..'),
      env: { ...process.env, PYTHONPATH: [this.pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      try {
        if (contentFileFingerprint(current.path).sha256 !== current.sha256) throw conflict('PDF changed during local page extraction; retry with the current file.');
      } catch (error) { if (error.code === 'ATLAS_STATE_CONFLICT') throw error; }
      throw new Error(`Atlas PDF page extraction failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
    }
    let extracted;
    try { extracted = JSON.parse(result.stdout.trim()); }
    catch { throw new Error('Atlas PDF page extraction returned invalid JSON.'); }
    if (extracted.schema !== 'atlas.pdf-page-location.v1' || extracted.file_sha256 !== current.sha256
      || !Number.isInteger(extracted.page_count) || extracted.page_count < 0 || extracted.page_count > MAX_PDF_PAGES
      || !Array.isArray(extracted.pages) || extracted.pages.length !== extracted.page_count) {
      throw conflict('PDF changed during extraction or exceeded the page-location limits.');
    }
    this.#verifyPdfSnapshot(current);
    return extracted;
  }

  #extractPdfTextSpan(current, { page, startCodepoint = 0 }) {
    if (!Number.isInteger(page) || page < 1 || page > MAX_PDF_PAGES || !Number.isInteger(startCodepoint) || startCodepoint < 0) {
      throw conflict('PDF page or text continuation offset is invalid.');
    }
    if (current.byte_length > MAX_PDF_BYTES) throw conflict(`PDF Resource must not exceed ${MAX_PDF_BYTES} bytes.`);
    this.#verifyPdfSnapshot(current, { verifyHash: false });
    const executable = this.pythonPath ?? locateContentPython({ installationRoot: this.installationRoot });
    if (!executable) {
      const error = new Error('PDF text continuation requires the installed Atlas Python PDF component.');
      error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
      throw error;
    }
    const result = spawnSync(executable, ['-m', 'atlas_content', 'pdf-page-text', '--file', current.path,
      '--expected-sha256', current.sha256, '--page', String(page), '--start-codepoint', String(startCodepoint)], {
      cwd: path.resolve(this.pythonSourceRoot, '..', '..'),
      env: { ...process.env, PYTHONPATH: [this.pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      try { if (contentFileFingerprint(current.path).sha256 !== current.sha256) throw conflict('PDF changed during page text extraction; retry with the current file.'); }
      catch (error) { if (error.code === 'ATLAS_STATE_CONFLICT') throw error; }
      throw conflict(`PDF page text extraction failed or the request exceeded its bounds: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
    }
    let extracted;
    try { extracted = JSON.parse(result.stdout.trim()); }
    catch { throw conflict('PDF page text extraction returned invalid JSON.'); }
    if (extracted.schema !== 'atlas.pdf-page-text.v1' || extracted.file_sha256 !== current.sha256
      || extracted.page !== page || !Number.isInteger(extracted.page_count) || extracted.page_count < page
      || extracted.page_count > MAX_PDF_PAGES || typeof extracted.pypdf_version !== 'string'
      || extracted.extraction_profile !== PDF_TEXT_PROFILE
      || !['text_layer', 'image_only', 'empty_or_vector', 'extraction_failed'].includes(extracted.status)
      || extracted.ocr_used !== false || extracted.spatial_mapping !== 'unsupported'
      || extracted.table_structure !== 'unsupported' || extracted.reading_order !== 'unverified') {
      throw conflict('PDF changed during text extraction or returned unsupported page facts.');
    }
    if (extracted.status === 'text_layer') {
      const codepoints = typeof extracted.text === 'string' ? Array.from(extracted.text).length : -1;
      if (codepoints < 0 || codepoints > 1200 || extracted.end_codepoint - extracted.start_codepoint !== codepoints
        || extracted.start_codepoint !== startCodepoint || !Number.isInteger(extracted.text_codepoints)
        || extracted.text_codepoints < extracted.end_codepoint || extracted.text_codepoints > MAX_PDF_PAGE_CODEPOINTS
        || !/^[a-f0-9]{64}$/u.test(extracted.page_text_sha256 ?? '') || !/^[a-f0-9]{64}$/u.test(extracted.segment_sha256 ?? '')
        || sha256(Buffer.from(extracted.text, 'utf8')) !== extracted.segment_sha256
        || (extracted.next_codepoint !== null && extracted.next_codepoint !== extracted.end_codepoint)) {
        throw conflict('PDF text segment is malformed or exceeded the 1200 codepoint slice limit.');
      }
    } else if (extracted.text !== null || extracted.next_codepoint !== null || startCodepoint !== 0) {
      throw conflict('Unavailable PDF page text cannot be continued.');
    }
    this.#verifyPdfSnapshot(current);
    return extracted;
  }

  #locatePdfTextSpan(current, { page, cursor = null }) {
    let startCodepoint = 0; let cursorFacts = null;
    if (cursor) {
      cursorFacts = unb64(cursor);
      if (cursorFacts.version !== 2 || cursorFacts.format !== 'pdf_text_span' || cursorFacts.project_id !== current.project_id
        || cursorFacts.resource_id !== current.resource_id || cursorFacts.file_sha256 !== current.sha256
        || cursorFacts.page !== page || !Number.isInteger(cursorFacts.start_codepoint) || cursorFacts.start_codepoint < 0
        || !/^[a-f0-9]{64}$/u.test(cursorFacts.page_text_sha256 ?? '') || typeof cursorFacts.pypdf_version !== 'string'
        || cursorFacts.extraction_profile !== PDF_TEXT_PROFILE) {
        throw conflict('The PDF or text continuation cursor changed; start that page again.');
      }
      startCodepoint = cursorFacts.start_codepoint;
    }
    const extracted = this.#extractPdfTextSpan(current, { page, startCodepoint });
    if (cursorFacts && (cursorFacts.page_text_sha256 !== extracted.page_text_sha256
      || cursorFacts.pypdf_version !== extracted.pypdf_version || extracted.status !== 'text_layer')) {
      throw conflict('The PDF text changed; start that page again.');
    }
    const common = { schema: 'atlas.content-location.v1', format: 'pdf', location_kind: 'pdf_text_span', project_id: current.project_id,
      resource_id: current.resource_id, relative_path: current.relative_path,
      file: { sha256: current.sha256, bytes: current.bytes, registered_sha256: current.registered_sha256,
        registration_status: current.registered_sha256 === current.sha256 ? 'current' : 'changed' },
      page, page_count: extracted.page_count, status: extracted.status, basis: extracted.basis,
      reading_order: extracted.reading_order, spatial_mapping: extracted.spatial_mapping,
      table_structure: extracted.table_structure, ocr_used: extracted.ocr_used,
      source_text_accuracy: extracted.source_text_accuracy, pypdf_version: extracted.pypdf_version,
      extraction_profile: extracted.extraction_profile };
    if (extracted.status !== 'text_layer') return { ...common, text: null, ref: null, href: null,
      next_cursor: null, start_codepoint: null, end_codepoint: null };
    const ref = b64({ version: 2, format: 'pdf_text_span', project_id: current.project_id, resource_id: current.resource_id,
      file_sha256: current.sha256, page, pypdf_version: extracted.pypdf_version, extraction_profile: extracted.extraction_profile,
      page_text_sha256: extracted.page_text_sha256, start_codepoint: extracted.start_codepoint,
      end_codepoint: extracted.end_codepoint, segment_sha256: extracted.segment_sha256 });
    const nextCursor = extracted.next_codepoint == null ? null : b64({ version: 2, format: 'pdf_text_span',
      project_id: current.project_id, resource_id: current.resource_id, file_sha256: current.sha256, page,
      pypdf_version: extracted.pypdf_version, extraction_profile: extracted.extraction_profile,
      page_text_sha256: extracted.page_text_sha256, start_codepoint: extracted.next_codepoint });
    return { ...common, text: extracted.text, text_codepoints: extracted.text_codepoints,
      page_text_sha256: extracted.page_text_sha256, segment_sha256: extracted.segment_sha256,
      start_codepoint: extracted.start_codepoint, end_codepoint: extracted.end_codepoint,
      ref, href: `/projects/${encodeURIComponent(current.project_id)}/content-location?ref=${encodeURIComponent(ref)}`,
      next_cursor: nextCursor };
  }

  #extractPdfSpatial(current, options) {
    this.#verifyPdfSnapshot(current, { verifyHash: false });
    const executable = this.pythonPath ?? locateContentPython({ installationRoot: this.installationRoot });
    if (!executable) {
      const error = new Error('PDF spatial location requires the Atlas PDF spatial component.');
      error.code = 'ATLAS_CAPABILITY_UNAVAILABLE'; throw error;
    }
    const command = options.mode === 'region' ? 'pdf-region' : 'pdf-tables';
    const args = ['-m', 'atlas_content', command, '--file', current.path, '--expected-sha256', current.sha256,
      '--page', String(options.page)];
    if (options.mode === 'region') args.push('--x', String(options.x), '--y', String(options.y), '--width', String(options.width), '--height', String(options.height));
    else if (options.tableIndex != null) args.push('--table-index', String(options.tableIndex));
    const result = spawnSync(executable, args, { cwd: path.resolve(this.pythonSourceRoot, '..', '..'),
      env: { ...process.env, PYTHONPATH: [this.pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      try { if (contentFileFingerprint(current.path).sha256 !== current.sha256) throw conflict('PDF changed during spatial extraction; retry with the current file.'); }
      catch (error) { if (error.code === 'ATLAS_STATE_CONFLICT') throw error; }
      throw conflict(`PDF spatial extraction failed or exceeded its bounds: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
    }
    let extracted;
    try { extracted = JSON.parse(result.stdout.trim()); } catch { throw conflict('PDF spatial extraction returned invalid JSON.'); }
    if (extracted.schema !== 'atlas.pdf-spatial.v1' || extracted.file_sha256 !== current.sha256
      || extracted.page !== options.page || !Number.isInteger(extracted.page_count) || extracted.page_count < options.page
      || extracted.page_count > MAX_PDF_PAGES || extracted.profile !== PDF_SPATIAL_PROFILE
      || typeof extracted.pdfplumber_version !== 'string') throw conflict('PDF changed during spatial extraction or returned invalid facts.');
    if (options.mode === 'region') {
      if (extracted.mode !== 'region' || !['text_layer', 'empty_region', 'text_truncated'].includes(extracted.status)
        || !Array.isArray(extracted.bbox) || extracted.bbox.length !== 4) throw conflict('PDF region result is malformed.');
      if (extracted.status !== 'text_truncated' && (typeof extracted.text !== 'string'
        || Array.from(extracted.text).length > MAX_PDF_SPATIAL_TEXT_CODEPOINTS
        || sha256(Buffer.from(extracted.text, 'utf8')) !== extracted.text_sha256)) throw conflict('PDF region text hash or bound is invalid.');
    } else if (options.tableIndex == null) {
      if (extracted.mode !== 'tables' || !['tables_found', 'no_tables', 'table_limit_exceeded'].includes(extracted.status)
        || !Array.isArray(extracted.tables) || extracted.tables.length > MAX_PDF_TABLES) throw conflict('PDF table list is malformed.');
    } else if (extracted.mode !== 'table' || !['table_cells', 'cell_limit_exceeded'].includes(extracted.status)
      || !Array.isArray(extracted.cells) || extracted.cells.length > MAX_PDF_TABLE_CELLS) throw conflict('PDF table cell result is malformed.');
    this.#verifyPdfSnapshot(current);
    return extracted;
  }

  #pdfSpatialCommon(current, extracted, locationKind) {
    return { schema: 'atlas.content-location.v1', format: 'pdf', location_kind: locationKind,
      project_id: current.project_id, resource_id: current.resource_id, relative_path: current.relative_path,
      file: { sha256: current.sha256, bytes: current.bytes, registered_sha256: current.registered_sha256,
        registration_status: current.registered_sha256 === current.sha256 ? 'current' : 'changed' },
      page: extracted.page, page_count: extracted.page_count, pdfplumber_version: extracted.pdfplumber_version,
      profile: extracted.profile, reading_order: extracted.reading_order ?? 'unverified',
      spatial_accuracy: extracted.spatial_accuracy ?? 'unverified' };
  }

  #locatePdfRegion(current, { page, x, y, width, height }) {
    if (!Number.isInteger(page) || page < 1 || page > MAX_PDF_PAGES
      || ![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0) {
      throw conflict('PDF region requires a page and four valid non-negative integer point coordinates.');
    }
    const extracted = this.#extractPdfSpatial(current, { mode: 'region', page, x, y, width, height });
    const common = this.#pdfSpatialCommon(current, extracted, 'pdf_region');
    if (extracted.status === 'text_truncated') return { ...common, status: extracted.status,
      bbox: extracted.bbox, text: extracted.text, text_truncated: true, ref: null, href: null };
    const ref = b64({ version: 3, format: 'pdf_region', project_id: current.project_id, resource_id: current.resource_id,
      file_sha256: current.sha256, page, bbox: extracted.bbox, pdfplumber_version: extracted.pdfplumber_version,
      profile: extracted.profile, text_sha256: extracted.text_sha256 });
    return { ...common, status: extracted.status, bbox: extracted.bbox, text: extracted.text,
      text_sha256: extracted.text_sha256, text_truncated: false, ref,
      href: `/projects/${encodeURIComponent(current.project_id)}/content-location?ref=${encodeURIComponent(ref)}` };
  }

  #locatePdfTables(current, { page, tableIndex = null, tables = false }) {
    if (!Number.isInteger(page) || page < 1 || page > MAX_PDF_PAGES) throw conflict('PDF table lookup requires a valid page number.');
    const extracted = this.#extractPdfSpatial(current, { mode: tableIndex == null ? 'tables' : 'table', page, tableIndex });
    if (tableIndex == null) return { ...this.#pdfSpatialCommon(current, extracted, 'pdf_tables'), status: extracted.status,
      tables: extracted.tables, tables_truncated: extracted.status === 'table_limit_exceeded' };
    const common = this.#pdfSpatialCommon(current, extracted, 'pdf_table');
    if (extracted.status === 'cell_limit_exceeded') return { ...common, status: extracted.status,
      table_index: tableIndex, bbox: extracted.bbox, cells: [], cells_truncated: true };
    const tableStructureSha256 = pdfTableStructureHash(extracted);
    const cells = extracted.cells.map((cell) => {
      if (cell.text_truncated || Array.from(cell.text ?? '').length > MAX_PDF_SPATIAL_TEXT_CODEPOINTS) {
        return { ...cell, ref: null, href: null };
      }
      const ref = b64({ version: 3, format: 'pdf_table_cell', project_id: current.project_id, resource_id: current.resource_id,
        file_sha256: current.sha256, page, table_index: tableIndex, bbox: extracted.bbox,
        table_structure_sha256: tableStructureSha256,
        row: cell.row, column: cell.column, pdfplumber_version: extracted.pdfplumber_version,
        profile: extracted.profile, text_sha256: cell.text_sha256 });
      return { ...cell, ref, href: `/projects/${encodeURIComponent(current.project_id)}/content-location?ref=${encodeURIComponent(ref)}` };
    });
    return { ...common, status: extracted.status, table_index: tableIndex, bbox: extracted.bbox, cells,
      table_structure_sha256: tableStructureSha256,
      table_structure: extracted.table_structure };
  }

  #extractDocx(current) {
    if (current.byte_length > MAX_DOCX_BYTES) throw conflict(`DOCX Resource must not exceed ${MAX_DOCX_BYTES} bytes.`);
    const executable = this.pythonPath ?? locateContentPython({ installationRoot: this.installationRoot });
    if (!executable) {
      const error = new Error('DOCX location requires the installed Atlas Python component.');
      error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
      throw error;
    }
    const result = spawnSync(executable, ['-m', 'atlas_content', 'docx-locations', '--file', current.path,
      '--expected-sha256', current.sha256], {
      cwd: path.resolve(this.pythonSourceRoot, '..', '..'),
      env: { ...process.env, PYTHONPATH: [this.pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      try { if (contentFileFingerprint(current.path).sha256 !== current.sha256) throw conflict('DOCX changed during location extraction; retry with the current file.'); }
      catch (error) { if (error.code === 'ATLAS_STATE_CONFLICT') throw error; }
      throw new Error(`Atlas DOCX location extraction failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
    }
    let extracted;
    try { extracted = JSON.parse(result.stdout.trim()); }
    catch { throw new Error('Atlas DOCX location extraction returned invalid JSON.'); }
    if (extracted.schema !== 'atlas.docx-location.v1' || extracted.file_sha256 !== current.sha256
      || !Array.isArray(extracted.locations) || extracted.locations.length > MAX_DOCX_LOCATIONS
      || extracted.location_count !== extracted.locations.length
      || extracted.locations.some((item) => !['paragraph', 'table_cell'].includes(item.kind)
        || typeof item.text !== 'string' || item.text.length > MAX_DOCX_TEXT_CHARS
        || !/^[a-f0-9]{64}$/u.test(item.text_sha256 ?? '') || typeof item.text_truncated !== 'boolean')) {
      throw conflict('DOCX changed during extraction or exceeded the location limits.');
    }
    const checked = this.#current(current.project_id, current.resource_id);
    if (checked.sha256 !== current.sha256 || checked.stat.ino !== current.stat.ino) throw conflict('DOCX changed during location extraction; retry with the current file.');
    return extracted;
  }

  #locateDocx(current, { limit, cursor }) {
    const extracted = this.#extractDocx(current);
    let offset = 0;
    if (cursor) {
      const decoded = unb64(cursor);
      if (decoded.version !== 1 || decoded.format !== 'docx' || decoded.project_id !== current.project_id
        || decoded.resource_id !== current.resource_id || decoded.file_sha256 !== current.sha256
        || !Number.isInteger(decoded.next_index) || decoded.next_index < 0 || decoded.next_index > extracted.locations.length) {
        throw conflict('The DOCX or location cursor changed; start the location list again.');
      }
      offset = decoded.next_index;
    }
    const items = extracted.locations.slice(offset, offset + limit).map((item) => {
      const coordinates = item.kind === 'paragraph' ? { paragraph_index: item.paragraph_index }
        : { table_index: item.table_index, row: item.row, column: item.column };
      const ref = b64({ version: 1, format: 'docx', project_id: current.project_id, resource_id: current.resource_id,
        file_sha256: current.sha256, kind: item.kind, ...coordinates, text_sha256: item.text_sha256 });
      return { ...item, ref, href: `/projects/${encodeURIComponent(current.project_id)}/content-location?ref=${encodeURIComponent(ref)}` };
    });
    const nextIndex = offset + items.length;
    return { schema: 'atlas.content-location.v1', format: 'docx', project_id: current.project_id,
      resource_id: current.resource_id, relative_path: current.relative_path,
      file: { sha256: current.sha256, bytes: current.bytes, registered_sha256: current.registered_sha256,
        registration_status: current.registered_sha256 === current.sha256 ? 'current' : 'changed' },
      total: extracted.location_count, items, limit,
      next_cursor: nextIndex < extracted.locations.length ? b64({ version: 1, format: 'docx', project_id: current.project_id,
        resource_id: current.resource_id, file_sha256: current.sha256, next_index: nextIndex }) : null,
      locations_truncated: extracted.locations_truncated, text_truncated_count: extracted.text_truncated_count,
      unsupported: extracted.unsupported, page_numbers_supported: false,
    };
  }

  #extractXlsx(current, { sheet = null, cell = null, limit = MAX_XLSX_CELLS } = {}) {
    if (current.byte_length > MAX_XLSX_BYTES) throw conflict(`XLSX Resource must not exceed ${MAX_XLSX_BYTES} bytes.`);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_XLSX_CELLS) throw new Error('XLSX cell sample limit must be between 1 and 50.');
    const executable = this.pythonPath ?? locateContentPython({ installationRoot: this.installationRoot });
    if (!executable) {
      const error = new Error('XLSX location requires the installed Atlas Python component.');
      error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
      throw error;
    }
    const args = ['-m', 'atlas_content', 'xlsx-locations', '--file', current.path, '--expected-sha256', current.sha256, '--limit', String(limit)];
    if (sheet != null) args.push('--sheet', sheet);
    if (cell != null) args.push('--cell', cell);
    const result = spawnSync(executable, args, {
      cwd: path.resolve(this.pythonSourceRoot, '..', '..'),
      env: { ...process.env, PYTHONPATH: [this.pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      try { if (contentFileFingerprint(current.path).sha256 !== current.sha256) throw conflict('XLSX changed during cell extraction; retry with the current file.'); }
      catch (error) { if (error.code === 'ATLAS_STATE_CONFLICT') throw error; }
      throw new Error(`Atlas XLSX location extraction failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
    }
    let extracted;
    try { extracted = JSON.parse(result.stdout.trim()); }
    catch { throw new Error('Atlas XLSX location extraction returned invalid JSON.'); }
    if (extracted.schema !== 'atlas.xlsx-location.v1' || extracted.file_sha256 !== current.sha256
      || !['workbook', 'sheet'].includes(extracted.mode) || !Number.isInteger(extracted.sheet_count)
      || !Array.isArray(extracted.sheets) || extracted.sheets.length > 50
      || extracted.sheets.some((item) => typeof item.name !== 'string' || !['visible', 'hidden', 'veryHidden'].includes(item.visibility)
        || !['available', 'missing_worksheet_part'].includes(item.status))
      || (extracted.mode === 'sheet' && (!Array.isArray(extracted.cells) || extracted.cells.length > MAX_XLSX_CELLS
        || !extracted.sheet || typeof extracted.sheet.name !== 'string'
        || extracted.cells.some((item) => typeof item.cell !== 'string' || !/^[A-Z]{1,3}[1-9][0-9]*$/u.test(item.cell)
          || !['value', 'empty', 'formula_cached', 'formula_no_cache', 'error', 'unavailable', 'merged_non_anchor'].includes(item.status)
          || (item.value != null && typeof item.value !== 'string')
          || (item.value_sha256 !== null && !/^[a-f0-9]{64}$/u.test(item.value_sha256 ?? ''))
          || typeof item.value_truncated !== 'boolean' || typeof item.formula_present !== 'boolean'
          || typeof item.formula_truncated !== 'boolean' || typeof item.merge_state !== 'string')))) {
      throw conflict('XLSX changed during extraction or exceeded the cell-location limits.');
    }
    const checked = this.#current(current.project_id, current.resource_id);
    if (checked.sha256 !== current.sha256 || checked.stat.ino !== current.stat.ino) throw conflict('XLSX changed during cell extraction; retry with the current file.');
    return extracted;
  }

  #locateXlsx(current, { sheet = null, cell = null, limit = MAX_XLSX_CELLS }) {
    if (cell != null && !sheet) throw conflict('Choose an exact Sheet before locating a cell.');
    const selectedCell = cell == null ? null : normalizeXlsxCell(cell);
    const extracted = this.#extractXlsx(current, { sheet, cell: selectedCell, limit });
    if (extracted.mode === 'workbook') return { schema: 'atlas.content-location.v1', format: 'xlsx',
      project_id: current.project_id, resource_id: current.resource_id, relative_path: current.relative_path,
      file: { sha256: current.sha256, bytes: current.bytes, registered_sha256: current.registered_sha256,
        registration_status: current.registered_sha256 === current.sha256 ? 'current' : 'changed' },
      sheet_count: extracted.sheet_count, sheets: extracted.sheets, sheets_truncated: extracted.sheets_truncated };
    const cells = extracted.cells.map((item) => {
      const ref = b64({ version: 1, format: 'xlsx', project_id: current.project_id, resource_id: current.resource_id,
        file_sha256: current.sha256, sheet: extracted.sheet.name, cell: item.cell, status: item.status,
        value_sha256: item.value_sha256, formula_present: item.formula_present, merge_state: item.merge_state });
      return { ...item, sheet: extracted.sheet.name, sheet_visibility: extracted.sheet.visibility,
        ref, href: `/projects/${encodeURIComponent(current.project_id)}/content-location?ref=${encodeURIComponent(ref)}` };
    });
    return { schema: 'atlas.content-location.v1', format: 'xlsx', project_id: current.project_id,
      resource_id: current.resource_id, relative_path: current.relative_path,
      file: { sha256: current.sha256, bytes: current.bytes, registered_sha256: current.registered_sha256,
        registration_status: current.registered_sha256 === current.sha256 ? 'current' : 'changed' },
      sheet_count: extracted.sheet_count, selected_sheet: extracted.sheet, cell: extracted.cell,
      sheets: extracted.sheets, sheets_truncated: extracted.sheets_truncated,
      cells, cells_truncated: extracted.cells_truncated, merged_ranges_truncated: extracted.merged_ranges_truncated,
      limit };
  }

  locateXlsxRow({ projectId, resourceId, sheet, row = null, key = null }) {
    const current = this.#current(projectId, resourceId);
    if (current.extension !== '.xlsx') throw conflict('Row property candidates require a registered XLSX Resource.');
    if (typeof sheet !== 'string' || !sheet.trim()) throw conflict('An exact XLSX Sheet is required.');
    if ((row == null) === (key == null)) throw conflict('Provide either an Excel row or a unique key locator.');
    const executable = this.pythonPath ?? locateContentPython({ installationRoot: this.installationRoot });
    if (!executable) { const error = new Error('XLSX row location requires the installed Atlas Python component.'); error.code = 'ATLAS_CAPABILITY_UNAVAILABLE'; throw error; }
    const args = ['-m', 'atlas_content', 'xlsx-row', '--file', current.path, '--expected-sha256', current.sha256, '--sheet', sheet];
    if (row != null) args.push('--row', String(row));
    else args.push('--key-column', String(key.column), '--key-value', String(key.value));
    const result = spawnSync(executable, args, { cwd: path.resolve(this.pythonSourceRoot, '..', '..'),
      env: { ...process.env, PYTHONPATH: [this.pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1_000_000 });
    if (result.error || result.status !== 0) {
      if (contentFileFingerprint(current.path).sha256 !== current.sha256) throw conflict('XLSX changed during row extraction.');
      throw conflict(result.stderr?.trim() || 'XLSX row identity is invalid or unavailable.');
    }
    let extracted;
    try { extracted = JSON.parse(result.stdout.trim()); } catch { throw conflict('XLSX row extraction returned invalid data.'); }
    const after = this.#current(projectId, resourceId);
    if (extracted.schema !== 'atlas.xlsx-row.v1' || extracted.file_sha256 !== current.sha256 || extracted.status !== 'available'
      || !Number.isInteger(extracted.row) || !/^[a-f0-9]{64}$/u.test(extracted.row_sha256 ?? '')
      || !Array.isArray(extracted.cells) || extracted.cells.length > 50 || after.sha256 !== current.sha256
      || after.stat.ino !== current.stat.ino || extracted.cells.some((item) => item.value_truncated || item.formula_truncated)) throw conflict('XLSX row changed or exceeded supported bounds.');
    return { project_id: projectId, resource_id: resourceId, relative_path: current.relative_path,
      file_sha256: current.sha256, sheet, row: extracted.row, row_sha256: extracted.row_sha256,
      key: extracted.key, cells: extracted.cells };
  }

  locateCsvRow({ projectId, resourceId, key, row = null, sheet = null }) {
    const current = this.#current(projectId, resourceId);
    if (current.extension !== '.csv') throw conflict('CSV row candidates require a registered CSV Resource.');
    if (row != null || sheet != null) throw conflict('CSV row identity uses a unique key and does not accept Sheet or row coordinates.');
    if (!key || typeof key.column !== 'string' || typeof key.value !== 'string') throw conflict('CSV row identity requires an exact key column and key value.');
    if (current.byte_length > MAX_CSV_ROW_BYTES) throw conflict('CSV Resource must not exceed 256 KiB.');
    const executable = this.pythonPath ?? locateContentPython({ installationRoot: this.installationRoot });
    if (!executable) { const error = new Error('CSV row location requires the installed Atlas Python component.'); error.code = 'ATLAS_CAPABILITY_UNAVAILABLE'; throw error; }
    const result = spawnSync(executable, ['-m', 'atlas_content', 'csv-row', '--file', current.path,
      '--expected-sha256', current.sha256, '--key-column', key.column, '--key-value', key.value], {
      cwd: path.resolve(this.pythonSourceRoot, '..', '..'),
      env: { ...process.env, PYTHONPATH: [this.pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      try { if (contentFileFingerprint(current.path).sha256 !== current.sha256) throw conflict('CSV changed during row extraction.'); }
      catch (error) { if (error.code === 'ATLAS_STATE_CONFLICT') throw error; }
      let message = result.stderr?.trim() || 'CSV row identity is invalid or unavailable.';
      try { message = JSON.parse(message).error ?? message; } catch { /* retain process error */ }
      throw conflict(message);
    }
    let extracted;
    try { extracted = JSON.parse(result.stdout.trim()); } catch { throw conflict('CSV row extraction returned invalid data.'); }
    const after = this.#current(projectId, resourceId);
    if (extracted.schema !== 'atlas.csv-row.v1' || extracted.status !== 'available' || extracted.format !== 'csv'
      || extracted.file_sha256 !== current.sha256 || extracted.key?.column !== key.column || extracted.key?.value !== key.value
      || !Number.isInteger(extracted.record_number) || extracted.record_number < 1
      || !Array.isArray(extracted.headers) || extracted.headers.length < 1 || extracted.headers.length > 50
      || !Array.isArray(extracted.cells) || extracted.cells.length !== extracted.headers.length
      || !/^[a-f0-9]{64}$/u.test(extracted.row_sha256 ?? '') || after.sha256 !== current.sha256
      || after.stat.ino !== current.stat.ino || extracted.cells.some((item, index) => item.column !== extracted.headers[index]
        || typeof item.value !== 'string' || item.value.length > MAX_XLSX_CELL_TEXT)) {
      throw conflict('CSV row changed or exceeded the supported header, record, or cell bounds.');
    }
    return { project_id: projectId, resource_id: resourceId, relative_path: current.relative_path,
      format: 'csv', sheet: null, file_sha256: current.sha256, record_number: extracted.record_number,
      row_sha256: extracted.row_sha256, key: extracted.key, headers: extracted.headers, cells: extracted.cells };
  }

  locateRow({ projectId, resourceId, sheet = null, row = null, key = null }) {
    const current = this.#current(projectId, resourceId);
    if (current.extension === '.csv') return this.locateCsvRow({ projectId, resourceId, sheet, row, key });
    if (current.extension === '.xlsx') return this.locateXlsxRow({ projectId, resourceId, sheet, row, key });
    throw conflict('Row property candidates support only registered CSV or XLSX Resources.');
  }

  #locatePng(current, { x = null, y = null, width = null, height = null }) {
    const provided = [x, y, width, height].some((value) => value !== null && value !== undefined);
    let region = null; let ref = null;
    const previewUrl = `/projects/${encodeURIComponent(current.project_id)}/resources/thumbnail?path=${encodeURIComponent(current.relative_path)}&expected_sha256=${current.sha256}`;
    if (provided) {
      if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1
        || x + width > current.image.width || y + height > current.image.height) {
        throw conflict('PNG region must be positive integer source pixels fully inside the image.');
      }
      region = { x, y, width, height, coordinate_space: 'source_pixels', origin: 'top_left' };
      ref = b64({ version: 1, format: 'png', project_id: current.project_id, resource_id: current.resource_id,
        file_sha256: current.sha256, image_width: current.image.width, image_height: current.image.height, region });
    }
    return { schema: 'atlas.content-location.v1', format: 'png', project_id: current.project_id,
      resource_id: current.resource_id, relative_path: current.relative_path,
      file: { sha256: current.sha256, bytes: current.byte_length, registered_sha256: current.registered_sha256,
        registration_status: current.registered_sha256 === current.sha256 ? 'current' : 'changed' },
      image: current.image, region, ref,
      href: ref ? `/projects/${encodeURIComponent(current.project_id)}/content-location?ref=${encodeURIComponent(ref)}` : null,
      preview_url: previewUrl };
  }

  #locatePdf(current, { limit, cursor }) {
    const extracted = this.#extractPdf(current);
    let offset = 0;
    if (cursor) {
      const decoded = unb64(cursor);
      if (decoded.version !== 1 || decoded.format !== 'pdf' || decoded.project_id !== current.project_id
        || decoded.resource_id !== current.resource_id || decoded.file_sha256 !== current.sha256
        || !Number.isInteger(decoded.next_index) || decoded.next_index < 0 || decoded.next_index > extracted.pages.length) {
        throw conflict('The PDF file or page reference cursor changed; start the page list again.');
      }
      offset = decoded.next_index;
    }
    const pages = extracted.pages.slice(offset, offset + limit).map((page) => {
      const ref = b64({ version: 1, format: 'pdf', project_id: current.project_id, resource_id: current.resource_id,
        file_sha256: current.sha256, page: page.page, status: page.status, text_sha256: page.text_sha256 });
      return { ...page, ref, href: `/projects/${encodeURIComponent(current.project_id)}/content-location?ref=${encodeURIComponent(ref)}` };
    });
    const nextIndex = offset + pages.length;
    return { schema: 'atlas.content-location.v1', format: 'pdf', project_id: current.project_id,
      resource_id: current.resource_id, relative_path: current.relative_path,
      file: { sha256: current.sha256, bytes: current.byte_length, registered_sha256: current.registered_sha256,
        registration_status: current.registered_sha256 === current.sha256 ? 'current' : 'changed' },
      page_count: extracted.page_count, pages, limit,
      next_cursor: nextIndex < extracted.pages.length ? b64({ version: 1, format: 'pdf', project_id: current.project_id,
        resource_id: current.resource_id, file_sha256: current.sha256, next_index: nextIndex }) : null,
      ocr_used: false,
    };
  }

  locate({ projectId, resourceId, limit = DEFAULT_LIMIT, cursor = null, sheet = null, cell = null, x = null, y = null, width = null, height = null, page = null, tables = false, tableIndex = null }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`Content location limit must be between 1 and ${MAX_LIMIT}.`);
    const current = this.#current(projectId, resourceId);
    if (current.extension === '.csv') throw conflict('CSV supports explicit-key row lookup only; it is not a general content location format.');
    if (current.extension === '.xlsx') return this.#locateXlsx(current, { sheet, cell, limit });
    if (current.extension === '.png') return this.#locatePng(current, { x, y, width, height });
    if (current.extension === '.pdf') {
      const hasRegion = [x, y, width, height].some((value) => value != null);
      if (hasRegion) {
        if (page == null || ![x, y, width, height].every((value) => value != null)) throw conflict('PDF region requires page, x, y, width, and height together.');
        if (tables || tableIndex != null || cursor) throw conflict('PDF region coordinates cannot be combined with a cursor or table request.');
        return this.#locatePdfRegion(current, { page, x, y, width, height });
      }
      if (tables || tableIndex != null) {
        if (page == null || cursor) throw conflict('PDF table lookup requires a page and cannot use a text cursor.');
        if (tables && tableIndex != null) throw conflict('List PDF tables or select one table, not both.');
        return this.#locatePdfTables(current, { page, tableIndex });
      }
      return page == null ? this.#locatePdf(current, { limit, cursor }) : this.#locatePdfTextSpan(current, { page, cursor });
    }
    if (current.extension === '.docx') return this.#locateDocx(current, { limit, cursor });
    const parsed = parseBlocks(current.text);
    let offset = 0;
    if (cursor) {
      const decoded = unb64(cursor);
      if (decoded.version !== 1 || decoded.project_id !== projectId || decoded.resource_id !== resourceId
        || decoded.file_sha256 !== current.sha256 || !Number.isInteger(decoded.next_index)
        || decoded.next_index < 0 || decoded.next_index > parsed.blocks.length) {
        throw conflict('The Markdown file or reference page changed; start the location list again.');
      }
      offset = decoded.next_index;
    }
    const selected = parsed.blocks.slice(offset, offset + limit);
    const items = selected.map((block, index) => {
      const blockHash = sha256(Buffer.from(block.raw, 'utf8'));
      const ref = b64({ version: 1, format: 'markdown', project_id: projectId, resource_id: resourceId, file_sha256: current.sha256,
        start_line: block.start_line, end_line: block.end_line, block_sha256: blockHash });
      return { kind: block.kind, ...(block.level ? { level: block.level } : {}), text: block.text,
        start_line: block.start_line, end_line: block.end_line, block_sha256: blockHash, ref,
        href: `/projects/${encodeURIComponent(projectId)}/content-location?ref=${encodeURIComponent(ref)}` };
    });
    const nextIndex = offset + selected.length;
    return { schema: 'atlas.content-location.v1', project_id: projectId, resource_id: resourceId,
      relative_path: current.relative_path, file: { sha256: current.sha256, bytes: current.bytes,
        registered_sha256: current.registered_sha256,
        registration_status: current.registered_sha256 === current.sha256 ? 'current' : 'changed' },
      limit, total: parsed.blocks.length, items,
      next_cursor: nextIndex < parsed.blocks.length ? b64({ version: 1, project_id: projectId, resource_id: resourceId,
        file_sha256: current.sha256, next_index: nextIndex }) : null,
      unsupported_blocks: parsed.unsupported_count,
      note: parsed.unsupported_count ? 'Some complex Markdown blocks were not located.' : null };
  }

  readRef({ projectId, ref }) {
    const decoded = unb64(ref);
    if (decoded.version === 3 && ['pdf_region', 'pdf_table_cell'].includes(decoded.format)) {
      const isRegion = decoded.format === 'pdf_region';
      if (decoded.project_id !== projectId || typeof decoded.resource_id !== 'string'
        || !/^[a-f0-9]{64}$/u.test(decoded.file_sha256 ?? '') || !Number.isInteger(decoded.page)
        || decoded.page < 1 || decoded.page > MAX_PDF_PAGES || !Array.isArray(decoded.bbox) || decoded.bbox.length !== 4
        || !decoded.bbox.every(Number.isFinite) || typeof decoded.pdfplumber_version !== 'string'
        || decoded.profile !== PDF_SPATIAL_PROFILE || !/^[a-f0-9]{64}$/u.test(decoded.text_sha256 ?? '')
        || (!isRegion && !/^[a-f0-9]{64}$/u.test(decoded.table_structure_sha256 ?? ''))
        || (!isRegion && (!Number.isInteger(decoded.table_index) || decoded.table_index < 1
          || !Number.isInteger(decoded.row) || decoded.row < 1 || !Number.isInteger(decoded.column) || decoded.column < 1))) {
        throw conflict('The PDF spatial reference is invalid for this Project.');
      }
      const current = this.#current(projectId, decoded.resource_id);
      if (current.extension !== '.pdf') throw conflict('The referenced Resource is no longer a PDF in this Project.');
      if (current.sha256 !== decoded.file_sha256) return { schema: 'atlas.content-location-ref.v1', format: 'pdf', status: 'stale',
        project_id: projectId, resource_id: decoded.resource_id, page: decoded.page, expected_sha256: decoded.file_sha256,
        current_sha256: current.sha256, text: null };
      let extracted;
      if (isRegion) {
        const [x, y, right, bottom] = decoded.bbox;
        extracted = this.#extractPdfSpatial(current, { mode: 'region', page: decoded.page, x, y, width: right - x, height: bottom - y });
      } else {
        extracted = this.#extractPdfSpatial(current, { mode: 'table', page: decoded.page, tableIndex: decoded.table_index });
      }
      if (extracted.pdfplumber_version !== decoded.pdfplumber_version || extracted.profile !== decoded.profile) {
        return { schema: 'atlas.content-location-ref.v1', format: 'pdf', status: 'extractor_changed',
          project_id: projectId, resource_id: decoded.resource_id, page: decoded.page, expected_sha256: decoded.file_sha256,
          file_sha256: current.sha256, text: null };
      }
      let text; let locationFields;
      if (isRegion) {
        if (extracted.status === 'text_truncated' || extracted.text_sha256 !== decoded.text_sha256
          || JSON.stringify(extracted.bbox) !== JSON.stringify(decoded.bbox)) {
          return { schema: 'atlas.content-location-ref.v1', format: 'pdf', status: 'extraction_changed',
            project_id: projectId, resource_id: decoded.resource_id, page: decoded.page, expected_sha256: decoded.file_sha256,
            file_sha256: current.sha256, text: null };
        }
        text = extracted.text; locationFields = { bbox: extracted.bbox };
      } else {
        const cell = extracted.cells?.find((item) => item.row === decoded.row && item.column === decoded.column);
        if (extracted.status !== 'table_cells' || !cell || cell.text_sha256 !== decoded.text_sha256
          || pdfTableStructureHash(extracted) !== decoded.table_structure_sha256
          || JSON.stringify(extracted.bbox) !== JSON.stringify(decoded.bbox)) {
          return { schema: 'atlas.content-location-ref.v1', format: 'pdf', status: 'extraction_changed',
            project_id: projectId, resource_id: decoded.resource_id, page: decoded.page, expected_sha256: decoded.file_sha256,
            file_sha256: current.sha256, text: null };
        }
        text = cell.text; locationFields = { bbox: extracted.bbox, table_index: decoded.table_index, row: decoded.row, column: decoded.column };
      }
      return { schema: 'atlas.content-location-ref.v1', format: 'pdf', status: 'current', location_kind: decoded.format,
        project_id: projectId, resource_id: decoded.resource_id, relative_path: current.relative_path,
        file_sha256: current.sha256, page: decoded.page, text, text_sha256: decoded.text_sha256,
        ...(!isRegion ? { table_structure_sha256: decoded.table_structure_sha256 } : {}),
        pdfplumber_version: extracted.pdfplumber_version, profile: extracted.profile, ...locationFields };
    }
    if (decoded.version === 2 && decoded.format === 'pdf_text_span') {
      if (decoded.project_id !== projectId || typeof decoded.resource_id !== 'string'
        || !/^[a-f0-9]{64}$/u.test(decoded.file_sha256 ?? '') || !Number.isInteger(decoded.page)
        || decoded.page < 1 || decoded.page > MAX_PDF_PAGES || typeof decoded.pypdf_version !== 'string'
        || decoded.extraction_profile !== PDF_TEXT_PROFILE || !/^[a-f0-9]{64}$/u.test(decoded.page_text_sha256 ?? '')
        || !/^[a-f0-9]{64}$/u.test(decoded.segment_sha256 ?? '')
        || !Number.isInteger(decoded.start_codepoint) || decoded.start_codepoint < 0
        || !Number.isInteger(decoded.end_codepoint) || decoded.end_codepoint <= decoded.start_codepoint
        || decoded.end_codepoint - decoded.start_codepoint > 1200) {
        throw conflict('The PDF text-span reference is invalid for this Project.');
      }
      const current = this.#current(projectId, decoded.resource_id);
      if (current.extension !== '.pdf') throw conflict('The referenced Resource is no longer a PDF in this Project.');
      if (current.sha256 !== decoded.file_sha256) return { schema: 'atlas.content-location-ref.v1', format: 'pdf', location_kind: 'pdf_text_span', status: 'stale',
        project_id: projectId, resource_id: decoded.resource_id, page: decoded.page, expected_sha256: decoded.file_sha256,
        current_sha256: current.sha256, text: null };
      const extracted = this.#extractPdfTextSpan(current, { page: decoded.page, startCodepoint: decoded.start_codepoint });
      if (extracted.pypdf_version !== decoded.pypdf_version || extracted.extraction_profile !== decoded.extraction_profile) {
        return { schema: 'atlas.content-location-ref.v1', format: 'pdf', location_kind: 'pdf_text_span', status: 'extractor_changed',
          project_id: projectId, resource_id: decoded.resource_id, page: decoded.page, expected_sha256: decoded.file_sha256,
          file_sha256: current.sha256, text: null };
      }
      if (extracted.status !== 'text_layer' || extracted.page_text_sha256 !== decoded.page_text_sha256
        || extracted.start_codepoint !== decoded.start_codepoint || extracted.end_codepoint !== decoded.end_codepoint
        || extracted.segment_sha256 !== decoded.segment_sha256) {
        return { schema: 'atlas.content-location-ref.v1', format: 'pdf', location_kind: 'pdf_text_span', status: 'extraction_changed',
          project_id: projectId, resource_id: decoded.resource_id, page: decoded.page, expected_sha256: decoded.file_sha256,
          file_sha256: current.sha256, text: null };
      }
      return { schema: 'atlas.content-location-ref.v1', format: 'pdf', location_kind: 'pdf_text_span', status: 'current', project_id: projectId,
        resource_id: decoded.resource_id, relative_path: current.relative_path, file_sha256: current.sha256,
        page: decoded.page, text: extracted.text, text_codepoints: extracted.text_codepoints,
        page_text_sha256: extracted.page_text_sha256, segment_sha256: extracted.segment_sha256,
        start_codepoint: extracted.start_codepoint, end_codepoint: extracted.end_codepoint,
        basis: extracted.basis, reading_order: extracted.reading_order, spatial_mapping: extracted.spatial_mapping,
        table_structure: extracted.table_structure, ocr_used: extracted.ocr_used,
        source_text_accuracy: extracted.source_text_accuracy, pypdf_version: extracted.pypdf_version,
        extraction_profile: extracted.extraction_profile };
    }
    if (decoded.version === 1 && decoded.format === 'png') {
      const region = decoded.region;
      if (decoded.project_id !== projectId || typeof decoded.resource_id !== 'string'
        || !/^[a-f0-9]{64}$/u.test(decoded.file_sha256 ?? '')
        || !Number.isInteger(decoded.image_width) || !Number.isInteger(decoded.image_height)
        || !region || ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger)
        || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1
        || region.x + region.width > decoded.image_width || region.y + region.height > decoded.image_height
        || region.coordinate_space !== 'source_pixels' || region.origin !== 'top_left') {
        throw conflict('The PNG region reference is invalid for this Project.');
      }
      const current = this.#current(projectId, decoded.resource_id);
      if (current.extension !== '.png') throw conflict('The referenced Resource is no longer a PNG in this Project.');
      if (current.sha256 !== decoded.file_sha256 || current.image.width !== decoded.image_width || current.image.height !== decoded.image_height) {
        return { schema: 'atlas.content-location-ref.v1', format: 'png', status: 'stale', project_id: projectId,
          resource_id: decoded.resource_id, expected_sha256: decoded.file_sha256, current_sha256: current.sha256,
          region: null, preview_url: null, text: null };
      }
      const previewUrl = `/projects/${encodeURIComponent(projectId)}/resources/thumbnail?path=${encodeURIComponent(current.relative_path)}&expected_sha256=${current.sha256}`;
      return { schema: 'atlas.content-location-ref.v1', format: 'png', status: 'current', project_id: projectId,
        resource_id: decoded.resource_id, relative_path: current.relative_path, file_sha256: current.sha256,
        image: current.image, region, preview_url: previewUrl,
        href: `/projects/${encodeURIComponent(projectId)}/content-location?ref=${encodeURIComponent(ref)}`, text: null };
    }
    if (decoded.version === 1 && decoded.format === 'xlsx') {
      if (decoded.project_id !== projectId || typeof decoded.resource_id !== 'string'
        || !/^[a-f0-9]{64}$/u.test(decoded.file_sha256 ?? '') || typeof decoded.sheet !== 'string' || !decoded.sheet
        || !/^[A-Z]{1,3}[1-9][0-9]*$/u.test(decoded.cell ?? '')
        || !['value', 'empty', 'formula_cached', 'formula_no_cache', 'error', 'unavailable', 'merged_non_anchor'].includes(decoded.status)
        || (decoded.value_sha256 !== null && !/^[a-f0-9]{64}$/u.test(decoded.value_sha256 ?? ''))
        || typeof decoded.formula_present !== 'boolean' || typeof decoded.merge_state !== 'string') {
        throw conflict('The XLSX cell reference is invalid for this Project.');
      }
      const current = this.#current(projectId, decoded.resource_id);
      if (current.extension !== '.xlsx') throw conflict('The referenced Resource is no longer an XLSX workbook in this Project.');
      if (current.sha256 !== decoded.file_sha256) return { schema: 'atlas.content-location-ref.v1', format: 'xlsx', status: 'stale',
        project_id: projectId, resource_id: decoded.resource_id, sheet: decoded.sheet, cell: decoded.cell,
        expected_sha256: decoded.file_sha256, current_sha256: current.sha256, value: null, text: null };
      const extracted = this.#extractXlsx(current, { sheet: decoded.sheet, cell: decoded.cell, limit: 1 });
      const item = extracted.cells[0];
      if (!item || item.status !== decoded.status || item.value_sha256 !== decoded.value_sha256
        || item.formula_present !== decoded.formula_present || item.merge_state !== decoded.merge_state) {
        return { schema: 'atlas.content-location-ref.v1', format: 'xlsx', status: 'stale',
          project_id: projectId, resource_id: decoded.resource_id, sheet: decoded.sheet, cell: decoded.cell,
          expected_sha256: decoded.file_sha256, current_sha256: current.sha256, value: null, text: null };
      }
      return { schema: 'atlas.content-location-ref.v1', format: 'xlsx', status: 'current', project_id: projectId,
        resource_id: decoded.resource_id, relative_path: current.relative_path, file_sha256: current.sha256,
        sheet: extracted.sheet.name, cell: item.cell, sheet_visibility: extracted.sheet.visibility,
        cell_status: item.status, value: item.value, text: item.value, value_sha256: item.value_sha256,
        value_characters: item.value_characters, value_truncated: item.value_truncated,
        formula_present: item.formula_present, formula: item.formula, merge_state: item.merge_state,
        merged_range: item.merged_range, cell_exists: item.cell_exists };
    }
    if (decoded.version === 1 && decoded.format === 'docx') {
      const paragraphCoordinates = Number.isInteger(decoded.paragraph_index) && decoded.paragraph_index >= 1
        && decoded.table_index === undefined && decoded.row === undefined && decoded.column === undefined;
      const cellCoordinates = Number.isInteger(decoded.table_index) && decoded.table_index >= 1
        && Number.isInteger(decoded.row) && decoded.row >= 1 && Number.isInteger(decoded.column) && decoded.column >= 1
        && decoded.paragraph_index === undefined;
      if (decoded.project_id !== projectId || typeof decoded.resource_id !== 'string'
        || !/^[a-f0-9]{64}$/u.test(decoded.file_sha256 ?? '') || !/^[a-f0-9]{64}$/u.test(decoded.text_sha256 ?? '')
        || !['paragraph', 'table_cell'].includes(decoded.kind)
        || (decoded.kind === 'paragraph' && !paragraphCoordinates) || (decoded.kind === 'table_cell' && !cellCoordinates)) {
        throw conflict('The DOCX content reference is invalid for this Project.');
      }
      const current = this.#current(projectId, decoded.resource_id);
      if (current.extension !== '.docx') throw conflict('The referenced Resource is no longer a DOCX in this Project.');
      if (current.sha256 !== decoded.file_sha256) return { schema: 'atlas.content-location-ref.v1', format: 'docx', status: 'stale',
        project_id: projectId, resource_id: decoded.resource_id, expected_sha256: decoded.file_sha256,
        current_sha256: current.sha256, kind: decoded.kind, text: null };
      const extracted = this.#extractDocx(current);
      const item = extracted.locations.find((candidate) => candidate.kind === decoded.kind
        && candidate.text_sha256 === decoded.text_sha256
        && (decoded.kind === 'paragraph' ? candidate.paragraph_index === decoded.paragraph_index
          : candidate.table_index === decoded.table_index && candidate.row === decoded.row && candidate.column === decoded.column));
      if (!item) return { schema: 'atlas.content-location-ref.v1', format: 'docx', status: 'stale',
        project_id: projectId, resource_id: decoded.resource_id, expected_sha256: decoded.file_sha256,
        current_sha256: current.sha256, kind: decoded.kind, text: null };
      return { schema: 'atlas.content-location-ref.v1', format: 'docx', status: 'current', project_id: projectId,
        resource_id: decoded.resource_id, relative_path: current.relative_path, file_sha256: current.sha256,
        kind: item.kind, paragraph_index: item.paragraph_index, table_index: item.table_index,
        row: item.row, column: item.column, text_sha256: item.text_sha256, text_characters: item.text_characters,
        text_truncated: item.text_truncated, text_complete: item.text_complete, text: item.text };
    }
    if (decoded.version === 1 && decoded.format === 'pdf') {
      if (decoded.project_id !== projectId || typeof decoded.resource_id !== 'string'
        || !/^[a-f0-9]{64}$/u.test(decoded.file_sha256 ?? '') || !Number.isInteger(decoded.page)
        || decoded.page < 1 || decoded.page > MAX_PDF_PAGES
        || !['text_layer', 'image_only', 'empty_or_vector'].includes(decoded.status)
        || (decoded.text_sha256 !== null && !/^[a-f0-9]{64}$/u.test(decoded.text_sha256 ?? ''))) {
        throw conflict('The PDF page reference is invalid for this Project.');
      }
      const current = this.#current(projectId, decoded.resource_id);
      if (current.extension !== '.pdf') throw conflict('The referenced Resource is no longer a PDF in this Project.');
      if (current.sha256 !== decoded.file_sha256) return { schema: 'atlas.content-location-ref.v1', status: 'stale',
        project_id: projectId, resource_id: decoded.resource_id, page: decoded.page,
        expected_sha256: decoded.file_sha256, current_sha256: current.sha256, text: null };
      const extracted = this.#extractPdf(current);
      const page = extracted.pages.find((item) => item.page === decoded.page);
      if (!page || page.status !== decoded.status || page.text_sha256 !== decoded.text_sha256) {
        return { schema: 'atlas.content-location-ref.v1', status: 'stale', project_id: projectId,
          resource_id: decoded.resource_id, page: decoded.page, expected_sha256: decoded.file_sha256,
          current_sha256: current.sha256, text: null };
      }
      return { schema: 'atlas.content-location-ref.v1', format: 'pdf', status: page.status,
        project_id: projectId, resource_id: decoded.resource_id, relative_path: current.relative_path, page: page.page,
        file_sha256: current.sha256, page_status: page.status, text_sha256: page.text_sha256,
        text_characters: page.text_characters, text_truncated: page.text_truncated, image_count: page.image_count, text: page.text };
    }
    if (decoded.version !== 1 || (decoded.format != null && decoded.format !== 'markdown') || decoded.project_id !== projectId || typeof decoded.resource_id !== 'string'
      || !/^[a-f0-9]{64}$/u.test(decoded.file_sha256 ?? '') || !Number.isInteger(decoded.start_line)
      || !Number.isInteger(decoded.end_line) || decoded.start_line < 1 || decoded.end_line < decoded.start_line
      || !/^[a-f0-9]{64}$/u.test(decoded.block_sha256 ?? '')) throw conflict('The content reference is invalid for this Project.');
    const current = this.#current(projectId, decoded.resource_id);
    if (current.extension !== '.md') throw conflict('The referenced Resource is no longer Markdown in this Project.');
    if (current.sha256 !== decoded.file_sha256) return { schema: 'atlas.content-location-ref.v1', status: 'stale',
      project_id: projectId, resource_id: decoded.resource_id, expected_sha256: decoded.file_sha256,
      current_sha256: current.sha256, start_line: decoded.start_line, end_line: decoded.end_line, text: null };
    const parsed = parseBlocks(current.text);
    const block = parsed.blocks.find((item) => item.start_line === decoded.start_line && item.end_line === decoded.end_line
      && sha256(Buffer.from(item.raw, 'utf8')) === decoded.block_sha256);
    if (!block) return { schema: 'atlas.content-location-ref.v1', status: 'stale', project_id: projectId,
      resource_id: decoded.resource_id, expected_sha256: decoded.file_sha256, current_sha256: current.sha256,
      start_line: decoded.start_line, end_line: decoded.end_line, text: null };
    return { schema: 'atlas.content-location-ref.v1', status: 'current', project_id: projectId,
      resource_id: decoded.resource_id, relative_path: current.relative_path, file_sha256: current.sha256,
      block_sha256: decoded.block_sha256, start_line: block.start_line, end_line: block.end_line,
      kind: block.kind, text: block.text };
  }

  dispose() {}
}

export function createContentLocationService(options) { return new ContentLocationService(options); }
