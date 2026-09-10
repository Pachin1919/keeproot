import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  CONTENT_INSPECTION_SCHEMA, CONTENT_PROCESSOR_VERSION, contentFileFingerprint,
  contentComparisonSupported, inspectContent,
} from '../src/content-inspection.js';
import { Intake } from '../src/intake.js';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { renderStatusGuide } from '../src/ui/components.js';
import { browseProjectFiles, listProjectFolders, searchProjectFiles } from '../src/ui/project-files.js';
import { buildProjectResourceDetailModel, buildProjectResourcesModel, summarizeProjectResources } from '../src/ui/read-model/project-resources-model.js';
import { readRecentWorkState, removeRecentWork, upsertRecentWork } from '../src/ui/recent-work.js';
import {
  beginCurrentActivity, failCurrentActivity, finishCurrentActivity, readCurrentActivityState,
} from '../src/ui/current-activity.js';
import { createSavedWorkService, readSavedWorkState } from '../src/ui/services/saved-work-service.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createProjectImportService, saveProjectImport } from '../src/ui/services/project-import-service.js';
import { createProjectOnboardingService } from '../src/ui/services/project-onboarding-service.js';
import { createDesktopSelectionService } from '../src/ui/services/desktop-selection-service.js';
import { runUiContentOperation } from '../src/ui/content-worker-client.js';
import { renderFileCompareView } from '../src/ui/views/file-compare-view.js';
import { renderFileWorkView } from '../src/ui/views/file-work-view.js';
import { renderActivityView } from '../src/ui/views/activity-view.js';
import { renderBatchWorkView } from '../src/ui/views/batch-work-view.js';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';
import { renderProjectResourcesView } from '../src/ui/views/project-resources-view.js';
import { renderProjectsHomeView } from '../src/ui/views/projects-home-view.js';
import { renderSettingsView } from '../src/ui/views/settings-view.js';
import { normalizeUiPreferences, preferenceHtmlAttributes, UI_PREFERENCE_DEFAULTS } from '../src/ui/preferences.js';
import { describeFileReadFailure } from '../src/ui/file-read-failure.js';

const testRoot = path.resolve('test', '.tmp');

function temporaryDirectory(t) {
  fs.mkdirSync(testRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(testRoot, 'data-work-regression-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
  return filePath;
}

function saveInput(root) {
  const projectRoot = path.join(root, 'project');
  const sourcePath = write(path.join(root, 'source.csv'), 'name\nsource\n');
  const stagedPath = write(path.join(root, 'staged.csv'), 'name\nresult\n');
  fs.mkdirSync(projectRoot, { recursive: true });
  return {
    project: { id: 'project-1', name: 'Project One' }, projectRoot, folder: '',
    fileName: 'result.csv', stagedPath, sourcePath,
    sourceFingerprint: contentFileFingerprint(sourcePath), parameters: {}, resultSummary: {},
  };
}

test('Status guide opens outside the clipping sidebar and points back to the related work', () => {
  const css = fs.readFileSync(path.resolve('src', 'ui', 'styles', 'components.css'), 'utf8');
  const panelRule = css.match(/\.status-guide-panel\s*\{(?<rule>[^}]*)\}/u)?.groups?.rule ?? '';
  assert.match(panelRule, /position:\s*fixed/u);
  assert.doesNotMatch(panelRule, /position:\s*absolute/u);
  const guide = renderStatusGuide();
  assert.match(guide, /popover="manual"/u);
  assert.match(guide, /data-status-guide-toggle/u);
  assert.match(guide, /Open the related work or resource/u);
  assert.match(guide, /status-progress">In progress/u);
  assert.match(guide, /status-safe">Normal[\s\S]*Restored/u);
  assert.match(guide, /status-warn">Waiting or attention[\s\S]*Not checked · Partial/u);
  assert.match(guide, /status-danger">Atlas stopped[\s\S]*Rejected/u);
  assert.doesNotMatch(guide, /Task page/u);
  assert.match(css, /\.status-progress::before/u);
  assert.match(css, /\.workspace-tree-state-waiting \.workspace-tree-state-dot[^}]*transform:\s*rotate\(45deg\)/u);
});

test('Project folder choices expose existing folders without offering the Project root', (t) => {
  const root = temporaryDirectory(t);
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(projectRoot, 'Data', 'TikTok'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Reports'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.git', 'objects'), { recursive: true });

  const result = listProjectFolders(projectRoot);

  assert.deepEqual(result.items.map((item) => item.relative_path), ['Data', 'Data/TikTok', 'Reports']);
  assert.equal(result.items.some((item) => item.relative_path === ''), false);
  assert.equal(result.items.some((item) => item.relative_path.includes('.git')), false);
});

test('Project import rejects the Project root as an implicit destination', (t) => {
  const root = temporaryDirectory(t);
  const projectRoot = path.join(root, 'project');
  const sourcePath = write(path.join(root, 'source.csv'), 'name\nsource\n');
  fs.mkdirSync(path.join(projectRoot, 'Data'), { recursive: true });
  const registry = {
    list: () => [{ id: 'project-1', name: 'Project One', status: 'active' }],
    show: () => ({ location: { root_path: projectRoot, relative_path: '' } }),
  };
  const service = createProjectImportService({ stateDir: path.join(root, 'state'), registry, intake: {} });

  assert.throws(
    () => service.destinationForFolder('project-1', '', sourcePath),
    /Choose an existing destination folder/u,
  );
  assert.equal(service.destinationForFolder('project-1', 'Data', sourcePath).target_path, path.join(projectRoot, 'Data', 'source.csv'));
});

test('Project import keeps its source path when a conflict is resolved with a new file name', (t) => {
  const root = temporaryDirectory(t);
  const projectRoot = path.join(root, 'project');
  const sourcePath = write(path.join(root, 'incoming', 'source.csv'), 'name\nsource\n');
  fs.mkdirSync(path.join(projectRoot, 'Data'), { recursive: true });
  let prepared = null;
  const service = createProjectImportService({
    stateDir: path.join(root, 'state'),
    registry: {
      list: () => [{ id: 'project-1', name: 'Project One', status: 'active' }],
      show: () => ({ location: { root_path: projectRoot, relative_path: '' } }),
      resolvePath: () => ({ project: null }),
    },
    intake: { prepare: (value) => { prepared = value; return { status: 'prepared', run_id: 'run-1' }; } },
  });
  const result = service.prepare({
    work: { work_id: 'work-1', file_path: sourcePath, project: null },
    projectId: 'project-1', folder: 'Data', targetFileName: 'source-copy.csv',
  });
  assert.equal(prepared.candidateFile, sourcePath);
  assert.equal(prepared.target, 'Data/source-copy.csv');
  assert.equal(result.target_path, path.join(projectRoot, 'Data', 'source-copy.csv'));
  assert.throws(
    () => service.destinationForFolder('project-1', 'Data', sourcePath, '../source-copy.csv'),
    /file name/u,
  );
});

test('Import conflict waits for a new name, resumes the same activity, and clears after save', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const projectRoot = path.join(root, 'project');
  const incoming = write(path.join(root, 'incoming', 'source.csv'), 'name\nsource\n');
  write(path.join(projectRoot, 'Data', 'source.csv'), 'name\nexisting\n');
  const project = { id: 'project-1', name: 'Project One', status: 'active' };
  const prepared = new Map();
  const intake = {
    prepare: (value) => { prepared.set('run-1', value); return { status: 'prepared', run_id: 'run-1' }; },
    execute: (runId) => {
      const value = prepared.get(runId);
      fs.copyFileSync(value.candidateFile, path.join(value.root, value.target));
      return { verified: true, rollback_ready: false };
    },
    rollback: () => ({ status: 'rolled_back' }),
  };
  const registry = {
    list: () => [project],
    show: () => ({ ...project, location: { root_path: projectRoot, relative_path: '' } }),
    resolvePath: () => ({ project: null }),
  };
  const runContentOperation = async (operation, args) => {
    if (operation !== 'inspect') return runUiContentOperation(operation, args);
    const sourceFingerprint = contentFileFingerprint(args.filePath);
    const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
      source_path: sourceFingerprint.file_path,
      source_hash: sourceFingerprint.sha256,
      purpose: args.purpose,
      sheet: args.sheet ?? null,
      max_characters: args.maxCharacters,
      processor_version: CONTENT_PROCESSOR_VERSION,
    })).digest('hex');
    const cachePath = path.join(stateDir, 'tmp', 'content-inspections', `${cacheKey}.json`);
    const inspection = {
      schema: CONTENT_INSPECTION_SCHEMA, purpose: args.purpose, source: sourceFingerprint,
      selection: { sheet: args.sheet ?? null }, extraction: { status: 'success', type: 'text', characters: 12 },
      attention: { maximum_characters: args.maxCharacters, truncated: false }, processor: { version: CONTENT_PROCESSOR_VERSION },
      inspection_id: `CIN-${cacheKey.slice(0, 24)}`, cache_path: cachePath,
    };
    write(cachePath, JSON.stringify(inspection));
    return { source_fingerprint: sourceFingerprint, inspection };
  };
  const server = await startAtlasUiServer({ stateDir, desktopPickerEnabled: true, runContentOperation, ...serverServices(registry), intake });
  t.after(() => server.close());
  const selectionResponse = await fetch(server.desktop_picker.registration_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-atlas-desktop-token': server.desktop_picker.token },
    body: new URLSearchParams({ file_path: incoming, kind: 'file', mode: 'single' }),
  });
  const selection = await selectionResponse.json();
  const selectedHtml = await (await fetch(`${server.workspace_url}files/selected/${selection.selection_id}`)).text();
  const csrf = selectedHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const inspected = await fetch(`${server.workspace_url}files/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, selection_id: selection.selection_id, purpose: 'data' }), redirect: 'manual',
  });
  assert.equal(inspected.status, 303, await inspected.text());
  assert.match(inspected.headers.get('location') ?? '', /RWK-/u);
  const workId = inspected.headers.get('location')?.match(/RWK-[a-f0-9-]{36}/u)?.[0];
  assert.ok(workId);
  const review = await fetch(`${server.workspace_url}files/add-to-project/review`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, work_id: workId, project_id: project.id, folder: 'Data' }), redirect: 'manual',
  });
  assert.equal(review.status, 303, await review.text());
  let conflictHref = review.headers.get('location');
  assert.match(conflictHref, /^\/files\/add-to-project\/conflict\?import_id=IMP-/u);
  const activityHtml = await (await fetch(`${server.workspace_url}activity`)).text();
  assert.match(activityHtml, /Waiting/u);
  assert.match(activityHtml, /already exists in Project One/u);
  assert.match(activityHtml, new RegExp(`href="${conflictHref.replaceAll('?', '\\?')}`));
  const conflictHtml = await (await fetch(new URL(conflictHref, server.workspace_url))).text();
  assert.match(conflictHtml, /Choose another destination/u);
  const conflictCsrf = conflictHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(conflictCsrf);
  let importId = conflictHref.match(/IMP-[a-f0-9]{32}/u)?.[0];
  const cancelled = await fetch(`${server.workspace_url}files/add-to-project/conflict/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: conflictCsrf, import_id: importId }), redirect: 'manual',
  });
  assert.equal(cancelled.status, 303);
  assert.equal(readCurrentActivityState(stateDir).items.length, 0);
  const retried = await fetch(`${server.workspace_url}files/add-to-project/review`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, work_id: workId, project_id: project.id, folder: 'Data' }), redirect: 'manual',
  });
  assert.equal(retried.status, 303);
  conflictHref = retried.headers.get('location');
  importId = conflictHref.match(/IMP-[a-f0-9]{32}/u)?.[0];
  const retriedConflictHtml = await (await fetch(new URL(conflictHref, server.workspace_url))).text();
  const retriedConflictCsrf = retriedConflictHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.ok(retriedConflictCsrf);
  const resolved = await fetch(`${server.workspace_url}files/add-to-project/conflict/resolve`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: retriedConflictCsrf, import_id: importId, folder: 'Data', file_name: 'source-copy.csv' }), redirect: 'manual',
  });
  assert.equal(resolved.status, 303);
  assert.match(resolved.headers.get('location'), /^\/files\/add-to-project\/review\?import_id=IMP-/u);
  assert.equal(readCurrentActivityState(stateDir).items[0].status, 'running');
  const reviewHtml = await (await fetch(new URL(resolved.headers.get('location'), server.workspace_url))).text();
  const reviewCsrf = reviewHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const saved = await fetch(`${server.workspace_url}files/add-to-project/save`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: reviewCsrf, import_id: importId }), redirect: 'manual',
  });
  assert.equal(saved.status, 303);
  assert.equal(fs.existsSync(path.join(projectRoot, 'Data', 'source-copy.csv')), true);
  assert.equal(readCurrentActivityState(stateDir).items.length, 0);
});

test('Host-created work remains visible in the bounded Activity surface', () => {
  const item = {
    work_id: 'RWK-00000000-0000-4000-8000-000000000001',
    file_path: 'F:\\Incoming\\campaign.csv',
    inspected_at: '2026-08-26T08:00:00.000Z',
    last_continued_at: null,
    inspect: { purpose: 'data', sheet: null, max_characters: 4000 },
    initiated_by: {
      channel: 'host', actor: 'agent', agent: 'Codex', model: 'gpt-5',
      tool: 'codex-desktop', client_run_id: 'run-1',
    },
    inspection_cache_hit: true,
    result_summary: { label: '41 rows · 83 fields', rows: 41, columns: 83 },
    project: null,
  };
  const activity = renderActivityView({ recent_work: [item], recent_work_error: false }, {
    csrfToken: 'csrf', workspaceHref: '/projects', settingsHref: '/settings',
  });
  assert.match(activity, /Completed local work/u);
  assert.match(activity, /Codex/u);
  assert.match(activity, /No Project/u);
  assert.match(activity, /Completed/u);
  assert.match(activity, /41 rows · 83 fields/u);
  assert.doesNotMatch(activity, /Continue/u);
  assert.doesNotMatch(activity, /http-equiv="refresh"/u);
});

test('Host current activity is visible while running and a failure remains dismissable', (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const source = write(path.join(root, 'campaign.csv'), 'campaign,spend\nA,10\n');
  const caller = { actor: 'agent', agent: 'Codex', model: 'gpt-5', tool: 'codex-desktop', client_run_id: 'run-live-1' };
  const running = beginCurrentActivity({ stateDir, filePath: source, purpose: 'data', caller, project: null });
  let state = readCurrentActivityState(stateDir);
  assert.equal(state.items[0].status, 'running');
  let html = renderActivityView({ recent_work: [], recent_work_error: false, current_activity: state.items, current_activity_error: false }, {
    csrfToken: 'csrf', workspaceHref: '/projects', settingsHref: '/settings',
  });
  assert.match(html, /In progress/u);
  assert.match(html, /campaign\.csv/u);

  failCurrentActivity({ stateDir, activityId: running.activity_id, error: new Error('Parser stopped on an invalid record.') });
  state = readCurrentActivityState(stateDir);
  assert.equal(state.items[0].status, 'failed');
  html = renderActivityView({ recent_work: [], recent_work_error: false, current_activity: state.items, current_activity_error: false }, {
    csrfToken: 'csrf', workspaceHref: '/projects', settingsHref: '/settings',
  });
  assert.match(html, /Parser stopped on an invalid record\./u);
  assert.match(html, /Failed/u);
  assert.match(html, /Dismiss/u);
  assert.equal(finishCurrentActivity(stateDir, running.activity_id), true);
  assert.equal(readCurrentActivityState(stateDir).items.length, 0);
});

test('Add to Project renders an existing-folder picker instead of a destination path field', () => {
  const html = renderFileWorkView({
    mode: 'add-to-project',
    work: { work_id: 'work-1', file_path: 'C:\\incoming\\source.csv' },
    projects: [{
      id: 'project-1', name: 'Project One', available: true,
      folders: [{ name: 'Data', relative_path: 'Data', depth: 1 }],
    }],
  }, { csrfToken: 'token' });

  assert.match(html, /name="folder"/u);
  assert.match(html, /data-project-folder-form/u);
  assert.match(html, /FILE NAME/iu);
  assert.doesNotMatch(html, /name="destination"/u);
  assert.doesNotMatch(html, /value=""[^>]*name="folder"|name="folder"[^>]*value=""/u);
  assert.match(html, /<button class="action-button" type="submit" disabled>Review destination<\/button>/u);
});

test('Saved Work removes a newly created result when metadata cannot be written', (t) => {
  const root = temporaryDirectory(t);
  const input = saveInput(root);
  const service = createSavedWorkService({ stateDir: path.join(root, 'state'), writeStateFn: () => { throw new Error('metadata unavailable'); } });
  assert.throws(() => service.save(input), /metadata unavailable/u);
  assert.equal(fs.existsSync(path.join(input.projectRoot, 'result.csv')), false);
});

test('Saved Work restores the result when Undo metadata cannot be written', (t) => {
  const root = temporaryDirectory(t);
  const input = saveInput(root);
  const stateDir = path.join(root, 'state');
  const record = createSavedWorkService({ stateDir }).save(input);
  const service = createSavedWorkService({ stateDir, writeStateFn: () => { throw new Error('metadata unavailable'); } });
  assert.throws(() => service.undo(record.work_id), /result file was restored/u);
  assert.equal(fs.readFileSync(record.result_path, 'utf8'), 'name\nresult\n');
  assert.equal(readSavedWorkState(stateDir).items[0].status, 'active');
});

test('Data Work result names keep the source format', (t) => {
  const root = temporaryDirectory(t);
  const input = saveInput(root);
  const service = createSavedWorkService({ stateDir: path.join(root, 'state') });
  assert.equal(path.basename(service.prepareDestination({ projectRoot: input.projectRoot, folder: '', fileName: 'result', sourcePath: input.sourcePath })), 'result.csv');
  assert.throws(() => service.prepareDestination({ projectRoot: input.projectRoot, folder: '', fileName: 'result.xlsx', sourcePath: input.sourcePath }), /produces a CSV result\. Use a file name ending in \.csv/u);
});

test('Data Work keeps the last valid state after a bad filter and expires by inactivity', async (t) => {
  const root = temporaryDirectory(t);
  const sourcePath = write(path.join(root, 'source.csv'), 'name,amount\nOne,1\n');
  let clock = 0;
  const preview = {
    columns: ['name', 'amount'], column_types: { name: 'text', amount: 'number' }, rows: [['One', 1]],
    source_summary: { rows: 1, columns: 2 }, result_summary: { rows: 1, columns: 2 },
  };
  const service = createDataWorkService({
    stateDir: path.join(root, 'state'), projectRoot: root, installationRoot: root,
    now: () => clock,
    fingerprintFn: async (filePath) => contentFileFingerprint(filePath),
    runDataWorkFn: async () => structuredClone(preview),
  });
  const session = await service.begin({ filePath: sourcePath });
  await assert.rejects(service.change(session.session_id, 'add_filter', { column: 'name', operator: '>', value: '1' }), /Numeric filters/u);
  assert.deepEqual(service.session(session.session_id).operations.filters, []);
  clock = 50 * 60 * 1000;
  assert.ok(service.session(session.session_id));
  clock = 100 * 60 * 1000;
  service.expire();
  assert.ok(service.session(session.session_id));
  clock = 161 * 60 * 1000;
  service.expire();
  assert.equal(service.session(session.session_id), null);
});

test('Data Work save uses refreshable GET pages after review and confirmation', async (t) => {
  const root = temporaryDirectory(t);
  const projectRoot = path.join(root, 'project');
  const sourcePath = write(path.join(projectRoot, 'Data', 'source.csv'), 'name,amount\nOne,1\n');
  const registry = {
    list: () => [{ id: 'project-1', name: 'Project One', status: 'active' }],
    show: () => ({ location: { root_path: projectRoot, relative_path: '' } }),
  };
  const preview = {
    columns: ['name', 'amount'], column_types: { name: 'text', amount: 'number' }, rows: [['One', 1]],
    source_summary: { rows: 1, columns: 2 }, result_summary: { rows: 1, columns: 2 },
  };
  const runContentOperation = async (operation, args) => {
    if (operation === 'fingerprint') return contentFileFingerprint(args.filePath);
    if (operation !== 'data-work') throw new Error(`Unexpected content operation: ${operation}`);
    if (args.action === 'export') {
      fs.copyFileSync(args.filePath, args.outputPath);
      const staged = contentFileFingerprint(args.outputPath);
      return { ...structuredClone(preview), staged: { path: staged.file_path, sha256: staged.sha256, bytes: staged.bytes } };
    }
    return structuredClone(preview);
  };
  const server = await startAtlasUiServer({
    stateDir: path.join(root, 'state'), runContentOperation,
    ...serverServices(registry), projectRoot, installationRoot: projectRoot,
  });
  t.after(() => server.close());

  const start = await fetch(`${server.workspace_url}projects/project-1/data-work?path=Data/source.csv`, { redirect: 'manual' });
  assert.equal(start.status, 303);
  const workUrl = new URL(start.headers.get('location'), server.workspace_url).toString();
  const savePage = await fetch(`${workUrl}/save`);
  const saveHtml = await savePage.text();
  const csrf = saveHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];

  const review = await fetch(`${workUrl}/save/review`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, project_id: 'project-1', folder: 'Data', file_name: 'cleaned.csv' }), redirect: 'manual',
  });
  assert.equal(review.status, 303);
  assert.match(review.headers.get('location'), /\/save\/review\?/u);
  const reviewUrl = new URL(review.headers.get('location'), server.workspace_url).toString();
  const reviewPage = await fetch(reviewUrl);
  assert.equal(reviewPage.status, 200);
  assert.match(await reviewPage.text(), /Review save/u);

  const confirmed = await fetch(`${workUrl}/save/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, project_id: 'project-1', folder: 'Data', file_name: 'cleaned.csv' }), redirect: 'manual',
  });
  assert.equal(confirmed.status, 303);
  assert.match(confirmed.headers.get('location'), /\/saved\?work_id=SWR-/u);
  const savedPage = await fetch(new URL(confirmed.headers.get('location'), server.workspace_url));
  assert.equal(savedPage.status, 200);
  assert.match(await savedPage.text(), /Atlas saved the new result/u);
});

