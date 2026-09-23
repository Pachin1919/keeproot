// Developer-only isolated UI fixture; never opens or edits a real user Project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const install = path.resolve(process.argv[2] ?? '');
const temp = path.join(repo, 'test/.tmp');
assert.ok(install.startsWith(`${temp}${path.sep}`));
for (let p = install; p !== repo; p = path.dirname(p)) assert.equal(fs.lstatSync(p).isSymbolicLink(), false);
const runtime = path.join(install, 'runtime'); const stateDir = path.join(install, 'state');
const load = (name) => import(pathToFileURL(path.join(runtime, 'src', name)));
const { Registry } = await load('registry.js');
const receiptPath = path.join(install, 'ui-review.json');
let receipt;
if (fs.existsSync(receiptPath)) receipt = JSON.parse(fs.readFileSync(receiptPath));
else {
  const fixture = fs.mkdtempSync(path.join(temp, 'workshop-ui-'));
  const workspace = path.join(fixture, 'workspace'); const projectRoot = path.join(workspace, 'Workshop');
  fs.mkdirSync(path.join(projectRoot, 'Results'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'budget.csv'), 'item,amount\nVenue,2400\nMaterials,860\nRefreshments,420\n');
  fs.writeFileSync(path.join(projectRoot, 'workshop-plan.md'), '# 春季工作坊\n\n目标：为 24 人安排半天手作活动。\n\n- 场地与物料预算分开核对\n- 交付活动方案和预算表\n\n这是隔离演示样例，不是真实用户项目。\n');
  const registry = new Registry({ stateDir });
  let projectId;
  try {
    const root = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
    projectId = registry.create({ name: '春季工作坊 · 预算与资料（演示）', currentPath: 'Workshop' }).project_id;
    registry.attachRoot(projectId, { rootId: root.root_id, relativePath: 'Workshop', reason: 'Isolated UI review' });
  } finally { registry.dispose(); }
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const caller = ['--actor', 'agent', '--tool', 'isolated-ui-fixture', '--client-run-id', path.basename(fixture)];
  function cli(args) {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& ${quote(path.join(install, 'atlas.cmd'))} ${[...args, '--json'].map(quote).join(' ')}`], { encoding: 'utf8', windowsHide: true });
    const result = JSON.parse(run.stdout.replace(/^\uFEFF/u, ''));
    assert.equal(result.ok, true, run.stdout + run.stderr); return result.data;
  }
  const request = (name, value) => { const file = path.join(fixture, `${name}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  let work = cli(['table-work', 'start', '--project', projectId, '--source', 'budget.csv', '--intent', '核对活动预算，生成可交付的预算表', ...caller]);
  work = cli(['table-work', 'prepare', work.session_id, '--base-revision', String(work.revision)]);
  assert.equal(work.sources[0].status, 'ready', work.sources[0].error_message);
  const mapping = work.sources[0].profile.profile.fields.map((field) => ({ source_key: work.sources[0].source_key, column: field.name, canonical: field.name }));
  work = cli(['table-work', 'align', work.session_id, '--base-revision', String(work.revision), '--request-file', request('mapping', { mapping })]);
  work = cli(['table-work', 'preview', work.session_id, '--base-revision', String(work.revision)]);
  const saved = cli(['table-work', 'save', work.session_id, '--base-revision', String(work.revision), '--folder', 'Results', '--file-name', 'workshop-budget.csv', '--format', 'csv', '--request-key', 'ui-budget', '--reason', 'Isolated UI review sample', ...caller]);
  const { createResourceControl } = await load('resource-control.js');
  const resources = createResourceControl({ stateDir });
  let planId;
  try { planId = resources.identify({ filePath: path.join(projectRoot, 'workshop-plan.md'), project: { id: projectId } }).resource_id; }
  finally { resources.dispose(); }
  let board = cli(['board', 'create', '--project', projectId, '--title', '工作坊交付概览']);
  board = cli(['board', 'save', board.board_id, '--project', projectId, '--base-revision', String(board.revision), '--request-file', request('board', {
    title: board.title, blocks: [{ type: 'text', text: '先看活动方案，再核对预算。预算结果已保存；这是隔离演示，不代表真实业务数据。' },
      { type: 'material_reference', resource_id: planId }, { type: 'result_preview', save_id: saved.work_id ?? saved.save_id, version_policy: 'pinned_version' }],
  })]);
  receipt = { fixture, projectRoot, project_id: projectId, work_id: work.session_id, resource_id: planId, board_id: board.board_id, save_id: saved.work_id ?? saved.save_id };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
}
const { Intake } = await load('intake.js');
const { startAtlasUiServer } = await load('ui-server.js');
const registry = new Registry({ stateDir }); const intake = new Intake({ stateDir });
if (!receipt.round_id) {
  const { createResourceControl } = await load('resource-control.js');
  const { SaveService } = await load('save-service.js');
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const saves = new SaveService({ stateDir, resourceControl: control });
  try {
    const work = registry.ledger.workSessions.byId(receipt.work_id);
    const saved = saves.show(receipt.save_id);
    const paths = ['workshop-plan.md', 'budget.csv', 'Results/workshop-budget.csv'];
    const data = { projectId: receipt.project_id, paths, resourceIds: [receipt.resource_id, ...work.sources.map((source) => source.resource_id), saved.resource_id], workIds: [receipt.work_id], saveIds: [receipt.save_id], boardIds: [receipt.board_id], label: '调整工作坊方案与预算', requestKey: 'ui-round-protect', caller: { actor: 'agent', tool: 'isolated-ui-fixture', client_run_id: path.basename(receipt.fixture) } };
    const requestPath = path.join(receipt.fixture, 'protect-round.json'); fs.writeFileSync(requestPath, JSON.stringify(data));
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& ${quote(path.join(install, 'atlas.cmd'))} round protect --request-file ${quote(requestPath)} --json`], { encoding: 'utf8', windowsHide: true });
    const response = JSON.parse(run.stdout.replace(/^\uFEFF/u, '')); assert.equal(response.ok, true, run.stdout + run.stderr);
    receipt.round_id = response.data.round_id;
    fs.appendFileSync(path.join(receipt.projectRoot, 'workshop-plan.md'), '\nHost 本轮试做：把活动调整为 32 人，预算待复核。\n');
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  } finally { saves.dispose(); control.dispose(); }
}
const server = await startAtlasUiServer({ stateDir, registry, intake, rules: {}, runtime: {}, projectRoot: runtime, installationRoot: install });
const base = server.workspace_url;
console.log(JSON.stringify({ home: `${base}projects/${receipt.project_id}`, resources: `${base}projects/${receipt.project_id}/resources`, work: `${base}work/${receipt.work_id}`, board: `${base}projects/${receipt.project_id}/boards/${receipt.board_id}`, result: `${base}saves/${receipt.save_id}`, round: `${base}projects/${receipt.project_id}/rounds/${receipt.round_id}`, settings: `${base}settings`, receipt: receiptPath }, null, 2));
process.on('SIGINT', async () => { await server.close(); intake.dispose(); registry.dispose(); process.exit(0); });
