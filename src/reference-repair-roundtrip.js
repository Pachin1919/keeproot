import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { documentUpdateWrite } from './document-update-writer.js';

const conflict=message=>Object.assign(new Error(message),{code:'ATLAS_STATE_CONFLICT'});
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const contentHash=v=>crypto.createHash('sha256').update(v).digest('hex');
const copy=v=>JSON.parse(JSON.stringify(v));
const inside=(root,p)=>{const r=path.relative(root,p);return !!r&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
const fail=()=>{throw conflict('Reference repair roundtrip evidence changed or is incomplete; migration Undo refuses unrelated changes.');};
function ancestors(p){let cursor=path.parse(p).root;for(const segment of p.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,segment);const s=fs.lstatSync(cursor);if(s.isSymbolicLink()||!s.isDirectory())fail();}}
function records(stateDir){
  const dir=path.join(path.resolve(stateDir),'document-updates');ancestors(path.resolve(stateDir));if(!fs.existsSync(dir))return [];ancestors(dir);
  const names=fs.readdirSync(dir);if(names.length>10000)fail();let bytes=0;
  return names.filter(n=>!n.endsWith('.tmp')).map(n=>{if(!/^UPD-[a-f0-9]{32}\.json$/u.test(n))fail();const p=path.join(dir,n);const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>2*1024*1024||(bytes+=s.size)>32*1024*1024)fail();let row;try{row=JSON.parse(fs.readFileSync(p,'utf8'));}catch{fail();}if(row.schema!=='atlas.document-update.v1'||row.update_id!==n.slice(0,-5))fail();return row;});
}
function related(stateDir,sourceKind,operationId){return records(stateDir).filter(r=>r.source?.kind===sourceKind&&r.source.operation_id===operationId&&r.status!=='preview_ready');}
function actionRows(db,id){const rows=db.prepare("SELECT rowid AS event_order,* FROM resource_actions WHERE json_extract(details_json,'$.update_id')=? ORDER BY rowid").all(id);if(rows.length!==2)fail();return copy(rows);}
function checkedBody(body){if(!body||typeof body.text!=='string'||Buffer.byteLength(body.text)>256*1024||Buffer.byteLength(body.text)!==body.bytes||contentHash(body.text)!==body.sha256)fail();}
function proveRecord(row,options){
  const {db,sourceKind,operationId,revision,digest,rootPath,sourceProjectId,rootId}=options;
  if(row.status!=='undone'||row.pending||row.patch?.kind!=='link_repair'||row.source.kind!==sourceKind||row.source.operation_id!==operationId||row.source.revision!==revision||row.source.digest!==digest||row.source.source_project_id!==sourceProjectId||row.source.root_id!==rootId||path.resolve(row.source.root_path)!==path.resolve(rootPath)||!row.resource?.location_id||!inside(rootPath,path.resolve(row.resource.path))||!inside(rootPath,path.resolve(row.resource.root_path))&&path.resolve(row.resource.root_path)!==path.resolve(rootPath))fail();
  checkedBody(row.execution?.before);checkedBody(row.execution?.after);
  const locations=db.prepare("SELECT id,project_id,path FROM resource_locations WHERE resource_id=? AND status='active'").all(row.resource_id);
  if(locations.length!==1||locations[0].id!==row.resource.location_id||locations[0].project_id!==row.project_id||path.resolve(locations[0].path)!==path.resolve(row.resource.path)||path.extname(row.resource.path).toLowerCase()!=='.md')fail();
  if(row.execution.before.sha256!==row.baseline?.sha256||row.execution.after.sha256!==row.decision?.candidate?.sha256||row.decision?.kind!=='accept-suggestion')fail();
  const actions=actionRows(db,row.update_id);const receipts=Object.values(row.operation_requests??{}).filter(r=>r.receipt);
  if(receipts.length!==2)fail();
  const events=actions.map(action=>{
    const requests=receipts.filter(r=>r.operation_id===action.id);if(requests.length!==1)fail();const request=requests[0];const receipt=request.receipt;let details;try{details=JSON.parse(action.details_json);}catch{fail();}
    const execute=receipt.kind==='execute';if(!execute&&receipt.kind!=='undo')fail();const before=execute?row.execution.before:row.execution.after;const after=execute?row.execution.after:row.execution.before;
    if(receipt.operation_id!==action.id||request.status!==(execute?'applied':'undone')||action.status!=='completed'||action.resource_id!==row.resource_id||action.action_type!==`document_update_${receipt.kind}`||action.created_at!==receipt.created_at||details.project_id!==row.project_id||details.update_id!==row.update_id||hash(details.source)!==hash(row.source)||hash(details.caller)!==hash(receipt.caller)||!receipt.caller?.tool||!receipt.caller?.client_run_id||details.file_id!==receipt.file_id||receipt.file_id!==row.execution.file_id||details.before_sha256!==receipt.before_sha256||details.after_sha256!==receipt.after_sha256||receipt.before_sha256!==before.sha256||receipt.after_sha256!==after.sha256||receipt.before_bytes!==before.bytes||receipt.after_bytes!==after.bytes||execute&&action.id!==row.execution.operation_id)fail();
    return {action,receipt,path:row.resource.path,location_id:row.resource.location_id,resource_id:row.resource_id};
  });
  if(events[0].receipt.kind!=='execute'||events[1].receipt.kind!=='undo')fail();
  return {events,summary:{update_id:row.update_id,record_digest:hash(row),actions:actions.map(a=>({operation_id:a.id,event_order:a.event_order,digest:hash(a)})),file:{resource_id:row.resource_id,location_id:row.resource.location_id,path:row.resource.path,file_id:row.execution.file_id,sha256:row.execution.before.sha256,bytes:row.execution.before.bytes}}};
}