test('expired Data Work stays inside the Data Work surface', async (t) => {
  const root = temporaryDirectory(t);
  const registry = { list: () => [], show: () => null };
  const server = await startAtlasUiServer({ stateDir: path.join(root, 'state'), ...serverServices(registry) });
  t.after(() => server.close());

  const response = await fetch(`${server.workspace_url}data-work/DWT-${'0'.repeat(32)}`);
  const html = await response.text();

  assert.equal(response.status, 410);
  assert.match(html, /Data Work unavailable/u);
  assert.match(html, /Your source file was not changed/u);
  assert.match(html, /href="\/files"/u);
  assert.doesNotMatch(html, /Atlas Error/u);
});

test('expired Recent Work stays inside the Import surface', async (t) => {
  const root = temporaryDirectory(t);
  const registry = { list: () => [], show: () => null };
  const server = await startAtlasUiServer({ stateDir: path.join(root, 'state'), ...serverServices(registry) });
  t.after(() => server.close());

  const response = await fetch(`${server.workspace_url}files/continue?work_id=RWK-00000000-0000-0000-0000-000000000000`);
  const html = await response.text();

  assert.equal(response.status, 410);
  assert.match(html, /This Recent Work item is no longer available/u);
  assert.match(html, /<h1>Import<\/h1>/u);
  assert.doesNotMatch(html, /Atlas Error/u);
});

test('UI content work runs outside the server request thread', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const projectRoot = path.join(root, 'Project One');
  const project = { id: 'project-1', name: 'Project One', status: 'active' };
  const sourcePath = write(path.join(projectRoot, 'source.txt'), 'local content');
  let releaseInspection;
  let inspectionStarted;
  const started = new Promise((resolve) => { inspectionStarted = resolve; });
  const gate = new Promise((resolve) => { releaseInspection = resolve; });
  t.after(() => releaseInspection());
  const runContentOperation = async (operation, args) => {
    if (operation !== 'inspect') return runUiContentOperation(operation, args);
    inspectionStarted();
    await gate;
    const fingerprint = contentFileFingerprint(args.filePath);
    return {
      source_fingerprint: fingerprint,
      inspection: {
        schema: 'atlas.content-inspection.v1',
        purpose: args.purpose,
        source: fingerprint,
        selection: { sheet: null },
        extraction: { status: 'success', type: 'text', characters: 13 },
        attention: { maximum_characters: args.maxCharacters, truncated: false },
        processor: { version: '0.3.1' },
        inspection_id: 'inspection-test',
        cache_path: path.join(stateDir, 'tmp', 'content-inspections', 'inspection-test.json'),
      },
    };
  };
  const registry = {
    list: () => [project],
    show: () => ({ ...project, location: { root_path: projectRoot, relative_path: '' } }),
    resolvePath: (candidate) => ({ project: path.resolve(candidate).startsWith(path.resolve(projectRoot)) ? project : null }),
  };
  const server = await startAtlasUiServer({
    stateDir,
    desktopPickerEnabled: true,
    runContentOperation,
    ...serverServices(registry),
  });
  t.after(() => server.close());
  const selectionResponse = await fetch(server.desktop_picker.registration_url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-atlas-desktop-token': server.desktop_picker.token,
    },
    body: new URLSearchParams({ file_path: sourcePath, kind: 'file', mode: 'single' }),
  });
  const selection = await selectionResponse.json();
  const selectedResponse = await fetch(`${server.workspace_url}files/selected/${selection.selection_id}`);
  const selectedHtml = await selectedResponse.text();
  const csrf = selectedHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const inspectRequest = fetch(`${server.workspace_url}files/inspect`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, selection_id: selection.selection_id, purpose: 'content' }),
    redirect: 'manual',
  });
  await started;
  const activityResponse = await fetch(`${server.workspace_url}activity`);
  const activityHtml = await activityResponse.text();
  assert.equal(activityResponse.status, 200);
  assert.match(activityHtml, /Atlas Desktop/u);
  assert.match(activityHtml, /In progress/u);
  assert.match(activityHtml, /source\.txt/u);
  const projectsResponse = await Promise.race([
    fetch(`${server.workspace_url}projects`),
    new Promise((_, reject) => setTimeout(() => reject(new Error('UI server stayed blocked')), 500)),
  ]);
  assert.equal(projectsResponse.status, 200);
  await projectsResponse.text();
  releaseInspection();
  const inspectResponse = await inspectRequest;
  assert.equal(inspectResponse.status, 303);
  await inspectResponse.text();
  assert.match(inspectResponse.headers.get('location'), /^\/files\/result\/RWK-[^?]+\?return_to=%2Fprojects%2Fproject-1%2Fresources$/u);
  assert.deepEqual(readRecentWorkState(stateDir).items[0].project, { id: 'project-1', name: 'Project One' });
  assert.equal(readCurrentActivityState(stateDir).items.length, 0);
});

