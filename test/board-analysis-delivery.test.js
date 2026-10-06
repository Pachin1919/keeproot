import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BoardService } from '../src/board-service.js';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';
import { contentFileFingerprint } from '../src/content-inspection.js';
import { renderBoardView } from '../src/ui/views/board-view.js';
import { renderSaveResultView } from '../src/ui/views/save-result-view.js';

test('Board projects a verified Table Work aggregate into full HTML and Markdown delivery snapshots', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/board-analysis-delivery-'));
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'Traffic');
  fs.mkdirSync(path.join(projectRoot, 'Data'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Results'), { recursive: true });
  const sourcePath = path.join(projectRoot, 'Data', 'volume.csv');
  const resultPath = path.join(projectRoot, 'Results', 'district-sums.csv');
  fs.writeFileSync(sourcePath, 'district,amount\nNorth,12.5\nSouth,7.25\nEast,4\n');
  const resultCsv = 'district,amount\nNorth,312.5\nSouth,145\nEast,60\n';
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'candidates'), { recursive: true });
  const candidate = path.join(stateDir, 'candidates', 'district-sums.csv');
  fs.writeFileSync(candidate, resultCsv);
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Traffic', currentPath: 'Traffic' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Traffic', reason: 'Board analysis fixture.' });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const source = resourceControl.identify({ filePath: sourcePath, project: { id: project.project_id } });
  const sourceFingerprint = contentFileFingerprint(sourcePath);
  const saveService = new SaveService({ stateDir, resourceControl });
  const recipe = { version: 1, steps: [{ operation: 'group-aggregate', dimension: 'district', measure: 'amount', formula: 'sum', unit: 'vehicles', null_policy: 'exclude' }] };
  const prepared = saveService.prepare({
    root: workspace, candidateFile: candidate, projectId: project.project_id, target: 'Traffic/Results/district-sums.csv',
    inputs: [sourcePath], origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'board-analysis-result',
    caller: { actor: 'agent', tool: 'table-work-fixture', client_run_id: 'board-analysis-result' },
    source: { path: sourcePath, fingerprint: sourceFingerprint, resource_id: source.resource_id, sources: [{ path: sourcePath, resource_id: source.resource_id, fingerprint: sourceFingerprint }], recipe },
    parameters: { work_session_id: 'WORK-board-analysis-fixture', recipe_version: 1, table_work_save: { identity: { project_id: project.project_id, work_session_id: 'WORK-board-analysis-fixture' } } },
    resultSummary: { rows: 3, columns: 2, validation: { input_rows: 62, output_rows: 3 } }, intent: 'Save the grouped district result.',
  });
  const result = saveService.execute(prepared.save_id, { reason: 'Fixture participant confirmed the grouped result.' });
  const service = new BoardService({ stateDir, registry, resourceControl, saveService, projectRoot: workspace });
  t.after(() => {
    saveService.dispose(); resourceControl.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const board = service.createBoard({ projectId: project.project_id, title: 'District totals' });
  const savedBoard = service.saveBoard({ projectId: project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [
    { type: 'text', text: 'North leads the current period.' },
    { type: 'result_preview', save_id: result.save_id, version_policy: 'pinned_version' },
  ] });
  const shown = service.showBoard(project.project_id, board.board_id);
  const resultBlock = shown.blocks.find((block) => block.type === 'result_preview');
  assert.deepEqual(resultBlock.analysis_projection?.groups?.map(({ value, sum }) => ({ value, sum })), [
    { value: 'North', sum: 312.5 }, { value: 'South', sum: 145 }, { value: 'East', sum: 60 },
  ]);
  assert.equal(resultBlock.analysis_projection.grand_total, 517.5);
  assert.equal(resultBlock.analysis_projection.unit, 'vehicles');
  assert.equal(resultBlock.analysis_projection.null_policy, 'exclude');
  const html = renderBoardView({ mode: 'detail', base: `/projects/${project.project_id}`, project: { id: project.project_id, name: 'Traffic' }, board: shown, resources: [], results: [], folders: [{ relative_path: 'Results' }] }, { locale: 'en' });
  assert.match(html, /North leads the current period/u);
  assert.match(html, /517\.5/u);
  assert.match(html, /312\.5/u);
  assert.match(html, /145/u);
  assert.match(html, /60/u);
  const preparedHtml = await service.preparePortableDelivery({ projectId: project.project_id, boardId: board.board_id, baseRevision: savedBoard.revision, target: 'Results/district-report.html', caller: { actor: 'agent', tool: 'fixture-writer', client_run_id: 'board-html' }, requestKey: 'board-html' });
  const htmlSnapshot = fs.readFileSync(saveService.candidateSnapshot(preparedHtml.save_id).path, 'utf8');
  assert.match(htmlSnapshot, /snapshot revision 2/u);
  for (const value of ['North', '312.5', 'South', '145', 'East', '60', '517.5', 'vehicles', 'exclude', result.save_id, source.resource_id]) assert.ok(htmlSnapshot.includes(value), `HTML snapshot must retain ${value}.`);
  const preparedMd = await service.preparePortableDelivery({ projectId: project.project_id, boardId: board.board_id, baseRevision: savedBoard.revision, target: 'Results/district-report.md', caller: { actor: 'agent', tool: 'fixture-writer', client_run_id: 'board-md' }, requestKey: 'board-md' });
  const mdSnapshot = fs.readFileSync(saveService.candidateSnapshot(preparedMd.save_id).path, 'utf8');
  assert.match(mdSnapshot, /Board snapshot · revision 2/u);
  for (const value of ['North', '312.5', 'South', '145', 'East', '60', '517.5', 'vehicles', 'exclude', result.save_id, source.resource_id]) assert.ok(mdSnapshot.includes(value), `Markdown snapshot must retain ${value}.`);
  const candidateHashes = [preparedHtml, preparedMd].map((delivery) => saveService.candidateSnapshot(delivery.save_id).sha256);
  const current = service.showBoard(project.project_id, board.board_id);
  const changedBoard = service.saveBoard({ projectId: project.project_id, boardId: board.board_id, title: current.title, baseRevision: current.revision, blocks: current.blocks.map((block) => block.type === 'text' ? { ...block, text: 'Updated after preparing revision two.' } : block) });
  assert.equal(changedBoard.revision, 3);
  for (const [index, delivery] of [preparedHtml, preparedMd].entries()) {
    assert.equal(saveService.candidateSnapshot(delivery.save_id).sha256, candidateHashes[index], 'Board edits must not rewrite an already prepared snapshot.');
    const reviewed = saveService.review(delivery.save_id);
    const receipt = saveService.execute(delivery.save_id, { reason: 'Fixture participant confirmed this Board snapshot.', expectedPreviewRevision: reviewed.preview_revision });
    assert.equal(receipt.status, 'executed');
    assert.equal(receipt.source.board_revision, 2);
    const reviewHtml = renderSaveResultView({ ...saveService.review(delivery.save_id), board_delivery: { board_id: board.board_id, snapshot_revision: 2, current_revision: changedBoard.revision } }, { locale: 'en' });
    assert.match(reviewHtml, /revision 2[\s\S]*revision 3/u);
  }
  const writerCandidate = path.join(root, 'external-tool-candidate.md');
  fs.writeFileSync(writerCandidate, `# Written from Board revision 2\n\n${mdSnapshot}\nExternal writing tool draft.\n`, 'utf8');
  const writerSave = saveService.prepare({ root: workspace, candidateFile: writerCandidate, projectId: project.project_id,
    target: 'Traffic/Results/external-summary.md', inputs: [resultPath], origin: 'agent_generated', kind: 'report', channel: 'host',
    requestKey: 'external-board-summary', caller: { actor: 'agent', tool: 'external-writer-fixture', client_run_id: 'external-board-summary' },
    source: { kind: 'external_writing_tool', board_id: board.board_id, board_revision: 2, save_id: result.save_id, sources: [{ path: resultPath, resource_id: result.resource_id }] },
    parameters: { board_id: board.board_id, board_revision: 2 }, intent: 'Save external writing tool output based on the Board snapshot.' });
  const writerReceipt = saveService.execute(writerSave.save_id, { reason: 'Fixture participant reviewed the external writing result.' });
  assert.equal(writerReceipt.status, 'executed');
  const latest = service.showBoard(project.project_id, board.board_id);
  const returned = service.saveBoard({ projectId: project.project_id, boardId: board.board_id, title: latest.title, baseRevision: latest.revision,
    blocks: [...latest.blocks.map((block) => block.type === 'text' ? { ...block, text: 'Updated after preparing revision two.' } : block), { type: 'result_preview', save_id: writerReceipt.save_id, version_policy: 'pinned_version' }] });
  const readback = service.showBoard(project.project_id, board.board_id);
  assert.equal(returned.revision, 4);
  assert.ok(readback.blocks.some((block) => block.type === 'result_preview' && block.save_id === writerReceipt.save_id));
  fs.writeFileSync(sourcePath, 'district,amount\nNorth,13\nSouth,7.25\nEast,4\n');
  const staleAnalysis = service.showBoard(project.project_id, board.board_id).blocks.find((block) => block.type === 'result_preview' && block.save_id === result.save_id);
  assert.equal(staleAnalysis.status, 'needs_review');
  await assert.rejects(service.preparePortableDelivery({ projectId: project.project_id, boardId: board.board_id, baseRevision: returned.revision, target: 'Results/stale-source.md', caller: { actor: 'agent', tool: 'fixture-writer', client_run_id: 'board-source-changed' }, requestKey: 'board-source-changed' }), (error) => error?.code === 'ATLAS_STATE_CONFLICT');
  assert.equal(fs.existsSync(path.join(projectRoot, 'Results', 'stale-source.md')), false);
});
