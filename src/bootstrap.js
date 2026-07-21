import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from './ledger.js';
import { isPathInside, normalizeRoot, toPortablePath } from './paths.js';
import {
  ARTIFACT_ROLES,
  ROLE_TRANSITIONS,
  getLibraryProfile,
  listLibraryProfiles,
  recommendLibraryProfile,
} from './profiles.js';
import { sha256Buffer, sha256File } from './snapshots.js';

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', '.atlas', '.obsidian', '.trash', 'node_modules']);
const SCAN_MODES = new Set(['metadata', 'structure']);
const AGENT_CONTEXT_AREA_LIMIT = 100;
const AGENT_PREDICTION_KINDS = new Set([
  'project_candidate',
  'folder_role',
  'artifact_role',
  'naming_rule_candidate',
  'routing_rule_candidate',
  'structure_improvement',
]);
const PREDICTION_RISKS = new Set(['low', 'medium', 'high']);

function timestamp() {
  return new Date().toISOString();
}

function stateConflict(message) {
  const error = new Error(message);
  error.code = 'ATLAS_STATE_CONFLICT';
  return error;
}

function makeScanId() {
  const date = timestamp().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `ENV-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function unique(values) {
  return [...new Set(values)];
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripCodeMarkup(value) {
  const output = [];
  let fence = null;
  for (const line of value.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1] ?? null;
    if (marker) {
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
      output.push('');
      continue;
    }
    output.push(fence ? '' : line.replace(/(`+)([^`\n]*?)\1/gu, ''));
  }
  return output.join('\n');
}

function parseInlineList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  return trimmed.slice(1, -1).split(',').map(stripQuotes).filter(Boolean);
}

function parseMarkdownMetadata(filePath, byteSize) {
  const bytesToRead = Math.min(byteSize, MAX_MARKDOWN_BYTES);
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(bytesToRead);
  try {
    if (bytesToRead) fs.readSync(descriptor, buffer, 0, bytesToRead, 0);
  } finally {
    fs.closeSync(descriptor);
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return {
      title: null,
      properties: [],
      tags: [],
      links: [],
      encoding: 'non_utf8',
      frontmatter: 'unknown',
      truncated: byteSize > MAX_MARKDOWN_BYTES,
    };
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const properties = [];
  const frontmatterTags = [];
  let frontmatterTitle = null;
  let frontmatter = 'absent';
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closing > 0) {
      frontmatter = 'parsed';
      let activeKey = null;
      for (const line of lines.slice(1, closing)) {
        const property = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (property) {
          activeKey = property[1];
          properties.push(activeKey);
          if (activeKey === 'title') frontmatterTitle = stripQuotes(property[2]) || null;
          if (activeKey === 'tags') frontmatterTags.push(...parseInlineList(property[2]));
          continue;
        }
        const listItem = line.match(/^\s*-\s*(.+)$/);
        if (activeKey === 'tags' && listItem) frontmatterTags.push(stripQuotes(listItem[1]));
      }
      bodyStart = closing + 1;
    } else {
      frontmatter = 'unterminated';
      bodyStart = lines.length;
    }
  }

  const body = stripCodeMarkup(lines.slice(bodyStart).join('\n'));
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const inlineTags = [...body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[1]);
  const links = [...body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  return {
    title: frontmatterTitle || heading,
    properties: unique(properties),
    tags: unique([...frontmatterTags, ...inlineTags]),
    links: unique(links),
    encoding: 'utf8',
    frontmatter,
    truncated: byteSize > MAX_MARKDOWN_BYTES,
  };
}

function normalizeIgnoreRules(values = []) {
  if (!Array.isArray(values)) throw new Error('Bootstrap ignore rules must be an array.');
  return unique(values.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Bootstrap ignore path cannot be empty.');
    const portable = value.trim().replace(/\\/g, '/').replace(/\/$/, '');
    if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(portable)) {
      throw new Error(`Bootstrap ignore path must be relative: ${value}`);
    }
    const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Bootstrap ignore path escapes the root: ${value}`);
    }
    return normalized;
  })).sort();
}

function normalizeScanMode(value = 'metadata') {
  if (!SCAN_MODES.has(value)) {
    throw new Error(`Bootstrap scan mode must be one of: ${[...SCAN_MODES].join(', ')}.`);
  }
  return value;
}

function normalizeProposalPath(value, field, observedPaths) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty relative path.`);
  }
  const portable = value.trim().replace(/\\/g, '/').normalize('NFC');
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(portable)) {
    throw new Error(`${field} must be relative to the scanned root: ${value}`);
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${field} escapes the scanned root: ${value}`);
  }
  if (!observedPaths.has(normalized)) {
    throw new Error(`${field} was not observed in the selected Bootstrap scan: ${normalized}`);
  }
  return normalized;
}

