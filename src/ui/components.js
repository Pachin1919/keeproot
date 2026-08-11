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

export function renderNav(current, { interactive = false, workspaceHref = '/' } = {}) {
  const items = interactive
    ? [
        { label: 'Workspace', href: workspaceHref },
        { label: 'Tasks', href: `${workspaceHref}#tasks` },
      ]
    : [{ label: 'Snapshot', href: null }];
  return `<aside class="sidebar">
    <div class="brand">Atlas</div>
    <nav aria-label="Primary">
      <ul class="nav-list">
        ${items.map((item) => (
    `<li class="nav-item"${item.label === current ? ' aria-current="page"' : ''}>${item.href
      ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`
      : escapeHtml(item.label)}</li>`
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
