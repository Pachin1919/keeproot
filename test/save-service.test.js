import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSaveService } from '../src/save-service.js';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';

const testTempRoot = path.resolve('test', '.tmp');

function temporary(t, prefix = 'save-service-') {
  fs.mkdirSync(testTempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testTempRoot, prefix));
  if (path.dirname(root) !== testTempRoot) throw new Error('Save Service test case escaped test/.tmp.');
  t.after(() => {
    if (path.dirname(root) !== testTempRoot) throw new Error('Refusing to remove a Save Service test case outside test/.tmp.');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return root;
}

test('Save Service commits one shared result shape and preserves request replay', (t) => {
  const root = temporary(t); const stateDir = path.join(root, 'state');
  const candidate = path.join(root, 'candidate.md'); fs.writeFileSync(candidate, 'saved\\n');
  const intake = {
    prepare(options) { return { status: 'prepared', run_id: options.runId, target: 'Projects/One/Data/result.md', project: { id: 'PRJ-1', name: 'One', path: 'Projects/One' } }; },
    execute(runId) { return { run_id: runId, verified: true, rollback_ready: true, after_sha256: 'a'.repeat(64), executed_at: '2026-01-01T00:00:00.000Z' }; },
    rollback(runId) { return { run_id: runId, status: 'rolled_back' }; }, dispose() {},
  };
  const save = createSaveService({ stateDir, intake });
  const options = { root, candidateFile: candidate, projectId: 'PRJ-1', target: 'Projects/One/Data/result.md', origin: 'agent_generated', kind: 'intermediate', channel: 'work', caller: { tool: 'atlas-ui', client_run_id: 'run-1' }, requestKey: 'save-1' };
  const prepared = save.prepare(options);
  assert.equal(prepared.schema, 'atlas.save-result.v1');
  assert.equal(save.prepare(options).save_id, prepared.save_id);
  const executed = save.execute(prepared.save_id, { reason: 'user confirmed' });
  assert.equal(executed.save_id, prepared.save_id);
  assert.equal(executed.status, 'executed');
  assert.equal(executed.undo_available, true);
  assert.equal(executed.resources_href, '/projects/PRJ-1/resources?path=Data%2Fresult.md');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items.length, 1);
  assert.throws(() => save.prepare({ ...options, target: 'Projects/One/other.md' }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('Save Service rejects unverified or mismatched Project paths', (t) => {
  const root = temporary(t); const stateDir = path.join(root, 'state'); const candidate = path.join(root, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  const options = { root, candidateFile: candidate, projectId: 'PRJ-1', target: 'Projects/One/Data/result.md', channel: 'host', caller: { tool: 'test', client_run_id: 'project-path' }, requestKey: 'project-path' };
  const withProject = (project) => createSaveService({ stateDir, intake: { prepare: (value) => ({ status: 'prepared', run_id: value.runId, target: value.target, project }), dispose() {} } });
  assert.throws(() => withProject({ id: 'PRJ-1', name: 'One' }).prepare(options), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items[0].status, 'failed');
  assert.throws(() => withProject({ id: 'PRJ-1', name: 'One', path: 'Projects/Other' }).prepare({ ...options, requestKey: 'project-mismatch' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items[0].owner_pid, null);
});

test('two processes retain distinct Save journal rows', async (t) => {
  const root = temporary(t); const stateDir = path.join(root, 'state');
  const candidate = path.join(root, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  const servicePath = new URL('../src/save-service.js', import.meta.url).href;
  const script = `import { createSaveService } from ${JSON.stringify(servicePath)};
const intake={prepare:o=>({status:'prepared',run_id:o.runId,target:'Projects/One/'+o.runId+'.md',project:{id:'PRJ-1',name:'One',path:'Projects/One'}}),execute:()=>({verified:true,rollback_ready:true}),rollback:()=>({status:'rolled_back'}),dispose(){}};
createSaveService({stateDir:process.argv[1],intake}).prepare({root:process.argv[2],candidateFile:process.argv[3],projectId:'PRJ-1',target:'Projects/One/'+process.argv[4]+'.md',channel:'host',caller:{tool:'test',client_run_id:process.argv[4]},requestKey:process.argv[4]});`;
  const run = (key) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, stateDir, root, candidate, key], { windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
  });
  await Promise.all([run('one'), run('two')]);
  const items = JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items;
  assert.deepEqual(new Set(items.map((item) => item.caller.client_run_id)), new Set(['one', 'two']));
});

test('two processes execute one real Derived save for one scoped request key', async (t) => {
  const caseRoot = temporary(t); const vault = path.join(caseRoot, 'vault'); const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true });
  const candidate = path.join(caseRoot, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  const registry = new Registry({ stateDir }); const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' }); registry.dispose();
  const servicePath = new URL('../src/save-service.js', import.meta.url).href;
  const script = `import { createSaveService } from ${JSON.stringify(servicePath)};
const save=createSaveService({stateDir:process.argv[1]}); const prepared=save.prepare({root:process.argv[2],candidateFile:process.argv[3],projectId:process.argv[4],target:'Projects/Atlas/result.md',origin:'agent_generated',kind:'intermediate',channel:'host',caller:{tool:'test',client_run_id:'same-client'},requestKey:'same-request'}); const result=prepared.status==='executed'?prepared:save.execute(prepared.save_id,{reason:'Authorized concurrency regression.'}); console.log(JSON.stringify({save_id:result.save_id,status:result.status,resource_id:result.resource_id,relationships:result.relationships})); save.dispose();`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, stateDir, vault, candidate, project.project_id], { windowsHide: true });
    let output = ''; let error = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`child exited ${code}: ${error}`)));
  });
  const results = (await Promise.all([run(), run()])).map((output) => JSON.parse(output));
  const items = JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items;
  assert.equal(items.length, 1);
  assert.equal(new Set(results.map((item) => item.save_id)).size, 1);
  assert.ok(results.every((item) => item.status === 'executed'));
  assert.ok(results.every((item) => /^RES-/u.test(item.resource_id) && item.relationships.some((relation) => relation.type === 'stored_in')));
  assert.equal(items[0].status, 'executed');
  assert.equal(items[0].target.relative_path, 'Projects/Atlas/result.md');
  assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'Atlas', 'result.md'), 'utf8'), 'candidate\n');
});

