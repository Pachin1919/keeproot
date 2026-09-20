import crypto from 'node:crypto';

const parse = (value, fallback = null) => value == null ? fallback : JSON.parse(value);
const encode = (value) => JSON.stringify(value);

function view(row) {
  return row && {
    view_id: row.id,
    project_id: row.project_id,
    name: row.name,
    mode: row.mode,
    config: parse(row.config_json, {}),
    revision: row.revision,
    last_evaluated_at: row.last_evaluated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function definition(row) {
  return row && {
    property_id: row.id,
    project_id: row.project_id,
    name: row.name,
    kind: row.kind,
    options: parse(row.options_json, []),
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function propertyValue(row) {
  return row && {
    property_id: row.property_id,
    resource_id: row.resource_id,
    value: parse(row.value_json),
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

function candidate(row) {
  return row && {
    candidate_id: row.id,
    batch_id: row.batch_id,
    project_id: row.project_id,
    view_id: row.view_id,
    resource_id: row.resource_id,
    resource_name: row.resource_name,
    property_id: row.property_id,
    property_name: row.property_name,
    property_kind: row.property_kind,
    value: parse(row.value_json),
    source_version: row.source_version,
    property_revision: row.property_revision,
    evidence: parse(row.evidence_json, {}),
    host: parse(row.host_json, {}),
    status: row.status,
    revision: row.revision,
    decision: parse(row.decision_json),
    property_batch_id: row.property_batch_id,
    generated_at: row.created_at,
    updated_at: row.updated_at,
    decided_at: row.decided_at,
  };
}

function conflict(message, details = {}) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  error.details = details;
  return error;
}

export class ProjectViewRepository {
  constructor({ db, transaction }) {
    this.db = db;
    this.transaction = transaction;
  }

  viewById(viewId) {
    return view(this.db.prepare('SELECT * FROM saved_resource_views WHERE id=?').get(viewId));
  }

  listViews(projectId) {
    return this.db.prepare('SELECT * FROM saved_resource_views WHERE project_id=? ORDER BY updated_at DESC,id')
      .all(projectId).map(view);
  }

  saveView({ projectId, viewId = null, name, mode, config, baseRevision = null, at }) {
    return this.transaction(() => {
      if (!viewId) {
        const id = `VIEW-${crypto.randomUUID()}`;
        this.db.prepare(`INSERT INTO saved_resource_views(id,project_id,name,mode,config_json,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,1,?,?)`).run(id, projectId, name, mode, encode(config), at, at);
        return this.viewById(id);
      }
      const current = this.viewById(viewId);
      if (!current || current.project_id !== projectId) throw new Error('Saved View is unavailable in this Project.');
      if (baseRevision == null || Number(baseRevision) !== current.revision) {
        throw conflict('Saved View changed after it was opened.', { view_id: viewId, current_revision: current.revision });
      }
      this.db.prepare(`UPDATE saved_resource_views SET name=?,mode=?,config_json=?,revision=revision+1,updated_at=?
        WHERE id=? AND project_id=? AND revision=?`).run(name, mode, encode(config), at, viewId, projectId, current.revision);
      return this.viewById(viewId);
    });
  }

  markEvaluated(viewId, at) {
    this.db.prepare('UPDATE saved_resource_views SET last_evaluated_at=? WHERE id=?').run(at, viewId);
    return this.viewById(viewId);
  }

  defineProperty({ projectId, name, kind, options, at }) {
    const id = `PROP-${crypto.randomUUID()}`;
    this.db.prepare(`INSERT INTO resource_property_definitions(id,project_id,name,kind,options_json,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,?)`).run(id, projectId, name, kind, encode(options), at, at);
    return this.propertyById(id);
  }

  propertyById(propertyId) {
    return definition(this.db.prepare('SELECT * FROM resource_property_definitions WHERE id=?').get(propertyId));
  }

  listProperties(projectId) {
    return this.db.prepare('SELECT * FROM resource_property_definitions WHERE project_id=? ORDER BY created_at,id')
      .all(projectId).map(definition);
  }

  createCandidateBatch({ projectId, viewId = null, scope, propertyId, host, candidates, at }) {
    return this.transaction(() => {
      const batchId = `PCBAT-${crypto.randomUUID()}`;
      this.db.prepare(`INSERT INTO resource_property_candidate_batches
        (id,project_id,view_id,scope_json,property_id,host_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'pending',?,?)`)
        .run(batchId, projectId, viewId, encode(scope), propertyId, encode(host), at, at);
      const insert = this.db.prepare(`INSERT INTO resource_property_candidates
        (id,batch_id,resource_id,value_json,source_version,property_revision,evidence_json,status,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',1,?,?)`);
      for (const item of candidates) insert.run(`PCAND-${crypto.randomUUID()}`, batchId, item.resourceId, encode(item.value), item.sourceVersion, item.propertyRevision, encode(item.evidence), at, at);
      return { batch_id: batchId, project_id: projectId, view_id: viewId, scope, property_id: propertyId, host, status: 'pending', created_at: at, candidates: this.listCandidates({ batchId }) };
    });
  }

  candidateById(candidateId) {
    return candidate(this.db.prepare(`SELECT c.*,b.project_id,b.view_id,b.property_id,b.host_json,
      r.display_name AS resource_name,p.name AS property_name,p.kind AS property_kind
      FROM resource_property_candidates c
      JOIN resource_property_candidate_batches b ON b.id=c.batch_id
      JOIN resources r ON r.id=c.resource_id
      JOIN resource_property_definitions p ON p.id=b.property_id
      WHERE c.id=?`).get(candidateId));
  }

  candidateBatch(projectId, batchId) {
    const row = this.db.prepare('SELECT * FROM resource_property_candidate_batches WHERE id=? AND project_id=?').get(batchId, projectId);
    if (!row) return null;
    const candidates = this.listCandidates({ projectId, batchId, limit: 11 });
    if (candidates.length > 10) throw new Error('Property suggestion batch exceeds its supported Preview size.');
    return { batch_id: row.id, project_id: row.project_id, view_id: row.view_id,
      scope: parse(row.scope_json, {}), property_id: row.property_id, host: parse(row.host_json, {}),
      status: row.status, created_at: row.created_at, updated_at: row.updated_at, candidates };
  }

  candidateApplication(item) {
    if (!item.property_batch_id) return null;
    const row = this.db.prepare(`SELECT b.status,i.after_value_json,i.after_revision
      FROM resource_property_batches b JOIN resource_property_batch_items i ON i.batch_id=b.id
      WHERE b.id=? AND b.project_id=? AND i.property_id=? AND i.resource_id=?`)
      .get(item.property_batch_id, item.project_id, item.property_id, item.resource_id);
    return row ? { status: row.status, value: parse(row.after_value_json), revision: row.after_revision } : null;
  }

  listCandidates({ projectId = null, batchId = null, statuses = null, limit = 100, recentDecisions = false } = {}) {
    const where = []; const values = [];
    if (projectId) { where.push('b.project_id=?'); values.push(projectId); }
    if (batchId) { where.push('b.id=?'); values.push(batchId); }
    if (Array.isArray(statuses) && statuses.length) { where.push(`c.status IN (${statuses.map(() => '?').join(',')})`); values.push(...statuses); }
    values.push(Number(limit));
    return this.db.prepare(`SELECT c.*,b.project_id,b.view_id,b.property_id,b.host_json,
      r.display_name AS resource_name,p.name AS property_name,p.kind AS property_kind
      FROM resource_property_candidates c
      JOIN resource_property_candidate_batches b ON b.id=c.batch_id
      JOIN resources r ON r.id=c.resource_id
      JOIN resource_property_definitions p ON p.id=b.property_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${recentDecisions ? 'c.decided_at' : 'c.created_at'} DESC,c.id LIMIT ?`).all(...values).map(candidate);
  }

  decideCandidate({ candidateId, expectedRevision, status, decision, propertyBatchId = null, at }) {
    return this.transaction(() => {
      const current = this.candidateById(candidateId);
      if (!current || current.status !== 'pending') throw new Error('Property suggestion is no longer awaiting review.');
      if (Number(expectedRevision) !== current.revision) throw conflict('Property suggestion changed after it was opened.', { candidate_id: candidateId, current_revision: current.revision });
      const changed = this.db.prepare(`UPDATE resource_property_candidates SET status=?,revision=revision+1,
        decision_json=?,property_batch_id=?,updated_at=?,decided_at=? WHERE id=? AND revision=? AND status='pending'`)
        .run(status, encode(decision), propertyBatchId, at, at, candidateId, current.revision);
      if (changed.changes !== 1) throw conflict('Property suggestion changed after it was opened.', { candidate_id: candidateId });
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM resource_property_candidates WHERE batch_id=? AND status='pending'").get(current.batch_id).count;
      if (!remaining) this.db.prepare("UPDATE resource_property_candidate_batches SET status='completed',updated_at=? WHERE id=?").run(at, current.batch_id);
      return this.candidateById(candidateId);
    });
  }

  acceptCandidate({ candidateId, expectedRevision, expectedPropertyRevision, value, decision, at }) {
    return this.transaction(() => {
      const current = this.candidateById(candidateId);
      if (!current || current.status !== 'pending') throw new Error('Property suggestion is no longer awaiting review.');
      if (Number(expectedRevision) !== current.revision) throw conflict('Property suggestion changed after it was opened.', { candidate_id: candidateId, current_revision: current.revision });
      const property = this.propertyById(current.property_id);
      const prior = this.value(current.property_id, current.resource_id);
      const priorRevision = prior?.revision ?? 0;
      if (Number(expectedPropertyRevision) !== priorRevision) throw conflict('The user property changed after this suggestion was created.', { candidate_id: candidateId, current_property_revision: priorRevision });
      const batchId = `PBAT-${crypto.randomUUID()}`;
      const afterRevision = priorRevision + 1;
      this.db.prepare("INSERT INTO resource_property_batches(id,project_id,status,created_at) VALUES(?,?,'applied',?)").run(batchId, current.project_id, at);
      this.db.prepare(`INSERT INTO resource_property_values(property_id,resource_id,value_json,revision,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(property_id,resource_id) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(current.property_id, current.resource_id, encode(value), afterRevision, at);
      this.db.prepare(`INSERT INTO resource_property_batch_items(batch_id,ordinal,property_id,resource_id,operation,before_value_json,before_revision,after_value_json,after_revision)
        VALUES(?,0,?,?, 'replace',?,?,?,?)`)
        .run(batchId, current.property_id, current.resource_id, prior ? encode(prior.value) : null, priorRevision, encode(value), afterRevision);
      const changed = this.db.prepare(`UPDATE resource_property_candidates SET status='accepted',revision=revision+1,
        decision_json=?,property_batch_id=?,updated_at=?,decided_at=? WHERE id=? AND revision=? AND status='pending'`)
        .run(encode(decision), batchId, at, at, candidateId, current.revision);
      if (changed.changes !== 1) throw conflict('Property suggestion changed after it was opened.', { candidate_id: candidateId });
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM resource_property_candidates WHERE batch_id=? AND status='pending'").get(current.batch_id).count;
      if (!remaining) this.db.prepare("UPDATE resource_property_candidate_batches SET status='completed',updated_at=? WHERE id=?").run(at, current.batch_id);
      return { candidate: this.candidateById(candidateId), property_batch: { batch_id: batchId, project_id: current.project_id, status: 'applied', created_at: at }, property_value: this.value(current.property_id, current.resource_id) };
    });
  }

  valuesForResources(resourceIds) {
    if (!resourceIds.length) return [];
    const marks = resourceIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM resource_property_values WHERE resource_id IN (${marks}) ORDER BY resource_id,property_id`)
      .all(...resourceIds).map(propertyValue);
  }

  value(propertyId, resourceId) {
    return propertyValue(this.db.prepare('SELECT * FROM resource_property_values WHERE property_id=? AND resource_id=?').get(propertyId, resourceId));
  }

  #assertProjectResource(projectId, resourceId) {
    const row = this.db.prepare(`SELECT 1 FROM resource_locations
      WHERE resource_id=? AND project_id=? AND status='active' LIMIT 1`).get(resourceId, projectId);
    if (!row) throw new Error(`Resource ${resourceId} is unavailable in this Project.`);
  }

  applyPropertyBatch({ projectId, changes, at }) {
    return this.transaction(() => {
      const prepared = changes.map((change) => {
        const property = this.propertyById(change.propertyId);
        if (!property || property.project_id !== projectId) throw new Error(`Property ${change.propertyId} is unavailable in this Project.`);
        this.#assertProjectResource(projectId, change.resourceId);
        const current = this.value(change.propertyId, change.resourceId);
        const currentRevision = current?.revision ?? 0;
        if (change.expectedRevision != null && Number(change.expectedRevision) !== currentRevision) {
          throw conflict('A Resource property changed after this edit was opened.', {
            property_id: change.propertyId,
            resource_id: change.resourceId,
            current_revision: currentRevision,
          });
        }
        let after;
        if (property.kind === 'multi') {
          const prior = Array.isArray(current?.value) ? current.value : [];
          if (change.operation === 'add') after = [...new Set([...prior, ...change.value])];
          else if (change.operation === 'remove') after = prior.filter((item) => !change.value.includes(item));
          else if (change.operation === 'replace') after = [...change.value];
          else throw new Error('Multi-select properties require add, remove, or replace.');
        } else {
          if (change.operation !== 'replace') throw new Error('Text and single-select properties require replace.');
          after = change.value;
        }
        return { ...change, property, current, beforeRevision: currentRevision, after, afterRevision: currentRevision + 1 };
      });

      const batchId = `PBAT-${crypto.randomUUID()}`;
      this.db.prepare("INSERT INTO resource_property_batches(id,project_id,status,created_at) VALUES(?,?,'applied',?)")
        .run(batchId, projectId, at);
      const upsert = this.db.prepare(`INSERT INTO resource_property_values(property_id,resource_id,value_json,revision,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(property_id,resource_id) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at`);
      const insertItem = this.db.prepare(`INSERT INTO resource_property_batch_items(batch_id,ordinal,property_id,resource_id,operation,before_value_json,before_revision,after_value_json,after_revision)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      prepared.forEach((item, ordinal) => {
        upsert.run(item.propertyId, item.resourceId, encode(item.after), item.afterRevision, at);
        insertItem.run(batchId, ordinal, item.propertyId, item.resourceId, item.operation,
          item.current ? encode(item.current.value) : null, item.beforeRevision, encode(item.after), item.afterRevision);
      });
      return {
        batch_id: batchId,
        project_id: projectId,
        status: 'applied',
        created_at: at,
        values: prepared.map((item) => this.value(item.propertyId, item.resourceId)),
      };
    });
  }

  undoPropertyBatch(batchId, at, projectId = null) {
    return this.transaction(() => {
      const batch = this.db.prepare('SELECT * FROM resource_property_batches WHERE id=?').get(batchId);
      if (!batch || batch.status !== 'applied') throw new Error('Property Undo is unavailable.');
      if (projectId != null && batch.project_id !== projectId) throw new Error('Property Undo is unavailable in this Project.');
      const items = this.db.prepare('SELECT * FROM resource_property_batch_items WHERE batch_id=? ORDER BY ordinal').all(batchId);
      const conflicts = [];
      for (const item of items) {
        const current = this.value(item.property_id, item.resource_id);
        if (!current || current.revision !== item.after_revision || encode(current.value) !== item.after_value_json) {
          conflicts.push({
            property_id: item.property_id,
            resource_id: item.resource_id,
            expected_revision: item.after_revision,
            current_revision: current?.revision ?? 0,
          });
        }
      }
      if (conflicts.length) throw conflict('Property Undo stopped because a later edit exists.', { batch_id: batchId, conflicts });
      const restore = this.db.prepare('UPDATE resource_property_values SET value_json=?,revision=?,updated_at=? WHERE property_id=? AND resource_id=?');
      const remove = this.db.prepare('DELETE FROM resource_property_values WHERE property_id=? AND resource_id=?');
      for (const item of items) {
        if (item.before_value_json == null) remove.run(item.property_id, item.resource_id);
        else restore.run(item.before_value_json, item.after_revision + 1, at, item.property_id, item.resource_id);
      }
      this.db.prepare("UPDATE resource_property_batches SET status='undone',undone_at=? WHERE id=?").run(at, batchId);
      return {
        batch_id: batchId,
        project_id: batch.project_id,
        status: 'undone',
        undone_at: at,
        values: items.map((item) => this.value(item.property_id, item.resource_id)),
      };
    });
  }

  latestAppliedPropertyBatch(projectId) {
    const row = this.db.prepare("SELECT * FROM resource_property_batches WHERE project_id=? AND status='applied' ORDER BY created_at DESC,id DESC LIMIT 1").get(projectId);
    return row && {
      batch_id: row.id,
      project_id: row.project_id,
      status: row.status,
      created_at: row.created_at,
    };
  }

  listPropertyActivity(limit = 100) {
    return this.db.prepare(`SELECT b.id,b.project_id,b.status,b.created_at,b.undone_at,p.name AS project_name,
      COUNT(i.ordinal) AS item_count,COUNT(DISTINCT i.resource_id) AS resource_count,COUNT(DISTINCT i.property_id) AS property_count
      FROM resource_property_batches b
      JOIN projects p ON p.id=b.project_id
      LEFT JOIN resource_property_batch_items i ON i.batch_id=b.id
      GROUP BY b.id,b.project_id,b.status,b.created_at,b.undone_at,p.name
      ORDER BY b.created_at DESC,b.id DESC LIMIT ?`).all(limit).map((row) => ({
        batch_id: row.id,
        project_id: row.project_id,
        project_name: row.project_name,
        status: row.status,
        created_at: row.created_at,
        undone_at: row.undone_at,
        item_count: row.item_count,
        resource_count: row.resource_count,
        property_count: row.property_count,
      }));
  }
}
