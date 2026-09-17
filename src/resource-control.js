import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './snapshots.js';
import { Ledger } from './ledger.js';
import { contentFilePath } from './content-inspection.js';

const now = () => new Date().toISOString();
function evidence(filePath) { const stat=fs.lstatSync(filePath); if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('Resource must be a regular non-linked file.'); return { path:path.resolve(filePath), sha256:sha256File(filePath), bytes:stat.size, modified_at:stat.mtime.toISOString() }; }
export class ResourceControl {
  constructor({ stateDir, ledger=null }) { this.ledger=ledger ?? new Ledger(stateDir); this.owned=!ledger; this.disposed=false; }
  identify({ filePath, project=null }) {
    const repo=this.ledger.resources; const at=now(); const facts=evidence(filePath);
    return this.ledger.transaction(() => {
      const prior=repo.byPath(facts.path);
      const resource=prior ?? repo.create({kind:'file',displayName:path.basename(facts.path),at});
      repo.ensureLocation({resourceId:resource.id,projectId:project?.id ?? null,path:facts.path,displayName:path.basename(facts.path),evidence:facts,at});
      return { ...repo.describe(resource.id), resource_id:resource.id, evidence:facts };
    });
  }
  projectResources(projectId, { refresh=false } = {}) { const scopedLocations=this.ledger.resources.locationsForProject(projectId); const scopedRelationships=this.ledger.resources.relationshipResourcesForProject(projectId); const ids=[...new Set([...scopedLocations.map(item=>item.resource_id),...scopedRelationships.map(item=>item.id)])]; if(refresh){ const checked=[]; for(const location of this.ledger.resources.activeLocationsForResources(ids)){try{contentFilePath(location.path);checked.push({location,evidence:evidence(location.path)});}catch(error){if(error.code==='ATLAS_CONTENT_INPUT_MISSING')checked.push({location,missing:true});else throw error;}}this.ledger.transaction(()=>{for(const item of checked){if(item.missing)this.ledger.resources.markLocationMissing(item.location.id,now());else this.ledger.resources.refreshLocation(item.location.id,item.evidence);this.ledger.resources.refreshResourceStatus(item.location.resource_id,now());}}); return this.projectResources(projectId); } return ids.map(resourceId=>{const detail=this.ledger.resources.describe(resourceId);const projectLocation=detail.locations.find(item=>item.project_id===projectId);const relationship=scopedRelationships.find(item=>item.id===resourceId&&item.type==='stored_in')??scopedRelationships.find(item=>item.id===resourceId);const location=projectLocation??detail.locations.find(item=>item.status==='active')??detail.locations.at(-1)??null;const stored=Boolean(projectLocation)||relationship?.type==='stored_in';return {resource_id:resourceId,resource:detail.resource,locations:detail.locations,relationships:detail.relationships,relationship_to_project:stored?'stored_in':'used_by',relationship_label:stored?'Stored in':'Used by',last_known_location:location,path:location?.path??null,content_hash:location?.content_hash??null,bytes:location?.bytes??null,modified_at:location?.modified_at??null,status:location?.status??detail.resource.status,resource_status:detail.resource.status};}); }
  describe(resourceId) { const value=this.ledger.resources.describe(resourceId); if(!value) throw new Error('Resource is unavailable.'); return {...value,actions:this.ledger.resources.listActions(resourceId)}; }
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
  forgetRelationship(relationshipId,{caller}) { caller=this.#caller(caller); const relationship=this.ledger.resources.relationshipById(relationshipId); if(!relationship||relationship.status!=='active') throw new Error('Relationship is unavailable.'); return this.ledger.transaction(()=>{this.ledger.resources.updateRelationshipStatus(relationshipId,'forgotten');return this.ledger.resources.recordAction({resourceId:relationship.source_resource_id,type:'forget_relationship',details:{relationship_id:relationshipId,caller},at:now()});}); }
  removeReference(relationshipId,{caller}) { caller=this.#caller(caller); const relationship=this.ledger.resources.relationshipById(relationshipId); if(!relationship||relationship.status!=='active'||relationship.type!=='used_by') throw new Error('Only an active Used by relationship can be removed.'); return this.ledger.transaction(()=>{this.ledger.resources.updateRelationshipStatus(relationshipId,'removed');return this.ledger.resources.recordAction({resourceId:relationship.source_resource_id,type:'remove_reference',details:{relationship_id:relationshipId,caller},at:now()});}); }
  relink({resourceId,filePath,caller}) { caller=this.#caller(caller); const checkedPath=contentFilePath(filePath); const facts=evidence(checkedPath); const before=this.describe(resourceId); if(before.resource.status!=='missing'||before.locations.some(item=>item.status==='active')) throw new Error('Relink requires a missing Resource without an active location.'); if(this.ledger.resources.byPath(facts.path)) throw new Error('An active Resource already owns this path.'); const at=now(); return this.ledger.transaction(()=>{const current=this.ledger.resources.describe(resourceId);if(!current||current.resource.status!=='missing'||current.locations.some(item=>item.status==='active'))throw new Error('Relink requires a missing Resource without an active location.');const oldLocation=this.ledger.resources.latestMissingLocation(resourceId);if(!oldLocation)throw new Error('Relink requires a missing Resource location.');if(this.ledger.resources.byPath(facts.path))throw new Error('An active Resource already owns this path.');const newLocation=this.ledger.resources.ensureLocation({resourceId,projectId:oldLocation.project_id??null,path:facts.path,displayName:path.basename(facts.path),evidence:facts,at});this.ledger.resources.activateResource(resourceId,at);const action=this.ledger.resources.recordAction({resourceId,type:'relink',details:{old_location:oldLocation,new_location:newLocation,caller},at});return {resource_id:resourceId,evidence:facts,location:newLocation,action};}); }
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
    if(source?.resource_id && project?.id) relationships.push(repo.upsertRelationship({sourceResourceId:source.resource_id,targetKind:'project',targetId:project.id,type:'used_by',submitter,evidence:facts,at}));
    return { resource_id:resource.id, relationships:repo.listRelationships(resource.id).concat(relationships.filter(r=>r.source_resource_id!==resource.id)) }; });
  }
  dispose(){ if(this.disposed)return; this.disposed=true; if(this.owned)this.ledger.close(); }
}
export function createResourceControl(options){return new ResourceControl(options);}
