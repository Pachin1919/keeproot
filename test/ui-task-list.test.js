import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTaskListModel } from '../src/ui/read-model/task-list-model.js';

function task(index, projectId, status = 'completed') {
  return {
    task_id: `TSK-${String(index).padStart(2, '0')}`,
    task_status: status,
    intent: index === 7 ? 'Prepare the July report' : `Task ${index}`,
    target: `outputs/${index}.md`,
    started_at: `2026-08-${String(Math.min(index, 28)).padStart(2, '0')}T00:00:00.000Z`,
  };
}

test('Task list filters, sorts and paginates a multi-Project queue', () => {
  const context = {
    projects: [{
      project: { id: 'PRJ-A', name: 'Alpha' },
      tasks: Array.from({ length: 28 }, (_, index) => task(index + 1, 'PRJ-A', index === 6 ? 'blocked' : 'completed')),
    }, {
      project: { id: 'PRJ-B', name: 'Beta' },
      tasks: [task(29, 'PRJ-B', 'ready')],
    }],
    runtime: null,
  };

  const secondPage = buildTaskListModel(context, { sort: 'oldest', page: '2' });
  assert.equal(secondPage.total_count, 29);
  assert.equal(secondPage.page_count, 2);
  assert.equal(secondPage.tasks.length, 4);
  assert.equal(secondPage.tasks[0].task_id, 'TSK-26');

  const filtered = buildTaskListModel(context, { q: 'july', status: 'action_required' });
  assert.deepEqual(filtered.tasks.map((item) => item.task_id), ['TSK-07']);
  assert.equal(filtered.filtered_count, 1);
});
