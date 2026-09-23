import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contentFileFingerprint, runDataWork } from './content-inspection.js';
import { Registry } from './registry.js';
import { createResourceControl } from './resource-control.js';
import { SaveService } from './save-service.js';
import { createSavedWorkService, savedResultFreshness } from './ui/services/saved-work-service.js';
import { buildResourceImpactLanes } from './ui/services/resource-impact-service.js';

const BLOCK_TYPES = new Set(['material_reference', 'text', 'result_preview']);
const VERSION_POLICIES = new Set(['follow_latest', 'pinned_version']);
const MAX_BLOCKS = 50;
const MAX_TEXT_LENGTH = 20_000;
const MAX_EMBED_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_EMBED_BYTES = 20 * 1024 * 1024;
const MAX_READABLE_PREVIEW_CHARS = 64_000;
const MAX_TABLE_PREVIEW_ROWS = 5;

const now = () => new Date().toISOString();
const requiredText = (value, label, maximum = 120) => {
  const normalized = String(value ?? '').trim().normalize('NFC');
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maximum) throw new Error(`${label} is too long.`);
  return normalized;
};
const portable = (value) => String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
const html = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const MIME_TYPES = new Map([
  ['.csv', 'text/csv'], ['.tsv', 'text/tab-separated-values'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],
  ['.json', 'application/json'], ['.html', 'text/html'], ['.pdf', 'application/pdf'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

function conflict(message, details = {}) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  error.details = details;
  return error;
}

function statusLabel(status) {
  return status === 'needs_review' ? 'Needs review' : status === 'missing' ? 'Missing' : status === 'contained' ? 'Pinned version' : 'Fresh';
}

function dataUri(filePath, typePath = filePath) {
  const mime = MIME_TYPES.get(path.extname(typePath).toLowerCase()) ?? 'application/octet-stream';
  return { mime, uri: `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}` };
}

function readablePreview(filePath, mime) {
  if (!mime.startsWith('text/') && mime !== 'application/json') return '';
  const text = fs.readFileSync(filePath, 'utf8').slice(0, 64_000);
  return `<pre>${html(text)}</pre>`;
}

function readableTablePreview(preview) {
  const content = preview?.kind === 'table' ? preview.content : null;
  if (!content?.columns?.length) return '';
  const head = `<tr>${content.columns.map((column) => `<th>${html(column)}</th>`).join('')}</tr>`;
  const body = (content.rows ?? []).map((row) => `<tr>${content.columns.map((_, index) => `<td>${html(row[index] ?? '')}</td>`).join('')}</tr>`).join('');
  const summary = `<p><small>${html(content.row_count ?? content.rows?.length ?? 0)} rows${content.sheet ? ` · ${html(content.sheet)}` : ''}${content.bounded ? ' · preview bounded' : ''}</small></p>`;
  return `${summary}<div class="table-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function parseDelimitedRow(line, delimiter) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) { values.push(value); value = ''; }
    else value += character;
  }
  values.push(value);
  return values;
}

function delimitedPreview(filePath, delimiter) {
  const lines = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u).filter((line) => line.length > 0);
  const columns = parseDelimitedRow(lines[0] ?? '', delimiter);
  return {
    columns,
    rows: lines.slice(1, MAX_TABLE_PREVIEW_ROWS + 1).map((line) => parseDelimitedRow(line, delimiter)),
    row_count: Math.max(0, lines.length - 1),
    bounded: lines.length - 1 > MAX_TABLE_PREVIEW_ROWS,
  };
}

export class BoardService {
  constructor({ stateDir, registry = null, resourceControl = null, saveService = null,
    projectRoot = undefined, installationRoot = undefined, pythonPath = null, runDataWorkFn = runDataWork }) {
    this.stateDir = path.resolve(stateDir);
    this.registry = registry ?? new Registry({ stateDir: this.stateDir });
    this.ownsRegistry = registry == null;
    this.resourceControl = resourceControl ?? createResourceControl({ stateDir: this.stateDir, ledger: this.registry.ledger });
    this.ownsResourceControl = resourceControl == null;
    this.saveService = saveService ?? new SaveService({ stateDir: this.stateDir, resourceControl: this.resourceControl });
    this.ownsSaveService = saveService == null;
    this.savedWork = createSavedWorkService({ stateDir: this.stateDir, saveService: this.saveService });
    this.repository = this.registry.ledger.boards;
    this.projectRoot = projectRoot;
    this.installationRoot = installationRoot;
    this.pythonPath = pythonPath;
    this.runDataWorkFn = runDataWorkFn;
  }

  #project(projectId) {
    const project = this.registry.list().find((item) => item.id === projectId && item.status === 'active');
    if (!project) throw new Error('The selected Project is not available.');
    const location = this.registry.show(project.id).location;
    if (!location?.root_path || location.relative_path == null) throw new Error('The selected Project does not have an available local location.');
    const workspaceRoot = path.resolve(location.root_path);
    const projectRoot = path.resolve(workspaceRoot, ...String(location.relative_path).split('/').filter(Boolean));
    return { project: { id: project.id, name: project.name }, workspaceRoot, projectRoot, relativePath: portable(location.relative_path) };
  }

  #storedBoard(projectId, boardId) {
    this.#project(projectId);
    const board = this.repository.byId(boardId);
    if (!board || board.project_id !== projectId) throw new Error('Board is unavailable in this Project.');
    return board;
  }

  #materialSnapshot(projectId, resourceId) {
    let fact;
    try { fact = this.resourceControl.projectResource(projectId, resourceId, { refresh: true }); }
    catch (error) { throw new Error(`Resource boundary check failed: ${error.message}`); }
    const current = fact.external_change?.current;
    return {
      resource_id: resourceId,
      recorded_path: fact.path ?? fact.last_known_location?.path ?? null,
      recorded_sha256: current?.sha256 ?? fact.content_hash ?? null,
      recorded_bytes: current?.bytes ?? fact.bytes ?? null,
      recorded_modified_at: current?.modified_at ?? fact.modified_at ?? null,
    };
  }

  #resultSnapshot(projectId, saveId) {
    const result = this.savedWork.find(saveId);
    if (!result || result.project?.id !== projectId) throw new Error('Result Save is unavailable in this Project boundary.');
    return {
      save_id: saveId,
      recorded_path: result.result_path ?? null,
      recorded_sha256: result.verification?.sha256 ?? result.result_fingerprint?.sha256 ?? null,
      recorded_at: result.executed_at ?? result.created_at ?? null,
    };
  }

  #normalizeBlocks(projectId, inputs, currentBlocks = []) {
    if (!Array.isArray(inputs) || inputs.length > MAX_BLOCKS) throw new Error(`Board supports at most ${MAX_BLOCKS} Blocks.`);
    const currentById = new Map(currentBlocks.map((item) => [item.block_id, item]));
    return inputs.map((input, ordinal) => {
      if (!input || !BLOCK_TYPES.has(input.type)) throw new Error('Board Block type must be material_reference, text, or result_preview.');
      const prior = input.block_id ? currentById.get(input.block_id) : null;
      const blockId = prior?.block_id ?? `BLK-${crypto.randomUUID()}`;
      if (input.type === 'text') {
        const text = requiredText(input.text, 'Board text', MAX_TEXT_LENGTH);
        return { block_id: blockId, ordinal, type: 'text', text };
      }
      const versionPolicy = String(input.version_policy ?? 'follow_latest');
      if (!VERSION_POLICIES.has(versionPolicy)) throw new Error('Board reference policy must be follow_latest or pinned_version.');
      if (input.type === 'material_reference') {
        const resourceId = requiredText(input.resource_id, 'Material Resource id', 100);
        const same = prior?.type === input.type && prior.resource_id === resourceId;
        return { ...(same ? prior : this.#materialSnapshot(projectId, resourceId)), block_id: blockId, ordinal, type: input.type,
          version_policy: versionPolicy };
      }
      const saveId = requiredText(input.save_id, 'Result Save id', 100);
      const same = prior?.type === input.type && prior.save_id === saveId;
      return { ...(same ? prior : this.#resultSnapshot(projectId, saveId)), block_id: blockId, ordinal, type: input.type,
        version_policy: versionPolicy };
    });
  }

  createBoard({ projectId, title }) {
    this.#project(projectId);
    return this.repository.create({ projectId, title: requiredText(title, 'Board title'), at: now() });
  }

  listBoards(projectId) {
    this.#project(projectId);
    return this.repository.list(projectId).map((item) => ({ ...item, desktop_href: `/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(item.board_id)}` }));
  }

  saveBoard({ projectId, boardId, title, blocks, baseRevision }) {
    const current = this.#storedBoard(projectId, boardId);
    if (Number(baseRevision) !== current.revision) throw conflict('Board changed after it was opened.', { board_id: boardId, current_revision: current.revision });
    const normalized = this.#normalizeBlocks(projectId, blocks, current.blocks);
    return this.repository.save({ projectId, boardId, title: requiredText(title, 'Board title'), blocks: normalized, baseRevision: Number(baseRevision), at: now() });
  }

  #projectMaterialBlock(projectId, block) {
    let fact;
    try { fact = this.resourceControl.projectResource(projectId, block.resource_id, { refresh: true }); }
    catch {
      return { ...block, name: block.resource_id, path: block.recorded_path, status: 'missing', status_label: 'Missing', reason: 'The referenced Material is no longer available in this Project.', resource_href: `/projects/${encodeURIComponent(projectId)}/resources?resource_id=${encodeURIComponent(block.resource_id)}` };
    }
    const state = fact.external_change?.status ?? 'not_checked';
    const currentSha256 = fact.external_change?.current?.sha256 ?? fact.content_hash ?? null;
    const matchesRecorded = Boolean(currentSha256 && block.recorded_sha256 && currentSha256 === block.recorded_sha256);
    let status = 'fresh'; let reason = 'The Material matches the recorded Board version.';
    if (state === 'missing' || !fact.path) { status = 'missing'; reason = 'The referenced Material is missing.'; }
    else if (!matchesRecorded && block.version_policy === 'follow_latest') { status = 'needs_review'; reason = 'The followed Material no longer matches the version recorded by this Board. Review the current file before updating the reference.'; }
    else if (!matchesRecorded) { status = 'needs_review'; reason = 'The pinned Material version is no longer available at this path. Restore that version or explicitly update the Board reference.'; }
    return { ...block, name: fact.resource?.display_name ?? path.basename(fact.path ?? block.recorded_path ?? block.resource_id), path: fact.path ?? block.recorded_path,
      current_sha256: currentSha256, updated_at: fact.modified_at ?? null,
      status, status_label: statusLabel(status), reason, resource_href: fact.desktop_href };
  }

  #projectResultBlock(projectId, block) {
    const result = this.savedWork.find(block.save_id);
    if (!result || result.project?.id !== projectId) return { ...block, name: block.save_id, path: block.recorded_path, status: 'missing', status_label: 'Missing', reason: 'The referenced Result is unavailable in this Project.', result_href: null };
    const freshness = savedResultFreshness(result, { versionPolicy: block.version_policy });
    const status = freshness.status === 'pinned' ? 'fresh' : freshness.status === 'undone' || freshness.status === 'not_checked' ? 'needs_review' : freshness.status;
    const workId = result.parameters?.work_session_id ?? null;
    return { ...block, name: path.basename(result.result_path ?? block.recorded_path ?? block.save_id), path: result.result_path ?? block.recorded_path,
      current_sha256: (() => { try { return contentFileFingerprint(result.result_path).sha256; } catch { return null; } })(),
      updated_at: result.executed_at ?? result.created_at ?? null, resource_id: result.resource_id ?? null,
      status, status_label: statusLabel(status), reason: freshness.reason,
      work_id: workId, result_href: workId ? `/work/${encodeURIComponent(workId)}/saved?work_id=${encodeURIComponent(block.save_id)}` : result.resources_href ?? null };
  }

  #exactBlockFile(block) {
    if (block.type === 'result_preview' && block.version_policy === 'pinned_version') {
      const result = this.savedWork.find(block.save_id);
      const expected = block.recorded_sha256 ?? result?.verification?.sha256 ?? result?.result_fingerprint?.sha256 ?? result?.candidate?.sha256 ?? null;
      if (result?.result_path && expected) {
        try {
          const current = contentFileFingerprint(result.result_path);
          if (current.sha256 === expected) return current.file_path;
        } catch { /* unavailable below */ }
      }
      try {
        const snapshot = this.saveService.candidateSnapshot(block.save_id);
        if (expected && snapshot.sha256 === expected) return snapshot.path;
      } catch { /* unavailable below */ }
    }
    if (!block.path || !block.recorded_sha256) return null;
    try {
      const fingerprint = contentFileFingerprint(block.path);
      return fingerprint.sha256 === block.recorded_sha256 ? fingerprint.file_path : null;
    } catch { return null; }
  }

  #tablePreview(filePath, extension, expectedSha256) {
    if (extension === '.csv' || extension === '.tsv') return delimitedPreview(filePath, extension === '.tsv' ? '\t' : ',');
    if (extension !== '.xlsx') return null;
    const options = {
      filePath, expectedSha256, action: 'profile', pythonPath: this.pythonPath,
      ...(this.projectRoot ? { projectRoot: this.projectRoot } : {}),
      ...(this.installationRoot ? { installationRoot: this.installationRoot } : {}),
    };
    let profile = this.runDataWorkFn(options);
    if (profile.status === 'sheet_required' && profile.sheets?.length) {
      const firstSheet = typeof profile.sheets[0] === 'string' ? profile.sheets[0] : profile.sheets[0]?.name;
      if (!firstSheet) return null;
      profile = this.runDataWorkFn({ ...options, sheet: firstSheet });
    }
    const sample = profile.profile?.sample;
    if (!sample) return null;
    return {
      columns: sample.columns ?? [], rows: (sample.rows ?? []).slice(0, MAX_TABLE_PREVIEW_ROWS),
      row_count: profile.profile?.rows ?? null,
      bounded: Number(profile.profile?.rows ?? 0) > MAX_TABLE_PREVIEW_ROWS,
      sheet: profile.sheet ?? profile.sheets?.[0] ?? null,
    };
  }

  #readableBlockPreview(projectId, boardId, block) {
    if (block.type === 'text') return null;
    const filePath = this.#exactBlockFile(block);
    if (!filePath) return null;
    const extension = path.extname(block.path ?? block.recorded_path ?? filePath).toLowerCase();
    const mime = MIME_TYPES.get(extension) ?? 'application/octet-stream';
    if (mime.startsWith('image/')) return {
      kind: 'image',
      content: `/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(boardId)}/blocks/${encodeURIComponent(block.block_id)}/content`,
      mime, bytes: fs.lstatSync(filePath).size,
    };
    if (extension === '.csv' || extension === '.tsv' || extension === '.xlsx') {
      try {
        const content = this.#tablePreview(filePath, extension, block.recorded_sha256);
        return content ? { kind: 'table', content } : null;
      } catch (error) {
        return { kind: 'unavailable', content: `Table preview unavailable: ${error.message}`.slice(0, MAX_READABLE_PREVIEW_CHARS) };
      }
    }
    if (mime.startsWith('text/') || mime === 'application/json') {
      const content = fs.readFileSync(filePath, 'utf8').slice(0, MAX_READABLE_PREVIEW_CHARS);
      return { kind: 'text', content, bounded: fs.lstatSync(filePath).size > Buffer.byteLength(content, 'utf8') };
    }
    return null;
  }

  showBoard(projectId, boardId) {
    const board = this.#storedBoard(projectId, boardId);
    const blocks = board.blocks.map((block) => {
      const projected = block.type === 'material_reference' ? this.#projectMaterialBlock(projectId, block)
        : block.type === 'result_preview' ? this.#projectResultBlock(projectId, block) : { ...block, status: 'fresh', status_label: 'Fresh' };
      const preview = this.#readableBlockPreview(projectId, boardId, projected);
      return preview ? { ...projected, preview } : projected;
    });
    const works = this.registry.ledger.workSessions.listForProject(projectId, { limit: 100, offset: 0 }).sessions;
    const results = this.savedWork.listForProject(projectId);
    const impactLanes = [];
    for (const block of blocks.filter((item) => item.type === 'material_reference')) {
      const resource = { resource_id: block.resource_id, name: block.name, path: block.path,
        desktop_href: block.resource_href, external_change: { status: block.status === 'needs_review' ? 'changed' : block.status === 'missing' ? 'missing' : 'unchanged' } };
      const lanes = buildResourceImpactLanes({ resource, workSessions: works, savedWork: results });
      impactLanes.push(...lanes.map((lane) => ({ ...lane, board: { board_id: boardId, block_id: block.block_id, href: `/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(boardId)}` } })));
      if (!lanes.length) impactLanes.push({
        source: { resource_id: block.resource_id, name: block.name, path: block.path, change_state: block.status, version_policy: block.version_policy },
        work: null, results: [], impact: { status: block.status, label: block.status_label, reason: block.reason },
        board: { board_id: boardId, block_id: block.block_id, href: `/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(boardId)}` },
        actions: { resource_context: block.resource_href, open_work: null, open_result: null },
      });
    }
    return { ...board, blocks, impact_lanes: impactLanes, desktop_href: `/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(boardId)}`,
      freshness: { status: blocks.some((item) => item.status === 'missing') ? 'missing' : blocks.some((item) => item.status === 'needs_review') ? 'needs_review' : 'fresh' } };
  }

  listResourceReferences(projectId, resourceId) {
    this.#project(projectId);
    return this.repository.list(projectId).flatMap((board) => board.blocks.flatMap((block) => {
      let relation = null;
      if (block.type === 'material_reference' && block.resource_id === resourceId) relation = 'material_reference';
      if (block.type === 'result_preview') {
        const result = this.savedWork.find(block.save_id);
        if (result?.project?.id === projectId || result?.project_id === projectId) {
          if (result.resource_id === resourceId) relation = 'result_preview';
          else if ((result.sources ?? []).some((source) => source.resource_id === resourceId)) relation = 'source_of_result_preview';
        }
      }
      if (!relation) return [];
      return [{
        board_id: board.board_id, block_id: block.block_id, title: board.title, revision: board.revision,
        version_policy: block.version_policy, relation,
        href: `/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(board.board_id)}`,
      }];
    }));
  }

  resolveBlockContent(projectId, boardId, blockId) {
    const block = this.showBoard(projectId, boardId).blocks.find((item) => item.block_id === blockId);
    if (!block) throw new Error('Board Block is unavailable.');
    const filePath = this.#exactBlockFile(block);
    if (!filePath) throw new Error('The recorded Board content is unavailable.');
    const mime = MIME_TYPES.get(path.extname(filePath).toLowerCase());
    const stat = fs.lstatSync(filePath);
    if (!mime?.startsWith('image/') || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EMBED_BYTES) {
      throw new Error('Board image preview is unavailable.');
    }
    return { file_path: filePath, mime, bytes: stat.size };
  }

  #portableHtml(board) {
    let embeddedBytes = 0;
    const inputs = [];
    const issues = [];
    const sections = [];
    for (const block of board.blocks) {
      if (block.type === 'text') { sections.push(`<section class="text"><p>${html(block.text).replaceAll('\n', '<br>')}</p></section>`); continue; }
      let filePath = block.path;
      let snapshot = null;
      if (block.type === 'result_preview' && block.version_policy === 'pinned_version') {
        try { snapshot = this.saveService.candidateSnapshot(block.save_id); filePath = snapshot.path; } catch { /* fall back to current verified file */ }
      }
      let stat = null;
      try { stat = fs.lstatSync(filePath); } catch { /* reported below */ }
      const currentMatches = block.type === 'result_preview' && snapshot
        ? snapshot.sha256 === block.recorded_sha256
        : block.current_sha256 && block.current_sha256 === block.recorded_sha256;
      const unavailable = !stat?.isFile() || stat.isSymbolicLink() || block.status === 'missing' || !currentMatches;
      if (unavailable) {
        issues.push(`${block.name ?? block.recorded_path ?? block.block_id}: ${block.reason ?? 'The referenced file is unavailable.'}`);
        sections.push(`<section><h2>${html(block.name ?? 'Reference')}</h2><p class="issue">Not included: ${html(block.reason ?? 'Unavailable')}</p></section>`);
        continue;
      }
      if (stat.size > MAX_EMBED_BYTES || embeddedBytes + stat.size > MAX_TOTAL_EMBED_BYTES) {
        issues.push(`${block.name}: file exceeds the portable delivery size limit.`);
        sections.push(`<section><h2>${html(block.name)}</h2><p class="issue">Not included: file exceeds the portable delivery size limit.</p></section>`);
        continue;
      }
      embeddedBytes += stat.size;
      const project = this.#project(board.project_id);
      const inputPath = block.type === 'result_preview' && snapshot ? block.path : filePath;
      if (inputPath && path.resolve(inputPath).startsWith(`${project.workspaceRoot}${path.sep}`)) {
        try {
          const inputFacts = contentFileFingerprint(inputPath);
          if (inputFacts.sha256 === block.recorded_sha256) inputs.push(path.resolve(inputPath));
        } catch { /* the issue list already describes unavailable content */ }
      }
      const encoded = dataUri(filePath, block.path ?? block.recorded_path ?? filePath); const name = block.name ?? path.basename(filePath);
      const preview = encoded.mime.startsWith('image/') ? `<img src="${encoded.uri}" alt="${html(name)}">`
        : block.preview?.kind === 'table' ? readableTablePreview(block.preview) : readablePreview(filePath, encoded.mime);
      sections.push(`<section><h2>${html(name)}</h2><p>${html(block.type === 'result_preview' ? 'Selected Result' : 'Material dependency')} · ${html(block.version_policy)}</p>${preview}<p><a download="${html(name)}" href="${encoded.uri}">Download ${html(name)}</a></p></section>`);
    }
    const issueList = issues.length ? `<ul>${issues.map((item) => `<li>${html(item)}</li>`).join('')}</ul>` : '<p>None.</p>';
    const document = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(board.title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 24px;color:#24211d}section{border-top:1px solid #c9c1b5;padding:24px 0}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f0e8;padding:16px}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #d9d1c5;padding:8px;white-space:nowrap}.issue{color:#8a3324}small{color:#625d55}</style></head><body><header><small>Atlas portable Board · revision ${board.revision}</small><h1>${html(board.title)}</h1><p>This self-contained document can be read without Atlas.</p></header>${sections.join('')}<section><h2>Missing or not included</h2>${issueList}</section></body></html>`;
    return { html: document, inputs: [...new Set(inputs)], issues, embedded_bytes: embeddedBytes };
  }

  async preparePortableDelivery({ projectId, boardId, baseRevision, target, caller, requestKey }) {
    const board = this.showBoard(projectId, boardId);
    if (Number(baseRevision) !== board.revision) throw conflict('Board changed after the portable delivery was opened.', { board_id: boardId, current_revision: board.revision });
    if (!caller?.tool || !caller?.client_run_id) throw new Error('Portable delivery requires caller tool and client run id.');
    const project = this.#project(projectId);
    const relativeTarget = portable(target);
    if (!relativeTarget || path.posix.isAbsolute(relativeTarget) || relativeTarget === '..' || relativeTarget.startsWith('../') || path.extname(relativeTarget).toLowerCase() !== '.html') throw new Error('Portable delivery target must be one new HTML file inside the Project.');
    const absoluteTarget = path.resolve(project.projectRoot, ...relativeTarget.split('/'));
    const targetRelative = path.relative(project.projectRoot, absoluteTarget);
    if (!targetRelative || targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) throw new Error('Portable delivery target must remain inside the Project.');
    const parent = path.dirname(absoluteTarget); const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Portable delivery requires an existing non-linked destination folder.');
    const portableDocument = this.#portableHtml(board);
    if (!portableDocument.inputs.length) throw new Error('Portable delivery requires at least one fresh Material or Result dependency inside the Project.');
    const candidateDir = path.join(this.stateDir, 'tmp', 'board-delivery'); fs.mkdirSync(candidateDir, { recursive: true });
    const candidatePath = path.join(candidateDir, `${boardId}-r${board.revision}-${crypto.randomUUID()}.html`);
    fs.writeFileSync(candidatePath, portableDocument.html, { encoding: 'utf8', flag: 'wx' });
    const workspaceTarget = portable(path.join(project.relativePath, relativeTarget));
    const prepared = this.saveService.prepare({
      root: project.workspaceRoot, candidateFile: candidatePath, projectId, target: workspaceTarget,
      inputs: portableDocument.inputs, origin: 'agent_generated', kind: 'report', role: 'report', relationType: 'derived_from',
      channel: caller.actor === 'user' ? 'desktop' : 'host', requestKey, caller,
      source: { kind: 'board_delivery', board_id: boardId, board_revision: board.revision, sources: board.blocks.filter((item) => item.resource_id).map((item) => ({ resource_id: item.resource_id, path: item.path, version_policy: item.version_policy })) },
      parameters: { board_id: boardId, board_revision: board.revision, portable_format: 'self_contained_html' },
      resultSummary: { block_count: board.blocks.length, embedded_bytes: portableDocument.embedded_bytes, missing_count: portableDocument.issues.length },
      intent: 'Save one reviewed portable Board delivery.',
    });
    return { ...prepared, board_id: boardId, board_revision: board.revision, issues: portableDocument.issues };
  }

  dispose() {
    if (this.ownsSaveService) this.saveService.dispose();
    if (this.ownsResourceControl) this.resourceControl.dispose();
    if (this.ownsRegistry) this.registry.dispose();
  }
}

export function createBoardService(options) { return new BoardService(options); }
