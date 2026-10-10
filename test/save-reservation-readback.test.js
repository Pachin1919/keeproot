import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createSaveService } from '../src/save-service.js';

test('pending Save reservation readback preserves identity without granting recovery or writing a target', async (t) => {
  const tmp = path.resolve('test/.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmp, 'save-reservation-readback-'));
  t.after(() => {
    assert.equal(path.dirname(root), tmp);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const stateDir = path.join(root, 'state');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, 'Project'), { recursive: true });
  const candidate = path.join(root, 'candidate.md');
  fs.writeFileSync(candidate, '# Pending capture\n');
  const registry = new Registry({ stateDir });
  const project = registry.create({ name: 'Project', currentPath: 'Project' });
  registry.dispose();
  const caller = { tool: 'test', client_run_id: 'pending-readback' };
  const moduleUrl = new URL('../src/save-service.js', import.meta.url).href;
  const script = `import { createSaveService } from ${JSON.stringify(moduleUrl)};
    const save=createSaveService({stateDir:process.argv[1],intake:{prepare(){process.exit(23)},dispose(){}}});
    save.prepare({root:process.argv[2],candidateFile:process.argv[3],projectId:process.argv[4],target:'Project/result.md',origin:'agent_generated',kind:'intermediate',channel:'host',caller:{tool:'test',client_run_id:'pending-readback'},requestKey:'pending-readback'});`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, stateDir, vault, candidate, project.project_id], { windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 23 ? resolve() : reject(new Error(`reservation child exited ${code}`)));
  });
  const journal = path.join(stateDir, 'ui/saved-work.json');
  const bytesBefore = fs.readFileSync(journal);
  const row = JSON.parse(bytesBefore).items[0];
  assert.equal(row.status, 'reserving');
  assert.equal(row.project, null);
  const save = createSaveService({ stateDir });
  try {
    for (const shown of [save.show(row.save_id), save.findByRequestKey({ channel: 'host', caller, requestKey: 'pending-readback' })]) {
      assert.equal(shown.save_id, row.save_id);
      assert.equal(shown.status, 'reserving');
      assert.equal(shown.project, null);
      assert.equal(shown.target.relative_path, 'Project/result.md');
      assert.equal(shown.undo_available, false);
      assert.equal(shown.redo_available, false);
      assert.equal(shown.verified, false);
    }
    assert.deepEqual(fs.readFileSync(journal), bytesBefore);
    assert.equal(fs.existsSync(path.join(vault, 'Project/result.md')), false);
  } finally { save.dispose(); }
});
