import assert from 'node:assert/strict';import crypto from 'node:crypto';import fs from 'node:fs';import path from 'node:path';import test from 'node:test';
import {buildProjectResourcesModel} from '../src/ui/read-model/project-resources-model.js';
test('Resource list indexes facts and reads a shared Source once per page, then notices a later change',t=>{
 const root=fs.mkdtempSync(path.resolve('test/.tmp/resource-page-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'来源.csv');const content='名称,值\n甲,1\n';fs.writeFileSync(source,content);const sha=crypto.createHash('sha256').update(content).digest('hex');
 let factPaths=0;const resourceFacts=[];const savedWork=[];
 for(let i=0;i<40;i++){const file=path.join(root,`结果${i}.csv`);fs.writeFileSync(file,'值\n1\n');const id=`RES-${i}`;resourceFacts.push({resource_id:id,get path(){factPaths++;return file;}});savedWork.push({resource_id:id,work_id:`WORK-${i}`,result_path:file,created_at:'2026-10-04T01:00:00Z',version_policy:'follow_latest',sources:[{path:source,fingerprint:{sha256:sha}}]});}
 const args={project:{id:'PRJ-cache',name:'研究'},root,base:'/projects/PRJ-cache',recentWork:[],savedWork,resourceFacts};
 const originalOpen=fs.openSync;let sourceReads=0;fs.openSync=function(file,...args){if(typeof file==='string'&&path.resolve(file)===source)sourceReads++;return originalOpen.call(this,file,...args);};
 try {
  const first=buildProjectResourcesModel(args);assert.equal(first.created_work.length,40);assert.ok(first.created_work.every(x=>x.saved_work.source_status==='Follow latest Source unchanged since this result was created'));
  assert.equal(sourceReads,1,'shared source should be fingerprinted once within this page');assert.ok(factPaths<=resourceFacts.length*3,`fact path lookup should be bounded; observed ${factPaths}`);
  fs.appendFileSync(source,'乙,2\n');sourceReads=0;const second=buildProjectResourcesModel(args);assert.equal(sourceReads,1);assert.ok(second.created_work.every(x=>x.saved_work.source_status==='Follow latest Source changed since this result was created'));
 }finally{fs.openSync=originalOpen;}
});
