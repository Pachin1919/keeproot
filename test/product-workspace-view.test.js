import assert from 'node:assert/strict';
import test from 'node:test';
import { renderNav } from '../src/ui/components.js';
import { renderProjectHomeView } from '../src/ui/views/project-home-view.js';
import { renderDataWorkView } from '../src/ui/views/data-work-view.js';

test('Project navigation keeps the selected file and links to the same Project operations', () => {
  const selected='/projects/PRJ-example/resources?folder=资料&resource_id=RES-existing';
  const html=renderNav('Resources',{interactive:true,resourcesHref:selected,locale:'zh-CN'});
  assert.match(html,/aria-label="当前项目"/u);
  assert.match(html,/href="\/projects\/PRJ-example\/resources\?folder=资料&amp;resource_id=RES-existing"[^>]*aria-current="page"/u);
  for(const suffix of ['boards','rounds','rules']) assert.ok(html.includes(`href="/projects/PRJ-example/${suffix}"`));
  assert.ok(html.includes('href="/projects/PRJ-example"'));
  assert.equal((html.match(/data-resources-nav/gu)??[]).length,1);
  assert.doesNotMatch(renderNav('Projects',{interactive:true,resourcesHref:'https://other.invalid/projects/PRJ-else/resources'}),/class="project-navigation"/u);
});

test('Saved Table Work retains the Project navigation and exact Result return target', () => {
  const project={id:'PRJ-example',name:'材料与分析'};
  const target='/projects/PRJ-example/resources?path=成果%2F汇总.csv&resource_id=RES-result';
  const html=renderDataWorkView({mode:'saved',project,back_href:'/work/DWT-current',session:{session_id:'DWT-current',sources:[]},record:{
    project,sources:[],output_status:'verified',result_path:'成果/汇总.csv',result_summary:{rows:3,columns:2},resources_href:target,
  }},{locale:'zh-CN'});
  assert.match(html,/aria-label="当前项目"/u);
  assert.ok(html.includes('href="'+target.replaceAll('&','&amp;')+'"'));
  for(const suffix of ['boards','rounds','rules']) assert.ok(html.includes(`href="/projects/PRJ-example/${suffix}"`));
  assert.ok(html.includes('href="/work/DWT-current"'));
});

test('Project overview exposes current work and results before optional forms and keeps POST fields', () => {
  const base='/projects/PRJ-example';
  const model={base,project:{id:'PRJ-example',name:'材料与分析'},continue_item:{title:'正在整理的表格',href:'/work/DWT-current',revision:7},
    recent_results:[{id:'SAV-result',title:'已保存报告',href:base+'/resources?resource_id=RES-result',status:'verified'}],
    handoff_work_sessions:[{session_id:'DWT-current',revision:7,intent:'整理资料'}],changes:{state:'not_checked'}};
  const html=renderProjectHomeView(model,{locale:'zh-CN',csrfToken:'same-csrf'});
  assert.ok(html.indexOf('href="/work/DWT-current"')<html.indexOf('action="'+base+'/capture-source/prepare"'));
  assert.ok(html.indexOf('resource_id=RES-result')<html.indexOf('action="'+base+'/rename/preview"'));
  for(const action of ['/capture-source/prepare','/capture-source/export/inspect','/handoffs','/rename/preview','/home/check']) {
    assert.ok(html.includes(`method="post" action="${base}${action}"`));
  }
  for(const field of ['csrf','url','folder','name','input_path','goal','work_id','request_key','new_name']) assert.ok(html.includes(`name="${field}"`));
  assert.match(html,/name="csrf" value="same-csrf"/u);
  assert.doesNotMatch(html,/<details class="project-disclosure" id="project-management" open/u);
  const error=renderProjectHomeView({...model,rename_error:'名字冲突 <当前>'},{locale:'zh-CN',csrfToken:'same-csrf'});
  assert.match(error,/<details class="project-disclosure" id="project-management" open/u);
  assert.match(error,/名字冲突 &lt;当前&gt;/u);
  assert.ok(html.includes(`${base}/move/new`)&&html.includes(`${base}/membership`));
});
