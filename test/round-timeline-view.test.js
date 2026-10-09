import assert from 'node:assert/strict';
import test from 'node:test';
import { renderRoundTimelineView } from '../src/ui/views/round-timeline-view.js';

function model(preview = {}) {
  return {
    base: '/projects/P1',
    project: { id: 'P1', name: 'Project name' },
    round: {
      round_id: 'RND-1', label: 'Round one', revision: 3, head_node_id: 'N-before', paths: ['one.txt'], current_digest: 'digest',
      changed_files: [], current_files: [], scope_extensions: [], restores: [],
      nodes: [
        { node_id: 'N-before', kind: 'before', label: 'Round before', files: [] },
        { node_id: 'N-future', kind: 'future_kind', label: 'Middle checkpoint', files: [{ path: 'one.txt', change: 'future <change>' }] },
        { node_id: 'N-insurance', kind: 'insurance', label: 'Before restore', files: [] },
      ],
    },
    preview: {
      action: 'restore', node_id: 'N-before', restore_id: '', base_revision: 3, expected_digest: 'digest', preview_token: 'preview-token',
      files: [{ path: 'one.txt', change: 'remove (insured)' }, { path: 'two.txt', change: 'restore file' }, { path: 'three.txt', change: 'replace content' }],
      work_count: 2, board_count: 1, resource_count: 4,
      ...preview,
    },
  };
}

test('round preview renders recorded product state and localizes recovery labels', () => {
  const html = renderRoundTimelineView(model(), { csrfToken: 'csrf', locale: 'zh-CN' });
  assert.match(html, /本回合记录了 0 项文件更改/u);
  assert.match(html, /将恢复的记录状态/u);
  assert.match(html, /包含 2 个工作、1 个看板和 4 个资源记录/u);
  assert.match(html, /删除文件（先留存回档前状态）/u);
  assert.match(html, /恢复文件/u);
  assert.match(html, /替换内容/u);
  assert.match(html, /回合前/u);
  assert.match(html, /回档前/u);
  assert.match(html, /预览回到这个节点/u);
  assert.match(html, /name="preview_token" value="preview-token"/u);
  assert.match(html, /future_kind/u);
  assert.match(html, /future &lt;change&gt;/u);
  assert.doesNotMatch(html, /future <change>/u);
});

test('round preview keeps recorded state visible without file changes and names an intermediate node target', () => {
  const empty = renderRoundTimelineView(model({ files: [] }), { csrfToken: 'csrf', locale: 'en' });
  assert.match(empty, /No recorded file changes\./u);
  assert.match(empty, /2 Work, 1 Board, and 4 Resource records are included\./u);
  const intermediate = renderRoundTimelineView(model({ node_id: 'N-future' }), { csrfToken: 'csrf', locale: 'en' });
  assert.match(intermediate, /<h2>Return to this node<\/h2>/u);
  assert.match(intermediate, /Node: Middle checkpoint/u);
  assert.match(intermediate, />Return to this node<\/button>/u);
  assert.doesNotMatch(intermediate, /<h2>Return to before this round<\/h2>/u);
  const translatedError = renderRoundTimelineView({ ...model(), error: 'Action stopped. Round revision changed. Read the current round again.', error_message: 'Round revision changed. Read the current round again.' }, { csrfToken: 'csrf', locale: 'zh-CN' });
  assert.match(translatedError, /你查看期间此回档已发生变化。请重新预览。/u);
  assert.match(translatedError, /Action stopped\. Round revision changed\. Read the current round again\./u);
  const unknownError = renderRoundTimelineView({ ...model(), error: 'Action stopped. Host detail is unavailable.', error_message: 'Host detail is unavailable.' }, { csrfToken: 'csrf', locale: 'zh-CN' });
  assert.match(unknownError, /Keeproot 无法继续此回档。/u);
  assert.match(unknownError, /Action stopped\. Host detail is unavailable\./u);
});

test('round node time follows the selected interface language', () => {
  const fixture = model();
  fixture.round.nodes[0].created_at = '2026-09-22T15:46:00+08:00';
  const html = renderRoundTimelineView(fixture, { csrfToken: 'csrf', locale: 'zh-CN' });
  assert.match(html, /2026年9月22日/u);
  assert.doesNotMatch(html, /Sep 22/u);
});
