import { escapeHtml } from './components.js';
export function toolboxErrorKey(error) {
 const text=String(error?.message ?? error ?? '');
 if (/module|paused|disabled/iu.test(text)) return 'capture_paused';
 if (/at least one|no.*selected/iu.test(text)) return 'missing';
 if (/nonnumeric|non.numeric|nonfinite|finite|numeric values/iu.test(text)) return 'data_error';
 if (/unit/iu.test(text)) return 'unit_error';
 if (/already exists|occupied/iu.test(text)) return 'occupied_error';
 if (/folder|directory|contain|boundary/iu.test(text)) return 'folder_error';
 if (/filename|file name|name.*plain|name.*path/iu.test(text)) return 'name_error';
 if (/export|authenticated|dynamic/iu.test(text)) return 'export_error';
 if (/URL|public.*address|private|HTTP/iu.test(text)) return 'url_error';
 if (/network|fetch|timeout|connect|ECONN/iu.test(text)) return 'network_error';
 if (/Resource|material|source.*unavailable|CSV|XLSX|Project/iu.test(text)) return 'source_error';
 return 'recipe_error';
}
export function boundedRecipeDraft(form) {
 return [...form].filter(([key])=>!['csrf','action','base_revision'].includes(key) && /^[a-z_]+$/u.test(key)).slice(0,100).map(([key,value])=>[key,String(value).slice(0,1024)]);
}
export function hydrateRecipeDraft(html, entries) {
 if (!entries?.length) return html;
 const values=new Map();for(const [key,value] of entries){if(!values.has(key))values.set(key,[]);values.get(key).push(value);}
 return html.replace(/<form\b[^>]*class="recipe-form"[^>]*>[\s\S]*?<\/form>/u,form=>form.replace(/<select\b[^>]*name="([^"]+)"[^>]*>[\s\S]*?<\/select>/gu,(select,key)=>{
  if(!values.has(key))return select;const value=escapeHtml(values.get(key)[0]);let found=false;
  let next=select.replace(/<option\b([^>]*)>/gu,(option,attrs)=>{const selected=attrs.match(/value="([^"]*)"/u)?.[1]===value;found ||= selected;return '<option'+attrs.replace(/\sselected(?:="[^"]*")?/gu,'')+(selected?' selected':'')+'>';});
  if(!found)next=next.replace('</select>','<option value="'+value+'" selected>'+value+'</option></select>');return next;
 }).replace(/<input\b[^>]*name="([^"]+)"[^>]*>/gu,(input,key)=>{
  if(!values.has(key))return /type="checkbox"/u.test(input)?input.replace(/\schecked/gu,''):input;
  if(/type="checkbox"/u.test(input)){const value=input.match(/value="([^"]*)"/u)?.[1];return input.replace(/\schecked/gu,'').replace(/>$/u,values.get(key).map(escapeHtml).includes(value)?' checked>':'>');}
  return input.replace(/value="[^"]*"/u,'value="'+escapeHtml(values.get(key)[0])+'"');
 }));
}
