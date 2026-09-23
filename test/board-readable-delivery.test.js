import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';
import { createBoardService } from '../src/board-service.js';
import { renderBoardView } from '../src/ui/views/board-view.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(path.resolve('test', '.tmp'), 'board-readable-delivery-'));
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'Project');
  const dataRoot = path.join(projectRoot, 'Data');
  const resultRoot = path.join(projectRoot, 'Results');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(resultRoot, { recursive: true });
  const imagePath = path.join(dataRoot, 'diagram.png');
  const textPath = path.join(dataRoot, 'notes.txt');
  const tablePath = path.join(dataRoot, 'table.csv');
  fs.writeFileSync(imagePath, Buffer.from('fake-png-content'));
  fs.writeFileSync(textPath, 'A bounded research note.\n');
  fs.writeFileSync(tablePath, 'name,value\nA,1\n');
  const stateDir = path.join(root, 'state');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Project', currentPath: 'Project' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Project', reason: 'Readable Board fixture.' });
  const resourceControl = createResourceControl({ stateDir, ledger: registry.ledger });
  const image = resourceControl.identify({ filePath: imagePath, project: { id: project.project_id } });
  const text = resourceControl.identify({ filePath: textPath, project: { id: project.project_id } });
  const table = resourceControl.identify({ filePath: tablePath, project: { id: project.project_id } });
  const saveService = new SaveService({ stateDir, resourceControl });
  const candidate = path.join(stateDir, 'candidate.csv');
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, 'name,value\nA,1\n');
  const prepared = saveService.prepare({
    root: workspace, candidateFile: candidate, projectId: project.project_id,
    target: 'Project/Results/table-result.csv', inputs: [tablePath], origin: 'agent_generated',
    kind: 'intermediate', channel: 'host', requestKey: 'board-readable-result',
    caller: { actor: 'agent', tool: 'board-readable-test', client_run_id: 'board-readable-result' },
    source: { path: tablePath, resource_id: table.resource_id, sources: [{ path: tablePath, resource_id: table.resource_id }] },
    parameters: { fixture: 'board-readable' }, resultSummary: { rows: 1, columns: 2 }, intent: 'Readable Board result.'
  });
  const savedResult = saveService.execute(prepared.save_id, { reason: 'Readable Board fixture.' });
  const makeService = () => createBoardService({ stateDir, registry, resourceControl, saveService });
  t.after(() => { saveService.dispose(); resourceControl.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { root, workspace, project, image, text, table, imagePath, textPath, tablePath, saveService, savedResult, makeService };
}

test('R3 Board show exposes bounded readable previews for image, text, and table Result blocks', (t) => {
  const f = fixture(t); const service = f.makeService();
  const board = service.createBoard({ projectId: f.project.project_id, title: 'Readable board' });
  const saved = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [
    { type: 'material_reference', resource_id: f.image.resource_id, version_policy: 'follow_latest' },
    { type: 'material_reference', resource_id: f.text.resource_id, version_policy: 'follow_latest' },
    { type: 'result_preview', save_id: f.savedResult.save_id, version_policy: 'pinned_version' },
  ] });
  const shown = service.showBoard(f.project.project_id, saved.board_id);
  assert.deepEqual(shown.blocks.map((block) => block.preview?.kind), ['image', 'text', 'table']);
  assert.ok(shown.blocks.every((block) => block.preview?.content && String(block.preview.content).length <= 64_000));
  assert.ok(shown.blocks.every((block) => !block.preview?.path), 'preview must contain bounded content, not path metadata');
});

test('R3 Board edit reuses block ids and preserves pinned recorded hashes in one revision save', (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: 'Editable board' });
  const first = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [
    { type: 'text', text: 'Before' }, { type: 'material_reference', resource_id: f.image.resource_id, version_policy: 'pinned_version' },
  ] });
  const originalHash = first.blocks[1].recorded_sha256;
  const edited = service.saveBoard({ projectId: f.project.project_id, boardId: first.board_id, title: first.title, baseRevision: first.revision, blocks: [
    { ...first.blocks[1], ordinal: 0 }, { ...first.blocks[0], text: 'After', ordinal: 1 },
  ] });
  assert.equal(edited.revision, first.revision + 1);
  assert.deepEqual(edited.blocks.map((block) => block.block_id), [first.blocks[1].block_id, first.blocks[0].block_id]);
  assert.deepEqual(edited.blocks.map((block) => block.ordinal), [0, 1]);
  assert.equal(edited.blocks[0].recorded_sha256, originalHash);
});