function normalizeAgentPredictions(predictions, detail, caller) {
  if (!Array.isArray(predictions) || predictions.length === 0) {
    throw new Error('Bootstrap propose requires a non-empty predictions array.');
  }
  if (predictions.length > 1000) throw new Error('Bootstrap propose accepts at most 1000 Predictions.');
  const observedPaths = new Set(detail.entries.map((entry) => entry.path));
  return predictions.map((prediction, index) => {
    if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)) {
      throw new Error(`Prediction ${index + 1} must be an object.`);
    }
    if (!AGENT_PREDICTION_KINDS.has(prediction.kind)) {
      throw new Error(
        `Prediction ${index + 1} kind must be one of: ${[...AGENT_PREDICTION_KINDS].join(', ')}.`,
      );
    }
    if (typeof prediction.summary !== 'string' || !prediction.summary.trim()) {
      throw new Error(`Prediction ${index + 1} requires a summary.`);
    }
    if (prediction.summary.length > 2000) {
      throw new Error(`Prediction ${index + 1} summary is too large; maximum is 2000 characters.`);
    }
    if (typeof prediction.proposed_action !== 'string' || !prediction.proposed_action.trim()) {
      throw new Error(`Prediction ${index + 1} requires a proposed_action.`);
    }
    if (prediction.proposed_action.length > 4000) {
      throw new Error(`Prediction ${index + 1} proposed_action is too large; maximum is 4000 characters.`);
    }
    const confidence = Number(prediction.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`Prediction ${index + 1} confidence must be between 0 and 1.`);
    }
    if (!PREDICTION_RISKS.has(prediction.risk)) {
      throw new Error(`Prediction ${index + 1} risk must be low, medium, or high.`);
    }
    if (!Array.isArray(prediction.affected_paths) || prediction.affected_paths.length === 0) {
      throw new Error(`Prediction ${index + 1} requires affected_paths.`);
    }
    if (prediction.affected_paths.length > 200) {
      throw new Error(`Prediction ${index + 1} affects too many paths; maximum is 200.`);
    }
    const affectedPaths = unique(prediction.affected_paths.map((value) => (
      normalizeProposalPath(value, `Prediction ${index + 1} affected path`, observedPaths)
    ))).sort();
    if (!prediction.evidence || typeof prediction.evidence !== 'object'
        || Array.isArray(prediction.evidence) || Object.keys(prediction.evidence).length === 0) {
      throw new Error(`Prediction ${index + 1} requires structured evidence.`);
    }
    const evidence = structuredClone(prediction.evidence);
    if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 64 * 1024) {
      throw new Error(`Prediction ${index + 1} evidence is too large; maximum is 64 KiB.`);
    }
    for (const field of ['path', 'directory', 'target_directory']) {
      if (evidence[field] != null) {
        evidence[field] = normalizeProposalPath(
          evidence[field],
          `Prediction ${index + 1} evidence.${field}`,
          observedPaths,
        );
      }
    }
    if (evidence.scope_paths != null) {
      if (!Array.isArray(evidence.scope_paths)) {
        throw new Error(`Prediction ${index + 1} evidence.scope_paths must be an array.`);
      }
      evidence.scope_paths = unique(evidence.scope_paths.map((value) => (
        normalizeProposalPath(value, `Prediction ${index + 1} evidence scope`, observedPaths)
      ))).sort();
    }
    return {
      kind: prediction.kind,
      summary: prediction.summary.trim(),
      confidence,
      risk: prediction.risk,
      affected_paths: affectedPaths,
      evidence,
      proposed_action: prediction.proposed_action.trim(),
      requires_review: true,
      source: 'agent',
      proposed_by: {
        actor: caller.actor ?? 'agent',
        agent: caller.agent ?? null,
        model: caller.model ?? null,
        tool: caller.tool ?? 'atlas-cli',
        client_run_id: caller.client_run_id ?? null,
      },
    };
  });
}

function buildAgentContext(detail, maxSamples) {
  const areas = new Map();
  for (const entry of detail.entries) {
    const areaName = entry.path.includes('/') ? entry.path.split('/')[0] : '.';
    const area = areas.get(areaName) ?? {
      path: areaName,
      files: 0,
      markdown_files: 0,
      directories: 0,
      bytes: 0,
      extensions: new Map(),
      sample_paths: [],
    };
    if (entry.kind === 'directory') area.directories += 1;
    if (entry.kind === 'file') {
      area.files += 1;
      area.bytes += entry.byteSize;
      if (entry.extension === '.md') area.markdown_files += 1;
      const extension = entry.extension || '(none)';
      area.extensions.set(extension, (area.extensions.get(extension) ?? 0) + 1);
      area.sample_paths.push(entry.path);
    }
    areas.set(areaName, area);
  }
  const predictionCounts = new Map();
  for (const prediction of detail.predictions) {
    predictionCounts.set(prediction.kind, (predictionCounts.get(prediction.kind) ?? 0) + 1);
  }
  const bounded = (values = []) => ({ count: values.length, sample: values.slice(0, maxSamples) });
  const sortedAreas = [...areas.values()].sort((left, right) => left.path.localeCompare(right.path));
  const changes = detail.summary.changes ?? {};
  return {
    scan_id: detail.scan.id,
    root: detail.scan.root_path,
    scan_mode: detail.summary.scan_mode ?? 'metadata',
    content_included: false,
    summary: {
      files: detail.summary.files,
      markdown_files: detail.summary.markdown_files,
      directories: detail.summary.directories,
      symlinks: detail.summary.symlinks,
      scan_mode: detail.summary.scan_mode,
      content_files_read: detail.summary.content_files_read,
      content_bytes_read: detail.summary.content_bytes_read,
      predictions: detail.summary.predictions,
      ignored_paths: bounded(detail.summary.ignored_paths),
      ignore_rules: bounded(detail.summary.ignore_rules),
      changes: {
        baseline_scan_id: changes.baseline_scan_id ?? null,
        added: bounded(changes.added),
        deleted: bounded(changes.deleted),
        modified: bounded(changes.modified),
        moved_candidates: bounded(changes.moved_candidates),
      },
    },
    area_limit: AGENT_CONTEXT_AREA_LIMIT,
    total_areas: sortedAreas.length,
    areas_truncated: sortedAreas.length > AGENT_CONTEXT_AREA_LIMIT,
    areas: sortedAreas.slice(0, AGENT_CONTEXT_AREA_LIMIT).map((area) => ({
      ...area,
      extensions: [...area.extensions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([extension, count]) => ({ extension, count })),
      sample_paths: area.sample_paths.sort().slice(0, maxSamples),
    })),
    prediction_counts: [...predictionCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => ({ kind, count })),
  };
}

