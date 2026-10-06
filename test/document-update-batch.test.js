import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { ResourceControl } from '../src/resource-control.js';
import { createSaveService } from '../src/save-service.js';
import { createCaptureSourceService } from '../src/capture-source-service.js';
import { createDocumentUpdateService } from '../src/document-update-service.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
import { spawnSync } from 'node:child_process';
import { CAPABILITIES } from '../src/protocol.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/document-update-'));
  const stateDir = path.join(root, 'state'); const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, '城市研究'); const sourceFolder = path.join(projectRoot, '01_来源');
  fs.mkdirSync(sourceFolder, { recursive: true });
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: '城市研究', currentPath: '城市研究' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: '城市研究', reason: 'Document update fixture.' });
  const resourceControl = new ResourceControl({ stateDir, registry });
  const saveService = createSaveService({ stateDir, resourceControl });
  const captureSource = createCaptureSourceService({ stateDir, registry, saveService,
    fetchImpl: async () => new Response('<html><head><title>来源</title></head><body><article><p>引用内容</p></article></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }] });
  const sourcePrepared = await captureSource.prepare({ url: 'https://example.test/source', projectId: project.project_id,
    folder: '01_来源', name: '来源', requestKey: 'source-save', caller: { tool: 'fixture', client_run_id: 'document-update-source' } });
  const sourceReview = saveService.review(sourcePrepared.save_id);
  const sourceSave = saveService.execute(sourcePrepared.save_id, { reason: 'fixture confirmed', expectedPreviewRevision: sourceReview.preview_revision });
  const markdownPath = path.join(projectRoot, '知识笔记', '公交方案观察.md');
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  const originalBytes = Buffer.from('# 观察\n\n开头段落。\n\n唯一旧块：早班车间隔较长。\n\n结尾段落。\n', 'utf8');
  fs.writeFileSync(markdownPath, originalBytes);
  const identified = resourceControl.identify({ filePath: markdownPath, project: registry.show(project.project_id).project }).resource_id;
  const updateService = createDocumentUpdateService({ stateDir, registry, resourceControl, saveService });
  t.after(() => {
    captureSource.dispose(); saveService.dispose(); resourceControl.dispose(); registry.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { root, stateDir, workspace, projectRoot, project, registry, resourceControl, saveService, captureSource,
    sourceSave, markdownPath, originalBytes, resourceId: identified, updateService };
}

import { RoundRecovery } from '../src/round-recovery.js';

const selected = update => ({updateId:update.update_id,expectedRevision:update.revision,expectedCurrentSha256:update.current.sha256,expectedCandidateSha256:update.candidate?.sha256 ?? update.proposed.sha256});
const caller = {tool:'batch-fixture',client_run_id:'batch-tests'};
async function reviewed(t, count=3) {
  const f=await fixture(t);f.projectId=f.project.project_id;f.updates=[];f.paths=[];
  for(let i=0;i<count;i++) {
    const target=i===0?f.markdownPath:path.join(f.projectRoot,`材料 ${i} & 资料.txt`);
    if(i)fs.writeFileSync(target,'唯一旧块：早班车间隔较长。\n','utf8');
    const resourceId=i===0?f.resourceId:f.resourceControl.identify({filePath:target,project:f.registry.show(f.projectId).project}).resource_id;
    const inspected=f.updateService.inspect({projectId:f.projectId,resourceId});
    const p=f.updateService.prepare({projectId:f.projectId,resourceId,expectedSha256:inspected.baseline.sha256,oldText:'唯一旧块：早班车间隔较长。',newText:`确认新块 ${i}。`,sourceSaveId:f.sourceSave.save_id,requestKey:`prepare-${i}`,caller});
    const d=f.updateService.decide(p.update_id,{projectId:f.projectId,expectedRevision:p.revision,expectedCurrentSha256:p.current.sha256,decision:'accept-suggestion',requestKey:`decide-${i}`,caller});
    f.updates.push(d);f.paths.push(target);
  }
  f.batch=(options={})=>f.updateService.prepareBatch({projectId:f.projectId,items:f.updates.map(selected),requestKey:'batch',caller,...options});
  f.advance=(batch,key,options={})=>f.updateService.advanceBatch(batch.batch_id,{projectId:f.projectId,expectedRevision:batch.revision,expectedDigest:batch.digest,requestKey:key,caller,...options});
  return f;
}

test('persistent partial progress applies A, blocks later-changed B, continues C without rewriting successes',async t=>{
  const f=await reviewed(t);let batch=f.batch();const originalManifest=JSON.stringify(batch.manifest);
  assert.equal(f.batch().batch_id,batch.batch_id);
  assert.throws(()=>f.batch({items:[selected(f.updates[0])]}),/different facts/u);
  fs.appendFileSync(f.paths[1],'外部后改');
  const firstOptions={projectId:f.projectId,expectedRevision:batch.revision,expectedDigest:batch.digest,requestKey:'first',caller};
  batch=f.advance(batch,'first');assert.equal(batch.successful_count,1);assert.equal(batch.items[0].status,'applied');
  assert.equal(f.updateService.advanceBatch(batch.batch_id,firstOptions).successful_count,1);
  assert.throws(()=>f.updateService.advanceBatch(batch.batch_id,{...firstOptions,expectedRevision:batch.revision}),/different facts/u);
  batch=f.advance(batch,'second');assert.equal(batch.items[1].status,'blocked');assert.equal(batch.successful_count,1);
  f.updateService=createDocumentUpdateService({stateDir:f.stateDir,registry:f.registry,resourceControl:f.resourceControl,saveService:f.saveService});
  batch=f.updateService.showBatch(batch.batch_id,{projectId:f.projectId});batch=f.advance(batch,'third',{caller:{tool:'other-host',client_run_id:'restarted'}});
  assert.equal(batch.status,'finished');assert.equal(batch.successful_count,2);assert.equal(batch.blocked_count,1);assert.equal(JSON.stringify(batch.manifest),originalManifest);
  for(const i of [0,2])assert.equal(f.resourceControl.describe(f.updates[i].resource_id).actions.filter(a=>a.action_type==='document_update_execute').length,1);
  assert.match(fs.readFileSync(f.paths[1],'utf8'),/外部后改/u);
  fs.appendFileSync(f.paths[0],'success later changed');const shown=f.updateService.showBatch(batch.batch_id,{projectId:f.projectId});assert.equal(shown.items[0].current_deviation,true);
  assert.equal(f.advance(shown,'finished-no-write').successful_count,2);assert.match(fs.readFileSync(f.paths[0],'utf8'),/success later changed/u);
  const cli=spawnSync(process.execPath,['bin/atlas.js','document','update','batch','show',batch.batch_id,'--project',f.projectId,'--json'],{encoding:'utf8',timeout:15000,env:{...process.env,ATLAS_STATE_DIR:f.stateDir}});
  assert.equal(cli.status,0,cli.stdout+cli.stderr);assert.equal(JSON.parse(cli.stdout).data.batch_id,batch.batch_id);
});

test('batch selection rejects unreviewed, keep-current, cross-Project and duplicate Resources',async t=>{
  const f=await reviewed(t,1);const u=f.updates[0];
  assert.throws(()=>f.batch({items:[selected(u),selected(u)]}),/distinct/u);
  assert.throws(()=>f.batch({projectId:'other-project'}));
  const inspected=f.updateService.inspect({projectId:f.projectId,resourceId:f.resourceId});
  const p=f.updateService.prepare({projectId:f.projectId,resourceId:f.resourceId,expectedSha256:inspected.baseline.sha256,oldText:'唯一旧块：早班车间隔较长。',newText:'另一建议',sourceSaveId:f.sourceSave.save_id,requestKey:'alternate',caller});
  assert.throws(()=>f.batch({items:[selected(p)]}),/accepted/u);
  const d=f.updateService.decide(p.update_id,{projectId:f.projectId,expectedRevision:p.revision,expectedCurrentSha256:p.current.sha256,decision:'accept-suggestion',requestKey:'alternate-decide',caller});
  assert.throws(()=>f.batch({items:[selected(u),selected(d)]}),/same Resource/u);
  const kept=f.updateService.decide(d.update_id,{projectId:f.projectId,expectedRevision:d.revision,expectedCurrentSha256:d.current.sha256,decision:'keep-current',requestKey:'keep',caller});
  assert.throws(()=>f.batch({items:[selected(kept)]}),/accepted/u);
  assert.equal(f.updateService.listReviewedUpdates({projectId:f.projectId}).entries.length,1);
  const revised=f.updateService.decide(u.update_id,{projectId:f.projectId,expectedRevision:u.revision,expectedCurrentSha256:u.current.sha256,decision:'revise',text:'新确认块',requestKey:'new-decision',caller});
  assert.throws(()=>f.batch({requestKey:'stale-selection',items:[selected(u)]}),/selection changed/u);
  assert.throws(()=>f.updateService.prepareBatch({projectId:f.projectId,updateIds:[u.update_id],requestKey:'ids-only',caller}),/explicit reviewed facts/u);
  assert.equal(f.batch({requestKey:'new-selection',items:[selected(revised)]}).items.length,1);
});

for(const point of ['batch-started','batch-after-update'])test(`restart reconciles ${point} using stable item identity without repeating write`,async t=>{
  const f=await reviewed(t,2);const batch=f.batch();f.updateService.operationHook=stage=>{if(stage===point)throw new Error('controlled batch interruption');};
  assert.throws(()=>f.advance(batch,'interrupted'),/controlled batch interruption/u);
  const record=JSON.parse(fs.readFileSync(path.join(f.stateDir,'document-update-batches',`${batch.batch_id}.json`),'utf8'));assert.equal(record.items[0].status,'started');
  f.updateService=createDocumentUpdateService({stateDir:f.stateDir,registry:f.registry,resourceControl:f.resourceControl,saveService:f.saveService});
  const restarted=f.updateService.showBatch(batch.batch_id,{projectId:f.projectId});const result=f.advance(restarted,'continue',{caller:{tool:'new-host',client_run_id:'new-run'}});
  assert.equal(result.successful_count,1);assert.equal(f.resourceControl.describe(f.resourceId).actions.filter(a=>a.action_type==='document_update_execute').length,1);
  const repeated=f.advance(batch,'interrupted');assert.equal(repeated.successful_count,1);assert.equal(repeated.items[1].status,'ready');assert.match(fs.readFileSync(f.paths[1],'utf8'),/早班车间隔较长/u);
  if(point==='batch-after-update')assert.equal(result.items[0].reconciled,true);
});

test('pending item requires explicit recovery; before outcome requires renewed review',async t=>{
  const f=await reviewed(t,2);let batch=f.batch();f.updateService.operationHook=stage=>{if(stage==='before-write')throw new Error('controlled single interruption');};
  assert.throws(()=>f.advance(batch,'interrupted'),/controlled single interruption/u);f.updateService.operationHook=()=>{};
  batch=f.updateService.showBatch(batch.batch_id,{projectId:f.projectId});batch=f.advance(batch,'check');assert.equal(batch.items[0].status,'needs_recovery');
  const pending=f.updateService.show(f.updates[0].update_id,{projectId:f.projectId});
  f.updateService.recover(pending.update_id,{projectId:f.projectId,expectedRevision:pending.revision,expectedCurrentSha256:pending.current.sha256,requestKey:'recover-before',caller});
  batch=f.advance(batch,'after-recover');assert.equal(batch.items[0].status,'blocked');assert.equal(batch.items[0].reason,'review_required');
  batch=f.advance(batch,'remaining');assert.equal(batch.items[1].status,'applied');assert.equal(batch.successful_count,1);
  assert.match(fs.readFileSync(f.paths[0],'utf8'),/早班车间隔较长/u);
});

test('same Hash replacement identity pauses the batch without overwriting the replacement',async t=>{
  const f=await reviewed(t,1);const batch=f.batch();const original=fs.readFileSync(f.paths[0]);
  fs.renameSync(f.paths[0],`${f.paths[0]}.old`);fs.writeFileSync(f.paths[0],original);
  const result=f.advance(batch,'identity');assert.equal(result.items[0].status,'paused');assert.equal(result.successful_count,0);assert.deepEqual(fs.readFileSync(f.paths[0]),original);
});

test('Host prepares and advances the same persistent reviewed batch using revision and digest',async t=>{
  const f=await reviewed(t,1);const request=path.join(f.root,'batch-request.json');fs.writeFileSync(request,JSON.stringify({items:f.updates.map(selected)}),'utf8');
  const cli=args=>spawnSync(process.execPath,['bin/atlas.js','document','update','batch',...args,'--json'],{encoding:'utf8',timeout:20000,env:{...process.env,ATLAS_STATE_DIR:f.stateDir}});
  const prepared=cli(['prepare','--project',f.projectId,'--request-file',request,'--request-key','host-batch','--tool','host','--client-run-id','host-batch']);
  assert.equal(prepared.status,0,prepared.stdout+prepared.stderr);const batch=JSON.parse(prepared.stdout).data;
  assert.equal(f.updateService.showBatch(batch.batch_id,{projectId:f.projectId}).digest,batch.digest);
  const advanced=cli(['advance',batch.batch_id,'--project',f.projectId,'--expected-revision',String(batch.revision),'--expected-digest',batch.digest,'--request-key','host-advance','--tool','host','--client-run-id','host-batch']);
  assert.equal(advanced.status,0,advanced.stdout+advanced.stderr);assert.equal(JSON.parse(advanced.stdout).data.successful_count,1);
  const applied=f.updateService.show(f.updates[0].update_id,{projectId:f.projectId});f.updateService.undo(applied.update_id,{projectId:f.projectId,expectedRevision:applied.revision,expectedCurrentSha256:applied.current.sha256,requestKey:'undo',caller});
  const shown=f.updateService.showBatch(batch.batch_id,{projectId:f.projectId});assert.equal(shown.items[0].status,'applied');assert.equal(shown.items[0].update_status,'undone');assert.equal(shown.items[0].current_deviation,true);
});

test('pending UPD blocks Round mutations and pending Round or changed history blocks batches',async t=>{
  const f=await reviewed(t,1);const recovery=new RoundRecovery({stateDir:f.stateDir,registry:f.registry});
  fs.writeFileSync(path.join(f.projectRoot,'insurance.txt'),'insurance\n');
  const rc={actor:'agent',tool:'fixture',client_run_id:'round-batch'};
  const round=recovery.protect({projectId:f.projectId,paths:['insurance.txt'],label:'before',requestKey:'protect',caller:rc});
  const batch=f.batch();f.updateService.operationHook=stage=>{if(stage==='before-write')throw new Error('controlled interruption');};
  assert.throws(()=>f.advance(batch,'pending'),/controlled interruption/u);f.updateService.operationHook=()=>{};
  assert.ok(recovery.show({projectId:f.projectId,roundId:round.round_id}));
  const args={projectId:f.projectId,roundId:round.round_id,baseRevision:round.revision,expectedDigest:round.current_digest,requestKey:'blocked',caller:rc};
  for(const call of [()=>recovery.protect({projectId:f.projectId,paths:['insurance.txt'],label:'blocked',requestKey:'new-protect',caller:rc}),()=>recovery.checkpoint(args),()=>recovery.extend({...args,paths:['other.txt']}),()=>recovery.restore({...args,nodeId:round.head_node_id}),()=>recovery.returnToLatest({...args,restoreId:'RST-missing'})])assert.throws(call,{code:'ATLAS_DOCUMENT_UPDATE_INCOMPLETE'});
  const pending=f.updateService.show(f.updates[0].update_id,{projectId:f.projectId});f.updateService.recover(pending.update_id,{projectId:f.projectId,expectedRevision:pending.revision,expectedCurrentSha256:pending.current.sha256,requestKey:'recover',caller});
  const oldJSON=f.registry.ledger.db.prepare('SELECT state_json FROM recovery_rounds WHERE id=?').get(round.round_id).state_json;const state=JSON.parse(oldJSON);state.pending_restore='test-pending';
  f.registry.ledger.db.prepare('UPDATE recovery_rounds SET state_json=? WHERE id=?').run(JSON.stringify(state),round.round_id);
  const current=f.updateService.showBatch(batch.batch_id,{projectId:f.projectId});assert.throws(()=>f.advance(current,'round-pending'),{code:'ATLAS_RECOVERY_INCOMPLETE'});
  f.registry.ledger.db.prepare('UPDATE recovery_rounds SET state_json=? WHERE id=?').run(oldJSON,round.round_id);
  const shown=recovery.show({projectId:f.projectId,roundId:round.round_id});recovery.restore({projectId:f.projectId,roundId:round.round_id,nodeId:round.head_node_id,baseRevision:shown.revision,expectedDigest:shown.current_digest,requestKey:'same-bytes-restore',caller:rc});
  assert.equal(fs.readFileSync(path.join(f.projectRoot,'insurance.txt'),'utf8'),'insurance\n');
  assert.throws(()=>f.advance(current,'history-changed'),/history changed/u);
  const corrupt=path.join(f.stateDir,'document-updates',`UPD-${'a'.repeat(32)}.json`);fs.writeFileSync(corrupt,'{bad');
  assert.throws(()=>recovery.protect({projectId:f.projectId,paths:['insurance.txt'],label:'bad',requestKey:'corrupt',caller:rc}),/unreadable/u);
  const valid=JSON.parse(fs.readFileSync(path.join(f.stateDir,'document-updates',`${pending.update_id}.json`),'utf8'));valid.update_id=`UPD-${'a'.repeat(32)}`;valid.revision='invalid';fs.writeFileSync(corrupt,JSON.stringify(valid),'utf8');
  assert.throws(()=>recovery.protect({projectId:f.projectId,paths:['insurance.txt'],label:'bad',requestKey:'bad-state',caller:rc}),/state is invalid/u);
  valid.revision=1;valid.status='pending_recovery';valid.pending=null;fs.writeFileSync(corrupt,JSON.stringify(valid),'utf8');
  assert.throws(()=>recovery.protect({projectId:f.projectId,paths:['insurance.txt'],label:'bad',requestKey:'bad-pending',caller:rc}),/state is invalid/u);
});
