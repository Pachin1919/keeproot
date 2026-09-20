import crypto from 'node:crypto';

const parse = (value, fallback) => value == null ? fallback : JSON.parse(value);
const recipeDefault = () => ({ schema: 'atlas.table-recipe.v1', version: 1, combine: { operation: 'concatenate' }, steps: [{ operation: 'validate' }] });

function stateConflict(id, expected, current) {
  const error = new Error('Work changed after it was opened. Refresh before applying this update.');
  error.code = 'ATLAS_STATE_CONFLICT';
  error.details = { session_id: id, expected_revision: expected, current_revision: current };
  return error;
}

function source(row) {
  return row && {
    session_id: row.session_id,
    source_key: row.source_key,
    ordinal: row.ordinal,
    resource_id: row.resource_id,
    sheet: row.sheet,
    fingerprint: parse(row.fingerprint_json, null),
    profile: parse(row.profile_json, null),
    profile_processor_version: row.profile_processor_version,
    status: row.status,
    error_message: row.error_message,
    updated_at: row.updated_at,
  };
}

function session(row, sources = []) {
  return row && {
    session_id: row.id,
    project_id: row.project_id,
    status: row.status,
    intent: row.intent ?? null,
    caller: parse(row.caller_json, null),
    revision: row.revision,
    return_state: parse(row.return_state_json, {}),
    mapping: parse(row.mapping_json, []),
    recipe: parse(row.recipe_json, recipeDefault()),
    preview: parse(row.preview_json, null),
    preview_revision: row.preview_revision,
    latest_save_id: row.latest_save_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    sources,
  };
}

export class WorkSessionRepository {
  constructor({ db, transaction }) {
    this.db = db;
    this.transaction = transaction;
  }

  byId(id) {
    const row = this.db.prepare('SELECT * FROM work_sessions WHERE id=?').get(id);
    if (!row) return null;
    const sources = this.db.prepare('SELECT * FROM work_session_sources WHERE session_id=? ORDER BY ordinal,source_key').all(id).map(source);
    return session(row, sources);
  }

  latestOpenForProject(projectId) {
    const row = this.db.prepare("SELECT * FROM work_sessions WHERE project_id=? AND status='open' ORDER BY updated_at DESC,id DESC LIMIT 1").get(projectId);
    return row ? this.byId(row.id) : null;
  }

  listOpenForProject(projectId) {
    return this.db.prepare("SELECT id FROM work_sessions WHERE project_id=? AND status='open' ORDER BY updated_at DESC,id DESC")
      .all(projectId).map((row) => this.byId(row.id));
  }