function buildDefaultProfilePredictions(recommendation) {
  const { profile, mappings, structure_plan: structurePlan } = recommendation;
  const mappedPaths = mappings.flatMap((mapping) => (
    mapping.existing_path ? [mapping.existing_path] : mapping.candidates
  ));
  const common = {
    requires_review: true,
    source: 'atlas-default',
    proposed_by: {
      actor: 'atlas',
      agent: null,
      model: null,
      tool: 'atlas-default-profiles',
      client_run_id: null,
    },
  };
  const predictions = [{
    kind: 'library_profile_candidate',
    summary: `${profile.name} is a candidate baseline for this library; it will not restructure source files.`,
    confidence: recommendation.confidence,
    risk: 'medium',
    affected_paths: unique(mappedPaths).sort(),
    evidence: {
      profile_id: profile.id,
      profile_version: profile.version,
      selection: recommendation.selection,
      signals: recommendation.evidence,
      alternatives: recommendation.alternatives,
      suitable_for: profile.suitable_for,
      not_suitable_for: profile.not_suitable_for,
    },
    proposed_action: 'Review this Profile as a routing baseline; do not move or create source directories.',
    ...common,
  }];
  for (const mapping of mappings.filter((item) => item.status === 'mapped')) {
    predictions.push({
      kind: 'folder_role',
      summary: `Map ${mapping.existing_path} to the ${mapping.area_role} semantic area.`,
      confidence: recommendation.selection === 'user_selected_candidate' ? 0.95 : recommendation.confidence,
      risk: 'low',
      affected_paths: [mapping.existing_path],
      evidence: {
        profile_id: profile.id,
        profile_version: profile.version,
        path: mapping.existing_path,
        area_role: mapping.area_role,
        purpose: mapping.purpose,
        accepts: mapping.accepts,
      },
      proposed_action: 'Use this accepted mapping for later routing recommendations; do not move the directory.',
      ...common,
    });
  }
  predictions.push({
    kind: 'structure_plan_candidate',
    summary: `${profile.name} produces a read-only mapping and missing-directory plan with no authorized source changes.`,
    confidence: recommendation.confidence,
    risk: 'medium',
    affected_paths: unique(mappedPaths).sort(),
    evidence: { profile_id: profile.id, profile_version: profile.version, plan: structurePlan },
    proposed_action: 'Review the plan; any future creation, move, or rename requires a separate governed ChangeSet.',
    ...common,
  });
  return predictions;
}

function buildLibraryContract(detail, recommendation, predictionIds) {
  const predictionIdSet = new Set(predictionIds);
  const zones = recommendation.mappings.map((mapping) => ({
    area_role: mapping.area_role,
    purpose: mapping.purpose,
    accepts: mapping.accepts,
    required: mapping.required,
    status: mapping.status,
    current_path: mapping.existing_path,
    candidates: mapping.candidates,
    proposed_path: mapping.suggested_path,
  }));
  const routes = Object.entries(recommendation.profile.derived_routes)
    .map(([role, route]) => ({ role, ...route }));
  const questions = zones
    .filter((zone) => zone.status === 'ambiguous')
    .slice(0, 3)
    .map((zone) => ({
      kind: 'choose_existing_area',
      area_role: zone.area_role,
      candidates: zone.candidates,
      prompt: `Which existing directory should represent ${zone.area_role}?`,
    }));
  const candidate = {
    schema: 'atlas-library-contract-candidate.v1',
    scan_id: detail.scan.id,
    source_fingerprint: detail.scan.fingerprint,
    root: detail.scan.root_path,
    scan_mode: detail.summary.scan_mode,
    status: questions.length ? 'needs_input' : 'ready',
    profile: {
      id: recommendation.profile.id,
      version: recommendation.profile.version,
      name: recommendation.profile.name,
      summary: recommendation.profile.summary,
      selection: recommendation.selection,
      confidence: recommendation.confidence,
      evidence: recommendation.evidence,
      alternatives: recommendation.alternatives,
    },
    zones,
    routes,
    questions,
    suggestions: recommendation.structure_plan.operations
      .filter((operation) => operation.operation !== 'map_existing_directory'),
    source_changes: [],
    approval: {
      action: 'adopt_library_contract',
      prediction_ids: [...predictionIds],
      deferred_prediction_count: detail.predictions.filter(
        (prediction) => !predictionIdSet.has(prediction.id) && !prediction.review,
      ).length,
    },
  };
  const hashMaterial = {
    ...candidate,
    approval: {
      action: candidate.approval.action,
      prediction_ids: candidate.approval.prediction_ids,
    },
  };
  const hash = sha256Buffer(Buffer.from(JSON.stringify(hashMaterial), 'utf8'));
  return {
    schema: candidate.schema,
    contract_id: `CONTRACT-${hash.slice(0, 16)}`,
    ...Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'schema')),
  };
}