test('R3 Resource context lists direct Materials, Result Resources, and Sources used by Board Results', (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: 'Back link board' });
  service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [
    { type: 'material_reference', resource_id: f.text.resource_id, version_policy: 'follow_latest' },
    { type: 'result_preview', save_id: f.savedResult.save_id, version_policy: 'pinned_version' },
  ] });
  const materialReferences = service.listResourceReferences(f.project.project_id, f.text.resource_id);
  const resultReferences = service.listResourceReferences(f.project.project_id, f.savedResult.resource_id);
  const sourceReferences = service.listResourceReferences(f.project.project_id, f.table.resource_id);
  assert.ok(materialReferences.some((item) => item.board_id === board.board_id && item.relation === 'material_reference'));
  assert.ok(resultReferences.some((item) => item.board_id === board.board_id && item.relation === 'result_preview'));
  assert.ok(sourceReferences.some((item) => item.board_id === board.board_id && item.relation === 'source_of_result_preview'));
});

test('R3 exact-version change removes stale preview and reports portable delivery issue', async (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: 'Pinned delivery' });
  const saved = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [{ type: 'material_reference', resource_id: f.text.resource_id, version_policy: 'pinned_version' }] });
  fs.appendFileSync(f.textPath, 'Changed current content.\n');
  const shown = service.showBoard(f.project.project_id, saved.board_id);
  const material = shown.blocks[0];
  assert.notEqual(material.preview?.content, 'Changed current content.\n');
  await assert.rejects(service.preparePortableDelivery({ projectId: f.project.project_id, boardId: saved.board_id, baseRevision: saved.revision, target: 'Results/pinned.html', caller: { actor: 'agent', tool: 'board-readable-test', client_run_id: 'pinned-delivery' }, requestKey: 'pinned-delivery' }), (error) => /missing|changed|recorded|available|fresh/iu.test(error.message) || Array.isArray(error.issues));
});

test('R3 portable CSV Result embeds a bounded table and excludes a mismatched pinned version', async (t) => {
  const f = fixture(t); const service = f.makeService(); const board = service.createBoard({ projectId: f.project.project_id, title: 'Table delivery' });
  const saved = service.saveBoard({ projectId: f.project.project_id, boardId: board.board_id, title: board.title, baseRevision: board.revision, blocks: [{ type: 'result_preview', save_id: f.savedResult.save_id, version_policy: 'pinned_version' }] });
  const prepared = await service.preparePortableDelivery({ projectId: f.project.project_id, boardId: saved.board_id, baseRevision: saved.revision, target: 'Results/table.html', caller: { actor: 'agent', tool: 'board-readable-test', client_run_id: 'table-delivery' }, requestKey: 'table-delivery' });
  const html = fs.readFileSync(f.saveService.candidateSnapshot(prepared.save_id).path, 'utf8');
  assert.match(html, /<table[\s>]/iu);
  assert.match(html, /name/iu);
  assert.match(html, />A</iu);
  const resultPath = path.join(f.workspace, 'Project', 'Results', 'table-result.csv');
  fs.appendFileSync(resultPath, 'NEW-CURRENT,99\n');
  const changed = await service.preparePortableDelivery({ projectId: f.project.project_id, boardId: saved.board_id, baseRevision: saved.revision, target: 'Results/table-changed.html', caller: { actor: 'agent', tool: 'board-readable-test', client_run_id: 'table-changed' }, requestKey: 'table-changed' }).catch((error) => error);
  assert.ok(changed instanceof Error || changed.issues?.length, 'mismatched version must be rejected or reported in issues');
  if (!(changed instanceof Error)) assert.ok(changed.issues.some((item) => /not included|changed|recorded|missing/iu.test(item)));
});

test('Board detail uses dedicated readable forms for each Block type and portable delivery', () => {
  const html = renderBoardView({ mode: 'detail', base: '/projects/PRJ-board-layout', project: { id: 'PRJ-board-layout', name: 'Board Layout' }, board: { board_id: 'BRD-board-layout', revision: 4, title: 'Layout Board', freshness: { status: 'fresh' }, blocks: [{ block_id: 'BLK-text', type: 'text', text: 'A readable note.' }] }, resources: [{ resource_id: 'RES-layout', resource: { display_name: 'Material' } }], results: [{ save_id: 'SAV-layout', name: 'Result' }], folders: [{ relative_path: 'Results' }] }, { csrfToken: 'csrf-board-layout' });
  assert.match(html, /href="#portable-delivery">Prepare Delivery<\/a>/u); assert.match(html, /id="portable-delivery"/u); assert.match(html, /class="surface board-add-blocks"/u); assert.match(html, /class="board-block-form board-text-block-form"/u); assert.match(html, /Text block/u); assert.match(html, /Material reference/u); assert.match(html, /Result preview/u); assert.match(html, /class="surface board-portable-delivery"/u); assert.match(html, /class="board-delivery-form"/u); assert.match(html, /<details class="board-text-editor"><summary>Edit text<\/summary>/u); assert.match(html, /<details class="board-block-actions"><summary>Block actions<\/summary>/u);
});
