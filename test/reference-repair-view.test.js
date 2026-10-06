import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReferenceRepairView } from '../src/ui/views/reference-repair-view.js';
import { renderDocumentUpdateView } from '../src/ui/views/document-update-view.js';
import { renderProjectMembershipView } from '../src/ui/views/project-membership-view.js';

const project = { id: 'P-target', name: 'Project' };
const update = { project_id: project.id, update_id: 'UPD-one', resource_id: 'RES-one', revision: 1, status: 'preview_ready',
  resource: { relative_path: 'Index.md' }, source: { kind: 'project_membership', operation_id: 'MEM-one', source_project_id: 'P-source', revision: 2, digest: 'digest' },
  source_status: 'current', source_conflict: null, baseline: { text: 'Before', sha256: 'hash' }, proposed: { text: 'After', sha256: 'candidate' },
  current: { text: 'Before', sha256: 'hash' }, change: { kind: 'link_repair', edits: [{ old_text: '[Doc](../old/a.md)', new_text: '[Doc](../new/a.md)' }], skipped: [{ reason: '<complex>', bounded_location: 'line 2' }] } };

test('Link repair preview is escaped, bound, limited to two decisions, and collapses document text', () => {
  for (const locale of ['en', 'zh-CN']) {
    const html = renderDocumentUpdateView({ project, update }, { csrfToken: 'token', locale });
    assert.match(html, /P-source\/membership\/MEM-one/u);
    assert.match(html, /\[Doc\]\(\.\.\/old\/a.md\)/u); assert.match(html, /\[Doc\]\(\.\.\/new\/a.md\)/u);
    assert.match(html, /&lt;complex&gt;/u);
    assert.match(html, /value="keep-current"/u); assert.match(html, /value="accept-suggestion"/u);
    assert.doesNotMatch(html, /value="revise"|textarea name="text"|<input name="request_key"/u);
    assert.match(html, /type="hidden" name="request_key"/u); assert.match(html, /name="expected_revision" value="1"/u);
    assert.match(html, /<details class="surface repair-fulltext"><summary>/u); assert.doesNotMatch(html, /<details[^>]+open/u);
  }
});

test('Stale repair source blocks accept and execute while preserving Undo and recovery', () => {
  const render = extra => renderDocumentUpdateView({ project, update: { ...update, ...extra } }, { csrfToken: 'token' });
  const stale = render({ source_status: 'changed', source_conflict: { reason: 'Operation <changed>' }, decision: { kind: 'accept-suggestion' } });
  assert.match(stale, /value="accept-suggestion" selected disabled/u); assert.doesNotMatch(stale, /UPD-one\/execute/u);
  assert.match(stale, /Operation &lt;changed&gt;/u);
  assert.match(render({ source_status: 'unavailable', execution: { before: {} } }), /UPD-one\/undo/u);
  assert.match(render({ source_status: 'changed', pending: { kind: 'execute' } }), /UPD-one\/recover/u);
});

test('Selection preserves receipt binding and no-change results; applied merge navigation points to target', () => {
  const html = renderReferenceRepairView({ project, source: { source_kind: 'project_move', source_project_id: 'P-source', operation_id: 'RUN-one', source_revision: '2', source_digest: 'digest' },
    basis: { from_path: 'old', to_path: 'new' }, resources: [{ resource_id: 'RES-one', relative_path: '<Index>.md' }],
    results: [{ relative_path: '<Index>.md', status: 'no_change', skipped: [] }] }, { csrfToken: 'token' });
  assert.match(html, /name="source_digest" value="digest"/u); assert.match(html, /type="checkbox" name="resource_id" value="RES-one"/u);
  assert.match(html, /&lt;Index&gt;.md/u); assert.match(html, /No supported link changes/u);
  const membership = renderProjectMembershipView({ project: { id: 'P-source', name: 'Old', status: 'merged' }, projects: [project],
    operation: { operation_id: 'MEM-one', operation: 'merge', status: 'applied', source_project_id: 'P-source', target_project_id: project.id,
      revision: 2, digest: 'digest', source: { relative_path: 'old' }, target: { relative_path: 'new' }, summary: {}, blockers: [] } }, { csrfToken: 'token' });
  assert.match(membership, /class="action-button" href="\/projects\/P-target"/u);
  assert.match(membership, /class="action-button action-button-secondary" type="submit"/u);
  assert.doesNotMatch(membership, /href="\/projects\/P-source\/membership"/u);
  assert.match(membership, /P-target\/document-updates\/repair/u);
});
