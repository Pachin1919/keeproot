import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {prepareProductDemo,serveProductDemo,loadProductDemo} from '../scripts/demo.js';
import {isPathInside} from '../src/paths.js';
import {Registry} from '../src/registry.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('demo UI assembles the rule service and shows an empty Project without creating rules',async t=>{
  const temp=fs.mkdtempSync(path.join(repo,'test/.tmp/product-demo-rules-'));
  const root=path.join(temp,'library');fs.mkdirSync(path.join(root,'资料'),{recursive:true});
  const stateDir=path.join(temp,'state');
  const registry=new Registry({stateDir});
  const adopted=registry.adoptRoot({rootPath:root,rootType:'managed_library',contentPolicy:'bounded_content'});
  const projectId=registry.create({name:'资料',currentPath:'资料'}).project_id;
  registry.attachRoot(projectId,{rootId:adopted.root_id,relativePath:'资料',reason:'Isolated empty-rule UI fixture.'});
  registry.dispose();
  let session;
  t.after(async()=>{if(session)await session.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5});});
  session=await serveProductDemo({state_dir:stateDir,board_href:`/projects/${projectId}`},{python:process.execPath});
  const response=await fetch(session.url+'/rules');
  const html=await response.text();
  assert.equal(response.status,200,html);
  assert.match(html,/No proposals awaiting confirmation/u);
  assert.match(html,/No confirmed rules yet/u);
  assert.match(html,/No confirmed Library rules/u);
  assert.doesNotMatch(html,/Confirm rule|Confirm deactivation/u);
});
function isolatedScript(t){
  const root=fs.mkdtempSync(path.join(repo,'test/.tmp/product-demo-command-'));
  const fake=path.join(root,'repository');
  for(const dir of ['scripts','src','fixtures'])fs.mkdirSync(path.join(fake,dir),{recursive:true});
  fs.copyFileSync(path.join(repo,'scripts/demo.js'),path.join(fake,'scripts/demo.js'));
  fs.copyFileSync(path.join(repo,'src/paths.js'),path.join(fake,'src/paths.js'));
  fs.writeFileSync(path.join(fake,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(fake,'src/tracker.js'),'export class Tracker { constructor(){throw new Error("legacy stopped after cleanup");} }');
  fs.cpSync(path.join(repo,'fixtures/demo-vault'),path.join(fake,'fixtures/demo-vault'),{recursive:true});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:5}));
  return {root,fake,run:args=>spawnSync(process.execPath,[path.join(fake,'scripts/demo.js'),...args],{encoding:'utf8',timeout:15000,windowsHide:true})};
}

test('demo help preserves the previous demonstration and creates no new workspace',t=>{
  const f=isolatedScript(t),previous=path.join(f.fake,'.atlas/demo');
  fs.mkdirSync(previous,{recursive:true});
  const marker=path.join(previous,'previous-user-result.txt');fs.writeFileSync(marker,'keep previous demonstration');
  const result=f.run(['--help']);
  assert.equal(fs.readFileSync(marker,'utf8'),'keep previous demonstration');
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/--python/);
  assert.equal(fs.existsSync(path.join(f.fake,'test/.tmp')),false);
});

test('demo resume rejects path syntax before reading any manifest',()=>{
  for(const id of ['../outside','C:/Users/example','00000000-0000-0000-0000-000000000000'])assert.throws(()=>loadProductDemo(id),/UUID demo-id/);
});

test('demo refuses a linked state parent before touching its target',t=>{
  const f=isolatedScript(t),outside=path.join(f.root,'outside');
  fs.mkdirSync(path.join(outside,'demo'),{recursive:true});
  const marker=path.join(outside,'demo/retained.txt');fs.writeFileSync(marker,'outside retained');
  fs.symlinkSync(outside,path.join(f.fake,'.atlas'),process.platform==='win32'?'junction':'dir');
  const result=f.run(['--python',process.execPath]);
  assert.equal(fs.readFileSync(marker,'utf8'),'outside retained');
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/symbolic link|junction/);
  assert.equal(fs.existsSync(path.join(f.fake,'test/.tmp')),false);
});

test('current-product demo creates one verified three-row Result and a readable three-kind Board',async t=>{
  const python=process.env.ATLAS_TEST_PYTHON;
  if(!python || !fs.existsSync(python)){t.skip('Provide ATLAS_TEST_PYTHON for the actual product demonstration.');return;}
  const demo=prepareProductDemo({python});
  let session,passed=false;
  t.after(async()=>{
    if(session)await session.close();
    if(!passed)return; // Preserve failed examples for diagnosis.
    for(const [target,parent] of [[demo.state_dir,path.join(repo,'.atlas/demo')],[path.dirname(demo.workspace),path.join(repo,'test/.tmp')]]){
      assert.ok(isPathInside(parent,target));assert.notEqual(path.resolve(parent),path.resolve(target));
      assert.ok(isPathInside(parent,fs.realpathSync(target)));
      fs.rmSync(target,{recursive:true,force:true,maxRetries:5});
    }
  });
  assert.equal(demo.phase,'ready');
  assert.equal(isPathInside(demo.project_path,demo.import_source),false);
  assert.ok(fs.readFileSync(demo.import_source).equals(fs.readFileSync(path.join(repo,'fixtures/product-demo/新线索.txt'))));
  const rows=fs.readFileSync(demo.result_path,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(line=>line.split(','));
  assert.deepEqual(rows,[['id','region','amount'],['1','北区','100'],['2','南区','80'],['3','北区','20']]);
  assert.equal(rows.slice(1).reduce((sum,row)=>sum+Number(row[2]),0),200);
  const shown=spawnSync(process.execPath,[path.join(repo,'bin/atlas.js'),'board','show',demo.board_id,'--project',demo.project_id,'--json'],{encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,ATLAS_STATE_DIR:demo.state_dir,ATLAS_CONTENT_PYTHON:python}});
  assert.equal(shown.status,0,shown.stderr+shown.stdout);
  const receipt=JSON.parse(shown.stdout);assert.equal(receipt.ok,true);
  assert.deepEqual(receipt.data.blocks.map(block=>block.type),['material_reference','text','result_preview']);
  assert.equal(receipt.data.blocks[2].save_id,demo.save_id);
  session=await serveProductDemo(demo,{python});
  const response=await fetch(session.url);assert.equal(response.status,200);
  const html=await response.text();assert.match(html,/金额合计200/);assert.match(html,/北区/);assert.match(html,/南区/);
  await session.close();session=null;
  assert.ok(fs.existsSync(demo.result_path),'closing the UI retains results');
  const reopened=loadProductDemo(demo.demo_id);
  assert.equal(reopened.work_id,demo.work_id);assert.equal(reopened.save_id,demo.save_id);
  assert.equal(reopened.board_id,demo.board_id);assert.equal(reopened.result_path,demo.result_path);
  const manifest=JSON.parse(fs.readFileSync(demo.manifest_path,'utf8'));
  fs.writeFileSync(demo.manifest_path,JSON.stringify({...manifest,workspace:repo}));
  assert.throws(()=>loadProductDemo(demo.demo_id),/does not match/);
  fs.writeFileSync(demo.manifest_path,JSON.stringify(manifest));
  for(const file of ['本期.csv','补充.csv','演示说明.md'])assert.ok(fs.readFileSync(path.join(demo.project_path,'01_资料',file)).equals(fs.readFileSync(path.join(repo,'fixtures/product-demo',file))));
  assert.equal(JSON.parse(fs.readFileSync(demo.manifest_path,'utf8')).save_id,demo.save_id);
  passed=true;
});
