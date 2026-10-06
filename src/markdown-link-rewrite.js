// Adapted from Rowboat wiki-link-rewrite.ts, revision 2fdae425 (Apache-2.0).
// Path/anchor/alias and extension preservation are retained; scanning and writes
// are replaced by bounded selected-document edits. See third-party/rowboat-LICENSE.txt.
import path from 'node:path';
export const LINK_REPAIR_ALGORITHM = 'atlas.markdown-link-repair.v1';
const conflict=message=>Object.assign(new Error(message),{code:'ATLAS_STATE_CONFLICT'});
const portable=p=>p.replaceAll('\\','/');
const key=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
const contained=(root,p)=>{const r=path.relative(root,p);return !!r&&!r.startsWith(`..${path.sep}`)&&r!=='..'&&!path.isAbsolute(r);};

function protectedRegions(text) {
  if(/<\/?(?:script|style)(?:\s|>)/iu.test(text))throw conflict('Raw HTML script/style regions are unsupported for link repair.');
  const mask=new Array(text.length).fill(null); const mark=(a,b,reason)=>{for(let i=a;i<b;i++)mask[i]=reason;};
  const lines=[...text.matchAll(/[^\n]*(?:\n|$)/gu)].filter(m=>m[0]);
  let front=false; let fence=null;
  for(const [index,line] of lines.entries()) {
    const value=line[0].replace(/\r?\n$/u,''); const start=line.index; const end=start+line[0].length;
    if(index===0&&value==='---'){front=true;mark(start,end,'frontmatter');continue;}
    if(front){mark(start,end,'frontmatter');if(/^(---|\.\.\.)\s*$/u.test(value))front=false;continue;}
    const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(value);
    if(fence){mark(start,end,'code_fence');if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;continue;}
    if(marker){fence=marker[1];mark(start,end,'code_fence');continue;}
    if(/^( {4}|\t)/u.test(value))mark(start,end,'indented_code');
  }
  if(front||fence)throw conflict('Cannot reliably delimit Markdown frontmatter or code fence. Close it before link repair.');
  for(let offset=0;;){const start=text.indexOf('<!--',offset);if(start<0)break;if(mask[start]){offset=start+4;continue;}const end=text.indexOf('-->',start+4);if(end<0)throw conflict('Cannot reliably delimit Markdown HTML comment.');mark(start,end+3,'html_comment');offset=end+3;}
  for(let i=0;i<text.length;i++){
    if(text[i]!=='`'||mask[i])continue;let end=i;while(text[end]==='`')end++;const marker=text.slice(i,end);let close=text.indexOf(marker,end);
    while(close>=0&&(text[close-1]==='`'||text[close+marker.length]==='`'||mask[close]))close=text.indexOf(marker,close+marker.length);
    if(close<0)throw conflict('Cannot reliably delimit Markdown inline code. Close it before link repair.');mark(i,close+marker.length,'inline_code');i=close+marker.length-1;
  }
  // A nested label is one unsupported region, not a collection of simple
  // links. Mask its complete bracket span before matching inner syntax.
  const brackets=[];
  for(let i=0;i<text.length;i++){
    if(mask[i]||text[i-1]==='\\')continue;
    if(text.slice(i,i+2)==='[['){if(brackets.length)brackets[0].nested=true;const end=text.indexOf(']]',i+2);if(end<0)throw conflict('Cannot reliably delimit a wikilink.');i=end+1;continue;}
    if(text[i]==='['){if(brackets.length)brackets[0].nested=true;brackets.push({start:i,nested:false});}
    if(text[i]===']'&&brackets.length){const b=brackets.pop();if(!brackets.length&&b.nested)mark(b.start,i+1,'complex_nested_label');}
  }
  return mask;
}

