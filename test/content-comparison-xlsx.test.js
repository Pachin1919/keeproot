import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
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
function fixture(t) {
  fs.mkdirSync(path.resolve('test/.tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve('test/.tmp/comparison-xlsx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = (name, rows, fault = '', sheet = '统计', extra = []) => { const file = path.join(root, name); book(file, [{ name: sheet, rows }, ...extra], fault); return file; };
  const compare = (leftPath, rightPath, options = {}) => compareContent({ stateDir: path.join(root, 'state'), projectRoot: path.resolve('.'), leftPath, rightPath, details: true, leftSheet: '统计', rightSheet: '统计', keyColumn: '线路', periodColumn: '期间', eventDateColumn: '日期', ...options });
  return { root, make, compare };
}
const oldRows = [['线路','期间','人数','日期'],['A','09','10','2020-09-01'],['B','09','20','2020-09-02'],['A','10','30','2020-10-01'],['撤项','09','5','2020-09-03']];
const newRows = [['日期','人数','期间','线路'],['2020-09-01','10','09','A'],['2020-09-02','25','09','B'],['2020-10-01','40','10','A'],['2020-10-02','15','10','C']];
test('XLSX explicit sheets compare complete rows with reordered headers and Host same facts', t => {
  const f = fixture(t); const a = f.make('old.xlsx', oldRows); const b = f.make('new.xlsx', newRows);
  const before = fs.readFileSync(a); const result = f.compare(a,b);
  assert.equal(result.details.kind, 'table_rows');
  assert.deepEqual(['added','removed','changed','unchanged'].map(k => result.details.summary[k]), [1,1,2,1]);
  assert.deepEqual(result.details.selected_sheets.left, { name: '统计', visibility: 'visible' });
  assert.equal(result.details.time_sources.event_dates.right.end, '2020-10-02');
  assert.notEqual(result.details.time_sources.file_modified.left.slice(0,10), '2020-09-01');
  assert.equal(f.compare(a,b).cache_hit, true); assert.deepEqual(fs.readFileSync(a), before);
  const cli = spawnSync(process.execPath, ['bin/atlas.js','content','compare','--left',a,'--right',b,'--details','--left-sheet','统计','--right-sheet','统计','--key-column','线路','--period-column','期间','--event-date-column','日期','--json'], { encoding:'utf8', timeout:15000, env:{...process.env,ATLAS_STATE_DIR:path.join(f.root,'cli')} });
  assert.equal(cli.status,0,cli.stderr); assert.deepEqual(JSON.parse(cli.stdout).data.details.summary,result.details.summary);
});

test('selected sheets isolate cache, hidden sheets are explicit, numeric event dates are not inferred', t => {
  const f=fixture(t); const a=f.make('a.xlsx',oldRows,'','统计',[{name:'隐藏',visibility:'hidden',rows:newRows}]); const b=f.make('b.xlsx',newRows);
  const first=f.compare(a,b); const second=f.compare(a,b,{leftSheet:'隐藏'});
  assert.notEqual(first.relationship_id,second.relationship_id); assert.equal(second.cache_hit,false);
  assert.deepEqual(second.details.selected_sheets.left,{name:'隐藏',visibility:'hidden'});
  assert.equal(second.details.summary.unchanged,4); assert.equal(second.details.summary.changed,0);
  const rows=[['线路','期间','人数','日期'],['A','09','1','44197']]; const numeric=f.make('numeric.xlsx',rows);
  const d=f.compare(numeric,numeric).details; assert.equal(d.time_sources.event_dates.left.invalid_count,1); assert.equal(d.time_sources.event_dates.left.start,null);
  const later=new Date('2030-01-01T00:00:00Z');fs.utimesSync(a,later,later);
  const fresh=f.compare(a,b);assert.equal(fresh.sources.left.modified_at,later.toISOString());assert.notEqual(fresh.relationship_id,first.relationship_id);
});

test('XLSX refuses uncertain structure and keeps duplicate or empty keys uncertain', t => {
  const f=fixture(t);const good=f.make('good.xlsx',oldRows);
  for(const fault of ['formula','merged','external','duplicate_cell','duplicate_row','duplicate_zip','error']) {
    const bad=f.make(`${fault}.xlsx`,oldRows,fault);const before=fs.readFileSync(bad);
    assert.throws(()=>f.compare(bad,good),/unsupported|external|Duplicate|duplicate|error|formula/iu,fault);assert.deepEqual(fs.readFileSync(bad),before);
  }
  for(const [name,rows] of [['duplicate_header',[['线路','线路'],['A','B']]],['empty_header',[['线路',''],['A','B']]],['wide',[Array.from({length:51},(_,i)=>`H${i}`)]]]) {
    assert.throws(()=>f.compare(f.make(`${name}.xlsx`,rows),good),/header|column|50/iu);
  }
  assert.throws(()=>f.compare(good,good,{leftSheet:null}),/sheet/iu);
  assert.throws(()=>f.compare(good,good,{leftSheet:'missing'}),/sheet/iu);
  assert.throws(()=>f.compare(good,good,{leftSheet:'x'.repeat(32)}),/31/iu);
  assert.throws(()=>f.compare(good,good,{details:false}),/details/iu);
  const text=path.join(f.root,'a.txt');fs.writeFileSync(text,'a');assert.throws(()=>f.compare(text,text),/sheet/iu);
  const duplicate=f.make('duplicate.xlsx',[oldRows[0],oldRows[1],oldRows[1]]);const d=f.compare(duplicate,good).details;
  assert.equal(d.status,'uncertain');assert.equal(d.summary.left_duplicate_keys,1);assert.equal(d.summary.changed,null);
  const empty=f.make('empty.xlsx',[oldRows[0],['','09','10','2020-09-01'],['','','','']]);const e=f.compare(empty,good).details;
  assert.equal(e.summary.left_records,1);assert.equal(e.summary.left_empty_key_records,1);assert.equal(e.blank_physical_rows.left,1);assert.equal(e.status,'uncertain');
  const tooMany=f.make('too-many.xlsx',[oldRows[0],...Array.from({length:10001},()=>oldRows[1])]);assert.throws(()=>f.compare(tooMany,good),/10000/iu);
  const largeCell=f.make('large-cell.xlsx',[oldRows[0],['A','09','x'.repeat(1201),'2020-09-01']]);assert.throws(()=>f.compare(largeCell,good),/1200/iu);
  const huge=path.join(f.root,'huge.xlsx');fs.writeFileSync(huge,'');fs.truncateSync(huge,16*1024*1024+1);assert.throws(()=>f.compare(huge,good),/16 MiB/iu);
});

test('XLSX input changes after Python comparison are refused before cache publication', t=>{
  const f=fixture(t);const a=f.make('a.xlsx',oldRows);const b=f.make('b.xlsx',newRows);
  assert.throws(()=>f.compare(a,b,{runProcess:(command,args,options)=>{const result=spawnSync(command,args,options);fs.appendFileSync(a,'changed');return result;}}),/changed during/iu);
  assert.equal(fs.existsSync(path.join(f.root,'state','tmp','content-relationships')),false);
});