// Two movement consumers call this under their existing state lock. Replaying
// the exact four refreshLocation fields and matched actions is the only delta
// accepted against the recorded applied database. No current metadata is copied.
export function verifyUndoneReferenceRepairs(options){
  const {stateDir,db,baseline,current,rootPath,inspect=documentUpdateWrite}=options;
  if(!Array.isArray(baseline.resource_facts)||!Array.isArray(baseline.resource_actions)){
    // Older Move receipts keep their original exact comparison. They cannot
    // admit any completed repair because those receipts lack the added proof.
    if(options.allowLegacyExactSnapshot && related(stateDir,options.sourceKind,options.operationId).length===0 && hash(baseline)===hash(current))return [];
    throw conflict('This migration lacks exact Resource/action baselines for reference repair Undo. Old evidence is not inferred.');
  }
  const expected=copy(baseline);const proofs=related(stateDir,options.sourceKind,options.operationId).map(r=>proveRecord(r,options));const events=proofs.flatMap(p=>p.events).sort((a,b)=>a.action.event_order-b.action.event_order);
  const scope=new Set(baseline.resource_facts.map(r=>r.id));const previous=new Map();
  for(const event of events){const {action,receipt}=event;const location=expected.resources.find(l=>l.id===event.location_id&&l.resource_id===event.resource_id);
    const prior=location?{sha256:location.content_hash,bytes:location.bytes}:previous.get(event.resource_id);
    if(prior&&(prior.sha256!==receipt.before_sha256||prior.bytes!==receipt.before_bytes))fail();
    if(location){if(path.resolve(location.path)!==path.resolve(event.path))fail();location.content_hash=receipt.after_sha256;location.bytes=receipt.after_bytes;location.modified_at=receipt.created_at;location.evidence_json=JSON.stringify({path:event.path,sha256:receipt.after_sha256,bytes:receipt.after_bytes,modified_at:receipt.created_at});}
    previous.set(event.resource_id,{sha256:receipt.after_sha256,bytes:receipt.after_bytes});
    if(scope.has(event.resource_id)){if(expected.resource_actions.some(a=>a.id===action.id))fail();const {event_order,...row}=action;expected.resource_actions.push(row);}
  }
  expected.resource_actions.sort((a,b)=>a.id.localeCompare(b.id));
  if(hash(expected)!==hash(current))throw conflict('Project, Work, Save, Board, Resource or action state changed outside proven reference repair roundtrips.');
  for(const {summary} of proofs){const f=summary.file;const fact=inspect({mode:'inspect',root:rootPath,target:f.path,expectedFileId:f.file_id,expectedSha256:f.sha256});if(fact.bytes!==f.bytes)fail();}
  return proofs.map(p=>p.summary);
}

// Recovery uses only the frozen acceptance set. It never certifies new repairs
// or reconstructs a more permissive before/after database projection.
export function verifyFrozenReferenceRepairs({stateDir,db,sourceKind,operationId,accepted,rootPath,fromPath,toPath,physicalAfter=false,inspect=documentUpdateWrite}){
  const rows=related(stateDir,sourceKind,operationId);if(rows.length!==accepted.length)fail();
  for(const proof of accepted){const row=rows.find(r=>r.update_id===proof.update_id);if(!row||row.status!=='undone'||row.pending||hash(row)!==proof.record_digest)fail();const actions=actionRows(db,proof.update_id);if(hash(actions.map(a=>({operation_id:a.id,event_order:a.event_order,digest:hash(a)})))!==hash(proof.actions))fail();const f=proof.file;const target=physicalAfter&&inside(fromPath,f.path)?path.join(toPath,path.relative(fromPath,f.path)):f.path;const fact=inspect({mode:'inspect',root:rootPath,target,expectedFileId:f.file_id,expectedSha256:f.sha256});if(fact.bytes!==f.bytes)fail();}
}