// Offsets are JavaScript UTF-16 indices into the unchanged original text.
export function rewriteMarkdownLinks({text,rootPath,documentPath,oldDocumentPath=documentPath,mappings,resolveTarget,syntax=['relative_markdown','wikilink']}) {
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>256*1024||text.startsWith('\uFEFF'))throw conflict('Link repair requires bounded UTF-8 Markdown without BOM.');
  const mask=protectedRegions(text); const edits=[];const skipped=[];const targets=[];
  const skip=(start,end,reason)=>{if(skipped.length<1000)skipped.push({reason,bounded_location:{start,end:Math.min(end,start+256)}});};
  const map=new Map(mappings.map(m=>[key(m.from_path),path.resolve(m.to_path)]));
  const token=/\[\[([^\[\]]*)\]\]/gu;
  for(const match of text.matchAll(token)){
    process(match.index,match[0],true,match[1]);
  }
  const ordinary=/\[([^\[\]\r\n]*)\]\(([^()\r\n]*)\)/gu;
  for(const m of text.matchAll(ordinary))process(m.index,m[0],false,m[2]);
  for(const m of text.matchAll(/\[[^\[\]\r\n]*\]\([^\r\n]*/gu)){
    const tail=m[0].slice(m[0].indexOf('](')+2);const first=tail.indexOf(')');if(first<0||tail.slice(0,first).includes('('))skip(m.index,m.index+m[0].length,'complex_destination');
  }
  function process(start,full,wiki,inner){
    const end=start+full.length;const reason=mask.slice(start,end).find(Boolean);if(reason){skip(start,end,reason);return;}
    if(start>0&&(text[start-1]==='!'||text[start-1]==='\\')){skip(start,end,text[start-1]==='!'?'image_or_embed':'escaped_syntax');return;}
    if(full.includes('\\')){skip(start,end,'escaped_syntax');return;}
    if(!syntax.includes(wiki?'wikilink':'relative_markdown'))return;
    const pipe=wiki?inner.indexOf('|'):-1;const pathAndAnchor=pipe>=0?inner.slice(0,pipe):inner;const anchor=pathAndAnchor.indexOf('#');
    const part=anchor>=0?pathAndAnchor.slice(0,anchor):pathAndAnchor;const raw=part.trim();
    if(!raw||(wiki&&!raw.includes('/'))){skip(start,end,'bare_name_or_fragment');return;}
    if(/^[a-z][a-z0-9+.-]*:/iu.test(raw)||raw.startsWith('/')||raw.startsWith('\\')){skip(start,end,'external_or_absolute');return;}
    if(/[\\%?<>"'()[\]\r\n]/u.test(inner)||(!wiki&&/\s/u.test(raw))){skip(start,end,'complex_destination');return;}
    const hadExtension=/\.md$/iu.test(raw);if(path.extname(raw)&&!hadExtension){skip(start,end,'non_markdown_target');return;}
    const oldTarget=path.resolve(wiki?rootPath:path.dirname(oldDocumentPath),`${raw}${hadExtension?'':'.md'}`);
    if(!contained(rootPath,oldTarget)){skip(start,end,'outside_registered_root');return;}
    const newTarget=map.get(key(oldTarget))??oldTarget;
    let replacement=portable(path.relative(wiki?rootPath:path.dirname(documentPath),newTarget));
    if(!hadExtension)replacement=replacement.replace(/\.md$/iu,'');
    if(!wiki&&raw.startsWith('./')&&!replacement.startsWith('.'))replacement=`./${replacement}`;
    if(replacement===raw)return;
    let target;try{target=resolveTarget(newTarget);}catch(error){skip(start,end,`target_unavailable: ${String(error.message).slice(0,160)}`);return;}
    const offset=start+(wiki?2:full.indexOf('](')+2)+(part.match(/^\s*/u)?.[0].length??0);
    edits.push({start:offset,end:offset+raw.length,old_text:raw,new_text:replacement,old_target_path:oldTarget,new_target_path:newTarget,target_resource_id:target.resource_id,target_location_id:target.location_id});
    targets.push(target);if(edits.length>1000)throw conflict('Link repair exceeds 1000 edits. Select a smaller document.');
  }
  // Duplicate ordinary matches within wiki syntax cannot become ordinary links.
  edits.sort((a,b)=>a.start-b.start);for(let i=1;i<edits.length;i++)if(edits[i].start<edits[i-1].end)throw conflict('Cannot reliably delimit overlapping Markdown links.');
  let proposed=text;for(const e of [...edits].reverse())proposed=proposed.slice(0,e.start)+e.new_text+proposed.slice(e.end);
  return {text:proposed,edits,skipped,targets:[...new Map(targets.map(t=>[t.location_id,t])).values()]};
}