test('Desktop inspection failure remains in Activity with its concrete reason', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const sourcePath = write(path.join(root, 'broken.txt'), 'local content');
  const server = await startAtlasUiServer({
    stateDir,
    desktopPickerEnabled: true,
    runContentOperation: async (operation) => {
      if (operation === 'inspect') throw new Error('The local reader could not open this file.');
      return runUiContentOperation(operation, {});
    },
    ...serverServices({ list: () => [], show: () => null }),
  });
  t.after(() => server.close());
  const selectionResponse = await fetch(server.desktop_picker.registration_url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-atlas-desktop-token': server.desktop_picker.token,
    },
    body: new URLSearchParams({ file_path: sourcePath, kind: 'file', mode: 'single' }),
  });
  const selection = await selectionResponse.json();
  const selectedHtml = await (await fetch(`${server.workspace_url}files/selected/${selection.selection_id}`)).text();
  const csrf = selectedHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const inspectResponse = await fetch(`${server.workspace_url}files/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, selection_id: selection.selection_id, purpose: 'content' }), redirect: 'manual',
  });
  assert.equal(inspectResponse.status, 303);
  const activityHtml = await (await fetch(`${server.workspace_url}activity`)).text();
  assert.match(activityHtml, /Atlas Desktop/u);
  assert.match(activityHtml, /Failed/u);
  assert.match(activityHtml, /The local reader could not open this file\./u);
});

test('Corrupt Saved Work is exposed as an unavailable Created Work state', (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  write(path.join(stateDir, 'ui', 'saved-work.json'), '{broken');
  const savedState = createSavedWorkService({ stateDir }).stateForProject('project-1');
  assert.ok(savedState.error);
  const html = renderProjectResourcesView({
    mode: 'explorer', project: { id: 'project-1', name: 'Project One' }, base: '/projects/project-1',
    known_sources: [], created_work: [], current_output: null, other_files: [], saved_work_error: true,
  });
  assert.match(html, /Created results could not be loaded\. Project files remain available\./u);
  assert.match(html, /Folder navigator/u);
});

test('Project Resources renders a local Project tree instead of category cards', (t) => {
  const root = temporaryDirectory(t);
  write(path.join(root, 'Data', 'Facebook', 'Raw', 'july.csv'), 'name\nJuly\n');
  write(path.join(root, 'Data', 'Facebook', 'Cleaned', 'july-cleaned.csv'), 'name\nJuly\n');
  write(path.join(root, 'Reports', 'july-report.pptx'), 'placeholder');
  const project = { id: 'project-1', name: 'Project One' };
  const cleaned = path.join(root, 'Data', 'Facebook', 'Cleaned', 'july-cleaned.csv');
  const model = buildProjectResourcesModel({
    project, root, base: '/projects/project-1', recentWork: [],
    focusedPath: 'Data/Facebook/Cleaned/july-cleaned.csv',
    currentActivity: [{
      activity_id: 'ACT-00000000-0000-4000-8000-000000000001',
      project, file_path: cleaned, status: 'failed', updated_at: '2026-08-17T00:01:00.000Z',
      error_message: 'The local parser stopped.',
    }],
    savedWork: [{ work_id: 'saved-1', project, result_path: cleaned, source_path: path.join(root, 'Data', 'Facebook', 'Raw', 'july.csv'), status: 'active', created_at: '2026-08-17T00:00:00.000Z', write: { undo_available: true } }],
  });
  const html = renderProjectResourcesView(model, { csrfToken: 'token' });
  assert.match(html, /Folder navigator/u);
  assert.match(html, />Data</u);
  assert.match(html, />Facebook</u);
  assert.match(html, /july-cleaned\.csv/u);
  assert.match(html, /Known relationships/u);
  assert.match(html, /aria-current="page"><a href="\/projects\/project-1\/resources" title="Resources"/u);
  assert.doesNotMatch(html, />Files<\/span>/u);
  assert.match(html, /Not yet worked in Atlas/u);
  assert.match(html, /<details data-project-folder data-folder-path="Data" open><summary class="workspace-tree-folder-row"/u);
  assert.match(html, /<details data-project-folder data-folder-path="Data\/Facebook"/u);
  assert.match(html, /data-resource-tree data-project-id="project-1"/u);
  assert.match(html, /href="\/projects\/project-1\/resources\?path=/u);
  assert.match(html, /Open in default app/u);
  assert.match(html, /workspace-tree-state-failed/u);
  assert.match(html, /The local parser stopped\./u);
  assert.doesNotMatch(html, />Continue</u);
  assert.equal(model.changed_resources, 0);
  assert.doesNotMatch(html, />undefined</u);
  assert.doesNotMatch(html, /Known Sources <span/u);
  assert.doesNotMatch(html, /<section class="workspace-fact-strip"/u);
  assert.doesNotMatch(html, /Current Output/u);
});

test('Resource tree client supports folder and file keyboard equivalents without a page-wide handler', () => {
  const client = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('src', 'ui', 'styles', 'components.css'), 'utf8');
  assert.match(client, /const visibleControls = \(\) => controls\.filter/u);
  assert.match(client, /event\.key === 'ArrowRight'[\s\S]*?folder\.open/u);
  assert.match(client, /visible\[visible\.indexOf\(control\) \+ 1\]\?\.focus\(\)/u);
  assert.match(client, /event\.key === 'ArrowLeft'[\s\S]*?parentFolderControl\(control\)\?\.focus\(\)/u);
  assert.match(client, /control\.tagName !== 'SUMMARY'[\s\S]*?:scope > summary/u);
  assert.match(client, /if \(event\.key === 'Enter'\)[\s\S]*?openResource\(row\)/u);
  assert.match(client, /fileList\.querySelectorAll\('\[data-open-resource\]'\)/u);
  assert.doesNotMatch(client, /document\.addEventListener\('keydown', \(event\) => \{[\s\S]{0,240}ArrowDown/u);
  assert.match(css, /\.workspace-tree-folder-row:hover\s*\{[^}]*background:/u);
  assert.match(css, /\.workspace-tree-folder-row:focus-visible\s*\{[^}]*outline:/u);
  assert.match(css, /\.workspace-resource-file:focus-visible\s*\{[^}]*outline:/u);
});

test('Project Resource detail distinguishes recorded work from a disk modification and labels downstream results as Used by', (t) => {
  const root = temporaryDirectory(t);
  const source = write(path.join(root, 'Data', 'source.csv'), 'name\nsource\n');
  const result = write(path.join(root, 'Results', 'cleaned.csv'), 'name\ncleaned\n');
  const project = { id: 'project-1', name: 'Project One' };
  const model = buildProjectResourceDetailModel({
    project,
    root,
    base: '/projects/project-1',
    recentWork: [],
    relativePath: 'Data/source.csv',
    savedWork: [{
      work_id: 'saved-1', project, result_path: result, source_path: source,
      status: 'active', created_at: '2026-08-17T00:00:00.000Z', write: { undo_available: true },
    }],
  });
  const html = renderProjectResourcesView(model, { csrfToken: 'token' });
  assert.match(html, />Used by</u);
  assert.match(html, /input to these saved results/u);
  assert.match(html, /cleaned\.csv/u);
  assert.match(html, /Last worked<\/dt><dd>Not yet worked in Atlas<\/dd>/u);
  assert.doesNotMatch(html, />Used to create</u);
});

test('Project Resource detail shows a Host inspection recorded for the same Project file', (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const source = write(path.join(root, 'Data', 'campaign.csv'), 'name\ncampaign\n');
  const project = { id: 'project-1', name: 'Project One' };
  upsertRecentWork({
    stateDir,
    filePath: source,
    inspect: { purpose: 'data', sheet: null, maxCharacters: 4000 },
    sourceFingerprint: contentFileFingerprint(source),
    inspectionId: 'INS-host-campaign',
    cacheReference: 'content/cache.json',
    project,
    initiatedBy: { channel: 'host', actor: 'agent', agent: 'Codex', tool: 'atlas.cmd' },
    resultSummary: { label: '1 rows · 1 fields', rows: 1, columns: 1 },
  });
  const model = buildProjectResourceDetailModel({
    project, root, base: '/projects/project-1', relativePath: 'Data/campaign.csv',
    recentWork: readRecentWorkState(stateDir).items,
  });
  const html = renderProjectResourcesView(model, { csrfToken: 'token' });
  assert.match(html, /Last inspected by<\/dt><dd>Codex<\/dd>/u);
  assert.match(html, /Known result<\/dt><dd>1 rows · 1 fields<\/dd>/u);
  assert.doesNotMatch(html, /Not yet worked in Atlas/u);
});

test('Project Resources keeps missing traces in context instead of a count tile', () => {
  const html = renderProjectResourcesView({
    mode: 'explorer', project: { id: 'project-1', name: 'Project One' }, base: '/projects/project-1',
    tree: { folders: [], files: [] }, known_sources: [], created_work: [], current_output: null,
    other_files: [], changed_resources: 0, missing_sources: [{ name: 'deleted-source.csv', source_path: 'F:\\missing\\deleted-source.csv' }],
  });
  assert.match(html, /Missing trace/u);
  assert.match(html, /deleted-source\.csv/u);
  assert.match(html, /F:\\missing\\deleted-source\.csv/u);
  assert.doesNotMatch(html, /<span>Missing<\/span>/u);
});

test('A later successful inspection supersedes an older failed Activity in Resource Context', (t) => {
  const root = temporaryDirectory(t);
  const filePath = write(path.join(root, 'Reference', 'brief.pdf'), 'pdf placeholder');
  const project = { id: 'project-1', name: 'Project One' };
  const recentWork = [{
    work_id: 'RWK-00000000-0000-4000-8000-000000000001', file_path: filePath, project,
    inspected_at: '2026-09-07T10:00:00.000Z', last_continued_at: null,
    inspect: { purpose: 'content', sheet: null, max_characters: 4000 },
    source_fingerprint: contentFileFingerprint(filePath), cache_reference: 'tmp/brief.json',
  }];
  const currentActivity = [{
    activity_id: 'ACT-00000000-0000-4000-8000-000000000001', file_path: filePath, project,
    status: 'failed', updated_at: '2026-09-07T09:00:00.000Z', error_message: 'The earlier reader stopped.',
  }];
  const model = buildProjectResourcesModel({
    project, root, base: '/projects/project-1',
    recentWork, focusedPath: 'Reference/brief.pdf',
    currentActivity,
  });
  assert.notEqual(model.focused_resource.state, 'failed');
  assert.equal(model.focused_resource.state, 'unchanged');
  assert.equal(model.focused_resource.activity, null);
  assert.doesNotMatch(renderProjectResourcesView(model, { csrfToken: 'token' }), /The earlier reader stopped./u);

  write(filePath, 'pdf placeholder changed after inspection');
  const changed = buildProjectResourcesModel({
    project, root, base: '/projects/project-1', recentWork, currentActivity, focusedPath: 'Reference/brief.pdf',
  });
  assert.equal(changed.focused_resource.state, 'changed');
});

test('Desktop selection accepts the current session token and rejects another token', async (t) => {
  const root = temporaryDirectory(t);
  const sourcePath = write(path.join(root, 'incoming.txt'), 'local file');
  const server = await startAtlasUiServer({
    stateDir: path.join(root, 'state'), desktopPickerEnabled: true,
    ...serverServices({ list: () => [], show: () => null }),
  });
  t.after(() => server.close());
  const body = new URLSearchParams({ file_path: sourcePath, kind: 'file', mode: 'single' });
  const rejected = await fetch(server.desktop_picker.registration_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-atlas-desktop-token': 'not-this-session' }, body,
  });
  assert.equal(rejected.status, 403);
  const accepted = await fetch(server.desktop_picker.registration_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Atlas-Desktop-Token': server.desktop_picker.token }, body,
  });
  assert.equal(accepted.status, 200);
  assert.match((await accepted.json()).selection_id, /^SEL-[a-f0-9]{32}$/u);
});

test('Resource Context shows only known Project, state, activity, and representation facts', () => {
  const html = renderProjectResourcesView({
    mode: 'explorer', project: { id: 'project-1', name: 'Project One' }, base: '/projects/project-1',
    tree: { folders: [], files: [] }, known_sources: [], created_work: [], other_files: [],
    focused_resource: {
      name: 'brief.pdf', relative_path: 'Reference/brief.pdf', type: 'PDF', state: 'failed',
      activity: { error_message: 'The local parser stopped.' }, last_worked_at: '2026-09-07T00:00:00.000Z',
      representation: null, created_work: [], saved_work: null, added_from: null, work: null,
    },
    activity_return_href: '/activity?selected=ACT-1', missing_sources: [],
  }, { csrfToken: 'token' });
  assert.match(html, /Project<\/dt><dd>Project One<\/dd>/u);
  assert.match(html, /Current state<\/dt><dd>The local parser stopped\.<\/dd>/u);
  assert.match(html, /Recent activity<\/dt>/u);
  assert.match(html, /No local representation has been prepared\./u);
  assert.match(html, /href="\/activity\?selected=ACT-1">Back to Activity/u);
  assert.doesNotMatch(html, /Structured details available/u);
});

test('Resource Representation does not claim structure from a file extension without a verified local inspection', (t) => {
  const root = temporaryDirectory(t);
  write(path.join(root, 'data.csv'), 'name\nvalue\n');
  const model = buildProjectResourcesModel({
    project: { id: 'project-1', name: 'Project One' }, root, base: '/projects/project-1',
    recentWork: [], stateDir: path.join(root, 'state'), focusedPath: 'data.csv',
  });
  assert.equal(model.focused_resource.representation, null);
  const html = renderProjectResourcesView(model, { csrfToken: 'token' });
  assert.match(html, /No local representation has been prepared\./u);
  assert.doesNotMatch(html, /Structured details available/u);
});

test('Activity can focus an in-Project regular file that is outside the truncated Resource tree', (t) => {
  const root = temporaryDirectory(t);
  for (let index = 0; index < 151; index += 1) write(path.join(root, `file-${String(index).padStart(3, '0')}.txt`), String(index));
  const focusedPath = 'file-150.txt';
  const model = buildProjectResourcesModel({
    project: { id: 'project-1', name: 'Project One' }, root, base: '/projects/project-1',
    recentWork: [], focusedPath,
  });
  assert.equal(model.truncated, true);
  assert.equal(model.focused_resource.relative_path, focusedPath);
  assert.equal(model.tree.files.some((item) => item.relative_path === focusedPath), true);
  const html = renderProjectResourcesView(model, { csrfToken: 'token' });
  assert.match(html, /data-focus-path="file-150\.txt"/u);
  assert.match(html, /data-focused-resource/u);
});

test('Activity resource return selects and expands the originating row', () => {
  const html = renderActivityView({
    selected_activity_key: 'ACT-1', current_activity: [{
      activity_id: 'ACT-1', status: 'failed', file_path: 'F:\\project\\brief.pdf',
      project: { id: 'project-1', name: 'Project One' }, error_message: 'Stopped.',
      resource_href: '/projects/project-1/resources?path=brief.pdf&from=activity&activity=ACT-1',
    }], recent_work: [],
  }, { csrfToken: 'token' });
  assert.match(html, /data-selected-activity="ACT-1"/u);
  assert.match(html, /data-activity-key="ACT-1" open/u);
  assert.match(html, /resources\?path=brief\.pdf&amp;from=activity&amp;activity=ACT-1/u);
});

test('Resources reports an unavailable explicit focus instead of selecting another file', (t) => {
  const root = temporaryDirectory(t);
  write(path.join(root, '.gitignore'), 'node_modules\n');
  const model = buildProjectResourcesModel({
    project: { id: 'project-1', name: 'Project One' }, root, base: '/projects/project-1',
    recentWork: [], focusedPath: 'Data/imported.csv',
  });
  const html = renderProjectResourcesView(model, { csrfToken: 'token' });
  assert.equal(model.focused_resource, null);
  assert.match(html, /The requested Resource is unavailable/u);
  assert.doesNotMatch(html, /Selected resource<\/span><strong>\.gitignore/u);
});

test('Import uses one Selection Set for one file, added files, and an unsupported folder', (t) => {
  const root = temporaryDirectory(t);
  const first = write(path.join(root, 'first.csv'), 'name\nfirst\n');
  const second = write(path.join(root, 'second.txt'), 'second');
  const folder = path.join(root, 'folder');
  fs.mkdirSync(folder);
  const selections = createDesktopSelectionService({ maxBatchFiles: 20 });
  const created = selections.registerImport({ kind: 'file', paths: [first] }).queue;
  const added = selections.registerImport({ kind: 'file', paths: [first, second, second], queueId: created.queue_id }).queue;
  selections.registerImport({ kind: 'folder', paths: [folder], queueId: created.queue_id });
  assert.equal(added.items.length, 3);
  assert.deepEqual(added.items.map((item) => item.kind), ['file', 'file', 'folder']);
  assert.equal(added.items[2].supported, false);
  assert.match(added.items[2].reason, /imports files only/u);
  selections.removeFromQueue(created.queue_id, added.items[1].item_id);
  assert.deepEqual(selections.queue(created.queue_id).items.map((item) => item.name), ['first.csv', 'folder']);
});

test('Import keeps a pending Selection Set alive until its save reaches a terminal state', (t) => {
  const root = temporaryDirectory(t);
  const source = write(path.join(root, 'pending.txt'), 'pending');
  let now = 0;
  const selections = createDesktopSelectionService({
    maxBatchFiles: 20,
    now: () => now,
    queueLifetimeMs: 100,
  });
  const queue = selections.registerImport({ kind: 'file', paths: [source] }).queue;
  selections.setQueuePending(queue.queue_id, true);
  now = 200;
  selections.expire();
  assert.equal(selections.queue(queue.queue_id)?.pending, true);

  selections.setQueuePending(queue.queue_id, false);
  now = 301;
  selections.expire();
  assert.equal(selections.queue(queue.queue_id), null);
});

test('Import Selection Set shows add, remove, cancel, support reasons, and real destination folders', () => {
  const html = renderBatchWorkView({
    mode: 'selection-set', queue_id: 'BQS-123', destination: null,
    items: [
      { item_id: 'one', name: 'report.csv', type: 'CSV', supported: true },
      { item_id: 'two', name: 'drop', type: 'Folder', supported: false, reason: 'The current Intake operation imports files only.' },
    ],
    projects: [{ id: 'project-1', name: 'Project One', available: true, folders_truncated: false, folders: [{ name: 'Data', relative_path: 'Data' }] }],
  }, { csrfToken: 'token' });
  assert.match(html, />Selection Set</u);
  assert.match(html, /data-import-add-files/u);
  assert.match(html, /data-import-add-folder/u);
  assert.match(html, />Remove</u);
  assert.match(html, />Cancel Import</u);
  assert.match(html, /imports files only/u);
  assert.match(html, /value="Data"/u);
  assert.doesNotMatch(html, /value=""[^>]*name="folder"/u);
  assert.doesNotMatch(html, /data-auto-prepare-files/u);
});

test('Import landing uses an empty Selection Set instead of Recent Work', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const source = write(path.join(root, 'incoming', 'report.csv'), 'name\nreport\n');
  upsertRecentWork({
    stateDir, filePath: source, inspect: { purpose: 'data', sheet: null, maxCharacters: 4000 },
    sourceFingerprint: contentFileFingerprint(source), inspectionId: 'inspection-import-entry', cacheReference: 'tmp/import-entry.json',
  });
  const registry = { list: () => [], show: () => null };
  const server = await startAtlasUiServer({ stateDir, desktopPickerEnabled: true, ...serverServices(registry) });
  t.after(() => server.close());

  const response = await fetch(`${server.workspace_url}files`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, />Selection Set</u);
  assert.match(html, /data-import-files/u);
  assert.match(html, /data-import-add-folder/u);
  assert.match(html, /class="topbar"/u);
  assert.doesNotMatch(html, /Recent Work/u);
  assert.doesNotMatch(html, />Continue</u);
  assert.doesNotMatch(html, />Project</u);
  assert.doesNotMatch(html, />Remove</u);
  assert.doesNotMatch(html, /<h2>Destination<\/h2>/u);

  const unavailable = await fetch(`${server.workspace_url}files/selected/SEL-${'a'.repeat(32)}`);
  const unavailableHtml = await unavailable.text();
  assert.equal(unavailable.status, 410);
  assert.match(unavailableHtml, />Selection Set</u);
  assert.match(unavailableHtml, /selected file is no longer available/u);
  assert.doesNotMatch(unavailableHtml, /Recent Work/u);
});

test('Import Selection Set presents nested destination folders as an expandable tree', () => {
  const html = renderBatchWorkView({
    mode: 'selection-set', queue_id: 'BQS-123',
    destination: { project_id: 'project-1', project_name: 'Project One', folder: 'test/.tmp' },
    items: [{ item_id: 'one', name: 'report.csv', type: 'CSV', supported: true }],
    projects: [{
      id: 'project-1', name: 'Project One', available: true, folders_truncated: false,
      folders: [
        { name: 'docs', relative_path: 'docs' },
        { name: 'test', relative_path: 'test' },
        { name: '.tmp', relative_path: 'test/.tmp' },
      ],
    }],
  }, { csrfToken: 'token' });
  assert.match(html, /data-project-folder-tree/u);
  assert.match(html, /data-project-folder-branch="test" open/u);
  assert.match(html, /data-project-folder-branch="test\/\.tmp"/u);
  assert.match(html, /value="test\/\.tmp"[^>]*checked/u);
  assert.doesNotMatch(html, /value=""[^>]*name="folder"/u);
  const styles = fs.readFileSync(path.resolve('src', 'ui', 'styles', 'components.css'), 'utf8');
  assert.match(styles, /\.project-folder-options \{[^}]*max-height:[^}]*overflow: auto/u);
  assert.match(styles, /\.project-folder-choice strong, \.project-folder-choice small \{[^}]*overflow-wrap: anywhere/u);
  assert.match(styles, /@media \(max-width: 640px\) \{[^}]*\.project-folder-options \{ max-height: 42vh/u);
});

test('Import Selection Set keeps partial results separate from actionable pending files', () => {
  const html = renderBatchWorkView({
    mode: 'selection-set', queue_id: 'BQS-123',
    destination: { project_id: 'project-1', project_name: 'Project One', folder: 'Data' },
    import_result: [{ name: 'saved.csv', target: 'Data/saved.csv', href: '/projects/project-1/resources?path=Data%2Fsaved.csv' }],
    items: [
      { item_id: 'conflict', name: 'conflict.csv', type: 'CSV', supported: true, actionable: false, reason: 'Conflict — already exists' },
      { item_id: 'folder', name: 'folder', type: 'Folder', supported: false, actionable: false, reason: 'Folder import is unsupported' },
    ],
    projects: [{ id: 'project-1', name: 'Project One', available: true, folders_truncated: false, folders: [{ name: 'Data', relative_path: 'Data' }] }],
  }, { csrfToken: 'token' });
  assert.match(html, /This import result/u);
  assert.match(html, /saved\.csv/u);
  assert.match(html, /Locate/u);
  assert.match(html, /2 selected · 0 ready/u);
  assert.match(html, /Review Import<\/button>/u);
  assert.doesNotMatch(html, /<button class="action-button" type="submit">Review Import/u);
  const running = renderBatchWorkView({
    mode: 'selection-set', queue_id: 'BQS-124', import_status: 'running',
    import_status_href: '/activity/import-status?import_id=BIM-123', activity_href: '/activity?import=BIM-123',
    items: [{ item_id: 'pending', name: 'pending.csv', type: 'CSV', supported: true, actionable: true }],
    projects: [{ id: 'project-1', name: 'Project One', available: true, folders_truncated: false, folders: [{ name: 'Data', relative_path: 'Data' }] }],
  }, { csrfToken: 'token' });
  assert.match(running, /Importing available files/u);
  assert.match(running, /View Activity/u);
  assert.match(running, /Review Import<\/button>/u);
  assert.doesNotMatch(running, /<button class="action-button" type="submit">Review Import/u);
  assert.match(running, /data-import-running="true"/u);
  assert.match(running, /data-import-add-files[^>]*disabled/u);
  assert.match(running, /action="\/files\/queue\/remove"[\s\S]*?<button[^>]*disabled/u);
  assert.match(running, /action="\/files\/queue\/clear"[\s\S]*?<button[^>]*disabled/u);
  const client = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  assert.match(client, /control\.dataset\.importRunning === 'true'/u);
  assert.match(client, /form\.dataset\.importRunning === 'true'/u);
  assert.match(client, /form\.dataset\.importActionableCount[\s\S]*?hasActionableItems/u);
  assert.match(client, /importTerminalStatuses[\s\S]*?'unavailable'/u);
  assert.match(client, /polls < 240 \? 500 : 2000/u);
  assert.match(client, /importPolls < 240 \? 500 : 2000/u);
  assert.doesNotMatch(client, /if \(polls < 240\) window\.setTimeout/u);
  assert.doesNotMatch(client, /if \(importPolls < 240\) window\.setTimeout/u);
});

test('Activity live refresh restores keyboard focus within the same activity item', () => {
  const client = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  assert.match(client, /focusedActivity[\s\S]*?dataset\.activityKey/u);
  assert.match(client, /focusedControlIndex/u);
  assert.match(client, /nextFocusedActivity[\s\S]*?focus\(\{ preventScroll: true \}\)/u);
  const responseIndex = client.indexOf("if (!next) throw new Error('Activity update was incomplete.')");
  const focusCaptureIndex = client.indexOf('const focusedControl = activityRegion.contains(document.activeElement)');
  assert.ok(responseIndex >= 0 && focusCaptureIndex > responseIndex);
});

test('Resources layout collapses before the tested narrow desktop width', () => {
  const html = renderProjectResourcesView({
    mode: 'explorer', project: { id: 'project-1', name: 'Project One' }, base: '/projects/project-1',
    tree: { folders: [], files: [] }, focused_resource: null, missing_sources: [],
  }, { csrfToken: 'token' });
  const styles = fs.readFileSync(path.resolve('src', 'ui', 'styles', 'components.css'), 'utf8');
  const client = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  assert.match(styles, /@media \(max-width: 1180px\) \{[\s\S]*?\.workspace-resource-grid \{ grid-template-columns:/u);
  assert.match(styles, /\.workspace-folder-scroll, \.workspace-resource-list-scroll, \.workspace-focus \{[^}]*overflow:\s*auto/u);
  assert.match(html, /data-resource-list-toggle[^>]*aria-controls="project-resource-file-list"[^>]*aria-expanded="true"/u);
  assert.match(html, /id="project-resource-file-list"[^>]*data-resource-file-list/u);
  assert.match(client, /data-resource-list-toggle[\s\S]*?fileList\.hidden[\s\S]*?aria-expanded/u);
});

test('Resources starts with folders closed and remembers disclosure by Project', (t) => {
  const root = temporaryDirectory(t);
  write(path.join(root, 'Data', 'report.csv'), 'name\nvalue\n');
  const model = buildProjectResourcesModel({
    project: { id: 'project-1', name: 'Project One' }, root, base: '/projects/project-1', recentWork: [],
  });
  const html = renderProjectResourcesView(model, { csrfToken: 'token' });
  const client = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  assert.equal(model.focused_resource, null);
  assert.doesNotMatch(html, /data-focus-path=/u);
  assert.doesNotMatch(html, /data-project-folder[^>]* open/u);
  assert.match(html, /Choose a resource/u);
  assert.match(client, /atlas-ui-open-folders:\$\{projectId\}/u);
  assert.match(client, /atlas-ui-selected-folder:\$\{projectId\}/u);
  assert.match(client, /atlas-ui-resource-list:\$\{projectId\}/u);
  assert.match(client, /focusedPath[\s\S]*?setFileListExpanded\(Boolean\(focusedPath\)/u);
});

test('Resources renders the approved three-pane workspace and remembers the collapsible file list', (t) => {
  const root = temporaryDirectory(t);
  write(path.join(root, 'src', 'ui', 'views', 'project-resources-view.js'), 'export const view = true;\n');
  write(path.join(root, 'src', 'ui', 'views', 'resource-list-view.js'), 'export const list = true;\n');
  write(path.join(root, 'README.md'), '# Project\n');
  const model = buildProjectResourcesModel({
    project: { id: 'project-1', name: 'Project One' }, root, base: '/projects/project-1', recentWork: [],
    focusedPath: 'src/ui/views/project-resources-view.js',
  });
  const html = renderProjectResourcesView(model, { csrfToken: 'token' });
  const client = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  const styles = fs.readFileSync(path.resolve('src', 'ui', 'styles', 'components.css'), 'utf8');

  assert.equal(model.selected_folder_path, 'src/ui/views');
  assert.equal(buildProjectResourcesModel({
    project: { id: 'project-1', name: 'Project One' }, root, base: '/projects/project-1', recentWork: [],
    selectedFolderPath: 'missing/folder',
  }).selected_folder_path, '');
  assert.match(html, /data-resource-workspace[^>]*data-project-id="project-1"/u);
  assert.match(html, /data-folder-navigator/u);
  assert.match(html, /data-resource-file-list/u);
  assert.match(html, /Files in <strong[^>]*>src\/ui\/views/u);
  assert.match(html, /data-resource-inspector/u);
  assert.match(html, /data-resource-list-toggle[^>]*aria-controls="project-resource-file-list"/u);
  assert.match(html, /data-folder-select[^>]*data-folder-path="src\/ui\/views"/u);
  assert.match(html, /data-folder-files="src\/ui\/views"/u);
  assert.match(html, /project-resources-view\.js/u);
  assert.match(client, /atlas-ui-selected-folder:\$\{projectId\}/u);
  assert.match(client, /atlas-ui-resource-list:\$\{projectId\}/u);
  assert.match(client, /is-file-list-collapsed/u);
  assert.match(client, /if \(selectedFolder && \(focusedPath \|\| workspace\.dataset\.selectedFolderExplicit === 'true'\)\)/u);
  assert.match(client, /if \(clearResource\)[\s\S]*?classList\.remove\('is-focused'\)[\s\S]*?history\.replaceState/u);
  assert.match(client, /event\.key === 'ArrowLeft'[\s\S]*?folders\.filter[\s\S]*?saveFolders\(\)[\s\S]*?target\.focus\(\)/u);
  assert.match(styles, /\.workspace-resource-grid\.is-file-list-collapsed/u);
  assert.match(styles, /grid-template-columns:\s*minmax\([^;]+\)\s+minmax\([^;]+\)/u);
  assert.match(styles, /\.workspace-resource-list\[hidden\], \.workspace-folder-files\[hidden\] \{ display: none !important; \}/u);
  assert.match(styles, /@container \(max-width: 900px\)[\s\S]*?\.workspace-resource-grid:not\(\.is-file-list-collapsed\) \.workspace-focus \{ display: none; \}/u);
});

test('Settings overlay keeps its dedicated width and reflows choices before 800 pixels', () => {
  const styles = fs.readFileSync(path.resolve('src', 'ui', 'styles', 'layout.css'), 'utf8');
  assert.match(styles, /\.atlas-overlay\.settings-overlay \{[^}]*max-width:\s*min\(1480px, calc\(100vw - 24px\)\)/u);
  assert.match(styles, /@media \(max-width: 820px\) \{[\s\S]*?\.setting-choice-grid,[^}]*grid-template-columns:\s*1fr/u);
  assert.match(styles, /@media \(max-width: 820px\) \{[\s\S]*?\.settings-heading \{ display:\s*block/u);
});

test('Import Selection Set saves through Intake and opens the exact Resource', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const projectRoot = path.join(root, 'project');
  const sourcePath = write(path.join(root, 'incoming', 'report.txt'), 'local report');
  fs.mkdirSync(path.join(projectRoot, 'Data'), { recursive: true });
  const project = { id: 'project-1', name: 'Project One', status: 'active' };
  const registry = {
    list: () => [project],
    show: () => ({ ...project, location: { root_path: projectRoot, relative_path: '' } }),
    resolvePath: () => ({ project: null }),
  };
  const prepared = new Map();
  let executionError = null;
  const intake = {
    prepare: (value) => { prepared.set('run-1', value); return { status: 'prepared', run_id: 'run-1' }; },
    execute: (runId) => {
      if (executionError) throw executionError;
      const value = prepared.get(runId);
      fs.copyFileSync(value.candidateFile, path.join(value.root, value.target));
      return { verified: true, rollback_ready: false };
    },
    rollback: () => ({ status: 'rolled_back' }),
  };
  const runContentOperation = async (operation, args) => {
    if (operation !== 'inspect') return runUiContentOperation(operation, args);
    const sourceFingerprint = contentFileFingerprint(args.filePath);
    const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
      source_path: sourceFingerprint.file_path,
      source_hash: sourceFingerprint.sha256,
      purpose: args.purpose,
      sheet: args.sheet ?? null,
      max_characters: args.maxCharacters,
      processor_version: CONTENT_PROCESSOR_VERSION,
    })).digest('hex');
    const cachePath = path.join(stateDir, 'tmp', 'content-inspections', `${cacheKey}.json`);
    const inspection = {
      schema: CONTENT_INSPECTION_SCHEMA, purpose: args.purpose, source: sourceFingerprint,
      selection: { sheet: null }, extraction: { status: 'success', type: 'text', characters: 12 },
      attention: { maximum_characters: args.maxCharacters, truncated: false },
      processor: { version: CONTENT_PROCESSOR_VERSION }, inspection_id: `CIN-${cacheKey.slice(0, 24)}`, cache_path: cachePath,
    };
    write(cachePath, JSON.stringify(inspection));
    return { source_fingerprint: sourceFingerprint, inspection };
  };
  let markSaveStarted;
  let releaseSave;
  const saveStarted = new Promise((resolve) => { markSaveStarted = resolve; });
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let delayNextSave = true;
  let corruptActivityAfterSave = false;
  const runProjectImportSaveFn = async (imported) => {
    if (delayNextSave) {
      delayNextSave = false;
      markSaveStarted();
      await saveGate;
    }
    const result = saveProjectImport({ stateDir, intake, imported });
    if (corruptActivityAfterSave) write(path.join(stateDir, 'ui', 'current-activity.json'), '{invalid');
    return result;
  };
  const server = await startAtlasUiServer({
    stateDir, desktopPickerEnabled: true, runContentOperation, runProjectImportSaveFn,
    ...serverServices(registry), intake,
    temporaryRecordLifetimeMs: 30,
    selectionSweepIntervalMs: 5,
    queueLifetimeMs: 30,
  });
  t.after(() => server.close());
  const picked = await fetch(server.desktop_picker.registration_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-atlas-desktop-token': server.desktop_picker.token },
    body: new URLSearchParams({ file_path: sourcePath, kind: 'file', mode: 'multiple', flow: 'import' }),
  });
  const selection = await picked.json();
  assert.match(selection.queue_id, /^BQS-/u);
  const selectionHtml = await (await fetch(`${server.workspace_url}files/queue/${selection.queue_id}`)).text();
  const csrf = selectionHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const reviewed = await fetch(`${server.workspace_url}files/queue/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, queue_id: selection.queue_id, project_id: project.id, folder: 'Data' }), redirect: 'manual',
  });
  assert.equal(reviewed.status, 303, await reviewed.text());
  const reviewHref = reviewed.headers.get('location');
  assert.match(reviewHref, /^\/files\/batch-review\/BIM-/u);
  const reviewHtml = await (await fetch(new URL(reviewHref, server.workspace_url))).text();
  assert.match(reviewHtml, /Data[\\/]report\.txt/u);
  const importId = reviewHtml.match(/name="batch_import_id" value="(BIM-[a-f0-9]{32})"/u)?.[1];
  const saved = await fetch(`${server.workspace_url}files/batch-add-to-project/save`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, batch_import_id: importId }), redirect: 'manual',
  });
  assert.equal(saved.status, 303, await saved.text());
  const importHref = saved.headers.get('location');
  assert.match(importHref, /^\/files\/queue\/BQS-[a-f0-9]{32}\?import=BIM-/u);
  await Promise.race([
    saveStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Import save did not start through the async runner.')), 500)),
  ]);
  const whileSaving = await Promise.race([
    fetch(`${server.workspace_url}activity/import-status?import_id=${importId}`).then((response) => response.json()),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Activity was blocked by the Import save.')), 300)),
  ]);
  assert.equal(whileSaving.status, 'running');
  assert.equal(whileSaving.href, null);
  await new Promise((resolve) => setTimeout(resolve, 45));
  const stillRunning = await fetch(`${server.workspace_url}activity/import-status?import_id=${importId}`);
  assert.equal(stillRunning.status, 200);
  assert.equal((await stillRunning.json()).status, 'running');
  releaseSave();
  let importStatus = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    importStatus = await (await fetch(`${server.workspace_url}activity/import-status?import_id=${importId}`)).json();
    if (importStatus.href) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(importStatus.status, 'completed');
  assert.equal(importStatus.href, '/projects/project-1/resources?path=Data%2Freport.txt');
  const terminalQueuePage = await fetch(new URL(importHref, server.workspace_url));
  assert.equal(terminalQueuePage.status, 200);
  assert.match(await terminalQueuePage.text(), /report\.txt/u);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'Data', 'report.txt'), 'utf8'), 'local report');
  await new Promise((resolve) => setTimeout(resolve, 45));
  const expiredStatus = await fetch(`${server.workspace_url}activity/import-status?import_id=${importId}`);
  assert.equal(expiredStatus.status, 410);
  assert.deepEqual(await expiredStatus.json(), { ok: false, status: 'unavailable', href: '/files' });

  const secondPath = write(path.join(root, 'incoming', 'second.txt'), 'second report');
  const folderPath = path.join(root, 'incoming-folder');
  fs.mkdirSync(folderPath);
  const secondPicked = await fetch(server.desktop_picker.registration_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-atlas-desktop-token': server.desktop_picker.token },
    body: new URLSearchParams({ file_path: secondPath, kind: 'file', mode: 'multiple', flow: 'import' }),
  });
  const secondSelection = await secondPicked.json();
  await fetch(server.desktop_picker.registration_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-atlas-desktop-token': server.desktop_picker.token },
    body: new URLSearchParams({ file_path: folderPath, kind: 'folder', mode: 'single', flow: 'import', queue_id: secondSelection.queue_id }),
  });
  const secondHtml = await (await fetch(`${server.workspace_url}files/queue/${secondSelection.queue_id}`)).text();
  const secondCsrf = secondHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const secondReviewed = await fetch(`${server.workspace_url}files/queue/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: secondCsrf, queue_id: secondSelection.queue_id, project_id: project.id, folder: 'Data' }), redirect: 'manual',
  });
  const secondReviewHtml = await (await fetch(new URL(secondReviewed.headers.get('location'), server.workspace_url))).text();
  const secondImportId = secondReviewHtml.match(/name="batch_import_id" value="(BIM-[a-f0-9]{32})"/u)?.[1];
  await fetch(`${server.workspace_url}files/batch-add-to-project/save`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: secondCsrf, batch_import_id: secondImportId }), redirect: 'manual',
  });
  let partialStatus = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    partialStatus = await (await fetch(`${server.workspace_url}activity/import-status?import_id=${secondImportId}`)).json();
    if (partialStatus.href) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(partialStatus.status, 'partial');
  assert.equal(partialStatus.href, `/files/queue/${secondSelection.queue_id}`);
  const retainedHtml = await (await fetch(new URL(partialStatus.href, server.workspace_url))).text();
  assert.match(retainedHtml, /incoming-folder/u);
  assert.match(retainedHtml, /imports files only/u);
  assert.match(retainedHtml, /value="Data"[^>]*checked/u);
  assert.match(retainedHtml, /This import result/u);
  assert.match(retainedHtml, /second\.txt/u);
  assert.match(retainedHtml, /1 selected · 0 ready/u);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'Data', 'second.txt'), 'utf8'), 'second report');

  executionError = new Error('Disk write stopped.');
  const failedPath = write(path.join(root, 'incoming', 'failed.txt'), 'will fail');
  const failedPicked = await fetch(server.desktop_picker.registration_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-atlas-desktop-token': server.desktop_picker.token },
    body: new URLSearchParams({ file_path: failedPath, kind: 'file', mode: 'multiple', flow: 'import' }),
  });
  const failedSelection = await failedPicked.json();
  const failedHtml = await (await fetch(`${server.workspace_url}files/queue/${failedSelection.queue_id}`)).text();
  const failedCsrf = failedHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const failedReviewed = await fetch(`${server.workspace_url}files/queue/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: failedCsrf, queue_id: failedSelection.queue_id, project_id: project.id, folder: 'Data' }), redirect: 'manual',
  });
  const failedReview = await (await fetch(new URL(failedReviewed.headers.get('location'), server.workspace_url))).text();
  const failedImportId = failedReview.match(/name="batch_import_id" value="(BIM-[a-f0-9]{32})"/u)?.[1];
  await fetch(`${server.workspace_url}files/batch-add-to-project/save`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: failedCsrf, batch_import_id: failedImportId }), redirect: 'manual',
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await (await fetch(`${server.workspace_url}activity/import-status?import_id=${failedImportId}`)).json();
    if (status.href) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const failedActivity = readCurrentActivityState(stateDir).items.find((item) => item.file_path === failedPath);
  assert.equal(failedActivity.status, 'failed');
  assert.equal(failedActivity.recovery_href, `/files/queue/${failedSelection.queue_id}`);
  assert.equal(failedActivity.recovery_label, 'Return to Import');

  executionError = null;
  corruptActivityAfterSave = true;
  const activityFailurePath = write(path.join(root, 'incoming', 'activity-failure.txt'), 'activity failure isolation');
  const activityFailurePicked = await fetch(server.desktop_picker.registration_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-atlas-desktop-token': server.desktop_picker.token },
    body: new URLSearchParams({ file_path: activityFailurePath, kind: 'file', mode: 'multiple', flow: 'import' }),
  });
  const activityFailureSelection = await activityFailurePicked.json();
  const activityFailureHtml = await (await fetch(`${server.workspace_url}files/queue/${activityFailureSelection.queue_id}`)).text();
  const activityFailureCsrf = activityFailureHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const activityFailureReviewed = await fetch(`${server.workspace_url}files/queue/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: activityFailureCsrf, queue_id: activityFailureSelection.queue_id, project_id: project.id, folder: 'Data' }), redirect: 'manual',
  });
  const activityFailureReview = await (await fetch(new URL(activityFailureReviewed.headers.get('location'), server.workspace_url))).text();
  const activityFailureImportId = activityFailureReview.match(/name="batch_import_id" value="(BIM-[a-f0-9]{32})"/u)?.[1];
  await fetch(`${server.workspace_url}files/batch-add-to-project/save`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: activityFailureCsrf, batch_import_id: activityFailureImportId }), redirect: 'manual',
  });
  let activityFailureStatus = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    activityFailureStatus = await (await fetch(`${server.workspace_url}activity/import-status?import_id=${activityFailureImportId}`)).json();
    if (activityFailureStatus.href) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(activityFailureStatus.status, 'completed');
  assert.equal(activityFailureStatus.href, '/projects/project-1/resources?path=Data%2Factivity-failure.txt');
  assert.equal(fs.readFileSync(path.join(projectRoot, 'Data', 'activity-failure.txt'), 'utf8'), 'activity failure isolation');
});

test('Import save worker executes real Intake state and compensates a failed Recent Work transfer', async (t) => {
  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, 'data-work-worker-regression-'));
  const stateDir = path.join(root, 'state');
  const workspaceRoot = path.join(root, 'workspace');
  const projectRoot = path.join(workspaceRoot, 'Project One');
  fs.mkdirSync(path.join(projectRoot, 'Data'), { recursive: true });

  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({
    rootPath: workspaceRoot, rootType: 'project_workspace', contentPolicy: 'bounded_content',
  });
  const created = registry.create({ name: 'Project One', currentPath: 'Project One' });
  registry.attachRoot(created.project_id, {
    rootId: adopted.root_id, relativePath: 'Project One', reason: 'Bind the worker regression Project.',
  });
  const intake = new Intake({ stateDir });
  t.after(() => intake.dispose());
  t.after(() => registry.dispose());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createProjectImportService({ stateDir, registry, intake });

  const inspectForRecentWork = (sourcePath) => {
    const fingerprint = contentFileFingerprint(sourcePath);
    const inspection = inspectContent({
      stateDir,
      projectRoot: path.resolve('.'),
      installationRoot: path.resolve('.'),
      filePath: sourcePath,
      purpose: 'content',
      maxCharacters: 4000,
      pythonPath: 'atlas-test-python',
      runProcess: () => ({
        status: 0,
        stdout: JSON.stringify({
          schema: CONTENT_INSPECTION_SCHEMA,
          purpose: 'content',
          source: fingerprint,
          selection: { sheet: null },
          extraction: { status: 'success', type: 'text', characters: fingerprint.bytes },
          attention: { maximum_characters: 4000, truncated: false },
          processor: { version: CONTENT_PROCESSOR_VERSION },
        }),
        stderr: '',
      }),
    });
    return upsertRecentWork({
      stateDir,
      filePath: sourcePath,
      inspect: { purpose: 'content', sheet: null, maxCharacters: 4000 },
      sourceFingerprint: fingerprint,
      inspectionId: inspection.inspection_id,
      cacheReference: path.relative(stateDir, inspection.cache_path),
    });
  };

  const sourcePath = write(path.join(root, 'incoming', 'worker-success.txt'), 'worker success');
  const work = inspectForRecentWork(sourcePath);
  const prepared = service.prepare({ work, projectId: created.project_id, folder: 'Data' });
  const saved = await runUiContentOperation('project-import-save', { stateDir, imported: prepared });
  const savedPath = path.join(projectRoot, 'Data', 'worker-success.txt');
  assert.equal(saved.file_path, savedPath);
  assert.equal(saved.project.id, created.project_id);
  assert.equal(fs.readFileSync(savedPath, 'utf8'), 'worker success');
  assert.equal(intake.show(prepared.run_id).run.status, 'executed');

  const failingSource = write(path.join(root, 'incoming', 'worker-rollback.txt'), 'worker rollback');
  const failingWork = inspectForRecentWork(failingSource);
  const failingPrepared = service.prepare({
    work: failingWork, projectId: created.project_id, folder: 'Data',
  });
  fs.rmSync(path.resolve(stateDir, failingWork.cache_reference));
  await assert.rejects(
    runUiContentOperation('project-import-save', { stateDir, imported: failingPrepared }),
    (error) => error.code === 'ATLAS_CONTENT_CACHE_UNAVAILABLE',
  );
  assert.equal(fs.existsSync(path.join(projectRoot, 'Data', 'worker-rollback.txt')), false);
  assert.equal(intake.show(failingPrepared.run_id).run.status, 'rolled_back');
  const retained = readRecentWorkState(stateDir).items.find((item) => item.work_id === failingWork.work_id);
  assert.equal(retained.file_path, failingSource);
  assert.equal(retained.project, null);
});

test('Recent Work serializes a worker update with a concurrent UI removal', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const firstPath = write(path.join(root, 'incoming', 'first.txt'), 'first');
  const secondPath = write(path.join(root, 'incoming', 'second.txt'), 'second');
  const first = upsertRecentWork({
    stateDir,
    filePath: firstPath,
    inspect: { purpose: 'content', sheet: null, maxCharacters: 4000 },
    sourceFingerprint: contentFileFingerprint(firstPath),
    inspectionId: 'inspection-first',
    cacheReference: 'tmp/first.json',
  });
  const second = upsertRecentWork({
    stateDir,
    filePath: secondPath,
    inspect: { purpose: 'content', sheet: null, maxCharacters: 4000 },
    sourceFingerprint: contentFileFingerprint(secondPath),
    inspectionId: 'inspection-second',
    cacheReference: 'tmp/second.json',
  });
  const signals = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { mutateRecentWork } = await import(workerData.moduleUrl);
      const signal = new Int32Array(workerData.signals);
      const value = mutateRecentWork(workerData.stateDir, (records) => {
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
        Atomics.wait(signal, 0, 1, 160);
        const index = records.findIndex((item) => item.work_id === workerData.workId);
        records[index] = { ...records[index], last_continued_at: workerData.continuedAt };
        return { records, value: records[index] };
      });
      parentPort.postMessage({ ok: true, value });
    })().catch((error) => parentPort.postMessage({ ok: false, error: error.message }));
  `, {
    eval: true,
    workerData: {
      moduleUrl: new URL('../src/ui/recent-work.js', import.meta.url).href,
      stateDir,
      workId: first.work_id,
      continuedAt: '2026-09-09T09:00:00.000Z',
      signals,
    },
  });
  const messagePromise = once(worker, 'message').then(([message]) => message);
  const exitPromise = once(worker, 'exit').then(([code]) => code);
  const signal = new Int32Array(signals);
  if (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0, 1000);
  assert.equal(Atomics.load(signal, 0), 1);

  assert.equal(removeRecentWork(stateDir, second.work_id), true);
  const message = await messagePromise;
  assert.deepEqual(message.ok, true, message.error);
  assert.equal(await exitPromise, 0);
  const remaining = readRecentWorkState(stateDir).items;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].work_id, first.work_id);
  assert.equal(remaining[0].last_continued_at, '2026-09-09T09:00:00.000Z');
});

