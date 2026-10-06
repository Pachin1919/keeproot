import crypto from 'node:crypto';
import path from 'node:path';
import { captureProjectIdentity } from './project-identity.js';
import { assertRecoveryWritable, assertDocumentUpdatesSettled } from './storage/recovery-write-guard.js';

const copy=v=>JSON.parse(JSON.stringify(v));
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const reject=m=>{throw Object.assign(new Error(m),{code:'ATLAS_STATE_CONFLICT'});};
const uid=p=>`${p}-${crypto.randomUUID()}`;
const portable=p=>p.replaceAll('\\','/');
const inside=(root,p)=>{const r=path.relative(root,p);return r===''||!r.startsWith('..')&&!path.isAbsolute(r);};
const pathFields=new Set(['path','file_path','source_path','target_path','result_path','project_root','relative_path','resource_path','folder','directory']);
function relativeBlockers(value,label,out){
  if(Array.isArray(value)){for(const item of value)relativeBlockers(item,label,out);return;}
  if(!value||typeof value!=='object')return;
  for(const [key,item]of Object.entries(value)){
    if(typeof item==='string'&&item&&pathFields.has(key)&&!path.isAbsolute(item)&&!path.win32.isAbsolute(item)&&!/^[a-z][a-z\d+.-]*:\/\//iu.test(item))out.push(`${label} has unsupported relative ${key}: ${item.slice(0,120)}. Clear or resolve that context before partitioning.`);
    else relativeBlockers(item,label,out);
  }
}
function context(value,projectRoot){
  if(Array.isArray(value))return value.map(v=>context(v,projectRoot));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='project_root'&&typeof v==='string'?projectRoot:context(v,projectRoot)]));
  return value;
}

