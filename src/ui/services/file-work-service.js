import fs from 'node:fs';
import path from 'node:path';
import {
  contentFileFingerprint, inspectContent, readCachedContentInspection,
} from '../../content-inspection.js';
import {
  recentWorkById, touchRecentWork,
} from '../recent-work.js';
import { runUiContentOperation } from '../content-worker-client.js';
import { inspectionCacheReference, recordInspectionWork } from '../../work-coordination.js';

export const cacheReference = inspectionCacheReference;

export function defaultInspectPurpose(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.xlsx') return 'structure';
  if (['.csv', '.tsv'].includes(extension)) return 'data';
  return 'content';
}

export function createFileWorkService({ stateDir, projectForFile, runContentOperation = runUiContentOperation, resourceControl = null }) {
  function finishInspection({ filePath, inspectOptions, inspection, sourceFingerprint, project, persistUnsupported }) {
    if (inspection?.extraction?.status === 'unsupported' && !persistUnsupported) {
      return { work: null, inspection, inspect: inspectOptions };
    }
    const work = recordInspectionWork({
      stateDir,
      filePath,
      inspect: inspectOptions,
      sourceFingerprint,
      inspection,
      project: project === undefined ? projectForFile(filePath) : project,
      caller: { actor: 'user', tool: 'atlas-desktop' },
      channel: 'desktop',
      resourceControl,
    });
    return { work, inspection, inspect: inspectOptions };
  }

  function inspect({
    filePath, purpose = null, sheet = null, maxCharacters = 4000, project = undefined, persistUnsupported = true,
  }) {
    const inspectOptions = {
      purpose: purpose || defaultInspectPurpose(filePath),
      sheet: sheet || null,
      maxCharacters,
    };
    const inspection = inspectContent({ stateDir, filePath, ...inspectOptions });
    const sourceFingerprint = contentFileFingerprint(filePath);
    if (sourceFingerprint.sha256 !== inspection.source?.sha256) {
      const error = new Error('The file changed while Atlas was inspecting it. Inspect the current file again.');
      error.code = 'ATLAS_STATE_CONFLICT';
      throw error;
    }
    return finishInspection({ filePath, inspectOptions, inspection, sourceFingerprint, project, persistUnsupported });
  }

  async function inspectAsync({
    filePath, purpose = null, sheet = null, maxCharacters = 4000, project = undefined, persistUnsupported = true,
  }) {
    const inspectOptions = {
      purpose: purpose || defaultInspectPurpose(filePath),
      sheet: sheet || null,
      maxCharacters,
    };
    const processed = await runContentOperation('inspect', {
      stateDir, filePath, ...inspectOptions,
    });
    return finishInspection({
      filePath,
      inspectOptions,
      inspection: processed.inspection,
      sourceFingerprint: processed.source_fingerprint,
      project,
      persistUnsupported,
    });
  }

  function continueWork(workId) {
    const work = recentWorkById(stateDir, workId);
    if (!work) throw new Error('This Recent Work item is no longer available.');
    const continued = () => touchRecentWork(stateDir, work.work_id) ?? work;
    if (!fs.existsSync(work.file_path)) return { mode: 'missing', work: continued() };
    const sourceFingerprint = contentFileFingerprint(work.file_path);
    if (sourceFingerprint.sha256 !== work.source_fingerprint.sha256) {
      return { mode: 'changed', work: continued() };
    }
    const inspection = readCachedContentInspection({
      stateDir,
      filePath: work.file_path,
      purpose: work.inspect.purpose,
      sheet: work.inspect.sheet,
      maxCharacters: work.inspect.max_characters,
      cacheReference: work.cache_reference,
    });
    if (!inspection) return { mode: 'cache-missing', work: continued() };
    return { mode: 'unchanged', work: continued(), inspection };
  }

  async function continueWorkAsync(workId) {
    const work = recentWorkById(stateDir, workId);
    if (!work) throw new Error('This Recent Work item is no longer available.');
    const continued = () => touchRecentWork(stateDir, work.work_id) ?? work;
    if (!fs.existsSync(work.file_path)) return { mode: 'missing', work: continued() };
    const sourceFingerprint = await runContentOperation('fingerprint', { filePath: work.file_path });
    if (sourceFingerprint.sha256 !== work.source_fingerprint.sha256) {
      return { mode: 'changed', work: continued() };
    }
    const inspection = readCachedContentInspection({
      stateDir,
      filePath: work.file_path,
      purpose: work.inspect.purpose,
      sheet: work.inspect.sheet,
      maxCharacters: work.inspect.max_characters,
      cacheReference: work.cache_reference,
    });
    if (!inspection) return { mode: 'cache-missing', work: continued() };
    return { mode: 'unchanged', work: continued(), inspection };
  }

  function cachedInspection(work) {
    if (!work) return null;
    return readCachedContentInspection({
      stateDir, filePath: work.file_path, purpose: work.inspect.purpose,
      sheet: work.inspect.sheet, maxCharacters: work.inspect.max_characters,
      cacheReference: work.cache_reference,
    });
  }

  return {
    inspect,
    inspectAsync,
    continueWork,
    continueWorkAsync,
    cachedInspection,
    recentWorkById: (workId) => recentWorkById(stateDir, workId),
  };
}
