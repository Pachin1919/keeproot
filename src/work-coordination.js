import path from 'node:path';
import { upsertRecentWork } from './ui/recent-work.js';

export function inspectionCacheReference(stateDir, cachePath) {
  const reference = path.relative(path.resolve(stateDir), path.resolve(cachePath));
  if (!reference || reference.startsWith('..') || path.isAbsolute(reference)) {
    throw new Error('Atlas inspection cache is outside its local state directory.');
  }
  return reference;
}

export function inspectionResultSummary(inspection) {
  const extraction = inspection?.extraction ?? {};
  const profile = extraction.profile ?? extraction.data_profile ?? extraction;
  if (Number.isFinite(profile.row_count) && Number.isFinite(profile.column_count)) {
    return {
      label: `${profile.row_count} rows · ${profile.column_count} fields`,
      rows: profile.row_count,
      columns: profile.column_count,
    };
  }
  if (Array.isArray(extraction.sheets)) {
    return { label: `${extraction.sheets.length} sheet${extraction.sheets.length === 1 ? '' : 's'}`, sheets: extraction.sheets.length };
  }
  if (Number.isFinite(extraction.page_count)) {
    return { label: `${extraction.page_count} pages`, pages: extraction.page_count };
  }
  if (Number.isFinite(extraction.paragraph_count)) {
    return { label: `${extraction.paragraph_count} paragraphs`, paragraphs: extraction.paragraph_count };
  }
  if (Number.isFinite(extraction.slide_count)) {
    return { label: `${extraction.slide_count} slides`, slides: extraction.slide_count };
  }
  return {
    label: extraction.status === 'unsupported' ? 'Unsupported file type' : 'Local inspection ready',
  };
}

export function inspectionInitiator(caller = {}, channel = 'host') {
  return {
    channel,
    actor: caller.actor ?? (channel === 'desktop' ? 'user' : 'unknown'),
    agent: caller.agent ?? null,
    model: caller.model ?? null,
    tool: caller.tool ?? (channel === 'desktop' ? 'atlas-desktop' : 'atlas-cli'),
    client_run_id: caller.client_run_id ?? caller.clientRunId ?? null,
  };
}

export function recordInspectionWork({
  stateDir,
  filePath,
  inspect,
  inspection,
  sourceFingerprint,
  project = null,
  caller = {},
  channel = 'host',
}) {
  return upsertRecentWork({
    stateDir,
    filePath,
    inspect,
    sourceFingerprint,
    inspectionId: inspection.inspection_id,
    cacheReference: inspectionCacheReference(stateDir, inspection.cache_path),
    project,
    initiatedBy: inspectionInitiator(caller, channel),
    inspectionCacheHit: inspection.cache_hit === true,
    resultSummary: inspectionResultSummary(inspection),
  });
}
