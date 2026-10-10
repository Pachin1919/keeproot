import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Registry } from '../src/registry.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { createCaptureSourceModule } from '../src/capture-source-module.js';
import { MODULE_PROTOCOL_VERSION, CAPABILITIES } from '../src/protocol.js';

function fixture(t) {
  fs.mkdirSync('test/.tmp', { recursive: true }); const root=fs.mkdtempSync(path.resolve('test/.tmp/capture-markdown-'));
  const stateDir=path.join(root,'state'),workspace=path.join(root,'workspace'),projectRoot=path.join(workspace,'A'),folder=path.join(projectRoot,'Sources');fs.mkdirSync(folder,{recursive:true});
  const registry=new Registry({stateDir});const adopted=registry.adoptRoot({rootPath:workspace,rootType:'project_workspace',contentPolicy:'structure_only'});const project=registry.create({name:'Markdown fixture',currentPath:'A'});
  registry.attachRoot(project.project_id,{rootId:adopted.root_id,relativePath:'A',reason:'capture Markdown fixture'});
  const save=createSaveService({stateDir});let fetches=0;let mode='article';
  const capture=createCaptureSourceService({stateDir,registry,saveService:save,lookupHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async()=>{
    fetches++;if(mode==='redirect-private')return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});
    if(mode==='expired')return new Response('Sign in private content',{status:403,headers:{'content-type':'text/html'}});
    if(mode==='oversized')return new Response('x'.repeat(8*1024*1024+1),{headers:{'content-type':'text/plain'}});
    return new Response('<html><title>Article</title><script>secret()</script><article><p>Public conclusion.</p><p>Second paragraph.</p></article></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
  }});
  t.after(()=>{capture.dispose();save.dispose();registry.dispose();});
  const request={url:'https://example.test/article#section',projectId:project.project_id,folder:'Sources',name:'article.md',requestKey:'markdown-one',caller:{tool:'fixture-host',client_run_id:'markdown-chain'}};
  return {root,stateDir,workspace,projectRoot,folder,registry,save,capture,request,fetches:()=>fetches,mode:value=>{mode=value;}};
}

