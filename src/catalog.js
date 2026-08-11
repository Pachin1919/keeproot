import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';
import { Registry } from './registry.js';
import { sha256File } from './snapshots.js';
import { withStateLock } from './state-lock.js';
import { CatalogRepository } from './storage/repositories/catalog-repository.js';

const PARSER_NAME = 'atlas-direct-text';
const PARSER_VERSION = '1.0.0';
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_OBSERVED_FILES = 20_000;
const INDEXED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const IGNORED_DIRECTORIES = new Set([
  '.git', '.atlas', '.obsidian', '.next', '.cache',
  'node_modules', 'dist', 'build', 'coverage',
]);

function isTemporaryFileName(name) {
  const normalized = name.toLowerCase();
  return normalized.startsWith('~$')
    || normalized.startsWith('.~lock.')
    || /^#.+#$/u.test(name)
    || /\.(?:swp|swo|tmp|temp|part|crdownload)$/u.test(normalized);
}

function timestamp() {
  return new Date().toISOString();
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u0000/gu, '')
    .replace(/\r\n?/gu, '\n')
    .normalize('NFC');
}

function readBoundedText(filePath, byteSize) {
  const indexedBytes = Math.min(byteSize, MAX_INDEX_BYTES);
  const buffer = Buffer.alloc(indexedBytes);
  const descriptor = fs.openSync(filePath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < indexedBytes) {
      const count = fs.readSync(
        descriptor,
        buffer,
        bytesRead,
        indexedBytes - bytesRead,
        bytesRead,
      );
      if (count <= 0) break;
      bytesRead += count;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    text: normalizeText(buffer.subarray(0, bytesRead).toString('utf8')),
    indexedBytes: bytesRead,
    truncated: byteSize > bytesRead,
  };
}

