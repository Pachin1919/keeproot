import crypto from 'node:crypto';
import { assertRecoveryWritable } from '../recovery-write-guard.js';

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
    version_policy: row.version_policy ?? 'follow_latest',
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
    reused_from_session_id: row.reused_from_session_id ?? null,
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
    assertRecoveryWritable(this.db, { projectId });
    for (const resourceId of resourceIds) assertRecoveryWritable(this.db, { resourceId });
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

  reuse({ sourceSessionId, baseRevision, sourceAssignments = null, intent = null, caller = null, at }) {
    if (intent != null && (typeof intent !== 'string' || !intent.trim() || intent.length > 500)) throw new Error('Work goal must be non-empty text of at most 500 characters.');
    return this.transaction(() => {
      const sourceSession = this.assertRevision(sourceSessionId, baseRevision);
      for (const source of sourceAssignments ?? sourceSession.sources) assertRecoveryWritable(this.db, { resourceId: source.resource_id });
      const id = `DWT-${crypto.randomBytes(16).toString('hex')}`;
      this.db.prepare(`INSERT INTO work_sessions(
          id,project_id,status,revision,return_state_json,mapping_json,recipe_json,
          preview_json,preview_revision,latest_save_id,created_at,updated_at,intent,caller_json,reused_from_session_id
        ) VALUES(?,?,'open',1,?,?,?,NULL,NULL,NULL,?,?,?,?,?)`)
        .run(
          id,
          sourceSession.project_id,
          JSON.stringify(sourceSession.return_state ?? {}),
          JSON.stringify(sourceSession.mapping ?? []),
          JSON.stringify(sourceSession.recipe ?? recipeDefault()),
          at,
          at,
          intent?.trim() ?? sourceSession.intent ?? null,
          caller == null ? null : JSON.stringify(caller),
          sourceSessionId,
        );
      const insertSource = this.db.prepare(`INSERT INTO work_session_sources(
          session_id,source_key,ordinal,resource_id,sheet,fingerprint_json,profile_json,
          profile_processor_version,version_policy,status,error_message,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      const assignments = sourceAssignments == null
        ? null
        : new Map(sourceAssignments.map((item) => [item.source_key, item]));
      for (const item of sourceSession.sources) {
        const assignment = assignments?.get(item.source_key) ?? null;
        const resourceChanged = assignment != null && assignment.resource_id !== item.resource_id;
        insertSource.run(
          id,
          item.source_key,
          item.ordinal,
          assignment?.resource_id ?? item.resource_id,
          assignment?.sheet ?? item.sheet,
          resourceChanged ? null : item.fingerprint == null ? null : JSON.stringify(item.fingerprint),
          item.profile == null ? null : JSON.stringify(item.profile),
          item.profile_processor_version,
          resourceChanged ? 'follow_latest' : item.version_policy ?? 'follow_latest',
          resourceChanged ? 'pending' : item.status,
          resourceChanged ? null : item.error_message,
          at,
        );
      }
      return this.byId(id);
    });
  }

  rebindSourceMapping(sessionId, sourceKey, { sha256, sheet = null }, at) {
    assertRecoveryWritable(this.db, { workId: sessionId });
    if (!sha256) throw new Error('Prepared Source hash is required before reusing its field alignment.');
    return this.transaction(() => {
      const current = this.byId(sessionId);
      if (!current || current.status !== 'open') throw new Error('This Work Session is unavailable.');
      const mapping = current.mapping.map((item) => item.source_key === sourceKey
        ? { ...item, source_sha256: sha256, source_sheet: sheet }
        : item);
      this.db.prepare('UPDATE work_sessions SET mapping_json=?,updated_at=? WHERE id=? AND status=\'open\'')
        .run(JSON.stringify(mapping), at, sessionId);
      return this.byId(sessionId);
    });
  }

  assertRevision(id, expectedRevision) {
    assertRecoveryWritable(this.db, { workId: id });
    const value = this.byId(id);
    if (!value || value.status !== 'open') throw new Error('This Work Session is unavailable.');
    if (expectedRevision != null && Number(expectedRevision) !== value.revision) {
      throw stateConflict(id, Number(expectedRevision), value.revision);
    }
    return value;
  }

  updateReturnState(id, returnState, at) {
    assertRecoveryWritable(this.db, { workId: id });
    this.db.prepare("UPDATE work_sessions SET return_state_json=?,updated_at=? WHERE id=? AND status='open'").run(JSON.stringify(returnState ?? {}), at, id);
    return this.byId(id);
  }

  addSource({ sessionId, resourceId, sheet = null, baseRevision = null, at }) {
    return this.transaction(() => {
      assertRecoveryWritable(this.db, { resourceId });
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
      for (const resourceId of desired) assertRecoveryWritable(this.db, { resourceId });
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
    assertRecoveryWritable(this.db, { workId: sessionId });
    this.db.prepare(`UPDATE work_session_sources SET fingerprint_json=?,profile_json=?,profile_processor_version=?,status=?,error_message=?,updated_at=? WHERE session_id=? AND source_key=?`)
      .run(fingerprint == null ? null : JSON.stringify(fingerprint), profile == null ? null : JSON.stringify(profile), processorVersion, status, errorMessage, at, sessionId, sourceKey);
    return this.byId(sessionId);
  }

  setSourceStatus(sessionId, sourceKey, status, errorMessage, at) {
    assertRecoveryWritable(this.db, { workId: sessionId });
    this.db.prepare('UPDATE work_session_sources SET status=?,error_message=?,updated_at=? WHERE session_id=? AND source_key=?')
      .run(status, errorMessage ?? null, at, sessionId, sourceKey);
    return this.byId(sessionId);
  }

  setSourceVersionPolicy(sessionId, sourceKey, versionPolicy, at, baseRevision = null) {
    if (!['follow_latest', 'pinned_version'].includes(versionPolicy)) throw new Error('Choose follow latest or pin recorded version.');
    return this.transaction(() => {
      this.assertRevision(sessionId, baseRevision);
      const current = this.db.prepare('SELECT version_policy FROM work_session_sources WHERE session_id=? AND source_key=?').get(sessionId, sourceKey);
      if (!current) throw new Error('Work Source is unavailable.');
      if ((current.version_policy ?? 'follow_latest') === versionPolicy) return this.byId(sessionId);
      this.db.prepare('UPDATE work_session_sources SET version_policy=?,updated_at=? WHERE session_id=? AND source_key=?')
        .run(versionPolicy, at, sessionId, sourceKey);
      this.#invalidate(sessionId, at);
      return this.byId(sessionId);
    });
  }

  adoptSourceVersion(sessionId, sourceKey, { fingerprint, profile, processorVersion = null, status, errorMessage = null }, at, baseRevision = null) {
    if (!fingerprint?.sha256 || !fingerprint?.file_path) throw new Error('Current Source facts are unavailable.');
    return this.transaction(() => {
      const currentSession = this.assertRevision(sessionId, baseRevision);
      const changed = this.db.prepare(`UPDATE work_session_sources
        SET fingerprint_json=?,profile_json=?,profile_processor_version=?,version_policy='follow_latest',status=?,error_message=?,updated_at=?
        WHERE session_id=? AND source_key=?`)
        .run(JSON.stringify(fingerprint), profile == null ? null : JSON.stringify(profile), processorVersion, status, errorMessage, at, sessionId, sourceKey).changes;
      if (changed !== 1) throw new Error('Work Source is unavailable.');
      const mapping = currentSession.mapping.map((item) => ({ ...item, source_sha256: null, source_sheet: null }));
      this.db.prepare('UPDATE work_sessions SET mapping_json=? WHERE id=?').run(JSON.stringify(mapping), sessionId);
      this.#invalidate(sessionId, at);
      return this.byId(sessionId);
    });
  }

  applySourceReconciliations(sessionId, sourceKeys, decision, { updates = [] } = {}, at, baseRevision = null) {
    const selected = [...new Set((sourceKeys ?? []).map(String))];
    if (!selected.length) throw new Error('Choose at least one Work Source to reconcile.');
    if (!['pin-recorded', 'follow-latest', 'use-current', 'stop-using'].includes(decision)) {
      throw new Error('Choose use-current, pin-recorded, follow-latest, or stop-using.');
    }
    return this.transaction(() => {
      const currentSession = this.assertRevision(sessionId, baseRevision);
      const currentKeys = new Set(currentSession.sources.map((item) => item.source_key));
      if (selected.some((sourceKey) => !currentKeys.has(sourceKey))) throw new Error('Work Source is unavailable.');
      let mapping = currentSession.mapping;

      if (decision === 'stop-using') {
        if (selected.length >= currentSession.sources.length) throw new Error('Work needs at least one Source.');
        const remove = this.db.prepare('DELETE FROM work_session_sources WHERE session_id=? AND source_key=?');
        for (const sourceKey of selected) remove.run(sessionId, sourceKey);
        mapping = mapping.filter((item) => !selected.includes(item.source_key));
      } else if (decision === 'pin-recorded' || decision === 'follow-latest') {
        const versionPolicy = decision === 'pin-recorded' ? 'pinned_version' : 'follow_latest';
        const updatePolicy = this.db.prepare('UPDATE work_session_sources SET version_policy=?,updated_at=? WHERE session_id=? AND source_key=?');
        for (const sourceKey of selected) updatePolicy.run(versionPolicy, at, sessionId, sourceKey);
      } else {
        const byKey = new Map(updates.map((item) => [String(item.sourceKey), item]));
        const updateSource = this.db.prepare(`UPDATE work_session_sources
          SET fingerprint_json=?,profile_json=?,profile_processor_version=?,version_policy='follow_latest',status=?,error_message=?,updated_at=?
          WHERE session_id=? AND source_key=?`);
        for (const sourceKey of selected) {
          const update = byKey.get(sourceKey);
          if (!update?.fingerprint?.sha256 || !update?.fingerprint?.file_path) throw new Error('Current Source facts are unavailable.');
          const changed = updateSource.run(
            JSON.stringify(update.fingerprint),
            update.profile == null ? null : JSON.stringify(update.profile),
            update.processorVersion ?? null,
            update.status,
            update.errorMessage ?? null,
            at,
            sessionId,
            sourceKey,
          ).changes;
          if (changed !== 1) throw new Error('Work Source is unavailable.');
          mapping = mapping.map((item) => item.source_key !== sourceKey ? item : {
            ...item,
            source_sha256: update.mappingCompatible ? update.fingerprint.sha256 : null,
            source_sheet: update.mappingCompatible ? (update.sheet ?? null) : null,
          });
        }
      }

      this.db.prepare(`UPDATE work_sessions
        SET mapping_json=?,revision=revision+1,preview_json=NULL,preview_revision=NULL,updated_at=?
        WHERE id=? AND status='open'`)
        .run(JSON.stringify(mapping), at, sessionId);
      return this.byId(sessionId);
    });
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
    assertRecoveryWritable(this.db, { workId: id });
    this.db.prepare('UPDATE work_sessions SET latest_save_id=?,updated_at=? WHERE id=?').run(saveId, at, id);
    return this.byId(id);
  }

  #invalidate(id, at) {
    assertRecoveryWritable(this.db, { workId: id });
    this.db.prepare('UPDATE work_sessions SET revision=revision+1,preview_json=NULL,preview_revision=NULL,updated_at=? WHERE id=?').run(at, id);
  }
}