test('CSV inspection renders profile schema types and the Data Work entry', () => {
  const html = renderFileWorkView({
    mode: 'ready',
    inspection: {
      created_at: '2026-08-17T00:00:00.000Z',
      source: {
        path: 'F:\\data\\campaign.csv', extension: '.csv', media_type: 'application/vnd.ms-excel', bytes: 2048,
      },
      extraction: {
        kind: 'tabular_profile', row_count: 9, column_count: 5, duplicate_row_count: 0,
        columns: [
          { name: '报告开始日期', inferred_type: 'date', missing_count: 0 },
          { name: '广告名称', inferred_type: 'text', missing_count: 0 },
          { name: '展示次数', inferred_type: 'integer', missing_count: 0 },
          { name: '点击率', inferred_type: 'number', missing_count: 0 },
          { name: '结果（初始）', inferred_type: 'empty', missing_count: 9 },
        ],
      },
    },
    work: {
      work_id: 'work-1', file_path: 'F:\\data\\campaign.csv', inspect: { purpose: 'data', sheet: null },
    },
  }, { csrfToken: 'csrf' });
  assert.match(html, />CSV</u);
  assert.doesNotMatch(html, /application\/vnd\.ms-excel/u);
  for (const type of ['Date', 'Text', 'Integer', 'Number', 'Empty']) assert.match(html, new RegExp(`>${type}<`, 'u'));
  assert.match(html, /data-profile-table/u);
  assert.match(html, /Technical file details/u);
  assert.match(html, /Work with data/u);
  assert.doesNotMatch(html, />Re-inspect</u);
  assert.match(html, /Open in default app/u);
});

