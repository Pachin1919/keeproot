import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';

let boardModule = null;
let boardImportError = null;
try {
  boardModule = await import('../src/board-service.js');
} catch (error) {
  boardImportError = error;
}

function fixture(t) {
  const tempRoot = path.resolve('test', '.tmp'); fs.mkdirSync(tempRoot, { recursive: true }); const root = fs.mkdtempSync(path.join(tempRoot, 'atlas-board-delivery-'));
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'Project A'); const foreignRoot = path.join(workspace, 'Project B');
  fs.mkdirSync(path.join(projectRoot, 'Data'), { recursive: true }); fs.mkdirSync(path.join(projectRoot, 'Results'), { recursive: true }); fs.mkdirSync(path.join(foreignRoot, 'Data'), { recursive: true }); fs.mkdirSync(path.join(foreignRoot, 'Results'), { recursive: true });
  const source = path.join(projectRoot, 'Data', 'study.csv'); const foreignSource = path.join(foreignRoot, 'Data', 'other.csv'); fs.writeFileSync(source, 'name\nA\n'); fs.writeFileSync(foreignSource, 'name\nB\n');
  const stateDir = path.join(root, 'state'); const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Project A', currentPath: 'Project A' }); const foreignProject = registry.create({ name: 'Project B', currentPath: 'Project B' }); registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Project A', reason: 'Board delivery fixture.' }); registry.attachRoot(foreignProject.project_id, { rootId: adopted.root_id, relativePath: 'Project B', reason: 'Board delivery boundary fixture.' });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger }); const resource = resourceControl.identify({ filePath: source, project: { id: project.project_id } }); const foreignResource = resourceControl.identify({ filePath: foreignSource, project: { id: foreignProject.project_id } });
  const saveService = new SaveService({ stateDir, resourceControl }); fs.mkdirSync(path.join(stateDir, 'candidates'), { recursive: true });
  const createResult = ({ id, projectId, projectName, sourcePath, sourceResourceId, target }) => {
    const candidate = path.join(stateDir, 'candidates', `${id}.csv`); fs.writeFileSync(candidate, `name,value\n${id},1\n`);
    const prepared = saveService.prepare({ root: workspace, candidateFile: candidate, projectId, target, inputs: [sourcePath], origin: 'agent_generated', kind: 'intermediate', channel: 'host', requestKey: id, caller: caller(id), source: { path: sourcePath, resource_id: sourceResourceId, sources: [{ path: sourcePath, resource_id: sourceResourceId }] }, parameters: { fixture: id }, resultSummary: { rows: 1, columns: 2 }, intent: `Create ${projectName} result.` });
    return saveService.execute(prepared.save_id, { reason: 'Board test result.' });
  };
  const saveA = createResult({ id: 'project-a', projectId: project.project_id, projectName: 'Project A', sourcePath: source, sourceResourceId: resource.resource_id, target: 'Project A/Results/result-a.csv' });
  const saveB = createResult({ id: 'project-b', projectId: foreignProject.project_id, projectName: 'Project B', sourcePath: foreignSource, sourceResourceId: foreignResource.resource_id, target: 'Project B/Results/result-b.csv' });
  const makeService = () => {
    assert.ok(boardModule, `BoardService module must be available: ${boardImportError?.message ?? 'unknown import error'}`);
    const Factory = boardModule.createBoardService;
    return typeof Factory === 'function'
      ? Factory({ stateDir, registry, resourceControl, saveService, projectRoot: workspace })
      : new boardModule.BoardService({ stateDir, registry, resourceControl, saveService, projectRoot: workspace });
  };
  t.after(() => { saveService.dispose(); resourceControl.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, stateDir, registry, resourceControl, saveService, project, foreignProject, resource, foreignResource, saveA, saveB, makeService };
}

function caller(id) {
  return { actor: 'agent', tool: 'board-test', client_run_id: id };
}

