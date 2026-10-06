import assert from 'node:assert/strict';
import test from 'node:test';
import { renderProjectMembershipView } from '../src/ui/views/project-membership-view.js';
const model = {project:{id:'P-source',name:'Source'},projects:[{id:'P-source',name:'Source',status:'active'},{id:'P-target',name:'Target',status:'active'}]};
const operation = {operation_id:'MEM-fixture',operation:'split',status:'prepared',revision:1,digest:'digest-one',source_project_id:'P-source',target_project_id:'P-new',source:{path:'C:/fixture/source/research',relative_path:'source/research'},target:{path:'C:/fixture/new',relative_path:'new'},new_project:{id:'P-new',name:'New'},summary:{files:3,resources:2,works:1,saves:1,boards:1},blockers:[],can_execute:true};
const render = (extra={},locale='en') => renderProjectMembershipView({...model,...extra},{csrfToken:'csrf-fixture',locale});
test('Membership chooser has explicit physical split and merge forms, root-relative versus target-relative help',()=>{
 const html=render();assert.match(html,/name="operation" value="split"/u);assert.match(html,/name="operation" value="merge"/u);
 assert.match(html,/name="source_relative_path"/u);assert.match(html,/name="new_project_name"/u);assert.match(html,/name="target_project_id"/u);
 assert.match(html,/registered workspace root/u);assert.match(html,/Relative to the destination Project/u);
 assert.match(html,/name="csrf" value="csrf-fixture"/u);assert.doesNotMatch(html,/<option value="P-source"/u);
 assert.match(render({},'zh-CN'),/拆分或合并项目/u);
});
test('Membership preview binds confirmation to version and never offers confirmation over dependency blockers',()=>{
 const html=render({operation});assert.match(html,/MEM-fixture\/execute/u);assert.match(html,/name="expected_revision" value="1"/u);assert.match(html,/name="expected_digest" value="digest-one"/u);
 assert.match(html,/remain unchanged until you confirm/u);assert.match(html,/<details class="technical-details"><summary>/u);
 const blocked=render({operation:{...operation,blockers:['Cross-boundary <work>'],can_execute:false}});
 assert.doesNotMatch(blocked,/MEM-fixture\/execute/u);assert.match(blocked,/Cross-boundary &lt;work&gt;/u);
});
test('Applied, recovery and undone states expose only their supported next actions',()=>{
 const applied=render({operation:{...operation,status:'applied'}});assert.match(applied,/MEM-fixture\/undo/u);assert.match(applied,/href="\/projects\/P-new"/u);assert.doesNotMatch(applied,/MEM-fixture\/execute/u);
 const pending=render({operation:{...operation,status:'needs_recovery'}});assert.match(pending,/MEM-fixture\/recover/u);assert.doesNotMatch(pending,/MEM-fixture\/undo/u);
 const undone=render({operation:{...operation,status:'undone'}});assert.doesNotMatch(undone,/MEM-fixture\/(execute|undo|recover)/u);
});
test('Names, errors and entered paths remain escaped and preserve retry inputs',()=>{
 const html=render({project:{id:'P-source',name:'<script>bad</script>'},notice:'Missing <folder>',form:{source_relative_path:'<data>',new_project_name:'<new>'}});
 assert.doesNotMatch(html,/<script>bad/u);assert.match(html,/Missing &lt;folder&gt;/u);assert.match(html,/value="&lt;data&gt;"/u);
});

test('In-place partition has separate labelled inputs and boundary preview without move or repair actions',()=>{
 const chooser=render({},'zh-CN');
 const form=chooser.match(/<section class="surface membership-partition">([\s\S]*?)<\/section>/u)?.[1];assert.ok(form);
 assert.match(form,/name="mode" value="partition_existing"/u);assert.match(form,/for="partition-retained_relative_path"/u);assert.match(form,/id="partition-retained_relative_path"/u);
 assert.match(form,/name="retained_relative_path"/u);assert.doesNotMatch(form,/name="target_relative_path"/u);
 const error=render({notice:'Unsupported <boundary>',form:{mode:'partition_existing',retained_relative_path:'<交付>',source_relative_path:'研究',new_project_name:'研究项目'}},'zh-CN');
 assert.match(error,/Unsupported &lt;boundary&gt;/u);assert.match(error,/id="partition-retained_relative_path"[^>]*value="&lt;交付&gt;"/u);
 const partition={...operation,mode:'partition_existing',files_moved:false,file_changes:[],boundary_before:{source_project:{project_id:'P-source',path:'C:/fixture/source',relative_path:'source'}},boundary_after:{source_project:{project_id:'P-source',path:'C:/fixture/source/交付',relative_path:'source/交付'},new_project:{project_id:'P-new',path:'C:/fixture/source/研究',relative_path:'source/研究'}}};
 const html=render({operation:partition},'zh-CN');assert.match(html,/不移动文件/u);assert.match(html,/source\/交付/u);assert.match(html,/source\/研究/u);
 assert.match(html,/确认项目边界变更/u);assert.doesNotMatch(html,/确认移动|原位置|目标位置/u);
 const applied=render({operation:{...partition,status:'applied'}},'zh-CN');assert.match(applied,/项目边界已变更/u);assert.match(applied,/打开原项目/u);assert.match(applied,/打开新项目/u);assert.match(applied,/MEM-fixture\/undo/u);assert.doesNotMatch(applied,/document-updates\/repair|文件及归属已变更/u);
 const blocked=render({operation:{...partition,can_execute:false,blockers:['Cross-side <dependency>']}});assert.match(blocked,/Cross-side &lt;dependency&gt;/u);assert.doesNotMatch(blocked,/MEM-fixture\/execute/u);
 const pending=render({operation:{...partition,status:'needs_recovery'}});assert.match(pending,/MEM-fixture\/recover/u);assert.match(pending,/No files move/u);
 const undone=render({operation:{...partition,status:'undone'}});assert.match(undone,/Project boundaries restored/u);assert.doesNotMatch(undone,/MEM-fixture\/(execute|undo|recover)/u);
});
