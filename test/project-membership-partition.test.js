import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createBoardService } from '../src/board-service.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createProjectMembershipService } from '../src/project-membership-service.js';
import { projectMoveWrite } from '../src/project-move-writer.js';
const caller={tool:'fixture',client_run_id:'partition'};
function fixture(t,hooks={}){
  const base=fs.mkdtempSync(path.resolve('test/.tmp/partition-'));const stateDir=path.join(base,'state');const root=path.join(base,'root');const parent=path.join(root,'客户工作');
  for(const name of ['交付','研究']){fs.mkdirSync(path.join(parent,name),{recursive:true});fs.writeFileSync(path.join(parent,name,'package.json'),JSON.stringify({name:`fixture-${name}`}));fs.writeFileSync(path.join(parent,name,'source.csv'),'kind,value\nA,1\n');}
  const registry=new Registry({stateDir});const adopted=registry.adoptRoot({rootPath:root,rootType:'project_workspace'});const source=registry.create({name:'客户工作',currentPath:'客户工作'});registry.attachRoot(source.project_id,{rootId:adopted.root_id,relativePath:'客户工作',reason:'fixture'});
  const control=createResourceControl({stateDir,registry});const save=createSaveService({stateDir,resourceControl:control});const boards=createBoardService({stateDir,registry,resourceControl:control,saveService:save});const sides={};
  for(const name of ['交付','研究']){const file=path.join(parent,name,'source.csv');const resource=control.identify({filePath:file,project:{id:source.project_id}});const work=registry.ledger.workSessions.create({projectId:source.project_id,resourceIds:[resource.resource_id],at:new Date().toISOString()});registry.ledger.workSessions.updateSource(work.session_id,work.sources[0].source_key,{fingerprint:{file_path:file,sha256:resource.evidence.sha256},status:'ready'},new Date().toISOString());
    const candidate=path.join(stateDir,`${name}.csv`);fs.writeFileSync(candidate,'kind,value\nA,2\n');const p=save.prepare({root,projectId:source.project_id,candidateFile:candidate,target:`客户工作/${name}/result.csv`,inputs:[file],origin:'agent_generated',kind:'intermediate',channel:'host',requestKey:name,caller,source:{resource_id:resource.resource_id,path:file,fingerprint:{file_path:file,sha256:resource.evidence.sha256}}});const saved=save.execute(p.save_id,{reason:'fixture'});registry.ledger.workSessions.setLatestSave(work.session_id,saved.save_id,new Date().toISOString());
    const b=boards.createBoard({projectId:source.project_id,title:name});const board=boards.saveBoard({projectId:source.project_id,boardId:b.board_id,title:name,baseRevision:b.revision,blocks:[{type:'material_reference',resource_id:resource.resource_id},{type:'text',text:'Keep this text'},{type:'result_preview',save_id:saved.save_id}]});sides[name]={resource,work,saved,board,file};}
  let moveCalls=0;const service=createProjectMembershipService({stateDir,registry,resourceControl:control,writer:input=>{if(input.mode!=='inspect')moveCalls++;return projectMoveWrite(input);},...hooks});
  const prepare=(extra={})=>service.prepare({operation:'split',mode:'partition_existing',sourceProjectId:source.project_id,retainedRelativePath:'交付',sourceRelativePath:'研究',newProjectName:'研究',requestKey:'partition',caller,...extra});const options=(r,key)=>({sourceProjectId:source.project_id,expectedRevision:r.revision,expectedDigest:r.digest,requestKey:key,caller});
  t.after(()=>{service.dispose();boards.dispose();save.dispose();control.dispose();registry.dispose();fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
  return {base,stateDir,root,parent,registry,source,control,save,boards,sides,service,prepare,options,getMoveCalls:()=>moveCalls};
}
test('partition existing narrows A and binds B without moving files; IDs and consumers continue',t=>{
  const f=fixture(t);const receipt=fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json'));const p=f.prepare();assert.equal(p.mode,'partition_existing');assert.equal(p.can_execute,true);assert.equal(p.files_moved,false);assert.deepEqual(p.file_changes,[]);assert.equal(p.source.path,p.target.path);
  assert.equal(f.registry.ledger.db.prepare('SELECT id FROM projects WHERE id=?').get(p.new_project.id),undefined);const before=projectMoveWrite({mode:'inspect',root:f.root,source:f.parent,target:f.parent});
  const a=f.service.execute(p.operation_id,f.options(p,'execute'));assert.equal(a.status,'applied');assert.equal(f.getMoveCalls(),0);assert.equal(f.registry.show(f.source.project_id).project.current_path,'客户工作/交付');assert.equal(f.registry.show(a.target_project_id).project.current_path,'客户工作/研究');assert.deepEqual(projectMoveWrite({mode:'inspect',root:f.root,source:f.parent,target:f.parent}).manifest,before.manifest);
  const data=createDataWorkService({stateDir:f.stateDir,resourceControl:f.control});
  for(const [name,s]of Object.entries(f.sides)){const projectId=name==='交付'?f.source.project_id:a.target_project_id;assert.equal(data.session(s.work.session_id).project_id,projectId);assert.equal(data.session(s.work.session_id).sources[0].file_path,s.file);assert.ok(data.session(s.work.session_id).revision>s.work.revision);const saved=f.save.show(s.saved.save_id);assert.equal(saved.project.id,projectId);assert.equal(saved.current_output,'verified');assert.equal(saved.target.path,path.join(f.parent,name,'result.csv'));assert.equal(saved.target.resource_path,'result.csv');assert.equal(saved.project.path,path.join(f.parent,name));const board=f.boards.showBoard(projectId,s.board.board_id);assert.deepEqual(board.blocks.map(b=>b.block_id),s.board.blocks.map(b=>b.block_id));assert.equal(board.blocks[2].status,'fresh');assert.throws(()=>f.save.undo(s.saved.save_id),{code:'ATLAS_STATE_CONFLICT'});}
  assert.throws(()=>f.control.projectResource(f.source.project_id,f.sides.研究.resource.resource_id));assert.deepEqual(fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json')),receipt);assert.equal(f.registry.projectContext.getActiveIdentity(f.source.project_id).evidence.manifest.value,'fixture-交付');assert.equal(f.registry.projectContext.getActiveIdentity(a.target_project_id).evidence.manifest.value,'fixture-研究');
});

test('partition Undo restores original boundary and IDs, retains history and original receipts',t=>{
  const f=fixture(t);const raw=fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json'));const p=f.prepare();const a=f.service.execute(p.operation_id,f.options(p,'execute'));const before=f.registry.ledger.db.prepare('SELECT count(*) n FROM project_locations').get().n;
  const reopened=createProjectMembershipService({stateDir:f.stateDir});let u;
  try { u=reopened.undo(a.operation_id,f.options(a,'undo')); } finally { reopened.dispose(); }
  assert.equal(u.status,'undone');assert.equal(f.getMoveCalls(),0);assert.equal(f.registry.show(f.source.project_id).project.current_path,'客户工作');assert.equal(f.registry.show(a.target_project_id).project.status,'archived');assert.equal(f.registry.projectContext.getActiveLocation(a.target_project_id),null);
  for(const s of Object.values(f.sides)){assert.equal(f.control.projectResource(f.source.project_id,s.resource.resource_id).resource_id,s.resource.resource_id);assert.equal(f.save.show(s.saved.save_id).project.id,f.source.project_id);assert.equal(f.registry.ledger.workSessions.byId(s.work.session_id).project_id,f.source.project_id);assert.deepEqual(f.boards.showBoard(f.source.project_id,s.board.board_id).blocks.map(b=>b.block_id),s.board.blocks.map(b=>b.block_id));}
  assert.ok(f.registry.ledger.db.prepare('SELECT count(*) n FROM project_locations').get().n>before);assert.deepEqual(fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json')),raw);
});

for(const stage of ['before','after'])test(`partition ${stage} database interruption recovers the frozen projection without moving files`,t=>{
  let stop=true;const f=fixture(t,{[stage==='before'?'beforeDatabaseMove':'afterDatabaseMove']:()=>{if(stop){stop=false;throw new Error('fixture interruption');}}});const p=f.prepare();assert.throws(()=>f.service.execute(p.operation_id,f.options(p,'execute')),/fixture interruption/);
  const pending=f.service.show(p.operation_id,{sourceProjectId:f.source.project_id});assert.equal(pending.status,'needs_recovery');
  const db=f.registry.ledger.db;const facts=()=>({works:db.prepare('SELECT * FROM work_sessions ORDER BY id').all(),locations:db.prepare('SELECT * FROM project_locations ORDER BY id').all(),resources:db.prepare('SELECT * FROM resource_locations ORDER BY id').all()});const frozen=facts();
  for(const s of Object.values(f.sides))assert.throws(()=>f.registry.ledger.workSessions.setLatestSave(s.work.session_id,s.saved.save_id,new Date().toISOString()),{code:'ATLAS_STATE_CONFLICT'});assert.deepEqual(facts(),frozen);
  const reopened=createProjectMembershipService({stateDir:f.stateDir});let recovered;
  try { recovered=reopened.recover(p.operation_id,f.options(pending,'recover')); } finally { reopened.dispose(); }
  assert.equal(recovered.status,'applied');assert.equal(f.getMoveCalls(),0);assert.equal(f.registry.show(f.source.project_id).project.current_path,'客户工作/交付');assert.equal(f.save.show(f.sides.研究.saved.save_id).project.id,recovered.target_project_id);
});

test('partition refuses root loose entries, cross-side Board and unsupported relative Work context',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.parent,'.control'),'not ignored');let p=f.prepare();assert.equal(p.can_execute,false);assert.match(p.blockers.join(' '),/exactly the two/);fs.unlinkSync(path.join(f.parent,'.control'));
  const b=f.sides.交付.board;f.boards.saveBoard({projectId:f.source.project_id,boardId:b.board_id,title:b.title,baseRevision:b.revision,blocks:[{type:'material_reference',resource_id:f.sides.交付.resource.resource_id},{type:'material_reference',resource_id:f.sides.研究.resource.resource_id}]});
  f.registry.ledger.db.prepare('UPDATE work_sessions SET recipe_json=? WHERE id=?').run(JSON.stringify({source_path:'unknown.csv'}),f.sides.研究.work.session_id);p=f.prepare({requestKey:'blocked'});assert.equal(p.can_execute,false);assert.match(p.blockers.join(' '),/cross|whole Board/);assert.match(p.blockers.join(' '),/unsupported relative source_path/);assert.throws(()=>f.service.execute(p.operation_id,f.options(p,'execute')),{code:'ATLAS_STATE_CONFLICT'});
});

test('partition rejects preview file growth, same-hash identity replacement, junction and third Project overlap',t=>{
  const f=fixture(t);let p=f.prepare();fs.writeFileSync(path.join(f.parent,'交付','added.txt'),'later');assert.throws(()=>f.service.execute(p.operation_id,f.options(p,'execute')),{code:'ATLAS_STATE_CONFLICT'});fs.unlinkSync(path.join(f.parent,'交付','added.txt'));
  p=f.prepare({requestKey:'identity'});const file=f.sides.研究.file;fs.renameSync(file,`${file}.old`);fs.writeFileSync(file,fs.readFileSync(`${file}.old`));assert.throws(()=>f.service.execute(p.operation_id,f.options(p,'identity-execute')),{code:'ATLAS_STATE_CONFLICT'});fs.unlinkSync(file);fs.renameSync(`${file}.old`,file);
  fs.symlinkSync(path.join(f.parent,'研究'),path.join(f.parent,'linked'),'junction');assert.throws(()=>f.prepare({requestKey:'linked'}));fs.unlinkSync(path.join(f.parent,'linked'));
  const third=f.registry.create({name:'third',currentPath:'客户工作/交付'});f.registry.attachRoot(third.project_id,{rootId:f.registry.projectContext.getActiveLocation(f.source.project_id).root_id,relativePath:'客户工作/交付',reason:'fixture overlap'});assert.throws(()=>f.prepare({requestKey:'overlap'}),/overlap/);
});

test('partition allows current new Save, refuses old boundary access and later Work/Save Undo',t=>{
  const f=fixture(t);const p=f.prepare();const a=f.service.execute(p.operation_id,f.options(p,'execute'));assert.deepEqual(f.service.execute(p.operation_id,f.options(p,'execute')),a);const count=()=>({projects:f.registry.ledger.db.prepare('SELECT count(*) n FROM projects').get().n,records:fs.readdirSync(path.join(f.stateDir,'project-memberships')).filter(n=>n.endsWith('.json')).length});const before=count();const replay=f.prepare();assert.deepEqual(replay,a);assert.equal(replay.operation_id,p.operation_id);assert.equal(replay.status,'applied');assert.equal(replay.revision,2);assert.deepEqual(count(),before);assert.throws(()=>f.service.referenceBasis(a.operation_id,{sourceProjectId:f.source.project_id,expectedRevision:a.revision,expectedDigest:a.digest}),/does not move/);
  const candidate=path.join(f.stateDir,'next.csv');fs.writeFileSync(candidate,'kind,value\nA,3\n');assert.throws(()=>f.save.prepare({root:f.root,projectId:f.source.project_id,candidateFile:candidate,target:'客户工作/研究/invalid.csv',inputs:[f.sides.研究.file],origin:'agent_generated',kind:'intermediate',requestKey:'invalid',caller}));
  const next=f.save.prepare({root:f.root,projectId:a.target_project_id,candidateFile:candidate,target:'客户工作/研究/next.csv',inputs:[f.sides.研究.file],origin:'agent_generated',kind:'intermediate',requestKey:'new-save',caller});const saved=f.save.execute(next.save_id,{reason:'continue'});assert.equal(f.save.show(saved.save_id).project.id,a.target_project_id);f.registry.ledger.workSessions.setLatestSave(f.sides.研究.work.session_id,saved.save_id,new Date().toISOString());assert.throws(()=>f.service.undo(a.operation_id,f.options(a,'undo')),{code:'ATLAS_STATE_CONFLICT'});
});

test('partition after database file change stays pending and recovery refuses changed bytes',t=>{
  let f;f=fixture(t,{afterDatabaseMove:()=>fs.appendFileSync(f.sides.交付.file,'B,2\n')});const p=f.prepare();assert.throws(()=>f.service.execute(p.operation_id,f.options(p,'execute')),{code:'ATLAS_STATE_CONFLICT'});const pending=f.service.show(p.operation_id,{sourceProjectId:f.source.project_id});assert.equal(pending.status,'needs_recovery');assert.throws(()=>f.service.recover(p.operation_id,f.options(pending,'recover')),{code:'ATLAS_STATE_CONFLICT'});assert.equal(f.getMoveCalls(),0);
});