function compileEnvironmentPolicy(detail, profilePrediction, acceptedPredictions, libraryContract = null) {
  const profileId = profilePrediction.evidence.profile_id;
  const profile = getLibraryProfile(profileId);
  if (profile.version !== profilePrediction.evidence.profile_version) {
    throw new Error(`Bundled Profile version changed after review: ${profileId}. Create a new scan.`);
  }
  const acceptedMappings = acceptedPredictions
    .filter((prediction) => prediction.kind === 'folder_role'
      && prediction.evidence?.profile_id === profileId
      && prediction.evidence?.area_role
      && prediction.evidence?.path)
    .map((prediction) => ({
      area_role: prediction.evidence.area_role,
      path: prediction.evidence.path,
      prediction_id: prediction.id,
    }));
  const customRouting = acceptedPredictions
    .filter((prediction) => prediction.kind === 'routing_rule_candidate')
    .map((prediction) => ({
      prediction_id: prediction.id,
      summary: prediction.summary,
      evidence: prediction.evidence,
      proposed_action: prediction.proposed_action,
    }));
  return {
    schema: 'atlas-environment-policy.v1',
    source_scan_id: detail.scan.id,
    root_path: detail.scan.root_path,
    profile_id: profile.id,
    profile_version: profile.version,
    source_mutation_policy: profile.source_mutation_policy,
    artifact_roles: ARTIFACT_ROLES,
    role_transitions: ROLE_TRANSITIONS,
    library_contract: libraryContract ? {
      schema: 'atlas-library-contract.v1',
      contract_id: libraryContract.contract_id,
      profile_id: libraryContract.profile.id,
      profile_version: libraryContract.profile.version,
      zones: libraryContract.zones,
      routes: libraryContract.routes,
      source_changes: [],
    } : null,
    area_mappings: acceptedMappings,
    derived_routes: profile.derived_routes,
    custom_routing_rules: customRouting,
    gates: {
      explicit_project_required_for_create: true,
      missing_directory_creation: 'separate_guarded_changeset',
      route_mismatch: 'warn_and_review',
      automatic_source_restructure: 'deny',
    },
  };
}

function scanEnvironment(root, ignoreRules = [], scanMode = 'metadata') {
  const entries = [];
  const ignoredPaths = [];
  const customIgnores = new Set(ignoreRules);
  let contentFilesRead = 0;
  let contentBytesRead = 0;

  function walk(directory) {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = toPortablePath(path.relative(root, absolute));
      if (child.isDirectory() && (IGNORED_DIRECTORIES.has(child.name) || customIgnores.has(relative))) {
        ignoredPaths.push(relative);
        continue;
      }

      const stat = fs.lstatSync(absolute);
      if (child.isSymbolicLink()) {
        entries.push({
          path: relative,
          kind: 'symlink',
          extension: null,
          byteSize: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          contentHash: null,
          metadata: { followed: false },
        });
        continue;
      }
      if (child.isDirectory()) {
        entries.push({
          path: relative,
          kind: 'directory',
          extension: null,
          byteSize: 0,
          modifiedAt: stat.mtime.toISOString(),
          contentHash: null,
          metadata: {},
        });
        walk(absolute);
        continue;
      }
      if (!child.isFile()) {
        entries.push({
          path: relative,
          kind: 'unsupported',
          extension: null,
          byteSize: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          contentHash: null,
          metadata: {},
        });
        continue;
      }

      const extension = path.extname(child.name).toLowerCase();
      const before = fs.statSync(absolute);
      const contentHash = scanMode === 'metadata' ? sha256File(absolute) : null;
      if (scanMode === 'metadata') {
        contentFilesRead += 1;
        contentBytesRead += before.size;
      }
      const after = fs.statSync(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`File changed while Bootstrap was scanning it; retry: ${absolute}`);
      }
      let metadata;
      if (scanMode === 'structure') {
        metadata = { scanned_content: false, scan_mode: 'structure' };
      } else if (extension === '.md') {
        metadata = {
          ...parseMarkdownMetadata(absolute, after.size),
          scanned_content: true,
          scan_mode: 'metadata',
        };
        contentBytesRead += Math.min(after.size, MAX_MARKDOWN_BYTES);
      } else {
        metadata = { scanned_content: false, scan_mode: 'metadata' };
      }
      entries.push({
        path: relative,
        kind: 'file',
        extension,
        byteSize: after.size,
        modifiedAt: after.mtime.toISOString(),
        contentHash,
        metadata,
      });
    }
  }

  walk(root);
  return { entries, ignoredPaths, contentFilesRead, contentBytesRead };
}