// The current membership service is the sole consumer. Filesystem facts are
// measured with the existing single-tree inspector; this mode never moves it.
export function createProjectMembershipPartition({stateDir,registry,ledger,db,writer,all,saves,graph,snapshot,rows,write,publicRow,finish,rootCheck,relative,requestHash,beforeDatabaseMove,afterDatabaseMove}){
  const parent=row=>row.boundary_before.source_project.path;
  const inspect=row=>writer({mode:'inspect',root:row.root_path,source:parent(row),target:parent(row),...(row.ancestors?{expectedAncestors:row.ancestors}:{})});
  const identityFacts=row=>({parent:captureProjectIdentity(parent(row)),retained:captureProjectIdentity(row.boundary_after.source_project.path),detached:captureProjectIdentity(row.source.path)});
  const childManifest=(manifest,name)=>Object.fromEntries(Object.entries(manifest).filter(([p])=>p===name||p.startsWith(`${name}/`)).map(([p,v])=>[p===name?'.':p.slice(name.length+1),v]));
  const closure=row=>{
    const retained=row.boundary_after.source_project;
    const detached=graph({...row,manifest:childManifest(row.manifest,row.detached_name)});
    const kept=graph({...row,source:{path:retained.path,relative_path:retained.relative_path},manifest:childManifest(row.manifest,row.retained_name)});
    const blockers=[...detached.blockers,...kept.blockers];const dirs=Object.entries(row.manifest).filter(([p])=>p!=='.'&&!p.includes('/'));
    if(dirs.length!==2||dirs.some(([p,v])=>v.kind!=='directory'||![row.retained_name,row.detached_name].includes(p)))blockers.push('partition_existing requires exactly the two selected real direct directories. Root files, hidden/control entries, and third directories are unsupported.');
    for(const name of [row.retained_name,row.detached_name])if(!Object.keys(row.manifest).some(p=>p.startsWith(`${name}/`)))blockers.push(`Selected directory ${name} must be nonempty.`);
    const resourceIds=new Set([...detached.resources,...kept.resources]);
    for(const l of all("SELECT * FROM resource_locations WHERE project_id=? AND status='active'",row.source_project_id))if(!resourceIds.has(l.resource_id))blockers.push(`Resource ${l.resource_id} is outside both selected boundaries.`);
    for(const s of saves().filter(s=>s.project?.id===row.source_project_id))if(s.status!=='executed'||![...detached.saves,...kept.saves].includes(s.save_id))blockers.push(`Save ${s.save_id} is unfinished or cannot be assigned completely to either side.`);
    const workIds=new Set([...detached.works,...kept.works]);
    for(const w of all('SELECT * FROM work_sessions WHERE project_id=?',row.source_project_id)){if(!workIds.has(w.id))blockers.push(`Work ${w.id} has no complete resource/save boundary and cannot be assigned.`);for(const field of ['return_state_json','mapping_json','recipe_json'])relativeBlockers(JSON.parse(w[field]),`Work ${w.id}`,blockers);}
    for(const s of all('SELECT s.* FROM work_session_sources s JOIN work_sessions w ON w.id=s.session_id WHERE w.project_id=?',row.source_project_id))for(const field of ['fingerprint_json','profile_json'])if(s[field])relativeBlockers(JSON.parse(s[field]),`Work Source ${s.session_id}/${s.source_key}`,blockers);
    const boardIds=new Set([...detached.boards,...kept.boards]);for(const b of all('SELECT * FROM project_boards WHERE project_id=?',row.source_project_id)){if(!boardIds.has(b.id))blockers.push(`Board ${b.id} has no complete resource/save boundary and cannot be assigned.`);relativeBlockers(JSON.parse(b.blocks_json),`Board ${b.id}`,blockers);}
    for(const key of ['resources','works','saves','boards'])if(detached[key].some(id=>kept[key].includes(id)))blockers.push(`A ${key} dependency crosses the two selected boundaries.`);
    return {detached,kept,blockers:[...new Set(blockers)]};
  };
  const prepare=input=>{
    if(input.operation!=='split'||Object.hasOwn(input,'targetRelativePath'))reject('partition_existing supports split only and does not accept targetRelativePath.');
    if(!input.sourceProjectId||typeof input.requestKey!=='string'||!input.requestKey.trim())reject('Partition requires the source Project and request key.');
    if(typeof input.newProjectName!=='string'||!input.newProjectName.trim()||input.newProjectName.length>200)reject('Enter the new Project name.');
    const kept=relative(input.retainedRelativePath);const detached=relative(input.sourceRelativePath);
    if(kept.includes('/')||detached.includes('/')||kept.toLowerCase()===detached.toLowerCase())reject('Select two different direct child directories for the retained and new Project boundaries.');
    const prepareHash=hash(input);const previous=rows().find(r=>r.source_project_id===input.sourceProjectId&&r.prepare_key===input.requestKey);if(previous){if(previous.prepare_hash!==prepareHash)reject('Membership request key already identifies different facts.');return publicRow(previous);}
    assertRecoveryWritable(db,{projectId:input.sourceProjectId});assertDocumentUpdatesSettled(stateDir,input.sourceProjectId);
    const location=registry.projectContext.getActiveLocation(input.sourceProjectId);const project=ledger.getProject(input.sourceProjectId);if(!location||project.status!=='active')reject('Partition requires an active source Project in an adopted Root.');
    const root=path.resolve(location.root_path);const original=path.resolve(root,location.relative_path);if(original===root||!inside(root,original)||inside(original,stateDir)||inside(stateDir,original))reject('Partition cannot narrow the registered Root itself or overlap Runtime state.');
    const physical=writer({mode:'inspect',root,source:original,target:original});
    const actual=name=>Object.keys(physical.manifest).find(p=>!p.includes('/')&&p.toLowerCase()===name.toLowerCase()&&physical.manifest[p].kind==='directory');
    const retainedName=actual(kept);const detachedName=actual(detached);if(!retainedName||!detachedName)reject('Both selected boundaries must be existing real direct child directories.');
    const targetId=uid('PRJ');const sourcePath=path.join(original,detachedName);const retainedPath=path.join(original,retainedName);const boundary=(projectId,p)=>({project_id:projectId,path:p,relative_path:portable(path.relative(root,p))});
    const row={schema:'atlas.project-membership.v1',operation_id:uid('MEM'),operation:'split',mode:'partition_existing',status:'prepared',revision:1,root_id:location.root_id,root_path:root,source_project_id:input.sourceProjectId,target_project_id:targetId,
      source:{path:sourcePath,relative_path:portable(path.relative(root,sourcePath))},target:{path:sourcePath,relative_path:portable(path.relative(root,sourcePath))},new_project:{id:targetId,name:input.newProjectName.trim()},
      boundary_before:{source_project:boundary(input.sourceProjectId,original)},boundary_after:{source_project:boundary(input.sourceProjectId,retainedPath),new_project:boundary(targetId,sourcePath)},retained_name:retainedName,detached_name:detachedName,
      manifest:physical.manifest,ancestors:physical.ancestors,prepare_key:input.requestKey,prepare_hash:prepareHash,requests:[],pending:null,caller:input.caller??{}};
    rootCheck(row);row.partition_identities=identityFacts(row);const closed=closure(row);row.members=closed.detached;row.retained_members=closed.kept;row.blockers=closed.blockers;row.database=snapshot(row);
    const active=row.database.identities.filter(i=>i.status==='active'&&i.project_id===row.source_project_id);if(active.length>1||active.some(i=>i.signature_hash!==row.partition_identities.parent.signature_hash))row.blockers.push('Source Project identity no longer matches its original directory. Resolve the identity before partitioning.');
    row.summary={files:Object.values(row.manifest).filter(v=>v.kind==='file').length,bytes:physical.bytes,resources:row.members.resources.length+row.retained_members.resources.length,works:row.members.works.length+row.retained_members.works.length,saves:row.members.saves.length+row.retained_members.saves.length,boards:row.members.boards.length+row.retained_members.boards.length};
    row.digest=hash({operation_id:row.operation_id,mode:row.mode,manifest:row.manifest,identities:row.partition_identities,database:row.database,members:row.members,retained_members:row.retained_members,before:row.boundary_before,after:row.boundary_after,blockers:row.blockers});write(row);return publicRow(row);
  };
  const assertFiles=row=>{const observed=inspect(row);if(hash(observed.manifest)!==hash(row.manifest)||hash(identityFacts(row))!==hash(row.partition_identities))reject('Partition filesystem content, directory/file identity or Project identity changed. Files remain in place; refresh or resolve the pending operation.');};
  const projectAfter=(row,action,at,before)=>{
    const after=copy(before);const undo=action==='undo';const sourceId=row.source_project_id;const targetId=row.target_project_id;const source=after.projects.find(p=>p.id===sourceId);const sourceBoundary=undo?row.boundary_before.source_project:row.boundary_after.source_project;
    source.current_path=sourceBoundary.relative_path;source.updated_at=at;
    if(!undo)after.projects.push({id:targetId,name:row.new_project.name,current_path:row.target.relative_path,status:'active',parent_project_id:null,lineage_json:JSON.stringify({split_from:[sourceId]}),created_at:at,updated_at:at});
    else{const target=after.projects.find(p=>p.id===targetId);target.status='archived';target.updated_at=at;}
    for(const l of after.location_history)if(l.status==='active'){l.status='historical';l.valid_to=at;}
    const location=(id,b)=>({id:uid('LOC'),project_id:id,root_id:row.root_id,relative_path:b.relative_path,status:'active',valid_from:at,valid_to:null,reason:`${action} partition ${row.operation_id}`});
    after.location_history.push(location(sourceId,sourceBoundary));if(!undo)after.location_history.push(location(targetId,row.boundary_after.new_project));after.locations=after.location_history.filter(l=>l.status==='active');
    for(const h of after.path_history)if(h.valid_to===null)h.valid_to=at;
    let historyId=Number(db.prepare('SELECT coalesce(max(id),0) AS n FROM project_path_history').get().n);
    const history=(id,b)=>({id:++historyId,project_id:id,path:b.relative_path,valid_from:at,valid_to:null,reason:`${action} partition ${row.operation_id}`});
    after.path_history.push(history(sourceId,sourceBoundary));if(!undo)after.path_history.push(history(targetId,row.boundary_after.new_project));
    for(const identity of after.identities)if(identity.status==='active'){identity.status='historical';identity.valid_to=at;}
    const identity=(id,signature)=>({id:uid('PID'),project_id:id,signature_hash:signature.signature_hash,evidence_json:JSON.stringify(signature.evidence),stable_signals_json:JSON.stringify(signature.stable_signals),status:'active',valid_from:at,valid_to:null,reason:`${action} partition ${row.operation_id}`});
    if(!undo){after.identities.push(identity(sourceId,row.partition_identities.retained),identity(targetId,row.partition_identities.detached));}
    else{const original=row.initial_database.identities.find(i=>i.project_id===sourceId&&i.status==='active');if(original)after.identities.push({...original,id:uid('PID'),valid_from:at,valid_to:null,reason:`undo partition ${row.operation_id}`});}
    const detached=new Set(row.members.resources);const currentProject=r=>undo||!detached.has(r)?sourceId:targetId;const currentRoot=r=>undo?parent(row):detached.has(r)?row.source.path:row.boundary_after.source_project.path;
    for(const l of after.resource_location_history)if(l.status==='active'){l.status='historical';l.valid_to=at;}
    after.resources=after.resources.map(l=>{const evidence=context(JSON.parse(l.evidence_json),currentRoot(l.resource_id));if(Object.hasOwn(evidence,'project_id'))evidence.project_id=currentProject(l.resource_id);return {...l,id:uid('RLOC'),project_id:currentProject(l.resource_id),evidence_json:JSON.stringify(evidence),valid_from:at,valid_to:null};});after.resource_location_history.push(...copy(after.resources));
    after.relationships=after.relationships.map(r=>{const evidence=context(JSON.parse(r.evidence_json),currentRoot(r.source_resource_id));if(Object.hasOwn(evidence,'project_id'))evidence.project_id=currentProject(r.source_resource_id);
      if(r.target_kind==='project'&&r.target_id!==currentProject(r.source_resource_id)){const old=after.relationship_history.find(h=>h.id===r.id);old.status='historical';const retained=after.relationship_history.find(h=>h.source_resource_id===r.source_resource_id&&h.target_kind==='project'&&h.target_id===currentProject(r.source_resource_id)&&h.type===r.type&&h.status==='historical');const next={...r,id:retained?.id??uid('RREL'),target_id:currentProject(r.source_resource_id),evidence_json:JSON.stringify(evidence),effective_at:at};if(retained)Object.assign(retained,next);else after.relationship_history.push(copy(next));return next;}
      const next={...r,evidence_json:JSON.stringify(evidence)};Object.assign(after.relationship_history.find(h=>h.id===r.id),next);return next;});
    const detachedWorks=new Set(row.members.works);for(const work of after.works){const moved=detachedWorks.has(work.id);work.project_id=undo||!moved?sourceId:targetId;work.revision++;work.preview_json=null;work.preview_revision=null;work.updated_at=at;for(const field of ['return_state_json','mapping_json','recipe_json'])work[field]=JSON.stringify(context(JSON.parse(work[field]),undo?parent(row):moved?row.source.path:row.boundary_after.source_project.path));}
    for(const s of after.sources){const work=after.works.find(w=>w.id===s.session_id);for(const field of ['fingerprint_json','profile_json'])if(s[field])s[field]=JSON.stringify(context(JSON.parse(s[field]),undo?parent(row):work.project_id===targetId?row.source.path:row.boundary_after.source_project.path));s.updated_at=at;}
    for(const board of after.boards){const moved=row.members.boards.includes(board.id);board.project_id=undo||!moved?sourceId:targetId;board.revision++;board.updated_at=at;board.blocks_json=JSON.stringify(context(JSON.parse(board.blocks_json),undo?parent(row):moved?row.source.path:row.boundary_after.source_project.path));}
    if(!undo)after.project_relations.push({id:uid('REL'),source_project_id:targetId,relation_type:'split_from',target_project_id:sourceId,effective_at:at,details_json:JSON.stringify({operation_id:row.operation_id,mode:row.mode})});
    for(const [key,values]of Object.entries(after))if(Array.isArray(values)&&values.every(v=>Object.hasOwn(v,'id')))values.sort((a,b)=>typeof a.id==='number'?a.id-b.id:a.id.localeCompare(b.id));
    return after;
  };
  const insert=(table,row)=>{const keys=Object.keys(row);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));};
  const update=(table,row)=>{const keys=Object.keys(row).filter(k=>k!=='id');db.prepare(`UPDATE ${table} SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k=>row[k]),row.id);};
  const projectDatabase=row=>{
    const p=row.pending;const current=hash(snapshot(row));if(current===hash(p.after))return;if(current!==hash(p.before))reject('Partition database differs from both frozen states.');
    ledger.transaction(()=>{
      const tables={projects:'projects',location_history:'project_locations',path_history:'project_path_history',identities:'project_identity_signatures',resource_location_history:'resource_locations',relationship_history:'resource_relationships',works:'work_sessions',boards:'project_boards',project_relations:'project_relations'};
      for(const [key,table]of Object.entries(tables)){for(const old of p.before[key]){const next=p.after[key].find(r=>r.id===old.id);if(!next)reject('Partition cannot delete historical evidence.');if(hash(next)!==hash(old))update(table,next);}for(const next of p.after[key])if(!p.before[key].some(r=>r.id===next.id))insert(table,next);}
      for(const s of p.after.sources){const columns=Object.keys(s).filter(k=>!['session_id','source_key'].includes(k));db.prepare(`UPDATE work_session_sources SET ${columns.map(k=>`${k}=?`).join(',')} WHERE session_id=? AND source_key=?`).run(...columns.map(k=>s[k]),s.session_id,s.source_key);}
    });
    if(hash(snapshot(row))!==hash(p.after))reject('Partition database projection verification failed.');
  };
  const transition=(row,options,action)=>{
    if(row.status!==(action==='undo'?'applied':'prepared')||row.blockers.length)reject(`Partition cannot ${action}: ${row.blockers.join(' ')||row.status}`);
    for(const id of [row.source_project_id,row.target_project_id]){assertRecoveryWritable(db,{projectId:id});assertDocumentUpdatesSettled(stateDir,id);}rootCheck(row);assertFiles(row);
    const before=snapshot(row);if(hash(before)!==hash(row.database))reject('Partition Project, Work, Save, Board, Resource, identity or history state changed after preview.');
    if(action==='execute'){const closed=closure(row);if(closed.blockers.length||hash(closed.detached)!==hash(row.members)||hash(closed.kept)!==hash(row.retained_members))reject('Partition dependency closure changed after preview.');}
    const at=new Date().toISOString();row.initial_database??=copy(before);const after=projectAfter(row,action,at,before);const key=requestHash(action,options);row.requests.push({action,key:options.requestKey,hash:key,result:null});row.pending={action,before,after,at,request_hash:key};row.status='needs_recovery';write(row);
    beforeDatabaseMove?.(publicRow(row));projectDatabase(row);afterDatabaseMove?.(publicRow(row));assertFiles(row);return finish(row);
  };
  const recover=(row,options)=>{
    if(!row.pending||row.status!=='needs_recovery')reject('Partition has no pending database transition to recover.');rootCheck(row);assertFiles(row);const current=hash(snapshot(row));if(![hash(row.pending.before),hash(row.pending.after)].includes(current))reject('Partition database differs from both frozen recovery states.');
    row.requests.push({action:'recover',key:options.requestKey,hash:requestHash('recover',options),result:null});write(row);projectDatabase(row);assertFiles(row);return finish(row);
  };
  return {prepare,transition,recover};
}
