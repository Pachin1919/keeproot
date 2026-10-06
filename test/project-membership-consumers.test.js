import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createBoardService } from '../src/board-service.js';
import { createDataWorkService } from '../src/ui/services/data-work-service.js';
import { createSavedWorkService } from '../src/ui/services/saved-work-service.js';
import { RoundRecovery } from '../src/round-recovery.js';
import { createProjectMembershipService } from '../src/project-membership-service.js';

const caller={actor:'agent',tool:'test',client_run_id:'membership-consumers'};
function fixture(t) {
  const base=fs.mkdtempSync(path.resolve('test/.tmp/membership-consumers-'));const stateDir=path.join(base,'state');const root=path.join(base,'workspace');fs.mkdirSync(path.join(root,'A/part'),{recursive:true});fs.writeFileSync(path.join(root,'A/part/source.csv'),'kind,value\nA,1\n');
  const registry=new Registry({stateDir});const adopted=registry.adoptRoot({rootPath:root,rootType:'project_workspace'});const project=registry.create({name:'A',currentPath:'A'});registry.attachRoot(project.project_id,{rootId:adopted.root_id,relativePath:'A',reason:'Consumers.'});
  const control=createResourceControl({stateDir,registry});const resource=control.identify({filePath:path.join(root,'A/part/source.csv'),project:{id:project.project_id}});const save=createSaveService({stateDir,resourceControl:control});const candidate=path.join(stateDir,'candidate.csv');fs.writeFileSync(candidate,'kind,value\nA,2\n');
  const work=registry.ledger.workSessions.create({projectId:project.project_id,resourceIds:[resource.resource_id],at:new Date().toISOString()});registry.ledger.workSessions.updateSource(work.session_id,work.sources[0].source_key,{fingerprint:{file_path:path.join(root,'A/part/source.csv'),sha256:resource.evidence.sha256},status:'ready'},new Date().toISOString());
  const prepareSave=(projectId,target,sourcePath,key)=>save.prepare({root,projectId,target,candidateFile:candidate,inputs:[sourcePath],origin:'agent_generated',kind:'intermediate',channel:'host',requestKey:key,caller,source:{resource_id:resource.resource_id,path:sourcePath,fingerprint:{file_path:sourcePath,sha256:resource.evidence.sha256}}});
  const pending=prepareSave(project.project_id,'A/part/result.csv',path.join(root,'A/part/source.csv'),'first');const saved=save.execute(pending.save_id,{reason:'First result.'});registry.ledger.workSessions.setLatestSave(work.session_id,saved.save_id,new Date().toISOString());
  registry.ledger.resources.createLinkedRelationship({sourceResourceId:resource.resource_id,targetResourceId:saved.resource_id,submitter:caller,evidence:{project_id:project.project_id},at:new Date().toISOString()});
  const boards=createBoardService({stateDir,registry,resourceControl:control,saveService:save});const b=boards.createBoard({projectId:project.project_id,title:'Whole Board'});const board=boards.saveBoard({projectId:project.project_id,boardId:b.board_id,title:b.title,baseRevision:b.revision,blocks:[{type:'material_reference',resource_id:resource.resource_id},{type:'text',text:'Continue here'},{type:'result_preview',save_id:saved.save_id}]});
  const service=createProjectMembershipService({stateDir,registry,resourceControl:control});const prepare=()=>service.prepare({operation:'split',sourceProjectId:project.project_id,sourceRelativePath:'part',newProjectName:'Part',targetRelativePath:'Part',requestKey:'split',caller});const options=(row,key)=>({sourceProjectId:project.project_id,expectedRevision:row.revision,expectedDigest:row.digest,requestKey:key,caller});
  t.after(()=>{service.dispose();boards.dispose();save.dispose();control.dispose();registry.dispose();fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:20});});return{stateDir,root,registry,project,control,resource,work,save,saved,boards,board,prepareSave,service,prepare,options};
}

