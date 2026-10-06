import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';

test('legacy merge refuses metadata-only mutation and directs the Host to a membership preview', () => {
  const directory=fs.mkdtempSync(path.resolve('test/.tmp/membership-cli-compat-'));
  const stateDir=path.join(directory,'state');
  const registry=new Registry({stateDir});
  try {
    const source=registry.create({name:'Source',currentPath:'Source'});
    const target=registry.create({name:'Target',currentPath:'Target'});
    const before=registry.show(source.project_id);
    const result=spawnSync(process.execPath,['bin/atlas.js','project','merge','--source',source.project_id,'--into',target.project_id,'--json'],{
      cwd:path.resolve('.'),env:{...process.env,ATLAS_STATE_DIR:stateDir},windowsHide:true,encoding:'utf8',timeout:30000,
    });
    assert.equal(result.status,1,result.stdout+result.stderr);
    const response=JSON.parse(result.stdout);
    assert.equal(response.ok,false);
    assert.match(response.error.message,/project membership prepare --request-file/u);
    assert.match(response.error.message,/operation.*merge/u);
    assert.deepEqual(registry.show(source.project_id),before);
  } finally {registry.dispose();}
});
