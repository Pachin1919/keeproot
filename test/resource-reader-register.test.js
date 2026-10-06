import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { createResourceReaderService } from '../src/resource-reader-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';

function fixture(t) {
  const directory=fs.mkdtempSync(path.resolve('test/.tmp/reader-register-'));
  const stateDir=path.join(directory,'state'),workspace=path.join(directory,'workspace'),root=path.join(workspace,'材料');
  fs.mkdirSync(root,{recursive:true});
  const registry=new Registry({stateDir});
  const adopted=registry.adoptRoot({rootPath:workspace,rootType:'project_workspace',contentPolicy:'bounded_content'});
  const id=registry.create({name:'材料',currentPath:'材料'}).project_id;
  registry.attachRoot(id,{rootId:adopted.root_id,relativePath:'材料',reason:'Explicit reader fixture'});
  const control=new ResourceControl({stateDir,registry});
  const service=createResourceReaderService({registry,resourceControl:control});
  const f={directory,stateDir,workspace,root,registry,control,service,id,shutdown:null};
  t.after(async()=>{if(f.shutdown)await f.shutdown();control.dispose();registry.dispose();fs.rmSync(directory,{recursive:true,force:true,maxRetries:5});});
  return f;
}

test('explicit Project file reading registers one identity and preserves source and later baseline',t=>{
  const f=fixture(t),file=path.join(f.root,'说明.md'),text='# 中文说明\n\nOriginal.';
  fs.writeFileSync(file,text);
  assert.equal(f.control.projectResources(f.id).length,0);
  const first=f.service.registerProjectFile({projectId:f.id,relativePath:'说明.md'});
  assert.equal(f.service.read({projectId:f.id,resourceId:first.resource_id}).text,text);
  const baseline=JSON.stringify(f.control.describe(first.resource_id));
  const again=f.service.registerProjectFile({projectId:f.id,relativePath:'说明.md'});
  assert.equal(again.resource_id,first.resource_id);assert.equal(f.control.projectResources(f.id).length,1);
  assert.equal(JSON.stringify(f.control.describe(first.resource_id)),baseline);
  assert.equal(fs.readFileSync(file,'utf8'),text);
  fs.writeFileSync(file,'# Later external change');
  const later=f.service.registerProjectFile({projectId:f.id,relativePath:'说明.md'});
  assert.equal(later.resource_id,first.resource_id);
  assert.equal(JSON.stringify(f.control.describe(first.resource_id)),baseline);
  assert.equal(f.service.read({projectId:f.id,resourceId:first.resource_id}).text,'# Later external change');
});