test('a dead reservation owner is recovered into one real Save run', async (t) => {
  const caseRoot = temporary(t, 'save-dead-owner-');
  const vault = path.join(caseRoot, 'vault'); const stateDir = path.join(caseRoot, 'state'); const candidate = path.join(caseRoot, 'candidate.md');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true }); fs.writeFileSync(candidate, 'candidate\n');
  const registry = new Registry({ stateDir }); const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' }); registry.dispose();
  const servicePath = new URL('../src/save-service.js', import.meta.url).href;
  const script = `import { createSaveService } from ${JSON.stringify(servicePath)}; const save=createSaveService({stateDir:process.argv[1],intake:{prepare(){process.exit(23)},dispose(){}}}); save.prepare({root:process.argv[2],candidateFile:process.argv[3],projectId:process.argv[4],target:'Projects/Atlas/result.md',origin:'agent_generated',kind:'intermediate',channel:'host',caller:{tool:'test',client_run_id:'dead-owner'},requestKey:'dead-owner',source:{path:'original-source.md',sha256:'${'a'.repeat(64)}'},parameters:{sheet:'Original'},resultSummary:{rows:7}});`;
  await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '--eval', script, stateDir, vault, candidate, project.project_id], { windowsHide: true }); child.once('error', reject); child.once('exit', (code) => code === 23 ? resolve() : reject(new Error(`child exited ${code}`))); });
  const reserved = JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items[0];
  assert.equal(reserved.status, 'reserving'); assert.match(String(reserved.owner_pid), /^\d+$/u);
  const recoverScript = `import { createSaveService } from ${JSON.stringify(servicePath)}; const save=createSaveService({stateDir:process.argv[1]}); const prepared=save.prepare({root:process.argv[2],candidateFile:process.argv[3],projectId:process.argv[4],target:'Projects/Atlas/result.md',origin:'agent_generated',kind:'intermediate',channel:'host',caller:{tool:'test',client_run_id:'dead-owner'},requestKey:'dead-owner',source:{path:'original-source.md',sha256:'${'a'.repeat(64)}'},parameters:{sheet:'Original'},resultSummary:{rows:7}}); const result=prepared.status==='executed'?prepared:save.execute(prepared.save_id,{reason:'recover dead owner'}); console.log(JSON.stringify({save_id:result.save_id,status:result.status,source:result.source,parameters:result.parameters,result_summary:result.result_summary})); save.dispose();`;
  const recover = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', recoverScript, stateDir, vault, candidate, project.project_id], { windowsHide: true }); let output = ''; let error = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`recovery child exited ${code}: ${error}`)));
  });
  const recovered = await Promise.all([recover(), recover()]);
  assert.equal(new Set(recovered.map((item) => item.save_id)).size, 1); assert.ok(recovered.every((item) => item.save_id === reserved.save_id && item.status === 'executed'));
  assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'Atlas', 'result.md'), 'utf8'), 'candidate\n');
  const items = JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items;
  assert.equal(items.length, 1); assert.equal(items[0].save_id, reserved.save_id); assert.equal(items[0].status, 'executed');
  assert.deepEqual(items[0].source, { path: 'original-source.md', sha256: 'a'.repeat(64) });
  assert.deepEqual(items[0].parameters, { sheet: 'Original' });
  assert.deepEqual(items[0].result_summary, { rows: 7 });
  assert.ok(recovered.every((item) => item.source?.path === 'original-source.md' && item.parameters?.sheet === 'Original' && item.result_summary?.rows === 7));
  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM derived_operations WHERE run_id = ?').get(reserved.save_id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM derived_operations WHERE target_path = ?').get('Projects/Atlas/result.md').count, 1);
  } finally { db.close(); }
});

