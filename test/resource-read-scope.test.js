import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { SaveService } from '../src/save-service.js';
import { Intake } from '../src/intake.js';
import { createBoardService } from '../src/board-service.js';
import { startAtlasUiServer } from '../src/ui-server.js';
function fixture(t) {
 const directory=fs.mkdtempSync(path.resolve('test/.tmp/read-scope-'));const stateDir=path.join(directory,'state'),workspace=path.join(directory,'workspace'),folder=path.join(workspace,'研究');fs.mkdirSync(folder,{recursive:true});
 const registry=new Registry({stateDir});const root=registry.adoptRoot({rootPath:workspace,rootType:'project_workspace',contentPolicy:'bounded_content'});const project=registry.create({name:'研究',currentPath:'研究'});registry.attachRoot(project.project_id,{rootId:root.root_id,relativePath:'研究',reason:'read scope fixture'});
 const control=new ResourceControl({stateDir,registry});const file=path.join(folder,'当前.md');fs.writeFileSync(file,'# 正文\n\n代表材料。');const resource=control.identify({filePath:file,project:registry.show(project.project_id).project});
 const unrelated=[];for(let n=0;n<16;n++){const f=path.join(folder,`资料${n}.txt`);fs.writeFileSync(f,'x'.repeat(32768));control.identify({filePath:f,project:registry.show(project.project_id).project});unrelated.push(f);}
 const saveService=new SaveService({stateDir,resourceControl:control}),intake=new Intake({stateDir});let server;
 t.after(async()=>{if(server)await server.close();intake.dispose();saveService.dispose();control.dispose();registry.dispose();fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return {stateDir,workspace,registry,control,saveService,intake,projectId:project.project_id,file,resourceId:resource.resource_id,unrelated,setServer(value){server=value;}};
}
function observe(paths) {
 const tracked=new Set(paths.map(p=>path.resolve(p)));const descriptors=new Map();const reads=[];let readingFile=0;const open=fs.openSync,read=fs.readSync,close=fs.closeSync,readFile=fs.readFileSync;
 fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(!readingFile&&typeof file==='string'&&tracked.has(path.resolve(file)))descriptors.set(fd,path.resolve(file));return fd;};
 fs.readSync=function(fd,...args){const bytes=read.call(this,fd,...args);if(descriptors.has(fd)&&bytes)reads.push({path:descriptors.get(fd),bytes});return bytes;};
 fs.closeSync=function(fd,...args){descriptors.delete(fd);return close.call(this,fd,...args);};
 fs.readFileSync=function(file,...args){readingFile++;try{const value=readFile.call(this,file,...args);if(typeof file==='string'&&tracked.has(path.resolve(file)))reads.push({path:path.resolve(file),bytes:Buffer.byteLength(value)});return value;}finally{readingFile--;}};
 return {reads,restore(){fs.openSync=open;fs.readSync=read;fs.closeSync=close;fs.readFileSync=readFile;}};
}
test('Single Resource refresh checks only that scoped Resource; explicit Project refresh still checks every file',t=>{
 const f=fixture(t);fs.appendFileSync(f.file,'\n来源后改。');const measured=observe([f.file,...f.unrelated]);
 try {
  const current=f.control.projectResource(f.projectId,f.resourceId,{refresh:true});
  assert.equal(current.external_change.status,'changed');assert.notEqual(current.external_change.current.sha256,current.content_hash);
  assert.deepEqual([...new Set(measured.reads.map(x=>x.path))],[f.file]);
  const count=measured.reads.length;assert.throws(()=>f.control.projectResource('PRJ-foreign',f.resourceId,{refresh:true}),/unavailable/);assert.equal(measured.reads.length,count);
  measured.reads.length=0;f.control.projectResources(f.projectId,{refresh:true});assert.equal(new Set(measured.reads.map(x=>x.path)).size,17);
 } finally {measured.restore();}
});
test('Opening a Board verifies referenced content without hashing unrelated Project files',async t=>{
 const f=fixture(t);const boards=createBoardService({stateDir:f.stateDir,registry:f.registry,resourceControl:f.control,saveService:f.saveService});const created=boards.createBoard({projectId:f.projectId,title:'按需读取'});
 const board=boards.saveBoard({projectId:f.projectId,boardId:created.board_id,title:created.title,baseRevision:created.revision,blocks:[{type:'material_reference',resource_id:f.resourceId,version_policy:'pinned_version'}]});
 const server=await startAtlasUiServer({stateDir:f.stateDir,registry:f.registry,resourceControl:f.control,saveService:f.saveService,intake:f.intake,projectRoot:f.workspace,installationRoot:f.workspace});f.setServer(server);
 const measured=observe([f.file,...f.unrelated]);try {
  const start=performance.now();const response=await fetch(new URL(`/projects/${f.projectId}/boards/${board.board_id}`,server.workspace_url));const html=await response.text();assert.equal(response.status,200);assert.match(html,/代表材料/);
  const unrelated=measured.reads.filter(x=>f.unrelated.includes(x.path));assert.equal(unrelated.length,0,'Board should not read unreferenced file bodies');
  t.diagnostic(JSON.stringify({milliseconds:Math.round(performance.now()-start),bytes:measured.reads.reduce((n,x)=>n+x.bytes,0),files:new Set(measured.reads.map(x=>x.path)).size}));
  fs.appendFileSync(f.file,'\n后改内容');const current=boards.showBoard(f.projectId,board.board_id);assert.notEqual(current.blocks[0].status,'fresh');assert.ok(!current.blocks[0].preview,'pinned changed content stays hidden');
 }finally{measured.restore();}
});
