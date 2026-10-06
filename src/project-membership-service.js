import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Registry } from './registry.js';
import { projectMoveWrite } from './project-move-writer.js';
import { withStateLock } from './state-lock.js';
import { assertRecoveryWritable, assertDocumentUpdatesSettled, assertReferenceRepairsUndone } from './storage/recovery-write-guard.js';
import { verifyUndoneReferenceRepairs, verifyFrozenReferenceRepairs } from './reference-repair-roundtrip.js';
import { createProjectMembershipPartition } from './project-membership-partition.js';

const now = () => new Date().toISOString();
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = (value) => JSON.parse(JSON.stringify(value));
const conflict = (message) => Object.assign(new Error(message), { code: 'ATLAS_STATE_CONFLICT' });
const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
const inside = (root, value) => { const r = path.relative(root, value); return r === '' || !r.startsWith('..') && !path.isAbsolute(r); };
const portable = (value) => value.replaceAll('\\', '/');
function relative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw invalid('Choose one relative directory inside the registered Root.');
  const parts = portable(value).split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/u.test(p) || /[ .]$/u.test(p)
    || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(p))) throw invalid('Directory path contains unsupported segments.');
  return parts.join('/');
}
function ancestors(value, missingLast = false) {
  let cursor = path.parse(value).root; const parts = value.slice(cursor.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]); let s;
    try { s = fs.lstatSync(cursor); } catch (e) { if (e.code === 'ENOENT' && missingLast && i === parts.length - 1) return; throw conflict('Directory ancestor is unavailable.'); }
    if (!s.isDirectory() || s.isSymbolicLink()) throw conflict('Directory paths cannot traverse links or non-directories.');
  }
}
function mapped(value, from, to) {
  if (Array.isArray(value)) return value.map(v => mapped(v, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,
    ['path','file_path','source_path','target_path','result_path','project_root'].includes(k) && typeof v === 'string' && path.isAbsolute(v) && inside(from,v)
      ? path.join(to,path.relative(from,v)) : mapped(v,from,to)]));
  return value;
}

