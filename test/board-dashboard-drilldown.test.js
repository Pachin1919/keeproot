import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BoardService } from '../src/board-service.js';
import { contentFileFingerprint } from '../src/content-inspection.js';
import { Intake } from '../src/intake.js';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createSavedWorkService } from '../src/ui/services/saved-work-service.js';
import { createTableWorkModule } from '../src/table-work-module.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { MODULE_PROTOCOL_VERSION } from '../src/protocol.js';
import { createModuleAvailabilityService } from '../src/module-availability.js';

const python = path.resolve('test/.tmp/v20-01-isolated-install/desktop-ui/venv/Scripts/python.exe');
const pythonRoot = path.resolve('python'); const pythonSourceRoot = path.resolve('python/src');
function runDataWork(args) {
  const argv = ['-m', 'atlas_content', 'data-work', '--file', args.filePath, '--expected-sha256', args.expectedSha256, '--action', args.action];
  if (args.requestPath) argv.push('--request', args.requestPath);
  if (args.outputPath) argv.push('--output', args.outputPath);
  if (args.sheet) argv.push('--sheet', args.sheet);
  const result = spawnSync(python, argv, { cwd: pythonRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: [pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONUTF8: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Python Data Work exited ${result.status}`);
  return JSON.parse(result.stdout);
}

test('Board category drilldown focuses the linked Work, reads details, and returns without changing the Board Save', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/board-drilldown-'));
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'Transit');
  const sourcePath = path.join(projectRoot, 'Data', 'source.csv');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true }); fs.mkdirSync(path.join(projectRoot, 'Results'), { recursive: true });
  const original = 'district,amount\nNorth,10\nSouth,5\n'; fs.writeFileSync(sourcePath, original, 'utf8');
  const stateDir = path.join(root, 'state'); const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Transit', currentPath: 'Transit' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Transit', reason: 'Drilldown fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const source = control.identify({ filePath: sourcePath, project: { id: project.project_id } });
  const intake = new Intake({ stateDir }); const saveService = new SaveService({ stateDir, intake, resourceControl: control });
  const savedWork = createSavedWorkService({ stateDir, saveService });
  const dataWork = createDataWorkService({ stateDir, projectRoot: root, installationRoot: root, resourceControl: control,
    fingerprintFn: async (filePath) => contentFileFingerprint(filePath), runDataWorkFn: runDataWork });
  const resolveProject = (projectId) => {
    const item = registry.list().find((candidate) => candidate.id === projectId && candidate.status === 'active');
    if (!item) return null;
    const location = registry.show(projectId).location;
    return location?.root_path ? { project: { id: item.id, name: item.name, status: item.status }, location } : null;
  };
  const tableWork = createTableWorkModule({ dataWork, savedWork, resolveProject });
  let server = null;
  t.after(async () => {
    await server?.close(); saveService.dispose(); control.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const invoke = (action, parameters = {}, session = null) => tableWork.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.project_id,
    ...(session ? { work: { session_id: session.session_id, base_revision: session.revision } } : {}), action, parameters });
  let work = (await invoke('start', { resource_ids: [source.resource_id], caller: { actor: 'agent', tool: 'drilldown-test', client_run_id: 'drill-start' } })).data;
  work = (await invoke('prepare', {}, work)).data;
  const mapping = work.sources[0].profile.profile.fields.map((field) => ({ source_key: work.sources[0].source_key, column: field.name, canonical: field.name }));
  work = (await invoke('align', { mapping }, work)).data;
  work = (await invoke('recipe', { combine: 'concatenate', filter_column: '', aggregate_dimension: 'district', aggregate_measure: 'amount',
    aggregate_formula: 'sum', aggregate_unit: 'rides', aggregate_null_policy: 'exclude' }, work)).data;
  work = (await invoke('preview', {}, work)).data;
  assert.equal(work.preview.aggregation.grand_total, 15);
  const fingerprint = await contentFileFingerprint(sourcePath);
  const candidate = path.join(stateDir, 'grouped.csv'); fs.writeFileSync(candidate, 'district,amount\nNorth,10\nSouth,5\n');
  const sources = work.sources.map((item) => ({ source_key: item.source_key, resource_id: item.resource_id, path: item.file_path,
    fingerprint: item.fingerprint, sheet: item.sheet ?? null, version_policy: item.version_policy ?? 'follow_latest' }));
  const prepared = saveService.prepare({ root: workspace, candidateFile: candidate, projectId: project.project_id, target: 'Transit/Results/grouped.csv',
    inputs: [sourcePath], origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'drilldown-save',
    caller: { actor: 'agent', tool: 'drilldown-test', client_run_id: 'drilldown-save' },
    source: { path: sourcePath, fingerprint, resource_id: source.resource_id, sources, recipe: work.recipe },
    parameters: { work_session_id: work.session_id, mapping: work.mapping, recipe_version: work.recipe.version,
      table_work_save: { identity: { module_id: 'atlas.table-work', project_id: project.project_id, session_id: work.session_id,
        base_revision: work.revision, preview_revision: work.preview_revision, mapping: work.mapping, recipe: work.recipe } } },
    resultSummary: { rows: 2, columns: 2, validation: { input_rows: 2, output_rows: 2 } }, intent: 'Grouped result for drilldown.' });
  const saved = saveService.execute(prepared.save_id, { reason: 'Fixture participant confirmed.' });
  dataWork.recordSave(work.session_id, saved.save_id);
  const boardService = new BoardService({ stateDir, registry, resourceControl: control, saveService, projectRoot: workspace });
  const board = boardService.createBoard({ projectId: project.project_id, title: 'Transit totals' });
  const savedBoard = boardService.saveBoard({ projectId: project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision,
    blocks: [{ type: 'result_preview', save_id: saved.save_id, version_policy: 'pinned_version' }] });
  const originalBoard = boardService.showBoard(project.project_id, board.board_id);
  assert.equal(originalBoard.blocks[0].dashboard_projection?.kind, 'table_work_group_sum');
  assert.equal(originalBoard.blocks[0].dashboard_projection?.grand_total, 15);

  server = await startAtlasUiServer({ stateDir, registry, intake, rules: {}, runtime: {}, projectRoot: workspace, installationRoot: root,
    resourceControl: control, dataWorkService: dataWork });
  const boardUrl = `${server.workspace_url}projects/${encodeURIComponent(project.project_id)}/boards/${encodeURIComponent(board.board_id)}`;
  const boardResponse = await fetch(boardUrl); const boardHtml = await boardResponse.text();
  assert.equal(boardResponse.status, 200);
  const csrf = boardHtml.match(/name="csrf" value="([^"]+)"/u)?.[1]; assert.ok(csrf);
  assert.match(boardHtml, new RegExp(`/projects/${project.project_id}/boards/${board.board_id}/drill`, 'u'));
  assert.match(boardHtml, /name="category" value="North"/u);
  const drillUrl = `${boardUrl}/drill`;
  const post = (category, token = csrf, revision = savedBoard.revision) => fetch(drillUrl, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token, base_revision: String(revision), block_id: originalBoard.blocks[0].block_id, category }) });
  const beforeFocus = dataWork.session(work.session_id).revision;
  assert.ok((await post('North', csrf, savedBoard.revision - 1)).status >= 400);
  assert.equal(dataWork.session(work.session_id).revision, beforeFocus);
  assert.ok((await post('Not a saved category')).status >= 400);
  assert.equal(dataWork.session(work.session_id).revision, beforeFocus);
  const focusedResponse = await post('North');
  assert.equal(focusedResponse.status, 303);
  const detailsUrl = new URL(focusedResponse.headers.get('location'), server.workspace_url).href;
  assert.match(detailsUrl, /\/details\?/u);
  const northHtmlResponse = await fetch(detailsUrl); const northHtml = await northHtmlResponse.text();
  assert.equal(northHtmlResponse.status, 200);
  assert.match(northHtml, /North/u); assert.match(northHtml, /Return to Board/u);
  assert.match(northHtml, new RegExp(`href="/projects/${project.project_id}/boards/${board.board_id}"`, 'u'));
  const north = dataWork.session(work.session_id);
  assert.equal(north.revision, beforeFocus + 1);
  assert.equal(north.preview.aggregation.grand_total, 10);
  const repeated = await post('North');
  assert.equal(repeated.status, 303);
  assert.equal(dataWork.session(work.session_id).revision, north.revision);
  const southResponse = await post('South');
  assert.equal(southResponse.status, 303);
  const southHtml = await (await fetch(new URL(southResponse.headers.get('location'), server.workspace_url))).text();
  assert.match(southHtml, /South/u); assert.doesNotMatch(southHtml, /<td>North<\/td>/u);
  assert.equal(dataWork.session(work.session_id).preview.aggregation.grand_total, 5);
  const revisionBeforeBadCsrf = dataWork.session(work.session_id).revision;
  assert.equal((await post('North', 'invalid')).status, 403);
  assert.equal(dataWork.session(work.session_id).revision, revisionBeforeBadCsrf);
  const finalBoard = boardService.showBoard(project.project_id, board.board_id);
  assert.equal(finalBoard.revision, savedBoard.revision);
  assert.equal(finalBoard.blocks[0].dashboard_projection.grand_total, 15);
  assert.equal(saveService.show(saved.save_id).status, 'executed');
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);

  const availability = createModuleAvailabilityService({ stateDir });
  availability.change({ moduleId: 'atlas.table-work', enabled: false, expectedRevision: 0, requestKey: 'disable-drilldown-test', reason: 'Verify disabled Module gate.' });
  const beforeDisabled = dataWork.session(work.session_id).revision;
  assert.ok((await post('North')).status >= 400);
  assert.equal(dataWork.session(work.session_id).revision, beforeDisabled);
  availability.change({ moduleId: 'atlas.table-work', enabled: true, expectedRevision: 1, requestKey: 'enable-drilldown-test', reason: 'Restore fixture Module state.' });
  fs.writeFileSync(sourcePath, `${original}West,3\n`, 'utf8');
  const beforeStaleSource = dataWork.session(work.session_id).revision;
  assert.ok((await post('North')).status >= 400);
  assert.equal(dataWork.session(work.session_id).revision, beforeStaleSource);
});
