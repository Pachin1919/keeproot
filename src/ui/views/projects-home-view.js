import { escapeHtml, renderFacts, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function returnInputs(model) {
  return `${model.return_work_id ? `<input type="hidden" name="return_work_id" value="${escapeHtml(model.return_work_id)}">` : ''}${model.return_batch_id ? `<input type="hidden" name="return_batch_id" value="${escapeHtml(model.return_batch_id)}">` : ''}${model.return_data_work_id ? `<input type="hidden" name="return_data_work_id" value="${escapeHtml(model.return_data_work_id)}">` : ''}`;
}

function projectLetter(name) {
  return Array.from(String(name ?? '').trim())[0]?.toUpperCase() ?? '?';
}

function renderRecentProjectFacts(project) {
  const resourceName = project.recent_resource?.name;
  return `${resourceName ? `<div class="projects-home-recent"><span>Recent resource</span><strong>${escapeHtml(resourceName)}</strong></div>` : ''}${project.recent_activity_text ? `<div class="projects-home-recent"><span>Recent activity</span><strong>${escapeHtml(project.recent_activity_text)}</strong></div>` : ''}`;
}

function renderProjectRow(project) {
  const name = String(project.name ?? 'Untitled Project');
  const searchText = `${name} ${project.recent_resource?.name ?? ''} ${project.recent_activity_text ?? ''}`.trim();
  const issue = project.folder_issue ? `<small class="projects-home-issue">${escapeHtml(project.folder_issue)}</small>` : '';
  const unavailableDetails = !project.folder_available
    ? `<small class="projects-home-folder">${escapeHtml(project.folder_display ?? project.folder ?? '')}</small>${issue}<span class="inline-actions">${project.relink_href ? `<a class="text-link projects-home-relink" href="${escapeHtml(project.relink_href)}">Relink</a>` : ''}${project.remove_href ? `<a class="text-link" href="${escapeHtml(project.remove_href)}">Remove from Atlas</a>` : ''}</span>`
    : '';
  const rowContent = `<span class="projects-home-badge" aria-hidden="true">${escapeHtml(projectLetter(name))}</span><span class="projects-home-row-copy"><strong>${escapeHtml(name)}</strong>${project.folder_available ? renderRecentProjectFacts(project) : unavailableDetails}</span><span class="projects-home-state ${project.folder_available ? 'is-available' : 'is-unavailable'}">${project.folder_available ? 'Available' : 'Folder unavailable'}</span>`;
  return project.folder_available
    ? `<a class="projects-home-row" data-project-search="${escapeHtml(searchText)}" href="/projects/${encodeURIComponent(String(project.id ?? ''))}/resources">${rowContent}</a>`
    : `<article class="projects-home-row is-unavailable" data-project-search="${escapeHtml(searchText)}">${rowContent}</article>`;
}

function renderProjectsContent(model, projects) {
  if (model.loading) return '<section class="surface projects-home-state-panel" aria-busy="true"><strong>Loading Projects</strong><p>Reading registered local Projects.</p></section>';
  if (model.error) return `<section class="surface projects-home-state-panel" role="alert"><strong>Projects unavailable</strong><p>${escapeHtml(model.error)}</p></section>`;
  if (!projects.length) return '<section class="surface projects-home-state-panel"><strong>No Projects yet</strong><p>Create a Project or add an existing local folder to begin.</p></section>';
  const selected = projects.find((project) => project.id === model.selected_project_id) ?? projects.find((project) => project.folder_available) ?? projects[0];
  const selectedName = String(selected.name ?? 'Untitled Project');
  const selectedUnavailable = !selected.folder_available;
  return `<div class="projects-home-layout"><section class="projects-home-list-panel" aria-labelledby="projects-list-title"><div class="projects-home-list-heading"><div><h2 id="projects-list-title">Local Projects</h2><p>Choose a Project to see its resources.</p></div><label class="projects-home-filter-label">Filter Projects<input type="search" data-project-filter placeholder="Filter Projects" autocomplete="off"></label></div><div class="projects-home-list">${projects.map(renderProjectRow).join('')}</div></section><aside class="surface projects-home-summary" aria-labelledby="projects-summary-title"><span class="eyebrow">CURRENT PROJECT</span><h2 id="projects-summary-title">${escapeHtml(selectedName)}</h2><span class="projects-home-state ${selectedUnavailable ? 'is-unavailable' : 'is-available'}">${selectedUnavailable ? 'Folder unavailable' : 'Available'}</span>${selectedUnavailable ? `<p class="projects-home-summary-issue">${escapeHtml(selected.folder_issue ?? '')}</p><p class="projects-home-folder">${escapeHtml(selected.folder_display ?? selected.folder ?? '')}</p><div class="inline-actions">${selected.relink_href ? `<a class="text-link" href="${escapeHtml(selected.relink_href)}">Relink folder</a>` : ''}${selected.remove_href ? `<a class="text-link" href="${escapeHtml(selected.remove_href)}">Remove from Atlas</a>` : ''}</div>` : renderRecentProjectFacts(selected)}</aside></div>`;
}

export function renderProjectsHomeView(model, options = {}) {
  const projects = model.projects ?? [];
  const actions = `<div class="inline-actions"><a class="action-button" href="/projects/new">New Project</a><a class="action-button action-button-secondary" href="/projects/add-existing">Add Existing Folder</a></div>`;
  const content = renderProjectsContent(model, projects);
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Atlas Projects</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Projects' })}<main class="page projects-home"><div class="page-intro"><div><span class="eyebrow">LOCAL PROJECTS</span><h1>Projects</h1><p class="lede">Keep ongoing local work together.</p></div>${!model.loading && !model.error ? actions : ''}</div>${model.notice ? `<section class="surface"><p class="callout warn">${escapeHtml(model.notice)}</p></section>` : ''}${content}</main></div></div></body></html>`;
}

export function renderProjectOnboardingView(model, options = {}) {
  const picker = options.desktop_picker_enabled ? ' data-requires-desktop-picker disabled' : ' disabled';
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken ?? '')}">`;
  const folderField = `<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id ?? '')}"><button type="button" class="action-button action-button-secondary" data-pick-folder${picker}>Choose folder</button><span class="muted" data-folder-selection-name>${escapeHtml(model.folder_name ?? '')}</span><p class="muted" data-folder-picker-notice aria-live="polite"></p>`;
  let body = '';
  if (model.mode === 'remove') {
    body = `<div class="page-intro"><div><span class="eyebrow">PROJECT RECORD</span><h1>Remove ${escapeHtml(model.project_name ?? 'Project')} from Atlas</h1><p class="lede">This removes the unavailable Project from Atlas lists. It does not delete any local files.</p></div></div><section class="surface"><p class="callout warn">Atlas will preserve the Project history. You can add the folder again later.</p><form method="post" action="/projects/${encodeURIComponent(String(model.project_id ?? ''))}/remove/confirm" class="inline-actions">${csrf}<button class="action-button action-button-danger" type="submit">Remove from Atlas</button><a class="action-button action-button-secondary" href="/projects">Cancel</a></form></section>`;
  } else if (model.mode === 'relink') {
    body = `<div class="page-intro"><div><span class="eyebrow">PROJECT RECOVERY</span><h1>Relink ${escapeHtml(model.project_name ?? 'Project')}</h1><p class="lede">Choose the moved Project folder. Atlas will verify its identity before changing the recorded location.</p></div></div><section class="surface"><p class="callout warn">Recorded folder: ${escapeHtml(model.previous_folder ?? 'Unavailable')}</p><form method="post" action="/projects/${encodeURIComponent(String(model.project_id ?? ''))}/relink/preview">${csrf}${folderField}<div class="inline-actions"><button class="action-button" type="submit">Review folder</button><a class="action-button action-button-secondary" href="/projects">Cancel</a></div></form></section>`;
  } else if (model.mode === 'relink-preview') {
    body = `<div class="page-intro"><div><span class="eyebrow">PROJECT RECOVERY</span><h1>Confirm Project folder</h1><p class="lede">Atlas will accept this location only if it matches the Project identity already on record.</p></div></div><section class="surface">${renderFacts([['Project', model.project_name], ['Recorded folder', model.previous_folder, true], ['Selected folder', model.folder, true]])}<form method="post" action="/projects/${encodeURIComponent(String(model.project_id ?? ''))}/relink/confirm" class="inline-actions">${csrf}<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id)}"><button class="action-button" type="submit">Relink Project</button><a class="action-button action-button-secondary" href="/projects">Cancel</a></form></section>`;
  } else if (model.mode === 'add-existing') {
    body = `<div class="page-intro"><div><span class="eyebrow">PROJECTS</span><h1>Add Existing Folder</h1><p class="lede">Choose a local folder that Atlas should treat as one Project.</p></div></div><section class="surface"><form method="post" action="/projects/add-existing/preview">${csrf}${returnInputs(model)}${folderField}<div class="inline-actions"><button class="action-button" type="submit">Continue</button><a class="action-button action-button-secondary" href="/projects">Back</a></div></form></section>`;
  } else if (model.mode === 'new') {
    body = `<div class="page-intro"><div><span class="eyebrow">PROJECTS</span><h1>New Project</h1><p class="lede">Choose a name and a parent folder. Atlas creates only the new local folder.</p></div></div><section class="surface"><form method="post" action="/projects/new/preview">${csrf}${returnInputs(model)}<label>Project name <input name="name" value="${escapeHtml(model.name ?? '')}" required maxlength="120"></label><label>Location</label>${folderField}<div class="inline-actions"><button class="action-button" type="submit">Continue</button><a class="action-button action-button-secondary" href="/projects">Back</a></div></form></section>`;
  } else if (model.mode === 'existing-preview') {
    body = `<div class="page-intro"><div><span class="eyebrow">PROJECTS</span><h1>Add Project</h1><p class="lede">Atlas will register this existing local folder. It will not change its files.</p></div></div><section class="surface">${renderFacts([['Folder', model.folder, true], ['Project name', model.name]])}<form method="post" action="/projects/add-existing/create" class="inline-actions">${csrf}${returnInputs(model)}<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id)}"><input type="hidden" name="name" value="${escapeHtml(model.name)}"><button class="action-button" type="submit">Add Project</button><a class="action-button action-button-secondary" href="/projects/add-existing">Back</a></form></section>`;
  } else if (model.mode === 'new-preview') {
    const facts = renderFacts([['Parent folder', model.folder, true], ['Project name', model.name], ['New folder', model.target, true]]);
    const existing = model.target_exists ? `<p class="callout warn">Folder already exists. Atlas will not overwrite it.</p><form method="post" action="/projects/new/use-existing" class="inline-actions">${csrf}${returnInputs(model)}<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id)}"><input type="hidden" name="name" value="${escapeHtml(model.name)}"><button class="action-button" type="submit">Use existing folder</button><a class="action-button action-button-secondary" href="/projects/new">Back</a></form>` : `<form method="post" action="/projects/new/create" class="inline-actions">${csrf}${returnInputs(model)}<input type="hidden" name="folder_selection_id" value="${escapeHtml(model.folder_selection_id)}"><input type="hidden" name="name" value="${escapeHtml(model.name)}"><button class="action-button" type="submit">Create Project</button><a class="action-button action-button-secondary" href="/projects/new">Back</a></form>`;
    body = `<div class="page-intro"><div><span class="eyebrow">PROJECTS</span><h1>Create Project</h1><p class="lede">Review the one local folder Atlas will create and register.</p></div></div><section class="surface">${facts}${existing}</section>`;
  }
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Atlas Projects</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref })}<div class="workspace"><main class="page">${body}</main></div></div></body></html>`;
}
