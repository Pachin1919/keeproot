import crypto from 'node:crypto';
import path from 'node:path';
import { assertRecoveryWritable } from '../recovery-write-guard.js';

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

export class ProjectRepository {
  constructor({ db, transaction }) {
    this.db = db;
    this.transaction = transaction;
  }

  create({ projectId, name, currentPath, aliases, status, parentProjectId, splitFrom, createdAt }) {
    return this.transaction(() => {
      if (this.db.prepare(`
        SELECT id FROM projects WHERE current_path = ? AND status = 'active'
      `).get(currentPath)) {
        throw new Error(`An active Project already uses path: ${currentPath}`);
      }
      if (parentProjectId) this.get(parentProjectId);
      for (const sourceId of splitFrom) this.get(sourceId);
      this.db.prepare(`
        INSERT INTO projects(
          id, name, current_path, status, parent_project_id, lineage_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        name,
        currentPath,
        status,
        parentProjectId ?? null,
        json({ split_from: splitFrom }),
        createdAt,
        createdAt,
      );
      this.db.prepare(`
        INSERT INTO project_path_history(project_id, path, valid_from) VALUES (?, ?, ?)
      `).run(projectId, currentPath, createdAt);
      const insertAlias = this.db.prepare(`
        INSERT OR IGNORE INTO project_aliases(project_id, alias, created_at) VALUES (?, ?, ?)
      `);
      for (const alias of aliases) insertAlias.run(projectId, alias, createdAt);
      if (parentProjectId) {
        this.#insertRelation(projectId, 'parent', parentProjectId, createdAt, {});
      }
      for (const sourceId of splitFrom) {
        this.#insertRelation(projectId, 'split_from', sourceId, createdAt, {});
      }
      return this.getDetail(projectId);
    });
  }

  update(projectId, { name, currentPath, aliases, status, reason, updatedAt }) {
    assertRecoveryWritable(this.db, { projectId });
    return this.transaction(() => {
      const project = this.get(projectId);
      if (currentPath !== project.current_path) {
        const collision = this.db.prepare(`
          SELECT id FROM projects WHERE current_path = ? AND status = 'active' AND id <> ?
        `).get(currentPath, projectId);
        if (collision) throw new Error(`An active Project already uses path: ${currentPath}`);
        this.db.prepare(`
          UPDATE project_path_history SET valid_to = ?, reason = ?
          WHERE project_id = ? AND valid_to IS NULL
        `).run(updatedAt, reason ?? null, projectId);
        this.db.prepare(`
          INSERT INTO project_path_history(project_id, path, valid_from, reason)
          VALUES (?, ?, ?, ?)
        `).run(projectId, currentPath, updatedAt, reason ?? null);
      }
      this.db.prepare(`
        UPDATE projects
        SET name = ?, current_path = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(name, currentPath, status, updatedAt, projectId);
      const insertAlias = this.db.prepare(`
        INSERT OR IGNORE INTO project_aliases(project_id, alias, created_at) VALUES (?, ?, ?)
      `);
      for (const alias of aliases) insertAlias.run(projectId, alias, updatedAt);
      return this.getDetail(projectId);
    });
  }

  renameName({ projectId, name, expectedName, expectedUpdatedAt, updatedAt }) {
    assertRecoveryWritable(this.db, { projectId });
    return this.transaction(() => {
      const project = this.get(projectId);
      if (project.name !== expectedName || project.updated_at !== expectedUpdatedAt) {
        const error = new Error('Project changed after the rename preview; review the current name again.');
        error.code = 'ATLAS_STATE_CONFLICT';
        throw error;
      }
      const result = this.db.prepare(`
        UPDATE projects SET name = ?, updated_at = ?
        WHERE id = ? AND name = ? AND updated_at = ?
      `).run(name, updatedAt, projectId, expectedName, expectedUpdatedAt);
      if (Number(result.changes) !== 1) {
        const error = new Error('Project changed after the rename preview; review the current name again.');
        error.code = 'ATLAS_STATE_CONFLICT';
        throw error;
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO project_aliases(project_id, alias, created_at) VALUES (?, ?, ?)
      `).run(projectId, expectedName, updatedAt);
      return this.getDetail(projectId);
    });
  }

  merge(sourceIds, targetId, effectiveAt) {
    for (const projectId of new Set([...sourceIds, targetId])) assertRecoveryWritable(this.db, { projectId });
    return this.transaction(() => {
      this.get(targetId);
      for (const sourceId of sourceIds) {
        if (sourceId === targetId) throw new Error('A Project cannot be merged into itself.');
        this.get(sourceId);
        this.db.prepare(`
          UPDATE projects SET status = 'merged', updated_at = ? WHERE id = ?
        `).run(effectiveAt, sourceId);
        this.#insertRelation(sourceId, 'merged_into', targetId, effectiveAt, {});
      }
      return sourceIds.map((sourceId) => this.getDetail(sourceId));
    });
  }

  #insertRelation(sourceId, relationType, targetId, effectiveAt, details) {
    this.db.prepare(`
      INSERT OR IGNORE INTO project_relations(
        id, source_project_id, relation_type, target_project_id, effective_at, details_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `REL-${crypto.randomUUID()}`,
      sourceId,
      relationType,
      targetId,
      effectiveAt,
      json(details),
    );
  }

  get(projectId) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  getDetail(projectId) {
    const project = this.get(projectId);
    const aliases = this.db.prepare(`
      SELECT alias FROM project_aliases WHERE project_id = ? ORDER BY rowid
    `).all(projectId).map((row) => row.alias);
    const paths = this.db.prepare(`
      SELECT path, valid_from, valid_to, reason
      FROM project_path_history WHERE project_id = ? ORDER BY id
    `).all(projectId);
    const relations = this.db.prepare(`
      SELECT relation_type, target_project_id, effective_at, details_json
      FROM project_relations WHERE source_project_id = ? ORDER BY rowid
    `).all(projectId).map((row) => ({
      ...row,
      details: parseJson(row.details_json, {}),
      details_json: undefined,
    }));
    return { project, aliases, paths, relations };
  }

  list() {
    return this.db.prepare(`
      SELECT id, name, current_path, status, parent_project_id, created_at, updated_at
      FROM projects ORDER BY created_at, id
    `).all();
  }

  ensureFromBootstrapPrediction(predictionId, createdAt) {
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT project_id FROM project_sources WHERE prediction_id = ?
      `).get(predictionId);
      if (existing) return this.getDetail(existing.project_id);
      const prediction = this.db.prepare(`
        SELECT id, run_id, kind, payload_json FROM predictions WHERE id = ?
      `).get(predictionId);
      if (!prediction || prediction.kind !== 'project_candidate') {
        throw new Error(`Bootstrap Project Prediction not found: ${predictionId}`);
      }
      const review = this.db.prepare(`
        SELECT value FROM labels
        WHERE subject_prediction_id = ? ORDER BY rowid DESC LIMIT 1
      `).get(predictionId);
      if (review?.value !== 'accepted') {
        throw new Error(`Project Prediction must be accepted before Registry initialization: ${predictionId}`);
      }
      const payload = parseJson(prediction.payload_json, {});
      const currentPath = payload.evidence?.directory;
      if (!currentPath) throw new Error(`Project Prediction has no directory evidence: ${predictionId}`);
      let project = this.db.prepare(`
        SELECT id FROM projects WHERE current_path = ? AND status = 'active'
      `).get(currentPath);
      if (!project) {
        const id = `PRJ-${crypto.randomUUID()}`;
        this.db.prepare(`
          INSERT INTO projects(
            id, name, current_path, status, lineage_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, ?, ?)
        `).run(
          id,
          path.posix.basename(currentPath),
          currentPath,
          json({ bootstrap_prediction_id: predictionId }),
          createdAt,
          createdAt,
        );
        this.db.prepare(`
          INSERT INTO project_path_history(project_id, path, valid_from, reason)
          VALUES (?, ?, ?, 'Accepted Bootstrap Prediction')
        `).run(id, currentPath, createdAt);
        project = { id };
      }
      this.db.prepare(`
        INSERT INTO project_sources(project_id, prediction_id, scan_run_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(project.id, predictionId, prediction.run_id, createdAt);
      return this.getDetail(project.id);
    });
  }
}
