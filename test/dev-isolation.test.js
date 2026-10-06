import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolationCommand } from '../scripts/dev-isolation.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Command composition only; no interpreter is launched by these tests.
const python=process.execPath;
const demoId='c083d15e-3590-45ba-b9da-dff57a18d702';
const ambient={ATLAS_HOME:'C:/formal',ATLAS_STATE_DIR:'C:/formal/state',ATLAS_CONTENT_PYTHON:'C:/wrong/highest.exe',ATLAS_TEST_PYTHON:'C:/wrong/test.exe',ATLAS_PYTHON:'C:/wrong/fallback.exe',ATLAS_DESKTOP_PYTHON:'C:/wrong/desktop.exe'};
function installation(t){
  const root=fs.mkdtempSync(path.join(repo,'test/.tmp/isolation-command-'));
  fs.mkdirSync(path.join(root,'runtime/bin'),{recursive:true}); fs.mkdirSync(path.join(root,'state'));
  fs.writeFileSync(path.join(root,'runtime/bin/atlas.js'),'// bounded command fixture; never run');
  fs.writeFileSync(path.join(root,'atlas-install.json'),JSON.stringify({install_format:'atlas-runtime-install.v1',runtime_path:path.join(root,'runtime'),state_path:path.join(root,'state')}));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:5}));return root;
}
test('source tests share the highest priority Python and cannot inherit formal state',()=>{
  const command=isolationCommand({repositoryRoot:repo,mode:'tests',python,testFiles:['test/product-demo.test.js']},ambient);
  assert.equal(command.env.ATLAS_CONTENT_PYTHON,python); assert.equal(command.env.ATLAS_TEST_PYTHON,python);
  assert.equal(command.env.ATLAS_HOME,undefined); assert.equal(command.env.ATLAS_STATE_DIR,undefined);
  assert.equal(command.env.ATLAS_DESKTOP_PYTHON,undefined); assert.ok(command.args.includes('--test-concurrency=1')); assert.ok(command.args.includes('--test-timeout=30000'));
});
test('source demo reuses the existing complete assembly with one explicit Python',()=>{
  const command=isolationCommand({repositoryRoot:repo,mode:'demo',python,demoId},ambient);
  assert.equal(command.env.ATLAS_HOME,undefined); assert.equal(command.env.ATLAS_STATE_DIR,undefined);
  assert.equal(command.env.ATLAS_CONTENT_PYTHON,python); assert.ok(command.args.includes('--resume')); assert.ok(command.args.includes(demoId));
});
test('installed HTML uses manifest state and managed Python instead of ambient overrides',t=>{
  const installRoot=installation(t),command=isolationCommand({repositoryRoot:repo,mode:'installed-ui',installRoot},ambient);
  assert.equal(command.env.ATLAS_HOME,installRoot); assert.equal(command.env.ATLAS_STATE_DIR,path.join(installRoot,'state'));
  for(const name of ['ATLAS_CONTENT_PYTHON','ATLAS_TEST_PYTHON','ATLAS_PYTHON','ATLAS_DESKTOP_PYTHON'])assert.equal(command.env[name],undefined);
  assert.deepEqual(command.args.slice(1),['ui','--no-open','--port','0','--json']);
});
test('development launcher refuses a formal installation before invoking any process',()=>{
  assert.throws(()=>isolationCommand({repositoryRoot:repo,mode:'installed-ui',installRoot:'C:/Example/Atlas'},ambient),/test.*\.tmp|isolated/i);
});
test('development launcher refuses state outside its isolated installation',t=>{
  const installRoot=installation(t);
  assert.throws(()=>isolationCommand({repositoryRoot:repo,mode:'installed-ui',installRoot,stateDir:path.join(repo,'.atlas/elsewhere')},ambient),/inside|installation/i);
});
test('development launcher refuses a junction state while retaining its external marker',t=>{
  const installRoot=installation(t),other=fs.mkdtempSync(path.join(repo,'test/.tmp/isolation-marker-'));
  t.after(()=>fs.rmSync(other,{recursive:true,force:true,maxRetries:5}));
  fs.writeFileSync(path.join(other,'keep.txt'),'preserve');
  fs.symlinkSync(other,path.join(installRoot,'linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>isolationCommand({repositoryRoot:repo,mode:'installed-ui',installRoot,stateDir:path.join(installRoot,'linked')},ambient),/link|junction/i);
  assert.equal(fs.readFileSync(path.join(other,'keep.txt'),'utf8'),'preserve');
});
