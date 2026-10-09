import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';
import { Intake } from '../src/intake.js';
import { PreferenceRules } from '../src/preference-rules.js';
import { createModuleAvailabilityService } from '../src/module-availability.js';
import { startAtlasUiServer } from '../src/ui-server.js';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const actionFields=(html,action)=>{const form=[...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gu)].find(m=>m[1].includes('name="action" value="'+action+'"'));assert.ok(form,action);const params=new URLSearchParams();for(const m of form[1].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gu))params.append(m[1],decode(m[2]));return params;};
const decode=v=>v.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
const fields=(html,action)=>{ const form=[...html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/gu)].find(m=>decode(m[1]).endsWith(action)); assert.ok(form,'form '+action); return Object.fromEntries([...form[2].matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gu)].map(m=>[m[1],decode(m[2])])); };
async function fixture(t){
 const root=fs.mkdtempSync(path.resolve('test/.tmp/toolbox-reader-')); const stateDir=path.join(root,'state'),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 const registry=new Registry({stateDir}); const adopted=registry.adoptRoot({rootPath:workspace,rootType:'project_workspace',contentPolicy:'structure_only'});
 const projects=['A','B'].map(folder=>{fs.mkdirSync(path.join(workspace,folder));const p=registry.create({name:folder,currentPath:folder});registry.attachRoot(p.project_id,{rootId:adopted.root_id,relativePath:folder,reason:'UI fixture'});return registry.show(p.project_id).project;});
 const control=createResourceControl({stateDir,ledger:registry.ledger}), intake=new Intake({stateDir}),rules=new PreferenceRules({stateDir,ledger:registry.ledger});
 const file=path.join(workspace,'A','note.md');fs.writeFileSync(file,'# Original\nContent\n'); const csv=path.join(workspace,'A','data.csv');fs.writeFileSync(csv,'region,value\nNorth,20\nSouth,10\n'); const other=path.join(workspace,'B','other.txt');fs.writeFileSync(other,'B text');
 const identify=(file,project)=>control.identify({filePath:file,project}).resource_id;
 const resourceId=identify(file,projects[0]),tableId=identify(csv,projects[0]),otherId=identify(other,projects[1]);
 const server=await startAtlasUiServer({stateDir,registry,rules,intake,resourceControl:control,runtime:{},projectRoot:path.resolve('.'),installationRoot:path.resolve('.')});
 t.after(async()=>{await server.close();intake.dispose();control.dispose();registry.dispose();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const base='/projects/'+projects[0].id, back=base+'/resources?folder=Notes&resource_id='+resourceId+'&path=note.md';
 const get=async route=>{const response=await fetch(new URL(route,server.workspace_url));return {status:response.status,html:await response.text()};};
 const post=(route,values)=>fetch(new URL(route,server.workspace_url),{method:'POST',redirect:'manual',body:new URLSearchParams(values)});
 const edit=()=>get(base+'/resources/edit?'+new URLSearchParams({resource_id:resourceId,expected_sha256:hash(fs.readFileSync(file)),return_to:back}));
 return {root,stateDir,registry,projects,file,csv,resourceId,tableId,otherId,base,back,get,post,edit};
}
test('Toolbox chooses verified Project, refuses foreign IDs and paused module, and starts the existing Work review', {timeout:30000}, async t=>{
 const f=await fixture(t);const none=await f.get('/toolbox');assert.equal(none.status,200);assert.match(none.html,/Choose a Project/u);assert.match(none.html,/aria-disabled="true"/u);assert.match(none.html,/data-icon="toolbox"/u);
 const missing=await f.get('/toolbox?project_id=missing');assert.match(missing.html,/data-project-context="unavailable"/u);
 const chosen=await f.get('/toolbox?project_id='+f.projects[0].id);const form=fields(chosen.html,'/toolbox/start');assert.ok(chosen.html.includes(f.tableId));assert.ok(!chosen.html.includes('value="'+f.otherId+'"'));
 const start=values=>f.post(f.base+'/toolbox/start',{...form,resource_ids:f.tableId,tool:'pivot',...values});
 let response=await start({resource_ids:f.otherId});assert.equal(response.status,303);assert.match(response.headers.get('location'),/^\/toolbox/u);
 response=await start({csrf:'wrong'});assert.equal(response.status,403);
 const modules=createModuleAvailabilityService({stateDir:f.stateDir});let m=modules.get('atlas.table-work');modules.change({moduleId:m.module_id,enabled:false,expectedRevision:m.revision,requestKey:'pause',reason:'UI test'});
 response=await start({});assert.equal(response.status,303);const paused=await f.get('/toolbox?project_id='+f.projects[0].id);assert.match(paused.html,/processing is unavailable/u);assert.doesNotMatch(paused.html,/<form[^>]+toolbox\/start/u);
 m=modules.get('atlas.table-work');modules.change({moduleId:m.module_id,enabled:true,expectedRevision:m.revision,requestKey:'resume',reason:'UI test'});
 response=await start({});assert.equal(response.status,303);assert.equal(response.headers.get('location'),f.base+'/work/review');const review=await f.get(response.headers.get('location'));assert.match(review.html,/Pivot table/u);assert.match(review.html,/data.csv/u);
 const commit=fields(review.html,'/work/commit');response=await f.post(f.base+'/work/commit',{...commit,target:'new'});assert.equal(response.status,303);assert.match(response.headers.get('location'),/^\/work\/DWT-/u);
 const workHref=response.headers.get('location');const work=await f.get(workHref);assert.equal(work.status,200);assert.match(work.html,/toolbox-work-hint[^>]*>Pivot table/u);assert.match(work.html,/name="action" value="prepare_sources"/u);response=await f.post(workHref+'/action',actionFields(work.html,'prepare_sources'));assert.equal(response.status,303);const prepared=await f.get(workHref);assert.match(prepared.html,/name="action" value="confirm_mapping"/u);response=await f.post(workHref+'/action',actionFields(prepared.html,'confirm_mapping'));assert.equal(response.status,303);const aligned=await f.get(workHref);assert.match(aligned.html,/<details class="recipe-option" open><summary>[^<]*Pivot/u);
 const read=await f.get(f.base+'/resources/read?'+new URLSearchParams({resource_id:f.tableId,return_to:f.back}));assert.equal(read.status,200);assert.match(read.html,/Process and analyse table/u);assert.match(read.html,/Prepare AI handoff/u);const process=fields(read.html,'/toolbox/start');response=await f.post(f.base+'/toolbox/start',process);assert.equal(response.status,303);
 const readerReview=await f.get(response.headers.get('location'));
 const readerBack=[...readerReview.html.matchAll(/href="([^"]+)"/gu)]
   .map(match=>new URL(decode(match[1]),'http://atlas.local'))
   .find(url=>url.origin==='http://atlas.local'&&url.pathname===f.base+'/resources/read'&&url.searchParams.get('resource_id')===f.tableId);
 assert.ok(readerBack,'review links back to the selected Reader resource');
 assert.equal(readerBack.searchParams.get('return_to'),f.back,'nested return scope keeps the original folder and resource selection');
 const cancel=fields(readerReview.html,'/work/cancel');response=await f.post(f.base+'/work/cancel',cancel);const cancelled=new URL(response.headers.get('location'),'http://atlas.local');assert.equal(cancelled.searchParams.get('resource_id'),f.tableId);assert.equal(cancelled.searchParams.get('return_to'),f.back);
 const settings=await f.get('/settings?project_id='+f.projects[0].id+'&return_to='+encodeURIComponent('/toolbox?project_id='+f.projects[0].id));const csrf=settings.html.match(/name="csrf" value="([^"]+)"/u)[1];response=await f.post('/settings?project_id='+f.projects[0].id,{csrf,action:'save',return_to:'/toolbox?project_id='+f.projects[0].id});assert.equal(new URL(response.headers.get('location'),'http://atlas.local').pathname,'/toolbox');
});
test('Reader full Unicode draft previews without writing, confirms same Resource, reads receipt and Undo', {timeout:30000}, async t=>{
 const f=await fixture(t), original=fs.readFileSync(f.file);const read=await f.get(f.base+'/resources/read?resource_id='+f.resourceId+'&return_to='+encodeURIComponent(f.back));assert.match(read.html,/Edit text/u);assert.match(read.html,/No related Table Work/u);assert.doesNotMatch(read.html,/<form[^>]+\/handoffs/u);
 const editor=await f.edit();assert.equal(editor.status,200);assert.match(editor.html,/data-draft-protect/u);assert.match(editor.html,/<textarea[^>]*name="text"/u);const form=fields(editor.html,'/edit/preview');assert.deepEqual(fs.readFileSync(f.file),original);
 const draft='更新材料。\n'.repeat(1600);assert.ok(Buffer.byteLength(draft)>8192);let response=await f.post(f.base+'/resources/edit/preview',{...form,text:draft});assert.equal(response.status,200);const preview=await response.text();assert.deepEqual(fs.readFileSync(f.file),original);assert.match(preview,/Current text/u);assert.match(preview,/Proposed text/u);assert.match(preview,/Save this text/u);const confirm=fields(preview,'/edit/confirm');
 response=await f.post(f.base+'/resources/edit/confirm',confirm);assert.equal(response.status,303);assert.equal(fs.readFileSync(f.file,'utf8'),draft);const target=new URL(response.headers.get('location'),'http://atlas.local');assert.equal(target.searchParams.get('resource_id'),f.resourceId);assert.equal(target.searchParams.get('return_to'),f.back);
 const saved=await f.get(response.headers.get('location'));assert.equal(saved.status,200);assert.match(saved.html,/Earlier Save receipts/u);assert.match(saved.html,/Undo text edit/u);const undo=fields(saved.html,'/edit/undo');response=await f.post(f.base+'/resources/edit/undo',undo);assert.equal(response.status,303);assert.deepEqual(fs.readFileSync(f.file),original);
 const emptyEditor=await f.edit();const emptyForm=fields(emptyEditor.html,'/edit/preview');response=await f.post(f.base+'/resources/edit/preview',{...emptyForm,text:''});assert.equal(response.status,200);const emptyPreview=await response.text();assert.match(emptyPreview,/Empty text/u);assert.deepEqual(fs.readFileSync(f.file),original);response=await f.post(f.base+'/resources/edit/confirm',fields(emptyPreview,'/edit/confirm'));assert.equal(response.status,303);assert.equal(fs.statSync(f.file).size,0);
});
test('Reader rejects CSRF, stale Hash and cross-Project manual refs, retains failed draft and handles no-op', {timeout:30000}, async t=>{
 const f=await fixture(t);let editor=await f.edit(),form=fields(editor.html,'/edit/preview');const original=fs.readFileSync(f.file);
 let response=await f.post(f.base+'/resources/edit/preview',{...form,csrf:'wrong',text:'draft'});assert.equal(response.status,403);assert.deepEqual(fs.readFileSync(f.file),original);
 response=await f.post(f.base+'/resources/edit/preview',{...form,text:original.toString()});assert.equal(response.status,303);assert.deepEqual(fs.readFileSync(f.file),original);
 response=await f.post(f.base+'/resources/edit/preview',{...form,resource_id:f.otherId,text:'foreign'});assert.equal(response.status,409);assert.deepEqual(fs.readFileSync(f.file),original);
 response=await f.post(f.base+'/resources/edit/preview',{...form,text:'proposed'});const preview=await response.text();assert.equal(response.status,200);const confirm=fields(preview,'/edit/confirm');response=await f.post('/projects/'+f.projects[1].id+'/resources/edit/confirm',{...confirm,resource_id:f.otherId});assert.equal(response.status,409);assert.deepEqual(fs.readFileSync(f.file),original);
 fs.writeFileSync(f.file,'External edit');response=await f.post(f.base+'/resources/edit/confirm',confirm);assert.equal(response.status,409);assert.equal(fs.readFileSync(f.file,'utf8'),'External edit');assert.match(await response.text(),/proposed/u);
 response=await f.post(f.base+'/resources/edit/preview',{...form,request_key:'stale-draft',text:'Preserved draft <unsafe>'});assert.equal(response.status,409);const failed=await response.text();assert.match(failed,/Preserved draft &lt;unsafe&gt;/u);assert.match(failed,/Reload current file/u);assert.equal(fs.readFileSync(f.file,'utf8'),'External edit');
 editor=await f.edit();form=fields(editor.html,'/edit/preview');response=await f.post(f.base+'/resources/edit/preview',{...form,text:'x'.repeat(256*1024+1)});assert.equal(response.status,409);assert.equal(fs.readFileSync(f.file,'utf8'),'External edit');
});