test('Settings exposes distinct workspace themes and migrates the legacy blue accent', () => {
  const migrated = normalizeUiPreferences({ ...UI_PREFERENCE_DEFAULTS, accent: 'blue' });
  assert.equal(migrated.accent, 'vermilion');
  assert.match(preferenceHtmlAttributes(migrated), /data-accent="vermilion"/u);
  assert.match(preferenceHtmlAttributes(migrated), /data-context-delay="650"/u);
  assert.match(preferenceHtmlAttributes(migrated), /data-reduce-motion="false"/u);

  const html = renderSettingsView({ preferences: migrated, runtime: {} }, { csrfToken: 'csrf', returnHref: '/activity' });
  for (const theme of ['Archive Signal', 'Post-Internet Plum', 'Gallery Grid']) assert.match(html, new RegExp(theme, 'u'));
  assert.match(html, /<dialog[^>]+data-overlay-autostart[^>]+data-overlay-dirty-protect/u);
  assert.match(html, /data-overlay-return-href="\/activity"/u);
  assert.match(html, /data-overlay-initial-focus/u);
  assert.match(html, /value="vermilion"/u);
  assert.match(html, /action-button-continue/u);
  assert.match(html, /action-button-remove/u);
  assert.doesNotMatch(html, /Steel blue/u);
  assert.equal(normalizeUiPreferences({ ...UI_PREFERENCE_DEFAULTS, app_rail_width: 68 }).app_rail_width, 68);
  const existingWidthHtml = renderSettingsView({ preferences: { ...migrated, app_rail_width: 240 }, runtime: {} }, { csrfToken: 'csrf' });
  assert.match(existingWidthHtml, /name="project_rail_width"[^>]*step="1"[^>]*value="282"/u);
  assert.match(existingWidthHtml, /name="app_rail_width"[^>]*step="1"[^>]*value="240"/u);
  assert.match(existingWidthHtml, /name="reduce_motion"/u);
});

