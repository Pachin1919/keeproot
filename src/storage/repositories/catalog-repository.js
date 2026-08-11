import crypto from 'node:crypto';

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function likePattern(value) {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function publicEntry(row) {
  return {
    entry_id: row.id,
    project_id: row.project_id,
    root_id: row.root_id,
    relative_path: row.relative_path,
    project_relative_path: row.project_relative_path,
    extension: row.extension,
    byte_size: row.byte_size,
    modified_at: row.modified_at,
    content_hash: row.content_hash,
    parser: {
      name: row.parser_name,
      version: row.parser_version,
      indexed_bytes: row.indexed_bytes,
      truncated: Boolean(row.truncated),
    },
    title: row.title,
    headings: parseJson(row.headings_json, []),
    tags: parseJson(row.tags_json, []),
    status: row.status,
  };
}

export class CatalogRepository {
  constructor({ db, transaction }) {
    this.db = db;
    this.transaction = transaction;
  }

  startGeneration({ generationId, projectId, rootId, startedAt, caller }) {
    this.db.prepare(`
      INSERT INTO catalog_generations(
        id, project_id, root_id, status, started_at,
        actor, agent, model, tool, client_run_id
      ) VALUES (?, ?, ?, 'indexing', ?, ?, ?, ?, ?, ?)
    `).run(
      generationId,
      projectId,
      rootId,
      startedAt,
      caller.actor ?? 'unknown',
      caller.agent ?? null,
      caller.model ?? null,
      caller.tool ?? 'atlas-cli',
      caller.client_run_id ?? null,
    );
  }

  getEntry(rootId, relativePath) {
    return this.db.prepare(`
      SELECT * FROM catalog_entries WHERE root_id = ? AND relative_path = ? COLLATE NOCASE
    `).get(rootId, relativePath) ?? null;
  }

  findActiveEntriesByHash(projectId, contentHash) {
    return this.db.prepare(`
      SELECT * FROM catalog_entries
      WHERE project_id = ? AND content_hash = ? AND status = 'active'
      ORDER BY relative_path COLLATE NOCASE
    `).all(projectId, contentHash).map(publicEntry);
  }

  touchEntry(entryId, { generationId, seenAt }) {
    this.db.prepare(`
      UPDATE catalog_entries
      SET status = 'active', last_seen_at = ?, last_seen_generation_id = ?
      WHERE id = ?
    `).run(seenAt, generationId, entryId);
  }

  invalidateEntry(entryId, { invalidatedAt }) {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE catalog_entries
        SET status = 'stale', last_seen_at = ?
        WHERE id = ? AND status = 'active'
      `).run(invalidatedAt, entryId);
      if (result.changes) {
        this.db.prepare('DELETE FROM catalog_fts WHERE entry_id = ?').run(entryId);
      }
      return result.changes > 0;
    });
  }

  upsertEntry(entry, body) {
    this.transaction(() => {
      const existing = this.getEntry(entry.rootId, entry.relativePath);
      const entryId = existing?.id ?? `CAT-${crypto.randomUUID()}`;
      if (existing) {
        this.db.prepare(`
          UPDATE catalog_entries
          SET project_id = ?, project_relative_path = ?, extension = ?,
              byte_size = ?, modified_ms = ?, modified_at = ?, content_hash = ?,
              parser_name = ?, parser_version = ?, title = ?, headings_json = ?,
              tags_json = ?, indexed_bytes = ?, truncated = ?, status = 'active',
              last_seen_at = ?, last_seen_generation_id = ?, changed_at = ?
          WHERE id = ?
        `).run(
          entry.projectId,
          entry.projectRelativePath,
          entry.extension,
          entry.byteSize,
          entry.modifiedMs,
          entry.modifiedAt,
          entry.contentHash,
          entry.parserName,
          entry.parserVersion,
          entry.title,
          json(entry.headings),
          json(entry.tags),
          entry.indexedBytes,
          entry.truncated ? 1 : 0,
          entry.seenAt,
          entry.generationId,
          entry.seenAt,
          entryId,
        );
        this.db.prepare('DELETE FROM catalog_fts WHERE entry_id = ?').run(entryId);
      } else {
        this.db.prepare(`
          INSERT INTO catalog_entries(
            id, project_id, root_id, relative_path, project_relative_path,
            extension, byte_size, modified_ms, modified_at, content_hash,
            parser_name, parser_version, title, headings_json, tags_json,
            indexed_bytes, truncated, status, first_seen_at, last_seen_at,
            last_seen_generation_id, changed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'active', ?, ?, ?, ?)
        `).run(
          entryId,
          entry.projectId,
          entry.rootId,
          entry.relativePath,
          entry.projectRelativePath,
          entry.extension,
          entry.byteSize,
          entry.modifiedMs,
          entry.modifiedAt,
          entry.contentHash,
          entry.parserName,
          entry.parserVersion,
          entry.title,
          json(entry.headings),
          json(entry.tags),
          entry.indexedBytes,
          entry.truncated ? 1 : 0,
          entry.seenAt,
          entry.seenAt,
          entry.generationId,
          entry.seenAt,
        );
      }
      this.db.prepare(`
        INSERT INTO catalog_fts(entry_id, title, headings, tags, body)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        entryId,
        entry.title ?? '',
        entry.headings.join('\n'),
        entry.tags.join('\n'),
        body,
      );
    });
  }

  markMissing({ projectId, generationId, missingAt }) {
    const missing = this.db.prepare(`
      SELECT id FROM catalog_entries
      WHERE project_id = ? AND status = 'active' AND last_seen_generation_id <> ?
    `).all(projectId, generationId);
    if (!missing.length) return 0;
    this.transaction(() => {
      const update = this.db.prepare(`
        UPDATE catalog_entries
        SET status = 'missing', last_seen_at = ?
        WHERE id = ?
      `);
      const removeFts = this.db.prepare('DELETE FROM catalog_fts WHERE entry_id = ?');
      for (const row of missing) {
        update.run(missingAt, row.id);
        removeFts.run(row.id);
      }
    });
    return missing.length;
  }

  finishGeneration({ generationId, fingerprint, summary, completedAt }) {
    this.db.prepare(`
      UPDATE catalog_generations
      SET status = 'completed', completed_at = ?, fingerprint = ?, summary_json = ?
      WHERE id = ?
    `).run(completedAt, fingerprint, json(summary), generationId);
  }

  latestGeneration(projectId) {
    const row = this.db.prepare(`
      SELECT * FROM catalog_generations
      WHERE project_id = ? AND status = 'completed'
      ORDER BY completed_at DESC, rowid DESC
      LIMIT 1
    `).get(projectId);
    return row ? {
      generation_id: row.id,
      project_id: row.project_id,
      root_id: row.root_id,
      completed_at: row.completed_at,
      fingerprint: row.fingerprint,
      summary: parseJson(row.summary_json, {}),
    } : null;
  }

  search({
    projectId,
    terms,
    extensions,
    maxCandidates,
  }) {
    if (!terms.length) {
      const extensionClause = extensions.length
        ? ` AND extension IN (${placeholders(extensions.length)})`
        : '';
      const rows = this.db.prepare(`
        SELECT * FROM catalog_entries
        WHERE project_id = ? AND status = 'active'${extensionClause}
        ORDER BY modified_at DESC, relative_path COLLATE NOCASE
        LIMIT ?
      `).all(projectId, ...extensions, maxCandidates);
      return rows.map((row) => ({ ...publicEntry(row), score: null, snippet: '' }));
    }
    if (terms.some((term) => [...term].length < 3)) {
      const termClauses = terms.map(() => `(
        catalog_fts.title LIKE ? ESCAPE '\\'
        OR catalog_fts.headings LIKE ? ESCAPE '\\'
        OR catalog_fts.tags LIKE ? ESCAPE '\\'
        OR catalog_fts.body LIKE ? ESCAPE '\\'
      )`);
      const patterns = terms.flatMap((term) => {
        const pattern = likePattern(term);
        return [pattern, pattern, pattern, pattern];
      });
      const firstTerm = terms[0];
      const extensionClause = extensions.length
        ? ` AND ce.extension IN (${placeholders(extensions.length)})`
        : '';
      const rows = this.db.prepare(`
        SELECT ce.*,
               CASE
                 WHEN instr(catalog_fts.title, ?) > 0 THEN -3
                 WHEN instr(catalog_fts.headings, ?) > 0 THEN -2
                 WHEN instr(catalog_fts.tags, ?) > 0 THEN -1
                 ELSE 0
               END AS score,
               CASE
                 WHEN instr(catalog_fts.body, ?) > 0
                   THEN substr(
                     catalog_fts.body,
                     max(instr(catalog_fts.body, ?) - 80, 1),
                     400
                   )
                 WHEN instr(catalog_fts.headings, ?) > 0
                   THEN substr(catalog_fts.headings, 1, 400)
                 ELSE ''
               END AS snippet
        FROM catalog_fts
        JOIN catalog_entries ce ON ce.id = catalog_fts.entry_id
        WHERE ce.project_id = ?
          AND ce.status = 'active'
          AND (${termClauses.join(' OR ')})${extensionClause}
        ORDER BY score, ce.modified_at DESC, ce.relative_path COLLATE NOCASE
        LIMIT ?
      `).all(
        firstTerm,
        firstTerm,
        firstTerm,
        firstTerm,
        firstTerm,
        firstTerm,
        projectId,
        ...patterns,
        ...extensions,
        maxCandidates,
      );
      return rows.map((row) => ({
        ...publicEntry(row),
        score: row.score,
        snippet: String(row.snippet ?? '').slice(0, 400),
      }));
    }
    const query = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const extensionClause = extensions.length
      ? ` AND ce.extension IN (${placeholders(extensions.length)})`
      : '';
    const rows = this.db.prepare(`
      SELECT ce.*, bm25(catalog_fts) AS score,
             snippet(catalog_fts, 4, '[', ']', '…', 32) AS snippet
      FROM catalog_fts
      JOIN catalog_entries ce ON ce.id = catalog_fts.entry_id
      WHERE catalog_fts MATCH ?
        AND ce.project_id = ?
        AND ce.status = 'active'${extensionClause}
      ORDER BY score, ce.modified_at DESC, ce.relative_path COLLATE NOCASE
      LIMIT ?
    `).all(query, projectId, ...extensions, maxCandidates);
    return rows.map((row) => ({
      ...publicEntry(row),
      score: row.score,
      snippet: String(row.snippet ?? '').slice(0, 400),
    }));
  }
}
