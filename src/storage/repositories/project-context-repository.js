import crypto from 'node:crypto';

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value);
}

function filtersHash(filters) {
  return crypto.createHash('sha256').update(json(filters)).digest('hex');
}

function publicRoot(row) {
  return {
    id: row.id,
    current_path: row.current_path,
    status: row.status,
    governance_status: row.governance_status,
    root_type: row.root_type,
    content_policy: row.content_policy,
    adopted_at: row.adopted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicLink(row) {
  return {
    link_id: row.id,
    target_project_id: row.target_project_id,
    source_project_id: row.source_project_id,
    purpose: row.purpose,
    filters: parseJson(row.filters_json, {}),
    filters_hash: row.filters_hash,
    rule_version_id: row.rule_version_id,
    status: row.status,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    supersedes_link_id: row.supersedes_link_id,
    reason: row.reason,
  };
}

function publicIdentity(row) {
  if (!row) return null;
  return {
    identity_id: row.id,
    project_id: row.project_id,
    signature_hash: row.signature_hash,
    evidence: parseJson(row.evidence_json, {}),
    stable_signals: parseJson(row.stable_signals_json, []),
    status: row.status,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    reason: row.reason,
  };
}

export class ProjectContextRepository {
  constructor({ db, transaction }) {
    this.db = db;
    this.transaction = transaction;
  }

  adoptRoot({
    currentPath,
    rootType,
    contentPolicy,
    adoptedAt,
  }) {
    return this.transaction(() => {
      let row = this.db.prepare(`
        SELECT * FROM portfolio_roots WHERE current_path = ? COLLATE NOCASE
      `).get(currentPath);
      if (!row) {
        const rootId = `ROOT-${crypto.randomUUID()}`;
        this.db.prepare(`
          INSERT INTO portfolio_roots(
            id, current_path, status, created_at, updated_at,
            governance_status, root_type, content_policy, adopted_at
          ) VALUES (?, ?, 'active', ?, ?, 'adopted', ?, ?, ?)
        `).run(
          rootId,
          currentPath,
          adoptedAt,
          adoptedAt,
          rootType,
          contentPolicy,
          adoptedAt,
        );
        this.db.prepare(`
          INSERT INTO portfolio_root_path_history(root_id, path, valid_from, reason)
          VALUES (?, ?, ?, 'workspace_root_adopted')
        `).run(rootId, currentPath, adoptedAt);
        row = this.db.prepare('SELECT * FROM portfolio_roots WHERE id = ?').get(rootId);
        return { root_id: row.id, status: row.governance_status, adopted_at: row.adopted_at };
      }
      if (row.governance_status === 'adopted') {
        if (row.root_type !== rootType || row.content_policy !== contentPolicy) {
          throw new Error(`Workspace Root is already adopted with different settings: ${row.id}`);
        }
        return { root_id: row.id, status: row.governance_status, adopted_at: row.adopted_at };
      }
      this.db.prepare(`
        UPDATE portfolio_roots
        SET governance_status = 'adopted', root_type = ?, content_policy = ?,
            adopted_at = ?, updated_at = ?
        WHERE id = ?
      `).run(rootType, contentPolicy, adoptedAt, adoptedAt, row.id);
      return { root_id: row.id, status: 'adopted', adopted_at: adoptedAt };
    });
  }

  getRoot(rootId) {
    const root = this.db.prepare('SELECT * FROM portfolio_roots WHERE id = ?').get(rootId);
    if (!root) throw new Error(`Workspace Root not found: ${rootId}`);
    const paths = this.db.prepare(`
      SELECT path, valid_from, valid_to, reason
      FROM portfolio_root_path_history
      WHERE root_id = ?
      ORDER BY id
    `).all(rootId);
    return { root: publicRoot(root), paths };
  }

  listRoots({ adoptedOnly = true } = {}) {
    const rows = adoptedOnly
      ? this.db.prepare(`
          SELECT * FROM portfolio_roots
          WHERE governance_status = 'adopted'
          ORDER BY adopted_at, id
        `).all()
      : this.db.prepare('SELECT * FROM portfolio_roots ORDER BY created_at, id').all();
    return rows.map(publicRoot);
  }

  getActiveLocation(projectId) {
    return this.db.prepare(`
      SELECT pl.*, pr.current_path AS root_path, pr.root_type, pr.content_policy
      FROM project_locations pl
      JOIN portfolio_roots pr ON pr.id = pl.root_id
      WHERE pl.project_id = ? AND pl.status = 'active'
    `).get(projectId) ?? null;
  }

  locationHistory(projectId) {
    return this.db.prepare(`
      SELECT pl.*, pr.current_path AS root_path, pr.root_type, pr.content_policy
      FROM project_locations pl
      JOIN portfolio_roots pr ON pr.id = pl.root_id
      WHERE pl.project_id = ?
      ORDER BY pl.valid_from, pl.rowid
    `).all(projectId);
  }

  getActiveIdentity(projectId) {
    const row = this.db.prepare(`
      SELECT * FROM project_identity_signatures
      WHERE project_id = ? AND status = 'active'
    `).get(projectId);
    return publicIdentity(row);
  }

  identityHistory(projectId) {
    return this.db.prepare(`
      SELECT * FROM project_identity_signatures
      WHERE project_id = ?
      ORDER BY valid_from, rowid
    `).all(projectId).map(publicIdentity);
  }

  recordIdentity({ projectId, signature, reason, recordedAt }) {
    return this.transaction(() => {
      const active = this.db.prepare(`
        SELECT * FROM project_identity_signatures
        WHERE project_id = ? AND status = 'active'
      `).get(projectId);
      if (active?.signature_hash === signature.signature_hash) return publicIdentity(active);
      if (active) {
        this.db.prepare(`
          UPDATE project_identity_signatures
          SET status = 'historical', valid_to = ?
          WHERE id = ?
        `).run(recordedAt, active.id);
      }
      const identityId = `PID-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO project_identity_signatures(
          id, project_id, signature_hash, evidence_json, stable_signals_json,
          status, valid_from, reason
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        identityId,
        projectId,
        signature.signature_hash,
        json(signature.evidence),
        json(signature.stable_signals),
        recordedAt,
        reason,
      );
      return this.getActiveIdentity(projectId);
    });
  }

  listActiveLocations() {
    return this.db.prepare(`
      SELECT pl.*, pr.current_path AS root_path, pr.root_type, pr.content_policy,
             pr.governance_status, p.name AS project_name, p.status AS project_status
      FROM project_locations pl
      JOIN portfolio_roots pr ON pr.id = pl.root_id
      JOIN projects p ON p.id = pl.project_id
      WHERE pl.status = 'active'
        AND pr.governance_status = 'adopted'
        AND p.status = 'active'
      ORDER BY length(pr.current_path || '/' || pl.relative_path) DESC, pl.valid_from, pl.id
    `).all();
  }

  listActiveLocationsForRoot(rootId) {
    return this.db.prepare(`
      SELECT pl.*, p.name AS project_name, p.status AS project_status
      FROM project_locations pl
      JOIN projects p ON p.id = pl.project_id
      WHERE pl.root_id = ?
        AND pl.status = 'active'
        AND p.status = 'active'
      ORDER BY pl.valid_from, pl.id
    `).all(rootId);
  }

  relocateRoot({ rootId, currentPath, reason, relocatedAt }) {
    return this.transaction(() => {
      const root = this.db.prepare('SELECT * FROM portfolio_roots WHERE id = ?').get(rootId);
      if (!root) throw new Error(`Workspace Root not found: ${rootId}`);
      const collision = this.db.prepare(`
        SELECT id FROM portfolio_roots
        WHERE current_path = ? COLLATE NOCASE AND id <> ?
      `).get(currentPath, rootId);
      if (collision) throw new Error(`Another Workspace Root already uses this path: ${collision.id}`);
      this.db.prepare(`
        UPDATE portfolio_root_path_history
        SET valid_to = ?
        WHERE root_id = ? AND valid_to IS NULL
      `).run(relocatedAt, rootId);
      this.db.prepare(`
        UPDATE portfolio_roots
        SET current_path = ?, updated_at = ?
        WHERE id = ?
      `).run(currentPath, relocatedAt, rootId);
      this.db.prepare(`
        INSERT INTO portfolio_root_path_history(root_id, path, valid_from, reason)
        VALUES (?, ?, ?, ?)
      `).run(rootId, currentPath, relocatedAt, reason);
      return this.getRoot(rootId);
    });
  }

  attachLocation({
    projectId,
    rootId,
    relativePath,
    reason,
    attachedAt,
  }) {
    return this.transaction(() => {
      const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.status !== 'active') throw new Error(`Project is not active: ${projectId}`);
      const root = this.db.prepare('SELECT * FROM portfolio_roots WHERE id = ?').get(rootId);
      if (!root) throw new Error(`Workspace Root not found: ${rootId}`);
      if (root.governance_status !== 'adopted') throw new Error(`Workspace Root is not adopted: ${rootId}`);
      const active = this.getActiveLocation(projectId);
      if (active?.root_id === rootId
          && active.relative_path.localeCompare(relativePath, undefined, { sensitivity: 'accent' }) === 0) {
        return active;
      }
      const collision = this.db.prepare(`
        SELECT project_id FROM project_locations
        WHERE root_id = ? AND relative_path = ? COLLATE NOCASE
          AND status = 'active' AND project_id <> ?
      `).get(rootId, relativePath, projectId);
      if (collision) {
        throw new Error(`An active Project location already uses ${rootId}:${relativePath}`);
      }
      if (active) {
        this.db.prepare(`
          UPDATE project_locations
          SET status = 'historical', valid_to = ?, reason = ?
          WHERE id = ?
        `).run(attachedAt, reason, active.id);
      }
      const locationId = `LOC-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO project_locations(
          id, project_id, root_id, relative_path, status, valid_from, reason
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(locationId, projectId, rootId, relativePath, attachedAt, reason);
      this.db.prepare(`
        UPDATE projects SET current_path = ?, updated_at = ? WHERE id = ?
      `).run(relativePath, attachedAt, projectId);
      return this.getActiveLocation(projectId);
    });
  }

  linkContext({
    targetProjectId,
    sourceProjectId,
    purpose,
    filters,
    reason,
    linkedAt,
  }) {
    return this.transaction(() => {
      if (targetProjectId === sourceProjectId) {
        throw new Error('A Project cannot use itself as a cross-Project context source.');
      }
      for (const projectId of [targetProjectId, sourceProjectId]) {
        const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        if (!project || project.status !== 'active') throw new Error(`Active Project not found: ${projectId}`);
        if (!this.getActiveLocation(projectId)) throw new Error(`Project has no active Workspace Root location: ${projectId}`);
      }
      const hash = filtersHash(filters);
      const active = this.db.prepare(`
        SELECT * FROM project_context_links
        WHERE target_project_id = ? AND source_project_id = ?
          AND purpose = ? AND status = 'active'
      `).get(targetProjectId, sourceProjectId, purpose);
      if (active?.filters_hash === hash) return publicLink(active);
      if (active) {
        this.db.prepare(`
          UPDATE project_context_links
          SET status = 'superseded', valid_to = ?
          WHERE id = ?
        `).run(linkedAt, active.id);
      }
      const linkId = `CTX-${crypto.randomUUID()}`;
      const ruleVersionId = `RULE-CONTEXT-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO rule_versions(id, name, version, definition_json, created_at)
        VALUES (?, 'Project context link', ?, ?, ?)
      `).run(ruleVersionId, linkId, json({
        target_project_id: targetProjectId,
        source_project_id: sourceProjectId,
        purpose,
        filters,
      }), linkedAt);
      this.db.prepare(`
        INSERT INTO project_context_links(
          id, target_project_id, source_project_id, purpose,
          filters_json, filters_hash, rule_version_id, status,
          valid_from, supersedes_link_id, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        linkId,
        targetProjectId,
        sourceProjectId,
        purpose,
        json(filters),
        hash,
        ruleVersionId,
        linkedAt,
        active?.id ?? null,
        reason,
      );
      return publicLink(this.db.prepare('SELECT * FROM project_context_links WHERE id = ?').get(linkId));
    });
  }

  listContextLinks(targetProjectId, { includeHistory = false } = {}) {
    const rows = includeHistory
      ? this.db.prepare(`
          SELECT * FROM project_context_links
          WHERE target_project_id = ?
          ORDER BY valid_from, rowid
        `).all(targetProjectId)
      : this.db.prepare(`
          SELECT * FROM project_context_links
          WHERE target_project_id = ? AND status = 'active'
          ORDER BY purpose, source_project_id
        `).all(targetProjectId);
    return rows.map(publicLink);
  }

  disableContextLink(linkId, { reason, disabledAt }) {
    return this.transaction(() => {
      const link = this.db.prepare('SELECT * FROM project_context_links WHERE id = ?').get(linkId);
      if (!link) throw new Error(`Project context link not found: ${linkId}`);
      if (link.status !== 'active') return publicLink(link);
      this.db.prepare(`
        UPDATE project_context_links
        SET status = 'disabled', valid_to = ?, reason = ?
        WHERE id = ?
      `).run(disabledAt, reason, linkId);
      return publicLink(this.db.prepare('SELECT * FROM project_context_links WHERE id = ?').get(linkId));
    });
  }
}
