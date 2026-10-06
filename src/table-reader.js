import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {locateContentPython} from './python-runtime.js';
export function readTableBytes(bytes,{sha256,format,sheet=null,offset=0,installationRoot,pythonPath,pythonSourceRoot=fileURLToPath(new URL('../python/src/',import.meta.url))}) {
  const fail=message=>Object.assign(new Error(message),{code:'ATLAS_STATE_CONFLICT'});
  if (!Number.isInteger(offset)||offset<0||offset>=10000||offset%50||sheet!==null&&(typeof sheet!=='string'||!sheet||sheet.length>128)) throw fail('Invalid table page or worksheet.');
  const executable=pythonPath??locateContentPython({installationRoot});
  if(!executable||!fs.existsSync(executable))throw Object.assign(new Error('Table reading requires the Atlas Python component.'),{code:'ATLAS_CAPABILITY_UNAVAILABLE'});
  const result=spawnSync(executable,['-m','atlas_content','table-read','--format',format,'--offset',String(offset),...(sheet!==null?['--sheet',sheet]:[])],{
    input:bytes,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:6*1024*1024,cwd:path.resolve(pythonSourceRoot,'..'),
    env:{...process.env,PYTHONPATH:pythonSourceRoot,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'},
  });
  if(result.error||result.status!==0)throw fail('Table could not be read within the supported format, worksheet and limits.');
  let table;try{table=JSON.parse(result.stdout);}catch{throw fail('Invalid table reader output.');}
  if(table.schema!=='atlas.table-reader.v1'||table.sha256!==sha256||table.format!==format||table.offset!==offset||!Number.isInteger(table.total_rows)||table.total_rows<0||table.total_rows>10000||typeof table.truncated!=='boolean'||!Array.isArray(table.columns)||table.columns.length>50||!Array.isArray(table.rows)||table.rows.length>50||!Array.isArray(table.sheets)||table.sheets.length>50||!Array.isArray(table.warnings))throw fail('Inconsistent table reader output.');
  if(table.columns.some(value=>typeof value!=='string'||!/^[A-Z]{1,2}$/u.test(value))||table.sheets.some(value=>typeof value!=='string'||!value||value.length>128)||table.warnings.some(value=>!['columns_clipped','cells_clipped','decode_warning','hidden_sheet','merged_cells','formula_cache','raw_values'].includes(value))||(format==='xlsx'?!table.sheets.includes(table.sheet)||sheet!==null&&table.sheet!==sheet:table.sheet!==null||table.sheets.length))throw fail('Invalid worksheet metadata.');
  let characters=0;
  for(const row of table.rows){if(!Number.isInteger(row.number)||row.number<1||row.number>1048576||!Array.isArray(row.cells)||row.cells.length>50||row.cells.some(cell=>typeof cell!=='string'||Array.from(cell).length>500))throw fail('Invalid table row output.');characters+=row.cells.reduce((sum,cell)=>sum+Array.from(cell).length,0);}
  if(characters>200000)throw fail('Table page exceeds text limit.');
  return table;
}
