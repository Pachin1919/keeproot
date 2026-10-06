import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256File } from './snapshots.js';
import { Ledger } from './ledger.js';
import { contentFilePath } from './content-inspection.js';
import { Registry } from './registry.js';
import { projectDirectory, projectPath } from './ui/project-files.js';
import { assertRecoveryWritable } from './storage/recovery-write-guard.js';

const now = () => new Date().toISOString();
function evidence(filePath) { const stat=fs.lstatSync(filePath); if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('Resource must be a regular non-linked file.'); return { path:path.resolve(filePath), sha256:sha256File(filePath), bytes:stat.size, modified_at:stat.mtime.toISOString() }; }
function stable(value) { if(Array.isArray(value))return value.map(stable); if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])); return value; }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function stateConflict(message) { const error=new Error(message); error.code='ATLAS_STATE_CONFLICT'; return error; }
function baselineFact(location) { return location ? {sha256:location.content_hash,bytes:location.bytes,modified_at:location.modified_at,observed_at:location.valid_from??null} : null; }
function externalChange(location,current,checkedAt) {
  if(!location||location.status==='missing') return {status:'missing',baseline:baselineFact(location),current:null,checked_at:checkedAt??null};
  if(!current) return {status:'not_checked',baseline:baselineFact(location),current:null,checked_at:null};
  return {status:location.content_hash===current.sha256?'unchanged':'changed',baseline:baselineFact(location),current:{sha256:current.sha256,bytes:current.bytes,modified_at:current.modified_at,observed_at:checkedAt},checked_at:checkedAt};
}
export class ResourceControl {
  constructor({ stateDir, ledger=null, registry=null }) { this.stateDir=path.resolve(stateDir??ledger?.stateDir??registry?.stateDir); this.ledger=ledger ?? registry?.ledger ?? new Ledger(this.stateDir); this.owned=!ledger&&!registry; this.registry=registry; this.ownsRegistry=false; this.disposed=false; }
  #registry() { if(!this.registry){this.registry=new Registry({stateDir:this.stateDir});this.ownsRegistry=true;} return this.registry; }
  identify({ filePath, project=null }) {
    const repo=this.ledger.resources; const at=now(); const facts=evidence(filePath);
    return this.ledger.transaction(() => {
      const prior=repo.byPath(facts.path);
      const resource=prior ?? repo.create({kind:'file',displayName:path.basename(facts.path),at});
      let location=prior ? repo.describe(resource.id).locations.find((item)=>item.status==='active'&&path.resolve(item.path)===facts.path) : null;
      if(location){if(project?.id&&!location.project_id)location=repo.assignLocationProject(location.id,project.id,path.basename(facts.path));}
      else location=repo.ensureLocation({resourceId:resource.id,projectId:project?.id ?? null,path:facts.path,displayName:path.basename(facts.path),evidence:facts,at});
      return { ...repo.describe(resource.id), resource_id:resource.id, evidence:facts, external_change:externalChange(location,facts,at) };
    });
  }
  observe({filePath,project=null}) {
    const facts=evidence(filePath); const repo=this.ledger.resources; const prior=repo.byPath(facts.path);
    if(!prior) { const created=this.identify({filePath,project}); const location=created.locations.find(item=>item.status==='active'&&path.resolve(item.path)===facts.path); return {...created,evidence:facts,external_change:externalChange(location,facts,now())}; }
    let detail=repo.describe(prior.id); let location=detail.locations.find(item=>item.status==='active'&&path.resolve(item.path)===facts.path);
    if(project?.id&&location&&!location.project_id) { repo.assignLocationProject(location.id,project.id,path.basename(facts.path)); detail=repo.describe(prior.id); location=detail.locations.find(item=>item.id===location.id); }
    return {...detail,resource_id:prior.id,evidence:facts,external_change:externalChange(location,facts,now())};
  }
  projectResources(projectId, { refresh=false } = {}) {
    return this.#projectResources(projectId, { refresh });
  }
  #projectResources(projectId, { refresh=false } = {}, resourceId=null) {
    const repo=this.ledger.resources;
    const scopedLocations=repo.locationsForProject(projectId).filter(item=>resourceId===null||item.resource_id===resourceId);
    const scopedRelationships=repo.relationshipResourcesForProject(projectId).filter(item=>resourceId===null||item.id===resourceId);
    const currentLocations=scopedLocations.filter(item=>['active','missing'].includes(item.status));
    const currentRelationships=scopedRelationships.filter(item=>item.type!=='stored_in'||currentLocations.some(location=>location.resource_id===item.id));
    const ids=[...new Set([...currentLocations.map(item=>item.resource_id),...currentRelationships.map(item=>item.id)])];
    const checks=new Map();
    if(refresh){
      const checked=[];
      for(const location of scopedLocations.filter(item=>item.status==='active')){
        try{contentFilePath(location.path);checked.push({location,evidence:evidence(location.path),checkedAt:now()});}
        catch(error){if(error.code==='ATLAS_CONTENT_INPUT_MISSING')checked.push({location,missing:true});else throw error;}
      }
      this.ledger.transaction(()=>{for(const item of checked){if(item.missing){repo.markLocationMissing(item.location.id,now());repo.refreshResourceStatus(item.location.resource_id,now());}else checks.set(item.location.id,item);}});
    }
    return ids.map(resourceId=>{
      const detail=repo.describe(resourceId);
      const projectLocation=detail.locations.find(item=>item.project_id===projectId&&item.status==='active')
        ??detail.locations.find(item=>item.project_id===projectId&&item.status==='missing');
      const relationship=currentRelationships.find(item=>item.id===resourceId&&item.type==='stored_in')??currentRelationships.find(item=>item.id===resourceId);
      const location=projectLocation??detail.locations.find(item=>item.status==='active')??detail.locations.at(-1)??null;
      const stored=Boolean(projectLocation)||relationship?.type==='stored_in';
      const archive=repo.missingArchiveState(resourceId,projectId);
      const check=location?checks.get(location.id):null;
      return {resource_id:resourceId,resource:detail.resource,locations:detail.locations,relationships:detail.relationships,relationship_to_project:stored?'stored_in':'used_by',relationship_label:stored?'Stored in':'Used by',last_known_location:location,path:location?.path??null,content_hash:location?.content_hash??null,bytes:location?.bytes??null,modified_at:location?.modified_at??null,status:location?.status??detail.resource.status,resource_status:detail.resource.status,external_change:externalChange(location,check?.evidence??null,check?.checkedAt??null),missing_record_archived:archive.archived,missing_archive_batch_id:archive.batch_id};
    });
  }
  projectResource(projectId, resourceId, { refresh=false } = {}) { const current=this.#projectResources(projectId,{refresh},resourceId).find(item=>item.resource_id===resourceId); if(!current) throw new Error('Resource is unavailable in this Project.'); return {...current,desktop_href:`/projects/${encodeURIComponent(projectId)}/resources?resource_id=${encodeURIComponent(resourceId)}`}; }
  describe(resourceId) { const value=this.ledger.resources.describe(resourceId); if(!value) throw new Error('Resource is unavailable.'); return {...value,actions:this.ledger.resources.listActions(resourceId)}; }
  acceptCurrentVersion({projectId,resourceId,expectedCurrentVersion,caller}) {
    caller=this.#caller(caller); const fact=this.projectResource(projectId,resourceId); const location=fact.locations.find(item=>item.project_id===projectId&&item.status==='active')??fact.locations.find(item=>item.status==='active');
    if(!location) throw new Error('Current Resource version is unavailable.'); const current=evidence(contentFilePath(location.path));
    if(!expectedCurrentVersion||current.sha256!==expectedCurrentVersion) { const error=new Error('The Resource changed again before its current version was accepted.'); error.code='ATLAS_STATE_CONFLICT'; throw error; }
    this.ledger.transaction(()=>{this.ledger.resources.refreshLocation(location.id,current);this.ledger.resources.recordAction({resourceId,type:'accept_current_version',details:{project_id:projectId,baseline_sha256:location.content_hash,current_sha256:current.sha256,caller},at:now()});});
    return this.projectResource(projectId,resourceId,{refresh:true});
  }
  relationships(resourceId) { return this.describe(resourceId).relationships; }
  relationshipsMatch(resourceId, snapshot = []) {
    if (!resourceId) return true;
    const sourceIds = new Set([resourceId, ...snapshot.map((item) => item.source_resource_id).filter(Boolean)]);
    for (const sourceId of sourceIds) {
      const current = this.ledger.resources.listRelationships(sourceId);
      const expectedRows = snapshot.filter((item) => item.source_resource_id === sourceId);
      if (current.length !== expectedRows.length) return false;
      const expected = new Map(expectedRows.map((item) => [item.id, item]));
      if (!current.every((value) => {
        const item = expected.get(value.id);
        return item && value.source_resource_id === item.source_resource_id && value.type === item.type
          && value.target_kind === item.target_kind && value.target_id === item.target_id && value.status === item.status;
      })) return false;
    }
    return true;
  }
  preflightSaveUndo({saveId,resourceId,target,project,verification}) { const repo=this.ledger.resources; const linked=repo.saveLink(saveId); const location=repo.activeLocationAt(resourceId,target.path,project?.id??null); if(!linked||linked.resource_id!==resourceId||repo.byId(resourceId)?.status!=='active'||!location||location.content_hash!==verification?.sha256) throw new Error('Saved Resource facts changed after this Save. Undo was not applied.'); return location; }
  preflightSaveRedo({saveId,resourceId,target,verification,channel}) { const repo=this.ledger.resources; const linked=repo.saveLink(saveId); const location=repo.missingLocationAt(resourceId,target.path); const targetActive=repo.activeLocationAt(resourceId,target.path); const outputState=channel==='import'|| (repo.byId(resourceId)?.status==='missing'&&repo.activeLocationCount(resourceId)===0); if(!linked||linked.resource_id!==resourceId||!outputState||targetActive||!location||location.content_hash!==verification?.sha256) throw new Error('Saved Resource facts changed after this Save. Redo was not applied.'); return location; }
  markSaveUndone({ resourceId, target, saveId, caller, transitionId }) { const repo=this.ledger.resources; return this.ledger.transaction(()=>{const prior=repo.actionForSave(resourceId,'save_undo',saveId,transitionId); if(prior)return prior; const detail=this.describe(resourceId); const location=detail.locations.find((item)=>item.status==='active'&&path.resolve(item.path)===path.resolve(target.path)); if(!location) throw new Error('Saved Resource location is unavailable for Undo.'); repo.markLocationMissing(location.id,now());repo.refreshResourceStatus(resourceId,now());return repo.recordAction({resourceId,type:'save_undo',details:{save_id:saveId,transition_id:transitionId,target_path:target.path,caller},at:now()});}); }
  markSaveRedone({ resourceId, target, project, saveId, caller, transitionId }) { const repo=this.ledger.resources; const facts=evidence(contentFilePath(target.path)); return this.ledger.transaction(()=>{const prior=repo.actionForSave(resourceId,'save_redo',saveId,transitionId); if(prior)return prior;const location=repo.ensureLocation({resourceId,projectId:project?.id??null,path:facts.path,displayName:path.basename(facts.path),evidence:facts,at:now()});repo.activateResource(resourceId,now());const action=repo.recordAction({resourceId,type:'save_redo',details:{save_id:saveId,transition_id:transitionId,target_path:target.path,caller},at:now()});return {location,action};}); }
  #caller(caller) { if(!caller?.tool||!caller?.client_run_id) throw new Error('Resource action requires caller tool and client run id.'); return caller; }
  keepRecord(resourceId,{caller}) { caller=this.#caller(caller); const value=this.describe(resourceId); if(value.resource.status!=='missing') throw new Error('Keep record requires a missing Resource.'); return this.ledger.transaction(()=>this.ledger.resources.recordAction({resourceId,type:'keep_record',details:{caller},at:now()})); }
  archiveMissingRecords({projectId,resourceIds=null,caller}) {
    caller=this.#caller(caller);
    if(!this.ledger.resources.projectExists(projectId)) throw new Error('The selected Project is not available.');
    const requested=Array.isArray(resourceIds)?new Set(resourceIds.filter(Boolean)):null;
    const facts=this.projectResources(projectId,{refresh:true});
    const available=new Set(facts.map((item)=>item.resource_id));
    if(requested&&[...requested].some((id)=>!available.has(id))) throw new Error('A requested Resource is unavailable in this Project.');
    const candidates=facts.filter((item)=>(!requested||requested.has(item.resource_id))&&(item.resource?.status==='missing'||item.status==='missing'||item.last_known_location?.status==='missing')&&!item.missing_record_archived);
    const batchId=`RAB-${crypto.randomUUID()}`;
    const actions=this.ledger.transaction(()=>candidates.map((item)=>this.ledger.resources.recordAction({resourceId:item.resource_id,type:'archive_missing',details:{project_id:projectId,batch_id:batchId,caller},at:now()})));
    return {project_id:projectId,batch_id:actions.length?batchId:null,archived:actions.map((item)=>item.resource_id),skipped:(requested?[...requested]:facts.map((item)=>item.resource_id)).filter((id)=>!actions.some((item)=>item.resource_id===id))};
  }
  restoreMissingRecords({projectId,resourceIds=null,batchId=null,caller}) {
    caller=this.#caller(caller);
    if(!this.ledger.resources.projectExists(projectId)) throw new Error('The selected Project is not available.');
    const requested=Array.isArray(resourceIds)?new Set(resourceIds.filter(Boolean)):null;
    const facts=this.projectResources(projectId);
    const available=new Set(facts.map((item)=>item.resource_id));
    if(requested&&[...requested].some((id)=>!available.has(id))) throw new Error('A requested Resource is unavailable in this Project.');
    const candidates=facts.filter((item)=>(!requested||requested.has(item.resource_id))&&item.missing_record_archived&&(!batchId||item.missing_archive_batch_id===batchId));
    const actions=this.ledger.transaction(()=>candidates.map((item)=>this.ledger.resources.recordAction({resourceId:item.resource_id,type:'restore_missing',details:{project_id:projectId,batch_id:item.missing_archive_batch_id??batchId??null,caller},at:now()})));
    return {project_id:projectId,restored:actions.map((item)=>item.resource_id),skipped:(requested?[...requested]:facts.map((item)=>item.resource_id)).filter((id)=>!actions.some((item)=>item.resource_id===id))};
  }
  forgetRelationship(relationshipId,{caller}) { caller=this.#caller(caller); const relationship=this.ledger.resources.relationshipById(relationshipId); if(!relationship||relationship.status!=='active') throw new Error('Relationship is unavailable.'); return this.ledger.transaction(()=>{this.ledger.resources.updateRelationshipStatus(relationshipId,'forgotten');return this.ledger.resources.recordAction({resourceId:relationship.source_resource_id,type:'forget_relationship',details:{relationship_id:relationshipId,caller},at:now()});}); }
  removeReference(relationshipId,{caller}) { caller=this.#caller(caller); const relationship=this.ledger.resources.relationshipById(relationshipId); if(!relationship||relationship.status!=='active'||relationship.type!=='used_by') throw new Error('Only an active Used by relationship can be removed.'); return this.ledger.transaction(()=>{this.ledger.resources.updateRelationshipStatus(relationshipId,'removed');return this.ledger.resources.recordAction({resourceId:relationship.source_resource_id,type:'remove_reference',details:{relationship_id:relationshipId,caller},at:now()});}); }
  #linkedRequest(operation,candidate,decisionChannel) {
    if(!['add','remove'].includes(operation)) throw new Error('Resource link operation must be add or remove.');
    if(!candidate||typeof candidate.project_id!=='string'||typeof candidate.source_resource_id!=='string'||candidate.target?.kind!=='resource'||typeof candidate.target.id!=='string'||candidate.type!=='linked_to') throw new Error('Resource link requires a Project, source Resource, target Resource, and linked_to type.');
    if(candidate.source_resource_id===candidate.target.id) throw new Error('A Resource cannot link to itself.');
    if(!candidate.evidence||typeof candidate.evidence!=='object'||Array.isArray(candidate.evidence)||!Object.keys(candidate.evidence).length) throw new Error('Resource link requires explicit evidence.');
    if(operation==='remove'&&typeof candidate.relationship_id!=='string') throw new Error('Removing a Resource link requires relationship_id.');
    if(operation==='add'&&candidate.relationship_id!=null) throw new Error('Adding a Resource link must not specify relationship_id.');
    if(!['host_command','ui_confirm'].includes(decisionChannel)) throw new Error('Resource link decision channel is invalid.');
    return {operation,project_id:candidate.project_id,source_resource_id:candidate.source_resource_id,target_resource_id:candidate.target.id,type:'linked_to',evidence:stable(candidate.evidence),relationship_id:operation==='remove'?candidate.relationship_id:null,decision_channel:decisionChannel};
  }
  #linkRegistration(projectId,resourceId) {
    const repo=this.ledger.resources;
    const projectDetail=this.#registry().show(projectId);
    if(projectDetail.project?.status!=='active'||!projectDetail.location) throw new Error('Resource link requires an active Project with an attached local Root.');
    const projectRoot=path.resolve(projectDetail.location.root_path,...projectDetail.location.relative_path.split('/'));
    const resource=repo.byId(resourceId);
    if(!resource||resource.status!=='active') throw new Error('Resource link endpoint is unavailable.');
    const locations=repo.activeLocationsForResourceInProject(resourceId,projectId);
    if(!locations.length) throw new Error('Resource link endpoints must have an active local registered location in the same Project.');
    const versions=locations.map((location)=>{
      const absolute=path.resolve(location.path);
      const relative=path.relative(projectRoot,absolute);
      if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)) throw new Error('Resource link endpoint is outside the Project Root.');
      return {location_id:location.id,project_id:location.project_id,resource_id:location.resource_id,path:relative.replaceAll('\\','/'),status:location.status,resource_status:resource.status,content_hash:location.content_hash??null,bytes:location.bytes??null,modified_at:location.modified_at??null};
    });
    return {resource_id:resource.id,display_name:resource.display_name,status:resource.status,locations:versions};
  }
  #linkEndpoint(projectId,resourceId) {
    const projectDetail=this.#registry().show(projectId);
    const projectRoot=projectDirectory(projectDetail.location);
    const endpoint=this.#linkRegistration(projectId,resourceId);
    for(const location of endpoint.locations){
      const checked=projectPath(projectRoot,location.path);
      const stat=fs.lstatSync(checked);
      if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Resource link endpoint must be a regular non-linked local file.');
    }
    return endpoint;
  }
  #projectRelinkFacts(projectId, resourceId, filePath) {
    const projectDetail=this.#registry().show(projectId);
    if(projectDetail.project?.status!=='active'||!projectDetail.location) throw stateConflict('Relink requires an active Project with an attached local Root.');
    const projectRoot=projectDirectory(projectDetail.location);
    const detail=this.ledger.resources.describe(resourceId);
    if(!detail||detail.resource.status!=='missing'||detail.locations.some((item)=>item.status==='active')) throw stateConflict('Relink requires a missing Resource without an active location.');
    const oldLocation=this.ledger.resources.locations(resourceId).filter((item)=>item.project_id===projectId&&item.status==='missing').at(-1);
    if(!oldLocation) throw stateConflict('The missing Resource is unavailable in this Project.');
    const oldPath=path.resolve(oldLocation.path);
    const oldRelative=path.relative(projectRoot,oldPath);
    if(!oldRelative||oldRelative==='..'||oldRelative.startsWith(`..${path.sep}`)||path.isAbsolute(oldRelative)) throw stateConflict('The missing Resource location is outside this Project.');
    const oldParent=path.dirname(oldRelative);
    if(oldParent!=='.') {
      try { projectPath(projectRoot,oldParent); }
      catch(error) { if(error.code!=='ENOENT') throw error; }
    }
    try {
      fs.lstatSync(oldPath);
      throw stateConflict('The previous Resource location has reappeared; refresh before relinking.');
    } catch(error) { if(error.code!=='ENOENT') throw error; }
    const selectedPath=contentFilePath(filePath);
    const relative=path.relative(projectRoot,selectedPath);
    if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)) throw stateConflict('The selected file is outside this Project.');
    const candidatePath=projectPath(projectRoot,relative.replaceAll('\\','/'));
    if(path.resolve(candidatePath)!==selectedPath) throw stateConflict('The selected file path changed during validation.');
    const statBefore=fs.lstatSync(candidatePath);
    if(!statBefore.isFile()||statBefore.isSymbolicLink()) throw stateConflict('The selected file must be a regular non-linked file.');
    const candidateEvidence=evidence(candidatePath);
    const statAfter=fs.lstatSync(candidatePath);
    if(statBefore.dev!==statAfter.dev||statBefore.ino!==statAfter.ino||statBefore.size!==statAfter.size||statBefore.mtimeMs!==statAfter.mtimeMs) throw stateConflict('The selected file changed during relink validation.');
    if(candidateEvidence.sha256!==oldLocation.content_hash) throw stateConflict('The selected file does not match the missing Resource version.');
    const registrations=this.ledger.db.prepare('SELECT resource_id,project_id,status,content_hash FROM resource_locations WHERE path=? COLLATE NOCASE ORDER BY CASE status WHEN \'active\' THEN 0 ELSE 1 END, valid_from DESC, id DESC').all(candidatePath);
    if(registrations.length) {
      const currentOwner=registrations.find((item)=>item.status==='active'&&item.project_id===projectId);
      const registered=registrations.find((item)=>item.status==='active')??registrations[0];
      const error=stateConflict('The selected path is already registered to a Resource.');
      error.details={reason:'candidate_path_registered',project_id:projectId,missing_resource_id:resourceId,
        old_location:{id:oldLocation.id,path:oldPath,project_id:oldLocation.project_id,status:oldLocation.status,content_hash:oldLocation.content_hash},
        candidate_relative_path:relative.replaceAll('\\','/'),candidate_sha256:candidateEvidence.sha256,
        registration_status:registered.status,same_bytes:candidateEvidence.sha256===oldLocation.content_hash,
        ...(currentOwner?{candidate_resource_id:currentOwner.resource_id}:{}),
      };
      throw error;
    }
    const binding={project_id:projectId,project_root_id:projectDetail.location.root_id,project_relative_path:projectDetail.location.relative_path,project_updated_at:projectDetail.project.updated_at??null,resource_id:resourceId,resource_status:detail.resource.status,old_location:{id:oldLocation.id,path:oldPath,project_id:oldLocation.project_id,status:oldLocation.status,content_hash:oldLocation.content_hash,valid_from:oldLocation.valid_from,valid_to:oldLocation.valid_to},candidate_path:candidatePath,candidate_relative_path:relative.replaceAll('\\','/'),candidate_sha256:candidateEvidence.sha256,candidate_bytes:candidateEvidence.bytes,candidate_modified_at:candidateEvidence.modified_at};
    return {binding,projectRoot,oldLocation,candidateEvidence};
  }
  previewProjectRelink({projectId,resourceId,filePath}) {
    if(typeof projectId!=='string'||!projectId||typeof resourceId!=='string'||!resourceId) throw new Error('Project relink requires a Project and Resource.');
    const snapshot=this.#projectRelinkFacts(projectId,resourceId,filePath);
    return {status:'ready',project_id:projectId,resource_id:resourceId,old_location:snapshot.binding.old_location,old_sha256:snapshot.binding.old_location.content_hash,candidate_path:snapshot.binding.candidate_path,candidate_relative_path:snapshot.binding.candidate_relative_path,candidate_sha256:snapshot.binding.candidate_sha256,candidate_bytes:snapshot.binding.candidate_bytes,file_verification:'not_checked',writes_files:false,preview_digest:digest(snapshot.binding)};
  }
  #relinkActionByRequestKey(requestKey) {
    const row=this.ledger.db.prepare("SELECT * FROM resource_actions WHERE action_type='relink' AND json_extract(details_json,'$.request_key')=? ORDER BY rowid DESC LIMIT 1").get(requestKey);
    return row?{...row,details:JSON.parse(row.details_json)}:null;
  }
  confirmProjectRelink({projectId,resourceId,filePath,previewDigest,requestKey,caller}) {
    caller=this.#caller(caller);
    if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.trim().length>200) throw new Error('Project relink requires a bounded request key.');
    if(typeof previewDigest!=='string'||!/^[a-f0-9]{64}$/u.test(previewDigest)) throw new Error('Project relink requires a valid preview digest.');
    const key=requestKey.trim();
    const requestDigest=digest({project_id:projectId,resource_id:resourceId,file_path:path.resolve(filePath),preview_digest:previewDigest});
    const prior=this.#relinkActionByRequestKey(key);
    if(prior){if(prior.details.request_digest!==requestDigest) throw stateConflict('Project relink request key was already used for different facts.');return {resource_id:resourceId,evidence:prior.details.evidence,location:prior.details.new_location,action:prior};}
    return this.ledger.transaction(()=>{
      const currentPrior=this.#relinkActionByRequestKey(key);
      if(currentPrior){if(currentPrior.details.request_digest!==requestDigest) throw stateConflict('Project relink request key was already used for different facts.');return {resource_id:resourceId,evidence:currentPrior.details.evidence,location:currentPrior.details.new_location,action:currentPrior};}
      const fresh=this.#projectRelinkFacts(projectId,resourceId,filePath);
      if(digest(fresh.binding)!==previewDigest) throw stateConflict('Project relink preview is stale; preview the current facts again.');
      const at=now();
      const location=this.ledger.resources.ensureLocation({resourceId,projectId,path:fresh.candidateEvidence.path,displayName:path.basename(fresh.candidateEvidence.path),evidence:fresh.candidateEvidence,at});
      this.ledger.resources.activateResource(resourceId,at);
      const action=this.ledger.resources.recordAction({resourceId,type:'relink',details:{project_id:projectId,request_key:key,request_digest:requestDigest,preview_digest:previewDigest,old_location:fresh.oldLocation,new_location:location,evidence:fresh.candidateEvidence,caller},at});
      return {resource_id:resourceId,evidence:fresh.candidateEvidence,location,action};
    });
  }
  #linkedPreview(operation,candidate,decisionChannel) {
    const request=this.#linkedRequest(operation,candidate,decisionChannel);
    const source=this.#linkEndpoint(request.project_id,request.source_resource_id);
    const target=this.#linkEndpoint(request.project_id,request.target_resource_id);
    const repo=this.ledger.resources;
    const existing=repo.linkedRelationship(request.project_id,request.source_resource_id,request.target_resource_id);
    if(existing&&existing.evidence?.project_id!==request.project_id) throw stateConflict('This Resource pair already has a linked_to edge owned by another Project.');
    if(operation==='remove'&&(!existing||existing.id!==request.relationship_id)) throw new Error('The selected Resource link is unavailable.');
    const lastAction=existing?repo.latestLinkedAction(existing.id):null;
    const requestDigest=digest(request);
    const edgeState=existing?{id:existing.id,status:existing.status,last_action:lastAction?{id:lastAction.id,action_type:lastAction.action_type,created_at:lastAction.created_at}:null}:null;
    const previewToken=digest({request_digest:requestDigest,source,target,edge_state:edgeState});
    let effect;
    if(operation==='add') effect=!existing?'create':existing.status==='active'?'already_present':'reactivate';
    else effect=existing.status==='active'?'remove':'already_removed';
    return {request,request_digest:requestDigest,preview_token:previewToken,project_id:request.project_id,source,target,relationship:existing,effect,file_verification:'not_checked',writes_files:false};
  }
  previewLinkedResource({operation,candidate,decisionChannel='host_command'}) { return this.#linkedPreview(operation,candidate,decisionChannel); }
  #commitLinkedResource({operation,candidate,requestKey,caller,decisionChannel,preview}) {
    const request=this.#linkedRequest(operation,candidate,decisionChannel); const repo=this.ledger.resources;
    assertRecoveryWritable(this.ledger.db,{projectId:request.project_id,resourceId:request.source_resource_id});
    assertRecoveryWritable(this.ledger.db,{projectId:request.project_id,resourceId:request.target_resource_id});
    const current=repo.linkedRelationship(request.project_id,request.source_resource_id,request.target_resource_id);
    if(current&&current.evidence?.project_id!==request.project_id) throw stateConflict('This Resource pair already has a linked_to edge owned by another Project.');
    const at=now(); const linkEvidence={...request.evidence,project_id:request.project_id}; let relationship=current; let actionType='resource_link_noop'; const effect=preview.effect;
    if(operation==='add'&&!current){relationship=repo.createLinkedRelationship({sourceResourceId:request.source_resource_id,targetResourceId:request.target_resource_id,submitter:{decision_channel:decisionChannel,caller},evidence:linkEvidence,at});actionType='link_resource';}
    else if(operation==='add'&&current.status==='removed'){relationship=repo.transitionLinkedRelationship({relationshipId:current.id,expectedStatus:'removed',status:'active',evidence:linkEvidence,submitter:{decision_channel:decisionChannel,caller},at});actionType='link_resource';}
    else if(operation==='remove'&&current.status==='active'){relationship=repo.transitionLinkedRelationship({relationshipId:current.id,expectedStatus:'active',status:'removed',evidence:linkEvidence,submitter:{decision_channel:decisionChannel,caller},at});actionType='remove_resource_link';}
    const actionId=`RACT-${crypto.randomUUID()}`; const requestDigest=digest(request);
    const receipt={relationship,relationship_id:relationship.id,project_id:request.project_id,operation,effect,file_verification:'not_checked',writes_files:false,request_key:requestKey,request_digest:requestDigest,preview_token:preview.preview_token,decision_channel:decisionChannel,caller,action:{id:actionId,action_type:actionType,created_at:at}};
    repo.recordAction({id:actionId,resourceId:request.source_resource_id,type:actionType,details:{request_key:requestKey,request_digest:requestDigest,operation,relationship_id:relationship.id,project_id:request.project_id,decision_channel:decisionChannel,caller,source:preview.source,target:preview.target,from_status:current?.status??null,to_status:relationship.status,effect,receipt},at}); return receipt;
  }
  submitLinkedResource({operation,candidate,previewToken,requestKey,caller,decisionChannel='host_command'}) {
    caller=this.#caller(caller);
    if(typeof requestKey!=='string'||!requestKey.trim()) throw new Error('Resource link submission requires requestKey.');
    const request=this.#linkedRequest(operation,candidate,decisionChannel);
    const requestDigest=digest(request);
    const repo=this.ledger.resources;
    return this.ledger.transaction(()=>{
      const prior=repo.actionByRequestKey(requestKey.trim());
      if(prior){if(prior.details.request_digest!==requestDigest)throw stateConflict('Resource link request key was already used for different facts.');return prior.details.receipt;}
      const preview=this.#linkedPreview(operation,candidate,decisionChannel);
      if(typeof previewToken!=='string'||preview.preview_token!==previewToken) throw stateConflict('Resource link preview is stale; preview the current endpoints and edge again.');
      return this.#commitLinkedResource({operation,candidate,requestKey:requestKey.trim(),caller,decisionChannel,preview});
    });
  }
  #suggestionBinding(candidate,{verifyHostHashes=true,decisionChannel='host_command'}={}) {
    const preview=this.#linkedPreview('add',candidate,decisionChannel);
    const project=this.#registry().show(candidate.project_id); const projectRoot=projectDirectory(project.location);
    const current=(endpoint)=>endpoint.locations.map((item)=>{const fact=evidence(projectPath(projectRoot,item.path));return {resource_id:item.resource_id,path:item.path,location_id:item.location_id,sha256:fact.sha256};});
    const source=current(preview.source); const target=current(preview.target);
    if(verifyHostHashes&&(source.some((item)=>item.sha256!==candidate.source_sha256)||target.some((item)=>item.sha256!==candidate.target_sha256))) throw stateConflict('Host Resource link suggestion hashes do not match current endpoint files.');
    const lastAction=preview.relationship?this.ledger.resources.latestLinkedAction(preview.relationship.id):null;
    const binding={project_id:candidate.project_id,root_id:project.location.root_id,root_path:project.location.root_path,project_path:project.location.relative_path,source,target,edge:preview.relationship?{id:preview.relationship.id,status:preview.relationship.status,last_action:lastAction?.id??null}:null};
    return {binding,binding_digest:digest(binding),preview};
  }
  suggestLinkedResource({candidate,requestKey,caller}) {
    caller=this.#caller(caller);
    if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.trim().length>200) throw new Error('Resource link suggestion requires a bounded request key.');
    if(!candidate||candidate.type!=='linked_to'||candidate.target?.kind!=='resource'||!/^([a-f0-9]{64})$/u.test(candidate.source_sha256??'')||!/^([a-f0-9]{64})$/u.test(candidate.target_sha256??'')) throw new Error('Resource link suggestion requires linked_to endpoints and their SHA-256 values.');
    const request={...candidate,evidence:stable(candidate.evidence)}; const key=requestKey.trim(); const requestHash=digest(request); const repo=this.ledger.resources;
    const href=(id)=>`/projects/${encodeURIComponent(candidate.project_id)}/resources/link-suggestions/${encodeURIComponent(id)}`;
    const prior=repo.linkCandidateByRequest(candidate.project_id,key);
    if(prior){if(prior.request_hash!==requestHash)throw stateConflict('Resource link suggestion request key was already used for different facts.');return {...prior,candidate_id:prior.id,review_href:href(prior.id)};}
    const {binding,binding_digest}=this.#suggestionBinding(request);
    assertRecoveryWritable(this.ledger.db,{projectId:candidate.project_id,resourceId:candidate.source_resource_id}); assertRecoveryWritable(this.ledger.db,{projectId:candidate.project_id,resourceId:candidate.target.id});
    return this.ledger.transaction(()=>{
      const current=repo.linkCandidateByRequest(candidate.project_id,key);
      if(current){if(current.request_hash!==requestHash)throw stateConflict('Resource link suggestion request key was already used for different facts.');return {...current,candidate_id:current.id,review_href:href(current.id)};}
      const saved=repo.createLinkCandidate({id:`RLCAND-${crypto.randomUUID()}`,project_id:candidate.project_id,source_resource_id:candidate.source_resource_id,target_resource_id:candidate.target.id,request_key:key,request_hash:requestHash,proposal:request,binding,binding_digest,policy:{decision:'review_required',reason:'No relationship is created before user review.'},created_at:now()});
      return {...saved,candidate_id:saved.id,review_href:href(saved.id)};
    });
  }
  linkedResourceSuggestion(projectId,candidateId) {
    const row=this.ledger.resources.linkCandidateById(projectId,candidateId); if(!row) throw new Error('Resource link suggestion is unavailable in this Project.');
    let validity=row.status==='accepted'?'decided':'current';
    if(row.status==='pending'||row.status==='rejected') try { if(this.#suggestionBinding(row.proposal,{verifyHostHashes:false}).binding_digest!==row.binding_digest) validity='stale'; } catch { validity='stale'; }
    return {...row,candidate_id:row.id,validity,review_href:`/projects/${encodeURIComponent(projectId)}/resources/link-suggestions/${encodeURIComponent(candidateId)}`};
  }
  listLinkedResourceSuggestions(projectId) {
    if(!this.ledger.resources.projectExists(projectId)) throw new Error('The selected Project is not available.');
    return this.ledger.resources.listLinkCandidates(projectId).map((row)=>this.linkedResourceSuggestion(projectId,row.id));
  }
  decideLinkedResourceSuggestion({projectId,candidateId,decision,expectedRevision,bindingDigest,requestKey,caller}) {
    if(!['accept','reject'].includes(decision)) throw new Error('Resource link suggestion decision must be accept or reject.');
    caller=this.#caller(caller); if(caller.decision_channel!=='ui_confirm') throw new Error('Resource link suggestions require a Project UI decision.');
    const repo=this.ledger.resources; const at=now();
    return this.ledger.transaction(()=>{
      const row=repo.linkCandidateById(projectId,candidateId); if(!row) throw new Error('Resource link suggestion is unavailable in this Project.');
      if(row.status!=='pending') {
        const sameDecision=row.decision?.label===decision;
        const sameKey=(row.decision?.request_key??null)===(requestKey??null);
        const sameReview=row.revision===Number(expectedRevision)+1&&row.binding_digest===bindingDigest;
        if(!sameDecision||!sameKey||!sameReview) throw stateConflict('Resource link suggestion was already decided differently; read its current decision.');
        return {...row,validity:this.linkedResourceSuggestion(projectId,candidateId).validity};
      }
      if(row.revision!==Number(expectedRevision)||row.binding_digest!==bindingDigest) throw stateConflict('Resource link suggestion revision or binding changed; review the current suggestion.');
      let current=null; let stale=false;
      try { current=this.#suggestionBinding(row.proposal,{verifyHostHashes:false,decisionChannel:'ui_confirm'}); stale=current.binding_digest!==row.binding_digest; }
      catch(error) { if(decision==='accept') throw stateConflict('Resource link suggestion is stale; it can only be rejected or replaced.'); stale=true; }
      if(stale&&decision==='accept') throw stateConflict('Resource link suggestion is stale; it can only be rejected or replaced.');
      assertRecoveryWritable(this.ledger.db,{projectId,resourceId:row.source_resource_id}); assertRecoveryWritable(this.ledger.db,{projectId,resourceId:row.target_resource_id});
      let receipt=null;
      if(decision==='accept') {
        const linkReceipt=this.#commitLinkedResource({operation:'add',candidate:row.proposal,requestKey:requestKey??`suggestion-${candidateId}`,caller,decisionChannel:'ui_confirm',preview:current.preview});
        receipt={...linkReceipt,candidate_id:candidateId,status:'accepted',decided_at:at};
      } else {
        receipt={candidate_id:candidateId,project_id:projectId,status:'rejected',request_key:requestKey??null,decision:'reject',relationship:null,decided_at:at};
      }
      const policy={decision:decision==='accept'?'allow':'deny',reason:decision==='accept'?'User accepted the Resource link suggestion.':'User rejected the Resource link suggestion.'};
      const decided=repo.decideLinkCandidate({projectId,id:candidateId,expectedRevision:row.revision,status:decision==='accept'?'accepted':'rejected',decision:{label:decision,source:'project_ui',caller,request_key:requestKey??null},policy,receipt,at});
      return {...decided,candidate_id:decided.id,validity:stale?'stale':'current'};
    });
  }
  linkedResourceRelationships(projectId,resourceId) {
    if(!this.ledger.resources.locations(resourceId).some((location)=>location.project_id===projectId)) throw new Error('Resource is unavailable in this Project.');
    return this.ledger.resources.linkedRelationshipsForResource(projectId,resourceId).map((relationship)=>{
      const source=this.ledger.resources.byId(relationship.source_resource_id);
      const target=this.ledger.resources.byId(relationship.target_id);
      const lastAction=this.ledger.resources.latestLinkedAction(relationship.id);
      const sourceRegistration=this.ledger.resources.activeLocationsForResourceInProject(relationship.source_resource_id,projectId).length?this.#linkRegistration(projectId,relationship.source_resource_id):null;
      const targetRegistration=this.ledger.resources.activeLocationsForResourceInProject(relationship.target_id,projectId).length?this.#linkRegistration(projectId,relationship.target_id):null;
      const needsReview=!lastAction||!sourceRegistration||!targetRegistration||digest(sourceRegistration)!==digest(lastAction.details.source)||digest(targetRegistration)!==digest(lastAction.details.target);
      return {...relationship,direction:relationship.source_resource_id===resourceId?'outgoing':'incoming',source_name:source?.display_name??null,target_name:target?.display_name??null,source_registered:Boolean(sourceRegistration),target_registered:Boolean(targetRegistration),needs_review:needsReview,last_action:lastAction,file_verification:'not_checked'};
    });
  }
  relationshipFocus(projectId,resourceId,{depth=1,status='active'}={}) {
    if(!Number.isInteger(depth)||![1,2].includes(depth)) throw new Error('Relationship focus depth must be 1 or 2.');
    if(!['active','removed','all'].includes(status)) throw new Error('Relationship focus status must be active, removed, or all.');
    const root=this.#linkRegistration(projectId,resourceId);
    const nodeMap=new Map([[resourceId,{resource_id:resourceId,name:root.display_name,relative_path:root.locations[0]?.path??null,hop:0}]]);
    const edgeMap=new Map();
    const queue=[{id:resourceId,hop:0}];
    let truncated=false;
    for(let cursor=0;cursor<queue.length;cursor+=1){
      const current=queue[cursor];
      if(current.hop>=depth) continue;
      const links=this.linkedResourceRelationships(projectId,current.id).filter((edge)=>
        ['active','removed'].includes(edge.status)&&(status==='all'||edge.status===status)&&edge.source_registered&&edge.target_registered,
      ).sort((left,right)=>left.id.localeCompare(right.id));
      for(const edge of links){
        const adjacentId=edge.source_resource_id===current.id?edge.target_id:edge.source_resource_id;
        if(!nodeMap.has(adjacentId)){
          if(nodeMap.size>=50){truncated=true;break;}
          const registration=this.#linkRegistration(projectId,adjacentId);
          nodeMap.set(adjacentId,{resource_id:adjacentId,name:registration.display_name,relative_path:registration.locations[0]?.path??null,hop:current.hop+1});
        }
        if(!edgeMap.has(edge.id)){
          if(edgeMap.size>=100){truncated=true;break;}
          edgeMap.set(edge.id,{...edge,direction:edge.source_resource_id===current.id?'outgoing':'incoming',adjacent_resource_id:adjacentId,hop:current.hop+1});
        }
        if(current.hop+1<depth&&!queue.some((item)=>item.id===adjacentId)) queue.push({id:adjacentId,hop:current.hop+1});
      }
      if(truncated) break;
    }
    const nodes=[...nodeMap.values()].sort((left,right)=>left.hop-right.hop||left.resource_id.localeCompare(right.resource_id));
    nodes.unshift(nodes.splice(nodes.findIndex((item)=>item.resource_id===resourceId),1)[0]);
    const edges=[...edgeMap.values()].sort((left,right)=>left.hop-right.hop||left.id.localeCompare(right.id));
    return {project_id:projectId,root_resource_id:resourceId,depth,status,nodes,edges,truncated,file_verification:'not_checked'};
  }
  relink({resourceId,filePath,caller}) { caller=this.#caller(caller); const before=this.ledger.resources.describe(resourceId); if(!before) throw new Error('Resource is unavailable.'); if(before.resource.status!=='missing'||before.locations.some((item)=>item.status==='active')) throw new Error('Relink requires a missing Resource without an active location.'); const old=this.ledger.resources.latestMissingLocation(resourceId); if(!old?.project_id) throw new Error('Relink requires a missing Resource attached to a Project.'); const preview=this.previewProjectRelink({projectId:old.project_id,resourceId,filePath}); return this.confirmProjectRelink({projectId:old.project_id,resourceId,filePath,previewDigest:preview.preview_digest,requestKey:`legacy-${crypto.randomUUID()}`,caller}); }
  submitRelationships({ candidates, caller }) {
    if(!caller?.tool || !caller?.client_run_id) throw new Error('Relationship submission requires caller tool and client run id.');
    if(!Array.isArray(candidates) || !candidates.length) throw new Error('Relationship submission requires candidates.');
    const repo=this.ledger.resources; const validated=candidates.map((candidate,index)=>{
      if(!candidate || typeof candidate.source_resource_id!=='string' || !repo.describe(candidate.source_resource_id)) throw new Error(`Candidate ${index}: unknown source Resource.`);
      if(candidate.target?.kind!=='project' || typeof candidate.target.id!=='string' || !repo.projectExists(candidate.target.id)) throw new Error(`Candidate ${index}: unknown Project target.`);
      if(!['used_by','stored_in'].includes(candidate.type)) throw new Error(`Candidate ${index}: unsupported relationship type.`);
      if(!candidate.evidence || typeof candidate.evidence!=='object' || Array.isArray(candidate.evidence) || !Object.keys(candidate.evidence).length) throw new Error(`Candidate ${index}: evidence must be a non-empty object.`);
      if(candidate.type==='stored_in'&&!repo.hasActiveLocationInProject(candidate.source_resource_id,candidate.target.id)) throw new Error(`Candidate ${index}: stored_in requires an active location in the target Project.`);
      return candidate;
    });
    const at=now(); return this.ledger.transaction(()=>validated.map(candidate=>repo.upsertRelationship({sourceResourceId:candidate.source_resource_id,targetKind:'project',targetId:candidate.target.id,type:candidate.type,submitter:{caller},evidence:candidate.evidence,at})));
  }
  recordSave({ saveId, channel, project, target, source=null, caller={} }) {
    const repo=this.ledger.resources; const at=now(); const targetEvidence=evidence(target.path); return this.ledger.transaction(() => { const prior=repo.bySave(saveId);
    const resource=prior ?? (channel==='import' && source?.resource_id ? repo.byId(source.resource_id) : repo.create({kind:'file',displayName:path.basename(target.path),at}));
    if(!resource) throw new Error('Import source Resource is unavailable.');
    repo.ensureLocation({resourceId:resource.id,projectId:project?.id ?? null,path:targetEvidence.path,displayName:path.basename(targetEvidence.path),evidence:targetEvidence,at}); repo.linkSave({saveId,resourceId:resource.id,at});
    const submitter={channel,caller}; const facts={save_id:saveId,target:targetEvidence}; const relationships=[];
    if(project?.id) relationships.push(repo.upsertRelationship({sourceResourceId:resource.id,targetKind:'project',targetId:project.id,type:'stored_in',submitter,evidence:facts,at}));
    const sourceItems=Array.isArray(source?.sources)?source.sources:(source?[source]:[]);
    for(const item of sourceItems) if(item?.resource_id&&project?.id) relationships.push(repo.upsertRelationship({sourceResourceId:item.resource_id,targetKind:'project',targetId:project.id,type:'used_by',submitter,evidence:{...facts,source_key:item.source_key??null,recipe_version:source?.recipe?.version??null},at}));
    const relatedIds=[...new Set([resource.id,...sourceItems.map(item=>item?.resource_id).filter(Boolean)])];
    return { resource_id:resource.id, relationships:relatedIds.flatMap(id=>repo.listRelationships(id)) }; });
  }
  dispose(){ if(this.disposed)return; this.disposed=true; if(this.owned)this.ledger.close(); if(this.ownsRegistry)this.registry?.dispose(); }
}
export function createResourceControl(options){return new ResourceControl(options);}
