import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createProjectMoveService } from '../src/project-move-service.js';
import { createProjectMembershipService } from '../src/project-membership-service.js';
import { createDocumentUpdateService } from '../src/document-update-service.js';
import { createBoardService } from '../src/board-service.js';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const caller={tool:'fixture',client_run_id:'roundtrip'};
function fixture(t,operation='move',hooks={}) {
  const base=fs.mkdtempSync(path.resolve('test/.tmp/reference-roundtrip-'));const stateDir=path.join(base,'state');const root=path.join(base,'root');
  for(const p of ['A/notes','B','Moved/Deep'])fs.mkdirSync(path.join(root,p),{recursive:true});
  fs.writeFileSync(path.join(root,'A/notes/out.md'),'[out](../../B/target.md)\n');fs.writeFileSync(path.join(root,'B/target.md'),'# target\n');fs.writeFileSync(path.join(root,'B/index.md'),'[in](../A/notes/out.md)\n');
  const registry=new Registry({stateDir});const adopted=registry.adoptRoot({rootPath:root,rootType:'project_workspace'});const ids={};
  for(const p of ['A','B']){ids[p]=registry.create({name:p,currentPath:p}).project_id;registry.attachRoot(ids[p],{rootId:adopted.root_id,relativePath:p,reason:'fixture'});}
  const control=new ResourceControl({stateDir,registry});const resources={};
  for(const p of ['A/notes/out.md','B/target.md','B/index.md'])resources[p]=control.identify({filePath:path.join(root,p),project:registry.show(ids[p[0]]).project}).resource_id;
  const save=createSaveService({stateDir,resourceControl:control});const candidate=path.join(stateDir,'candidate.md');fs.writeFileSync(candidate,'# saved\n');
  const preparedSave=save.prepare({root,projectId:ids.A,candidateFile:candidate,target:'A/notes/saved.md',inputs:[path.join(root,'A/notes/out.md')],origin:'agent_generated',kind:'intermediate',channel:'host',requestKey:'save',caller});
  const review=save.review(preparedSave.save_id);const saved=save.execute(preparedSave.save_id,{reason:'fixture',expectedPreviewRevision:review.preview_revision});
  const work=registry.ledger.workSessions.create({projectId:ids.A,resourceIds:[resources['A/notes/out.md']],at:new Date().toISOString()});registry.ledger.workSessions.setLatestSave(work.session_id,saved.save_id,new Date().toISOString());
  const boards=createBoardService({stateDir,registry,resourceControl:control,saveService:save});const board=boards.createBoard({projectId:ids.A,title:'Before movement'});
  const move=operation==='move';const service=(move?createProjectMoveService:createProjectMembershipService)({stateDir,registry,resourceControl:control,...hooks});
  const p=move?service.prepare({projectId:ids.A,targetRelativePath:'Moved/A',requestKey:'move',caller}):service.prepare({operation,sourceProjectId:ids.A,sourceRelativePath:operation==='split'?'notes':undefined,newProjectName:'Notes',targetProjectId:ids.B,targetRelativePath:operation==='split'?'Moved/Deep/Notes':'incoming',requestKey:'move',caller});
  const opts=r=>({...move?{projectId:ids.A}:{sourceProjectId:ids.A},expectedRevision:r.revision,expectedDigest:r.digest,caller});
  const a=service.execute(p.move_id??p.operation_id,{...opts(p),requestKey:'execute'});const id=a.move_id??a.operation_id;
  const source={kind:move?'project_move':'project_membership',operationId:id,sourceProjectId:ids.A,expectedRevision:a.revision,expectedDigest:a.digest};
  const update=createDocumentUpdateService({stateDir,registry,resourceControl:control,saveService:save});
  const treeFile=path.join(a.target.path,operation==='split'?'out.md':'notes/out.md');const projectId=move?ids.A:a.target_project_id;
  let serial=0;
  const roundtrip=(outside=false)=>{const resourceId=resources[outside?'B/index.md':'A/notes/out.md'];const file=outside?path.join(root,'B/index.md'):treeFile;const project=outside?ids.B:projectId;const key=`repair-${++serial}`;
    const p=update.prepare({projectId:project,resourceId,expectedSha256:hash(fs.readFileSync(file)),source,patch:{kind:'link_repair',syntax:['relative_markdown'],wikiBase:'registered_root'},requestKey:key,caller});
    const d=update.decide(p.update_id,{projectId:project,expectedRevision:p.revision,expectedCurrentSha256:p.current.sha256,decision:'accept-suggestion',requestKey:`${key}-decide`,caller});
    const a=update.execute(p.update_id,{projectId:project,expectedRevision:d.revision,expectedCurrentSha256:d.current.sha256,requestKey:`${key}-execute`,caller:{tool:'execute-host',client_run_id:key}});
    const u=update.undo(p.update_id,{projectId:project,expectedRevision:a.revision,expectedCurrentSha256:a.current.sha256,requestKey:`${key}-undo`,caller:{tool:'undo-host',client_run_id:key}});return u;};
  const undo=(key='undo')=>service.undo(id,{...opts(a),requestKey:key});
  t.after(()=>{service.dispose();boards.dispose();save.dispose();control.dispose();registry.dispose();fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
  return {base,stateDir,root,registry,control,save,saved,work,board,resources,service,source,a,id,opts,treeFile,projectId,roundtrip,undo};
}
for(const op of ['move','split','merge'])test(`roundtrip restore ${op}: tree and outside repairs Undo permit migration Undo with actions retained`,t=>{
  const f=fixture(t,op);const receipt=fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json'));f.roundtrip();f.roundtrip();f.roundtrip(true);
  const actions=f.registry.ledger.db.prepare("SELECT * FROM resource_actions WHERE action_type LIKE 'document_update_%' ORDER BY id").all();assert.equal(actions.length,6);
  const result=f.undo();assert.equal(result.status,'undone');assert.deepEqual(f.registry.ledger.db.prepare("SELECT * FROM resource_actions WHERE action_type LIKE 'document_update_%' ORDER BY id").all(),actions);assert.deepEqual(fs.readFileSync(path.join(f.stateDir,'ui/saved-work.json')),receipt);assert.equal(fs.readFileSync(path.join(f.root,'A/notes/out.md'),'utf8'),'[out](../../B/target.md)\n');
});
for(const change of ['action','work','save','save_link','resource','board'])test(`roundtrip refuses independent ${change} change`,t=>{
  const f=fixture(t);f.roundtrip();const db=f.registry.ledger.db;
  if(change==='action')f.registry.ledger.resources.recordAction({resourceId:f.resources['A/notes/out.md'],type:'independent_change',details:{reason:'after repair'},at:new Date().toISOString()});
  if(change==='work')db.prepare('UPDATE work_sessions SET revision=revision+1 WHERE id=?').run(f.work.session_id);
  if(change==='resource')db.prepare('UPDATE resources SET display_name=? WHERE id=?').run('Later name',f.resources['A/notes/out.md']);
  if(change==='save_link')db.prepare('UPDATE resource_save_links SET resource_id=? WHERE save_id=?').run(f.resources['A/notes/out.md'],f.saved.save_id);
  if(change==='board')db.prepare('UPDATE project_boards SET title=?,revision=revision+1 WHERE id=?').run('Later Board',f.board.board_id);
  if(change==='save'){const file=path.join(f.stateDir,'ui/saved-work.json');const row=JSON.parse(fs.readFileSync(file,'utf8'));row.items.find(i=>i.save_id===f.saved.save_id).intent='later Save change';fs.writeFileSync(file,JSON.stringify(row));}
  assert.throws(()=>f.undo(),/outside proven reference repair/);assert.equal(fs.existsSync(f.treeFile),true);
});
test('roundtrip refuses same-hash replacement and later outside bytes',t=>{
  const f=fixture(t,'split');f.roundtrip();const outside=f.roundtrip(true);const original=fs.readFileSync(f.treeFile);fs.renameSync(f.treeFile,`${f.treeFile}.original`);fs.writeFileSync(f.treeFile,original);assert.throws(()=>f.undo(),{code:'ATLAS_STATE_CONFLICT'});fs.unlinkSync(f.treeFile);fs.renameSync(`${f.treeFile}.original`,f.treeFile);
  fs.appendFileSync(path.join(f.root,'B/index.md'),'outside later');assert.throws(()=>f.undo('outside-changed'),{code:'ATLAS_STATE_CONFLICT'});assert.equal(outside.status,'undone');assert.equal(fs.existsSync(f.treeFile),true);
});
test('roundtrip refuses missing independent receipt and mismatched caller/source proof',t=>{
  const f=fixture(t);const u=f.roundtrip();const file=path.join(f.stateDir,'document-updates',`${u.update_id}.json`);const original=fs.readFileSync(file);const row=JSON.parse(original);
  const request=Object.values(row.operation_requests).find(r=>r.receipt.kind==='undo');request.receipt.caller.tool='different-host';fs.writeFileSync(file,JSON.stringify(row));assert.throws(()=>f.undo(),/evidence changed or is incomplete/);
  delete request.receipt;fs.writeFileSync(file,JSON.stringify(row));assert.throws(()=>f.undo('missing'),/evidence changed or is incomplete/);
  fs.writeFileSync(file,original);row.source.digest='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(row));assert.throws(()=>f.undo('stale-source'),/evidence changed or is incomplete/);
});
for(const repaired of [false,true])test(`old Move keeps exact Undo only without reference roundtrips: ${repaired}`,t=>{
  const f=fixture(t);if(repaired)f.roundtrip(true);const file=path.join(f.stateDir,'project-moves',`${f.id}.json`);const row=JSON.parse(fs.readFileSync(file));delete row.reference_roundtrip_baseline_version;for(const k of ['resource_facts','resource_actions','save_links','saves'])delete row.database[k];fs.writeFileSync(file,JSON.stringify(row));
  if(repaired)assert.throws(()=>f.undo(),/lacks exact/);
  else { assert.equal(f.undo().status,'undone');assert.equal(fs.readFileSync(path.join(f.root,'A/notes/out.md'),'utf8'),'[out](../../B/target.md)\n'); }
});
for(const op of ['move','split'])test(`roundtrip ${op} Undo file interruption recovers frozen before/after with audit actions retained`,t=>{
  let interrupt=false;const f=fixture(t,op,{afterPhysicalMove:()=>{if(interrupt)throw new Error('Undo interrupted');}});f.roundtrip();f.roundtrip(true);interrupt=true;
  const actions=f.registry.ledger.db.prepare("SELECT * FROM resource_actions WHERE action_type LIKE 'document_update_%' ORDER BY id").all();assert.throws(()=>f.undo(),/Undo interrupted/);
  const pending=f.service.show(f.id,op==='move'?{projectId:f.source.sourceProjectId}:{sourceProjectId:f.source.sourceProjectId});assert.equal(pending.status,'needs_recovery');
  const result=f.service.recover(f.id,{...f.opts(pending),requestKey:'recover'});assert.equal(result.status,'undone');assert.deepEqual(f.registry.ledger.db.prepare("SELECT * FROM resource_actions WHERE action_type LIKE 'document_update_%' ORDER BY id").all(),actions);
  const journal=JSON.parse(fs.readFileSync(path.join(f.stateDir,op==='move'?'project-moves':'project-memberships',`${f.id}.json`)));assert.equal(journal.accepted_reference_roundtrips.length,2);assert.equal(journal.pending,null);
});
test('roundtrip recovery refuses later changes to frozen UPD proof',t=>{
  let interrupt=false;const f=fixture(t,'split',{afterPhysicalMove:()=>{if(interrupt)throw new Error('Undo interrupted');}});const u=f.roundtrip();interrupt=true;assert.throws(()=>f.undo(),/Undo interrupted/);
  const file=path.join(f.stateDir,'document-updates',`${u.update_id}.json`);const row=JSON.parse(fs.readFileSync(file));row.updated_at='changed';fs.writeFileSync(file,JSON.stringify(row));const pending=f.service.show(f.id,{sourceProjectId:f.source.sourceProjectId});assert.throws(()=>f.service.recover(f.id,{...f.opts(pending),requestKey:'recover'}),/evidence changed or is incomplete/);assert.equal(f.service.show(f.id,{sourceProjectId:f.source.sourceProjectId}).status,'needs_recovery');
});