  listForProject(projectId, { limit = 20, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Work Session limit must be an integer between 1 and 100.');
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Work Session offset must be a non-negative integer.');
    const total = Number(this.db.prepare('SELECT COUNT(*) AS total FROM work_sessions WHERE project_id=?').get(projectId).total);
    const rows = this.db.prepare('SELECT id FROM work_sessions WHERE project_id=? ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?')
      .all(projectId, limit, offset);
    return { sessions: rows.map((row) => this.byId(row.id)), total };
  }

  create({ projectId, returnState = {}, resourceIds = [], intent = null, caller = null, at }) {
    if (intent != null && (typeof intent !== 'string' || !intent.trim() || intent.length > 500)) throw new Error('Work goal must be non-empty text of at most 500 characters.');
    return this.transaction(() => {
      const id = `DWT-${crypto.randomBytes(16).toString('hex')}`;
      this.db.prepare(`INSERT INTO work_sessions(id,project_id,status,revision,return_state_json,mapping_json,recipe_json,created_at,updated_at,intent,caller_json)
        VALUES(?,?,'open',1,?,'[]',?,?,?,?,?)`).run(id, projectId, JSON.stringify(returnState), JSON.stringify(recipeDefault()), at, at, intent?.trim() ?? null, caller == null ? null : JSON.stringify(caller));
      const insert = this.db.prepare(`INSERT INTO work_session_sources(session_id,source_key,ordinal,resource_id,sheet,status,updated_at)
        VALUES(?,?,?,?,NULL,'pending',?)`);
      [...new Set(resourceIds.map(String))].forEach((resourceId, ordinal) => {
        insert.run(id, `SRC-${crypto.randomUUID()}`, ordinal, resourceId, at);
      });
      return this.byId(id);
    });
  }

  assertRevision(id, expectedRevision) {
    const value = this.byId(id);
    if (!value || value.status !== 'open') throw new Error('This Work Session is unavailable.');
    if (expectedRevision != null && Number(expectedRevision) !== value.revision) {
      throw stateConflict(id, Number(expectedRevision), value.revision);
    }
    return value;
  }

  updateReturnState(id, returnState, at) {
    this.db.prepare("UPDATE work_sessions SET return_state_json=?,updated_at=? WHERE id=? AND status='open'").run(JSON.stringify(returnState ?? {}), at, id);
    return this.byId(id);
  }

  addSource({ sessionId, resourceId, sheet = null, baseRevision = null, at }) {
    return this.transaction(() => {
      this.assertRevision(sessionId, baseRevision);
      const existing = this.db.prepare('SELECT * FROM work_session_sources WHERE session_id=? AND resource_id=? AND sheet IS ?').get(sessionId, resourceId, sheet);
      if (existing) return this.byId(sessionId);
      const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 AS value FROM work_session_sources WHERE session_id=?').get(sessionId).value);
      const sourceKey = `SRC-${crypto.randomUUID()}`;
      this.db.prepare(`INSERT INTO work_session_sources(session_id,source_key,ordinal,resource_id,sheet,status,updated_at)
        VALUES(?,?,?,?,?,'pending',?)`).run(sessionId, sourceKey, ordinal, resourceId, sheet, at);
      this.#invalidate(sessionId, at);
      return this.byId(sessionId);
    });
  }

  removeSource(sessionId, resourceId, at, baseRevision = null) {
    return this.transaction(() => {
      this.assertRevision(sessionId, baseRevision);
      const changed = this.db.prepare('DELETE FROM work_session_sources WHERE session_id=? AND resource_id=?').run(sessionId, resourceId).changes;
      if (changed) this.#invalidate(sessionId, at);
      return this.byId(sessionId);
    });
  }

  replaceSources({ sessionId, resourceIds, baseRevision, returnState = null, at }) {
    return this.transaction(() => {
      const current = this.assertRevision(sessionId, baseRevision);
      const desired = [...new Set(resourceIds.map(String))];
      const currentIds = current.sources.map((item) => item.resource_id);
      const changed = JSON.stringify(currentIds) !== JSON.stringify(desired);
      if (returnState != null) {
        this.db.prepare("UPDATE work_sessions SET return_state_json=?,updated_at=? WHERE id=? AND status='open'")
          .run(JSON.stringify(returnState), at, sessionId);
      }
      if (!changed) return this.byId(sessionId);
      this.db.prepare(`DELETE FROM work_session_sources WHERE session_id=? AND resource_id NOT IN (${desired.map(() => '?').join(',') || "''"})`)
        .run(sessionId, ...desired);
      const existing = new Map(this.db.prepare('SELECT * FROM work_session_sources WHERE session_id=?').all(sessionId).map((item) => [item.resource_id, item]));
      const insert = this.db.prepare(`INSERT INTO work_session_sources(session_id,source_key,ordinal,resource_id,sheet,status,updated_at)
        VALUES(?,?,?,?,NULL,'pending',?)`);
      const reorder = this.db.prepare('UPDATE work_session_sources SET ordinal=?,updated_at=? WHERE session_id=? AND resource_id=?');
      desired.forEach((resourceId, ordinal) => {
        if (existing.has(resourceId)) reorder.run(ordinal, at, sessionId, resourceId);
        else insert.run(sessionId, `SRC-${crypto.randomUUID()}`, ordinal, resourceId, at);
      });
      this.db.prepare(`UPDATE work_sessions SET mapping_json='[]',revision=revision+1,preview_json=NULL,preview_revision=NULL,updated_at=? WHERE id=?`)
        .run(at, sessionId);
      return this.byId(sessionId);
    });
  }

  setSheet(sessionId, sourceKey, sheet, at, baseRevision = null) {
    return this.transaction(() => {
      this.assertRevision(sessionId, baseRevision);
      const changed = this.db.prepare(`UPDATE work_session_sources SET sheet=?,fingerprint_json=NULL,profile_json=NULL,profile_processor_version=NULL,status='pending',error_message=NULL,updated_at=? WHERE session_id=? AND source_key=?`).run(sheet, at, sessionId, sourceKey).changes;
      if (changed !== 1) throw new Error('Work Source is unavailable.');
      this.#invalidate(sessionId, at);
      return this.byId(sessionId);
    });
  }

  updateSource(sessionId, sourceKey, { fingerprint = null, profile = null, processorVersion = null, status, errorMessage = null }, at) {
    this.db.prepare(`UPDATE work_session_sources SET fingerprint_json=?,profile_json=?,profile_processor_version=?,status=?,error_message=?,updated_at=? WHERE session_id=? AND source_key=?`)
      .run(fingerprint == null ? null : JSON.stringify(fingerprint), profile == null ? null : JSON.stringify(profile), processorVersion, status, errorMessage, at, sessionId, sourceKey);
    return this.byId(sessionId);
  }

  setSourceStatus(sessionId, sourceKey, status, errorMessage, at) {
    this.db.prepare('UPDATE work_session_sources SET status=?,error_message=?,updated_at=? WHERE session_id=? AND source_key=?')
      .run(status, errorMessage ?? null, at, sessionId, sourceKey);
    return this.byId(sessionId);
  }

  invalidate(id, at) {
    this.#invalidate(id, at);
    return this.byId(id);
  }

  setMapping(id, mapping, at, baseRevision = null) {
    return this.transaction(() => {
      this.assertRevision(id, baseRevision);
      this.db.prepare('UPDATE work_sessions SET mapping_json=?,revision=revision+1,preview_json=NULL,preview_revision=NULL,updated_at=? WHERE id=?').run(JSON.stringify(mapping ?? []), at, id);
      return this.byId(id);
    });
  }

  setRecipe(id, recipe, at, baseRevision = null) {
    return this.transaction(() => {
      this.assertRevision(id, baseRevision);
      this.db.prepare('UPDATE work_sessions SET recipe_json=?,revision=revision+1,preview_json=NULL,preview_revision=NULL,updated_at=? WHERE id=?').run(JSON.stringify(recipe), at, id);
      return this.byId(id);
    });
  }

  setPreview(id, preview, revision, at) {
    return this.transaction(() => {
      this.assertRevision(id, revision);
      const changed = this.db.prepare('UPDATE work_sessions SET preview_json=?,preview_revision=?,updated_at=? WHERE id=? AND revision=?')
        .run(JSON.stringify(preview), revision, at, id, revision).changes;
      if (changed !== 1) throw stateConflict(id, revision, this.byId(id)?.revision ?? null);
      return this.byId(id);
    });
  }

  setLatestSave(id, saveId, at) {
    this.db.prepare('UPDATE work_sessions SET latest_save_id=?,updated_at=? WHERE id=?').run(saveId, at, id);
    return this.byId(id);
  }

  #invalidate(id, at) {
    this.db.prepare('UPDATE work_sessions SET revision=revision+1,preview_json=NULL,preview_revision=NULL,updated_at=? WHERE id=?').run(at, id);
  }
}
