import MarkdownIt from './vendor/markdown-it/markdown-it.mjs';
import { readerHeadingId } from './resource-reader-service.js';

// Upstream owns Markdown syntax. Atlas owns the permitted destinations.
const md = new MarkdownIt({html:false, linkify:false, typographer:false, maxNesting:20});
const escape = md.utils.escapeHtml;
function materialHref(value) {
 return typeof value === 'string' && (/^#reader-heading-[\p{L}\p{N}_-]+$/u.test(value)
  || /^\/projects\/[^/\s\\]+\/resources\/read\?resource_id=[^\s\\#&]+(?:#reader-heading-[\p{L}\p{N}_-]+)?$/u.test(value));
}
function resolved(env, raw, syntax) {
 return env.links.find(item => item.syntax === syntax && item.status === 'resolved'
  && (item.raw === raw || syntax === 'relative_markdown' && md.normalizeLink(item.raw) === raw)
  && materialHref(item.href));
}
function external(raw) {
 if (!/^(https?:\/\/|mailto:)/u.test(raw) || /[\s\\\x00-\x1f]/u.test(raw)) return null;
 try { const url=new URL(raw); return ['https:','http:','mailto:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
md.inline.ruler.before('escape','atlas_escaped_material', (state,silent) => {
 // Preserve explicitly escaped material markup, including its visible backslash.
 const match=state.src.slice(state.pos).match(/^\\(?:\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\([^\n)]*\))/u);
 if(!match) return false;
 if(!silent) state.push('text','',0).content=match[0];
 state.pos+=match[0].length;return true;
});
md.inline.ruler.before('link','atlas_wiki', (state,silent) => {
 if(state.linkLevel || state.pos>0 && state.src[state.pos-1]==='!') return false;
 const match=state.src.slice(state.pos).match(/^\[\[([^\]\n]+)\]\]/u);if(!match) return false;
 if(!silent) { const token=state.push('atlas_wiki','',0);token.content=match[1]; }
 state.pos+=match[0].length;return true;
});
md.renderer.rules.atlas_wiki=(tokens,index,options,env) => {
 const raw=tokens[index].content;const item=resolved(env,raw,'wikilink');
 const label=raw.includes('|') ? raw.slice(raw.indexOf('|')+1).trim() : raw.split('#')[0];
 return item ? `<a class="reader-material-link" href="${escape(item.href)}">${escape(label)}</a>` : escape(`[[${raw}]]`);
};
md.renderer.rules.image=(tokens,index) => escape(`![${tokens[index].content}](${tokens[index].attrGet('src')})`);
md.renderer.rules.link_open=(tokens,index,options,env) => {
 const raw=tokens[index].attrGet('href'); const item=resolved(env,raw,'relative_markdown'); const href=item?.href ?? external(raw);
 if(href) return item ? `<a class="reader-material-link" href="${escape(href)}">` : `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">`;
 return '[';
};
md.renderer.rules.link_close=(tokens,index,options,env) => {
 let start=index-1;while(start>=0 && tokens[start].type!=='link_open') start--;
 const raw=tokens[start]?.attrGet('href') ?? '';
 return resolved(env,raw,'relative_markdown') || external(raw) ? '</a>' : `](${escape(raw)})`;
};
md.renderer.rules.heading_open=(tokens,index,options,env,self) => {
 const id=readerHeadingId(tokens[index+1]?.content ?? '');const count=env.headings.get(id) ?? 0;env.headings.set(id,count+1);
 tokens[index].attrSet('id',id+(count ? `-${count+1}` : ''));return self.renderToken(tokens,index,options);
};
export function renderMarkdown(text,links=[]) {
 return md.render(String(text),{links,headings:new Map()});
}
