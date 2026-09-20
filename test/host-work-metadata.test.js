import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';

test('Work metadata migration preserves old sessions and CLI start metadata', (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'host-work-metadata-')); const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const csv = path.join(workspace, 'A', 'Data', 'input.csv');
  fs.mkdirSync(path.dirname(csv), { recursive: true }); fs.writeFileSync(csv, 'name,value\na,1\n');
  const registry = new Registry({ stateDir }); const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' }); const project = registry.create({ name: 'A', currentPath: 'A' }); registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'test' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger }); const resource = control.identify({ filePath: csv, project: { id: project.project_id, name: project.name } }); const old = registry.ledger.workSessions.create({ projectId: project.project_id, resourceIds: [resource.resource_id], returnState: { folder: 'Data' }, at: '2026-09-20T00:00:00.000Z' });
  registry.ledger.db.prepare('UPDATE work_sessions SET mapping_json=?, recipe_json=?, latest_save_id=? WHERE id=?').run('[{"source_key":"old","column":"name","canonical":"name"}]', '{"schema":"atlas.table-recipe.v1","version":4,"steps":[{"operation":"validate"}]}', 'SAVE-old', old.session_id); control.dispose(); registry.dispose();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const downgrade = new DatabaseSync(path.join(stateDir, 'ledger.sqlite')); downgrade.exec('ALTER TABLE work_sessions DROP COLUMN intent; ALTER TABLE work_sessions DROP COLUMN caller_json; DELETE FROM schema_migrations WHERE version=27; PRAGMA user_version=26;'); downgrade.close();
  const reopened = new Registry({ stateDir });
  const columns = reopened.ledger.db.prepare('PRAGMA table_info(work_sessions)').all().map((item) => item.name); assert.ok(columns.includes('intent')); assert.ok(columns.includes('caller_json')); assert.equal(reopened.ledger.workSessions.byId(old.session_id).latest_save_id, 'SAVE-old'); assert.deepEqual(reopened.ledger.workSessions.byId(old.session_id).sources.map((item) => item.resource_id), [resource.resource_id]); assert.deepEqual(reopened.ledger.workSessions.byId(old.session_id).mapping, [{ source_key: 'old', column: 'name', canonical: 'name' }]); assert.equal(reopened.ledger.workSessions.byId(old.session_id).intent, null); assert.equal(reopened.ledger.workSessions.byId(old.session_id).caller, null); reopened.dispose();
  const backupPath = path.join(stateDir, 'backups', 'ledger-pre-migration-v26-to-v27.sqlite'); assert.ok(fs.existsSync(backupPath)); const backup = new DatabaseSync(backupPath); assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 26); assert.equal(backup.prepare('SELECT latest_save_id FROM work_sessions WHERE id=?').get(old.session_id).latest_save_id, 'SAVE-old'); assert.equal(backup.prepare('PRAGMA table_info(work_sessions)').all().some((item) => item.name === 'intent'), false); backup.close();
  const started = spawnSync(process.execPath, [path.resolve('bin/atlas.js'), 'table-work', 'start', '--project', project.project_id, '--source', 'Data/input.csv', '--intent', 'Join these rows', '--tool', 'Codex', '--client-run-id', 'metadata-start', '--json'], { cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: stateDir }, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr); const startedData = JSON.parse(started.stdout).data; assert.equal(startedData.intent, 'Join these rows'); assert.equal(startedData.caller.tool, 'Codex'); assert.equal(startedData.caller.client_run_id, 'metadata-start');
  const check = new Registry({ stateDir }); const before = check.ledger.workSessions.byId(startedData.session_id); check.ledger.workSessions.updateReturnState(startedData.session_id, { folder: 'Results', path: 'Results/out.csv' }, '2026-09-20T00:01:00.000Z'); const after = check.ledger.workSessions.byId(startedData.session_id); assert.equal(after.intent, 'Join these rows'); assert.deepEqual(after.caller, before.caller); assert.deepEqual(after.return_state, { folder: 'Results', path: 'Results/out.csv' }); check.dispose();
});
