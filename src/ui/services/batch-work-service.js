import fs from 'node:fs';
import path from 'node:path';
import { describeFileReadFailure } from '../file-read-failure.js';

export function createBatchWorkService({ fileWork, projectImport, inspectionFact }) {
  function inspectQueue(items) {
    const results = [];
    for (const item of items) {
      if (item.supported === false) {
        results.push({ item_id: item.item_id, path: item.path, name: item.name, status: 'unsupported', fact: 'Not imported', error: item.reason });
        continue;
      }
      try {
        const inspected = fileWork.inspect({
          filePath: item.path,
          purpose: null,
          sheet: null,
          maxCharacters: 4000,
          persistUnsupported: false,
        });
        if (inspected.inspection?.extraction?.status === 'unsupported') {
          results.push({
            item_id: item.item_id,
            path: item.path,
            name: item.name,
            status: 'unsupported',
            fact: 'Unsupported',
            error: inspected.inspection.next_action?.reason ?? 'This file type has no built-in local reader.',
          });
          continue;
        }
        results.push({
          item_id: item.item_id,
          path: item.path,
          name: item.name,
          status: 'inspected',
          fact: inspectionFact(inspected.inspection),
          work_id: inspected.work.work_id,
          project: inspected.work.project ?? null,
        });
      } catch (error) {
        results.push({ item_id: item.item_id, path: item.path, name: item.name, status: 'failed', ...describeFileReadFailure(error), error: error.message });
      }
    }
    return results;
  }

  async function inspectQueueAsync(items) {
    const results = [];
    for (const item of items) {
      if (item.supported === false) {
        results.push({ item_id: item.item_id, path: item.path, name: item.name, status: 'unsupported', fact: 'Not imported', error: item.reason });
        continue;
      }
      try {
        const inspected = await fileWork.inspectAsync({
          filePath: item.path,
          purpose: null,
          sheet: null,
          maxCharacters: 4000,
          persistUnsupported: false,
        });
        if (inspected.inspection?.extraction?.status === 'unsupported') {
          results.push({
            item_id: item.item_id,
            path: item.path,
            name: item.name,
            status: 'unsupported',
            fact: 'Unsupported',
            error: inspected.inspection.next_action?.reason ?? 'This file type has no built-in local reader.',
          });
          continue;
        }
        results.push({
          item_id: item.item_id,
          path: item.path,
          name: item.name,
          status: 'inspected',
          fact: inspectionFact(inspected.inspection),
          work_id: inspected.work.work_id,
          project: inspected.work.project ?? null,
        });
      } catch (error) {
        results.push({ item_id: item.item_id, path: item.path, name: item.name, status: 'failed', ...describeFileReadFailure(error), error: error.message });
      }
    }
    return results;
  }

  function prepareImports({ workIds, projectId, folder }) {
    return workIds.map((workId) => {
      const work = fileWork.recentWorkById(workId);
      if (!work || work.project?.id || projectImport.projectForFile(work?.file_path)?.id) {
        return { work_id: workId, name: work ? path.basename(work.file_path) : 'Unavailable file', status: 'Not available' };
      }
      try {
        const destination = projectImport.destinationForFolder(projectId, folder, work.file_path);
        if (fs.existsSync(destination.target_path)) {
          return { work_id: workId, name: path.basename(work.file_path), target_path: destination.target_path, status: 'Conflict — already exists' };
        }
        const prepared = projectImport.prepare({ work, projectId, folder });
        return {
          work_id: workId,
          name: path.basename(work.file_path),
          target_path: prepared.target_path,
          status: 'Ready to save',
          prepared,
        };
      } catch (error) {
        return { work_id: workId, name: path.basename(work.file_path), status: error.message };
      }
    });
  }

  function saveImports(items) {
    return items.map((item) => {
      try {
        return { work_id: item.work_id, status: 'saved', work: projectImport.save(item.prepared) };
      } catch (error) {
        return { work_id: item.work_id, status: 'failed', error: error.message };
      }
    });
  }

  async function saveImportsAsync(items) {
    const results = [];
    for (const item of items) {
      try {
        results.push({ work_id: item.work_id, status: 'saved', work: await projectImport.saveAsync(item.prepared) });
      } catch (error) {
        results.push({ work_id: item.work_id, status: 'failed', error: error.message });
      }
    }
    return results;
  }

  return { inspectQueue, inspectQueueAsync, prepareImports, saveImports, saveImportsAsync };
}