test('a dead owner after real Derived prepare is reconstructed without a second prepare', async (t) => {
  const caseRoot = temporary(t, 'save-prepared-owner-');
  const vault = path.join(caseRoot, 'vault'); const stateDir = path.join(caseRoot, 'state'); const candidate = path.join(caseRoot, 'candidate.md'); fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true }); fs.writeFileSync(candidate, 'candidate\n');
  const registry = new Registry({ stateDir }); const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' }); registry.dispose();
  const servicePath = new URL('../src/save-service.js', import.meta.url).href;
  const script = `import fs from 'node:fs'; import path from 'node:path'; import { createSaveService } from ${JSON.stringify(servicePath)}; const writer=(dir,items)=>{if(items.some(x=>x.status==='prepared'))process.exit(24); const f=path.join(dir,'ui','saved-work.json');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify({items}));}; const save=createSaveService({stateDir:process.argv[1],writeJournalFn:writer}); save.prepare({root:process.argv[2],candidateFile:process.argv[3],projectId:process.argv[4],target:'Projects/Atlas/result.md',origin:'agent_generated',kind:'intermediate',channel:'host',caller:{tool:'test',client_run_id:'prepared-owner'},requestKey:'prepared-owner'});`;
  await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '--eval', script, stateDir, vault, candidate, project.project_id], { windowsHide: true }); child.once('error', reject); child.once('exit', (code) => code === 24 ? resolve() : reject(new Error(`child exited ${code}`))); });
  const reserved = JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items[0]; const save = createSaveService({ stateDir });
  const prepared = save.prepare({ root: vault, candidateFile: candidate, projectId: project.project_id, target: 'Projects/Atlas/result.md', origin: 'agent_generated', kind: 'intermediate', channel: 'host', caller: { tool: 'test', client_run_id: 'prepared-owner' }, requestKey: 'prepared-owner' });
  assert.equal(prepared.save_id, reserved.save_id); assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.resources_href, `/projects/${project.project_id}/resources?path=result.md`);
  const recoveredRow = JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items[0];
  assert.equal(recoveredRow.owner_pid, null); assert.equal(recoveredRow.owner_token, null);
  const executed = save.execute(prepared.save_id, { reason: 'recover prepared owner' }); assert.equal(executed.status, 'executed'); assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'Atlas', 'result.md'), 'utf8'), 'candidate\n'); save.dispose();
});