test('public Markdown previews a true md candidate and Save/readback/Undo replay without refetch',async t=>{
  const f=fixture(t);const prepared=await f.capture.prepareMarkdown(f.request);const target=path.join(f.folder,'article.md');
  assert.equal(prepared.status,'prepared');assert.equal(fs.existsSync(target),false);assert.equal(prepared.source.kind,'public_markdown');assert.equal(prepared.source.path,undefined);
  assert.equal(prepared.target.resource_path,'Sources/article.md');assert.equal(prepared.capture_scope,'static_http_response_text');assert.match(prepared.completeness,/dynamic_content_not_proven/u);assert.ok(prepared.work_id);
  const candidate=f.save.candidateSnapshot(prepared.save_id);const body=fs.readFileSync(candidate.path,'utf8');assert.match(body,/# Article/u);assert.match(body,/Public conclusion/u);assert.doesNotMatch(body,/secret\(\)|atlas.source-capture.v1/u);
  const replay=await f.capture.prepareMarkdown({...f.request,url:'https://example.test/article#other',name:'article'});assert.equal(replay.save_id,prepared.save_id);assert.equal(f.fetches(),1);
  for(const changed of [{name:'other'},{folder:'.'},{url:'https://example.test/other'}])await assert.rejects(f.capture.prepareMarkdown({...f.request,...changed}),{code:'ATLAS_STATE_CONFLICT'});
  const review=f.save.review(prepared.save_id);assert.throws(()=>f.save.execute(prepared.save_id,{reason:'stale',expectedPreviewRevision:'0'.repeat(64)}),{code:'ATLAS_STATE_CONFLICT'});
  const executed=f.save.execute(prepared.save_id,{reason:'explicit fixture confirmation',expectedPreviewRevision:review.preview_revision});assert.equal(executed.status,'executed');assert.ok(executed.resource_id);assert.equal(fs.readFileSync(target,'utf8'),body);
  assert.equal((await f.capture.prepareMarkdown(f.request)).status,'executed');assert.equal(f.fetches(),1);
  assert.throws(()=>f.capture.read(prepared.save_id,{projectId:f.request.projectId}),{code:'ATLAS_STATE_CONFLICT'});
  const undone=f.save.undo(prepared.save_id,{reason:'fixture Undo'});assert.equal(undone.status,'undone');assert.equal(fs.existsSync(target),false);
  assert.equal((await f.capture.prepareMarkdown(f.request)).status,'undone');assert.equal(f.fetches(),1);assert.equal(fs.existsSync(target),false);
});

test('public Markdown replays an interrupted pending reservation without refetch or implicit write',async t=>{
  const f=fixture(t);
  const writeJournal=f.save.writeJournal;
  f.save.writeJournal=(stateDir,items)=>{
    writeJournal(stateDir,items);
    if(items.some(item=>item.status==='reserving'))throw Error('Fixture interruption after reservation journal');
  };
  const pending=await f.capture.prepareMarkdown(f.request);
  assert.equal(pending.status,'reserving');assert.equal(pending.project,null);
  assert.equal(pending.undo_available,false);assert.equal(pending.redo_available,false);
  const before=fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json'));
  const replay=await f.capture.prepareMarkdown(f.request);
  assert.equal(replay.save_id,pending.save_id);assert.equal(replay.status,'reserving');assert.equal(f.fetches(),1);
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json')),before);
  assert.equal(fs.existsSync(path.join(f.folder,'article.md')),false);
});

test('public Markdown refuses invalid scope/path/name/private redirect and oversized responses',async t=>{
  const f=fixture(t);
  for(const patch of [{url:'file:///private'},{url:'http://127.0.0.1/private'},{url:'https://user:password@example.test/private'},{folder:'../outside'},{folder:'missing'},{name:'../file'},{name:'.md'},{name:'CON'},{name:'file.'},{caller:{tool:'missing'}}])await assert.rejects(f.capture.prepareMarkdown({...f.request,...patch}));
  assert.equal(f.fetches(),0);
  const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.projectRoot,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(f.capture.prepareMarkdown({...f.request,folder:'linked'}));
  fs.writeFileSync(path.join(f.folder,'article.md'),'Existing');await assert.rejects(f.capture.prepareMarkdown(f.request));assert.equal(fs.readFileSync(path.join(f.folder,'article.md'),'utf8'),'Existing');
  f.mode('redirect-private');await assert.rejects(f.capture.prepareMarkdown({...f.request,name:'redirect',requestKey:'redirect'}),/private|local/u);
  f.mode('oversized');await assert.rejects(f.capture.prepareMarkdown({...f.request,name:'large',requestKey:'large'}),/exceeds|limit|bytes/iu);
  assert.equal(fs.existsSync(path.join(f.folder,'redirect.md')),false);assert.equal(fs.existsSync(path.join(f.folder,'large.md')),false);
});

test('public Markdown share fallback creates no fake candidate, and module gate prevents fetch',async t=>{
  const f=fixture(t);f.mode('expired');const fallback=await f.capture.prepareMarkdown({...f.request,url:'https://chatgpt.com/share/expired'});
  assert.equal(fallback.status,'export_required');assert.equal(fallback.save_id,undefined);assert.doesNotMatch(JSON.stringify(fallback),/private content/u);assert.equal(fs.existsSync(path.join(f.folder,'article.md')),false);
  const module=createCaptureSourceModule({captureSource:f.capture,availability:{assertActionEnabled(){throw Object.assign(Error('Disabled'),{code:'ATLAS_MODULE_DISABLED'});}}});
  await assert.rejects(module.invoke({protocol:MODULE_PROTOCOL_VERSION,module_id:'atlas.capture-source',project_id:f.request.projectId,action:'capture-markdown',parameters:f.request}),{code:'ATLAS_MODULE_DISABLED'});assert.equal(f.fetches(),1);
});

test('public Markdown module action and CLI discovery use ordinary Save confirmation',async t=>{
  const f=fixture(t);const module=createCaptureSourceModule({captureSource:f.capture});
  const result=await module.invoke({protocol:MODULE_PROTOCOL_VERSION,module_id:'atlas.capture-source',project_id:f.request.projectId,action:'capture-markdown',parameters:f.request});assert.equal(result.data.status,'prepared');
  assert.ok(CAPABILITIES.product_entrypoints.current_product.commands.includes('capture source prepare-markdown'));
  const help=spawnSync(process.execPath,['bin/atlas.js','--help'],{encoding:'utf8',timeout:10000});assert.equal(help.status,0);assert.match(help.stdout,/capture source prepare-markdown/u);
  const invalid=spawnSync(process.execPath,['bin/atlas.js','capture','source','prepare-markdown','--url','http://127.0.0.1/private','--project',f.request.projectId,'--folder','Sources','--name','cli','--request-key','cli-one','--tool','fixture','--client-run-id','cli-fixture','--json'],{encoding:'utf8',timeout:10000,env:{...process.env,ATLAS_STATE_DIR:f.stateDir}});
  assert.equal(invalid.status,1);const envelope=JSON.parse(invalid.stdout);assert.equal(envelope.ok,false);assert.match(envelope.error.message,/private|local/u);assert.equal(fs.existsSync(path.join(f.folder,'cli.md')),false);
});