test('Saved display settings persist when returning to Files', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const registry = { list: () => [], show: () => null };
  const server = await startAtlasUiServer({ stateDir, ...serverServices(registry) });
  let restarted = null;
  t.after(async () => {
    await server.close().catch(() => {});
    await restarted?.close().catch(() => {});
  });

  const settingsResponse = await fetch(`${server.workspace_url}settings`);
  const settingsHtml = await settingsResponse.text();
  const csrf = settingsHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  assert.match(settingsHtml, /name="selected_theme"[^>]*data-settings-selected-theme/u);
  assert.match(settingsHtml, /name="selected_accent"[^>]*data-settings-selected-accent/u);
  const saveResponse = await fetch(`${server.workspace_url}settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf, action: 'save', theme: 'graphite', accent: 'vermilion', contrast: 'high',
      text_size: 'comfortable', density: 'comfortable', project_rail_width: '282', app_rail_width: '228',
      reduce_motion: 'yes',
    }),
    redirect: 'manual',
  });
  assert.equal(saveResponse.status, 303);
  assert.equal(saveResponse.headers.get('location'), '/settings?saved=1');

  const filesResponse = await fetch(`${server.workspace_url}files`);
  const filesHtml = await filesResponse.text();
  assert.match(filesHtml, /data-theme="graphite"/u);
  assert.match(filesHtml, /data-accent="vermilion"/u);
  assert.match(filesHtml, /data-reduce-motion="true"/u);

  const fallbackResponse = await fetch(`${server.workspace_url}settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf, action: 'save', selected_theme: 'warm_charcoal', selected_accent: 'amber', contrast: 'high',
      text_size: 'comfortable', density: 'comfortable', project_rail_width: '282', app_rail_width: '228',
    }),
    redirect: 'manual',
  });
  assert.equal(fallbackResponse.status, 303);
  const fallbackFiles = await fetch(`${server.workspace_url}files`);
  const fallbackFilesHtml = await fallbackFiles.text();
  assert.match(fallbackFilesHtml, /data-theme="warm_charcoal"/u);
  assert.match(fallbackFilesHtml, /data-accent="amber"/u);
  const stored = JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'preferences.json'), 'utf8'));
  assert.equal(stored.theme, 'warm_charcoal');
  assert.equal(stored.accent, 'amber');

  await server.close();
  restarted = await startAtlasUiServer({ stateDir, ...serverServices(registry) });
  for (const route of ['projects', 'activity', 'files']) {
    const restartedHtml = await (await fetch(`${restarted.workspace_url}${route}`)).text();
    assert.match(restartedHtml, /data-theme="warm_charcoal"/u);
    assert.match(restartedHtml, /data-accent="amber"/u);
  }
});

