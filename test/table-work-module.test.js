import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { contentFileFingerprint } from '../src/content-inspection.js';
import { SaveService } from '../src/save-service.js';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createSavedWorkService } from '../src/ui/services/saved-work-service.js';
import { createTableWorkModule, TABLE_WORK_MODULE_DESCRIPTOR } from '../src/table-work-module.js';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';

const temporaryRoot = path.resolve('test', '.tmp');

test('Table Work Module shares a bounded Project-scoped CSV Work through Save', async (t) => {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'table-work-module-'));
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'A');
  const foreignProjectPath = path.join(workspace, 'B');
  const sourcePath = path.join(projectPath, 'Data', 'input.csv');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.join(projectPath, 'Results'), { recursive: true });
  fs.mkdirSync(path.join(foreignProjectPath, 'Data'), { recursive: true });
  fs.writeFileSync(sourcePath, 'name,value\nalpha,1\nbeta,2\n', 'utf8');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const a = registry.create({ name: 'A', currentPath: 'A' });
  const b = registry.create({ name: 'B', currentPath: 'B' });
  registry.attachRoot(a.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Table Module fixture.' });
  registry.attachRoot(b.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'Table Module boundary fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const projectA = { id: a.project_id, name: a.name };
  const projectB = { id: b.project_id, name: b.name };
  const resource = control.identify({ filePath: sourcePath, project: projectA });
  const dataWork = createDataWorkService({
    stateDir, projectRoot: path.resolve('.'), installationRoot: path.resolve('.'), resourceControl: control,
    fingerprintFn: async (filePath) => contentFileFingerprint(filePath),
    runDataWorkFn: async ({ filePath, expectedSha256, action, requestPath, outputPath }) => {
      const fingerprint = contentFileFingerprint(filePath);
      if (expectedSha256 && fingerprint.sha256 !== expectedSha256) throw new Error('Table Module fixture Source changed during processing.');
      const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/u);
      const headers = lines[0].split(',');
      const sourceRows = lines.slice(1).map((line) => line.split(','));
      if (action === 'profile') return {
        status: 'ready', source: fingerprint, processor: { version: 'table-module-fixture' }, sheets: [],
        profile: { rows: sourceRows.length, columns: headers.length, null_cells: 0, duplicate_rows: 0,
          fields: headers.map((name) => ({ name, inferred_type: sourceRows.every((row) => Number.isFinite(Number(row[headers.indexOf(name)]))) ? 'number' : 'text', missing_count: 0, distinct_count: sourceRows.length })) },
      };
      if (!['preview', 'export'].includes(action)) throw new Error(`Unexpected Table Module fixture action: ${action}`);
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
      const selected = request.recipe?.steps?.find((step) => step.operation === 'select')?.columns ?? null;
      const outputColumns = selected?.length ? selected : request.mapping.map((item) => item.canonical);
      const mappedRows = sourceRows.map((row) => request.mapping.map((item) => row[headers.indexOf(item.column)]));
      const outputIndexes = outputColumns.map((name) => request.mapping.findIndex((item) => item.canonical === name));
      const outputRows = mappedRows.map((row) => outputIndexes.map((index) => row[index]));
      const result = {
        processor: { version: 'table-module-fixture' }, columns: outputColumns, rows: outputRows,
        preview: { rows_shown: outputRows.length, total_rows: outputRows.length },
        result_summary: { rows: outputRows.length, columns: outputColumns.length },
        validation: { input_rows: sourceRows.length, output_rows: outputRows.length, null_cells: 0, duplicate_rows: 0, conversion_failures: {} },
      };
      if (action === 'export') {
        const csv = [outputColumns, ...outputRows].map((row) => row.map((cell) => String(cell ?? '')).join(',')).join('\n') + '\n';
        fs.writeFileSync(outputPath, csv, 'utf8');
        const staged = contentFileFingerprint(outputPath);
        return { ...result, staged: { path: staged.file_path, sha256: staged.sha256, bytes: staged.bytes } };
      }
      return result;
    },
  });
  const saveService = new SaveService({ stateDir });
  const savedWork = createSavedWorkService({ stateDir, saveService });
  const resolveProject = (projectId) => {
    const project = registry.list().find((item) => item.id === projectId && item.status === 'active');
    if (!project) return null;
    const location = registry.show(projectId).location;
    if (!location?.root_path || location.relative_path == null) return null;
    return { project: { id: project.id, name: project.name, status: project.status }, location };
  };
  const module = createTableWorkModule({ dataWork, savedWork, resolveProject });
  t.after(() => {
    saveService.dispose();
    control.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  assert.equal(module.describe().module_id, TABLE_WORK_MODULE_DESCRIPTOR.module_id);
  assert.equal(module.describe().protocol, MODULE_PROTOCOL_VERSION);
  await assert.rejects(module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    action: 'cancel', parameters: {},
  }), { code: 'ATLAS_MODULE_ACTION_UNSUPPORTED' });
  const start = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    action: 'start', parameters: { resource_ids: [resource.resource_id], intent: 'Summarize the rows', caller: { actor: 'agent', tool: 'fixture', client_run_id: 'table-module-start' } },
  });
  const work = start.data;
  assert.match(work.session_id, /^DWT-/u);
  assert.equal(start.state.work.session_id, work.session_id);
  assert.equal(start.state.work.revision, work.revision);
  assert.equal(start.state.sources[0].resource_id, resource.resource_id);
  assert.equal(start.state.actions.find((item) => item.action === 'preview').executable, false);

  await assert.rejects(module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: b.project_id,
    work: { session_id: work.session_id, base_revision: work.revision }, action: 'show', parameters: {},
  }), { code: 'ATLAS_MODULE_PROJECT_MISMATCH' });

  const prepared = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: work.revision }, action: 'prepare', parameters: {},
  });
  const ready = prepared.data;
  assert.equal(ready.sources[0].status, 'ready');
  assert.match(prepared.state.sources[0].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(prepared.state.sources[0].resource_id, resource.resource_id);
  const mapping = ready.sources.flatMap((source) => source.profile.profile.fields.map((field) => ({ source_key: source.source_key, column: field.name, canonical: field.name })));
  const aligned = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: ready.revision }, action: 'align', parameters: { mapping },
  });
  assert.notEqual(aligned.data.revision, work.revision);
  const stale = module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: work.revision }, action: 'align',
    parameters: { mapping },
  });
  await assert.rejects(stale, { code: 'ATLAS_STATE_CONFLICT' });

  const recipe = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: aligned.data.revision }, action: 'recipe',
    parameters: { combine: 'concatenate', select_columns: ['name', 'value'] },
  });
  const previewed = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: recipe.data.revision }, action: 'preview', parameters: {},
  });
  const preview = await module.readPreview({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: previewed.data.revision },
    preview_revision: previewed.data.preview_revision,
  });
  assert.equal(preview.work.session_id, work.session_id);
  assert.equal(preview.work.revision, previewed.data.revision);
  assert.ok(Buffer.byteLength(JSON.stringify(preview.preview), 'utf8') <= preview.limits.max_utf8_bytes);
  assert.ok((preview.preview.rows?.length ?? 0) <= preview.limits.max_rows);
  assert.ok((preview.preview.columns?.length ?? 0) <= preview.limits.max_columns);
  assert.equal(preview.preview.complete, true);
  assert.deepEqual(preview.preview.truncated_reasons, []);

  const savePreparation = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: previewed.data.revision }, action: 'prepare-save',
    parameters: { folder: 'Results', file_name: 'summary.csv', format: 'csv' },
  });
  const stage = savePreparation.data;
  assert.match(stage.candidate_sha256, /^[a-f0-9]{64}$/u);
  const repeatedSavePreparation = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: previewed.data.revision }, action: 'prepare-save',
    parameters: { folder: 'Results', file_name: 'summary.csv', format: 'csv' },
  });
  const repeatedStage = repeatedSavePreparation.data;
  assert.equal(repeatedStage.stage_id, stage.stage_id);
  assert.equal(repeatedStage.candidate_sha256, stage.candidate_sha256);
  const stageDirectory = path.dirname(dataWork.persistentStage(work.session_id).path);
  const stagePrefix = `${work.session_id}-r${previewed.data.revision}-`;
  assert.equal(fs.readdirSync(stageDirectory).filter((name) => name.startsWith(stagePrefix) && name.endsWith('.csv')).length, 1);
  await assert.rejects(module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: stage.revision }, action: 'confirm-save',
    parameters: { ...stage, candidate_sha256: '0'.repeat(64), folder: 'Results', file_name: 'summary.csv', format: 'csv', request_key: 'table-module-save', reason: 'Approved.', caller: { actor: 'agent', tool: 'fixture', client_run_id: 'table-module-save' } },
  }), { code: 'ATLAS_STATE_CONFLICT' });

  const confirmedParameters = { ...stage, folder: 'Results', file_name: 'summary.csv', format: 'csv', channel: 'work', request_key: 'table-module-save', reason: 'Approved.', caller: { actor: 'agent', tool: 'fixture', client_run_id: 'table-module-save' } };
  const saved = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: stage.revision }, action: 'confirm-save',
    parameters: confirmedParameters,
  });
  assert.equal(saved.data.status, 'executed');
  assert.equal(saved.data.channel, 'work');
  assert.ok(saved.data.save_id);
  assert.equal(saved.state.work.latest_save_id, saved.data.work_id);
  const outputPath = path.join(projectPath, 'Results', 'summary.csv');
  const outputText = fs.readFileSync(outputPath, 'utf8');
  assert.equal(outputText, 'name,value\nalpha,1\nbeta,2\n');
  assert.equal(contentFileFingerprint(outputPath).sha256, createHash('sha256').update(outputText, 'utf8').digest('hex'));
  const replayed = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: stage.revision }, action: 'confirm-save',
    parameters: confirmedParameters,
  });
  assert.equal(replayed.data.save_id, saved.data.save_id);
  assert.equal(replayed.data.current_output, 'verified');
  assert.equal(fs.readFileSync(outputPath, 'utf8'), outputText);
  await assert.rejects(module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: stage.revision }, action: 'confirm-save',
    parameters: { ...confirmedParameters, candidate_sha256: '0'.repeat(64) },
  }), { code: 'ATLAS_STATE_CONFLICT' });
  fs.appendFileSync(outputPath, 'external edit\n');
  const changed = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: stage.revision }, action: 'confirm-save',
    parameters: confirmedParameters,
  });
  assert.equal(changed.data.save_id, saved.data.save_id);
  assert.equal(changed.data.verified, false);
  assert.equal(changed.data.current_output, 'changed');
  assert.match(fs.readFileSync(outputPath, 'utf8'), /external edit/u);
  const shown = await module.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: work.session_id, base_revision: saved.state.work.revision }, action: 'show', parameters: {},
  });
  assert.equal(shown.data.latest_result.work_id, saved.data.work_id);
  assert.equal(shown.state.saves.latest_save_id, saved.data.work_id);

  const pinnedSession = {
    session_id: 'DWT-pinned-not-ready', project_id: a.project_id, revision: 4, status: 'open', intent: 'Pinned blocker',
    sources: [{ source_key: 'source-1', resource_id: resource.resource_id, name: 'input.csv', status: 'changed', version_policy: 'pinned_version', fingerprint: { sha256: 'a'.repeat(64) }, error_message: 'The pinned Source version is unavailable.' }],
    mapping: [], mapping_complete: false, recipe: { version: 1 }, preview: null, preview_revision: null,
  };
  const projected = createTableWorkModule({
    dataWork: { session: () => pinnedSession, validateSources: async () => pinnedSession, persistentStage: () => null },
    savedWork, resolveProject,
  });
  const pinnedState = await projected.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: pinnedSession.session_id, base_revision: pinnedSession.revision }, action: 'show', parameters: {},
  });
  assert.equal(pinnedState.state.sources[0].version_policy, 'pinned_version');
  assert.equal(pinnedState.state.actions.find((item) => item.action === 'preview').executable, false);

  const oversizedPreviewSession = {
    ...pinnedSession,
    revision: 5,
    preview: { rows: Array.from({ length: 51 }, (_, index) => `row-${index}`), columns: ['value'] },
    preview_revision: 5,
  };
  const previewModule = createTableWorkModule({
    dataWork: { session: () => oversizedPreviewSession }, savedWork, resolveProject,
  });
  const bounded = await previewModule.readPreview({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: oversizedPreviewSession.session_id, base_revision: oversizedPreviewSession.revision },
    preview_revision: oversizedPreviewSession.preview_revision,
  });
  assert.equal(bounded.preview.complete, false);
  assert.ok(bounded.preview.truncated_reasons.includes('rows'));
  assert.equal(bounded.preview.rows.length, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.preview), 'utf8') <= bounded.limits.max_utf8_bytes);

  const incompleteMappingSession = {
    ...pinnedSession,
    revision: 6,
    sources: [{
      ...pinnedSession.sources[0], status: 'ready',
      profile: { profile: { fields: [{ name: 'name' }, { name: 'value' }] } },
    }],
    mapping: [
      { source_key: 'source-1', column: 'name', canonical: 'name' },
      { source_key: 'source-1', column: 'value', canonical: 'value' },
    ],
    mapping_complete: false,
    preview: null,
    preview_revision: null,
  };
  const incompleteMappingModule = createTableWorkModule({
    dataWork: {
      session: () => incompleteMappingSession,
      validateSources: async () => incompleteMappingSession,
      persistentStage: () => null,
    },
    savedWork, resolveProject,
  });
  const incompleteMapping = await incompleteMappingModule.invoke({
    protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: a.project_id,
    work: { session_id: incompleteMappingSession.session_id, base_revision: incompleteMappingSession.revision },
    action: 'show', parameters: {},
  });
  assert.equal(incompleteMapping.state.actions.find((item) => item.action === 'preview').executable, false);
});
