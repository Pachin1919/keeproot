import assert from 'node:assert/strict';
import test from 'node:test';
import {renderDataWorkView} from '../src/ui/views/data-work-view.js';
function model(){return {mode:'sources',project:{id:'PRJ-flow',name:'资料分析'},csrf:'flow-csrf',back_href:'/projects/PRJ-flow/resources',session:{session_id:'DWT-flow',project_id:'PRJ-flow',revision:6,preview_revision:6,mapping_complete:true,intent:'整理所选材料',sources:[{name:'本期.csv',source_key:'SRC-1',resource_id:'RES-1',status:'ready',fingerprint:{sha256:'a'.repeat(64)},profile:{profile:{rows:3,columns:2,fields:[{name:'region'},{name:'amount'}]}}}],mapping:[{source_key:'SRC-1',column:'region',canonical:'region'},{source_key:'SRC-1',column:'amount',canonical:'amount'}],recipe:{version:2,combine:{operation:'concatenate'},steps:[{operation:'validate'}]},change_review:{status:'fresh',items:[]},freshness:{label:'fresh'},preview:{columns:['region','amount'],rows:[['North',30]],preview:{rows_shown:1,total_rows:3},result_summary:{rows:3,columns:2},validation:{input_rows:3,output_rows:3,null_cells:0,duplicate_rows:0}}}};}

test('fresh Table preview precedes optional configuration and ready sources, with original guarded forms',()=>{
 const html=renderDataWorkView(model(),{locale:'zh-CN'});
 assert.ok(html.indexOf('class="data-work-table"')<html.indexOf('class="recipe-form"'));
 assert.match(html,/<details class="project-disclosure table-work-editor">/u);
 assert.match(html,/<details class="project-disclosure table-work-inputs">/u);
 assert.match(html,/href="\/work\/DWT-flow\/save"/u);
 const forms=[...html.matchAll(/<form[^>]*action="\/work\/DWT-flow\/action"[^>]*>([\s\S]*?)<\/form>/gu)].map(m=>m[1]);
 assert.ok(forms.length>=3);for(const form of forms){assert.match(form,/name="csrf" value="flow-csrf"/u);assert.match(form,/name="base_revision" value="6"/u);}
});

test('unprepared source and outdated Preview cannot disappear into ready-source disclosure or expose Save',()=>{
 const input=model();input.session.preview_revision=5;input.session.sources[0].status='pending';
 input.session.sources[0].error_message='来源需要重新准备 <原因>';
 const html=renderDataWorkView(input,{locale:'zh-CN'});
 assert.doesNotMatch(html,/<details class="project-disclosure table-work-(inputs|editor)">/u);
 assert.match(html,/来源需要重新准备 &lt;原因&gt;/u);
 assert.match(html,/处理修订已变化/u);
 assert.doesNotMatch(html,/href="\/work\/DWT-flow\/save"/u);
});

test('verified Saved result opens its exact Resource and receipt hash; changed results offer no verified reader shortcut',()=>{
 const input={...model(),mode:'saved',record:{project:{id:'PRJ-flow',name:'资料分析'},sources:[],result_path:'成果/汇总.csv',resource_id:'RES-result',resources_href:'/projects/PRJ-flow/resources?resource_id=RES-result',output_status:'verified',verification:{sha256:'b'.repeat(64)},result_summary:{rows:3,columns:2},write:{undo_available:true},work_id:'SAV-result'}};
 let html=renderDataWorkView(input,{locale:'zh-CN'});
 const url=new URL(html.match(/href="([^"]*\/resources\/read\?[^"]+)"/u)[1].replaceAll('&amp;','&'),'http://atlas.local');
 assert.equal(url.pathname,'/projects/PRJ-flow/resources/read');assert.equal(url.searchParams.get('resource_id'),'RES-result');assert.equal(url.searchParams.get('expected_sha256'),'b'.repeat(64));assert.equal(url.searchParams.get('return_to'),input.record.resources_href);
 assert.match(html,/action="\/data-work\/undo"/u);assert.match(html,/name="work_id" value="SAV-result"/u);
 input.record.output_status='changed';html=renderDataWorkView(input,{locale:'zh-CN'});assert.doesNotMatch(html,/\/resources\/read\?/u);assert.ok(html.includes('<h1>成果已被修改</h1>'));
});
