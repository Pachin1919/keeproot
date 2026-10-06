import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { rewriteMarkdownLinks } from '../src/markdown-link-rewrite.js';
const root=path.resolve('test/.tmp/algorithm-root');
const old=path.join(root,'A','target.md');const next=path.join(root,'Moved','A','target.md');
const run=(text,extra={})=>rewriteMarkdownLinks({text,rootPath:root,documentPath:path.join(root,'B','doc.md'),mappings:[{from_path:old,to_path:next}],resolveTarget:p=>({resource_id:'RES-target',location_id:'LOC-target',path:p}),...extra});
test('path spans preserve alias, fragment, whitespace, extension, CRLF and several links per line',()=>{
  const r=run('[a](../A/target.md#head) [[ A/target#h|Alias ]] [b](../A/target)\r\n');
  assert.equal(r.text,'[a](../Moved/A/target.md#head) [[ Moved/A/target#h|Alias ]] [b](../Moved/A/target)\r\n');assert.equal(r.edits.length,3);assert.equal(r.edits[0].target_resource_id,'RES-target');
});
test('protected syntax, nested labels, images and external/complex destinations stay byte identical',()=>{
  const text='---\nx: [[A/target]]\n---\n```md\n[a](../A/target.md)\n```\n`[[A/target]]`\n    [[A/target]]\n<!-- [[A/target]] -->\n![a](../A/target.md) ![[A/target]]\n[outer [inner](../A/target.md)](../A/target.md)\n[x](https://example.test/a) [[target]]\n[t](../A/target.md "title") [q](../A/target.md?x) [p](../A/t%61rget.md)\n';
  const r=run(text);assert.equal(r.text,text);assert.equal(r.edits.length,0);assert.ok(r.skipped.some(s=>s.reason==='complex_nested_label'));assert.ok(r.skipped.every(s=>s.bounded_location.end-s.bounded_location.start<=256));
});
test('ambiguous syntax and raw HTML executable regions refuse the file',()=>{
  for(const text of ['```\n[[A/target]]','---\nx: 1','<!-- [[A/target]]','`[[A/target]]','<script>"[[A/target]]"</script>','<style>[[A/target]]</style>'])assert.throws(()=>run(text),{code:'ATLAS_STATE_CONFLICT'});
});
test('moving both ends is a no-op and moved document outgoing links use the old directory',()=>{
  const movedDoc=path.join(root,'Moved','A','doc.md');const oldDoc=path.join(root,'A','doc.md');
  const r=run('[same](./target.md) [out](../B/external.md)',{documentPath:movedDoc,oldDocumentPath:oldDoc});
  assert.equal(r.text,'[same](./target.md) [out](../../B/external.md)');assert.equal(r.edits.length,1);
  assert.equal(run('[same](target.md)',{documentPath:movedDoc,oldDocumentPath:oldDoc}).text,'[same](target.md)');
});
test('Windows mapping lookup accepts different link spelling case',()=>{
  const text='[x](../a/TARGET.md)';const r=run(text);if(process.platform==='win32')assert.equal(r.text,'[x](../Moved/A/target.md)');else assert.equal(r.text,text);
});
test('outside Root, unavailable target and edit budget are bounded',()=>{
  const r=run('[x](../../escape.md) [y](../A/target.md)',{resolveTarget:()=>{throw new Error('not registered');}});assert.equal(r.edits.length,0);assert.equal(r.skipped.length,2);
  assert.throws(()=>run('[x](../A/target.md)\n'.repeat(1001)),/1000 edits/);
});
