export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STATUS_PRESENTATION = Object.freeze({
  active: { label: 'Active', meaning: 'This rule or item is currently in effect.' },
  approved: { label: 'Approved', meaning: 'The exact reviewed proposal was approved but may not be applied yet.' },
  available: { label: 'Available', meaning: 'The optional local capability is installed and responding.' },
  awaiting_review: { label: 'Awaiting review', meaning: 'A proposal exists and is waiting for a user decision.' },
  blocked: { label: 'Blocked', meaning: 'Atlas stopped the Task because a conflict or policy condition needs attention.' },
  cancelled: { label: 'Cancelled', meaning: 'The Task ended without applying the proposed work.' },
  completed: { label: 'Completed', meaning: 'The Task output was recorded and verified.' },
  conflict: { label: 'Conflict', meaning: 'Current files no longer match the state Atlas expected.' },
  current: { label: 'Current', meaning: 'The checked source still matches the recorded source.' },
  deferred: { label: 'Deferred', meaning: 'This capability is not included in the current release.' },
  deny: { label: 'Denied', meaning: 'Policy did not allow the proposed operation.' },
  failed: { label: 'Failed', meaning: 'The operation did not reach its expected result.' },
  missing_source: { label: 'Source missing', meaning: 'A recorded source could not be found at its expected location.' },
  moved_same_content: { label: 'Source moved', meaning: 'Matching content was found at a different location.' },
  needs_approval: { label: 'Needs approval', meaning: 'Atlas needs a user decision before applying the change.' },
  needs_candidate: { label: 'Candidate needed', meaning: 'The Agent has not supplied the proposed output yet.' },
  needs_input: { label: 'Input needed', meaning: 'The Task is missing a required user decision or input.' },
  not_checked: { label: 'Not checked', meaning: 'The check has not been run; Atlas is not claiming the source is current.' },
  ok: { label: 'Healthy', meaning: 'The local integrity check passed.' },
  partial: { label: 'Partial', meaning: 'Only part of the required historical fact is available.' },
  ready: { label: 'Ready', meaning: 'The next controlled action is available.' },
  rejected: { label: 'Rejected', meaning: 'The reviewed proposal was rejected and was not applied.' },
  rollback_available: { label: 'Restore available', meaning: 'Atlas has enough verified state to offer recovery.' },
  rolled_back: { label: 'Restored', meaning: 'The prior Atlas-controlled change was restored.' },
  selection_required: { label: 'Select project', meaning: 'More than one Project is possible; choose the intended boundary.' },
  setup_required: { label: 'Setup required', meaning: 'Root or Project Location has not been established.' },
  stale: { label: 'Out of date', meaning: 'The reviewed Task or Candidate changed and must be prepared again.' },
  stale_source: { label: 'Source changed', meaning: 'A selected source changed after the Task recorded it.' },
  unavailable: { label: 'Unavailable', meaning: 'The fact or optional local capability is not available.' },
  verified: { label: 'Verified', meaning: 'Atlas checked the recorded result against the expected result.' },
  warn: { label: 'Attention', meaning: 'The item is usable, but a limitation or decision needs attention.' },
});

export function statusPresentation(status) {
  const key = String(status ?? 'unavailable');
  return STATUS_PRESENTATION[key] ?? {
    label: key.replaceAll('_', ' '),
    meaning: 'Open the related Task or fact view for the recorded detail.',
  };
}

export function statusClass(status) {
  if (['completed', 'verified', 'ready', 'available', 'approved', 'rolled_back', 'current', 'active', 'ok'].includes(status)) return 'status-safe';
  if (['warn', 'awaiting_review', 'needs_approval', 'needs_candidate', 'needs_input', 'selection_required', 'setup_required', 'rollback_available', 'not_checked', 'moved_same_content', 'partial'].includes(status)) return 'status-warn';
  if (['deny', 'blocked', 'stale', 'stale_source', 'missing_source', 'conflict', 'rejected', 'failed'].includes(status)) return 'status-danger';
  return 'status-neutral';
}

export function renderStatus(status, label = null) {
  const presentation = statusPresentation(status);
  return `<span class="status ${statusClass(status)}" title="${escapeHtml(presentation.meaning)}">${escapeHtml(label ?? presentation.label)}</span>`;
}

export function renderStatusGuide() {
  const groups = [
    ['safe', 'Normal', 'Ready · Active · Completed · Verified', 'Atlas has a usable or verified state. No warning is being raised.'],
    ['warn', 'Waiting for you', 'Awaiting review · Input needed', 'Work is paused. Open the Task and make the requested decision.'],
    ['danger', 'Atlas stopped', 'Blocked · Conflict · Out of date', 'Atlas did not continue. Inspect the recorded reason before trying again.'],
    ['neutral', 'Information incomplete', 'Not checked · Unavailable · Partial', 'Atlas is not claiming success. Run the named check or inspect the missing fact.'],
    ['neutral', 'Ended or restored', 'Restored · Rejected · Cancelled', 'The change was restored, or the Task ended without continuing.'],
  ];
  return `<details class="status-guide"><summary>Status guide</summary><div class="status-guide-panel"><strong>How to read Atlas states</strong><p class="status-guide-intro">Color tells you whether Atlas continued, paused, or stopped. The Task page contains the exact event and reason.</p><div class="status-guide-list">${groups.map(([tone, label, states, meaning]) => `<section class="status-guide-item"><span class="status status-${escapeHtml(tone)}">${escapeHtml(label)}</span><div><strong>${escapeHtml(states)}</strong><p>${escapeHtml(meaning)}</p></div></section>`).join('')}</div></div></details>`;
}

export function renderUiClientScript(interactive) {
  return interactive ? '<script src="/ui.js" defer></script>' : '';
}

export function renderNav(current, { interactive = false, workspaceHref = '/', settingsHref = null } = {}) {
  const items = interactive
    ? [
        { label: 'Workspace', href: workspaceHref },
        { label: 'Tasks', href: '/tasks' },
        ...(settingsHref ? [{ label: 'Settings', href: settingsHref }] : []),
      ]
    : [{ label: 'Snapshot', href: null }];
  return `<aside class="sidebar" id="atlas-primary-nav">
    <div class="brand"><span class="brand-mark">A</span><span>Atlas<small>Local governance</small></span></div>
    <nav aria-label="Primary">
      <ul class="nav-list">
        ${items.map((item) => (
    `<li class="nav-item"${item.label === current ? ' aria-current="page"' : ''}>${item.href
      ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`
      : escapeHtml(item.label)}</li>`
  )).join('')}
      </ul>
    </nav>
    <div class="sidebar-foot">${interactive ? renderStatusGuide() : ''}<span><span class="status-dot"></span> On this device</span></div>
  </aside>${interactive ? '<div class="rail-resizer app-rail-resizer" role="separator" aria-label="Resize navigation" aria-orientation="vertical" aria-valuemin="180" aria-valuemax="360" tabindex="0" data-rail="app"></div>' : ''}`;
}

export function renderFacts(rows) {
  return `<dl class="facts">${rows.map(([label, value, mono = false]) => (
    `<dt>${escapeHtml(label)}</dt><dd${mono ? ' class="mono"' : ''}>${escapeHtml(value ?? 'Not available')}</dd>`
  )).join('')}</dl>`;
}