test('Project file registration rejects escapes links oversized unsupported ownership and pending recovery before writes',t=>{
  const f=fixture(t),count=()=>f.control.ledger.db.prepare('SELECT count(*) n FROM resources').get().n;
  fs.writeFileSync(path.join(f.root,'普通.txt'),'bounded');
  fs.writeFileSync(path.join(f.root,'unsupported.exe'),'not software');
  fs.writeFileSync(path.join(f.root,'large.txt'),Buffer.alloc(256*1024+1));
  const outside=path.join(f.directory,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret.txt'),'DO NOT READ');
  fs.symlinkSync(outside,path.join(f.root,'linked'),process.platform==='win32'?'junction':'dir');
  for(const relativePath of ['../outside/secret.txt',path.join(outside,'secret.txt'),'普通.txt:stream','linked/secret.txt','large.txt','unsupported.exe','.']) {
    assert.throws(()=>f.service.registerProjectFile({projectId:f.id,relativePath}));assert.equal(count(),0);
  }
  assert.throws(()=>f.service.registerProjectFile({projectId:'PRJ-missing',relativePath:'普通.txt'}));assert.equal(count(),0);
  const other=path.join(f.workspace,'其他');fs.mkdirSync(other);
  const otherId=f.registry.create({name:'其他',currentPath:'其他'}).project_id;
  f.registry.attachRoot(otherId,{rootId:f.registry.show(f.id).location.root_id,relativePath:'其他',reason:'Other fixture'});
  const owned=f.control.identify({filePath:path.join(f.root,'普通.txt'),project:f.registry.show(otherId).project});
  const before=JSON.stringify(f.control.describe(owned.resource_id));
  assert.throws(()=>f.service.registerProjectFile({projectId:f.id,relativePath:'普通.txt'}));
  assert.equal(JSON.stringify(f.control.describe(owned.resource_id)),before);assert.equal(count(),1);
  const restoredPath=path.join(f.root,'restored.txt');fs.writeFileSync(restoredPath,'a returned file');
  const missing=f.control.identify({filePath:restoredPath,project:f.registry.show(f.id).project});
  f.control.ledger.resources.markLocationMissing(missing.locations[0].id,new Date().toISOString());
  assert.throws(()=>f.service.registerProjectFile({projectId:f.id,relativePath:'restored.txt'}),/Restore or relink/);
  assert.equal(count(),2,'a missing record must not silently become another Resource');
  fs.writeFileSync(path.join(f.root,'pending.md'),'# Pending');
  f.registry.ledger.db.prepare('INSERT INTO recovery_rounds(id,project_id,revision,state_json,updated_at) VALUES(?,?,?,?,?)')
    .run('RND-reader-pending',f.id,1,JSON.stringify({pending_restore:'restore-test'}),new Date().toISOString());
  assert.throws(()=>f.service.registerProjectFile({projectId:f.id,relativePath:'pending.md'}),{code:'ATLAS_RECOVERY_INCOMPLETE'});
  assert.equal(count(),2);assert.equal(fs.readFileSync(path.join(outside,'secret.txt'),'utf8'),'DO NOT READ');
});

test('HTML explicit Read on an unregistered Project file uses CSRF and returns to the same folder with shared identity',async t=>{
  const f=fixture(t),file=path.join(f.root,'说明.md'),text='# 中文说明\n\nA readable local file.';fs.writeFileSync(file,text);
  const intake=new Intake({stateDir:f.stateDir});let externalOpens=0;
  const server=await startAtlasUiServer({stateDir:f.stateDir,registry:f.registry,resourceControl:f.control,intake,host:'127.0.0.1',port:0,
    openLocalFileFn:async()=>{externalOpens++;}});
  f.shutdown=async()=>{await server.close();intake.dispose();};
  const base=`/projects/${f.id}/resources`,url=new URL(`${base}?path=${encodeURIComponent('说明.md')}&folder=`,server.workspace_url);
  const page=await (await fetch(url)).text();
  assert.match(page,/action="[^"]+\/resources\/read-file"/u);assert.equal(f.control.projectResources(f.id).length,0);
  const csrf=page.match(/name="csrf" value="([^"]+)"/u)?.[1];assert.ok(csrf);
  const post=(token,relativePath,returnTo=base+'?folder=')=>fetch(new URL(`${base}/read-file`,server.workspace_url),{method:'POST',redirect:'manual',body:new URLSearchParams({csrf:token,path:relativePath,return_to:returnTo})});
  assert.equal((await post('bad','说明.md')).status,403);assert.equal(f.control.projectResources(f.id).length,0);
  assert.notEqual((await post(csrf,'../secret.txt')).status,303);assert.equal(f.control.projectResources(f.id).length,0);
  const first=await post(csrf,'说明.md');assert.equal(first.status,303);
  const href=first.headers.get('location'),id=new URL(href,server.workspace_url).searchParams.get('resource_id');assert.ok(id);
  const reader=await fetch(new URL(href,server.workspace_url));assert.equal(reader.status,200);
  const html=await reader.text();assert.match(html,/A readable local file/u);assert.ok(html.includes(id));
  assert.ok(html.includes(`href="${base}?folder=&amp;resource_id=${id}"`));
  assert.equal((await post(csrf,'说明.md')).headers.get('location'),href);assert.equal(f.control.projectResources(f.id).length,1);
  const maliciousReturn=await post(csrf,'说明.md','https://outside.invalid/');
  const safeReturn=new URL(maliciousReturn.headers.get('location'),server.workspace_url).searchParams.get('return_to');
  assert.equal(safeReturn,base+'?resource_id='+id);
  assert.equal(externalOpens,0);assert.equal(fs.readFileSync(file,'utf8'),text);
  assert.equal(f.control.projectResource(f.id,id).content_hash,crypto.createHash('sha256').update(text).digest('hex'));
});
