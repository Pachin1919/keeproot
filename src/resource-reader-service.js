import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { contentFilePath } from './content-inspection.js';
import { projectDirectory, projectPath } from './ui/project-files.js';
import { readDocxBytes } from './docx-reader.js';
import { readTableBytes } from './table-reader.js';
import { assertRecoveryWritable, assertDocumentUpdatesSettled } from './storage/recovery-write-guard.js';

const TEXT_LIMIT = 256 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const PDF_LIMIT = 20 * 1024 * 1024;
const IMAGE_TYPES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif']]);
export function readerHeadingId(value) {
  return `reader-heading-${String(value).normalize('NFC').toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/gu, '-') || 'section'}`;
}
export function readerMarkupEscaped(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}
export function readerLinkTokens(text) {
  const result = []; let fence = null;
  for (const line of String(text).split(/\r?\n/u)) {
    const marker = line.match(/^\s*(```|~~~)/u)?.[1];
    if (marker) { fence = fence === marker ? null : fence ?? marker; continue; }
    if (fence || /^( {4}|\t)/u.test(line)) continue;
    const plain = line.replace(/`[^`\n]*`/gu, value => ' '.repeat(value.length));
    for (const match of plain.matchAll(/(!?\[\[([^\]\n]+)\]\]|!?\[[^\]\n]*\]\(([^\s)]+)\))/gu)) {
      if (match[0].startsWith('!') || readerMarkupEscaped(plain, match.index)) continue;
      result.push({ syntax: match[2] ? 'wikilink' : 'relative_markdown', raw: match[2] ?? match[3] });
    }
  }
  return result;
}
function conflict(message) { const error = new Error(message); error.code = 'ATLAS_STATE_CONFLICT'; return error; }
function same(a, b) {
  return a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink()
    && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function dimensions(width, height) {
  if (!width || !height || width > 50_000 || height > 50_000 || width * height > 100_000_000) {
    throw conflict('Image dimensions exceed the reader limits. Choose a smaller image.');
  }
}
function verifyImage(bytes, mime) {
  let width; let height;
  if (mime === 'image/png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii',12,16) !== 'IHDR') throw conflict('The PNG header does not match this image. Choose a valid PNG.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mime === 'image/gif') {
    if (bytes.length < 13 || !['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) throw conflict('The GIF header does not match this image. Choose a valid GIF.');
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw conflict('The JPEG header does not match this image. Choose a valid JPEG.');
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset += 1;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length < 8) break;
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
    if (width == null) throw conflict('JPEG dimensions are unavailable. Choose a valid JPEG.');
  } else {
    if (bytes.length < 30 || bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WEBP'
      || bytes.readUInt32LE(4) + 8 !== bytes.length) throw conflict('The WebP header does not match this image. Choose a valid WebP.');
    const format = bytes.toString('ascii',12,16);
    if (format === 'VP8X' && bytes.readUInt32LE(16) === 10) {
      width = bytes.readUIntLE(24,3) + 1; height = bytes.readUIntLE(27,3) + 1;
    } else if (format === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383;
    } else if (format === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
    } else throw conflict('WebP dimensions are unavailable. Choose a valid WebP.');
  }
  dimensions(width, height);
}

export function createResourceReaderService({ registry, resourceControl, installationRoot = null, pythonPath = null, pythonSourceRoot } = {}) {
  if (!registry || !resourceControl) throw new Error('Resource reading requires Registry and ResourceControl.');
  function current(projectId, resourceId) {
    try {
      const detail = registry.show(projectId);
      if (detail.project?.status !== 'active' || !detail.location?.root_path) throw new Error('inactive');
      const fact = resourceControl.projectResource(projectId, resourceId);
      if (fact.resource?.status && fact.resource.status !== 'active') throw new Error('inactive resource');
      const locations = (fact.locations ?? []).filter((item) => item.project_id === projectId && item.status === 'active');
      if (locations.length !== 1) throw new Error('ambiguous location');
      const root = projectDirectory(detail.location); const registered = path.resolve(locations[0].path);
      const relative = path.relative(root, registered);
      const checked = contentFilePath(projectPath(root, relative));
      if (checked !== registered) throw new Error('path mismatch');
      return { checked, relative, detail, stat: fs.lstatSync(checked) };
    } catch { throw conflict('The Resource is unavailable, linked, or outside this active Project. Restore or relink it in Resources, then retry.'); }
  }
  return {
    registerProjectFile({ projectId, relativePath }) {
      // Registration happens only after an explicit user action, never while browsing.
      if (typeof relativePath !== 'string' || !relativePath || /^[\\/]/u.test(relativePath)
        || /[\x00-\x1f:]/u.test(relativePath) || path.isAbsolute(relativePath)
        || relativePath.split(/[\\/]/u).some(part => part === '..' || part === '.')) throw conflict('Choose a relative file inside this Project.');
      const detail = registry.show(projectId);
      if (detail.project?.status !== 'active') throw conflict('This Project is unavailable.');
      const root = projectDirectory(detail.location);
      const checked = contentFilePath(projectPath(root, relativePath));
      const extension = path.extname(checked).toLowerCase();
      const limit = IMAGE_TYPES.has(extension) ? IMAGE_LIMIT : ['.pdf', '.docx', '.csv', '.tsv', '.xlsx'].includes(extension) ? PDF_LIMIT
        : ['.md', '.markdown', '.txt'].includes(extension) ? TEXT_LIMIT : null;
      if (limit == null) throw conflict('This format does not have an embedded reader.');
      if (fs.lstatSync(checked).size > limit) throw conflict(`Resource exceeds the ${limit} byte reader limit. Choose a smaller file.`);
      const prior = resourceControl.ledger.resources.byPath(checked);
      if (prior) {
        const facts = resourceControl.describe(prior.id);
        if (facts.resource.status !== 'active' || facts.locations.some(location => location.status === 'active'
          && path.resolve(location.path).toLowerCase() === checked.toLowerCase() && location.project_id && location.project_id !== projectId)) {
          throw conflict('This file is registered to another Project or requires recovery. Open its existing Resource.');
        }
      } else if (resourceControl.ledger.resources.locationsForProject(projectId).some(location =>
        path.resolve(location.path).toLowerCase() === checked.toLowerCase())) {
        throw conflict('This path has an existing Resource record. Restore or relink it in Resources.');
      }
      assertDocumentUpdatesSettled(resourceControl.stateDir, projectId);
      assertRecoveryWritable(resourceControl.ledger.db, { projectId, resourceId: prior?.id });
      const observed = resourceControl.identify({ filePath: checked, project: detail.project });
      return { project_id: projectId, resource_id: observed.resource_id, sha256: observed.evidence.sha256,
        relative_path: path.relative(root, checked).replaceAll('\\', '/') };
    },
    resolveLinks({ projectId, resourceId, expectedSha256, targets }) {
      if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '') || !Array.isArray(targets) || targets.length > 100) throw conflict('Reader links require a current source version and at most 100 targets.');
      const source = this.read({ projectId, resourceId, expectedSha256 });
      if (source.kind !== 'markdown') throw conflict('Reader links require Markdown.');
      const observed = new Set(readerLinkTokens(source.text).map(item => JSON.stringify(item)));
      const sourceFact = current(projectId, resourceId); const root = sourceFact.detail.location;
      // Directory/registration facts only: resolving a link never reads a target body.
      const candidates = [];
      for (const project of registry.list()) {
        if (project.status !== 'active') continue;
        const detail = registry.show(project.id);
        if (detail.location?.root_id !== root.root_id || path.resolve(detail.location?.root_path ?? '') !== path.resolve(root.root_path)) continue;
        for (const fact of resourceControl.projectResources(project.id)) {
          if (fact.resource?.status !== 'active') continue;
          const all = resourceControl.describe(fact.resource_id).locations.filter(item => item.status === 'active');
          for (const location of all.filter(item => item.project_id === project.id)) candidates.push({ projectId: project.id, resourceId: fact.resource_id, location, unique: all.length === 1 });
        }
      }
      return targets.map(item => {
        const result = { raw: item?.raw, syntax: item?.syntax, status: 'unresolved', reason: 'unsupported' };
        if (!item || !observed.has(JSON.stringify({ syntax: item.syntax, raw: item.raw }))) return { ...result, reason: 'not_in_source' };
        // Alias/fragment splitting follows Rowboat lib/wiki-links.ts at 2fdae42589992c19958f53ad64d52d1846c4b288 (Apache-2.0).
        let target = item.syntax === 'wikilink' ? item.raw.split('|', 1)[0] : item.raw;
        try { target = decodeURIComponent(target); } catch { return result; }
        if (/[\x00-\x1f\x7f\\]/u.test(target) || /^[\s/]/u.test(target) || /^[^/]*:/u.test(target) || /[?]/u.test(target)) return { ...result, reason: 'unsafe_path' };
        const index = target.indexOf('#'); const fragment = index < 0 ? null : target.slice(index + 1);
        target = index < 0 ? target : target.slice(0, index);
        if (!target && fragment && item.syntax === 'relative_markdown') return { ...result, status: 'resolved', reason: null, project_id: projectId, resource_id: resourceId, href: `#${readerHeadingId(fragment)}` };
        if (item.syntax === 'wikilink') {
          if (!target.includes('/')) return { ...result, reason: 'bare_wiki' };
          if (!path.extname(target)) target += '.md';
        }
        const absolute = path.resolve(item.syntax === 'wikilink' ? root.root_path : path.dirname(sourceFact.checked), target);
        const relative = path.relative(root.root_path, absolute);
        if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return { ...result, reason: 'outside_root' };
        const matching = candidates.filter(candidate => path.resolve(candidate.location.path) === absolute);
        if (matching.length !== 1 || !matching[0].unique) return { ...result, reason: matching.length ? 'ambiguous' : 'unregistered' };
        const candidate = matching[0];
        try {
          const checked = current(candidate.projectId, candidate.resourceId);
          if (!['.md', '.markdown', '.txt', '.pdf', '.docx', '.csv', '.tsv', '.xlsx', ...IMAGE_TYPES.keys()].includes(path.extname(checked.checked).toLowerCase())) return result;
        } catch { return { ...result, reason: 'unavailable' }; }
        const href = `/projects/${encodeURIComponent(candidate.projectId)}/resources/read?resource_id=${encodeURIComponent(candidate.resourceId)}${fragment ? `#${readerHeadingId(fragment)}` : ''}`;
        return { ...result, status: 'resolved', reason: null, project_id: candidate.projectId, resource_id: candidate.resourceId, href };
      });
    },
    readPdf({ projectId, resourceId, expectedSha256 }) {
      if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')) throw conflict('PDF reading requires the current Resource version. Reopen the Resource.');
      const result = this.read({ projectId, resourceId, expectedSha256, includePdfBytes: true });
      if (result.kind !== 'pdf') throw conflict('This Resource is not a PDF.');
      const { pdf_bytes: data, ...metadata } = result;
      return { ...metadata, data };
    },
    read({ projectId, resourceId, expectedSha256 = null, includePdfBytes = false, tableSheet = null, tableOffset = 0 }) {
      const before = current(projectId, resourceId); const extension = path.extname(before.checked).toLowerCase();
      const mime = IMAGE_TYPES.get(extension);
      const kind = extension === '.md' || extension === '.markdown' ? 'markdown' : extension === '.txt' ? 'text' : extension === '.pdf' ? 'pdf' : extension === '.docx' ? 'docx' : ['.csv', '.tsv', '.xlsx'].includes(extension) ? 'table' : mime ? 'image' : 'unsupported';
      const result = { project_id: projectId, resource_id: resourceId, name: path.basename(before.checked),
        relative_path: before.relative.replaceAll('\\','/'), sha256: null, bytes: before.stat.size, kind };
      if (kind === 'unsupported') {
        if (expectedSha256 != null) throw conflict('This format does not support reader version verification. Choose a Markdown, text, or supported image Resource.');
        const after = current(projectId, resourceId);
        if (after.checked !== before.checked || !same(before.stat, after.stat)) throw conflict('The Resource changed during reading. Retry from Resources.');
        return result;
      }
      const limit = ['pdf', 'docx', 'table'].includes(kind) ? PDF_LIMIT : mime ? IMAGE_LIMIT : TEXT_LIMIT;
      if (before.stat.size > limit) throw conflict(`Resource exceeds the ${limit} byte reader limit. Choose a smaller file.`);
      let fd; let bytes;
      try {
        fd = fs.openSync(before.checked, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const opened = fs.fstatSync(fd);
        if (!same(before.stat, opened)) throw conflict('The Resource changed before reading. Retry from Resources.');
        // One extra byte detects growth without ever reading an unbounded file.
        const buffer = Buffer.alloc(opened.size + 1); let count = 0;
        while (count < buffer.length) {
          const n = fs.readSync(fd, buffer, count, buffer.length - count, count);
          if (!n) break; count += n;
        }
        const afterFd = fs.fstatSync(fd); const afterPath = current(projectId, resourceId);
        if (count !== opened.size || !same(opened, afterFd) || afterPath.checked !== before.checked || !same(opened, afterPath.stat)) {
          throw conflict('The Resource changed during reading. Retry from Resources.');
        }
        bytes = buffer.subarray(0, count);
      } catch (error) {
        if (error.code === 'ATLAS_STATE_CONFLICT') throw error;
        throw conflict('The Resource could not be read. Restore or relink it in Resources, then retry.');
      } finally { if (fd !== undefined) fs.closeSync(fd); }
      result.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (expectedSha256 != null && expectedSha256 !== result.sha256) throw conflict('The Resource version changed. Refresh Resources and reopen the current version.');
      if (kind === 'table') {
        if ((tableOffset !== 0 || tableSheet !== null) && !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')) throw conflict('Table pagination and worksheet selection require the current Resource version. Reopen the Resource.');
        result.table = readTableBytes(bytes, { sha256: result.sha256, format: extension.slice(1), sheet: tableSheet, offset: tableOffset, installationRoot, pythonPath, pythonSourceRoot });
        const after = current(projectId, resourceId);
        if (after.checked !== before.checked || !same(before.stat, after.stat)) throw conflict('The Resource changed during table reading. Reopen the current version.');
      } else if (kind === 'docx') {
        result.document = readDocxBytes(bytes, { sha256: result.sha256, installationRoot, pythonPath, pythonSourceRoot });
        const after = current(projectId, resourceId);
        if (after.checked !== before.checked || !same(before.stat, after.stat)) throw conflict('The Resource changed during DOCX reading. Reopen the current version.');
      } else if (kind === 'pdf') {
        // This gate only identifies a PDF candidate; PDF.js validates the document structure.
        if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n|\s)/u.test(bytes.subarray(0, 16).toString('ascii'))) throw conflict('The PDF header does not match this file. Choose a valid PDF.');
        result.mime = 'application/pdf';
        if (includePdfBytes) result.pdf_bytes = bytes;
      } else if (mime) {
        verifyImage(bytes, mime); result.mime = mime; result.image_data_url = `data:${mime};base64,${bytes.toString('base64')}`;
      } else {
        try { result.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw conflict('The Resource is not valid UTF-8 text. Save it as UTF-8, then retry.'); }
      }
      return result;
    },
  };
}