test('split consumers continue Work, read original Save and Board, create new Save and protect a new Round without rewriting receipts', (t)=>{
  const f=fixture(t);const roundService=new RoundRecovery({stateDir:f.stateDir,registry:f.registry});
  const oldRound=roundService.protect({projectId:f.project.project_id,paths:['part/source.csv','part/result.csv'],resourceIds:[f.resource.resource_id,f.saved.resource_id],workIds:[f.work.session_id],saveIds:[f.saved.save_id],boardIds:[f.board.board_id],label:'Before split',requestKey:'old-round',caller});
  const receipt=fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json'));const oldIntake=f.save.intake.show(f.saved.save_id).execution_receipt;
  const preview=f.prepare();const applied=f.service.execute(preview.operation_id,f.options(preview,'execute'));const projectId=applied.target_project_id;
  const data=createDataWorkService({stateDir:f.stateDir,resourceControl:f.control});assert.equal(data.session(f.work.session_id).project_id,projectId);assert.equal(data.session(f.work.session_id).sources[0].file_path,path.join(f.root,'Part/source.csv'));
  const shown=f.save.show(f.saved.save_id);assert.equal(shown.project.id,projectId);assert.equal(shown.source.path,path.join(f.root,'Part/source.csv'));assert.equal(shown.target.path,path.join(f.root,'Part/result.csv'));assert.equal(shown.current_output,'verified');assert.equal(shown.undo_available,false);assert.equal(shown.redo_available,false);
  assert.equal(shown.target.relative_path,'Part/result.csv');assert.equal(shown.target.resource_path,'result.csv');
  assert.ok(shown.resources_href.startsWith(`/projects/${projectId}/resources?`));assert.equal(new URL(shown.resources_href,'http://atlas.local').searchParams.get('path'),'result.csv');
  const savedWork=createSavedWorkService({stateDir:f.stateDir,saveService:f.save});assert.equal(savedWork.listForProject(projectId)[0].work_id,f.saved.save_id);assert.equal(savedWork.listForProject(f.project.project_id).length,0);
  const currentBoard=f.boards.showBoard(projectId,f.board.board_id);assert.deepEqual(currentBoard.blocks.map(b=>b.block_id),f.board.blocks.map(b=>b.block_id));assert.equal(currentBoard.blocks[2].status,'fresh');
  assert.throws(()=>roundService.show({projectId:f.project.project_id,roundId:oldRound.round_id}),/Project|Resource|Work|moved|same|changed/iu);
  const freshRound=roundService.protect({projectId,paths:['source.csv','result.csv'],resourceIds:[f.resource.resource_id,f.saved.resource_id],workIds:[f.work.session_id],saveIds:[f.saved.save_id],boardIds:[f.board.board_id],label:'After split',requestKey:'fresh-round',caller});assert.equal(roundService.show({projectId,roundId:freshRound.round_id}).save_ids[0],f.saved.save_id);
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json')),receipt);assert.deepEqual(f.save.intake.show(f.saved.save_id).execution_receipt,oldIntake);
  f.registry.ledger.workSessions.updateReturnState(f.work.session_id,{page:'continued'},new Date().toISOString());
  const next=f.prepareSave(projectId,'Part/next.csv',path.join(f.root,'Part/source.csv'),'next');const saved=f.save.execute(next.save_id,{reason:'Continue in new Project.'});assert.equal(f.save.show(saved.save_id).project.id,projectId);assert.equal(f.save.show(saved.save_id).current_output,'verified');
  assert.throws(()=>f.service.undo(preview.operation_id,f.options(applied,'undo-after-consumers')),{code:'ATLAS_STATE_CONFLICT'});
});

test('a newly added third-party Work consumer blocks membership Undo before physical changes', (t)=>{
  const f=fixture(t);const p=f.prepare();const applied=f.service.execute(p.operation_id,f.options(p,'execute'));
  fs.mkdirSync(path.join(f.root,'Other'));const project=f.registry.create({name:'Other',currentPath:'Other'});f.registry.attachRoot(project.project_id,{rootId:f.registry.projectContext.getActiveLocation(applied.target_project_id).root_id,relativePath:'Other',reason:'Later consumer.'});
  f.registry.ledger.workSessions.create({projectId:project.project_id,resourceIds:[f.resource.resource_id],at:new Date().toISOString()});
  assert.throws(()=>f.service.undo(p.operation_id,f.options(applied,'undo')),{code:'ATLAS_STATE_CONFLICT'});assert.equal(fs.existsSync(path.join(f.root,'Part/source.csv')),true);
});
