import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';

test('legacy project move explains preview migration without changing files or Registry', () => {
  const directory = fs.mkdtempSync(path.resolve('test/.tmp/project-move-cli-compat-'));
  const stateDir = path.join(directory, 'state');
  const source = path.join(directory, '项目');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'note.md'), '# retained\n');
  const registry = new Registry({ stateDir });
  try {
    const { project_id: projectId } = registry.create({ name: '项目', currentPath: '项目' });
    const before = registry.show(projectId);
    const result = spawnSync(process.execPath, ['bin/atlas.js', 'project', 'move', projectId,
      '--path', path.join(directory, '新目录'), '--json'], {
      cwd: path.resolve('.'), env: { ...process.env, ATLAS_STATE_DIR: stateDir },
      windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 1, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, false);
    assert.match(response.error.message, /project move prepare --request-file/u);
    assert.match(response.error.message, /targetRelativePath/u);
    assert.match(response.error.message, /expectedRevision/u);
    assert.deepEqual(registry.show(projectId), before);
    assert.equal(fs.readFileSync(path.join(source, 'note.md'), 'utf8'), '# retained\n');
    assert.equal(fs.existsSync(path.join(directory, '新目录')), false);
  } finally { registry.dispose(); }
});