function withoutMarkdownExtension(value) {
  return value.replace(/\.md$/i, '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function normalizeLookup(value) {
  return withoutMarkdownExtension(value).normalize('NFC').toLowerCase();
}

function makePrediction(kind, summary, confidence, affectedPaths, evidence, proposedAction, risk = 'low') {
  return {
    kind,
    summary,
    confidence,
    risk,
    affected_paths: unique(affectedPaths).sort(),
    evidence,
    proposed_action: proposedAction,
    requires_review: true,
  };
}

function compareEnvironment(previousEntries, currentEntries, baselineScanId) {
  if (!previousEntries) {
    return {
      baseline_scan_id: null,
      added: [],
      deleted: [],
      modified: [],
      moved_candidates: [],
    };
  }
  const previous = new Map(previousEntries.map((entry) => [entry.path, entry]));
  const current = new Map(currentEntries.map((entry) => [entry.path, entry]));
  const added = [...current.keys()].filter((item) => !previous.has(item)).sort();
  const deleted = [...previous.keys()].filter((item) => !current.has(item)).sort();
  const modified = [...current.keys()].filter((item) => {
    const before = previous.get(item);
    const after = current.get(item);
    if (!before || before.kind !== after.kind) return Boolean(before);
    if (before.contentHash && after.contentHash) return before.contentHash !== after.contentHash;
    return before.byteSize !== after.byteSize || before.modifiedAt !== after.modifiedAt;
  }).sort();
  const deletedByHash = new Map();
  const addedByHash = new Map();
  for (const item of deleted.map((itemPath) => previous.get(itemPath)).filter(
    (entry) => entry.kind === 'file' && entry.contentHash,
  )) {
    const paths = deletedByHash.get(item.contentHash) ?? [];
    paths.push(item.path);
    deletedByHash.set(item.contentHash, paths);
  }
  for (const item of added.map((itemPath) => current.get(itemPath)).filter(
    (entry) => entry.kind === 'file' && entry.contentHash,
  )) {
    const paths = addedByHash.get(item.contentHash) ?? [];
    paths.push(item.path);
    addedByHash.set(item.contentHash, paths);
  }
  const movedCandidates = [];
  for (const [contentHash, fromPaths] of deletedByHash) {
    const toPaths = addedByHash.get(contentHash) ?? [];
    if (fromPaths.length === 1 && toPaths.length === 1) {
      movedCandidates.push({ from: fromPaths[0], to: toPaths[0] });
    }
  }
  return {
    baseline_scan_id: baselineScanId,
    added,
    deleted,
    modified,
    moved_candidates: movedCandidates.sort((left, right) => left.from.localeCompare(right.from)),
  };
}

function inferPredictions(entries, scanMode = 'metadata') {
  const markdown = entries.filter((entry) => entry.kind === 'file' && entry.extension === '.md');
  const exact = new Map();
  const linkStems = new Map();
  for (const entry of entries.filter((item) => item.kind === 'file')) {
    exact.set(normalizeLookup(entry.path), entry.path);
    const stem = normalizeLookup(path.posix.basename(entry.path));
    const paths = linkStems.get(stem) ?? [];
    paths.push(entry.path);
    linkStems.set(stem, paths);
  }
  const markdownStems = new Map();
  for (const entry of markdown) {
    const stem = normalizeLookup(path.posix.basename(entry.path));
    const paths = markdownStems.get(stem) ?? [];
    paths.push(entry.path);
    markdownStems.set(stem, paths);
  }

  function resolveLink(sourcePath, target) {
    const normalizedTarget = normalizeLookup(target);
    const sourceDirectory = path.posix.dirname(sourcePath);
    const relativeTarget = normalizeLookup(path.posix.join(sourceDirectory === '.' ? '' : sourceDirectory, target));
    if (exact.has(relativeTarget)) return [exact.get(relativeTarget)];
    if (exact.has(normalizedTarget)) return [exact.get(normalizedTarget)];
    return linkStems.get(normalizeLookup(path.posix.basename(target))) ?? [];
  }

  const predictions = [];
  if (scanMode === 'metadata') {
    const broken = new Map();
    const ambiguous = new Map();
    const incoming = new Map(markdown.map((entry) => [entry.path, 0]));
    const outgoing = new Map(markdown.map((entry) => [entry.path, 0]));
    for (const entry of markdown) {
      for (const target of entry.metadata.links ?? []) {
        const candidates = resolveLink(entry.path, target);
        if (candidates.length === 0) {
          const sources = broken.get(target) ?? [];
          sources.push(entry.path);
          broken.set(target, sources);
        } else if (candidates.length > 1) {
          const item = ambiguous.get(target) ?? { sources: [], candidates };
          item.sources.push(entry.path);
          ambiguous.set(target, item);
        } else {
          outgoing.set(entry.path, outgoing.get(entry.path) + 1);
          if (incoming.has(candidates[0])) {
            incoming.set(candidates[0], incoming.get(candidates[0]) + 1);
          }
        }
      }
    }
    for (const [target, sources] of broken) {
      predictions.push(makePrediction(
        'broken_wiki_link',
        `Wiki link target "${target}" was not found.`,
        0.98,
        sources,
        { target, source_paths: sources },
        'Confirm the intended target before repairing the link.',
        'medium',
      ));
    }
    for (const [target, item] of ambiguous) {
      predictions.push(makePrediction(
        'ambiguous_wiki_link',
        `Wiki link target "${target}" matches multiple notes.`,
        0.95,
        [...item.sources, ...item.candidates],
        { target, source_paths: item.sources, candidate_paths: item.candidates },
        'Replace the link with an explicit path or alias after review.',
        'medium',
      ));
    }

    const titles = new Map();
    for (const entry of markdown) {
      if (!entry.metadata.title) continue;
      const key = entry.metadata.title.normalize('NFC').trim().toLowerCase();
      const paths = titles.get(key) ?? [];
      paths.push(entry.path);
      titles.set(key, paths);
    }
    for (const paths of titles.values()) {
      if (paths.length < 2) continue;
      const title = markdown.find((entry) => entry.path === paths[0]).metadata.title;
      predictions.push(makePrediction(
        'duplicate_title',
        `Multiple notes use the title "${title}".`,
        0.99,
        paths,
        { title, paths },
        'Review whether the titles or note roles should be made more specific.',
      ));
    }

    const orphanPaths = markdown
      .filter((entry) => incoming.get(entry.path) === 0 && outgoing.get(entry.path) === 0)
      .map((entry) => entry.path);
    if (orphanPaths.length) {
      predictions.push(makePrediction(
        'orphan_notes',
        `${orphanPaths.length} note(s) have no resolved incoming or outgoing wiki links.`,
        0.75,
        orphanPaths,
        { paths: orphanPaths },
        'Review whether these notes need an index link or are intentionally standalone.',
      ));
    }
  }
  for (const paths of markdownStems.values()) {
    if (paths.length < 2) continue;
    predictions.push(makePrediction(
      'duplicate_filename',
      `The filename "${path.posix.basename(paths[0])}" appears in multiple folders.`,
      0.99,
      paths,
      { paths },
      'Keep if folder context is intentional; otherwise adopt more specific names.',
    ));
  }

  const rootNotes = markdown.filter((entry) => !entry.path.includes('/')).map((entry) => entry.path);
  if (rootNotes.length >= 2) {
    predictions.push(makePrediction(
      'root_notes',
      `${rootNotes.length} Markdown notes are stored directly in the Vault root.`,
      0.8,
      rootNotes,
      { paths: rootNotes },
      'Review whether these are intentional entry points or need project routing.',
    ));
  }

  const topLevelCounts = new Map();
  for (const entry of markdown.filter((item) => item.path.includes('/'))) {
    const topLevel = entry.path.split('/')[0];
    const paths = topLevelCounts.get(topLevel) ?? [];
    paths.push(entry.path);
    topLevelCounts.set(topLevel, paths);
  }
  for (const [directory, paths] of topLevelCounts) {
    if (paths.length < 2) continue;
    predictions.push(makePrediction(
      'project_candidate',
      `Top-level folder "${directory}" may represent a project or project area.`,
      0.65,
      paths,
      { directory, markdown_file_count: paths.length, sample_paths: paths.slice(0, 10) },
      'Confirm its role and assign a stable Project ID only after review.',
    ));
  }

  const entryNames = new Set(['index', 'readme', 'overview', 'home', '00 home']);
  for (const directory of entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path)) {
    const descendants = markdown.filter((entry) => entry.path.startsWith(`${directory}/`));
    if (descendants.length < 2) continue;
    const hasEntry = descendants.some((entry) => {
      if (path.posix.dirname(entry.path) !== directory) return false;
      return entryNames.has(normalizeLookup(path.posix.basename(entry.path)));
    });
    if (hasEntry) continue;
    predictions.push(makePrediction(
      'directory_missing_index',
      `Directory "${directory}" contains ${descendants.length} notes but has no obvious entry note.`,
      0.8,
      [directory, ...descendants.slice(0, 10).map((entry) => entry.path)],
      { directory, markdown_file_count: descendants.length },
      'Review whether this directory needs an Index, README, Overview, or Home note.',
    ));
  }

  if (scanMode === 'metadata') {
    for (const entry of markdown.filter((item) => (
      item.metadata.truncated
      || item.metadata.encoding !== 'utf8'
      || item.metadata.frontmatter === 'unterminated'
    ))) {
      predictions.push(makePrediction(
        'incomplete_metadata_scan',
        `Metadata extraction for "${entry.path}" was incomplete.`,
        0.99,
        [entry.path],
        {
          encoding: entry.metadata.encoding,
          truncated: entry.metadata.truncated,
          frontmatter: entry.metadata.frontmatter,
        },
        'Use a targeted reader before making content-based decisions.',
        'medium',
      ));
    }
  }

  return predictions;
}

