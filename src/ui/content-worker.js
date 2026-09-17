import { parentPort, workerData } from 'node:worker_threads';
import {
  compareContent,
  contentFileFingerprint,
  inspectContent,
  runDataWork,
} from '../content-inspection.js';
import { Intake } from '../intake.js';
import { createSaveService } from '../save-service.js';
import { saveProjectImport } from './services/project-import-service.js';

function execute(operation, args) {
  if (operation === 'fingerprint') return contentFileFingerprint(args.filePath);
  if (operation === 'inspect') {
    const inspection = inspectContent(args);
    const sourceFingerprint = contentFileFingerprint(args.filePath);
    if (sourceFingerprint.sha256 !== inspection.source?.sha256) {
      const error = new Error('The file changed while Atlas was inspecting it. Inspect the current file again.');
      error.code = 'ATLAS_STATE_CONFLICT';
      throw error;
    }
    return { inspection, source_fingerprint: sourceFingerprint };
  }
  if (operation === 'compare') return compareContent(args);
  if (operation === 'data-work') return runDataWork(args);
  if (operation === 'project-import-save') {
    const intake = new Intake({ stateDir: args.stateDir });
    const saveService = createSaveService({ stateDir: args.stateDir, intake });
    try {
      return saveProjectImport({ stateDir: args.stateDir, saveService, imported: args.imported });
    } finally {
      saveService.dispose();
    }
  }
  throw new Error(`Unsupported Atlas UI content operation: ${operation}`);
}

try {
  parentPort.postMessage({ ok: true, result: execute(workerData.operation, workerData.args) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: error?.code ?? null,
    },
  });
}
