export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function statusClass(status) {
  if (['completed', 'verified', 'ready', 'approved', 'rolled_back', 'current', 'active'].includes(status)) return 'status-safe';
  if (['warn', 'awaiting_review', 'selection_required', 'rollback_available', 'not_checked', 'moved_same_content', 'partial'].includes(status)) return 'status-warn';
  if (['deny', 'blocked', 'stale', 'stale_source', 'missing_source', 'conflict', 'rejected', 'failed'].includes(status)) return 'status-danger';
  return 'status-neutral';
}

export function renderStatus(status, label = status) {
  return `<span class="status ${statusClass(status)}">${escapeHtml(label)}</span>`;
}

export function renderNav(current) {
  return `<aside class="sidebar">
    <div class="brand">Atlas</div>
    <nav aria-label="Primary">
      <ul class="nav-list">
        ${['Workspace', 'Tasks', 'Rules', 'Sources', 'Runtime'].map((item) => (
    `<li class="nav-item"${item === current ? ' aria-current="page"' : ''}>${item}</li>`
  )).join('')}
      </ul>
    </nav>
  </aside>`;
}

export function renderFacts(rows) {
  return `<dl class="facts">${rows.map(([label, value, mono = false]) => (
    `<dt>${escapeHtml(label)}</dt><dd${mono ? ' class="mono"' : ''}>${escapeHtml(value ?? 'Not available')}</dd>`
  )).join('')}</dl>`;
}