function environmentFingerprint(entries, ignoredPaths, ignoreRules, scanMode) {
  const canonical = {
    scanMode,
    ignoredPaths: [...ignoredPaths].sort(),
    ignoreRules: [...ignoreRules].sort(),
    entries: entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      byteSize: entry.byteSize,
      modifiedAt: entry.modifiedAt,
      contentHash: entry.contentHash,
      metadata: entry.metadata,
    })),
  };
  return sha256Buffer(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

function renderVaultMap(detail) {
  const lines = [
    '# Vault Map',
    '',
    `- Scan: ${detail.scan.id}`,
    `- Root: ${detail.scan.root_path}`,
    `- Files: ${detail.summary.files}`,
    `- Markdown files: ${detail.summary.markdown_files}`,
    `- Directories: ${detail.summary.directories}`,
    '',
    '## Structure',
    '',
  ];
  for (const entry of detail.entries) {
    lines.push(`- ${entry.kind === 'directory' ? '[D]' : '[F]'} ${entry.path}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderSetupReport(detail) {
  const lines = [
    '# Bootstrap Setup Report',
    '',
    `Scan: ${detail.scan.id}`,
    '',
    '## Reviewed Recommendations',
    '',
  ];
  if (!detail.predictions.length) lines.push('No recommendations were produced.');
  for (const prediction of detail.predictions) {
    lines.push(`### ${prediction.kind}: ${prediction.review?.decision ?? 'unreviewed'}`);
    lines.push('');
    lines.push(prediction.summary);
    lines.push('');
    lines.push(`Affected: ${prediction.affected_paths.join(', ') || '-'}`);
    lines.push(`Reason: ${prediction.review?.reason ?? '-'}`);
    lines.push('');
  }
  lines.push('## Registered Projects');
  lines.push('');
  if (!detail.projects?.length) lines.push('No Project candidates were accepted.');
  for (const project of detail.projects ?? []) {
    lines.push(`- ${project.id}: ${project.name} (${project.current_path})`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export class Bootstrap {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('Bootstrap requires a stateDir');
    this.stateDir = path.resolve(stateDir);
    this._ledger = null;
  }

  get ledger() {
    if (!this._ledger) this._ledger = new Ledger(this.stateDir);
    return this._ledger;
  }

  scan({
    root: rootInput,
    ignore = [],
    scanMode: scanModeInput = 'metadata',
    forceNew = false,
    caller = {},
  }) {
    const root = normalizeRoot(rootInput);
    if (isPathInside(root, this.stateDir)) {
      throw new Error(`Atlas state directory must be outside the scanned root: ${this.stateDir}`);
    }
    const ignoreRules = normalizeIgnoreRules(ignore);
    const scanMode = normalizeScanMode(scanModeInput);
    const { entries, ignoredPaths, contentFilesRead, contentBytesRead } = scanEnvironment(
      root,
      ignoreRules,
      scanMode,
    );
    const fingerprint = environmentFingerprint(entries, ignoredPaths, ignoreRules, scanMode);
    const existing = this.ledger.findBootstrapScan(root, fingerprint);
    if (existing && !forceNew) {
      return { ...this.ledger.getBootstrapDetail(existing.id).receipt, reused: true };
    }

    const previous = this.ledger.findLatestBootstrapScanForRoot(root);
    const previousDetail = previous ? this.ledger.getBootstrapDetail(previous.id) : null;
    const changes = compareEnvironment(previousDetail?.entries ?? null, entries, previous?.id ?? null);
    const predictions = inferPredictions(entries, scanMode);
    const startedAt = timestamp();
    const runId = makeScanId();
    const summary = {
      files: entries.filter((entry) => entry.kind === 'file').length,
      markdown_files: entries.filter((entry) => entry.kind === 'file' && entry.extension === '.md').length,
      directories: entries.filter((entry) => entry.kind === 'directory').length,
      symlinks: entries.filter((entry) => entry.kind === 'symlink').length,
      ignored_paths: ignoredPaths,
      ignore_rules: ignoreRules,
      scan_mode: scanMode,
      content_files_read: contentFilesRead,
      content_bytes_read: contentBytesRead,
      predictions: predictions.length,
      changes,
    };
    const receipt = {
      scan_id: runId,
      status: 'scanned',
      root,
      fingerprint,
      files: summary.files,
      markdown_files: summary.markdown_files,
      predictions: predictions.length,
      scan_mode: scanMode,
      content_files_read: contentFilesRead,
      content_bytes_read: contentBytesRead,
      changes: {
        added: changes.added.length,
        deleted: changes.deleted.length,
        modified: changes.modified.length,
        moved_candidates: changes.moved_candidates.length,
      },
      reused: false,
      forced_new_scan: Boolean(forceNew),
      started_at: startedAt,
    };
    this.ledger.createBootstrapScan({
      runId,
      root,
      fingerprint,
      entries,
      predictions,
      summary,
      receipt,
      caller,
      startedAt,
    });
    return receipt;
  }

  show(scanId) {
    return this.ledger.getBootstrapDetail(scanId);
  }

  context(scanId, { maxSamples = 5 } = {}) {
    if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 20) {
      throw new Error('Bootstrap context maxSamples must be an integer between 1 and 20.');
    }
    return buildAgentContext(this.show(scanId), maxSamples);
  }

  profiles() {
    return {
      profile_catalog_version: '1.0.0',
      profiles: listLibraryProfiles(),
      artifact_roles: ARTIFACT_ROLES,
      role_transitions: ROLE_TRANSITIONS,
      temp_policy: {
        inbox: 'durable_source_area',
        technical_temp: '.atlas/tmp',
        agent_work: '.atlas/work',
      },
    };
  }

  recommend(scanId, { profileId = null } = {}) {
    const detail = this.show(scanId);
    if (detail.scan.status === 'initialized') {
      throw new Error('Bootstrap Profile recommendations cannot be added after Initialize; create a new scan first.');
    }
    const recommendation = recommendLibraryProfile(detail.entries, { profileId });
    const predictions = buildDefaultProfilePredictions(recommendation);
    const sourceHash = sha256Buffer(Buffer.from(JSON.stringify(predictions), 'utf8'));
    const receipt = this.ledger.addBootstrapProposal({
      runId: scanId,
      sourceHash,
      predictions,
      caller: { actor: 'atlas', tool: 'atlas-default-profiles' },
      createdAt: timestamp(),
    });
    return {
      ...receipt,
      profile_id: recommendation.profile.id,
      profile_version: recommendation.profile.version,
      selection: recommendation.selection,
      confidence: recommendation.confidence,
      directory_mappings: recommendation.mappings,
      structure_plan: recommendation.structure_plan,
    };
  }

  contract(scanId, { profileId = null } = {}) {
    const detail = this.show(scanId);
    if (detail.scan.status === 'initialized') {
      throw new Error('A new Library Contract requires a new Bootstrap scan after Initialize.');
    }
    const recommendation = recommendLibraryProfile(detail.entries, { profileId });
    const receipt = this.recommend(scanId, { profileId });
    return buildLibraryContract(this.show(scanId), recommendation, receipt.prediction_ids);
  }

  adoptContract(scanId, { contractId, profileId = null, reason = null }) {
    if (!contractId) throw new Error('Library Contract adoption requires a contract ID.');
    if (!reason?.trim()) throw new Error('Library Contract adoption requires a reason.');
    const existing = this.show(scanId);
    if (existing.scan.status === 'initialized') {
      if (existing.receipt.contract_id !== contractId) {
        throw stateConflict('The scan is already initialized with a different Library Contract.');
      }
      return existing.receipt;
    }

    const contract = this.contract(scanId, { profileId });
    if (contract.contract_id !== contractId) {
      throw stateConflict('Library Contract does not match the current scan and Profile; it may be stale or changed.');
    }
    if (contract.status !== 'ready') {
      throw new Error(`Library Contract still needs input for ${contract.questions.length} question(s).`);
    }

    const acceptedIds = new Set(contract.approval.prediction_ids);
    const current = this.show(scanId);
    for (const prediction of current.predictions.filter((item) => acceptedIds.has(item.id))) {
      if (prediction.review && prediction.review.decision !== 'accepted') {
        throw new Error(
          `Library Contract conflicts with an existing ${prediction.review.decision} review: ${prediction.id}.`,
        );
      }
    }
    for (const prediction of current.predictions) {
      if (prediction.review) continue;
      const decision = acceptedIds.has(prediction.id) ? 'accepted' : 'deferred';
      this.review(prediction.id, {
        decision,
        reason: decision === 'accepted'
          ? reason.trim()
          : `Deferred by ${contract.contract_id}; not accepted or rejected.`,
      });
    }
    return this.initialize(scanId, { libraryContract: contract });
  }

  propose(scanId, { predictions, caller = {} }) {
    const detail = this.show(scanId);
    if (detail.scan.status === 'initialized') {
      throw new Error('Bootstrap Predictions cannot be added after Initialize; create a new scan first.');
    }
    const normalized = normalizeAgentPredictions(predictions, detail, caller);
    const sourceHash = sha256Buffer(Buffer.from(JSON.stringify(normalized), 'utf8'));
    return this.ledger.addBootstrapProposal({
      runId: scanId,
      sourceHash,
      predictions: normalized,
      caller,
      createdAt: timestamp(),
    });
  }

  status() {
    return this.ledger.listBootstrapRuns();
  }

  review(predictionId, { decision, reason = null }) {
    if (!['accepted', 'rejected', 'corrected', 'deferred'].includes(decision)) {
      throw new Error('Bootstrap review decision must be accepted, rejected, corrected, or deferred.');
    }
    return this.ledger.reviewBootstrapPrediction(predictionId, {
      decision,
      reason,
      reviewedAt: timestamp(),
    });
  }

  initialize(scanId, { libraryContract = null } = {}) {
    const detail = this.show(scanId);
    if (detail.scan.status === 'initialized') return detail.receipt;
    const unreviewed = detail.predictions.filter((prediction) => !prediction.review);
    if (unreviewed.length) {
      throw new Error(
        `Bootstrap Initialize requires review of ${unreviewed.length} remaining Prediction(s).`,
      );
    }

    const initializedAt = timestamp();
    const projects = detail.predictions
      .filter((prediction) => prediction.kind === 'project_candidate' && prediction.review?.decision === 'accepted')
      .map((prediction) => this.ledger.ensureProjectFromBootstrapPrediction(prediction.id, initializedAt).project);
    const initializedDetail = { ...detail, projects };
    const outputDir = path.join(this.stateDir, 'environments', scanId);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'vault-map.md'), renderVaultMap(initializedDetail), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'setup-report.md'), renderSetupReport(initializedDetail), 'utf8');
    const acceptedPredictions = detail.predictions.filter(
      (prediction) => prediction.review?.decision === 'accepted',
    );
    const acceptedAgentPredictions = acceptedPredictions.filter((prediction) => prediction.source === 'agent');
    const profilePredictions = acceptedPredictions.filter(
      (prediction) => prediction.kind === 'library_profile_candidate',
    );
    if (profilePredictions.length > 1) {
      throw new Error('Bootstrap Initialize accepts at most one library Profile candidate per scan.');
    }
    const routingRules = acceptedPredictions.filter((prediction) => [
      'folder_role', 'naming_rule_candidate', 'routing_rule_candidate',
    ].includes(prediction.kind));
    const classifications = acceptedPredictions.filter((prediction) => [
      'folder_role', 'artifact_role',
    ].includes(prediction.kind));
    fs.writeFileSync(
      path.join(outputDir, 'routing-rules.json'),
      `${JSON.stringify(routingRules, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(outputDir, 'artifact-classifications.json'),
      `${JSON.stringify(classifications, null, 2)}\n`,
      'utf8',
    );
    let activePolicy = null;
    let selectedProfile = null;
    let structurePlan = null;
    if (profilePredictions.length === 1) {
      selectedProfile = getLibraryProfile(profilePredictions[0].evidence.profile_id);
      structurePlan = acceptedPredictions.find(
        (prediction) => prediction.kind === 'structure_plan_candidate'
          && prediction.evidence?.profile_id === selectedProfile.id,
      )?.evidence?.plan ?? null;
      const policy = compileEnvironmentPolicy(
        detail,
        profilePredictions[0],
        acceptedPredictions,
        libraryContract,
      );
      activePolicy = this.ledger.activateEnvironmentPolicy({
        runId: scanId,
        root: detail.scan.root_path,
        policy,
        activatedAt: initializedAt,
      });
    }
    fs.writeFileSync(
      path.join(outputDir, 'library-profile.json'),
      `${JSON.stringify({
        profile: selectedProfile,
        accepted_prediction_id: profilePredictions[0]?.id ?? null,
        active_policy_id: activePolicy?.id ?? null,
        rule_version_id: activePolicy?.rule_version_id ?? null,
      }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(outputDir, 'structure-plan.json'),
      `${JSON.stringify(structurePlan ?? {
        version: 'atlas-structure-plan.v1',
        read_only: true,
        source_changes: [],
        operations: [],
        note: 'No accepted default Profile structure plan.',
      }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(outputDir, 'environment.json'),
      `${JSON.stringify({
        scan: detail.scan,
        summary: detail.summary,
        entries: detail.entries,
        predictions: detail.predictions,
        projects,
        active_policy: activePolicy,
      }, null, 2)}\n`,
      'utf8',
    );
    const receipt = {
      ...detail.receipt,
      status: 'initialized',
      output_dir: outputDir,
      registered_projects: projects.length,
      accepted_agent_predictions: acceptedAgentPredictions.length,
      accepted_profile_predictions: profilePredictions.length,
      profile_id: selectedProfile?.id ?? null,
      active_policy_id: activePolicy?.id ?? null,
      active_rule_version_id: activePolicy?.rule_version_id ?? null,
      contract_id: libraryContract?.contract_id ?? null,
      initialized_at: initializedAt,
    };
    this.ledger.finishBootstrapInitialize(scanId, receipt, initializedAt);
    return receipt;
  }

  dispose() {
    if (this._ledger) this._ledger.close();
    this._ledger = null;
  }
}
