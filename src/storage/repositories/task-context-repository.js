import crypto from 'node:crypto';

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

export class TaskContextRepository {
  constructor({ db, transaction }) {
    this.db = db;
    this.transaction = transaction;
  }

  createCandidateSet({
    targetProjectId,
    purpose,
    terms,
    contextLinks,
    candidates,
    createdAt,
  }) {
    const candidateSetId = `CSET-${crypto.randomUUID()}`;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO context_candidate_sets(
          id, target_project_id, purpose, terms_json,
          context_link_ids_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'ready', ?)
      `).run(
        candidateSetId,
        targetProjectId,
        purpose,
        json(terms),
        json(contextLinks.map((item) => item.link_id)),
        createdAt,
      );
      const insert = this.db.prepare(`
        INSERT INTO context_candidate_items(
          candidate_set_id, ordinal, catalog_entry_id, context_link_id,
          source_project_id, source_root_id, content_hash, score, snippet,
          snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      candidates.forEach((candidate, ordinal) => {
        const snapshot = {
          entry_id: candidate.entry_id,
          project_id: candidate.project_id,
          root_id: candidate.root_id,
          relative_path: candidate.relative_path,
          project_relative_path: candidate.project_relative_path,
          extension: candidate.extension,
          byte_size: candidate.byte_size,
          modified_at: candidate.modified_at,
          content_hash: candidate.content_hash,
          title: candidate.title,
          headings: candidate.headings,
          tags: candidate.tags,
          score: candidate.score,
          snippet: candidate.snippet ?? '',
        };
        insert.run(
          candidateSetId,
          ordinal,
          candidate.entry_id,
          candidate.context_link_id,
          candidate.project_id,
          candidate.root_id,
          candidate.content_hash,
          candidate.score,
          candidate.snippet ?? '',
          json(snapshot),
        );
      });
    });
    return this.getCandidateSet(candidateSetId);
  }

  getCandidateSet(candidateSetId) {
    const row = this.db.prepare(`
      SELECT * FROM context_candidate_sets WHERE id = ?
    `).get(candidateSetId);
    if (!row) throw new Error(`Context Candidate Set not found: ${candidateSetId}`);
    const candidates = this.db.prepare(`
      SELECT cci.ordinal, cci.context_link_id, cci.score, cci.snippet,
             cci.content_hash AS discovered_content_hash, cci.snapshot_json,
             ce.id AS current_entry_id, ce.project_id AS current_project_id,
             ce.root_id AS current_root_id, ce.relative_path AS current_relative_path,
             ce.project_relative_path AS current_project_relative_path,
             ce.extension AS current_extension, ce.byte_size AS current_byte_size,
             ce.modified_at AS current_modified_at, ce.title AS current_title,
             ce.headings_json AS current_headings_json, ce.tags_json AS current_tags_json,
             ce.content_hash AS catalog_current_hash,
             ce.status AS catalog_status
      FROM context_candidate_items cci
      JOIN catalog_entries ce ON ce.id = cci.catalog_entry_id
      WHERE cci.candidate_set_id = ?
      ORDER BY cci.ordinal
    `).all(candidateSetId).map((item) => {
      const saved = parseJson(item.snapshot_json, {});
      const snapshot = saved.entry_id ? saved : {
        entry_id: item.current_entry_id,
        project_id: item.current_project_id,
        root_id: item.current_root_id,
        relative_path: item.current_relative_path,
        project_relative_path: item.current_project_relative_path,
        extension: item.current_extension,
        byte_size: item.current_byte_size,
        modified_at: item.current_modified_at,
        content_hash: item.discovered_content_hash,
        title: item.current_title,
        headings: parseJson(item.current_headings_json, []),
        tags: parseJson(item.current_tags_json, []),
        score: item.score,
        snippet: item.snippet,
      };
      return {
        ordinal: item.ordinal,
        context_link_id: item.context_link_id,
        ...snapshot,
        content_hash: item.discovered_content_hash,
        score: item.score,
        snippet: item.snippet,
        catalog_status: item.catalog_status,
        catalog_current_hash: item.catalog_current_hash,
      };
    });
    return {
      candidate_set_id: row.id,
      target_project_id: row.target_project_id,
      purpose: row.purpose,
      terms: parseJson(row.terms_json, []),
      context_link_ids: parseJson(row.context_link_ids_json, []),
      status: row.status,
      created_at: row.created_at,
      candidates,
    };
  }

  createSourceSet({
    candidateSetId,
    targetProjectId,
    selectedEntryIds,
    createdAt,
  }) {
    const candidateSet = this.getCandidateSet(candidateSetId);
    if (candidateSet.status !== 'ready') {
      throw new Error(`Context Candidate Set is not ready: ${candidateSetId}`);
    }
    if (candidateSet.target_project_id !== targetProjectId) {
      throw new Error('Task Project does not match the Context Candidate Set target Project.');
    }
    const selectedIds = [...new Set(selectedEntryIds)];
    if (!selectedIds.length) throw new Error('Source Set requires at least one selected Catalog entry.');
    const byId = new Map(candidateSet.candidates.map((item) => [item.entry_id, item]));
    const selected = selectedIds.map((entryId) => {
      const item = byId.get(entryId);
      if (!item) throw new Error(`Catalog entry is not in the Candidate Set: ${entryId}`);
      if (item.catalog_status !== 'active') throw new Error(`Catalog entry is no longer active: ${entryId}`);
      if (item.catalog_current_hash !== item.content_hash) {
        throw new Error(`Candidate Set source changed after discovery: ${entryId}`);
      }
      return item;
    });
    const sourceSetId = `SSET-${crypto.randomUUID()}`;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO source_sets(id, candidate_set_id, target_project_id, status, created_at)
        VALUES (?, ?, ?, 'active', ?)
      `).run(sourceSetId, candidateSetId, targetProjectId, createdAt);
      const insert = this.db.prepare(`
        INSERT INTO source_set_items(
          source_set_id, ordinal, catalog_entry_id, source_project_id,
          source_root_id, source_root_path, source_relative_path,
          content_hash, byte_size, snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const rootPath = this.db.prepare(`
        SELECT current_path FROM portfolio_roots WHERE id = ?
      `);
      selected.forEach((item, ordinal) => {
        const root = rootPath.get(item.root_id);
        if (!root) throw new Error(`Workspace Root not found for Candidate: ${item.root_id}`);
        insert.run(
          sourceSetId,
          ordinal,
          item.entry_id,
          item.project_id,
          item.root_id,
          root.current_path,
          item.relative_path,
          item.content_hash,
          item.byte_size,
          json({
            entry_id: item.entry_id,
            project_id: item.project_id,
            root_id: item.root_id,
            relative_path: item.relative_path,
            project_relative_path: item.project_relative_path,
            extension: item.extension,
            byte_size: item.byte_size,
            modified_at: item.modified_at,
            content_hash: item.content_hash,
            title: item.title,
            headings: item.headings,
            tags: item.tags,
          }),
        );
      });
    });
    return this.getSourceSet(sourceSetId);
  }

  getSourceSet(sourceSetId) {
    const row = this.db.prepare('SELECT * FROM source_sets WHERE id = ?').get(sourceSetId);
    if (!row) throw new Error(`Source Set not found: ${sourceSetId}`);
    const items = this.db.prepare(`
      SELECT ssi.*
      FROM source_set_items ssi
      WHERE ssi.source_set_id = ?
      ORDER BY ssi.ordinal
    `).all(sourceSetId).map((item) => ({
      ...item,
      ...parseJson(item.snapshot_json, {}),
      snapshot_json: undefined,
    }));
    return {
      source_set_id: row.id,
      candidate_set_id: row.candidate_set_id,
      target_project_id: row.target_project_id,
      status: row.status,
      created_at: row.created_at,
      items,
    };
  }
}
