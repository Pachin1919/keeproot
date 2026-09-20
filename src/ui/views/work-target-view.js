import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function sourceCount(work) {
  return Array.isArray(work.sources) ? work.sources.length : work.sources ?? 0;
}

function selectedResources(selection) {
  const resources = selection.resources ?? [];
  return resources.length
    ? `<ul class="work-target-selection-list">${resources.map((resource) => `<li><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resource.relative_path)}</small></li>`).join('')}</ul>`
    : '<p class="callout warn">No files are selected for Work.</p>';
}

function updateWorkForm(model, work) {
  const label = typeof work.intent === 'string' && work.intent.trim() ? work.intent : work.session_id;
  const identity = label === work.session_id ? '' : `<p class="muted">Work ID: ${escapeHtml(work.session_id)}</p>`;
  return `<article class="surface work-target-existing"><div><span class="eyebrow">EXISTING WORK</span><h2>${escapeHtml(label)}</h2>${identity}<dl><dt>Revision</dt><dd>${escapeHtml(work.revision)}</dd><dt>Sources</dt><dd>${escapeHtml(sourceCount(work))}</dd><dt>Last update</dt><dd>${escapeHtml(work.updated_at ?? 'Not available')}</dd>${work.return_state ? `<dt>Return state</dt><dd>${escapeHtml(work.return_state)}</dd>` : ''}</dl></div><form method="post" action="${escapeHtml(model.commit_action)}"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><input type="hidden" name="target" value="existing"><input type="hidden" name="work_id" value="${escapeHtml(work.session_id)}"><input type="hidden" name="base_revision" value="${escapeHtml(work.revision)}"><button class="action-button" type="submit">Update this Work</button></form></article>`;
}

export function renderWorkTargetView(model, options = {}) {
  const selection = model.selection ?? { resources: [], count: 0 };
  const works = model.works ?? [];
  const startNew = `<form method="post" action="${escapeHtml(model.commit_action)}" class="work-target-start"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><input type="hidden" name="target" value="new"><button class="action-button" type="submit">Start new Work</button></form>`;
  const cancel = `<form method="post" action="${escapeHtml(model.cancel_action)}"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><button class="action-button action-button-secondary" type="submit">Cancel selection</button></form>`;
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Review Work target · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Resources', { interactive: true, workspaceHref: '/projects', resourcesHref: model.back_href, settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Work target', project: model.project })}<main class="page work-target-page"><div class="page-intro"><div><span class="eyebrow">WORK TARGET</span><h1>Review where this Work goes</h1><p class="lede">The selected files stay temporary until you choose a target.</p></div><a class="action-button action-button-secondary" href="${escapeHtml(model.back_href)}">Back to Resources</a></div>${model.notice ? `<p class="callout warn">${escapeHtml(model.notice)}</p>` : ''}<section class="surface work-target-selection"><div><span class="eyebrow">SELECTED FILES</span><h2>${escapeHtml(selection.count)} files</h2>${selection.origin_label ? `<p class="muted">From ${escapeHtml(selection.origin_label)}</p>` : ''}</div>${selectedResources(selection)}</section><section class="surface work-target-new"><div><span class="eyebrow">NEW WORK</span><h2>Start a new Work</h2><p>Atlas will use exactly the selected files for a new Work.</p></div>${startNew}</section><section class="work-target-existing-list" aria-labelledby="work-target-existing-title"><div class="section-heading"><div><span class="eyebrow">EXISTING WORK</span><h2 id="work-target-existing-title">Update a named Work</h2><p class="muted">Choose one Work explicitly. No recent or Home item is preselected.</p></div></div>${works.length ? works.map((work) => updateWorkForm(model, work)).join('') : '<p class="surface muted">No compatible existing Work is available for these files.</p>'}</section><div class="inline-actions">${cancel}<a class="text-link" href="${escapeHtml(model.back_href)}">Return to Resources</a></div></main></div></div></body></html>`;
}