test('V19-04 Board saves revision-bound material, text, and Result blocks with Project boundaries', (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: 'Study board' });
  const saved = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [
    { type: 'material_reference', resource_id: f.resource.resource_id, version_policy: 'follow_latest' },
    { type: 'text', text: 'Research conclusion.' },
    { type: 'result_preview', save_id: f.saveA.save_id, version_policy: 'pinned_version' },
  ] });
  assert.equal(saved.revision, board.revision + 1); assert.deepEqual(saved.blocks.map((item) => item.type), ['material_reference', 'text', 'result_preview']);
  assert.throws(() => service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: saved.blocks }), (error) => error?.code === 'ATLAS_STATE_CONFLICT');
  assert.throws(() => service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: saved.revision, blocks: [{ type: 'material_reference', resource_id: f.foreignResource.resource_id, version_policy: 'follow_latest' }] }), /Project|boundary|Resource/u);
  assert.throws(() => service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: saved.revision, blocks: [{ type: 'result_preview', save_id: f.saveB.save_id, version_policy: 'pinned_version' }] }), /Project|boundary|Save|Result/u);
});

test('V19-04 Board show returns Resource-precise Source and Result freshness projection', (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: 'Freshness board' }); const saved = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [{ type: 'material_reference', resource_id: f.resource.resource_id, version_policy: 'follow_latest' }, { type: 'result_preview', save_id: f.saveA.save_id, version_policy: 'pinned_version' }] });
  const shown = service.showBoard(f.project.project_id, saved.board_id); assert.equal(shown.blocks[0].resource_id, f.resource.resource_id); assert.ok(Array.isArray(shown.impact_lanes), 'Board show must expose Source to Work to Result lanes');
  const lane = shown.impact_lanes.find((item) => item.source.resource_id === f.resource.resource_id); assert.equal(lane.source.resource_id, f.resource.resource_id); assert.ok(['needs_review', 'contained', 'fresh', 'missing'].includes(lane.impact.status)); assert.ok(lane.results.every((item) => item.save_id));
  assert.equal(shown.impact_lanes.some((item) => item.source.resource_id === f.foreignResource.resource_id), false);
});

test('V19-04 Board portable delivery prepares self-contained HTML through SaveService', async (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: 'Portable board' }); const saved = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [{ type: 'text', text: 'Research conclusion.' }, { type: 'material_reference', resource_id: f.resource.resource_id, version_policy: 'pinned_version' }, { type: 'result_preview', save_id: f.saveA.save_id, version_policy: 'pinned_version' }] });
  const prepared = await service.preparePortableDelivery({ projectId: f.project.project_id, boardId: saved.board_id, baseRevision: saved.revision, target: 'Results/portable-board.html', caller: caller('v19-04-portable'), requestKey: 'v19-04-portable' });
  const candidate = f.saveService.candidateSnapshot(prepared.save_id); const html = fs.readFileSync(candidate.path, 'utf8'); assert.equal(prepared.status, 'prepared'); assert.equal(fs.existsSync(path.join(f.root, 'workspace', 'Project A', 'Results', 'portable-board.html')), false); assert.match(html, /Research conclusion/u); assert.match(html, /study.csv|material|result/u); assert.ok(prepared.save_id);
  await assert.rejects(service.preparePortableDelivery({ projectId: f.project.project_id, boardId: saved.board_id, baseRevision: board.revision, target: 'Results/stale.html', caller: caller('v19-04-stale'), requestKey: 'v19-04-stale' }), (error) => error?.code === 'ATLAS_STATE_CONFLICT');
});

test('V19-04 prepared portable delivery executes, verifies, and undoes through SaveService', async (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: 'Executable board' }); const saved = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [{ type: 'text', text: 'Executable text.' }, { type: 'material_reference', resource_id: f.resource.resource_id, version_policy: 'pinned_version' }, { type: 'result_preview', save_id: f.saveA.save_id, version_policy: 'pinned_version' }] });
  const prepared = await service.preparePortableDelivery({ projectId: f.project.project_id, boardId: saved.board_id, baseRevision: saved.revision, target: 'Results/executable-board.html', caller: caller('v19-04-execute'), requestKey: 'v19-04-execute' }); const saveId = prepared.save_id ?? prepared.prepared?.save_id; assert.ok(saveId);
  const executed = f.saveService.execute(saveId, { reason: 'User approved Board delivery.' }); const target = path.join(f.root, 'workspace', 'Project A', 'Results', 'executable-board.html'); assert.equal(executed.status, 'executed'); assert.equal(fs.existsSync(target), true); const html = fs.readFileSync(target, 'utf8'); assert.match(html, /Executable text/u); assert.match(html, /study\.csv|result-a\.csv|missing|dependency/u);
  const undone = f.saveService.undo(saveId); assert.equal(undone.status, 'undone'); assert.equal(fs.existsSync(target), false);
});

