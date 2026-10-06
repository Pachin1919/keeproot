import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHandoffView } from '../src/ui/views/handoff-view.js';
import { renderProjectHomeView } from '../src/ui/views/project-home-view.js';

const model = {
  base: '/projects/PRJ-test', project: { id: 'PRJ-test', name: '代表项目' },
  work_name: '合并地区资料', resource_items: [{ id: 'RES-source', name: '本期.csv', href: '/projects/PRJ-test/resources?resource_id=RES-source' }],
  save_items: [{ id: 'SAV-result', name: '地区汇总.csv', href: '/projects/PRJ-test/resources?resource_id=RES-result' }],
  handoff: { handoff_id: 'HOF-test', work_id: 'DWT-test', digest: 'f'.repeat(64), work_revision: 4, current_work_revision: 4, status: 'current', goal: '继续核对地区结果',
    package: { resource_ids: ['RES-source'], save_ids: ['SAV-result'], corrections: [{ text: '测试参与者：使用已确认字段', source: 'user_self_report' }], unfinished: ['检查下一期'] } },
};

test('Handoff foreground names, unfinished work and readonly object links; exact identity stays folded', () => {
  const html = renderHandoffView(model, { locale: 'zh-CN' });
  assert.match(html, /<h1>继续核对地区结果<\/h1>/u);
  assert.match(html, /href="\/projects\/PRJ-test\/resources\?resource_id=RES-source">本期.csv<\/a>/u);
  assert.match(html, /href="\/projects\/PRJ-test\/resources\?resource_id=RES-result">地区汇总.csv<\/a>/u);
  assert.match(html, /<details class="surface handoff-technical"><summary>/u);
  assert.ok(html.indexOf('检查下一期') < html.indexOf('<details class="surface handoff-technical">'));
  assert.match(html, /atlas handoff read HOF-test --project PRJ-test --json/u);
  assert.match(html, /自述纠正不是已确认规则/u);
  assert.doesNotMatch(html.slice(html.indexOf('<main')), /<form|启动Host/u);
});

test('blocked Handoff retains inspection, warns before action, escapes content and keeps unavailable objects unlinked', () => {
  const html = renderHandoffView({ ...model, resource_items: [], save_items: [], handoff: { ...model.handoff, status: 'blocked', goal: '<script>bad</script>' } }, { locale: 'zh-CN' });
  assert.match(html, /此包当前不能用于授权接续/u);
  assert.match(html, /href="\/work\/DWT-test"/u);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>bad|href="[^"]*RES-source|先阅读所选材料/u);
});

test('Home explicitly selects saved results by name without guessing or selecting a Save identity', () => {
  const html = renderProjectHomeView({ base: model.base, project: model.project, handoff_work_sessions: [{ session_id: 'DWT-test', revision: 4, intent: '合并地区资料' }], handoff_save_options: [{ save_id: 'SAV-result', name: '地区汇总.csv', created_at: '2026-10-06T00:00:00Z' }] }, { locale: 'zh-CN' });
  assert.match(html, /type="checkbox" name="save_ids" value="SAV-result"/u);
  assert.doesNotMatch(html, /type="checkbox" name="save_ids"[^>]*checked|placeholder="SAV-/u);
  assert.match(html, /地区汇总.csv/u);
  assert.match(html, /创建接续包时Atlas会再次核验/u);
  assert.match(html, /<option value="DWT-test">合并地区资料/u);
});
