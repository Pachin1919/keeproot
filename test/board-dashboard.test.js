import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BoardService } from '../src/board-service.js';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';
import { renderBoardView } from '../src/ui/views/board-view.js';

test('Board projects saved group, pivot, and trend Results into one complete revision-bound Dashboard', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/board-dashboard-'));
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'Transit');
  fs.mkdirSync(path.join(projectRoot, 'Data'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Results'), { recursive: true });
  const sourcePath = path.join(projectRoot, 'Data', 'base.csv');
  fs.writeFileSync(sourcePath, 'record\nsource\n');
  const stateDir = path.join(root, 'state');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Transit', currentPath: 'Transit' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Transit', reason: 'Dashboard fixture.' });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const source = resourceControl.identify({ filePath: sourcePath, project: { id: project.project_id } });
  const fingerprint = { file_path: sourcePath, sha256: (await import('../src/content-inspection.js')).contentFileFingerprint(sourcePath).sha256 };
  const saveService = new SaveService({ stateDir, resourceControl });
  const boardService = new BoardService({ stateDir, registry, resourceControl, saveService, projectRoot: workspace });
  t.after(() => {
    saveService.dispose(); resourceControl.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const sourceSet = [{ source_key: 'fixture-source', resource_id: source.resource_id, path: sourcePath, fingerprint, version_policy: 'follow_latest' }];
  const cases = [
    {
      key: 'group', target: 'group.csv', csv: 'district,amount\nNorth,312.5\nSouth,145\nEast,52.5\n',
      recipe: { version: 1, combine: { operation: 'concatenate' }, steps: [{ operation: 'group-aggregate', dimension: 'district', measure: 'amount', formula: 'sum', unit: 'rides', null_policy: 'exclude' }] },
      summary: { rows: 3, columns: 2, validation: { input_rows: 62, output_rows: 3 } },
    },
    {
      key: 'pivot', target: 'pivot.csv',
      csv: 'row:district,column:1:January,column:2:February,total:amount,share_percent,dense_rank\nNorth,300,100,400,85.11,1\nSouth,70,0,70,14.89,2\n__TOTAL__,370,100,470,100,\n',
      recipe: { version: 1, combine: { operation: 'concatenate' }, steps: [{ operation: 'pivot-aggregate', row_dimension: 'district', column_dimension: 'month', measure: 'amount', formula: 'sum', unit: 'rides', null_policy: 'exclude' }] },
      summary: { rows: 3, columns: 6, validation: { input_rows: 62, output_rows: 3 } },
    },
    {
      key: 'trend', target: 'trend.csv',
      csv: 'month,sum:amount\n2026-01,200\n2026-02,300\n2026-03,250\n2026-04,300\n',
      recipe: { version: 1, combine: { operation: 'concatenate' }, steps: [{ operation: 'trend-aggregate', date_field: 'service_date', measure: 'amount', formula: 'sum', start_month: '2026-01', current_start_month: '2026-03', end_month: '2026-04', unit: 'rides', null_policy: 'exclude' }] },
      summary: { rows: 4, columns: 2, validation: { input_rows: 73, output_rows: 4 } },
    },
  ];
  const saves = [];
  for (const item of cases) {
    const candidate = path.join(stateDir, `${item.key}-candidate.csv`);
    fs.writeFileSync(candidate, item.csv);
    const prepared = saveService.prepare({
      root: workspace, candidateFile: candidate, projectId: project.project_id, target: `Transit/Results/${item.target}`,
      inputs: [sourcePath], origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: `dashboard-${item.key}`,
      caller: { actor: 'agent', tool: 'dashboard-fixture', client_run_id: `dashboard-${item.key}` },
      source: { path: sourcePath, fingerprint, resource_id: source.resource_id, sources: sourceSet, recipe: item.recipe },
      parameters: { work_session_id: `WORK-dashboard-${item.key}`, recipe_version: 1, table_work_save: { identity: { project_id: project.project_id, work_session_id: `WORK-dashboard-${item.key}` } } },
      resultSummary: item.summary, intent: `Save ${item.key} Table Work result.`,
    });
    saves.push(saveService.execute(prepared.save_id, { reason: `Confirmed ${item.key} result.` }));
  }

  const board = boardService.createBoard({ projectId: project.project_id, title: 'Transit dashboard' });
  const savedBoard = boardService.saveBoard({ projectId: project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [
    { type: 'text', text: 'Monthly and district totals for the selected period.' },
    ...saves.map((save) => ({ type: 'result_preview', save_id: save.save_id, version_policy: 'pinned_version' })),
  ] });
  const shown = boardService.showBoard(project.project_id, board.board_id);
  const projections = shown.blocks.filter((block) => block.type === 'result_preview').map((block) => block.dashboard_projection);
  assert.equal(projections.length, 3);
  assert.deepEqual(projections.map((projection) => projection?.kind), ['table_work_group_sum', 'table_work_pivot_sum', 'table_work_trend_sum']);
  assert.equal(projections[0].grand_total, 510);
  assert.equal(projections[1].grand_total, 470);
  assert.equal(projections[1].matrix.find((row) => row.row === 'North').share_percent, 85.11);
  assert.equal(projections[1].matrix.find((row) => row.row === 'South').rank, 2);
  assert.equal(projections[2].previous_period.total, 500);
  assert.equal(projections[2].current_period.total, 550);
  assert.equal(projections[2].delta, 50);
  assert.equal(projections[2].growth_percent, 10);
  const html = renderBoardView({ mode: 'detail', base: `/projects/${project.project_id}`, project: { id: project.project_id, name: 'Transit' }, board: shown, resources: [], results: [], folders: [{ relative_path: 'Results' }] }, { locale: 'en' });
  assert.match(html, /Grand total: 470 rides/u);
  assert.doesNotMatch(html, /<th scope="row">__TOTAL__<\/th>/u);
  for (const value of ['510', '470', '400', '70', '85.11%', '2026-01', '2026-04', '550', '50', '10%']) assert.ok(html.includes(value), `Board HTML must contain ${value}.`);
  const preparedHtml = await boardService.preparePortableDelivery({ projectId: project.project_id, boardId: board.board_id, baseRevision: savedBoard.revision, target: 'Results/dashboard.html', caller: { actor: 'agent', tool: 'dashboard-fixture', client_run_id: 'dashboard-html' }, requestKey: 'dashboard-html' });
  const htmlSnapshot = fs.readFileSync(saveService.candidateSnapshot(preparedHtml.save_id).path, 'utf8');
  for (const value of ['510', '470', '400', '70', '85.11', '2026-01', '2026-04', '550', '50', '10', ...saves.map((save) => save.save_id), source.resource_id]) assert.ok(htmlSnapshot.includes(value), `HTML snapshot must contain ${value}.`);
  const preparedMd = await boardService.preparePortableDelivery({ projectId: project.project_id, boardId: board.board_id, baseRevision: savedBoard.revision, target: 'Results/dashboard.md', caller: { actor: 'agent', tool: 'dashboard-fixture', client_run_id: 'dashboard-md' }, requestKey: 'dashboard-md' });
  const mdSnapshot = fs.readFileSync(saveService.candidateSnapshot(preparedMd.save_id).path, 'utf8');
  for (const value of ['510', '470', '400', '70', '85.11', '2026-01', '2026-04', '550', '50', '10', ...saves.map((save) => save.save_id), source.resource_id]) assert.ok(mdSnapshot.includes(value), `Markdown snapshot must contain ${value}.`);
  assert.equal(preparedHtml.board_revision, savedBoard.revision);
  assert.equal(preparedMd.board_revision, savedBoard.revision);

  // Opposing signed cells can produce a valid zero-total Matrix. Its shares are undefined.
  const zeroCandidate = path.join(stateDir, 'zero-pivot-candidate.csv');
  fs.writeFileSync(zeroCandidate, 'row:district,column:1:January,column:2:February,total:amount,share_percent,dense_rank\nNorth,10,-10,0,,1\nSouth,-10,10,0,,1\n__TOTAL__,0,0,0,,\n');
  const zeroPrepared = saveService.prepare({
    root: workspace, candidateFile: zeroCandidate, projectId: project.project_id, target: 'Transit/Results/zero-pivot.csv',
    inputs: [sourcePath], origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'dashboard-zero-pivot',
    caller: { actor: 'agent', tool: 'dashboard-fixture', client_run_id: 'dashboard-zero-pivot' },
    source: { path: sourcePath, fingerprint, resource_id: source.resource_id, sources: sourceSet, recipe: cases[1].recipe },
    parameters: { work_session_id: 'WORK-dashboard-zero-pivot', recipe_version: 1, table_work_save: { identity: { project_id: project.project_id, work_session_id: 'WORK-dashboard-zero-pivot' } } },
    resultSummary: { rows: 3, columns: 6, validation: { input_rows: 4, output_rows: 3 } }, intent: 'Save signed zero-total pivot.',
  });
  const zeroSaved = saveService.execute(zeroPrepared.save_id, { reason: 'Confirmed zero-total Matrix.' });
  const zeroBoard = boardService.createBoard({ projectId: project.project_id, title: 'Zero total' });
  boardService.saveBoard({ projectId: project.project_id, boardId: zeroBoard.board_id, title: zeroBoard.title, baseRevision: zeroBoard.revision,
    blocks: [{ type: 'result_preview', save_id: zeroSaved.save_id, version_policy: 'pinned_version' }] });
  const zeroProjection = boardService.showBoard(project.project_id, zeroBoard.board_id).blocks[0].dashboard_projection;
  assert.equal(zeroProjection?.kind, 'table_work_pivot_sum');
  assert.equal(zeroProjection?.complete, true);
  assert.equal(zeroProjection?.grand_total, 0);
  assert.deepEqual(zeroProjection?.matrix?.map((row) => row.share_percent), [null, null, null]);

  const signedCandidate = path.join(stateDir, 'signed-group-candidate.csv');
  fs.writeFileSync(signedCandidate, 'district,amount\nNorth,10\nReturns,-4\n');
  const signedPrepared = saveService.prepare({
    root: workspace, candidateFile: signedCandidate, projectId: project.project_id, target: 'Transit/Results/signed-group.csv',
    inputs: [sourcePath], origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'dashboard-signed-group',
    caller: { actor: 'agent', tool: 'dashboard-fixture', client_run_id: 'dashboard-signed-group' },
    source: { path: sourcePath, fingerprint, resource_id: source.resource_id, sources: sourceSet, recipe: cases[0].recipe },
    parameters: { work_session_id: 'WORK-dashboard-signed-group', recipe_version: 1, table_work_save: { identity: { project_id: project.project_id, work_session_id: 'WORK-dashboard-signed-group' } } },
    resultSummary: { rows: 2, columns: 2, validation: { input_rows: 2, output_rows: 2 } }, intent: 'Save signed group.',
  });
  const signedSaved = saveService.execute(signedPrepared.save_id, { reason: 'Confirmed signed group.' });
  const signedBoard = boardService.createBoard({ projectId: project.project_id, title: 'Signed group' });
  const signedBoardSaved = boardService.saveBoard({ projectId: project.project_id, boardId: signedBoard.board_id, title: signedBoard.title, baseRevision: signedBoard.revision,
    blocks: [{ type: 'result_preview', save_id: signedSaved.save_id, version_policy: 'pinned_version' }] });
  const signedShown = boardService.showBoard(project.project_id, signedBoard.board_id);
  assert.equal(signedShown.blocks[0].dashboard_projection?.grand_total, 6);
  const signedPage = renderBoardView({ mode: 'detail', base: `/projects/${project.project_id}`, project: { id: project.project_id, name: 'Transit' }, board: signedShown, resources: [], results: [], folders: [{ relative_path: 'Results' }] }, { locale: 'en' });
  assert.match(signedPage, /data-sign="negative"/u);
  const signedDelivery = await boardService.preparePortableDelivery({ projectId: project.project_id, boardId: signedBoard.board_id, baseRevision: signedBoardSaved.revision,
    target: 'Results/signed-dashboard.html', caller: { actor: 'agent', tool: 'dashboard-fixture', client_run_id: 'dashboard-signed-html' }, requestKey: 'dashboard-signed-html' });
  assert.match(fs.readFileSync(saveService.candidateSnapshot(signedDelivery.save_id).path, 'utf8'), /data-sign="negative"/u);

  fs.appendFileSync(sourcePath, 'later\n');
  const staleBlocks = boardService.showBoard(project.project_id, board.board_id).blocks.filter((block) => block.type === 'result_preview');
  assert.equal(staleBlocks.length, 3);
  assert.ok(staleBlocks.every((block) => block.status === 'needs_review' && !block.dashboard_projection));
  await assert.rejects(boardService.preparePortableDelivery({ projectId: project.project_id, boardId: board.board_id, baseRevision: savedBoard.revision,
    target: 'Results/stale-dashboard.md', caller: { actor: 'agent', tool: 'dashboard-fixture', client_run_id: 'dashboard-stale-md' }, requestKey: 'dashboard-stale-md' }), { code: 'ATLAS_STATE_CONFLICT' });
  await assert.rejects(Promise.resolve().then(() => saveService.execute(preparedHtml.save_id, { reason: 'Must reject changed source.', expectedPreviewRevision: saveService.review(preparedHtml.save_id).preview_revision })), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(fs.existsSync(path.join(projectRoot, 'Results', 'dashboard.html')), false);
});
