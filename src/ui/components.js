
import { translateUi } from './i18n.js';

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
  blocked: { label: 'Blocked', meaning: 'Atlas stopped the work because a conflict or policy condition needs attention.' },
  cancelled: { label: 'Cancelled', meaning: 'The operation ended without applying the proposed work.' },
  completed: { label: 'Completed', meaning: 'The result was recorded and verified.' },
  conflict: { label: 'Conflict', meaning: 'Current files no longer match the state Atlas expected.' },
  current: { label: 'Current', meaning: 'The checked source still matches the recorded source.' },
  deferred: { label: 'Deferred', meaning: 'This capability is not included in the current release.' },
  deny: { label: 'Denied', meaning: 'Policy did not allow the proposed operation.' },
  failed: { label: 'Failed', meaning: 'The operation did not reach its expected result.' },
  missing_source: { label: 'Source missing', meaning: 'A recorded source could not be found at its expected location.' },
  moved_same_content: { label: 'Source moved', meaning: 'Matching content was found at a different location.' },
  needs_approval: { label: 'Needs approval', meaning: 'Atlas needs a user decision before applying the change.' },
  needs_candidate: { label: 'Candidate needed', meaning: 'The Agent has not supplied the proposed output yet.' },
  needs_input: { label: 'Input needed', meaning: 'The operation is missing a required user decision or input.' },
  not_checked: { label: 'Not checked', meaning: 'The check has not been run; Atlas is not claiming the source is current.' },
  ok: { label: 'Healthy', meaning: 'The local integrity check passed.' },
  partial: { label: 'Partial', meaning: 'Only part of the required historical fact is available.' },
  ready: { label: 'Ready', meaning: 'The next controlled action is available.' },
  rejected: { label: 'Rejected', meaning: 'The reviewed proposal was rejected and was not applied.' },
  rollback_available: { label: 'Restore available', meaning: 'Atlas has enough verified state to offer recovery.' },
  rolled_back: { label: 'Restored', meaning: 'The prior Atlas-controlled change was restored.' },
  selection_required: { label: 'Select project', meaning: 'More than one Project is possible; choose the intended boundary.' },
  setup_required: { label: 'Setup required', meaning: 'Root or Project Location has not been established.' },
  stale: { label: 'Out of date', meaning: 'The reviewed operation or Candidate changed and must be prepared again.' },
  stale_source: { label: 'Source changed', meaning: 'A selected source changed after Atlas recorded it.' },
  running: { label: 'In progress', meaning: 'Atlas is still working. The result is not complete yet.' },
  in_progress: { label: 'In progress', meaning: 'Atlas is still working. The result is not complete yet.' },
  unavailable: { label: 'Unavailable', meaning: 'The fact or optional local capability is not available.' },
  verified: { label: 'Verified', meaning: 'Atlas checked the recorded result against the expected result.' },
  warn: { label: 'Attention', meaning: 'The item is usable, but a limitation or decision needs attention.' },
});

export function statusPresentation(status) {
  const key = String(status ?? 'unavailable');
  return STATUS_PRESENTATION[key] ?? {
    label: key.replaceAll('_', ' '),
    meaning: 'Open the related operation or fact view for the recorded detail.',
  };
}

export function statusClass(status) {
  if (['completed', 'verified', 'ready', 'available', 'approved', 'rolled_back', 'current', 'active', 'ok'].includes(status)) return 'status-safe';
  if (['running', 'in_progress'].includes(status)) return 'status-progress';
  if (['warn', 'awaiting_review', 'needs_approval', 'needs_candidate', 'needs_input', 'selection_required', 'setup_required', 'rollback_available', 'not_checked', 'moved_same_content', 'partial'].includes(status)) return 'status-warn';
  if (['deny', 'blocked', 'stale', 'stale_source', 'missing_source', 'conflict', 'rejected', 'failed'].includes(status)) return 'status-danger';
  return 'status-neutral';
}

export function renderStatus(status, label = null) {
  const presentation = statusPresentation(status);
  return `<span class="status ${statusClass(status)}" title="${escapeHtml(presentation.meaning)}">${escapeHtml(label ?? presentation.label)}</span>`;
}

