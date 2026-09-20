import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Registry } from '../src/registry.js';
import { Intake } from '../src/intake.js';
import { createResourceControl } from '../src/resource-control.js';
import { startAtlasUiServer } from '../src/ui-server.js';

function selection() {
  return { schema: 'atlas.conversation-selection.v1', title: 'Selected decisions', source: { host: 'codex', thread_id: 'thread-save-test', selected_at: '2026-09-20T00:00:00.000Z' }, purpose: 'Save selected decisions.', decisions: [{ title: 'Boundary', content: 'Only selected decisions are saved. <img src=x onerror=alert(1)>' }], completed: [], pending: [], task_packet: null };
}

function run(f, args) {
  return spawnSync(process.execPath, [path.resolve('bin/atlas.js'), ...args, '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: f.stateDir }, encoding: 'utf8' });
}

test('Conversation selection Save prepares before execute and survives undo/redo', async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'conversation-save-')); const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const projectRoot = path.join(workspace, 'A'); const input = path.join(root, 'selection.json');
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true }); fs.writeFileSync(input, JSON.stringify(selection())); fs.writeFileSync(path.join(projectRoot, 'docs', 'existing.md'), 'keep');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' }); const project = registry.create({ name: 'A', currentPath: 'A' }); registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'test' }); registry.dispose();
  let server; let control; let intake; let reopened;
  t.after(async () => { if (server) await server.close(); control?.dispose(); intake?.dispose(); reopened?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const missingKey = run({ stateDir }, ['content', 'localize-conversation', '--input', input, '--project', project.project_id, '--output-relative', 'docs/missing-key.md', '--tool', 'Codex', '--client-run-id', 'missing-key']); assert.notEqual(missingKey.status, 0);
  const existing = run({ stateDir }, ['content', 'localize-conversation', '--input', input, '--project', project.project_id, '--output-relative', 'docs/existing.md', '--request-key', 'existing', '--tool', 'Codex', '--client-run-id', 'existing']); assert.notEqual(existing.status, 0);
  const traversal = run({ stateDir }, ['content', 'localize-conversation', '--input', input, '--project', project.project_id, '--output-relative', '../outside.md', '--request-key', 'traversal', '--tool', 'Codex', '--client-run-id', 'traversal']); assert.notEqual(traversal.status, 0);
  const prepared = run({ stateDir }, ['content', 'localize-conversation', '--input', input, '--project', project.project_id, '--output-relative', 'docs/selected.md', '--request-key', 'selection-1', '--tool', 'Codex', '--client-run-id', 'prepare-1']);
  assert.equal(prepared.status, 0, prepared.stderr); const data = JSON.parse(prepared.stdout).data; assert.equal(data.status, 'prepared'); assert.ok(data.save_id); assert.equal(data.desktop_href, `/saves/${data.save_id}`); assert.equal(data.project.id, project.project_id); assert.equal(data.source.kind, 'conversation_selection'); assert.ok(data.source.sha256); assert.equal(data.decision_count, 1); assert.equal(fs.existsSync(path.join(projectRoot, 'docs', 'selected.md')), false);
  intake = new Intake({ stateDir }); reopened = new Registry({ stateDir }); control = createResourceControl({ stateDir, ledger: reopened.ledger }); server = await startAtlasUiServer({ stateDir, registry: reopened, intake, resourceControl: control, projectRoot: workspace, installationRoot: workspace });
  const preview = await (await fetch(`${server.workspace_url}saves/${data.save_id}`)).text(); assert.doesNotMatch(preview, /<img src=x/u); assert.match(preview, /&lt;img src=x/u); const csrf = preview.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1]; assert.ok(csrf);
  const badCsrf = await fetch(`${server.workspace_url}saves/${data.save_id}/execute`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: 'bad' }) }); assert.equal(badCsrf.status, 403);
  const executed = await fetch(`${server.workspace_url}saves/${data.save_id}/execute`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) }); assert.equal(executed.status, 303); assert.equal(fs.existsSync(path.join(projectRoot, 'docs', 'selected.md')), true);
  const shown = run({ stateDir }, ['save', 'show', data.save_id]); assert.equal(shown.status, 0, shown.stderr); const saved = JSON.parse(shown.stdout).data; assert.equal(saved.source.kind, 'conversation_selection'); assert.equal(saved.project.id, project.project_id); assert.ok(saved.source.sha256);
  const undone = await fetch(`${server.workspace_url}saves/${data.save_id}/undo`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) }); assert.equal(undone.status, 303); assert.equal(fs.existsSync(path.join(projectRoot, 'docs', 'selected.md')), false);
  const redone = await fetch(`${server.workspace_url}saves/${data.save_id}/redo`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) }); assert.equal(redone.status, 303); assert.equal(fs.existsSync(path.join(projectRoot, 'docs', 'selected.md')), true);
});
