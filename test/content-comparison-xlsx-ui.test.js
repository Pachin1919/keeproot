import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { compareContent } from '../src/content-inspection.js';
const python = process.env.ATLAS_TEST_PYTHON;
function book(file, sheets, fault = '') {
  const script = String.raw`
import sys,json,zipfile
from xml.sax.saxutils import escape
ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
rns='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
sheets=json.loads(sys.stdin.buffer.read().decode('utf-8'));fault=sys.argv[2]
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types/>')
 z.writestr('xl/workbook.xml','<workbook xmlns="'+ns+'" xmlns:r="'+rns+'"><sheets>'+''.join('<sheet name="'+escape(s['name'],{'"':'&quot;'})+'" sheetId="'+str(i)+'" state="'+s.get('visibility','visible')+'" r:id="r'+str(i)+'"/>' for i,s in enumerate(sheets,1))+'</sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join('<Relationship Id="r'+str(i)+'" Type="'+rns+'/worksheet" Target="'+('https://example.invalid/x' if fault=='external' else 'worksheets/s'+str(i)+'.xml')+'"'+(' TargetMode="External"' if fault=='external' else '')+'/>' for i in range(1,len(sheets)+1))+'</Relationships>')
 for i,s in enumerate(sheets,1):
  rows=[]
  for n,row in enumerate(s['rows'],1):
   cells=[]
   for c,value in enumerate(row):
    col='';v=c+1
    while v:v,rem=divmod(v-1,26);col=chr(65+rem)+col
    body='<is><t>'+escape(str(value))+'</t></is>'
    if fault=='formula' and n==2 and c==0:body='<f>1+1</f><v>2</v>'
    cells.append('<c r="'+col+str(n)+'" t="'+('e' if fault=='error' and n==2 and c==0 else 'inlineStr')+'">'+body+'</c>')
   if fault=='duplicate_cell' and n==2:cells.append(cells[0])
   rows.append('<row r="'+str(n)+'">'+''.join(cells)+'</row>')
  if fault=='duplicate_row':rows.append(rows[-1])
  xml='<worksheet xmlns="'+ns+'"><sheetData>'+''.join(rows)+'</sheetData>'+('<mergeCells><mergeCell ref="A1:B1"/></mergeCells>' if fault=='merged' else '')+'</worksheet>'
  z.writestr('xl/worksheets/s'+str(i)+'.xml',xml)
  if fault=='duplicate_zip':z.writestr('xl/worksheets/s'+str(i)+'.xml',xml)
`;
  const done = spawnSync(python, ['-c', script, file, fault], { input: JSON.stringify(sheets), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(done.status, 0, done.stderr);
}

test('Project XLSX POST shows selected sheets and computed counts; sources remain unchanged', async t => {
  fs.mkdirSync(path.resolve('test/.tmp'),{recursive:true});
  const root=fs.mkdtempSync(path.resolve('test/.tmp/comparison-xlsx-ui-'));
  const stateDir=path.join(root,'state');const workspace=path.join(root,'workspace');const projectPath=path.join(workspace,'项目');fs.mkdirSync(projectPath,{recursive:true});
  const leftPath=path.join(projectPath,'旧.xlsx');const rightPath=path.join(projectPath,'新.xlsx');
  book(leftPath,[{name:'旧统计',rows:[['线路','期间','人数','日期'],['A','09','10','2020-09-01'],['B','09','20','2020-09-02'],['A','10','30','2020-10-01'],['撤项','09','5','2020-09-03']]}]);
  const rightName='新<统计>';
  book(rightPath,[{name:rightName,visibility:'hidden',rows:[['日期','人数','期间','线路'],['2020-09-01','10','09','A'],['2020-09-02','25','09','B'],['2020-10-01','40','10','A'],['2020-10-02','<script>alert(1)</script>','10','C']]}]);
  const before=fs.readFileSync(leftPath);const after=fs.readFileSync(rightPath);
  const registry=new Registry({stateDir});const adopted=registry.adoptRoot({rootPath:workspace,rootType:'project_workspace',contentPolicy:'structure_only'});
  const project=registry.create({name:'项目',currentPath:'项目'});registry.attachRoot(project.project_id,{rootId:adopted.root_id,relativePath:'项目',reason:'XLSX comparison fixture.'});
  const server=await startAtlasUiServer({stateDir,registry,projectRoot:path.resolve('.'),installationRoot:path.resolve('.')});
  t.after(async()=>{await server.close();registry.dispose();fs.rmSync(root,{recursive:true,force:true});});
  const url=new URL(`projects/${project.project_id}/compare`,server.workspace_url);const choose=await(await fetch(url)).text();
  assert.match(choose,/旧.xlsx/u);assert.match(choose,/name="left_sheet" maxlength="31"/u);assert.match(choose,/name="right_sheet" maxlength="31"/u);
  const csrf=choose.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];assert.ok(csrf);
  const run=values=>fetch(`${url.href}/run`,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...values})});
  const fields={left:'旧.xlsx',right:'新.xlsx',left_sheet:'旧统计',right_sheet:rightName,key_column:'线路',period_column:'期间',event_date_column:'日期'};
  const started=await run(fields);assert.equal(started.status,303,(await started.clone().text()).slice(-1000));
  const page=await(await fetch(new URL(started.headers.get('location'),server.workspace_url))).text();
  const host=compareContent({stateDir,projectRoot:path.resolve('.'),leftPath,rightPath,details:true,leftSheet:'旧统计',rightSheet:rightName,keyColumn:'线路',periodColumn:'期间',eventDateColumn:'日期'});
  assert.deepEqual(['added','removed','changed','unchanged'].map(k=>host.details.summary[k]),[1,1,2,1]);
  for(const [label,count] of [['Added on the right',1],['Only on the left',1],['Text or row differs',2],['Unchanged',1]])assert.match(page,new RegExp(`${label}</dt>\\s*<dd[^>]*>${count}</dd>`,'u'));
  assert.match(page,/旧统计 \(visible\)/u);assert.match(page,/新&lt;统计&gt; \(hidden\)/u);assert.match(page,/2020-10-02/u);
  assert.doesNotMatch(page, /<dt>Left lines<\/dt>|supported local text formats only/u);
  assert.ok(page.includes(host.sources.left.modified_at));assert.match(page,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);assert.doesNotMatch(page,/<script>alert\(1\)<\/script>/u);
  assert.deepEqual(fs.readFileSync(leftPath),before);assert.deepEqual(fs.readFileSync(rightPath),after);
  assert.equal((await run({...fields,right:'../outside.xlsx'})).status,400);
  assert.equal((await run({...fields,left_sheet:''})).status,400);
});
