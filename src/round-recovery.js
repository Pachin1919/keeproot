import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Registry } from './registry.js';
import { isPathInside } from './paths.js';
import { captureBlob, sha256Buffer, sha256File } from './snapshots.js';
import { withStateLock } from './state-lock.js';
import { assertDocumentUpdatesSettled } from './storage/recovery-write-guard.js';
import { captureProductState, expandSaveScope, productState, restoreProductState, validateProductTransition } from './round-product-state.js';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const digest = (value) => sha256Buffer(Buffer.from(JSON.stringify(value)));
const fail = (message, code = 'ATLAS_RECOVERY_CONFLICT') => {
  const error = new Error(message); error.code = code; throw error;
};
const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) fail(`${field} is required (maximum 500 characters).`);
  return value.trim();
};

// Explicit regular files only. Check every ancestor, including junctions above
// the Project/Runtime; realpath alone would silently accept an in-root link.
function noLinks(absolute, allowAbsentLeaf = false) {
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT' && allowAbsentLeaf && index === parts.length - 1) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`Links or junctions are unsupported: ${cursor}`);
    if (index < parts.length - 1 && !stat.isDirectory()) fail(`Expected a directory: ${cursor}`);
    if (index === parts.length - 1) return stat;
  }
  return fs.lstatSync(absolute);
}

export class RoundRecovery {
  constructor({ stateDir, registry = null }) {
    this.stateDir = path.resolve(stateDir);
    // Registry may create the directory; validate its nearest existing ancestor first.
    let ancestor = this.stateDir;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    noLinks(ancestor);
    this.registry = registry ?? new Registry({ stateDir: this.stateDir });
    this.ownsRegistry = registry == null;
    if (path.resolve(this.registry.stateDir) !== this.stateDir) fail('Registry and recovery must use the same Runtime state.');
    this.ledger = this.registry.ledger;
    this.db = this.ledger.db;
  }

  dispose() { if (this.ownsRegistry) this.registry.dispose(); }

