import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {Registry} from '../src/registry.js';
import {ResourceControl} from '../src/resource-control.js';
import {createResourceReaderService} from '../src/resource-reader-service.js';
import {renderResourceReaderView} from '../src/ui/views/resource-reader-view.js';
import {Intake} from '../src/intake.js';
import {startAtlasUiServer} from '../src/ui-server.js';
const python=process.env.ATLAS_TEST_PYTHON??'python';
function fixture(t, extension, bytes, deferred=false){
 const base=fs.mkdtempSync(path.resolve('test/.tmp/reader-table-')), directory=path.join(base,'workspace','表格');fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,`材料.${extension}`);fs.writeFileSync(file,bytes);
 const registry=new Registry({stateDir:path.join(base,'state')});const root=registry.adoptRoot({rootPath:path.dirname(directory),rootType:'project_workspace',contentPolicy:'bounded_content'});
 const project=registry.create({name:'表格',currentPath:'表格'});registry.attachRoot(project.project_id,{rootId:root.root_id,relativePath:'表格',reason:'table reading'});
 const control=new ResourceControl({stateDir:registry.stateDir,registry});const resource=control.identify({filePath:file,project:registry.show(project.project_id).project});
 const reader=createResourceReaderService({registry,resourceControl:control,pythonPath:python});
 const cleanup=()=>{control.dispose();registry.dispose();fs.rmSync(base,{recursive:true,force:true});};if(!deferred)t.after(cleanup);
 return {file,registry,control,resource,project,cleanup,read:options=>reader.read({projectId:project.project_id,resourceId:resource.resource_id,...options})};
}
test('CSV reading pages preserve quoted newlines, row order and exact bound source version',t=>{
 const bytes=Buffer.from('名称,备注\n甲,"多行\n说明"\n'+Array.from({length:75},(_,i)=>`条目${i},${i}`).join('\n'));
 const f=fixture(t,'csv',bytes);const first=f.read();assert.equal(first.kind,'table');assert.equal(first.table.rows.length,50);
 assert.deepEqual(first.table.rows[1],{number:2,cells:['甲','多行\n说明']});assert.equal(first.table.total_rows,77);
 const second=f.read({tableOffset:50,expectedSha256:first.sha256});assert.equal(second.table.rows.length,27);assert.equal(second.table.rows[0].number,51);assert.deepEqual(fs.readFileSync(f.file),bytes);
 fs.appendFileSync(f.file,'\n新行,2');assert.throws(()=>f.read({tableOffset:50,expectedSha256:first.sha256}),{code:'ATLAS_STATE_CONFLICT'});
});
test('Table HTTP pages bind version, retain return location and never launch external apps',async t=>{
 const f=fixture(t,'csv',Buffer.from(Array.from({length:80},(_,i)=>`${i},<script>文字</script>`).join('\n')),true);
 const intake=new Intake({stateDir:f.registry.stateDir});let opens=0;const previous=process.env.ATLAS_CONTENT_PYTHON;process.env.ATLAS_CONTENT_PYTHON=python;
 const server=await startAtlasUiServer({stateDir:f.registry.stateDir,registry:f.registry,resourceControl:f.control,intake,projectRoot:path.dirname(path.dirname(f.file)),openLocalFileFn:async()=>{opens++;}});
 t.after(async()=>{await server.close();intake.dispose();f.cleanup();if(previous===undefined)delete process.env.ATLAS_CONTENT_PYTHON;else process.env.ATLAS_CONTENT_PYTHON=previous;});
 const base=`/projects/${f.project.project_id}/resources/read`;const returnTo=`/projects/${f.project.project_id}/resources?mode=table&folder=notes`;
 const url=base+`?resource_id=${f.resource.resource_id}&return_to=${encodeURIComponent(returnTo)}`;
 const first=await fetch(new URL(url,server.workspace_url));assert.equal(first.status,200);const html=await first.text();
 assert.match(html,/&lt;script&gt;文字&lt;\/script&gt;/u);assert.ok(html.includes(returnTo.replaceAll('&','&amp;')));
 const next=html.match(/href="([^"]+offset=50[^"]+)"/u)?.[1];assert.ok(next);assert.match(next,/expected_sha256=/u);
 const second=await fetch(new URL(next.replaceAll('&amp;','&'),server.workspace_url));assert.equal(second.status,200);assert.match(await second.text(),/<th scope="row">51<\/th>/u);
 assert.equal((await fetch(new URL(url+'&offset=50',server.workspace_url))).status,409);
 fs.appendFileSync(f.file,'\nnew,1');assert.equal((await fetch(new URL(next.replaceAll('&amp;','&'),server.workspace_url))).status,409);assert.equal(opens,0);
});
function workbook({external=false,doctype=false}={}){
 const source=String.raw`import io,sys,json,zipfile
x=json.load(sys.stdin);b=io.BytesIO()
ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="'+ns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="第一表" sheetId="1" r:id="r1"/><sheet name="第二表" sheetId="2" r:id="r2"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"'+(' TargetMode="External"' if x['external'] else '')+'/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
 body='<worksheet xmlns="'+ns+'"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lt;script&gt;</t></is></c><c r="C1"><v>9</v></c></row><row r="2"><c r="A2"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'
 if x['doctype']: body='<!DOCTYPE worksheet [<!ENTITY x "bad">]>'+body
 z.writestr('xl/worksheets/sheet1.xml',body.encode('utf-16') if x['doctype'] else body)
 z.writestr('xl/worksheets/sheet2.xml','<worksheet xmlns="'+ns+'"><sheetData><row r="8"><c r="B8" t="inlineStr"><is><t>中文第二表</t></is></c></row></sheetData></worksheet>')
sys.stdout.buffer.write(b.getvalue())`;
 const result=spawnSync(python,['-c',source],{input:JSON.stringify({external,doctype}),windowsHide:true,timeout:30000});assert.equal(result.status,0,result.stderr.toString());return result.stdout;
}
test('XLSX reading switches exact worksheets, preserves coordinates and reports raw formula caches',t=>{
 const bytes=workbook(),f=fixture(t,'xlsx',bytes);const first=f.read();assert.deepEqual(first.table.sheets,['第一表','第二表']);assert.equal(first.table.sheet,'第一表');
 assert.deepEqual(first.table.rows[0],{number:1,cells:['<script>','','9']});assert.equal(first.table.rows[1].cells[0],'2');assert.ok(first.table.warnings.includes('formula_cache'));
 const second=f.read({tableSheet:'第二表',expectedSha256:first.sha256});assert.deepEqual(second.table.rows[0],{number:8,cells:['','中文第二表']});assert.deepEqual(fs.readFileSync(f.file),bytes);
 assert.throws(()=>f.read({tableSheet:'未知'}),{code:'ATLAS_STATE_CONFLICT'});assert.throws(()=>f.read({tableOffset:1}),{code:'ATLAS_STATE_CONFLICT'});
 const html=renderResourceReaderView({project:{id:'P',name:'表格'},reader:first,returnHref:'/projects/P/resources?folder=研究',resources:[]},{locale:'zh-CN'});
 assert.match(html,/&lt;script&gt;/u);assert.doesNotMatch(html,/<script>/u);assert.match(html,/expected_sha256=/u);assert.match(html,/第二表/u);assert.match(html,/不重新计算公式/u);
});
test('Table reader visibly bounds records, columns and cells; rejects external worksheets and UTF16 DTD',t=>{
 const f=fixture(t,'csv',Buffer.alloc(20*1024*1024+1,0x78));
 // This fixture is deliberately above the byte limit, and must be refused before Python.
 assert.throws(()=>f.read(),{code:'ATLAS_STATE_CONFLICT'});
 fs.writeFileSync(f.file,Array.from({length:10001},()=>Array.from({length:51},()=> 'x').join(',')).join('\n'));
 const limited=f.read();assert.equal(limited.table.total_rows,10000);assert.equal(limited.table.truncated,true);assert.equal(limited.table.columns.length,50);assert.ok(limited.table.warnings.includes('columns_clipped'));
 fs.writeFileSync(f.file,'长文字\n'+ '中'.repeat(600));const clipped=f.read();assert.equal(clipped.table.rows[1].cells[0].length,500);assert.ok(clipped.table.warnings.includes('cells_clipped'));
 const unsafe=fixture(t,'xlsx',workbook({external:true}));assert.throws(()=>unsafe.read(),{code:'ATLAS_STATE_CONFLICT'});
 fs.writeFileSync(unsafe.file,workbook({doctype:true}));assert.throws(()=>unsafe.read(),{code:'ATLAS_STATE_CONFLICT'});
});
