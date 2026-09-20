import { escapeHtml, renderNav, renderStatus, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function escapedHref(href) {
  return href ? ` href="${escapeHtml(href)}"` : '';
}

function renderLinkedItem(item, className, content) {
  return item.href
    ? `<a class="${className}"${escapedHref(item.href)}>${content}</a>`
    : `<article class="${className}">${content}</article>`;
}

function renderTimestamp(value) {
  return value ? `<time>${escapeHtml(value)}</time>` : '';
}

function renderPinControl(item, model, csrfToken, label = null, explicitAction = null) {
  const action = explicitAction ?? (item.pinned ? 'unpin' : 'pin');
  const actionLabel = label ?? (action === 'pin' ? 'Pin' : 'Unpin');
  return `<form method="post" action="${escapeHtml(`${model.base}/home/pins`)}" class="project-home-pin-form"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="kind" value="${escapeHtml(item.kind ?? '')}"><input type="hidden" name="id" value="${escapeHtml(item.id ?? '')}"><button class="text-link" type="submit">${escapeHtml(actionLabel)}</button></form>`;
}

function renderContinue(model) {
  if (!model.continue_item && !(model.other_work ?? []).length) return '';
  const item = model.continue_item;
  const target = item ? renderLinkedItem(item, 'project-home-primary-target', `<span class="project-home-item-copy"><strong>${escapeHtml(item.title ?? '')}</strong>${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ''}</span><span class="project-home-primary-meta">${item.position !== undefined && item.position !== null ? `<span>Position ${escapeHtml(item.position)}</span>` : ''}${renderTimestamp(item.updated_at)}${item.notice ? `<span class="project-home-notice">${escapeHtml(item.notice)}</span>` : ''}</span>`) : '';
  const otherWork = (model.other_work ?? []).length
    ? `<div class="project-home-secondary-list"><span class="eyebrow">OTHER OPEN WORK</span>${model.other_work.map((work) => renderLinkedItem(work, 'project-home-secondary-target', `<span><strong>${escapeHtml(work.title ?? '')}</strong>${work.detail ? `<small>${escapeHtml(work.detail)}</small>` : ''}</span>${renderTimestamp(work.updated_at)}`)).join('')}</div>`
    : '';
  return `<section class="surface project-home-section project-home-continue" aria-labelledby="project-home-continue-title"><div class="project-home-section-heading"><div><span class="eyebrow">CONTINUE</span><h2 id="project-home-continue-title">Pick up where you left off</h2></div></div>${target}${otherWork}</section>`;
}

function renderPinned(model, csrfToken) {
  const pinned = model.pinned ?? [];
  if (!pinned.length) return '';
  return `<section class="surface project-home-section" aria-labelledby="project-home-pinned-title"><div class="project-home-section-heading"><div><span class="eyebrow">PINNED</span><h2 id="project-home-pinned-title">Keep close at hand</h2></div></div><div class="project-home-list">${pinned.map((item) => `<div class="project-home-list-row">${renderLinkedItem(item, 'project-home-list-target', `<span class="project-home-item-copy"><strong>${escapeHtml(item.title ?? '')}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}</span><span class="project-home-meta">${item.status ? renderStatus(item.status) : ''}${renderTimestamp(item.updated_at)}</span>`)}${renderPinControl(item, model, csrfToken, 'Unpin', 'unpin')}</div>`).join('')}</div></section>`;
}

function renderChanges(model, csrfToken) {
  const changes = model.changes ?? {};
  const stateCopy = {
    attention: ['Changes requiring attention', 'Atlas found items that need review.'],
    not_checked: ['Not checked yet', 'Atlas has not checked this scope yet.'],
    clear: ['No issues found', 'The last completed check found no issues in this scope.'],
    failed: ['Check did not finish', 'Atlas could not complete the last check.'],
  };
  const [title, detail] = stateCopy[changes.state] ?? ['Changes requiring attention', 'Open the recorded items for their current detail.'];
  const items = changes.items ?? [];
  const canCheck = ['not_checked', 'failed', 'clear', 'attention'].includes(changes.state);
  const checkForm = canCheck ? `<form method="post" action="${escapeHtml(`${model.base}/home/check`)}" class="project-home-check-form"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><button class="action-button action-button-secondary" type="submit">Check tracked Resources</button></form>` : '';
  const missing = model.missing_records ?? {};
  const missingControls = missing.count || missing.archived_count
    ? `<div class="inline-actions">${missing.count ? `<a class="action-button action-button-secondary" href="${escapeHtml(`${model.base}/resources?missing=1`)}">Review missing records</a><form method="post" action="${escapeHtml(`${model.base}/home/archive-missing`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><button class="action-button" type="submit">Archive unavailable records</button></form>` : ''}${missing.archived_count ? `<form method="post" action="${escapeHtml(`${model.base}/home/restore-missing`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><button class="action-button action-button-secondary" type="submit">Restore archived records</button></form>` : ''}</div><p class="muted">Archiving hides the selected missing reminders, including old Work or Result reminders. It does not delete local files, relationships, or Atlas history.</p>`
    : '';
  return `<section class="surface project-home-section" aria-labelledby="project-home-changes-title"><div class="project-home-section-heading"><div><span class="eyebrow">CHANGES</span><h2 id="project-home-changes-title">${escapeHtml(title)}</h2><p>${escapeHtml(detail)}${changes.scope_label ? ` ${escapeHtml(changes.scope_label)}` : ''}</p></div>${changes.checked_at ? `<time class="project-home-checked">Checked ${escapeHtml(changes.checked_at)}</time>` : ''}</div>${items.length ? `<div class="project-home-list">${items.map((item) => renderLinkedItem(item, 'project-home-list-target', `<span class="project-home-item-copy"><strong>${escapeHtml(item.title ?? '')}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}</span>${item.status ? renderStatus(item.status) : ''}`)).join('')}</div>` : ''}${missingControls}${checkForm}</section>`;
}

function renderRecentResults(model, csrfToken) {
  const results = model.recent_results ?? [];
  const resourcesHref = `${model.base}/resources`;
  return `<section class="surface project-home-section" aria-labelledby="project-home-results-title"><div class="project-home-section-heading"><div><span class="eyebrow">RECENT RESULTS</span><h2 id="project-home-results-title">Saved work you can return to</h2></div></div>${results.length ? `<div class="project-home-list">${results.map((item) => `<div class="project-home-list-row">${renderLinkedItem(item, 'project-home-list-target', `<span class="project-home-item-copy"><strong>${escapeHtml(item.title ?? '')}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}</span><span class="project-home-meta">${item.status ? renderStatus(item.status) : ''}${renderTimestamp(item.updated_at)}</span>`)}${renderPinControl({ ...item, kind: 'result' }, model, csrfToken)}</div>`).join('')}</div>` : `<p class="project-home-empty-copy">No verified results are saved yet. <a class="text-link" href="${escapeHtml(resourcesHref)}">Open Resources</a></p>`}</section>`;
}

function renderEmptyProject(model) {
  const resourcesHref = `${model.base}/resources`;
  return `<section class="surface project-home-start" aria-labelledby="project-home-start-title"><span class="eyebrow">START HERE</span><h2 id="project-home-start-title">Bring your Project into view</h2><p>Open its local files and resources, or import material to begin working here.</p><div class="inline-actions"><a class="action-button" href="${escapeHtml(resourcesHref)}">Files and Resources</a><a class="action-button action-button-secondary" href="/files">Import</a></div></section>`;
}

export function renderProjectHomeView(model, options = {}) {
  const csrfToken = options.csrfToken ?? '';
  const base = model.base ?? '';
  const project = model.project ?? {};
  const body = model.empty_project ? renderEmptyProject(model) : `${renderContinue(model)}${renderPinned(model, csrfToken)}`;
  const supportingSections = model.empty_project ? '' : `${renderChanges(model, csrfToken)}${renderRecentResults(model, csrfToken)}`;
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(project.name ?? 'Project')} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { interactive: true, workspaceHref: '/projects', resourcesHref: `${base}/resources`, importHref: '/files', settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Project Home', project })}<main class="page project-home"><div class="page-intro"><div><span class="eyebrow">PROJECT HOME</span><h1>Welcome back to ${escapeHtml(project.name ?? 'this Project')}</h1><p class="lede">Return to the local work that matters now.</p></div></div>${model.state_error ? `<section class="surface project-home-state-warning" role="alert"><p class="callout warn">${escapeHtml(model.state_error)}</p><a class="text-link" href="${escapeHtml(`${base}/resources`)}">Open Project files and Resources</a></section>` : ''}${body}${supportingSections}</main></div></div></body></html>`;
}