export function renderStatusGuide(locale = 'en', languageCatalog = null) {
  const t = (key) => translateUi(locale, `nav.${key}`, languageCatalog);
  const groups = [
    ['safe', 'status_safe'],
    ['progress', 'status_progress'],
    ['warn', 'status_warn'],
    ['danger', 'status_danger'],
    ['neutral', 'status_neutral'],
    ['neutral', 'status_ended'],
  ];
  return `<div class="status-guide"><button type="button" class="status-guide-toggle" data-status-guide-toggle aria-expanded="false">${escapeHtml(t('status_guide'))}</button><div class="status-guide-panel" popover="manual" data-status-guide-panel><button type="button" class="status-guide-close" data-status-guide-close aria-label="${escapeHtml(t('status_guide_close'))}">×</button><strong>${escapeHtml(t('status_guide_title'))}</strong><p class="status-guide-intro">${escapeHtml(t('status_guide_intro'))}</p><div class="status-guide-list">${groups.map(([tone, key]) => `<section class="status-guide-item"><span class="status status-${escapeHtml(tone)}">${escapeHtml(t(key))}</span><div><strong>${escapeHtml(t(`${key}_examples`))}</strong><p>${escapeHtml(t(`${key}_meaning`))}</p></div></section>`).join('')}</div></div></div>`;
}

export function renderUiClientScript(interactive) {
  return interactive ? '<script src="/ui.js" defer></script>' : '';
}

const NAV_ICON_SVG = Object.freeze({
  projects: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon="projects"><path d="M2.75 5.75h5l1.5 1.75h8v8.75H2.75z"/><path d="M2.75 7.5h14.5"/><path d="M6 10.5h2.5M6 13h2.5"/></svg>',
  resources: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon="resources"><path d="M5.25 3.25h7l2.5 2.5v10.5H5.25z"/><path d="M12.25 3.25v2.5h2.5M7.5 9h5M7.5 12h5M4 6.5v10.25h8.25"/></svg>',
  activity: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon="activity"><path d="M2.75 10h3l1.75-4.25 3 8.5 1.75-4.25h5.5"/><path d="M2.75 3.5v13h14.5"/></svg>',
  import: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon="import"><path d="M3 11.25h3l1.25 2h5.5l1.25-2h3v4.5H3z"/><path d="M10 3v7M7.5 7.5 10 10l2.5-2.5"/></svg>',
  settings: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon="settings"><circle cx="10" cy="10" r="2.5"/><path d="M10 3.25v1.5M10 15.25v1.5M16.75 10h-1.5M4.75 10h-1.5M14.77 5.23l-1.06 1.06M6.29 13.71l-1.06 1.06M14.77 14.77l-1.06-1.06M6.29 6.29 5.23 5.23"/></svg>',
});

function renderNavIcon(name) {
  return NAV_ICON_SVG[name] ?? NAV_ICON_SVG.activity;
}

export function renderTopbar({ section, project = null, resource = null, status = null, locale = 'en', languageCatalog = null } = {}) {
  const t = (key) => translateUi(locale, key, languageCatalog);
  const projectName = project?.name ?? project;
  const projectLabel = project?.id
    ? `<a class="topbar-project-link" href="${escapeHtml(`/projects/${encodeURIComponent(project.id)}`)}" title="${escapeHtml(projectName)}"><strong>${escapeHtml(projectName)}</strong></a>`
    : `<strong>${escapeHtml(projectName)}</strong>`;
  const context = project
    ? `<span class="topbar-context">${projectLabel}${resource ? `<small>${escapeHtml(resource)}</small>` : ''}</span>`
    : `<span class="topbar-context"><strong>${escapeHtml(section ?? 'Atlas')}</strong></span>`;
  return `<header class="topbar" data-current-project-id="${escapeHtml(project?.id ?? '')}" data-current-resource-path="${escapeHtml(resource ?? '')}">
    <div class="topbar-identity"><span class="label">Atlas Desktop</span>${context}</div>
    <button class="topbar-search" type="button" data-overlay-open="atlas-search" aria-haspopup="dialog" aria-label="${escapeHtml(t('topbar.search'))}"><span class="nav-icon" aria-hidden="true">&#xE721;</span><span>${escapeHtml(t('topbar.search'))}</span><kbd>Ctrl K</kbd></button>
    <span class="status status-safe topbar-status">${escapeHtml(status ?? t('topbar.on_device'))}</span>
  </header>
  <dialog class="atlas-overlay search-overlay" id="atlas-search" data-atlas-overlay aria-labelledby="atlas-search-title">
    <div class="overlay-card">
      <div class="overlay-heading"><div><span class="label">${escapeHtml(t('topbar.find_local_work'))}</span><h2 id="atlas-search-title">${escapeHtml(t('topbar.search'))}</h2></div><button class="overlay-close" type="button" data-overlay-close aria-label="${escapeHtml(t('topbar.close_search'))}">×</button></div>
      <form class="search-form" method="get" action="/search"><label for="atlas-search-query">${escapeHtml(t('topbar.search_label'))}</label><div><input id="atlas-search-query" name="q" type="search" autocomplete="off" required data-overlay-initial-focus><button class="action-button" type="submit">${escapeHtml(t('topbar.search_action'))}</button></div></form>
      <p class="muted">${escapeHtml(t('topbar.search_lede'))}</p>
    </div>
  </dialog>`;
}