  #project(projectId) {
    const project = this.registry.list().find((item) => item.id === projectId && item.status === 'active');
    if (!project) fail('Project is unavailable.');
    const location = this.registry.show(projectId).location;
    if (!location?.root_path || location.relative_path == null) fail('Project needs an attached local root.');
    const root = path.resolve(location.root_path, location.relative_path);
    if (!isPathInside(path.resolve(location.root_path), root)) fail('Project root escapes its Workspace.');
    const stat = noLinks(root);
    if (!stat.isDirectory()) fail('Project root is not a directory.');
    return { root, identity: `${stat.dev}:${stat.ino}` };
  }

  #path(round, relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) fail('Use explicit Project-relative file paths.');
    const normalized = relative.replaceAll('\\', '/');
    const parts = normalized.split('/');
    if (parts.some((part) => !part || ['.', '..', '.atlas', '.git'].includes(part.toLowerCase()) || /[:<>"|?*\x00-\x1f]|[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail(`Unsupported or escaping file path: ${relative}`);
    const absolute = path.resolve(round.root, ...parts);
    if (!isPathInside(round.root, absolute) || isPathInside(this.stateDir, absolute)) fail('Recovery path crosses a protected boundary.');
    for (const project of this.registry.list()) {
      if (project.id === round.project_id || project.status !== 'active') continue;
      const location = this.registry.show(project.id).location;
      if (!location?.root_path || location.relative_path == null) continue;
      const otherRoot = path.resolve(location.root_path, location.relative_path);
      if (isPathInside(round.root, otherRoot) && isPathInside(otherRoot, absolute)) fail('Recovery path belongs to another registered Project.');
    }
    const stat = noLinks(absolute, true);
    if (stat && (!stat.isFile() || stat.nlink > 1)) fail('Only ordinary, non-hardlinked files are supported.');
    return { absolute, stat, relative: normalized };
  }

  #checkRoot(round) {
    const current = this.#project(round.project_id);
    if (current.root !== round.root || current.identity !== round.root_identity) fail('Project location changed; recovery is blocked.');
    noLinks(this.stateDir);
    for (const sub of ['blobs', 'tmp', 'locks']) {
      const target = path.join(this.stateDir, sub);
      if (fs.existsSync(target)) noLinks(target);
    }
    if (fs.existsSync(path.join(this.stateDir, 'blobs/sha256'))) noLinks(path.join(this.stateDir, 'blobs/sha256'));
  }

  #read(projectId, roundId) {
    const row = this.db.prepare('SELECT * FROM recovery_rounds WHERE id=? AND project_id=?').get(roundId, projectId);
    if (!row) fail('Round is unavailable in this Project.');
    const round = JSON.parse(row.state_json);
    this.#checkRoot(round);
    return round;
  }

  #save(round, insert = false) {
    round.updated_at = now();
    if (insert) this.db.prepare('INSERT INTO recovery_rounds(id,project_id,revision,state_json,updated_at) VALUES(?,?,?,?,?)')
      .run(round.round_id, round.project_id, round.revision, JSON.stringify(round), round.updated_at);
    else this.db.prepare('UPDATE recovery_rounds SET revision=?,state_json=?,updated_at=? WHERE id=?')
      .run(round.revision, JSON.stringify(round), round.updated_at, round.round_id);
  }

  #caller(args) {
    if (!args.caller || !['agent', 'user'].includes(args.caller.actor)) fail('caller.actor must be agent or user.');
    text(args.caller.tool, 'caller.tool'); text(args.caller.client_run_id, 'caller.client_run_id');
  }

  #request(action, args) {
    const allowed = ['projectId', 'requestKey', 'caller', ...(action === 'protect'
      ? ['paths', 'boardIds', 'resourceIds', 'workIds', 'saveIds', 'saveTargets', 'saveTarget', 'resourceId', 'label', 'protectionBasis']
      : ['roundId', 'baseRevision', 'expectedDigest', ...(action === 'extend' ? ['paths', 'boardIds', 'resourceIds', 'workIds', 'saveIds', 'saveTargets', 'label'] : action === 'checkpoint' ? ['label'] : action === 'return' ? ['restoreId'] : ['nodeId'])])];
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !allowed.includes(key))) fail('Unknown or unsupported round request field.');
    this.#caller(args); text(args.requestKey, 'requestKey');
    return { key: args.requestKey, hash: digest({ action, ...args }) };
  }

  #retry(round, request) {
    const previous = round.requests.find((item) => item.key === request.key);
    if (!previous) return null;
    if (previous.hash !== request.hash) fail('requestKey already belongs to a different payload.');
    return { ...this.#view(round), ...previous.receipt, replayed: true };
  }

  #board(round, boardId) {
    const board = this.ledger.boards.byId(boardId);
    if (!board || board.project_id !== round.project_id) fail('Board is unavailable in this Project.');
    for (const block of board.blocks) {
      if (block.type === 'text') continue;
      if (block.type === 'material_reference') {
        if (!(round.resource_ids ?? []).includes(block.resource_id)) fail('Declare every Board reference Resource and its file in the protected scope.');
      } else if (block.type === 'result_preview') {
        if (!(round.save_ids ?? []).includes(block.save_id)) fail('Declare every Board Result Save in the protected scope.');
      } else fail('Unsupported Board block in recovery.');
    }
    return { board_id: boardId, title: board.title, blocks: board.blocks, revision: board.revision };
  }

  #facts(round, capture = false) {
    this.#checkRoot(round);
    round = expandSaveScope(round, this.stateDir);
    let total = 0;
    const files = round.paths.map((relative) => {
      const { absolute, stat } = this.#path(round, relative);
      const locations = this.db.prepare('SELECT resource_id FROM resource_locations WHERE path=? COLLATE NOCASE').all(absolute);
      if (locations.some((location) => !(round.resource_ids ?? []).includes(location.resource_id))) fail('Declare every Resource identity explicitly before protecting its file.');
      if (!stat) return { path: relative, sha256: null, bytes: 0 };
      total += stat.size;
      if (stat.size > 32 * 1024 * 1024 || total > 128 * 1024 * 1024) fail('Recovery file budget exceeded (32 MiB per file, 128 MiB total).');
      const blob = capture ? captureBlob(absolute, this.stateDir) : null;
      if (blob) this.#blob(blob.contentHash);
      return { path: relative, sha256: blob?.contentHash ?? sha256File(absolute), bytes: blob?.byteSize ?? stat.size };
    });
    const boards = round.board_ids.map((boardId) => this.#board(round, boardId));
    const typed = captureProductState({ round, ledger: this.ledger, stateDir: this.stateDir, resolvePath: (name) => this.#path(round, name) });
    return { files, boards, ...typed };
  }

  #blob(hash) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) fail('Invalid snapshot hash.');
    const target = path.join(this.stateDir, 'blobs/sha256', hash);
    const stat = noLinks(target);
    if (!stat.isFile() || stat.nlink > 1 || sha256File(target) !== hash) fail('Snapshot blob is missing or corrupt.');
    return target;
  }

  #capture(round, expectedDigest) {
    const before = this.#facts(round);
    if (expectedDigest != null && digest(before) !== expectedDigest) fail('Files or Board changed since readback. Read the current round again.');
    const captured = this.#facts(round, true);
    if (digest(captured) !== digest(before) || digest(this.#facts(round)) !== digest(before)) fail('State changed during checkpoint capture.');
    return captured;
  }

  #node(round, kind, label, state, parent = round.head_node_id) {
    if (round.nodes.length >= 200) fail('Round node limit reached; history has not been deleted.');
    const node = { node_id: id('NODE'), parent_node_id: parent, kind, label, created_at: now(), state };
    round.nodes.push(node); return node;
  }

  #view(round) {
    const current = this.#facts(round);
    const head = this.#effectiveState(round, round.nodes[0]);
    return {
      round_id: round.round_id, project_id: round.project_id, revision: round.revision,
      label: round.label, head_node_id: round.head_node_id,
      paths: round.paths, board_ids: round.board_ids,
      resource_ids: current.resources.map((item) => item.resource_id), work_ids: round.work_ids ?? [], save_ids: current.saves.map((item) => item.save_id), save_targets: round.save_targets ?? [],
      current_digest: digest(current), current_files: current.files, pending_restore: round.pending_restore,
      changed_files: current.files.filter((file) => file.sha256 !== head.files.find((item) => item.path === file.path)?.sha256),
      scope_extensions: round.scope_extensions ?? [],
      capacity: { nodes_used: round.nodes.length, nodes_limit: 200, files_limit: 64, bytes_limit: 128 * 1024 * 1024 },
      nodes: round.nodes.map(({ state, ...node }) => ({ ...node, files: state.files, board_ids: state.boards.map((board) => board.board_id) })),
      restores: round.restores,
      scope_notice: 'Experimental: only explicitly protected files and related Resource, Work, Save and Board state. New Save outputs require an absent saveTargets slot protected before creation. Original Save receipts remain unchanged; Save Undo/Redo transitions, editor buffers and Host conversation are not restored.',
    };
  }

  show({ projectId, roundId }) { return this.#view(this.#read(projectId, roundId)); }
  preview({ projectId, roundId, baseRevision, expectedDigest, action, nodeId, restoreId }) {
    const round = this.#read(projectId, roundId);
    this.#ready(round, { baseRevision, expectedDigest });
    if (!['restore', 'return'].includes(action)) fail('Unsupported recovery preview.');
    const selectedId = action === 'return'
      ? round.restores.find((entry) => entry.restore_id === restoreId && entry.status === 'completed')?.return_node_id : nodeId;
    const node = round.nodes.find((item) => item.node_id === selectedId);
    if (!node) fail('Requested recovery node is unavailable.');
    const target = this.#effectiveState(round, node); const current = this.#facts(round);
    validateProductTransition(target, current);
    for (const file of target.files) if (file.sha256) this.#blob(file.sha256);
    return { action, node_id: node.node_id, restore_id: restoreId ?? '', base_revision: baseRevision, expected_digest: expectedDigest,
      files: target.files.filter((file) => file.sha256 !== current.files.find((item) => item.path === file.path)?.sha256)
        .map((file) => ({ path: file.path, change: file.sha256 == null ? 'remove (insured)' : current.files.find((item) => item.path === file.path).sha256 == null ? 'restore file' : 'replace content' })),
      board_count: target.boards.length, work_count: target.works.length, resource_count: target.resources.length };
  }
  list({ projectId }) {
    this.#project(projectId);
    return this.db.prepare('SELECT state_json FROM recovery_rounds WHERE project_id=? ORDER BY updated_at DESC').all(projectId)
      .map(({ state_json }) => { const r = JSON.parse(state_json); return { round_id: r.round_id, label: r.label, revision: r.revision, pending_restore: r.pending_restore, updated_at: r.updated_at }; });
  }

  protectedRoundsForSave({ projectId, saveId, targetPath }) {
    const rows = this.db.prepare(`SELECT state_json FROM recovery_rounds AS round WHERE project_id=? AND (
      EXISTS (SELECT 1 FROM json_each(round.state_json, '$.save_ids') WHERE value=?) OR
      EXISTS (SELECT 1 FROM json_each(round.state_json, '$.save_targets') WHERE value=?)
    ) ORDER BY updated_at DESC LIMIT 8`).all(projectId, saveId, targetPath ?? '');
    return rows.flatMap(({ state_json }) => {
      try {
        const round = JSON.parse(state_json);
        this.#checkRoot(round);
        return [{ round_id: round.round_id, label: round.label, revision: round.revision }];
      } catch { return []; } // A stale Round must not prevent the Save receipt from opening.
    });
  }

  #saveTargetBasis(projectRoot, relative, extensions = ['csv', 'xlsx']) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) fail('Use one Project-relative Save output file.');
    const normalized = relative.replaceAll('\\', '/');
    if (!extensions.some((extension) => normalized.toLowerCase().endsWith(`.${extension}`))) fail(`Save output must be one ${extensions.map((extension) => extension.toUpperCase()).join(' or ')} file.`);
    const parts = normalized.split('/');
    if (parts.some((part) => !part || ['.', '..', '.atlas', '.git'].includes(part.toLowerCase()))) fail('Save output path is unsupported.');
    const target = path.resolve(projectRoot, ...parts);
    if (!isPathInside(projectRoot, target)) fail('Save output is outside this Project.');
    const identities = [];
    let cursor = projectRoot;
    const rootStat = noLinks(cursor);
    identities.push({ path: '.', dev: String(rootStat.dev), ino: String(rootStat.ino) });
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      const stat = noLinks(cursor);
      if (!stat.isDirectory()) fail('Save output parent must be an existing directory.');
      identities.push({ path: path.relative(projectRoot, cursor).split(path.sep).join('/'), dev: String(stat.dev), ino: String(stat.ino) });
    }
    const leaf = noLinks(target, true);
    if (leaf) fail('Save output target must not exist.');
    return { target: normalized, identities };
  }

  previewProtect({ projectId, workId = null, resourceId = null, label, saveTarget = null }) {
    const project = this.#project(projectId);
    const cleanLabel = text(label, 'label');
    const resources = [];
    const paths = [];
    let work = null;
    let selectedResources = [];
    let slot = null;
    if (resourceId != null) {
      if (workId != null || !saveTarget) fail('Resource-only protection requires one Resource and one absent Save target.');
      work = null;
      selectedResources = [String(resourceId)];
      const detail = this.ledger.resources.describe(resourceId);
      if (!detail || detail.locations.length !== 1) fail('Work Source requires one active Resource location.');
      const location = detail.locations[0];
      if (location.status !== 'active' || location.project_id !== projectId || !isPathInside(project.root, location.path)) fail('Work Source Resource is unavailable in this Project.');
      if (path.extname(location.path).toLowerCase() !== '.txt') fail('Module protection supports one registered .txt Resource.');
      const relative = path.relative(project.root, location.path).split(path.sep).join('/');
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) fail('Work Source path is outside the Project.');
      paths.push(relative);
      resources.push({ resource_id: resourceId, path: relative, location: structuredClone(location) });
      if (this.db.prepare('SELECT session_id FROM work_session_sources WHERE resource_id=? LIMIT 1').get(resourceId)) fail('Resource-only protection does not include existing Work dependencies.');
      if (this.db.prepare('SELECT save_id FROM resource_save_links WHERE resource_id=? LIMIT 1').get(resourceId)) fail('Resource-only protection does not include existing Save dependencies.');
      if (this.db.prepare('SELECT blocks_json FROM project_boards').all().some(({ blocks_json }) => JSON.parse(blocks_json).some((block) => block.resource_id === resourceId))) fail('Resource-only protection does not include existing Board dependencies.');
      if (detail.relationships?.some((relation) => relation.status === 'active')) fail('Resource-only protection does not include existing Resource relationships.');
      slot = this.#saveTargetBasis(project.root, saveTarget, ['txt']);
    } else {
      work = this.ledger.workSessions.byId(workId);
      if (!work || work.project_id !== projectId || work.status !== 'open') fail('Protection requires an open Work in this Project.');
      if (!Array.isArray(work.sources) || !work.sources.length) fail('Work has no complete Source scope to protect.');
      selectedResources = work.sources.map((source) => source.resource_id);
      for (const source of work.sources) {
        const detail = this.ledger.resources.describe(source.resource_id);
        if (!detail || detail.locations.length !== 1) fail('Work Source requires one active Resource location.');
        const location = detail.locations[0];
        if (location.status !== 'active' || location.project_id !== projectId || !isPathInside(project.root, location.path)) fail('Work Source Resource is unavailable in this Project.');
        const relative = path.relative(project.root, location.path).split(path.sep).join('/');
        if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) fail('Work Source path is outside the Project.');
        paths.push(relative);
        resources.push({ resource_id: source.resource_id, path: relative, location: structuredClone(location) });
      }
      if (saveTarget != null) slot = this.#saveTargetBasis(project.root, saveTarget);
    }
    const scope = {
      paths: [...new Set([...paths, ...(slot ? [slot.target] : [])])].sort(),
      resourceIds: [...new Set(selectedResources)].sort(),
      workIds: work ? [work.session_id] : [], boardIds: [], saveIds: [], saveTargets: slot ? [slot.target] : [],
    };
    const draft = { project_id: projectId, root: project.root, root_identity: project.identity,
      paths: scope.paths, resource_ids: scope.resourceIds, work_ids: scope.workIds, board_ids: [], save_ids: [], save_targets: [] };
    const facts = this.#facts(draft);
    if (resourceId != null && facts.files.find((file) => file.path === resources[0].path)?.sha256 !== resources[0].location.content_hash) {
      fail('Resource content changed since registration; review it again.');
    }
    const factsDigest = digest(facts);
    const bindingDigest = digest({ projectId, root: project.root, root_identity: project.identity, scope, label: cleanLabel, save_target_basis: slot,
      work: work ? { session_id: work.session_id, project_id: work.project_id, status: work.status, revision: work.revision, sources: work.sources } : null,
      resources, files: facts.files, facts });
    return { scope, label: cleanLabel, work_id: work?.session_id ?? null, work_revision: work?.revision ?? null,
      resource_id: resourceId, sources: work?.sources ?? [], resources: resources.map(({ resource_id, path: relative }) => ({ resource_id, path: relative })),
      files: facts.files, save_target: slot ? slot.target : null, save_target_basis: slot,
      protection_basis: { root: project.root, root_identity: project.identity, facts_digest: factsDigest, binding_digest: bindingDigest, save_target_basis: slot } };
  }

  protect(args) {
    const request = this.#request('protect', args);
    return withStateLock(this.stateDir, () => {
      assertDocumentUpdatesSettled(this.stateDir, args.projectId);
      const project = this.#project(args.projectId);
      for (const row of this.db.prepare('SELECT state_json FROM recovery_rounds WHERE project_id=?').all(args.projectId)) {
        const other = JSON.parse(row.state_json);
        const retry = this.#retry(other, request); if (retry) return retry;
        if (other.pending_restore) fail('Project has an incomplete recovery. Resume it first.');
      }
      if (!Array.isArray(args.paths) || args.paths.length > 64 || !Array.isArray(args.boardIds ?? []) || (args.boardIds ?? []).length > 10 || !args.paths.length && !(args.boardIds ?? []).length) fail('Declare 1–64 files and/or up to 10 existing Boards.');
      for (const [key, limit] of [['resourceIds', 64], ['workIds', 20], ['saveIds', 64], ['saveTargets', 64]]) {
        if (!Array.isArray(args[key] ?? []) || (args[key] ?? []).length > limit || (args[key] ?? []).some((value) => typeof value !== 'string' || !value)) fail(`Invalid ${key} scope.`);
      }
      if (args.resourceId && (!args.protectionBasis || !args.saveTarget || (args.resourceIds ?? []).length !== 1
          || args.resourceIds[0] !== args.resourceId || (args.workIds ?? []).length || (args.boardIds ?? []).length
          || (args.saveIds ?? []).length || (args.saveTargets ?? []).some((target) => target !== args.saveTarget))) {
        fail('Resource-only protection requires a reviewed single Resource, no Work/Board/Save dependencies, and one absent TXT target.');
      }
      const round = { round_id: id('RND'), project_id: args.projectId, root: project.root, root_identity: project.identity,
        paths: [], board_ids: [...new Set(args.boardIds ?? [])].sort(), label: text(args.label, 'label'),
        resource_ids: [...new Set(args.resourceIds ?? [])].sort(), work_ids: [...new Set(args.workIds ?? [])].sort(), save_ids: [...new Set(args.saveIds ?? [])].sort(),
        save_targets: [],
        revision: 1, head_node_id: null, nodes: [], restores: [], requests: [], pending_restore: null };
      const requestedPaths = [...new Set([...(args.paths ?? []), ...(args.saveTarget ? [args.saveTarget] : [])])];
      round.paths = requestedPaths.map((relative) => this.#path(round, relative).relative).sort();
      if (new Set(round.paths.map((entry) => entry.toLowerCase())).size !== round.paths.length) fail('Duplicate paths are not supported.');
      round.save_targets = [...new Set([...(args.saveTargets ?? []), ...(args.saveTarget ? [args.saveTarget] : [])])].map((name) => {
        const checked = this.#path(round, name);
        if (!round.paths.includes(checked.relative) || checked.stat) fail('Save output slots must be absent files explicitly declared in paths before Save creation.');
        return checked.relative;
      });
      if (expandSaveScope(round, this.stateDir).created_save_ids.length) fail('Declare output slots before any Save exists for their paths.');
      let expectedDigest;
      if (args.protectionBasis) {
        const reviewed = this.previewProtect({ projectId: args.projectId, ...(args.resourceId ? { resourceId: args.resourceId } : { workId: round.work_ids[0] }), label: round.label, saveTarget: args.saveTarget ?? null });
        const scopeMatches = digest({ paths: round.paths, resourceIds: round.resource_ids, workIds: round.work_ids, boardIds: round.board_ids, saveIds: round.save_ids, saveTargets: round.save_targets })
          === digest(reviewed.scope);
        if (!scopeMatches || digest(args.protectionBasis) !== digest(reviewed.protection_basis)) fail('Protection preview changed. Review the current Work again.');
        expectedDigest = args.protectionBasis.facts_digest;
      }
      const baseline = this.#node(round, 'before', round.label, this.#capture(round, expectedDigest));
      round.head_node_id = baseline.node_id;
      round.requests.push({ ...request, caller: args.caller, receipt: {} });
      this.#save(round, true);
      return this.#view(round);
    });
  }

  #ready(round, args) {
    if (round.pending_restore) fail('Recovery is incomplete. Resume it before making another node.');
    if (this.db.prepare("SELECT id FROM recovery_rounds WHERE project_id=? AND json_extract(state_json,'$.pending_restore') IS NOT NULL LIMIT 1").get(round.project_id)) fail('Project recovery is incomplete. Resume it first.');
    if (!Number.isInteger(args.baseRevision) || args.baseRevision !== round.revision) fail('Round revision changed. Read the current round again.');
    if (typeof args.expectedDigest !== 'string' || digest(this.#facts(round)) !== args.expectedDigest) fail('Files or Board changed since readback.');
  }

  checkpoint(args) {
    const request = this.#request('checkpoint', args);
    return withStateLock(this.stateDir, () => {
      assertDocumentUpdatesSettled(this.stateDir, args.projectId);
      const round = this.#read(args.projectId, args.roundId);
      const retry = this.#retry(round, request); if (retry) return retry;
      this.#ready(round, args);
      const state = this.#capture(round, args.expectedDigest);
      const current = round.nodes.find((node) => node.node_id === round.head_node_id);
      const unchanged = digest(current.state) === digest(state);
      if (!unchanged) round.head_node_id = this.#node(round, 'checkpoint', text(args.label, 'label'), state).node_id;
      round.revision++;
      round.requests.push({ ...request, caller: args.caller, receipt: { unchanged } });
      this.#save(round);
      return { ...this.#view(round), unchanged };
    });
  }

  extend(args) {
    const request = this.#request('extend', args);
    return withStateLock(this.stateDir, () => {
      assertDocumentUpdatesSettled(this.stateDir, args.projectId);
      const round = this.#read(args.projectId, args.roundId);
      const retry = this.#retry(round, request); if (retry) return retry;
      this.#ready(round, args);
      const old = structuredClone(round);
      for (const [input, field, limit] of [['paths', 'paths', 64], ['boardIds', 'board_ids', 10], ['resourceIds', 'resource_ids', 64], ['workIds', 'work_ids', 20], ['saveIds', 'save_ids', 64]]) {
        const added = args[input] ?? [];
        if (!Array.isArray(added) || added.some((value) => typeof value !== 'string' || !value)) fail(`Invalid ${input} scope.`);
        const normalized = input === 'paths' ? added.map((name) => this.#path(round, name).relative) : added;
        round[field] = [...new Set([...(round[field] ?? []), ...normalized])].sort();
        if (round[field].length > limit) fail(`Recovery ${input} budget exceeded; history was not deleted.`);
      }
      if (!Array.isArray(args.saveTargets ?? []) || (args.saveTargets ?? []).length > 64) fail('Invalid saveTargets scope.');
      const addedSlots = (args.saveTargets ?? []).map((name) => {
        const checked = this.#path(round, name);
        if (!round.paths.includes(checked.relative) || checked.stat || (round.save_targets ?? []).includes(checked.relative)) fail('New Save slots must be absent declared paths not already protected as output slots.');
        return checked.relative;
      });
      if (expandSaveScope({ ...round, save_targets: addedSlots }, this.stateDir).created_save_ids.length) fail('Declare output slots before any Save exists for their paths.');
      round.save_targets = [...new Set([...(round.save_targets ?? []), ...addedSlots])].sort();
      if (new Set(round.paths.map((name) => name.toLowerCase())).size !== round.paths.length) fail('Duplicate paths are not supported.');
      if (['paths', 'board_ids', 'resource_ids', 'work_ids', 'save_ids', 'save_targets'].every((field) => digest(round[field]) === digest(old[field] ?? []))) fail('Declare at least one new protected object.');
      // Capture new scope before its first authorized modification. Old nodes stay immutable.
      const state = this.#capture(round);
      if (digest(this.#facts(old)) !== args.expectedDigest) fail('Prior scope changed during extension.');
      const node = this.#node(round, 'scope_extension', text(args.label, 'label'), state);
      round.scope_extensions ??= [];
      round.scope_extensions.push({ node_id: node.node_id, created_at: node.created_at, paths: round.paths.filter((name) => !old.paths.includes(name)) });
      round.head_node_id = node.node_id; round.revision++;
      round.requests.push({ ...request, caller: args.caller, receipt: {} });
      this.#save(round);
      return this.#view(round);
    });
  }

  #effectiveState(round, node) {
    const state = structuredClone(node.state);
    const additions = (round.scope_extensions ?? []).map((entry) => round.nodes.find((item) => item.node_id === entry.node_id).state);
    const scope = expandSaveScope(round, this.stateDir);
    if (scope.created_save_ids.length) {
      const current = this.#facts(round);
      additions.push({ resources: current.resources.filter((item) => item.created_in_round), saves: current.saves.filter((item) => item.created_in_round) });
    }
    for (const [field, key, order] of [['files', 'path', round.paths], ['boards', 'board_id', round.board_ids], ['resources', 'resource_id', scope.resource_ids], ['works', 'session_id', round.work_ids ?? []], ['saves', 'save_id', scope.save_ids]]) {
      const byId = new Map((state[field] ?? []).map((item) => [item[key], item]));
      for (const addition of additions) for (const item of addition[field] ?? []) if (!byId.has(item[key])) byId.set(item[key], item);
      state[field] = order.map((identity) => byId.get(identity));
      if (state[field].some((item) => !item)) fail('Recovery node has an incomplete protected scope.');
    }
    for (const resource of state.resources) if (resource.created_in_round) {
      const file = state.files.find((item) => path.resolve(round.root, item.path).toLowerCase() === path.resolve(resource.location.path).toLowerCase());
      resource.location.status = file?.sha256 ? 'active' : 'missing';
    }
    return state;
  }

  restore(args) { return this.#restore('restore', args); }
  returnToLatest(args) { return this.#restore('return', args); }

  #restore(action, args) {
    const request = this.#request(action, args);
    return withStateLock(this.stateDir, () => {
      assertDocumentUpdatesSettled(this.stateDir, args.projectId);
      const round = this.#read(args.projectId, args.roundId);
      const retry = this.#retry(round, request); if (retry) return retry;
      this.#ready(round, args);
      const nodeId = action === 'return'
        ? round.restores.find((item) => item.restore_id === args.restoreId && item.status === 'completed')?.return_node_id
        : args.nodeId;
      const target = round.nodes.find((node) => node.node_id === nodeId);
      if (!target) fail('Requested recovery node is unavailable.');
      const targetState = this.#effectiveState(round, target);
      for (const file of targetState.files) if (file.sha256) this.#blob(file.sha256);
      const state = this.#capture(round, args.expectedDigest);
      const insurance = this.#node(round, 'insurance', 'Before restore', state);
      validateProductTransition(targetState, state);
      const operation = { restore_id: id('RST'), target_node_id: nodeId, return_node_id: insurance.node_id,
        status: 'pending', completed_paths: [], started_at: now(), request, caller: args.caller };
      round.restores.push(operation);
      round.pending_restore = operation.restore_id;
      round.revision++;
      this.#save(round); // Durable insurance and journal BEFORE the first overwrite.
      return this.#execute(round, operation);
    });
  }

  resume(args) {
    this.#caller(args);
    return withStateLock(this.stateDir, () => {
      assertDocumentUpdatesSettled(this.stateDir, args.projectId);
      const round = this.#read(args.projectId, args.roundId);
      const operation = round.restores.find((item) => item.restore_id === args.restoreId);
      if (!operation) fail('Recovery operation is unavailable.');
      if (operation.status === 'completed') return { ...this.#view(round), restore_id: operation.restore_id, return_node_id: operation.return_node_id };
      if (round.pending_restore !== operation.restore_id) fail('This is not the pending recovery.');
      return this.#execute(round, operation);
    });
  }

  #execute(round, operation) {
    const target = this.#effectiveState(round, round.nodes.find((node) => node.node_id === operation.target_node_id));
    const before = round.nodes.find((node) => node.node_id === operation.return_node_id).state;
    try {
      // Revalidate ALL targets and both sets of blobs on resume, before any write.
      const current = this.#facts(round);
      for (const state of [target, before]) for (const file of state.files) if (file.sha256) this.#blob(file.sha256);
      for (const file of current.files) {
        const start = before.files.find((item) => item.path === file.path);
        const end = target.files.find((item) => item.path === file.path);
        if (file.sha256 !== start.sha256 && file.sha256 !== end.sha256) fail(`Later file change blocks recovery: ${file.path}`);
        if (operation.completed_paths.includes(file.path) && file.sha256 !== end.sha256) fail(`Recovered file changed again: ${file.path}`);
      }
      if (digest(current.boards) !== digest(before.boards)) fail('Board changed while recovery was pending.');
      if (digest(productState(current)) !== digest(productState(before))) fail('Work or Resource changed while recovery was pending.');
      validateProductTransition(target, before);
      for (const end of target.files) {
        const { absolute } = this.#path(round, end.path);
        const actual = this.#facts(round).files.find((item) => item.path === end.path);
        const start = before.files.find((item) => item.path === end.path);
        if (actual.sha256 !== end.sha256) {
          if (actual.sha256 !== start.sha256) fail(`Later file change blocks recovery: ${end.path}`);
          if (end.sha256 == null) {
            // Its exact bytes already exist in the verified insurance node.
            this.#path(round, end.path);
            if (sha256File(absolute) !== start.sha256) fail('File changed immediately before removal.');
            fs.unlinkSync(absolute);
          } else {
            const blob = this.#blob(end.sha256);
            const temp = path.join(path.dirname(absolute), `.atlas-restore-${crypto.randomUUID()}.tmp`);
            try {
              fs.copyFileSync(blob, temp, fs.constants.COPYFILE_EXCL);
              if (sha256File(temp) !== end.sha256) fail('Copied snapshot failed verification.');
              const checked = this.#path(round, end.path);
              if ((checked.stat ? sha256File(absolute) : null) !== start.sha256) fail('File changed immediately before replacement.');
              fs.renameSync(temp, absolute);
            } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
          }
        }
        const verified = this.#path(round, end.path);
        if ((verified.stat ? sha256File(absolute) : null) !== end.sha256) fail('Restored file failed verification.');
        if (!operation.completed_paths.includes(end.path)) operation.completed_paths.push(end.path);
        this.#save(round);
      }
      this.ledger.transaction(() => {
        const finalFacts = this.#facts(round);
        if (digest(finalFacts.files) !== digest(target.files) || digest(finalFacts.boards) !== digest(before.boards)) fail('State changed before recovery completion.');
        if (digest(productState(finalFacts)) !== digest(productState(before))) fail('Work or Resource changed before recovery completion.');
        restoreProductState({ target, before, ledger: this.ledger, restoreId: operation.restore_id, caller: operation.caller, at: now() });
        for (const board of target.boards) {
          const prior = before.boards.find((item) => item.board_id === board.board_id);
          const changed = this.db.prepare('UPDATE project_boards SET title=?,blocks_json=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?')
            .run(board.title, JSON.stringify(board.blocks), now(), board.board_id, round.project_id, prior.revision).changes;
          if (changed !== 1) fail('Board revision changed before restore.');
        }
        operation.status = 'completed'; operation.completed_at = now();
        round.pending_restore = null;
        round.head_node_id = operation.target_node_id;
        round.revision++;
        round.requests.push({ ...operation.request, caller: operation.caller, receipt: { restore_id: operation.restore_id, return_node_id: operation.return_node_id } });
        this.#save(round);
      });
      return { ...this.#view(round), restore_id: operation.restore_id, return_node_id: operation.return_node_id };
    } catch (error) {
      // Do not roll back the journal or insurance when the filesystem is partial.
      // The persisted pending state is the source of truth on the next process.
      error.details = { ...(error.details ?? {}), round_id: round.round_id, restore_id: operation.restore_id, recovery_incomplete: true };
      throw error;
    }
  }
}
