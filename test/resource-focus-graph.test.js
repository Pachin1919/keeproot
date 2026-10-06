import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
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

test('Host and Resources render the same bounded Resource to Work to Result focus graph', async (t) => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/resource-focus-graph-'));
  const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'Transit');
  const sourcePath = path.join(projectRoot, 'Data', 'rides.csv');
  const relatedPath = path.join(projectRoot, 'Data', 'route-notes.md');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true }); fs.mkdirSync(path.join(projectRoot, 'Results'), { recursive: true });
  fs.writeFileSync(sourcePath, 'district,amount\nNorth,10\nSouth,5\n', 'utf8');
  fs.writeFileSync(relatedPath, 'Route notes for the same Project.', 'utf8');
  const stateDir = path.join(root, 'state'); const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: 'Transit', currentPath: 'Transit' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'Transit', reason: 'Focus graph fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  const source = control.identify({ filePath: sourcePath, project: { id: project.project_id, name: project.name } });
  const related = control.identify({ filePath: relatedPath, project: { id: project.project_id, name: project.name } });
  const candidate = { project_id: project.project_id, source_resource_id: source.resource_id, target: { kind: 'resource', id: related.resource_id }, type: 'linked_to', evidence: { reason: 'Same-route supporting note.' } };
  const edgePreview = control.previewLinkedResource({ operation: 'add', candidate, decisionChannel: 'host_command' });
  const relationship = control.submitLinkedResource({ operation: 'add', candidate, previewToken: edgePreview.preview_token, requestKey: 'focus-graph-link', caller: { tool: 'focus-graph-test', client_run_id: 'link-1' }, decisionChannel: 'host_command' }).relationship;

  const intake = new Intake({ stateDir }); const saveService = new SaveService({ stateDir, intake, resourceControl: control });
  const savedWork = createSavedWorkService({ stateDir, saveService });
  const dataWork = createDataWorkService({ stateDir, projectRoot: root, installationRoot: root, resourceControl: control,
    fingerprintFn: async (filePath) => contentFileFingerprint(filePath), runDataWorkFn: runDataWork });
  const resolveProject = (projectId) => {
    const item = registry.list().find((entry) => entry.id === projectId && entry.status === 'active');
    if (!item) return null;
    const location = registry.show(projectId).location;
    return location?.root_path ? { project: { id: item.id, name: item.name, status: item.status }, location } : null;
  };
  const tableWork = createTableWorkModule({ dataWork, savedWork, resolveProject });
  const invoke = (action, parameters = {}, work = null) => tableWork.invoke({ protocol: MODULE_PROTOCOL_VERSION, module_id: 'atlas.table-work', project_id: project.project_id,
    ...(work ? { work: { session_id: work.session_id, base_revision: work.revision } } : {}), action, parameters });
  let work = (await invoke('start', { resource_ids: [source.resource_id], caller: { actor: 'agent', tool: 'focus-graph-test', client_run_id: 'start-1' } })).data;
  work = (await invoke('prepare', {}, work)).data;
  const mapping = work.sources[0].profile.profile.fields.map((field) => ({ source_key: work.sources[0].source_key, column: field.name, canonical: field.name }));
  work = (await invoke('align', { mapping }, work)).data;
  work = (await invoke('recipe', { combine: 'concatenate', filter_column: '', aggregate_dimension: 'district', aggregate_measure: 'amount',
    aggregate_formula: 'sum', aggregate_unit: 'rides', aggregate_null_policy: 'exclude' }, work)).data;
  work = (await invoke('preview', {}, work)).data;
  const fingerprint = await contentFileFingerprint(sourcePath);
  const candidateFile = path.join(stateDir, 'grouped.csv'); fs.writeFileSync(candidateFile, 'district,amount\nNorth,10\nSouth,5\n', 'utf8');
  const sources = work.sources.map((item) => ({ source_key: item.source_key, resource_id: item.resource_id, path: item.file_path,
    fingerprint: item.fingerprint, sheet: item.sheet ?? null, version_policy: item.version_policy ?? 'follow_latest' }));
  const prepared = saveService.prepare({ root: workspace, candidateFile, projectId: project.project_id, target: 'Transit/Results/grouped.csv',
    inputs: [sourcePath], origin: 'agent_generated', kind: 'intermediate', channel: 'work', requestKey: 'focus-graph-save',
    caller: { actor: 'agent', tool: 'focus-graph-test', client_run_id: 'save-1' },
    source: { path: sourcePath, fingerprint, resource_id: source.resource_id, sources, recipe: work.recipe, version_policy: 'follow_latest' },
    parameters: { work_session_id: work.session_id, mapping: work.mapping, recipe_version: work.recipe.version,
      table_work_save: { identity: { module_id: 'atlas.table-work', project_id: project.project_id, session_id: work.session_id,
        base_revision: work.revision, preview_revision: work.preview_revision, mapping: work.mapping, recipe: work.recipe } } },
    resultSummary: { rows: 2, columns: 2, validation: { input_rows: 2, output_rows: 2 } }, intent: 'Graph result fixture.' });
  const saved = saveService.execute(prepared.save_id, { reason: 'Fixture participant confirmed.' });
  dataWork.recordSave(work.session_id, saved.save_id);

  const server = await startAtlasUiServer({ stateDir, registry, intake, rules: {}, runtime: {}, projectRoot: workspace, installationRoot: root,
    resourceControl: control, dataWorkService: dataWork });
  t.after(async () => {
    await server.close(); saveService.dispose(); control.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const cli = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'resource', 'show', source.resource_id, '--project', project.project_id,
    '--relation-depth', '2', '--relation-status', 'active', '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: stateDir }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const host = JSON.parse(cli.stdout).data.resource_focus_graph;
  assert.ok(host, 'Host resource show should return the unified focus graph.');
  assert.deepEqual(host.nodes.map((node) => node.id), [
    `resource:${source.resource_id}`, `resource:${related.resource_id}`, `work:${work.session_id}`, `result:${saved.save_id}`,
  ]);
  assert.ok(host.edges.some((item) => item.id === relationship.id));
  assert.ok(host.edges.some((item) => item.kind === 'derived' && item.work_session_id === work.session_id));
  assert.ok(host.edges.some((item) => item.kind === 'derived' && item.save_id === saved.save_id));
  const resultNode = host.nodes.find((node) => node.id === `result:${saved.save_id}`);
  const sourceWorkEdge = host.edges.find((edge) => edge.derived_kind === 'source_to_work');
  assert.equal(resultNode.freshness?.status, 'fresh');
  assert.equal(sourceWorkEdge.impact?.status, 'fresh');

  const pageUrl = new URL(`/projects/${encodeURIComponent(project.project_id)}/resources?resource_id=${encodeURIComponent(source.resource_id)}&relation_depth=2&relation_status=active`, server.workspace_url);
  const pageResponse = await fetch(pageUrl); assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /data-resource-focus-graph/u);
  for (const node of host.nodes) assert.ok(html.includes(node.id), `Resources must retain the Host node identity ${node.id}.`);
  assert.ok(html.includes(relationship.id));
  assert.match(html, new RegExp(saved.save_id, 'u'));
  assert.match(html, new RegExp(`/work/${work.session_id}`, 'u'));
  assert.match(html, new RegExp(`data-focus-graph-node="result:${saved.save_id}"[^<]*>[^<]*<a[^>]*>[^<]*</a> · Fresh`, 'u'));
  assert.match(html, new RegExp(`data-focus-graph-edge="${sourceWorkEdge.id}"[^>]*>[^<]*Fresh</li>`, 'u'));
  assert.equal(saveService.show(saved.save_id).status, 'executed');
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'district,amount\nNorth,10\nSouth,5\n');
  fs.writeFileSync(sourcePath, 'district,amount\nNorth,11\nSouth,5\n', 'utf8');
  const changedCli = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'resource', 'show', source.resource_id, '--project', project.project_id,
    '--relation-depth', '2', '--relation-status', 'active', '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: stateDir }, encoding: 'utf8' });
  assert.equal(changedCli.status, 0, changedCli.stderr);
  const changedGraph = JSON.parse(changedCli.stdout).data.resource_focus_graph;
  assert.equal(changedGraph.edges.find((edge) => edge.derived_kind === 'source_to_work')?.impact?.status, 'needs_review');
  const changedHtml = await (await fetch(pageUrl)).text();
  assert.match(changedHtml, new RegExp(`data-focus-graph-edge="${sourceWorkEdge.id}"[^>]*>[^<]*Needs review</li>`, 'u'));
});
