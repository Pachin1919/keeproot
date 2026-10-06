import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 64 * 1024;
const SCHEMA_VERSION = 1;
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (message, code = 'ATLAS_STATE_CONFLICT') => Object.assign(new Error(message), { code });
const text = (value, label, max = 4096) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw conflict(`${label} must be non-empty text of at most ${max} characters.`, 'ATLAS_INVALID_ARGUMENT');
  return value.trim();
};
const safeArray = (value, label, max) => {
  if (!Array.isArray(value) || value.length > max) throw conflict(`${label} must be an array with at most ${max} entries.`, 'ATLAS_INVALID_ARGUMENT');
  return value;
};
function canonical(value) { return JSON.stringify(value); }
function isoNow() { return new Date().toISOString(); }
function samePath(left, right) {
  const a = path.resolve(left); const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function noLinks(absolutePath) {
  const absolute = path.resolve(absolutePath); const volume = path.parse(absolute).root;
  let cursor = volume; let finalStat = null;
  for (const part of absolute.slice(volume.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    finalStat = fs.lstatSync(cursor);
    if (finalStat.isSymbolicLink()) throw conflict('Handoff paths cannot traverse symbolic links.');
  }
  return finalStat;
}

function normalizeRequest(projectId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw conflict('Handoff request must be an object.', 'ATLAS_INVALID_ARGUMENT');
  const allowed = new Set(['schema', 'goal', 'work_id', 'resource_ids', 'save_ids', 'rule_request', 'corrections', 'unfinished', 'caller', 'request_key']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw conflict('Handoff request contains an unsupported field.', 'ATLAS_INVALID_ARGUMENT');
  if (input.schema !== 'atlas.handoff.v1') throw conflict('Handoff schema must be atlas.handoff.v1.', 'ATLAS_INVALID_ARGUMENT');
  const goal = text(input.goal, 'Handoff goal', 1000);
  const workId = text(input.work_id, 'work_id', 128);
  const resourceIds = [...new Set(safeArray(input.resource_ids, 'resource_ids', 16).map((item) => text(item, 'resource_id', 128)))].sort();
  const saveIds = [...new Set(safeArray(input.save_ids ?? [], 'save_ids', 8).map((item) => text(item, 'save_id', 128)))].sort();
  if (!input.rule_request || typeof input.rule_request !== 'object' || Array.isArray(input.rule_request)) throw conflict('rule_request must be an object.', 'ATLAS_INVALID_ARGUMENT');
  const ruleRequest = structuredClone(input.rule_request);
  if (ruleRequest.project_id !== projectId) throw conflict('Rule request must belong to this Project.', 'ATLAS_PROJECT_MISMATCH');
  if (Buffer.byteLength(canonical(ruleRequest), 'utf8') > 8192) throw conflict('rule_request exceeds its size limit.', 'ATLAS_INVALID_ARGUMENT');
  const corrections = safeArray(input.corrections ?? [], 'corrections', 16).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw conflict('Each correction must be an object.', 'ATLAS_INVALID_ARGUMENT');
    return { text: text(item.text, 'correction.text', 1000), source: text(item.source, 'correction.source', 128) };
  });
  const unfinished = safeArray(input.unfinished ?? [], 'unfinished', 16).map((item) => text(item, 'unfinished item', 1000));
  const caller = input.caller;
  if (!caller || typeof caller !== 'object' || Array.isArray(caller)) throw conflict('caller is required.', 'ATLAS_INVALID_ARGUMENT');
  const normalizedCaller = { actor: text(caller.actor, 'caller.actor', 32), tool: text(caller.tool, 'caller.tool', 128), client_run_id: text(caller.client_run_id, 'caller.client_run_id', 128) };
  if (!['agent', 'user'].includes(normalizedCaller.actor)) throw conflict('caller.actor must be agent or user.', 'ATLAS_INVALID_ARGUMENT');
  const requestKey = text(input.request_key, 'request_key', 256);
  const payload = { schema: input.schema, goal, work_id: workId, resource_ids: resourceIds, save_ids: saveIds, rule_request: ruleRequest, corrections, unfinished, caller: normalizedCaller };
  if (Buffer.byteLength(canonical(payload), 'utf8') > MAX_BYTES) throw conflict('Handoff content exceeds 64 KiB.', 'ATLAS_INVALID_ARGUMENT');
  return { payload, requestKey, requestHash: digest(payload) };
}

export class HandoffService {
  constructor({ registry, rules, saveService, dataWork, roundRecovery, resourceControl = null }) {
    if (!registry?.ledger?.db || !rules || !saveService || !dataWork || !roundRecovery) throw new Error('HandoffService requires Registry, rules, Save, Data Work, and Round Recovery services.');
    this.registry = registry; this.db = registry.ledger.db; this.rules = rules; this.saveService = saveService;
    this.dataWork = dataWork; this.roundRecovery = roundRecovery; this.resourceControl = resourceControl;
  }

  #project(projectId) {
    const entry = this.registry.show(projectId);
    if (entry.project?.status !== 'active' || !entry.location?.root_path || entry.location.relative_path == null) throw conflict('Handoff requires an active Project with an attached local Root.');
    const rootPath = path.resolve(entry.location.root_path, ...String(entry.location.relative_path).split('/').filter(Boolean));
    const stat = noLinks(rootPath);
    if (!stat.isDirectory()) throw conflict('Project Root must be a regular directory without a link.');
    return { entry, rootPath, rootIdentity: `${stat.dev}:${stat.ino}` };
  }

  #facts(projectId, payload) {
    const { entry, rootPath, rootIdentity } = this.#project(projectId);
    const work = this.dataWork.session(payload.work_id);
    if (!work || work.project_id !== projectId || work.status !== 'open') throw conflict('Table Work is unavailable in this Project.', 'ATLAS_PROJECT_MISMATCH');
    const sources = (work.sources ?? []).map((source) => ({
      resource_id: source.resource_id, source_key: source.source_key, sheet: source.sheet ?? null,
      sha256: source.fingerprint?.sha256 ?? null, status: source.status, version_policy: source.version_policy ?? null,
    })).sort((a, b) => a.source_key.localeCompare(b.source_key));
    if (!sources.length || sources.some((source) => source.status !== 'ready' || !source.sha256)) throw conflict('All Table Work Sources must be current and ready before creating or using a Handoff.');
    const sourceIds = sources.map((source) => source.resource_id).sort();
    if (canonical(sourceIds) !== canonical(payload.resource_ids)) throw conflict('Handoff Resource IDs must exactly match the Table Work Source set.');
    const resources = sourceIds.map((resourceId) => {
      const locations = this.registry.ledger.resources.activeLocationsForResourceInProject(resourceId, projectId);
      if (locations.length !== 1) throw conflict('Each Handoff Resource must have exactly one active location in this Project.');
      const locationPath = path.resolve(locations[0].path);
      const relative = path.relative(rootPath, locationPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw conflict('A Handoff Resource path is outside its Project Root.');
      const source = sources.find((item) => item.resource_id === resourceId);
      const sourceDetail = work.sources.find((item) => item.resource_id === resourceId);
      if (!sourceDetail?.fingerprint?.file_path || !samePath(sourceDetail.fingerprint.file_path, locationPath)) throw conflict('Table Work Source and active Resource location do not match.');
      const stat = noLinks(locationPath);
      if (!stat.isFile()) throw conflict('Handoff Resources must be regular non-linked files.');
      return { resource_id: resourceId, path: relative.replaceAll('\\', '/'), status: locations[0].resource_status, sha256: source.sha256 };
    }).sort((a, b) => a.resource_id.localeCompare(b.resource_id));
    const rules = this.rules.context({ root: rootPath, request: payload.rule_request });
    const saves = payload.save_ids.map((saveId) => {
      const save = this.saveService.show(saveId);
      if (!save || save.project?.id !== projectId || save.status !== 'executed' || save.current_output !== 'verified' || save.verified !== true) throw conflict(`Save ${saveId} is not a current verified Result in this Project.`);
      return { save_id: saveId, status: save.status, resource_id: save.resource_id ?? null, result_sha256: save.verification?.sha256 ?? null, current_output: save.current_output };
    }).sort((a, b) => a.save_id.localeCompare(b.save_id));
    const recoveries = this.roundRecovery.list({ projectId }).map((round) => {
      const shown = this.roundRecovery.show({ projectId, roundId: round.round_id });
      return { round_id: round.round_id, revision: shown.revision, current_digest: shown.current_digest, pending_restore: shown.pending_restore ?? null };
    }).sort((a, b) => a.round_id.localeCompare(b.round_id));
    if (recoveries.some((round) => round.pending_restore)) throw conflict('A pending recovery blocks Handoff creation or continuation.');
    const facts = {
      project: { project_id: projectId, name: entry.project.name, updated_at: entry.project.updated_at ?? null, root_id: entry.location.root_id, relative_path: entry.location.relative_path, root_identity: rootIdentity },
      work: { work_id: work.session_id, revision: work.revision, mapping: work.mapping, recipe: work.recipe, preview_revision: work.preview_revision ?? null, sources },
      resources, rules: { context_hash: rules.context_hash }, saves, recoveries,
    };
    return { facts, work, project: entry.project, rootPath };
  }

  async create({ projectId, request }) {
    const { payload, requestKey, requestHash } = normalizeRequest(projectId, request);
    const scopedKey = `${payload.caller.tool}:${payload.caller.client_run_id}:${requestKey}`;
    const existing = this.db.prepare('SELECT * FROM handoffs WHERE project_id=? AND request_key=?').get(projectId, scopedKey);
    if (existing) {
      if (existing.request_hash !== requestHash) throw conflict('This Handoff request key was already used for different content.');
      await this.dataWork.validateSources(existing.work_id);
      return this.#view(existing, true);
    }
    const firstWork = this.dataWork.session(payload.work_id);
    if (!firstWork || firstWork.project_id !== projectId) throw conflict('Table Work is unavailable in this Project.', 'ATLAS_PROJECT_MISMATCH');
    await this.dataWork.validateSources(payload.work_id);
    const first = this.#facts(projectId, payload);
    const second = this.#facts(projectId, payload);
    if (canonical(first.facts) !== canonical(second.facts)) throw conflict('Project facts changed while preparing the Handoff.');
    const packageDigest = digest({ schema_version: SCHEMA_VERSION, payload, facts: first.facts });
    if (Buffer.byteLength(canonical(first.facts), 'utf8') > MAX_BYTES) throw conflict('Selected Handoff facts exceed 64 KiB.', 'ATLAS_INVALID_ARGUMENT');
    const id = `HOF-${crypto.randomUUID()}`;
    const createdAt = isoNow();
    const stored = this.registry.ledger.transaction(() => {
      const raced = this.db.prepare('SELECT * FROM handoffs WHERE project_id=? AND request_key=?').get(projectId, scopedKey);
      if (raced) {
        if (raced.request_hash !== requestHash) throw conflict('This Handoff request key was already used for different content.');
        return raced;
      }
      const final = this.#facts(projectId, payload);
      if (canonical(final.facts) !== canonical(first.facts)) throw conflict('Project facts changed before the Handoff could be recorded.');
      this.db.prepare(`INSERT INTO handoffs(id,project_id,work_id,schema_version,digest,request_key,request_hash,package_json,facts_json,revision,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,1,?)`).run(id, projectId, payload.work_id, SCHEMA_VERSION, packageDigest, scopedKey, requestHash, canonical(payload), canonical(first.facts), createdAt);
      return this.db.prepare('SELECT * FROM handoffs WHERE id=?').get(id);
    });
    return this.#view(stored, stored.id !== id);
  }

  #view(row, replayed) {
    const payload = JSON.parse(row.package_json);
    const initialFacts = JSON.parse(row.facts_json);
    let currentFacts = null; let status = 'current'; let reason = null; let changes = [];
    try {
      currentFacts = this.#facts(row.project_id, payload).facts;
      if (digest({ schema_version: row.schema_version, payload, facts: currentFacts }) !== row.digest) {
        status = 'stale'; reason = 'Project, Work, rule, Save, Resource, or recovery facts changed.';
        changes = ['project', 'work', 'resources', 'rules', 'saves', 'recoveries'].filter((key) => canonical(initialFacts[key]) !== canonical(currentFacts[key]));
      }
    } catch (error) { status = 'blocked'; reason = error.message; changes = ['unavailable_or_blocked']; }
    return {
      handoff_id: row.id, project_id: row.project_id, work_id: row.work_id,
      schema_version: row.schema_version, digest: row.digest, status, reason,
      created_at: row.created_at, revision: row.revision, replayed,
      goal: payload.goal, resource_ids: payload.resource_ids, save_ids: payload.save_ids,
      corrections: payload.corrections, unfinished: payload.unfinished,
      rule_request: payload.rule_request, caller: payload.caller,
      changes, work_revision: initialFacts.work.revision,
      current_work_revision: currentFacts?.work?.revision ?? null,
    };
  }

  async read({ projectId, handoffId }) {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE id=? AND project_id=?').get(handoffId, projectId);
    if (!row) throw conflict('Handoff is unavailable in this Project.', 'ATLAS_NOT_FOUND');
    await this.dataWork.validateSources(row.work_id);
    const view = this.#view(row, false);
    return { ...view, package: JSON.parse(row.package_json) };
  }

  list({ projectId, limit = 20 }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw conflict('Handoff list limit must be 1..100.', 'ATLAS_INVALID_ARGUMENT');
    const rows = this.db.prepare('SELECT * FROM handoffs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(projectId, limit);
    return { project_id: projectId, handoffs: rows.map((row) => this.#view(row, false)) };
  }

  assertFocus({ projectId, handoffId, expectedDigest, workId, baseRevision }) {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE id=? AND project_id=?').get(handoffId, projectId);
    if (!row || row.work_id !== workId || row.digest !== expectedDigest) throw conflict('Handoff identity or digest does not match this Project Work.');
    const payload = JSON.parse(row.package_json);
    const { facts, work } = this.#facts(projectId, payload);
    if (work.revision !== baseRevision || digest({ schema_version: row.schema_version, payload, facts }) !== row.digest) throw conflict('Handoff is stale; create a new Handoff before continuing.');
    return true;
  }
}

export function createHandoffService(options) { return new HandoffService(options); }