export function renderNav(current, {
  interactive = false,
  workspaceHref = '/projects',
  resourcesHref = null,
  importHref = '/files',
  settingsHref = null,
  locale = 'en',
  languageCatalog = null,
} = {}) {
  const t = (key) => translateUi(locale, key, languageCatalog);
  const projectsHref = workspaceHref || '/projects';
  const items = interactive
    ? [
        { current: 'Projects', label: t('nav.projects'), icon: 'projects', href: projectsHref },
        {
          current: 'Resources', label: t('nav.resources'),
          icon: 'resources',
          href: resourcesHref ?? projectsHref,
          title: resourcesHref ? t('nav.resources') : t('nav.resources_choose_project'),
        },
        { current: 'Activity', label: t('nav.activity'), icon: 'activity', href: '/activity' },
        { current: 'Import', label: t('nav.import'), icon: 'import', href: importHref },
        ...(settingsHref ? [{ current: 'Settings', label: t('nav.settings'), icon: 'settings', href: settingsHref }] : []),
      ]
    : [{ current: 'Snapshot', label: t('nav.snapshot'), icon: 'activity', href: null }];
  const clientMessages = Object.fromEntries(['resources_title', 'sort_ascending', 'sort_descending', 'close_settings_confirm', 'choose_folder', 'project', 'file', 'working', 'processing']
    .map((key) => [key, t(`client.${key}`)]));
  return `<aside class="sidebar" id="atlas-primary-nav" data-atlas-primary-nav data-ui-client-messages="${escapeHtml(JSON.stringify(clientMessages))}">
    <div class="brand"><span class="brand-mark">A</span><span class="brand-copy">Atlas<small>Workspace</small></span></div>
    <nav aria-label="${escapeHtml(t('nav.primary'))}">
      <ul class="nav-list">
        ${items.map((item) => (
    `<li class="nav-item"${item.current === current ? ' aria-current="page"' : ''}>${item.href
      ? `<a href="${escapeHtml(item.href)}" title="${escapeHtml(item.title ?? item.label)}"${item.current === 'Resources' ? ' data-resources-nav' : ''}><span class="nav-icon" aria-hidden="true">${renderNavIcon(item.icon)}</span><span class="nav-label">${escapeHtml(item.label)}</span></a>`
      : `<span class="nav-link nav-link-disabled"${item.current === 'Resources' ? ' data-resources-nav' : ''} aria-disabled="true" title="${escapeHtml(item.current === 'Resources' ? t('nav.resources_choose_project') : item.label)}"><span class="nav-icon" aria-hidden="true">${renderNavIcon(item.icon)}</span><span class="nav-label">${escapeHtml(item.label)}</span></span>`}</li>`
  )).join('')}
      </ul>
    </nav>
    ${interactive ? `<button class="rail-toggle" type="button" data-toggle-rail data-collapse-label="${escapeHtml(t('nav.collapse'))}" data-expand-label="${escapeHtml(t('nav.expand'))}" aria-label="${escapeHtml(t('nav.collapse'))}" aria-expanded="true"><span aria-hidden="true">‹</span></button>` : ''}
    <div class="sidebar-signature" aria-label="Pachin Studio · Local Workspace">
      <div class="signature-art" aria-hidden="true"><img class="signature-calligraphy" src="/ui/pachin-calligraphy.png" alt=""><img class="signature-seal" src="/ui/pachin-seal.png" alt=""></div>
      <div class="signature-copy"><strong>PACHIN STUDIO</strong><span>LOCAL WORKSPACE</span></div>
    </div>
    <div class="sidebar-foot">${interactive ? renderStatusGuide(locale, languageCatalog) : ''}<span class="device-state"><span class="status-dot"></span><span class="device-state-copy">${escapeHtml(t('nav.on_device'))}</span></span></div>
  </aside>${interactive ? `<div class="rail-resizer app-rail-resizer" role="separator" aria-label="${escapeHtml(t('nav.resize'))}" aria-orientation="vertical" aria-valuemin="68" aria-valuemax="360" tabindex="0" data-rail="app"></div>` : ''}`;
}

export function renderFacts(rows) {
  return `<dl class="facts">${rows.map(([label, value, mono = false]) => (
    `<dt>${escapeHtml(label)}</dt><dd${mono ? ' class="mono"' : ''}>${escapeHtml(value ?? 'Not available')}</dd>`
  )).join('')}</dl>`;
}