function parseDirectText(filePath, text) {
  const headings = [];
  const tags = new Set();
  let title = null;
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      const value = heading[2].trim();
      if (!title && heading[1].length === 1) title = value;
      if (headings.length < 200) headings.push(value);
    }
    for (const match of line.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]{1,80})/gu)) {
      tags.add(match[1]);
      if (tags.size >= 100) break;
    }
  }
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(text);
  if (frontmatter) {
    const tagLine = /^tags?\s*:\s*(.+)$/imu.exec(frontmatter[1]);
    if (tagLine) {
      for (const value of tagLine[1].replace(/[[\]"]/gu, '').split(',')) {
        const tag = value.trim().replace(/^#/u, '');
        if (tag) tags.add(tag);
      }
    }
  }
  return {
    title: title ?? path.basename(filePath, path.extname(filePath)),
    headings,
    tags: [...tags].sort(),
  };
}

function normalizeSearchTerms(values = []) {
  if (!Array.isArray(values)) throw new Error('Catalog search terms must be an array.');
  const terms = [...new Set(values.map((value) => String(value).trim().normalize('NFC')).filter(Boolean))];
  if (terms.length > 12) throw new Error('Catalog search accepts at most 12 terms.');
  for (const term of terms) {
    if (term.length < 2 || term.length > 64) {
      throw new Error('Each Catalog search term must contain 2 to 64 characters.');
    }
  }
  return terms;
}

function normalizeSearchExtensions(values = []) {
  if (!Array.isArray(values)) throw new Error('Catalog search extensions must be an array.');
  return [...new Set(values.map((value) => {
    const extension = String(value).trim().toLowerCase();
    if (!INDEXED_EXTENSIONS.has(extension)) {
      throw new Error(`Catalog does not index extension: ${value}`);
    }
    return extension;
  }))].sort();
}

export class Catalog {
  constructor({ stateDir, registry = null }) {
    if (!stateDir) throw new Error('Catalog requires a stateDir.');
    this.stateDir = path.resolve(stateDir);
    this.registry = registry ?? new Registry({ stateDir: this.stateDir });
    this._ownsRegistry = registry == null;
    this.repository = new CatalogRepository({
      db: this.registry.ledger.db,
      transaction: (callback) => this.registry.ledger.transaction(callback),
    });
  }

  update({ projectId, caller = {} }) {
    return withStateLock(this.stateDir, () => {
      const project = this.registry.show(projectId);
      const location = project.location;
      if (!location) throw new Error(`Project has no active Workspace Root location: ${projectId}`);
      if (location.content_policy !== 'bounded_content') {
        throw new Error(`Workspace Root does not authorize bounded content indexing: ${location.root_id}`);
      }
      const rootPath = normalizeRoot(location.root_path);
      const projectRoot = path.resolve(rootPath, ...location.relative_path.split('/'));
      if (!isPathInside(rootPath, projectRoot) || !fs.existsSync(projectRoot)) {
        throw new Error(`Catalog Project location is missing or outside its Workspace Root: ${project.id}`);
      }
      const projectStat = fs.lstatSync(projectRoot);
      if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
        throw new Error(`Catalog Project location must be a real directory: ${projectRoot}`);
      }
      const realProjectRoot = fs.realpathSync.native(projectRoot);
      if (!isPathInside(rootPath, realProjectRoot)) {
        throw new Error(`Catalog Project location resolves outside its Workspace Root: ${project.id}`);
      }
      const generationId = `CGEN-${crypto.randomUUID()}`;
      const startedAt = timestamp();
      this.repository.startGeneration({
        generationId,
        projectId,
        rootId: location.root_id,
        startedAt,
        caller,
      });
      const summary = {
        observed_files: 0,
        changed_files: 0,
        reused_files: 0,
        missing_files: 0,
        content_files_read: 0,
        content_bytes_read: 0,
        skipped_unindexed_files: 0,
        skipped_temporary_files: 0,
        skipped_symbolic_links: 0,
        skipped_special_files: 0,
        truncated_files: 0,
      };
      const fingerprintItems = [];
      const walk = (directory) => {
        const children = fs.readdirSync(directory, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          const absolute = path.join(directory, child.name);
          const stat = fs.lstatSync(absolute);
          if (child.isSymbolicLink() || stat.isSymbolicLink()) {
            summary.skipped_symbolic_links += 1;
            continue;
          }
          if (child.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(child.name)) walk(absolute);
            continue;
          }
          if (!child.isFile()) {
            summary.skipped_special_files += 1;
            continue;
          }
          if (isTemporaryFileName(child.name)) {
            summary.skipped_temporary_files += 1;
            continue;
          }
          const extension = path.extname(child.name).toLowerCase();
          if (!INDEXED_EXTENSIONS.has(extension)) {
            summary.skipped_unindexed_files += 1;
            continue;
          }
          summary.observed_files += 1;
          if (summary.observed_files > MAX_OBSERVED_FILES) {
            throw new Error(`Catalog Project exceeds the ${MAX_OBSERVED_FILES} file safety limit.`);
          }
          const projectRelativePath = toPortablePath(path.relative(realProjectRoot, absolute));
          const relativePath = `${location.relative_path}/${projectRelativePath}`;
          const existing = this.repository.getEntry(location.root_id, relativePath);
          if (existing
              && existing.status === 'active'
              && existing.byte_size === stat.size
              && existing.modified_ms === stat.mtimeMs
              && existing.parser_name === PARSER_NAME
              && existing.parser_version === PARSER_VERSION) {
            this.repository.touchEntry(existing.id, { generationId, seenAt: startedAt });
            summary.reused_files += 1;
            fingerprintItems.push([relativePath, existing.content_hash]);
            continue;
          }
          const extracted = readBoundedText(absolute, stat.size);
          const parsed = parseDirectText(absolute, extracted.text);
          const contentHash = sha256File(absolute);
          this.repository.upsertEntry({
            projectId,
            rootId: location.root_id,
            relativePath,
            projectRelativePath,
            extension,
            byteSize: stat.size,
            modifiedMs: stat.mtimeMs,
            modifiedAt: stat.mtime.toISOString(),
            contentHash,
            parserName: PARSER_NAME,
            parserVersion: PARSER_VERSION,
            title: parsed.title,
            headings: parsed.headings,
            tags: parsed.tags,
            indexedBytes: extracted.indexedBytes,
            truncated: extracted.truncated,
            seenAt: startedAt,
            generationId,
          }, extracted.text);
          summary.changed_files += 1;
          summary.content_files_read += 1;
          summary.content_bytes_read += extracted.indexedBytes;
          if (extracted.truncated) summary.truncated_files += 1;
          fingerprintItems.push([relativePath, contentHash]);
        }
      };
      walk(realProjectRoot);
      summary.missing_files = this.repository.markMissing({
        projectId,
        generationId,
        missingAt: startedAt,
      });
      const fingerprint = sha256Json(fingerprintItems.sort((left, right) => left[0].localeCompare(right[0])));
      const completedAt = timestamp();
      this.repository.finishGeneration({
        generationId,
        fingerprint,
        summary,
        completedAt,
      });
      return {
        schema: 'atlas-catalog-generation.v1',
        generation_id: generationId,
        project_id: projectId,
        root_id: location.root_id,
        status: 'completed',
        fingerprint,
        ...summary,
        source_changes: [],
      };
    });
  }

  search({
    projectId,
    terms = [],
    extensions = [],
    maxCandidates = 20,
  }) {
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 50) {
      throw new Error('Catalog maxCandidates must be an integer from 1 to 50.');
    }
    const normalizedTerms = normalizeSearchTerms(terms);
    const normalizedExtensions = normalizeSearchExtensions(extensions);
    const generation = this.repository.latestGeneration(projectId);
    if (!generation) throw new Error(`Project has no completed Catalog generation: ${projectId}`);
    const candidates = this.repository.search({
      projectId,
      terms: normalizedTerms,
      extensions: normalizedExtensions,
      maxCandidates,
    });
    return {
      schema: 'atlas-catalog-candidates.v1',
      project_id: projectId,
      generation_id: generation.generation_id,
      catalog_fingerprint: generation.fingerprint,
      query: {
        terms: normalizedTerms,
        extensions: normalizedExtensions,
        max_candidates: maxCandidates,
      },
      query_hash: sha256Json({
        project_id: projectId,
        generation_id: generation.generation_id,
        terms: normalizedTerms,
        extensions: normalizedExtensions,
        max_candidates: maxCandidates,
      }),
      query_mode: normalizedTerms.length
        ? (normalizedTerms.some((term) => [...term].length < 3)
            ? 'local_sqlite_short_text'
            : 'local_fts5_trigram')
        : 'local_catalog_recent',
      candidates,
      candidate_count: candidates.length,
      content_files_read: 0,
      source_changes: [],
    };
  }

  invalidate(entryId) {
    if (typeof entryId !== 'string' || !entryId.trim()) {
      throw new Error('Catalog invalidation requires an entry ID.');
    }
    return withStateLock(this.stateDir, () => this.repository.invalidateEntry(
      entryId,
      { invalidatedAt: timestamp() },
    ));
  }

  dispose() {
    if (this._ownsRegistry) this.registry.dispose();
  }
}