test('Save Service rejects a replay when an input fact changes', (t) => {
  const root = temporary(t); const stateDir = path.join(root, 'state');
  const candidate = path.join(root, 'candidate.md'); const input = path.join(root, 'input.md');
  fs.writeFileSync(candidate, 'candidate\n'); fs.writeFileSync(input, 'first\n');
  const intake = { prepare: (options) => ({ status: 'prepared', run_id: options.runId, target: options.target, project: { id: 'PRJ-1', name: 'One', path: 'Projects/One' } }), dispose() {} };
  const save = createSaveService({ stateDir, intake });
  const options = { root, candidateFile: candidate, projectId: 'PRJ-1', target: 'Projects/One/result.md', inputs: ['input.md'], channel: 'host', caller: { tool: 'test', client_run_id: 'input' }, requestKey: 'same' };
  const prepared = save.prepare(options);
  assert.equal(prepared.inputs[0].relative_path, 'input.md');
  fs.writeFileSync(input, 'second\n');
  assert.throws(() => save.prepare(options), { code: 'ATLAS_STATE_CONFLICT' });

  const vault = path.join(root, 'vault'); const realStateDir = path.join(root, 'real-state');
  fs.mkdirSync(path.join(vault, 'Projects', 'One'), { recursive: true });
  const realInput = path.join(vault, 'input.md'); const realCandidate = path.join(root, 'real-candidate.md');
  fs.writeFileSync(realInput, 'first\n'); fs.writeFileSync(realCandidate, 'candidate\n');
  const registry = new Registry({ stateDir: realStateDir });
  const project = registry.create({ name: 'One', currentPath: 'Projects/One' });
  registry.dispose();
  const realSave = createSaveService({ stateDir: realStateDir });
  const realPrepared = realSave.prepare({ root: vault, candidateFile: realCandidate, projectId: project.project_id, target: 'Projects/One/result.md', inputs: ['input.md'], channel: 'host', caller: { tool: 'test', client_run_id: 'input-execute' }, requestKey: 'input-execute' });
  fs.writeFileSync(realInput, 'changed\n');
  assert.throws(() => realSave.execute(realPrepared.save_id), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(realSave.show(realPrepared.save_id).status, 'prepared');
  assert.equal(fs.existsSync(path.join(vault, 'Projects', 'One', 'result.md')), false);
  realSave.dispose();
});

test('Save Service scopes request identity to the real root, origin, and kind', (t) => {
  const caseRoot = temporary(t, 'save-request-identity-');
  const rootOne = path.join(caseRoot, 'root-one'); const rootTwo = path.join(caseRoot, 'root-two');
  fs.mkdirSync(path.join(rootOne, 'Projects', 'One'), { recursive: true }); fs.mkdirSync(path.join(rootTwo, 'Projects', 'One'), { recursive: true });
  const candidate = path.join(caseRoot, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  const intake = { prepare: (value) => ({ status: 'prepared', run_id: value.runId, target: value.target, project: { id: 'PRJ-1', name: 'One', path: 'Projects/One' } }), dispose() {} };
  const base = { candidateFile: candidate, projectId: 'PRJ-1', target: 'Projects/One/result.md', channel: 'host', caller: { tool: 'test', client_run_id: 'identity' }, requestKey: 'same', origin: 'agent_generated', kind: 'intermediate' };
  const rootScoped = createSaveService({ stateDir: path.join(caseRoot, 'root-state'), intake });
  rootScoped.prepare({ ...base, root: rootOne });
  assert.throws(() => rootScoped.prepare({ ...base, root: rootTwo }), { code: 'ATLAS_STATE_CONFLICT' });
  const originScoped = createSaveService({ stateDir: path.join(caseRoot, 'origin-state'), intake });
  originScoped.prepare({ ...base, root: rootOne });
  assert.throws(() => originScoped.prepare({ ...base, root: rootOne, origin: 'human_submitted' }), { code: 'ATLAS_STATE_CONFLICT' });
  const kindScoped = createSaveService({ stateDir: path.join(caseRoot, 'kind-state'), intake });
  kindScoped.prepare({ ...base, root: rootOne });
  assert.throws(() => kindScoped.prepare({ ...base, root: rootOne, kind: 'report' }), { code: 'ATLAS_STATE_CONFLICT' });
});

test('Save Service scopes request identity to source, parameters, and result summary', (t) => {
  const caseRoot = temporary(t, 'save-request-facts-'); const root = path.join(caseRoot, 'root'); fs.mkdirSync(path.join(root, 'Projects', 'One'), { recursive: true }); const candidate = path.join(caseRoot, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  const intake = { prepare: (value) => ({ status: 'prepared', run_id: value.runId, target: value.target, project: { id: 'PRJ-1', name: 'One', path: 'Projects/One' } }), dispose() {} };
  const base = { root, candidateFile: candidate, projectId: 'PRJ-1', target: 'Projects/One/result.md', channel: 'host', caller: { tool: 'test', client_run_id: 'facts' } };
  for (const [key, changed] of [['source', { source: { resource_id: 'RES-two' } }], ['parameters', { parameters: { sheet: 'B' } }], ['summary', { resultSummary: { rows: 2 } }]]) {
    const save = createSaveService({ stateDir: path.join(caseRoot, key), intake }); const first = { ...base, requestKey: key, source: { resource_id: 'RES-one' }, parameters: { sheet: 'A' }, resultSummary: { rows: 1 } };
    save.prepare(first); assert.throws(() => save.prepare({ ...first, ...changed }), { code: 'ATLAS_STATE_CONFLICT' });
  }
});

test('Save Service does not take over a reservation with an unknown owner', (t) => {
  const root = temporary(t, 'save-unknown-owner-'); const stateDir = path.join(root, 'state'); const candidate = path.join(root, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  let prepares = 0;
  const intake = { prepare: (value) => { prepares += 1; return { status: 'prepared', run_id: value.runId, target: value.target, project: { id: 'PRJ-1', name: 'One', path: 'Projects/One' } }; }, dispose() {} };
  const save = createSaveService({ stateDir, intake });
  const options = { root, candidateFile: candidate, projectId: 'PRJ-1', target: 'Projects/One/result.md', channel: 'host', caller: { tool: 'test', client_run_id: 'unknown-owner' }, requestKey: 'unknown-owner' };
  save.prepare(options);
  const journal = path.join(stateDir, 'ui', 'saved-work.json'); const state = JSON.parse(fs.readFileSync(journal, 'utf8'));
  state.items[0] = { ...state.items[0], status: 'reserving', owner_pid: null, owner_token: null };
  fs.writeFileSync(journal, JSON.stringify(state));
  assert.throws(() => save.prepare(options), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(prepares, 1);
});

test('Save Service reconciles an executed receipt after the final journal write fails', (t) => {
  const root = temporary(t); const stateDir = path.join(root, 'state');
  const candidate = path.join(root, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  const calls = []; const target = path.join(root, 'Projects', 'One', 'result.md');
  const intake = {
    prepare: (options) => ({ status: 'prepared', run_id: options.runId, target: 'Projects/One/result.md', project: { id: 'PRJ-1', name: 'One', path: 'Projects/One' } }),
    execute: (runId) => { calls.push(runId); if (!fs.existsSync(target)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'candidate\n'); } return { run_id: runId, verified: true, rollback_ready: true, after_sha256: 'b'.repeat(64) }; }, dispose() {},
  };
  const faulted = createSaveService({ stateDir, intake, writeJournalFn: (dir, items) => { if (items.some((item) => item.status === 'executed')) throw new Error('journal unavailable'); const file = path.join(dir, 'ui', 'saved-work.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ items })}\n`); } });
  const prepared = faulted.prepare({ root, candidateFile: candidate, projectId: 'PRJ-1', target: 'Projects/One/result.md', channel: 'host', caller: { tool: 'test', client_run_id: 'reconcile' }, requestKey: 'one' });
  assert.throws(() => faulted.execute(prepared.save_id), /journal unavailable/u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items[0].status, 'committing');
  const recovered = createSaveService({ stateDir, intake }).execute(prepared.save_id);
  assert.equal(recovered.status, 'executed');
  assert.equal(recovered.save_id, prepared.save_id);
  assert.equal(fs.readFileSync(target, 'utf8'), 'candidate\n');
  assert.deepEqual(calls, [prepared.save_id, prepared.save_id]);
});

test('Save Service finalizes an executed Intake receipt from a stale reservation', (t) => {
  const caseRoot = temporary(t); const vault = path.join(caseRoot, 'vault'); const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true });
  const candidate = path.join(caseRoot, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  const registry = new Registry({ stateDir }); const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' }); registry.dispose();
  const options = { root: vault, candidateFile: candidate, projectId: project.project_id, target: 'Projects/Atlas/result.md', origin: 'agent_generated', kind: 'intermediate', channel: 'host', caller: { tool: 'test', client_run_id: 'receipt' }, requestKey: 'receipt' };
  const prepareIntake = { prepare: (value) => ({ status: 'prepared', run_id: value.runId, target: value.target, project: { id: project.project_id, name: 'Atlas', path: 'Projects/Atlas' } }), dispose() {} };
  const initial = createSaveService({ stateDir, intake: prepareIntake });
  const prepared = initial.prepare(options); initial.dispose();
  fs.writeFileSync(path.join(vault, 'Projects', 'Atlas', 'result.md'), 'candidate\n');
  const journalPath = path.join(stateDir, 'ui', 'saved-work.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const candidateHash = createHash('sha256').update('candidate\n').digest('hex');
  journal.items[0] = { ...journal.items[0], status: 'reserving', owner_pid: 999999, owner_token: 'dead-recovery-owner', prepare_request: { root: fs.realpathSync.native(vault), candidate_path: candidate, candidate_hash: candidateHash, inputs: [], origin: 'agent_generated', kind: 'intermediate', project_id: project.project_id, target: 'Projects/Atlas/result.md', relation_type: null, intent: null } };
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  let shows = 0;
  const executedIntake = { show: (runId) => {
    shows += 1;
    return { run: { id: runId, status: 'executed', root_path: vault }, candidate: { target_path: 'Projects/Atlas/result.md', content_hash: candidateHash }, placement: { project_id: project.project_id, project_path: 'Projects/Atlas', project_name: 'Atlas' }, execution_receipt: { run_id: runId, verified: true, rollback_ready: true } };
  }, dispose() {} };
  const recoveryService = createSaveService({ stateDir, intake: executedIntake });
  const recovered = recoveryService.prepare(options);
  assert.equal(recovered.status, 'executed'); assert.equal(recovered.save_id, prepared.save_id);
  assert.match(recovered.resource_id, /^RES-/u);
  assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'Atlas', 'result.md'), 'utf8'), 'candidate\n');
  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM resource_save_links WHERE save_id = ?').get(prepared.save_id).count, 1); } finally { db.close(); }
  assert.equal(recoveryService.prepare(options).resource_id, recovered.resource_id);
  assert.equal(shows, 2);
  recoveryService.dispose();
});

test('Save Service restores visible Undo facts when rollback is protectively rejected', (t) => {
  const root = temporary(t); const stateDir = path.join(root, 'state'); const candidate = path.join(root, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  const target = path.join(root, 'Projects/One/result.md'); fs.mkdirSync(path.dirname(target), { recursive: true });
  const intake = {
    prepare: (options) => ({ status: 'prepared', run_id: options.runId, target: 'Projects/One/result.md', project: { id: 'PRJ-1', name: 'One', path: 'Projects/One' } }),
    execute: () => { fs.copyFileSync(candidate, target); return { verified: true, rollback_ready: true, after_sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') }; },
    rollback: () => { throw new Error('target changed externally'); }, dispose() {},
  };
  const save = createSaveService({ stateDir, intake });
  const prepared = save.prepare({ root, candidateFile: candidate, projectId: 'PRJ-1', target: 'Projects/One/result.md', channel: 'host', caller: { tool: 'test', client_run_id: 'undo' }, requestKey: 'undo' });
  save.execute(prepared.save_id);
  assert.throws(() => save.undo(prepared.save_id), /target changed externally/u);
  const shown = save.show(prepared.save_id);
  assert.equal(shown.status, 'executed'); assert.equal(shown.undo_available, true);
  const row = JSON.parse(fs.readFileSync(path.join(stateDir, 'ui', 'saved-work.json'), 'utf8')).items[0];
  assert.match(row.undo_error, /target changed externally/u);
});

test('a late execute receipt cannot revive an undone Save', (t) => {
  const root = temporary(t); const stateDir = path.join(root, 'state'); const candidate = path.join(root, 'candidate.md'); fs.writeFileSync(candidate, 'candidate\n');
  const target = path.join(root, 'Projects/One/result.md'); fs.mkdirSync(path.dirname(target), { recursive: true });
  const prepare = (options) => ({ status: 'prepared', run_id: options.runId, target: 'Projects/One/result.md', project: { id: 'PRJ-1', name: 'One', path: 'Projects/One' } });
  const receipt = { verified: true, rollback_ready: true, after_sha256: 'd'.repeat(64) };
  const intakeB = { prepare, execute: () => { fs.copyFileSync(candidate, target); return receipt; }, rollback: () => ({ status: 'rolled_back' }), dispose() {} };
  const serviceB = createSaveService({ stateDir, intake: intakeB });
  let saveId;
  const intakeA = { prepare, execute: () => { serviceB.execute(saveId); serviceB.undo(saveId); return receipt; }, rollback: () => ({ status: 'rolled_back' }), dispose() {} };
  const serviceA = createSaveService({ stateDir, intake: intakeA });
  const prepared = serviceA.prepare({ root, candidateFile: candidate, projectId: 'PRJ-1', target: 'Projects/One/result.md', channel: 'host', caller: { tool: 'test', client_run_id: 'late' }, requestKey: 'late' }); saveId = prepared.save_id;
  const late = serviceA.execute(saveId);
  assert.equal(late.status, 'undone'); assert.equal(serviceA.show(saveId).status, 'undone');
});

test('Save Service reopens an executed Save for durable Undo and Redo with one Resource ID', (t) => {
  const caseRoot = temporary(t, 'save-redo-'); const vault = path.join(caseRoot, 'vault'); const stateDir = path.join(caseRoot, 'state'); const candidate = path.join(caseRoot, 'candidate.md'); fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true }); fs.writeFileSync(candidate, 'candidate\n');
  const registry = new Registry({ stateDir }); const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' }); registry.dispose(); const options = { root: vault, candidateFile: candidate, projectId: project.project_id, target: 'Projects/Atlas/result.md', origin: 'agent_generated', kind: 'intermediate', channel: 'host', caller: { tool: 'test', client_run_id: 'redo' }, requestKey: 'redo' };
  const first = createSaveService({ stateDir }); const executed = first.execute(first.prepare(options).save_id, { reason: 'Save for redo.' }); const saveId = executed.save_id; const resourceId = executed.resource_id; assert.match(resourceId, /^RES-/u); first.dispose();
  const undoing = createSaveService({ stateDir }); const undone = undoing.undo(saveId); assert.equal(undone.status, 'undone'); assert.equal(undone.redo_available, true); const targetPath = path.join(vault, 'Projects', 'Atlas', 'result.md'); assert.equal(fs.existsSync(targetPath), false); fs.writeFileSync(targetPath, 'external replacement\n'); assert.throws(() => undoing.redo(saveId), /empty target path/u); assert.equal(fs.readFileSync(targetPath, 'utf8'), 'external replacement\n'); assert.equal(undoing.show(saveId).redo_available, true); fs.unlinkSync(targetPath); undoing.dispose();
  const db = new DatabaseSync(path.join(stateDir, 'ledger.sqlite'), { readOnly: true }); try { assert.equal(db.prepare('SELECT status FROM resources WHERE id=?').get(resourceId).status, 'missing'); assert.equal(db.prepare("SELECT COUNT(*) AS count FROM resource_locations WHERE resource_id=? AND status='missing'").get(resourceId).count, 1); } finally { db.close(); }
  const reloaded = createSaveService({ stateDir }); const redone = reloaded.redo(saveId); assert.equal(redone.status, 'executed'); assert.equal(redone.resource_id, resourceId); assert.equal(redone.undo_available, true); assert.equal(redone.redo_available, false); assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'Atlas', 'result.md'), 'utf8'), 'candidate\n'); const repeated = reloaded.undo(saveId); assert.equal(repeated.status, 'undone'); assert.equal(fs.existsSync(path.join(vault, 'Projects', 'Atlas', 'result.md')), false); const finalRedo=reloaded.redo(saveId);assert.equal(finalRedo.status,'executed');assert.equal(fs.existsSync(path.join(vault,'Projects','Atlas','result.md')),true); reloaded.dispose();
});

test('Save Service refuses Undo when a receipt relationship changed', (t) => {
  const caseRoot = temporary(t, 'save-undo-relationship-'); const vault = path.join(caseRoot, 'vault'); const stateDir = path.join(caseRoot, 'state'); const candidate = path.join(caseRoot, 'candidate.md'); fs.mkdirSync(path.join(vault, 'Projects', 'Atlas'), { recursive: true }); fs.writeFileSync(candidate, 'candidate\n'); const registry = new Registry({ stateDir }); const project = registry.create({ name: 'Atlas', currentPath: 'Projects/Atlas' }); registry.dispose();
  const save = createSaveService({ stateDir }); const executed = save.execute(save.prepare({ root: vault, candidateFile: candidate, projectId: project.project_id, target: 'Projects/Atlas/result.md', origin: 'agent_generated', kind: 'intermediate', channel: 'host', caller: { tool: 'test', client_run_id: 'relationship' }, requestKey: 'relationship' }).save_id, { reason: 'Save.' }); const control = createResourceControl({ stateDir }); const relation = executed.relationships.find((item) => item.type === 'stored_in'); control.forgetRelationship(relation.id, { caller: { tool: 'test', client_run_id: 'changed' } }); assert.throws(() => save.undo(executed.save_id), { code: 'ATLAS_STATE_CONFLICT' }); assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'Atlas', 'result.md'), 'utf8'), 'candidate\n'); assert.equal(save.show(executed.save_id).undo_available, true); control.dispose(); save.dispose();
});

test('Save Service refuses Undo when an additional active Resource relationship appears', (t) => {
  const root=temporary(t,'save-relationship-added-');const vault=path.join(root,'vault');const stateDir=path.join(root,'state');const candidate=path.join(root,'candidate.md');fs.mkdirSync(path.join(vault,'Projects','Atlas'),{recursive:true});fs.writeFileSync(candidate,'candidate\n');const registry=new Registry({stateDir});const project=registry.create({name:'Atlas',currentPath:'Projects/Atlas'});registry.dispose();const save=createSaveService({stateDir});const executed=save.execute(save.prepare({root:vault,candidateFile:candidate,projectId:project.project_id,target:'Projects/Atlas/result.md',origin:'agent_generated',kind:'intermediate',channel:'host',caller:{tool:'test',client_run_id:'added'},requestKey:'added'}).save_id,{reason:'Save.'});const reopenedRegistry=new Registry({stateDir});const second=reopenedRegistry.create({name:'Second',currentPath:'Projects/Second'});const control=createResourceControl({stateDir,ledger:reopenedRegistry.ledger});control.submitRelationships({caller:{tool:'test',client_run_id:'added'},candidates:[{source_resource_id:executed.resource_id,target:{kind:'project',id:second.project_id},type:'used_by',evidence:{reason:'new'}}]});assert.throws(()=>save.undo(executed.save_id),{code:'ATLAS_STATE_CONFLICT'});assert.equal(fs.existsSync(path.join(vault,'Projects','Atlas','result.md')),true);assert.equal(save.show(executed.save_id).undo_available,true);control.dispose();reopenedRegistry.dispose();save.dispose();
});

test('Save Service reconciles crash-state Resource projections without duplicate actions', (t) => {
  const caseRoot=temporary(t,'save-transition-reconcile-'); const vault=path.join(caseRoot,'vault'); const stateDir=path.join(caseRoot,'state'); const candidate=path.join(caseRoot,'candidate.md'); fs.mkdirSync(path.join(vault,'Projects','Atlas'),{recursive:true});fs.writeFileSync(candidate,'candidate\n');const registry=new Registry({stateDir});const project=registry.create({name:'Atlas',currentPath:'Projects/Atlas'});registry.dispose();
  const options={root:vault,candidateFile:candidate,projectId:project.project_id,target:'Projects/Atlas/result.md',origin:'agent_generated',kind:'intermediate',channel:'host',caller:{tool:'test',client_run_id:'crash'},requestKey:'crash'};const first=createSaveService({stateDir});const executed=first.execute(first.prepare(options).save_id,{reason:'Save.'});first.undo(executed.save_id);first.dispose();
  const journal=path.join(stateDir,'ui','saved-work.json');let state=JSON.parse(fs.readFileSync(journal,'utf8'));state.items[0].status='undoing';state.items[0].redo_available=false;fs.writeFileSync(journal,JSON.stringify(state));const reopened=createSaveService({stateDir});assert.equal(reopened.show(executed.save_id).status,'undone');let control=createResourceControl({stateDir});assert.equal(control.describe(executed.resource_id).actions.filter((a)=>a.action_type==='save_undo').length,1);control.dispose();reopened.redo(executed.save_id);reopened.dispose();
  state=JSON.parse(fs.readFileSync(journal,'utf8'));state.items[0].status='redoing';state.items[0].undo_available=false;fs.writeFileSync(journal,JSON.stringify(state));const finalSave=createSaveService({stateDir});assert.equal(finalSave.show(executed.save_id).status,'executed');control=createResourceControl({stateDir});assert.equal(control.describe(executed.resource_id).actions.filter((a)=>a.action_type==='save_redo').length,1);control.dispose();finalSave.dispose();
});

test('Save Service refuses Redo after the missing Resource was relinked', (t) => {
  const root=temporary(t,'save-redo-relink-');const vault=path.join(root,'vault');const stateDir=path.join(root,'state');const candidate=path.join(root,'candidate.md');fs.mkdirSync(path.join(vault,'Projects','Atlas'),{recursive:true});fs.writeFileSync(candidate,'candidate\n');const registry=new Registry({stateDir});const project=registry.create({name:'Atlas',currentPath:'Projects/Atlas'});registry.dispose();const save=createSaveService({stateDir});const result=save.execute(save.prepare({root:vault,candidateFile:candidate,projectId:project.project_id,target:'Projects/Atlas/result.md',origin:'agent_generated',kind:'intermediate',channel:'host',caller:{tool:'test',client_run_id:'relink'},requestKey:'relink'}).save_id,{reason:'Save.'});save.undo(result.save_id);const replacement=path.join(root,'replacement.md');fs.writeFileSync(replacement,'replacement\n');const control=createResourceControl({stateDir});control.relink({resourceId:result.resource_id,filePath:replacement,caller:{tool:'test',client_run_id:'relink'}});assert.throws(()=>save.redo(result.save_id),/Resource facts changed/u);assert.equal(fs.existsSync(path.join(vault,'Projects','Atlas','result.md')),false);assert.equal(fs.readFileSync(replacement,'utf8'),'replacement\n');assert.equal(control.describe(result.resource_id).locations.filter((l)=>l.status==='active').length,1);assert.equal(save.show(result.save_id).redo_available,true);control.dispose();save.dispose();
});