test('Settings save failure keeps the submitted draft and leaves stored preferences unchanged', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const registry = { list: () => [], show: () => null };
  const server = await startAtlasUiServer({
    stateDir,
    ...serverServices(registry),
    writeUiPreferencesFn: () => {
      const error = new Error('The preferences file is locked.');
      error.code = 'EACCES';
      throw error;
    },
  });
  t.after(() => server.close());

  const settingsHtml = await (await fetch(`${server.workspace_url}settings?return_to=%2Factivity`)).text();
  const csrf = settingsHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const response = await fetch(`${server.workspace_url}settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf, action: 'save', return_to: '/activity', selected_theme: 'graphite', selected_accent: 'amber',
      contrast: 'standard', text_size: 'large', density: 'compact', project_rail_width: '320',
      app_rail_width: '92', context_card_delay: 'deliberate', show_technical_ids: 'yes',
    }),
    redirect: 'manual',
  });
  const html = await response.text();
  assert.equal(response.status, 409);
  assert.match(html, /data-overlay-dirty="true"/u);
  assert.match(html, /Action stopped\. The preferences file is locked\./u);
  assert.match(html, /name="theme" value="graphite" checked/u);
  assert.match(html, /name="accent" value="amber" checked/u);
  assert.match(html, /name="return_to" value="\/activity"/u);
  assert.equal(fs.existsSync(path.join(stateDir, 'ui', 'preferences.json')), false);

  const escapedReturnHtml = await (await fetch(`${server.workspace_url}settings?return_to=${encodeURIComponent('//example.com/escape')}`)).text();
  assert.match(escapedReturnHtml, /name="return_to" value="\/projects"/u);
});

test('Shared overlays keep keyboard focus, survive blocked Web Storage, and keep Status guide available in compact layouts', () => {
  const topbarHtml = renderBatchWorkView({ mode: 'empty-selection', projects: [] }, {
    csrfToken: 'csrf', workspaceHref: '/projects', settingsHref: '/settings',
  });
  assert.match(topbarHtml, /id="atlas-search"[^>]+data-atlas-overlay/u);
  assert.match(topbarHtml, /id="atlas-search-query"[^>]+data-overlay-initial-focus/u);

  const client = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  assert.match(client, /function storageGet\(/u);
  assert.match(client, /function storageSet\(/u);
  assert.match(client, /dataOverlayDirtyProtect|overlayDirtyProtect|overlay-dirty-protect/u);
  assert.match(client, /dataOverlayInitialFocus|overlayInitialFocus|overlay-initial-focus/u);
  assert.match(client, /const initialFocus = dialog\.querySelector\('\[data-overlay-initial-focus\]'\)/u);
  assert.match(client, /const markDirty = \(\) => \{ dialog\.dataset\.overlayDirty = 'true'; \}/u);
  assert.match(client, /addEventListener\('input', markDirty\)/u);
  assert.match(client, /querySelector\('\[data-overlay-dirty-protect\]\[open\]'\)/u);
  assert.match(client, /event\.key [!=]==? 'Escape'/u);
  assert.match(client, /window\.addEventListener\('resize', hide\)/u);

  const layoutCss = fs.readFileSync(path.resolve('src', 'ui', 'styles', 'layout.css'), 'utf8');
  const componentsCss = fs.readFileSync(path.resolve('src', 'ui', 'styles', 'components.css'), 'utf8');
  assert.doesNotMatch(layoutCss, /\.device-state-copy, \.app-shell \.status-guide \{ display: none; \}/u);
  assert.doesNotMatch(componentsCss, /\.device-state-copy,\s*\nbody \.is-compact-app-rail \.status-guide \{ display: none; \}/u);
  assert.match(componentsCss, /html\[data-density="compact"\] \.workspace-resource-file/u);
});

test('File read failures map to explicit recovery capabilities without unsafe generic retry', () => {
  const cases = [
    [{ code: 'ENOENT', message: 'missing' }, 'missing', false, false],
    [{ code: 'EACCES', message: 'access denied' }, 'permission', true, true],
    [{ code: 'EBUSY', message: 'file locked' }, 'busy', true, true],
    [{ code: 'ATLAS_CAPABILITY_UNAVAILABLE', message: 'Python component unavailable' }, 'component_unavailable', true, true],
    [{ code: 'ATLAS_CONTENT_CACHE_UNAVAILABLE', message: 'cache corrupt' }, 'cache_unavailable', true, true],
    [{ code: 'ATLAS_STATE_CONFLICT', message: 'file changed while reading' }, 'changed', true, true],
    [{ message: 'Worksheet does not exist: Revenue' }, 'sheet', false, true],
    [{ message: 'text encoding decode failed' }, 'encoding', false, true],
    [{ message: 'No usable header row was found' }, 'header', false, true],
    [{ message: 'invalid workbook package' }, 'corrupt', false, true],
    [{ message: 'parser could not parse file structure' }, 'parser', false, true],
    [{ message: 'format is not supported' }, 'unsupported', false, true],
    [{ message: 'unexpected local reader stop' }, 'unknown', true, true],
  ];
  for (const [error, kind, retrySupported, openSupported] of cases) {
    const failure = describeFileReadFailure(error);
    assert.equal(failure.kind, kind);
    assert.equal(failure.retry_supported, retrySupported);
    assert.equal(failure.open_supported, openSupported);
  }
});

test('Missing and failed Recent Work expose only recovery actions that remain valid', () => {
  const work = {
    work_id: 'RWK-11111111-1111-4111-8111-111111111111',
    file_path: 'F:\\missing\\campaign.csv',
    inspect: { purpose: 'data', sheet: null },
    project_transfer: { undo_available: true },
  };
  const options = {
    csrfToken: 'csrf', fileBackHref: '/activity', fileCurrentHref: '/files/result/RWK-11111111-1111-4111-8111-111111111111?return_to=%2Factivity',
  };
  const missing = renderFileWorkView({ mode: 'missing', work }, options);
  assert.match(missing, /Undo Add to Project/u);
  assert.match(missing, /Remove from Recent Work/u);
  assert.match(missing, /href="\/activity"/u);
  assert.doesNotMatch(missing, /Work with data|>Add to Project<|Open in default app|Retry local read/u);

  const failed = renderFileWorkView({
    mode: 'read-failed', work,
    failure: describeFileReadFailure({ message: 'text encoding decode failed' }),
  }, options);
  assert.match(failed, /Open in default app/u);
  assert.match(failed, /name="return_to" value="\/files\/result\/RWK-/u);
  assert.match(failed, /Undo Add to Project/u);
  assert.doesNotMatch(failed, />Retry local read</u);
});

test('Import notices render structured failures without object coercion', () => {
  const html = renderBatchWorkView({
    mode: 'empty-selection', projects: [],
    notice: { title: 'Permission denied', action: 'Allow local access, then choose the file again.' },
  }, { csrfToken: 'csrf' });
  assert.match(html, /Permission denied\. Allow local access/u);
  assert.doesNotMatch(html, /\[object Object\]/u);
});

test('Recent Work preserves validated Activity and Project object return context', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const projectRoot = path.join(root, 'project');
  const source = write(path.join(projectRoot, 'Data', 'campaign.csv'), 'name\ncampaign\n');
  const project = { id: 'project-1', name: 'Project One', status: 'active' };
  const work = upsertRecentWork({
    stateDir, filePath: source, inspect: { purpose: 'data', sheet: null, maxCharacters: 4000 },
    sourceFingerprint: contentFileFingerprint(source), inspectionId: 'inspection-return-context',
    cacheReference: 'tmp/missing-result.json', project,
  });
  const registry = {
    list: () => [project],
    show: () => ({ ...project, location: { root_path: projectRoot, relative_path: '' } }),
    resolvePath: () => ({ project }),
  };
  const server = await startAtlasUiServer({ stateDir, ...serverServices(registry) });
  t.after(() => server.close());

  const activityReturn = '/activity?selected=ACT-123';
  const activityHtml = await (await fetch(`${server.workspace_url}files/result/${work.work_id}?return_to=${encodeURIComponent(activityReturn)}`)).text();
  assert.match(activityHtml, /href="\/activity\?selected=ACT-123"/u);

  const resourceReturn = '/projects/project-1/resources?path=Data%2Fcampaign.csv';
  const resourceHtml = await (await fetch(`${server.workspace_url}files/result/${work.work_id}?return_to=${encodeURIComponent(resourceReturn)}`)).text();
  assert.match(resourceHtml, /href="\/projects\/project-1\/resources\?path=Data%2Fcampaign\.csv"/u);

  const otherProject = '/projects/project-2/resources?path=secret.txt';
  const containedHtml = await (await fetch(`${server.workspace_url}files/result/${work.work_id}?return_to=${encodeURIComponent(otherProject)}`)).text();
  assert.doesNotMatch(containedHtml, /href="\/projects\/project-2|href="\/[^"?]*secret\.txt/u);
  assert.match(containedHtml, /href="\/projects\/project-1\/resources"/u);
});

test('Global Search finds only registered Project names and Resource paths', async (t) => {
  const root = temporaryDirectory(t);
  const projectRoot = path.join(root, 'project');
  write(path.join(projectRoot, 'Data', 'campaign.csv'), 'date,value\n2026-07-01,1\n');
  const registry = {
    list: () => [{ id: 'project-1', name: 'Campaign Project', status: 'active' }],
    show: () => ({ location: { root_path: projectRoot, relative_path: '' } }),
    resolvePath: () => ({ status: 'unresolved' }),
  };
  const server = await startAtlasUiServer({ stateDir: path.join(root, 'state'), ...serverServices(registry) });
  t.after(() => server.close());

  const response = await fetch(`${server.workspace_url}search?q=campaign`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Search Projects and Resources/u);
  assert.match(html, /Campaign Project/u);
  assert.match(html, /campaign\.csv/u);
  assert.match(html, /projects\/project-1\/resources\?path=Data%2Fcampaign\.csv/u);
  assert.match(html, /does not read file contents/u);
});

test('Global Search routes existing relationships and Activity to their real product surfaces', async (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  const projectRoot = path.join(root, 'project');
  const sourcePath = write(path.join(projectRoot, 'Data', 'source.csv'), 'value\n1\n');
  const resultPath = write(path.join(projectRoot, 'Outputs', 'result.csv'), 'value\n2\n');
  const project = { id: 'project-1', name: 'Campaign Project', status: 'active' };
  const registry = {
    list: () => [project],
    show: () => ({ ...project, location: { root_path: projectRoot, relative_path: '' } }),
    resolvePath: () => ({ status: 'unresolved' }),
  };
  write(path.join(stateDir, 'ui', 'saved-work.json'), JSON.stringify({
    items: [{
      work_id: `SWR-${crypto.randomUUID()}`,
      project: { id: project.id, name: project.name },
      source_path: sourcePath,
      result_path: resultPath,
      status: 'active',
    }],
  }));
  const activity = beginCurrentActivity({
    stateDir, filePath: sourcePath, purpose: 'data', project, channel: 'desktop',
  });
  const server = await startAtlasUiServer({ stateDir, ...serverServices(registry) });
  t.after(() => server.close());

  const relationshipHtml = await (await fetch(`${server.workspace_url}search?q=source.csv`)).text();
  assert.match(relationshipHtml, /Known relationship/u);
  assert.match(relationshipHtml, /source\.csv.*result\.csv/us);
  assert.match(relationshipHtml, /projects\/project-1\/resources\?path=Outputs%2Fresult\.csv/u);

  const activityHtml = await (await fetch(`${server.workspace_url}search?q=In progress`)).text();
  assert.match(activityHtml, /Activity/u);
  assert.match(activityHtml, new RegExp(`activity\\?selected=${activity.activity_id}`, 'u'));

  const activityStatePath = path.join(stateDir, 'ui', 'current-activity.json');
  const activityState = JSON.parse(fs.readFileSync(activityStatePath, 'utf8'));
  activityState.items[0].started_at = new Date(Date.now() - (31 * 60 * 1000)).toISOString();
  write(activityStatePath, JSON.stringify(activityState));
  const interruptedHtml = await (await fetch(`${server.workspace_url}search?q=Interrupted`)).text();
  assert.match(interruptedHtml, /Activity/u);
  assert.match(interruptedHtml, /Campaign Project · Interrupted/u);
  assert.doesNotMatch(interruptedHtml, /Campaign Project · Completed/u);
});

test('Global Search reports bounded no-results and unavailable Project states', async (t) => {
  const root = temporaryDirectory(t);
  const registry = {
    list: () => [{ id: 'missing-project', name: 'Missing Project', status: 'active' }],
    show: () => ({ location: { root_path: path.join(root, 'missing'), relative_path: '' } }),
    resolvePath: () => ({ status: 'unresolved' }),
  };
  const server = await startAtlasUiServer({ stateDir: path.join(root, 'state'), ...serverServices(registry) });
  t.after(() => server.close());

  const html = await (await fetch(`${server.workspace_url}search?q=definitely-absent`)).text();
  assert.match(html, /No local matches/u);
  assert.match(html, /1 Project folder was unavailable/u);
  assert.doesNotMatch(html, /Task|Context Pack/u);
});

test('Atlas navigation uses product surfaces, aligned SVG icons, and supplied Pachin identity assets', () => {
  const html = renderBatchWorkView({
    mode: 'empty-selection',
  }, { csrfToken: 'csrf', settingsHref: '/settings' });
  assert.match(html, /data-toggle-rail/u);
  assert.match(html, /aria-valuemin="68"/u);
  assert.doesNotMatch(html, /class="nav-short"/u);
  assert.match(html, /class="nav-icon"/u);
  assert.match(html, /data-icon="projects"/u);
  assert.match(html, /data-icon="resources"/u);
  assert.match(html, /data-icon="activity"/u);
  assert.match(html, /data-icon="import"/u);
  assert.match(html, /data-icon="settings"/u);
  assert.match(html, /stroke-linecap="round"/u);
  assert.match(html, /\/ui\/pachin-seal\.png/u);
  assert.match(html, /\/ui\/pachin-calligraphy\.png/u);
  assert.match(html, /PACHIN STUDIO/u);
  assert.match(html, /LOCAL WORKSPACE/u);
  assert.match(html, /is-compact-app-rail/u);
  assert.match(html, /height:\s*100dvh/u);
  assert.match(html, /position:\s*sticky/u);
  assert.match(html, /signature-calligraphy[^}]*height:\s*62px/u);
  assert.match(html, /body \.brand \{[^}]*min-height:\s*86px/u);
  assert.match(html, /body \.nav-item \{[^}]*padding:\s*0/u);
  assert.match(html, /body \.nav-item > a, body \.nav-item > \.nav-link \{[^}]*display:\s*flex/u);
  assert.match(html, /body \.sidebar-signature \{[^}]*flex-shrink:\s*0[^}]*min-height:\s*120px/u);
  assert.ok(html.indexOf('>Projects<') < html.indexOf('>Resources<'));
  assert.ok(html.indexOf('>Resources<') < html.indexOf('>Activity<'));
  assert.ok(html.indexOf('>Activity<') < html.indexOf('>Import<'));
  assert.match(html, /href="\/projects" title="Choose a Project to view its resources" data-resources-nav/u);
  assert.doesNotMatch(html, /data-resources-nav[^>]*aria-disabled="true"/u);
  const clientSource = fs.readFileSync(path.resolve('src', 'ui', 'client.js'), 'utf8');
  assert.match(clientSource, /item\.href = rememberedProjectHref/u);
  assert.match(html, /data-import-files[^>]*>Add files</u);
  assert.match(html, /data-import-add-folder[^>]*>Add folder</u);
  assert.doesNotMatch(html, />Open File</u);
  assert.doesNotMatch(html, />Open Files</u);
  assert.doesNotMatch(html, />Compare Files</u);
});

test('File results retain Remove and Undo while batch results retain Continue', () => {
  const batch = renderBatchWorkView({
    mode: 'batch-result', batch_id: 'BRS-1', inspected_count: 1,
    items: [{ work_id: 'work-1', name: 'campaign.csv', status: 'inspected', fact: 'Local inspection ready' }],
  }, { csrfToken: 'csrf' });
  assert.match(batch, /href="\/files\/continue\?work_id=work-1"/u);
  const ready = renderFileWorkView({
    mode: 'ready',
    inspection: { source: { path: 'F:\\data\\campaign.csv', extension: '.csv', bytes: 1 }, extraction: {} },
    work: {
      work_id: 'work-1', file_path: 'F:\\data\\campaign.csv', inspect: { purpose: 'data', sheet: null },
      project_transfer: { undo_available: true },
    },
  }, { csrfToken: 'csrf' });
  assert.match(ready, /action="\/files\/remove"/u);
  assert.match(ready, /action="\/files\/add-to-project\/undo"/u);
  assert.match(ready, /name="work_id" value="work-1"/u);
});

test('File Work unavailable mode returns to Import without the legacy list', () => {
  const html = renderFileWorkView({ mode: 'unavailable' }, { csrfToken: 'csrf' });
  assert.match(html, /This file work view is unavailable\./u);
  assert.match(html, /href="\/files"/u);
  assert.doesNotMatch(html, /Recent Work/u);
  assert.doesNotMatch(html, /data-import-files/u);
  assert.doesNotMatch(html, /data-import-add-folder/u);
});

test('Data Work keeps wide previews inside a readable scroll region', () => {
  const columns = Array.from({ length: 26 }, (_, index) => `字段 ${index + 1}`);
  const html = renderDataWorkView({
    mode: 'table', csrf: 'csrf', page: 0, back_href: '/files',
    session: {
      session_id: 'DWT-1234567890abcdef1234567890abcdef', file_path: 'F:\\data\\campaign.csv', sheet: null,
      available_columns: columns, column_types: {},
      operations: { search: null, filters: [], sort: null, columns, remove_empty_rows: false, remove_duplicates: false },
      preview: {
        columns, rows: [columns.map((_, index) => index)],
        source_summary: { rows: 9, columns: 26 }, result_summary: { rows: 9, columns: 26 },
      },
    },
  });
  assert.match(html, /class="page data-work-page"/u);
  assert.match(html, /class="data-work-table-wrap"/u);
  assert.match(html, /class="data-work-table"/u);
  assert.match(html, />26 selected</u);
  assert.match(html, /white-space: nowrap/u);
  assert.doesNotMatch(html, /字段 1, 字段 2, 字段 3/u);
});

test('Recent Work sorts by the latest inspection or continuation time', (t) => {
  const root = temporaryDirectory(t);
  const stateDir = path.join(root, 'state');
  for (const name of ['a.csv', 'b.csv']) {
    const filePath = write(path.join(root, name), 'value\n1\n');
    upsertRecentWork({ stateDir, filePath, inspect: { purpose: 'data', sheet: null, maxCharacters: 4000 }, sourceFingerprint: contentFileFingerprint(filePath), inspectionId: `inspection-${name}`, cacheReference: `tmp/${name}.json` });
  }
  const target = path.join(stateDir, 'ui', 'recent-work.json');
  const state = JSON.parse(fs.readFileSync(target, 'utf8'));
  const a = state.items.find((item) => item.file_path.endsWith('a.csv'));
  const b = state.items.find((item) => item.file_path.endsWith('b.csv'));
  a.inspected_at = '2026-08-14T12:00:00.000Z'; a.last_continued_at = '2024-01-01T00:00:00.000Z';
  b.inspected_at = '2025-08-14T12:00:00.000Z'; b.last_continued_at = null;
  fs.writeFileSync(target, JSON.stringify(state), 'utf8');
  assert.equal(path.basename(readRecentWorkState(stateDir).items[0].file_path), 'a.csv');
});

test('Project file discovery skips technical directories and reports folder limits', (t) => {
  const root = temporaryDirectory(t);
  write(path.join(root, '.git', 'secret.txt'), 'hidden');
  write(path.join(root, 'node_modules', 'dependency.txt'), 'hidden');
  write(path.join(root, 'visible.txt'), 'visible');
  for (let index = 0; index < 501; index += 1) write(path.join(root, `file-${String(index).padStart(3, '0')}.txt`), 'x');
  assert.equal(searchProjectFiles(root, '').items.some((item) => item.relative_path.includes('.git') || item.relative_path.includes('node_modules')), false);
  const browse = browseProjectFiles(root);
  assert.equal(browse.items.length, 500);
  assert.equal(browse.truncated, true);
});

test('Created Work is not also counted as a source or Other File', (t) => {
  const root = temporaryDirectory(t);
  const resultPath = write(path.join(root, 'result.csv'), 'value\n1\n');
  const summary = summarizeProjectResources({
    project: { id: 'project-1' }, root,
    recentWork: [{ project: { id: 'project-1' }, file_path: resultPath, project_transfer: { saved_at: '2026-08-14T00:00:00.000Z', origin: { file_path: 'external.csv' }, undo_available: true }, inspect: {}, source_fingerprint: {} }],
    savedWork: [{ work_id: 'saved-1', result_path: resultPath, source_path: path.join(root, 'source.csv'), created_at: '2026-08-14T00:00:00.000Z', write: { undo_available: true } }],
  });
  assert.deepEqual({ known: summary.known_sources, created: summary.created_work, other: summary.other_files }, { known: 0, created: 1, other: 0 });
});

test('Project Compare defaults to two different supported files inside the Atlas shell', () => {
  assert.equal(contentComparisonSupported('notes.md'), true);
  assert.equal(contentComparisonSupported('report.pdf'), false);
  const html = renderFileCompareView({ mode: 'project-choose', choices: [{ relative_path: 'a.md' }, { relative_path: 'b.txt' }], compare_action: '/projects/p/compare/run' }, { csrfToken: 'token', navCurrent: 'Projects' });
  assert.match(html, /value="a\.md" selected/u);
  assert.match(html, /value="b\.txt" selected/u);
  assert.match(html, /atlas-primary-nav/u);
});

test('Unsupported files do not consume Project Compare result slots', (t) => {
  const root = temporaryDirectory(t);
  for (let index = 0; index < 160; index += 1) write(path.join(root, `${String(index).padStart(3, '0')}.pdf`), 'binary placeholder');
  write(path.join(root, 'z-notes.md'), '# Notes');
  const choices = searchProjectFiles(root, '', { acceptFile: (item) => contentComparisonSupported(item.relative_path) });
  assert.deepEqual(choices.items.map((item) => item.relative_path), ['z-notes.md']);
});

test('Projects Home keeps an unavailable registered Project visible without an Open action', () => {
  const html = renderProjectsHomeView({ projects: [{ id: 'p1', name: 'Unavailable Project', folder: 'F:\\missing', folder_display: 'missing', folder_available: false, folder_issue: 'This Project folder is no longer at its recorded location.', relink_href: '/projects/p1/relink' }] });
  assert.match(html, /Folder unavailable/u);
  assert.match(html, /This Project folder is no longer at its recorded location\./u);
  assert.match(html, /href="\/projects\/p1\/relink">Relink/u);
  assert.doesNotMatch(html, /F:\\missing/u);
  assert.doesNotMatch(html, />Open</u);
});

test('Projects Home uses whole-row links and real recent resources instead of dashboard counts', () => {
  const html = renderProjectsHomeView({
    selected_project_id: 'p1',
    projects: [{
      id: 'p1', name: 'Campaign', folder_available: true,
      recent_resource: { name: 'July report.xlsx' },
      recent_activity_text: 'Codex saved this today',
    }],
  });
  assert.match(html, /class="projects-home-row"[^>]+href="\/projects\/p1\/resources"/u);
  assert.match(html, /July report\.xlsx/u);
  assert.match(html, /Codex saved this today/u);
  assert.match(html, /data-project-filter/u);
  assert.doesNotMatch(html, /Recent file work/u);
  assert.doesNotMatch(html, />Open</u);
});

test('Projects Home filter rows have an explicit hidden rendering contract', () => {
  const styles = fs.readFileSync(path.resolve('src/ui/styles/components.css'), 'utf8');
  assert.match(styles, /\.projects-home-row\[hidden\]\s*\{[^}]*display:\s*none\s*!important/u);
});

test('Project Relink verifies a moved folder through the existing Registry recovery path', (t) => {
  const root = temporaryDirectory(t);
  const selected = path.join(root, 'Moved Project');
  fs.mkdirSync(selected);
  let relocation = null;
  const service = createProjectOnboardingService({ registry: {
    show: () => ({ id: 'p1', name: 'Moved Project', location: { root_path: root, relative_path: 'Missing Project' } }),
    listRoots: () => [{ id: 'root-1', current_path: root }],
    relocate: (projectId, options) => { relocation = { projectId, ...options }; return { status: 'relocated' }; },
    list: () => [{ id: 'p1', name: 'Moved Project', status: 'active' }],
  } });
  const result = service.relinkFolder('p1', selected);
  assert.equal(result.folder, selected);
  assert.deepEqual({ projectId: relocation.projectId, rootId: relocation.rootId, relativePath: relocation.relativePath }, {
    projectId: 'p1', rootId: 'root-1', relativePath: 'Moved Project',
  });
});

function serverServices(registry) {
  return {
    registry, rules: {}, runtime: {}, task: {}, guarded: {}, derived: {}, intake: {}, lifecycle: {},
    projectRoot: path.resolve('.'), installationRoot: path.resolve('.'),
  };
}

test('Projects route remains available when one registered folder is missing', async (t) => {
  const root = temporaryDirectory(t);
  const registry = {
    list: () => [{ id: 'missing-project', name: 'Missing Project', status: 'active' }],
    show: () => ({ location: { root_path: path.join(root, 'missing'), relative_path: '' } }),
  };
  const server = await startAtlasUiServer({ stateDir: path.join(root, 'state'), ...serverServices(registry) });
  t.after(() => server.close());
  assert.equal(server.url, `${server.workspace_url}projects`);
  const response = await fetch(`${server.workspace_url}projects`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-eval/u);
  assert.match(html, /Missing Project/u);
  assert.match(html, /Folder unavailable/u);
});

test('Activity exposes local live updates and a replaceable fragment without whole-page refresh', async (t) => {
  const root = temporaryDirectory(t);
  const registry = { list: () => [], show: () => null };
  const server = await startAtlasUiServer({ stateDir: path.join(root, 'state'), ...serverServices(registry) });
  t.after(() => server.close());
  const page = await fetch(`${server.workspace_url}activity`);
  const html = await page.text();
  assert.match(html, /data-events-href="\/activity\/events"/u);
  assert.match(html, /data-fragment-href="\/activity\/fragment"/u);
  assert.doesNotMatch(html, /http-equiv="refresh"/u);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/u);
  const fragment = await fetch(`${server.workspace_url}activity/fragment`);
  assert.match(await fragment.text(), /^<section class="activity-manager"/u);
  const controller = new AbortController();
  const events = await fetch(`${server.workspace_url}activity/events`, { signal: controller.signal });
  const first = await events.body.getReader().read();
  controller.abort();
  assert.match(new TextDecoder().decode(first.value), /event: ready\ndata: connected/u);
});

test('Activity links only real Project files, not failed directory inputs', async (t) => {
  const root = temporaryDirectory(t);
  const projectRoot = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  const folder = path.join(projectRoot, 'docs');
  fs.mkdirSync(folder, { recursive: true });
  const project = { id: 'project-1', name: 'Project One', status: 'active' };
  const activity = beginCurrentActivity({ stateDir, filePath: folder, purpose: 'structure', caller: { agent: 'Codex' }, project });
  failCurrentActivity({ stateDir, activityId: activity.activity_id, error: new Error('A regular file is required.') });
  const registry = {
    list: () => [project],
    show: () => ({ ...project, location: { root_path: projectRoot, relative_path: '' } }),
  };
  const server = await startAtlasUiServer({ stateDir, ...serverServices(registry) });
  t.after(() => server.close());

  const response = await fetch(`${server.workspace_url}activity`);
  const html = await response.text();
  assert.match(html, />docs</u);
  assert.match(html, /A regular file is required\./u);
  assert.doesNotMatch(html, /resources\?path=docs/u);
});

test('Opening a Project enters its Resource tree workspace', async (t) => {
  const root = temporaryDirectory(t);
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const registry = {
    list: () => [{ id: 'project-1', name: 'Project One', status: 'active' }],
    show: () => ({ id: 'project-1', name: 'Project One', status: 'active', location: { root_path: projectRoot, relative_path: '' } }),
  };
  const server = await startAtlasUiServer({ stateDir: path.join(root, 'state'), ...serverServices(registry) });
  t.after(() => server.close());

  const response = await fetch(`${server.workspace_url}projects/project-1`, { redirect: 'manual' });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/projects/project-1/resources');
});

test('Project Compare route stays in the shell, filters choices, and rejects the same file', async (t) => {
  const root = temporaryDirectory(t);
  const projectRoot = path.join(root, 'project');
  write(path.join(projectRoot, 'a.md'), '# A');
  write(path.join(projectRoot, 'b.txt'), 'B');
  write(path.join(projectRoot, 'report.pdf'), 'not a real pdf');
  const registry = {
    list: () => [{ id: 'project-1', name: 'Project One', status: 'active' }],
    show: () => ({ location: { root_path: projectRoot, relative_path: '' } }),
  };
  const server = await startAtlasUiServer({ stateDir: path.join(root, 'state'), desktopPickerEnabled: true, ...serverServices(registry) });
  t.after(() => server.close());
  const chooseResponse = await fetch(`${server.workspace_url}projects/project-1/compare`);
  const chooseHtml = await chooseResponse.text();
  assert.equal(chooseResponse.status, 200);
  assert.match(chooseResponse.headers.get('content-security-policy'), /script-src 'self' 'unsafe-eval'/u);
  assert.match(chooseHtml, /value="a\.md" selected/u);
  assert.match(chooseHtml, /value="b\.txt" selected/u);
  assert.doesNotMatch(chooseHtml, /report\.pdf/u);
  assert.match(chooseHtml, /Settings/u);
  const csrf = chooseHtml.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
  const response = await fetch(`${server.workspace_url}projects/project-1/compare/run`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, left: 'a.md', right: 'a.md' }), redirect: 'manual',
  });
  const html = await response.text();
  assert.equal(response.status, 400);
  assert.match(html, /Choose two different files\./u);
  assert.match(html, /PROJECT COMPARISON/u);
});

test('Atlas UI rejects a WebView2-restricted explicit port', async (t) => {
  const root = temporaryDirectory(t);
  const registry = { list: () => [], show: () => null };
  await assert.rejects(
    startAtlasUiServer({ stateDir: path.join(root, 'state'), port: 6665, ...serverServices(registry) }),
    /WebView2 blocks it/u,
  );
});

test('Atlas UI serves the Workspace texture and supplied identity assets locally', async (t) => {
  const root = temporaryDirectory(t);
  const registry = { list: () => [], show: () => null };
  const server = await startAtlasUiServer({ stateDir: path.join(root, 'state'), ...serverServices(registry) });
  t.after(() => server.close());

  for (const asset of ['atlas-paper-texture.png', 'pachin-seal.png', 'pachin-calligraphy.png']) {
    const response = await fetch(`${server.workspace_url}ui/${asset}`);
    const image = await response.arrayBuffer();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/png/u);
    assert.ok(image.byteLength > 1_000);
  }
});
