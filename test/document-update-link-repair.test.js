import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { createProjectMoveService } from '../src/project-move-service.js';
import { createProjectMembershipService } from '../src/project-membership-service.js';
import { createDocumentUpdateService } from '../src/document-update-service.js';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const caller={tool:'fixture',client_run_id:'link-repair'};
function fixture(t, membership=false) {
  const root=fs.mkdtempSync(path.resolve('test/.tmp/link-repair-')); const stateDir=path.join(root,'state'); const workspace=path.join(root,'workspace');
  for(const p of ['A/notes','B','Moved/Deep'])fs.mkdirSync(path.join(workspace,p),{recursive:true});
  const registry=new Registry({stateDir}); const adopted=registry.adoptRoot({rootPath:workspace,rootType:'project_workspace',contentPolicy:'structure_only'});
  const projects={}; for(const p of ['A','B']){projects[p]=registry.create({name:p,currentPath:p}).project_id;registry.attachRoot(projects[p],{rootId:adopted.root_id,relativePath:p,reason:'fixture'});}
  const control=new ResourceControl({stateDir,registry}); const save=createSaveService({stateDir,resourceControl:control}); const resources={};
  const texts={'A/notes/target.md':'# target\n','A/notes/out.md':'[out](../../B/external.md) [same](./target.md)\n','A/notes/out2.md':'[second out](../../B/external.md)\n','B/external.md':'# external\n',
    'B/in1.md':'[in](../A/notes/target.md#h) [[ A/notes/target#h|Alias ]]\n`[code](../A/notes/target.md)`\n',
    'B/in2.md':'[second](../A/notes/target.md)\n','B/unselected.md':'[unchanged](../A/notes/target.md)\n'};
  for(const [p,text]of Object.entries(texts)){const filePath=path.join(workspace,p);fs.writeFileSync(filePath,text);resources[p]=control.identify({filePath,project:registry.show(projects[p[0]]).project}).resource_id;}
  const service=membership?createProjectMembershipService({stateDir,registry,resourceControl:control}):createProjectMoveService({stateDir,registry,resourceControl:control});
  const prepared=membership?service.prepare({operation:'split',sourceProjectId:projects.A,sourceRelativePath:'notes',newProjectName:'Notes',targetRelativePath:'Moved/Deep/Notes',requestKey:'move',caller}):service.prepare({projectId:projects.A,targetRelativePath:'Moved/A',requestKey:'move',caller});
  const options=membership?{sourceProjectId:projects.A}:{projectId:projects.A};
  const applied=service.execute(prepared.operation_id??prepared.move_id,{...options,expectedRevision:prepared.revision,expectedDigest:prepared.digest,requestKey:'apply-move',caller});
  const source={kind:membership?'project_membership':'project_move',operationId:applied.operation_id??applied.move_id,sourceProjectId:projects.A,expectedRevision:applied.revision,expectedDigest:applied.digest};
  const update=createDocumentUpdateService({stateDir,registry,resourceControl:control,saveService:save});
  t.after(()=>{service.dispose();save.dispose();control.dispose();registry.dispose();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
  const prepare=(p,key=p)=>update.prepare({projectId:projects.B,resourceId:resources[p],expectedSha256:hash(fs.readFileSync(path.join(workspace,p))),source,patch:{kind:'link_repair',syntax:['relative_markdown','wikilink'],wikiBase:'registered_root'},requestKey:key,caller});
  const decide=r=>update.decide(r.update_id,{projectId:r.project_id,expectedRevision:r.revision,expectedCurrentSha256:r.current.sha256,decision:'accept-suggestion',requestKey:`decide-${r.update_id}`,caller});
  const execute=r=>update.execute(r.update_id,{projectId:r.project_id,expectedRevision:r.revision,expectedCurrentSha256:r.current.sha256,requestKey:`execute-${r.update_id}`,caller});
  return {root,stateDir,workspace,registry,control,save,projects,resources,service,source,applied,options,update,prepare,decide,execute,texts};
}
test('selected repair uses real Move mapping and preserves alias, anchor and unselected bytes',t=>{
  const f=fixture(t); const p=f.prepare('B/in1.md'); assert.equal(p.change.kind,'link_repair'); assert.equal(p.change.edits.length,2);
  assert.equal(p.source_status,'current'); assert.equal(p.source.source_project_id,f.projects.A);
  const a=f.execute(f.decide(p)); assert.equal(a.status,'applied');
  assert.match(fs.readFileSync(path.join(f.workspace,'B/in1.md'),'utf8'),/\[\[ Moved\/A\/notes\/target#h\|Alias \]\]/);
  assert.equal(fs.readFileSync(path.join(f.workspace,'B/unselected.md'),'utf8'),f.texts['B/unselected.md']);
  const second=f.execute(f.decide(f.prepare('B/in2.md')));assert.equal(second.status,'applied');
  assert.throws(()=>f.service.undo(f.source.operationId,{...f.options,expectedRevision:f.applied.revision,expectedDigest:f.applied.digest,requestKey:'undo-move',caller}),/reference repair/i);
});

const undoUpdate=(f,r,key='undo')=>f.update.undo(r.update_id,{projectId:r.project_id,expectedRevision:r.revision,expectedCurrentSha256:r.current.sha256,requestKey:key,caller});
test('repair Undo clears only its guard; migration original state checks remain strict',t=>{
  const f=fixture(t);const applied=f.execute(f.decide(f.prepare('B/in1.md')));
  assert.throws(()=>f.service.undo(f.source.operationId,{...f.options,expectedRevision:f.applied.revision,expectedDigest:f.applied.digest,requestKey:'blocked',caller}),/reference repair/);
  const undone=undoUpdate(f,applied);assert.equal(undone.status,'undone');assert.equal(fs.readFileSync(path.join(f.workspace,'B/in1.md'),'utf8'),f.texts['B/in1.md']);
  // This inbound repair never touched the moved Project; its original strict
  // state and tree comparison still permits the unchanged Move to return.
  const returned=f.service.undo(f.source.operationId,{...f.options,expectedRevision:f.applied.revision,expectedDigest:f.applied.digest,requestKey:'return',caller});assert.equal(returned.status,'undone');
});
test('moved document outgoing repair and membership target retain Resource identity',t=>{
  const f=fixture(t,true);const projectId=f.applied.target_project_id;const resourceId=f.resources['A/notes/out.md'];const file=path.join(f.workspace,'Moved/Deep/Notes/out.md');
  const prepared=f.update.prepare({projectId,resourceId,expectedSha256:hash(fs.readFileSync(file)),source:f.source,patch:{kind:'link_repair',syntax:['relative_markdown','wikilink'],wikiBase:'registered_root'},requestKey:'out',caller});
  assert.equal(prepared.change.edits.length,1);assert.match(prepared.proposed.text,/\.\.\/\.\.\/\.\.\/B\/external.md/);
  const applied=f.execute(f.decide(prepared));assert.equal(applied.resource_id,resourceId);
  const secondPath=path.join(f.workspace,'Moved/Deep/Notes/out2.md');const second=f.update.prepare({projectId,resourceId:f.resources['A/notes/out2.md'],expectedSha256:hash(fs.readFileSync(secondPath)),source:f.source,patch:{kind:'link_repair',syntax:['relative_markdown'],wikiBase:'registered_root'},requestKey:'out2',caller});const secondApplied=f.execute(f.decide(second));assert.equal(secondApplied.status,'applied');undoUpdate(f,secondApplied,'undo-second');
  assert.throws(()=>f.service.undo(f.source.operationId,{...f.options,expectedRevision:f.applied.revision,expectedDigest:f.applied.digest,requestKey:'blocked',caller}),/reference repair/);
  undoUpdate(f,applied);assert.equal(f.service.undo(f.source.operationId,{...f.options,expectedRevision:f.applied.revision,expectedDigest:f.applied.digest,requestKey:'strict',caller}).status,'undone');
});
test('tree repair roundtrip still refuses unrelated Resource action changes',t=>{
  const f=fixture(t,true);const projectId=f.applied.target_project_id;const resourceId=f.resources['A/notes/out.md'];const file=path.join(f.workspace,'Moved/Deep/Notes/out.md');
  const p=f.update.prepare({projectId,resourceId,expectedSha256:hash(fs.readFileSync(file)),source:f.source,patch:{kind:'link_repair',syntax:['relative_markdown'],wikiBase:'registered_root'},requestKey:'out',caller});undoUpdate(f,f.execute(f.decide(p)));
  f.registry.ledger.resources.recordAction({resourceId,type:'fixture_later_action',details:{reason:'Later independent mutation'},at:new Date().toISOString()});
  assert.throws(()=>f.service.undo(f.source.operationId,{...f.options,expectedRevision:f.applied.revision,expectedDigest:f.applied.digest,requestKey:'strict',caller}),/outside proven reference repair/);
});
test('source Undo invalidates preview and source later Move invalidates accepted suggestion',t=>{
  const f=fixture(t);const p=f.prepare('B/in1.md');assert.throws(()=>f.update.decide(p.update_id,{projectId:p.project_id,expectedRevision:p.revision,expectedCurrentSha256:p.current.sha256,decision:'revise',text:'arbitrary',requestKey:'revise',caller}),/only keep-current/);
  f.service.undo(f.source.operationId,{...f.options,expectedRevision:f.applied.revision,expectedDigest:f.applied.digest,requestKey:'return',caller});assert.equal(f.update.show(p.update_id,{projectId:p.project_id}).source_status,'changed');assert.throws(()=>f.decide(p),/basis changed/);
});
test('later relocation of a used target refuses execution, and missing source stays readable',t=>{
  const f=fixture(t);const p=f.decide(f.prepare('B/in1.md'));
  const move=f.service.prepare({projectId:f.projects.A,targetRelativePath:'Moved/Again',requestKey:'again',caller});f.service.execute(move.move_id,{projectId:f.projects.A,expectedRevision:move.revision,expectedDigest:move.digest,requestKey:'execute-again',caller});
  const changed=f.update.show(p.update_id,{projectId:p.project_id});assert.equal(changed.source_status,'changed');assert.throws(()=>f.execute(p),/location|Root changed/);
  fs.renameSync(path.join(f.stateDir,'project-moves',`${f.source.operationId}.json`),path.join(f.stateDir,'project-moves',`${f.source.operationId}.json.tmp`));
  assert.equal(f.update.show(p.update_id,{projectId:p.project_id}).source_status,'unavailable');
});
test('changed selected bytes refuse execute and Undo; request replay remains one write',t=>{
  const f=fixture(t);const p=f.decide(f.prepare('B/in1.md'));const file=path.join(f.workspace,'B/in1.md');fs.appendFileSync(file,'later');assert.throws(()=>f.execute(p));fs.writeFileSync(file,f.texts['B/in1.md']);
  const a=f.execute(p);assert.equal(f.execute(p).revision,a.revision);fs.appendFileSync(file,'after');const shown=f.update.show(a.update_id,{projectId:a.project_id});assert.throws(()=>undoUpdate(f,shown));
  const count=fs.readdirSync(path.join(f.stateDir,'document-updates')).length;assert.throws(()=>f.update.prepare({projectId:f.projects.B,resourceId:f.resources['B/in1.md'],expectedSha256:p.baseline.sha256,source:f.source,patch:{kind:'link_repair',syntax:['relative_markdown','wikilink'],wikiBase:'registered_root'},requestKey:'B/in1.md',caller}),/changed/);assert.equal(fs.readdirSync(path.join(f.stateDir,'document-updates')).length,count);
});

test('used target replacement and relink invalidate preview without reading whole tree hashes',t=>{
  const f=fixture(t);const p=f.decide(f.prepare('B/in1.md'));const target=path.join(f.workspace,'Moved/A/notes/target.md');const renamed=`${target}.original`;fs.renameSync(target,renamed);fs.writeFileSync(target,'# replacement\n');
  assert.equal(f.update.show(p.update_id,{projectId:p.project_id}).source_status,'changed');assert.throws(()=>f.execute(p),/identity changed/);fs.unlinkSync(target);fs.renameSync(renamed,target);
  const l=f.control.projectResource(f.projects.A,f.resources['A/notes/target.md']).locations.find(v=>v.status==='active');f.registry.ledger.db.prepare("UPDATE resource_locations SET status='historical' WHERE id=?").run(l.id);
  assert.throws(()=>f.execute(p),/unique registered active location/);
});
test('selected cross-Root document refuses before an Update record, and unchanged link creates no Update',t=>{
  const f=fixture(t);const other=path.join(f.root,'other');fs.mkdirSync(path.join(other,'P'),{recursive:true});const adopted=f.registry.adoptRoot({rootPath:other,rootType:'project_workspace',contentPolicy:'structure_only'});const p=f.registry.create({name:'P',currentPath:'P'}).project_id;f.registry.attachRoot(p,{rootId:adopted.root_id,relativePath:'P',reason:'fixture'});const file=path.join(other,'P/x.md');fs.writeFileSync(file,'[[A/notes/target]]');const resourceId=f.control.identify({filePath:file,project:f.registry.show(p).project}).resource_id;
  assert.throws(()=>f.update.prepare({projectId:p,resourceId,expectedSha256:hash(fs.readFileSync(file)),source:f.source,patch:{kind:'link_repair',syntax:['wikilink'],wikiBase:'registered_root'},requestKey:'cross',caller}),/registered Root/);
  const no=f.prepare('B/external.md');assert.equal(no.status,'no_change');assert.equal(fs.readdirSync(path.join(f.stateDir,'document-updates')).length,0);
});
test('existing Capture revise still executes and Undo restores its selected block',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.workspace,'B/source'));const capture=createCaptureSourceService({stateDir:f.stateDir,registry:f.registry,saveService:f.save,fetchImpl:async()=>new Response('<html><title>source</title><article>Captured content</article></html>',{headers:{'content-type':'text/html'}}),lookupHost:async()=>[{address:'93.184.216.34',family:4}]});t.after(()=>capture.dispose());
  const saved=await capture.prepare({url:'https://example.test/source',projectId:f.projects.B,folder:'source',name:'source',requestKey:'capture',caller});const review=f.save.review(saved.save_id);f.save.execute(saved.save_id,{reason:'fixture',expectedPreviewRevision:review.preview_revision});
  const file=path.join(f.workspace,'B/external.md');const p=f.update.prepare({projectId:f.projects.B,resourceId:f.resources['B/external.md'],expectedSha256:hash(fs.readFileSync(file)),oldText:'# external',newText:'# suggested',sourceSaveId:saved.save_id,requestKey:'capture-update',caller});
  assert.equal('source_status' in p,false);const d=f.update.decide(p.update_id,{projectId:p.project_id,expectedRevision:p.revision,expectedCurrentSha256:p.current.sha256,decision:'revise',text:'# revised',requestKey:'revise-capture',caller});const a=f.execute(d);assert.equal(fs.readFileSync(file,'utf8'),'# revised\n');undoUpdate(f,a);assert.equal(fs.readFileSync(file,'utf8'),'# external\n');
});
for(const point of ['before-write','after-write'])test(`link repair ${point} recovery reconciles without retrying writes or requiring source`,t=>{
  const f=fixture(t);const p=f.decide(f.prepare('B/in1.md'));f.update.operationHook=stage=>{if(stage===point)throw new Error('interrupted');};assert.throws(()=>f.execute(p),/interrupted/);f.update.operationHook=()=>{};
  const pending=f.update.show(p.update_id,{projectId:p.project_id});assert.equal(pending.status,'pending_recovery');
  fs.renameSync(path.join(f.stateDir,'project-moves',`${f.source.operationId}.json`),path.join(f.stateDir,'project-moves',`${f.source.operationId}.json.tmp`));
  const recovered=f.update.recover(p.update_id,{projectId:p.project_id,expectedRevision:pending.revision,expectedCurrentSha256:pending.current.sha256,requestKey:'recover',caller});assert.equal(recovered.status,point==='before-write'?'preview_ready':'applied');
  assert.equal(fs.readFileSync(path.join(f.workspace,'B/in1.md'),'utf8'),point==='before-write'?f.texts['B/in1.md']:p.candidate.text);
});