export function createProjectMembershipService({ stateDir, registry = null, resourceControl = null, writer = projectMoveWrite, afterPhysicalMove = null, beforeDatabaseMove = null, afterDatabaseMove = null } = {}) {
  stateDir = path.resolve(stateDir); const ownsRegistry = !registry; registry ??= new Registry({ stateDir });
  if (path.resolve(registry.stateDir) !== stateDir) throw invalid('Project membership and Registry require the same state directory.');
  const ledger = registry.ledger; const db = ledger.db; const directory = path.join(stateDir,'project-memberships');
  const all = (sql, ...args) => { const rows = db.prepare(sql).all(...args); if (rows.length > 10000) throw conflict('Project dependency inspection exceeds its row limit.'); return copy(rows); };
  const file = (id) => { if (!/^MEM-[a-f0-9-]{36}$/u.test(id ?? '')) throw invalid('Invalid Project membership operation ID.'); return path.join(directory,`${id}.json`); };
  const validate = (row) => {
    if (row?.schema !== 'atlas.project-membership.v1' || !['split','merge'].includes(row.operation) || !Number.isInteger(row.revision) || row.revision < 1
      || !['prepared','applied','undone','needs_recovery','conflict'].includes(row.status) || Boolean(row.pending) !== (row.status === 'needs_recovery')
      || !row.database || !row.members || !row.manifest || !Array.isArray(row.blockers) || !Array.isArray(row.requests)
      || typeof row.source_project_id !== 'string' || typeof row.target_project_id !== 'string' || !path.isAbsolute(row.root_path ?? '')
      || !path.isAbsolute(row.source?.path ?? '') || !path.isAbsolute(row.target?.path ?? '') || !inside(row.root_path,row.source.path) || !inside(row.root_path,row.target.path)
      || ![undefined,'move_tree','partition_existing'].includes(row.mode)
      || row.mode !== 'partition_existing' && (inside(row.source.path,row.target.path) || inside(row.target.path,row.source.path))
      || row.pending && (!row.pending.before || !row.pending.after || !['execute','undo'].includes(row.pending.action))) throw conflict('Project membership journal identity or state is invalid.');
    if(row.mode==='partition_existing'){
      const before=row.boundary_before?.source_project;const kept=row.boundary_after?.source_project;const detached=row.boundary_after?.new_project;
      if(row.operation!=='split'||!row.retained_members||!row.partition_identities||!before||!kept||!detached||before.project_id!==row.source_project_id||kept.project_id!==row.source_project_id||detached.project_id!==row.target_project_id
        || !path.isAbsolute(before.path??'')||!inside(row.root_path,before.path)||before.path===row.root_path||path.dirname(kept.path??'')!==before.path||path.dirname(detached.path??'')!==before.path||kept.path===detached.path
        || detached.path!==row.source.path||row.target.path!==row.source.path)throw conflict('Partition boundary journal is invalid.');
    }
    file(row.operation_id); return row;
  };
  const write = (row) => {
    validate(row); const body = JSON.stringify(row); if (Buffer.byteLength(body) > 8*1024*1024) throw conflict('Project membership journal exceeds its byte limit.');
    ancestors(stateDir); fs.mkdirSync(directory,{recursive:true}); ancestors(directory); const target = file(row.operation_id);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw conflict('Project membership journal is linked.');
    const temporary = `${target}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temporary,body,{flag:'wx'});
    const fd = fs.openSync(temporary,'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temporary,target);
  };
  const read = (id, sourceProjectId) => {
    ancestors(directory); const target = file(id); const s = fs.lstatSync(target);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 8*1024*1024) throw conflict('Project membership journal is not a bounded regular file.');
    let row; try { row = validate(JSON.parse(fs.readFileSync(target,'utf8'))); } catch (e) { if (e.code === 'ATLAS_STATE_CONFLICT') throw e; throw conflict('Project membership journal is unreadable.'); }
    if (row.operation_id !== id || row.source_project_id !== sourceProjectId) throw conflict('Project membership identity does not match the source Project.'); return row;
  };
  const rows = () => {
    if (!fs.existsSync(directory)) { ancestors(stateDir); return []; } ancestors(directory); const names=fs.readdirSync(directory).filter(n=>!n.endsWith('.tmp'));
    if(names.length>10000) throw conflict('Project membership journal exceeds its record limit.'); let total=0;
    return names.map(n=>{ if(!/^MEM-[a-f0-9-]{36}\.json$/u.test(n))throw conflict('Unknown Project membership journal record.');const p=path.join(directory,n);const s=fs.lstatSync(p);
      if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024||(total+=s.size)>64*1024*1024)throw conflict('Project membership journal exceeds its bounded byte budget.');
      return validate(JSON.parse(fs.readFileSync(p,'utf8'))); });
  };
  const saves = () => {
    const p = path.join(stateDir,'ui/saved-work.json'); if(!fs.existsSync(p))return [];
    ancestors(path.dirname(p)); const s=fs.lstatSync(p); if(!s.isFile()||s.isSymbolicLink()||s.size>16*1024*1024)throw conflict('Save journal is not a bounded regular file.');
    const items=JSON.parse(fs.readFileSync(p,'utf8')).items; if(!Array.isArray(items)||items.length>10000)throw conflict('Save journal exceeds its record limit.'); return items;
  };
  const activeResource = (id) => { const matches=all("SELECT * FROM resource_locations WHERE resource_id=? AND status='active' ORDER BY id",id);return matches.length===1?matches[0]:null; };
  const byPath = (p) => {
    if(typeof p!=='string')return null; const matches=all('SELECT DISTINCT resource_id FROM resource_locations WHERE path=? COLLATE NOCASE',path.resolve(p));
    return matches.length===1 ? activeResource(matches[0].resource_id) : null;
  };
  const saveFacts = (s) => {
    const linked=db.prepare('SELECT resource_id FROM resource_save_links WHERE save_id=?').get(s.save_id)?.resource_id;
    const output=linked?activeResource(linked):null;
    const inputs=(s.inputs??s.prepare_request?.inputs??[]).map(i=>byPath(typeof i==='string'?path.resolve(s.prepare_request?.root??'.',i): i.path??(i.relative_path&&s.prepare_request?.root?path.resolve(s.prepare_request.root,i.relative_path):null)));
    const sources=[s.source,...(s.source?.sources??[])].filter(i=>i&&(i.path||i.resource_id)).map(i=>i.resource_id?activeResource(i.resource_id):byPath(i.path));
    return { output, inputs:[...inputs,...sources] };
  };
  const configTables=['saved_resource_views','resource_property_definitions','resource_property_batches','resource_property_candidate_batches','row_property_candidate_batches','resource_link_candidates'];
  const graph = (row) => {
    const moving=all("SELECT * FROM resource_locations WHERE status='active' ORDER BY id").filter(l=>inside(row.source.path,l.path)); const ids=new Set(moving.map(l=>l.resource_id));const blockers=[];
    for(const l of moving)if(l.project_id!==row.source_project_id||!activeResource(l.resource_id))blockers.push(`Resource ${l.resource_id} has a foreign or ambiguous location.`);
    if(row.operation==='merge')for(const l of all("SELECT * FROM resource_locations WHERE project_id=? AND status='active'",row.source_project_id))if(!ids.has(l.resource_id))blockers.push(`Resource ${l.resource_id} is outside the source tree.`);
    for(const l of moving){const entry=row.manifest[portable(path.relative(row.source.path,l.path))];if(!entry||entry.kind!=='file')blockers.push(`Resource ${l.resource_id} is missing from the inspected tree.`);}
    const selectedSaves=[];const saveIds=new Set();
    for(const s of saves()) {
      const facts=saveFacts(s);const reserved=s.target?.path??(s.prepare_request?.root&&s.prepare_request?.target?path.resolve(s.prepare_request.root,s.prepare_request.target):null);
      const touches=facts.output&&ids.has(facts.output.resource_id)||facts.inputs.some(l=>l&&ids.has(l.resource_id))||reserved&&inside(row.source.path,reserved);
      if(!touches)continue;selectedSaves.push(s.save_id);saveIds.add(s.save_id);
      if(s.status!=='executed'||!facts.output||!ids.has(facts.output.resource_id)||facts.inputs.some(l=>!l||!ids.has(l.resource_id)||l.project_id!==row.source_project_id))blockers.push(`Save ${s.save_id} is unfinished, has an unidentified input, or crosses the move tree.`);
      if(s.source?.kind==='capture_source')blockers.push(`Capture Source Save ${s.save_id} has Project-level configuration that this membership operation cannot transfer.`);
    }
    const works=all('SELECT * FROM work_sessions ORDER BY id').filter(w=>row.operation==='merge'&&w.project_id===row.source_project_id||all('SELECT resource_id FROM work_session_sources WHERE session_id=?',w.id).some(s=>ids.has(s.resource_id))||saveIds.has(w.latest_save_id));
    for(const w of works){const sources=all('SELECT * FROM work_session_sources WHERE session_id=?',w.id);if(w.project_id!==row.source_project_id||sources.some(s=>!ids.has(s.resource_id))||w.latest_save_id&&!saveIds.has(w.latest_save_id))blockers.push(`Work ${w.id} is outside this Project or its dependencies are not closed inside the tree.`);}
    const boards=all('SELECT * FROM project_boards ORDER BY id').filter(b=>row.operation==='merge'&&b.project_id===row.source_project_id||JSON.parse(b.blocks_json).some(b=>ids.has(b.resource_id)||saveIds.has(b.save_id)));
    for(const b of boards)if(b.project_id!==row.source_project_id||JSON.parse(b.blocks_json).some(b=>b.type==='material_reference'&&!ids.has(b.resource_id)||b.type==='result_preview'&&!saveIds.has(b.save_id)))blockers.push(`Board ${b.id} has a third-party or cross-tree reference; the whole Board must travel together.`);
    const relations=all("SELECT * FROM resource_relationships WHERE status='active' ORDER BY id").filter(r=>ids.has(r.source_resource_id)||r.target_kind==='resource'&&ids.has(r.target_id));
    for(const r of relations)if(r.target_kind==='resource'&&(!ids.has(r.source_resource_id)||!ids.has(r.target_id))||r.target_kind==='project'&&r.target_id!==row.source_project_id)blockers.push(`Resource relationship ${r.id} crosses a third-party dependency.`);
    for(const table of configTables)if(all(`SELECT id FROM ${table} WHERE project_id=?`,row.source_project_id).length)blockers.push(`Project configuration ${table} is not supported by this move_tree operation.`);
    if(all("SELECT id FROM project_context_links WHERE status='active' AND (source_project_id=? OR target_project_id=?)",row.source_project_id,row.source_project_id).length)blockers.push('Project context links must be resolved before changing membership.');
    return { resources:[...ids].sort(), works:works.map(w=>w.id).sort(), boards:boards.map(b=>b.id).sort(), saves:selectedSaves.sort(), blockers:[...new Set(blockers)] };
  };
  const snapshot = (row) => {
    const ids=[row.source_project_id,row.target_project_id];const members=new Set([...row.members.resources,...(row.mode==='partition_existing'?row.retained_members.resources:[])]);
    const locations=all("SELECT * FROM resource_locations WHERE status='active' ORDER BY id").filter(l=>ids.includes(l.project_id)||members.has(l.resource_id));
    const works=all('SELECT * FROM work_sessions ORDER BY id').filter(w=>ids.includes(w.project_id)||all('SELECT resource_id FROM work_session_sources WHERE session_id=?',w.id).some(s=>members.has(s.resource_id)));
    const workIds=new Set(works.map(w=>w.id));const saveIds=new Set([...row.members.saves,...(row.mode==='partition_existing'?row.retained_members.saves:[])]);
    return { projects:all('SELECT * FROM projects WHERE id IN (?,?) ORDER BY id',...ids), locations:all("SELECT * FROM project_locations WHERE project_id IN (?,?) AND status='active' ORDER BY id",...ids), resources:locations,
      resource_facts:all('SELECT * FROM resources ORDER BY id').filter(r=>members.has(r.id)), resource_actions:all('SELECT * FROM resource_actions ORDER BY id').filter(r=>members.has(r.resource_id)),
      save_links:all('SELECT * FROM resource_save_links ORDER BY save_id,resource_id').filter(r=>members.has(r.resource_id)||saveIds.has(r.save_id)),
      relationships:all("SELECT * FROM resource_relationships WHERE status='active' ORDER BY id").filter(r=>members.has(r.source_resource_id)||r.target_kind==='resource'&&members.has(r.target_id)),
      works, sources:all('SELECT * FROM work_session_sources ORDER BY session_id,source_key').filter(s=>workIds.has(s.session_id)),
      boards:all('SELECT * FROM project_boards ORDER BY id').filter(b=>ids.includes(b.project_id)||JSON.parse(b.blocks_json).some(b=>members.has(b.resource_id)||saveIds.has(b.save_id))),
      saves:saves().filter(s=>ids.includes(s.project?.id)||saveIds.has(s.save_id)||saveFacts(s).inputs.some(l=>l&&members.has(l.resource_id))),
      rounds:all('SELECT * FROM recovery_rounds WHERE project_id IN (?,?) ORDER BY id',...ids),
      configurations:Object.fromEntries(configTables.map(t=>[t,all(`SELECT * FROM ${t} WHERE project_id IN (?,?) ORDER BY id`,...ids)])),
      contexts:all('SELECT * FROM project_context_links WHERE source_project_id IN (?,?) OR target_project_id IN (?,?) ORDER BY id',...ids,...ids),
      ...(row.mode==='partition_existing'?{
        location_history:all('SELECT * FROM project_locations WHERE project_id IN (?,?) ORDER BY id',...ids),
        path_history:all('SELECT * FROM project_path_history WHERE project_id IN (?,?) ORDER BY id',...ids),
        identities:all('SELECT * FROM project_identity_signatures WHERE project_id IN (?,?) ORDER BY id',...ids),
        resource_location_history:all('SELECT * FROM resource_locations ORDER BY id').filter(l=>members.has(l.resource_id)),
        relationship_history:all('SELECT * FROM resource_relationships ORDER BY id').filter(r=>members.has(r.source_resource_id)||r.target_kind==='resource'&&members.has(r.target_id)),
        project_relations:all('SELECT * FROM project_relations WHERE source_project_id IN (?,?) OR target_project_id IN (?,?) ORDER BY id',...ids,...ids)
      }:{}) };
  };
  const publicRow = (r) => ({ operation_id:r.operation_id,operation:r.operation,status:r.status,revision:r.revision,digest:r.digest,source_project_id:r.source_project_id,target_project_id:r.target_project_id,
    source:r.source,target:r.target,new_project:r.new_project,summary:r.summary,blockers:r.blockers,can_execute:r.status==='prepared'&&!r.blockers.length,
    ...(r.mode==='partition_existing'?{mode:r.mode,files_moved:false,file_changes:[],boundary_before:r.boundary_before,boundary_after:r.boundary_after}:{}) });
  const digest = (r) => hash({ operation_id:r.operation_id,operation:r.operation,revision:r.revision,status:r.status,source:r.source,target:r.target,root:r.root_path,root_id:r.root_id,source_project_id:r.source_project_id,target_project_id:r.target_project_id,new_project:r.new_project,members:r.members,manifest:r.manifest,database:r.database,blockers:r.blockers,...(r.mode==='partition_existing'?{mode:r.mode,retained_members:r.retained_members,identities:r.partition_identities,boundary_before:r.boundary_before,boundary_after:r.boundary_after}:{}) });
  const rootCheck = (row) => {
    const root=registry.projectContext.getRoot(row.root_id).root;if(root.governance_status!=='adopted'||path.resolve(root.current_path)!==row.root_path)throw conflict('Registered Root changed after this preview.');
    ancestors(row.root_path);
    for(const l of registry.projectContext.listActiveLocations()) {
      if([row.source_project_id,row.target_project_id].includes(l.project_id))continue; const p=path.resolve(l.root_path,l.relative_path);
      if((row.mode==='partition_existing'?[row.boundary_before.source_project.path]:[row.source.path,row.target.path]).some(v=>inside(v,p)||inside(p,v)))throw conflict('Membership paths overlap another active Project.');
    }
  };
  const inspect = (row,which) => {
    const p=row[which].path;try{fs.lstatSync(p);}catch(e){if(e.code==='ENOENT'){ancestors(p,true);return null;}throw e;}
    return writer({mode:'inspect',root:row.root_path,source:p,target:row[which==='source'?'target':'source'].path,expectedAncestors:row.ancestors}).manifest;
  };
  const prepare = (input) => withStateLock(stateDir,()=>{
    if(input.mode==='partition_existing')return partition.prepare(input);
    if(!['split','merge'].includes(input.operation))throw invalid('Only split or merge with move_tree is supported. Metadata-only membership and cross-Root moves are unsupported.');
    if(input.mode&&input.mode!=='move_tree')throw invalid('Only move_tree membership is supported.');
    if(typeof input.requestKey!=='string'||!input.requestKey.trim()||!input.sourceProjectId)throw invalid('Membership requires a source Project and request key.');
    const requestHash=hash(input);const previous=rows().find(r=>r.source_project_id===input.sourceProjectId&&r.prepare_key===input.requestKey);
    if(previous){if(previous.prepare_hash!==requestHash)throw conflict('Membership request key already identifies different facts.');return publicRow(previous);}
    const source=registry.projectContext.getActiveLocation(input.sourceProjectId);const sourceProject=ledger.getProject(input.sourceProjectId);
    if(!source||sourceProject.status!=='active')throw conflict('Source Project requires an active registered location.');
    assertRecoveryWritable(db,{projectId:input.sourceProjectId});assertDocumentUpdatesSettled(stateDir,input.sourceProjectId);
    const root=path.resolve(source.root_path);const projectPath=path.resolve(root,source.relative_path);let targetProjectId;let targetPath;let newProject=null;
    const sourcePath=input.operation==='split'?path.resolve(projectPath,relative(input.sourceRelativePath)):projectPath;
    if(input.operation==='split'){
      if(!inside(projectPath,sourcePath)||sourcePath===projectPath)throw conflict('Split requires one complete child directory inside the source Project.');
      if(typeof input.newProjectName!=='string'||!input.newProjectName.trim()||input.newProjectName.length>200)throw invalid('Enter the new Project name.');
      targetProjectId=`PRJ-${crypto.randomUUID()}`;newProject={id:targetProjectId,name:input.newProjectName.trim()};targetPath=path.resolve(root,relative(input.targetRelativePath));
      if(inside(projectPath,targetPath)||inside(targetPath,projectPath))throw conflict('Split target must be outside the source Project inside the same Root.');
    }else{
      targetProjectId=input.targetProjectId;const target=registry.projectContext.getActiveLocation(targetProjectId);const project=ledger.getProject(targetProjectId);
      if(targetProjectId===input.sourceProjectId||!target||project.status!=='active'||target.root_id!==source.root_id)throw conflict('Merge requires a different active target Project inside the same Root.');
      assertRecoveryWritable(db,{projectId:targetProjectId});assertDocumentUpdatesSettled(stateDir,targetProjectId);
      targetPath=path.resolve(root,target.relative_path,relative(input.targetRelativePath));
    }
    if(sourcePath===root||!inside(root,sourcePath)||!inside(root,targetPath)||inside(sourcePath,targetPath)||inside(targetPath,sourcePath)||[sourcePath,targetPath].some(p=>inside(p,stateDir)||inside(stateDir,p)))throw conflict('Membership directories overlap, escape the Root, or contain Runtime state.');
    ancestors(sourcePath);ancestors(targetPath,true);if(fs.existsSync(targetPath))throw conflict('Membership target already exists. Choose an absent directory.');
    const row={schema:'atlas.project-membership.v1',operation_id:`MEM-${crypto.randomUUID()}`,operation:input.operation,status:'prepared',revision:1,root_id:source.root_id,root_path:root,
      source_project_id:input.sourceProjectId,target_project_id:targetProjectId,source:{path:sourcePath,relative_path:portable(path.relative(root,sourcePath))},target:{path:targetPath,relative_path:portable(path.relative(root,targetPath))},new_project:newProject,
      prepare_key:input.requestKey,prepare_hash:requestHash,requests:[],pending:null,caller:input.caller??{}};
    rootCheck(row);const physical=writer({mode:'inspect',root,source:sourcePath,target:targetPath});row.manifest=physical.manifest;row.ancestors=physical.ancestors;
    row.members=graph(row);row.blockers=row.members.blockers;row.database=snapshot(row);row.summary={files:Object.values(row.manifest).filter(v=>v.kind==='file').length,bytes:physical.bytes,resources:row.members.resources.length,works:row.members.works.length,saves:row.members.saves.length,boards:row.members.boards.length};
    row.digest=digest(row);write(row);return publicRow(row);
  });
  const bind=(r,o)=>{if(o.expectedRevision!==r.revision||o.expectedDigest!==r.digest)throw conflict('Membership preview changed. Refresh before confirming.');if(typeof o.requestKey!=='string'||!o.requestKey.trim())throw invalid('Membership requires a request key.');};
  const requestHash=(action,o)=>hash({action,...o});
  const replay=(r,action,o)=>{const previous=r.requests.find(v=>v.action===action&&v.key===o.requestKey);if(!previous)return null;if(previous.hash!==requestHash(action,o))throw conflict('Membership request key already identifies different facts.');return previous.result??null;};
  const projectAfter = (row,action,at,before) => {
    const after=copy(before);const undo=action==='undo';const from=undo?row.target.path:row.source.path;const to=undo?row.source.path:row.target.path;
    const projectId=undo?row.source_project_id:row.target_project_id;const source=after.projects.find(p=>p.id===row.source_project_id);
    if(!undo&&row.operation==='split')after.projects.push({id:projectId,name:row.new_project.name,current_path:row.target.relative_path,status:'active',parent_project_id:null,lineage_json:JSON.stringify({split_from:[row.source_project_id]}),created_at:at,updated_at:at});
    if(row.operation==='merge'){source.status=undo?'active':'merged';source.updated_at=at;}
    if(undo&&row.operation==='split'){const p=after.projects.find(p=>p.id===row.target_project_id);p.status='archived';p.updated_at=at;}
    if(!undo&&row.operation==='split')after.locations.push({id:`LOC-${crypto.randomUUID()}`,project_id:projectId,root_id:row.root_id,relative_path:row.target.relative_path,status:'active',valid_from:at,valid_to:null,reason:`Project membership ${row.operation_id}`});
    if(!undo&&row.operation==='merge'||undo&&row.operation==='split')after.locations=after.locations.filter(l=>l.project_id!== (undo?row.target_project_id:row.source_project_id));
    if(undo&&row.operation==='merge'){const old=row.initial_database.locations.find(l=>l.project_id===row.source_project_id);after.locations.push({...old,id:`LOC-${crypto.randomUUID()}`,valid_from:at,valid_to:null,reason:`Undo membership ${row.operation_id}`});}
    after.resources=after.resources.map(l=>row.members.resources.includes(l.resource_id)?{...l,id:`RLOC-${crypto.randomUUID()}`,project_id:projectId,path:path.join(to,path.relative(from,l.path)),evidence_json:JSON.stringify(mapped(JSON.parse(l.evidence_json),from,to)),valid_from:at,valid_to:null}:l);
    const members=new Set(row.members.resources);
    after.relationships=after.relationships.map(r=>{
      if(r.target_kind==='project'&&members.has(r.source_resource_id)){
        // Reuse the endpoint's retained relationship row when membership returns.
        // The original snapshots remain in the operation journal; no history row is deleted.
        const retained=db.prepare("SELECT id FROM resource_relationships WHERE source_resource_id=? AND target_kind='project' AND target_id=? AND type=? AND status='historical'").get(r.source_resource_id,projectId,r.type);
        return {...r,id:retained?.id??`RREL-${crypto.randomUUID()}`,target_id:projectId,effective_at:at,evidence_json:JSON.stringify(mapped(JSON.parse(r.evidence_json),from,to))};
      }
      if(r.target_kind==='resource'&&members.has(r.source_resource_id)){const e=mapped(JSON.parse(r.evidence_json),from,to);if(e.project_id)e.project_id=projectId;return {...r,evidence_json:JSON.stringify(e)};}return r;
    });
    for(const w of after.works)if(row.members.works.includes(w.id)){w.project_id=projectId;w.revision+=1;w.preview_json=null;w.preview_revision=null;w.updated_at=at;for(const f of ['return_state_json','mapping_json','recipe_json'])w[f]=JSON.stringify(mapped(JSON.parse(w[f]),from,to));}
    for(const s of after.sources)if(row.members.works.includes(s.session_id)){for(const f of ['fingerprint_json','profile_json'])if(s[f])s[f]=JSON.stringify(mapped(JSON.parse(s[f]),from,to));s.updated_at=at;}
    for(const b of after.boards)if(row.members.boards.includes(b.id)){b.project_id=projectId;b.revision+=1;b.updated_at=at;b.blocks_json=JSON.stringify(mapped(JSON.parse(b.blocks_json),from,to));}
    for(const key of ['projects','locations','resources','relationships'])after[key].sort((a,b)=>a.id.localeCompare(b.id));return after;
  };
  const insert=(table,r)=>{const columns=Object.keys(r);db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>r[k]));};
  const update=(table,r,key='id')=>{const columns=Object.keys(r).filter(k=>k!==key);db.prepare(`UPDATE ${table} SET ${columns.map(k=>`${k}=?`).join(',')} WHERE ${key}=?`).run(...columns.map(k=>r[k]),r[key]);};
  const projectDatabase=(row)=>{
    const p=row.pending;const current=snapshot(row);if(hash(current)===hash(p.after))return;if(hash(current)!==hash(p.before))throw conflict('Membership Project state differs from both recorded states.');
    ledger.transaction(()=>{
      for(const r of p.after.projects){if(p.before.projects.some(v=>v.id===r.id))update('projects',r);else{insert('projects',r);db.prepare('INSERT INTO project_path_history(project_id,path,valid_from,reason) VALUES(?,?,?,?)').run(r.id,r.current_path,p.at,`Project membership ${row.operation_id}`);db.prepare('INSERT INTO project_relations(id,source_project_id,relation_type,target_project_id,effective_at,details_json) VALUES(?,?,?,?,?,?)').run(`REL-${crypto.randomUUID()}`,r.id,'split_from',row.source_project_id,p.at,JSON.stringify({operation_id:row.operation_id}));}}
      for(const r of p.before.locations)if(!p.after.locations.some(v=>v.id===r.id))db.prepare("UPDATE project_locations SET status='historical',valid_to=? WHERE id=?").run(p.at,r.id);
      for(const r of p.after.locations)if(!p.before.locations.some(v=>v.id===r.id))insert('project_locations',r);
      for(const r of p.before.resources)if(!p.after.resources.some(v=>v.id===r.id))db.prepare("UPDATE resource_locations SET status='historical',valid_to=? WHERE id=?").run(p.at,r.id);
      for(const r of p.after.resources)if(!p.before.resources.some(v=>v.id===r.id))insert('resource_locations',r);
      for(const r of p.before.relationships)if(!p.after.relationships.some(v=>v.id===r.id))db.prepare("UPDATE resource_relationships SET status='historical' WHERE id=?").run(r.id);
      for(const r of p.after.relationships)if(db.prepare('SELECT id FROM resource_relationships WHERE id=?').get(r.id))update('resource_relationships',r);else insert('resource_relationships',r);
      for(const r of p.after.works)if(row.members.works.includes(r.id))update('work_sessions',r);
      for(const r of p.after.sources)if(row.members.works.includes(r.session_id)){const columns=Object.keys(r).filter(k=>!['session_id','source_key'].includes(k));db.prepare(`UPDATE work_session_sources SET ${columns.map(k=>`${k}=?`).join(',')} WHERE session_id=? AND source_key=?`).run(...columns.map(k=>r[k]),r.session_id,r.source_key);}
      for(const r of p.after.boards)if(row.members.boards.includes(r.id))update('project_boards',r);
      if(row.operation==='merge'&&p.action==='execute')db.prepare('INSERT INTO project_relations(id,source_project_id,relation_type,target_project_id,effective_at,details_json) VALUES(?,?,?,?,?,?)').run(`REL-${crypto.randomUUID()}`,row.source_project_id,'merged_into',row.target_project_id,p.at,JSON.stringify({operation_id:row.operation_id}));
    });
    if(hash(snapshot(row))!==hash(p.after))throw conflict('Membership database projection verification failed.');
  };
  const finish=(row)=>{const p=row.pending;if(p.accepted_reference_roundtrips)row.accepted_reference_roundtrips=p.accepted_reference_roundtrips;row.status=p.action==='undo'?'undone':'applied';row.revision+=1;row.database=snapshot(row);row.pending=null;row.digest=digest(row);const result=publicRow(row);for(const r of row.requests)if(!r.result&&(r.hash===p.request_hash||r.action==='recover'))r.result=result;write(row);return result;};
  const transition=(id,o,action)=>withStateLock(stateDir,()=>{
    const row=read(id,o.sourceProjectId);const old=replay(row,action,o);if(old)return old;bind(row,o);
    if(row.mode==='partition_existing')return partition.transition(row,o,action);
    if(row.status!==(action==='undo'?'applied':'prepared')||row.blockers.length)throw conflict(`Membership cannot ${action}; ${row.blockers.join(' ')||row.status}`);
    if(action==='undo')assertReferenceRepairsUndone(stateDir,'project_membership',id);
    for(const id of [row.source_project_id,row.target_project_id]){assertRecoveryWritable(db,{projectId:id});assertDocumentUpdatesSettled(stateDir,id);}rootCheck(row);
    const before=snapshot(row);let accepted=[];
    if(action==='undo')accepted=verifyUndoneReferenceRepairs({stateDir,db,sourceKind:'project_membership',operationId:id,sourceProjectId:row.source_project_id,rootId:row.root_id,revision:row.revision,digest:row.digest,baseline:row.database,current:before,rootPath:row.root_path});
    else if(hash(before)!==hash(row.database))throw conflict('Project, Work, Board, Save, or dependency state changed after the membership preview.');
    if(action==='execute'&&hash(graph(row))!==hash(row.members))throw conflict('Membership dependency closure changed after preview.');
    const which=action==='undo'?'target':'source';if(hash(inspect(row,which))!==hash(row.manifest)||inspect(row,which==='source'?'target':'source')!==null)throw conflict('Membership tree changed or destination is occupied.');
    const at=now();row.initial_database??=copy(before);const after=projectAfter(row,action,at,before);const key=requestHash(action,o);row.requests.push({action,key:o.requestKey,hash:key,result:null});
    row.pending={action,before,after,at,from:row[which],to:row[which==='source'?'target':'source'],request_hash:key,...(action==='undo'?{accepted_reference_roundtrips:accepted}:{})};row.status='needs_recovery';write(row);
    writer({mode:'move',root:row.root_path,source:row.pending.from.path,target:row.pending.to.path,expectedManifest:row.manifest,expectedAncestors:row.ancestors});afterPhysicalMove?.(publicRow(row));projectDatabase(row);afterDatabaseMove?.(publicRow(row));return finish(row);
  });
  const recover=(id,o)=>withStateLock(stateDir,()=>{
    const row=read(id,o.sourceProjectId);const old=replay(row,'recover',o);if(old)return old;bind(row,o);if(row.mode==='partition_existing')return partition.recover(row,o);if(!row.pending)throw conflict('Membership has no pending operation to recover.');rootCheck(row);
    const p=row.pending;const which=p.action==='undo'?'target':'source';const before=inspect(row,which);const after=inspect(row,which==='source'?'target':'source');
    const beforeMatches=hash(before)===hash(row.manifest)&&after===null;const afterMatches=before===null&&hash(after)===hash(row.manifest);const current=hash(snapshot(row));
    if(!beforeMatches&&!afterMatches||beforeMatches&&current!==hash(p.before)||afterMatches&&![hash(p.before),hash(p.after)].includes(current))throw conflict('Membership filesystem and database differ from the recorded recoverable states.');
    if(p.accepted_reference_roundtrips)verifyFrozenReferenceRepairs({stateDir,db,sourceKind:'project_membership',operationId:id,accepted:p.accepted_reference_roundtrips,rootPath:row.root_path,fromPath:p.from.path,toPath:p.to.path,physicalAfter:afterMatches});
    row.requests.push({action:'recover',key:o.requestKey,hash:requestHash('recover',o),result:null});write(row);
    if(beforeMatches)writer({mode:'move',root:row.root_path,source:p.from.path,target:p.to.path,expectedManifest:row.manifest,expectedAncestors:row.ancestors});projectDatabase(row);return finish(row);
  });
  const referenceBasis=(id,{sourceProjectId,expectedRevision,expectedDigest})=>{
    const row=read(id,sourceProjectId);
    if(row.mode==='partition_existing')throw conflict('Partition existing does not move file paths and has no reference-repair basis.');
    if(row.status!=='applied'||row.pending||row.revision!==expectedRevision||row.digest!==expectedDigest)throw conflict('Project membership reference basis changed. Reopen the applied receipt.');
    const root=registry.projectContext.getRoot(row.root_id).root;const location=registry.projectContext.getActiveLocation(row.target_project_id);
    if(root.governance_status!=='adopted'||path.resolve(root.current_path)!==row.root_path||!location||location.root_id!==row.root_id||!inside(path.resolve(location.root_path,location.relative_path),row.target.path)||ledger.getProject(row.target_project_id).status!=='active')throw conflict('Project membership current location or Root changed.');
    ancestors(row.target.path);
    const mappings=Object.entries(row.manifest).filter(([,v])=>v.kind==='file').map(([p])=>({from_path:path.resolve(row.source.path,p),to_path:path.resolve(row.target.path,p)}));
    if(mappings.some(m=>!inside(row.source.path,m.from_path)||!inside(row.target.path,m.to_path)))throw conflict('Project membership manifest mapping escapes its tree.');
    return {kind:'project_membership',operation_id:id,revision:row.revision,digest:row.digest,root_id:row.root_id,root_path:row.root_path,from_path:row.source.path,to_path:row.target.path,affected_project_ids:[row.source_project_id,row.target_project_id],mappings};
  };
  const partition=createProjectMembershipPartition({stateDir,registry,ledger,db,writer,all,saves,graph,snapshot,rows,write,publicRow,finish,rootCheck,relative,requestHash,beforeDatabaseMove,afterDatabaseMove});
  return {prepare,referenceBasis,show:(id,{sourceProjectId})=>publicRow(read(id,sourceProjectId)),execute:(id,o)=>transition(id,o,'execute'),undo:(id,o)=>transition(id,o,'undo'),recover,dispose:()=>{if(ownsRegistry)registry.dispose();}};
}