test('V19-04 portable delivery reports missing or oversized material and escapes HTML', async (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: '<Board & unsafe>' }); const saved = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [{ type: 'text', text: '<script>alert("x")</script>' }, { type: 'material_reference', resource_id: f.resource.resource_id, version_policy: 'follow_latest' }, { type: 'result_preview', save_id: f.saveA.save_id, version_policy: 'pinned_version' }] });
  const prepared = await service.preparePortableDelivery({ projectId: f.project.project_id, boardId: saved.board_id, baseRevision: saved.revision, target: 'Results/escaped-board.html', caller: caller('v19-04-escaped'), requestKey: 'v19-04-escaped' }); assert.equal(Object.hasOwn(prepared, 'candidate'), false); const html = fs.readFileSync(f.saveService.candidateSnapshot(prepared.save_id).path, 'utf8'); assert.match(html, /&lt;script&gt;|&amp;lt;/u); assert.doesNotMatch(html, /<script>alert/u);
  fs.rmSync(path.join(f.root, 'workspace', 'Project A', 'Data', 'study.csv')); const missingPrepared = await service.preparePortableDelivery({ projectId: f.project.project_id, boardId: saved.board_id, baseRevision: saved.revision, target: 'Results/missing-board.html', caller: caller('v19-04-missing'), requestKey: 'v19-04-missing' }); const missingHtml = fs.readFileSync(f.saveService.candidateSnapshot(missingPrepared.save_id).path, 'utf8'); assert.match(missingHtml, /Missing or not included|Not included|missing/iu); assert.match(missingHtml, /result-a\.csv|Selected Result/u);
  const fresh = fixture(t); const freshService = fresh.makeService(); const hugeBoard = freshService.createBoard({ projectId: fresh.project.project_id, title: 'Oversized board' }); assert.throws(() => freshService.saveBoard({ projectId: fresh.project.project_id, boardId: hugeBoard.board_id, title: hugeBoard.title, baseRevision: hugeBoard.revision, blocks: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }, { type: 'result_preview', save_id: fresh.saveA.save_id, version_policy: 'pinned_version' }] }), /too long|too large|limit/iu);
});

test('V19-04 pinned Material keeps recorded-version semantics after Resource baseline acceptance', async (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: 'Pinned baseline board' }); const saved = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [{ type: 'material_reference', resource_id: f.resource.resource_id, version_policy: 'pinned_version' }] }); const sourcePath = path.join(f.root, 'workspace', 'Project A', 'Data', 'study.csv'); fs.appendFileSync(sourcePath, 'CHANGED-V19-04\n'); const current = f.resourceControl.projectResource(f.project.project_id, f.resource.resource_id, { refresh: true }); f.resourceControl.acceptCurrentVersion({ projectId: f.project.project_id, resourceId: f.resource.resource_id, expectedCurrentVersion: current.external_change.current.sha256, caller: caller('v19-04-accept-baseline') });
  const shown = service.showBoard(f.project.project_id, saved.board_id); const material = shown.blocks.find((item) => item.type === 'material_reference'); assert.notEqual(material.status, 'fresh'); assert.match(material.reason, /recorded|version|changed|baseline/iu);
  await assert.rejects(service.preparePortableDelivery({ projectId: f.project.project_id, boardId: saved.board_id, baseRevision: saved.revision, target: 'Results/pinned-baseline.html', caller: caller('v19-04-pinned-export'), requestKey: 'v19-04-pinned-export' }), /fresh Material|missing|changed|recorded|available/iu);
});

test('V19-04 Board state survives service reopen after schema migration', (t) => {
  const f = fixture(t); const first = f.makeService(); const created = first.createBoard({ projectId: f.project.project_id, title: 'Persisted board' }); const second = f.makeService(); const boards = second.listBoards(f.project.project_id); assert.ok(boards.some((item) => item.board_id === created.board_id)); assert.equal(second.showBoard(f.project.project_id, created.board_id).title, 'Persisted board');
});
