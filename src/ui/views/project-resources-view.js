import { escapeHtml, renderFacts, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function size(bytes) {
  if (!Number.isFinite(bytes)) return 'Not available';
  if (bytes < 1024) return `${bytes} bytes`;
  return `${(bytes / 1024).toFixed(bytes < 1024 * 1024 ? 1 : 2)} ${bytes < 1024 * 1024 ? 'KB' : 'MB'}`;
}

function time(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Not available' : date.toLocaleString();
}

function detailHref(model, resource) {
  return `${model.base}/resources/detail?path=${encodeURIComponent(resource.relative_path)}`;
}

function resourceHref(model, resource) {
  return `${model.base}/resources?path=${encodeURIComponent(resource.relative_path)}`;
}

function lastWorked(resource) {
  return resource.last_worked_at ? time(resource.last_worked_at) : 'Not yet worked in Atlas';
}

function fileRow(model, resource, focused) {
  const stateLabels = { changed: 'Changed since Atlas last used it', missing: 'Recorded file is missing', unchanged: 'Unchanged since Atlas last used it', running: 'Atlas or a Host is working with this resource', waiting: 'This resource is waiting for a decision', failed: resource.activity?.error_message || 'Work with this resource stopped' };
  const state = resource.state ? `<span class="workspace-tree-state workspace-tree-state-${escapeHtml(resource.state)}" title="${escapeHtml(stateLabels[resource.state] ?? resource.state)}"><span class="workspace-tree-state-dot" aria-hidden="true"></span><span class="workspace-tree-state-label">${escapeHtml(resource.state)}</span></span>` : '';
  const category = resource.saved_work ? 'Created result' : resource.added_from ? 'Added to Project' : 'Project file';
  const relationshipText = resource.saved_work?.source_path ? `Created from ${resource.saved_work.source_path.split(/[\\/]/u).pop()}` : resource.added_from?.origin_file ? `Added from ${resource.added_from.origin_file.split(/[\\/]/u).pop()}` : 'No recorded relationship';
  const stateText = stateLabels[resource.state] ?? 'No change state recorded';
  return `<a class="workspace-resource-file${focused ? ' is-focused' : ''}" href="${escapeHtml(resourceHref(model, resource))}" data-resource-path="${escapeHtml(resource.relative_path)}"${focused ? ' data-focused-resource tabindex="-1"' : ''} data-open-resource data-resource-context data-context-title="${escapeHtml(resource.name)}" data-context-body="${escapeHtml(`${category} · ${stateText} · ${relationshipText}`)}"><span class="workspace-resource-file-name"><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(category)}</small></span><span class="workspace-resource-file-type">${escapeHtml(resource.type)}</span><time datetime="${escapeHtml(resource.modified_at)}">${escapeHtml(lastWorked(resource))}</time>${state}</a>`;
}

function folderContainsPath(folder, focusedPath) {
  if (!focusedPath) return false;
  return folder.files.some((resource) => resource.relative_path === focusedPath)
    || folder.folders.some((child) => folderContainsPath(child, focusedPath));
}

function treeFolder(model, folder, depth, focusedPath) {
  const children = folder.folders.map((child) => treeFolder(model, child, depth + 1, focusedPath)).join('');
  const open = folderContainsPath(folder, focusedPath);
  const href = `${model.base}/resources?folder=${encodeURIComponent(folder.relative_path)}`;
  return `<div class="workspace-tree-folder"><details data-project-folder data-folder-path="${escapeHtml(folder.relative_path ?? '')}"${open ? ' open' : ''}><summary class="workspace-tree-folder-row" style="--tree-depth:${depth}" data-folder-select data-folder-path="${escapeHtml(folder.relative_path)}" data-folder-href="${escapeHtml(href)}"><span>${escapeHtml(folder.name)}</span></summary><div class="workspace-tree-folder-children">${children}</div></details></div>`;
}

function folderFileGroups(model, node, folderPath = '') {
  const selected = folderPath === model.selected_folder_path;
  const label = folderPath || 'Project root';
  const files = node.files.length
    ? node.files.map((resource) => fileRow(model, resource, resource.relative_path === model.focused_resource?.relative_path)).join('')
    : '<p class="workspace-empty">No visible regular files are in this folder.</p>';
  const current = `<section class="workspace-folder-files" data-folder-files="${escapeHtml(folderPath)}"${selected ? '' : ' hidden'}><div class="workspace-resource-columns"><span>Name</span><span>Type</span><span>Last used</span><span>State</span></div>${files}</section>`;
  return `${current}${node.folders.map((folder) => folderFileGroups(model, folder, folder.relative_path)).join('')}`;
}

function relationship(resource) {
  const input = resource.saved_work?.source_path ?? resource.added_from?.origin_file ?? null;
  const downstream = resource.created_work?.[0] ?? null;
  const nodes = [input ? { name: input.split(/[\\/]/u).pop(), label: resource.saved_work ? 'Created from' : 'Added from' } : null, { name: resource.name, label: 'Selected resource' }, downstream ? { name: downstream.name, label: 'Created work' } : null].filter(Boolean);
  return `<section class="workspace-relationship"><h3>Known relationships</h3>${nodes.length > 1 ? `<div class="workspace-relationship-route">${nodes.map((node, index) => `${index ? '<span class="workspace-route-arrow" aria-hidden="true">→</span>' : ''}<div><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(node.label)}</small></div>`).join('')}</div>` : '<p class="muted">Atlas has not recorded a relationship for this file.</p>'}</section>`;
}

function representation(resource) {
  if (!resource.representation) return 'No local representation has been prepared.';
  return [resource.representation.label, ...(resource.representation.facts ?? [])].filter(Boolean).join(' · ');
}

function currentState(resource) {
  const labels = { changed: 'Changed since Atlas last used it', missing: 'Recorded file is missing', running: 'In progress', waiting: 'Waiting for a decision', failed: resource.activity?.error_message || 'Work with this resource stopped', unchanged: 'Unchanged since Atlas last used it' };
  return resource.state ? labels[resource.state] ?? resource.state : null;
}

function focusPanel(model, csrfToken) {
  const resource = model.focused_resource;
  if (!resource) return '<aside class="workspace-focus" data-resource-inspector><span class="workspace-kicker">Selected resource</span><h2>Choose a resource</h2><p>Select a file from the current folder to see its known local facts and open it with its default app.</p></aside>';
  const location = resource.relative_path.split('/').slice(0, -1).join('/') || 'Project root';
  const source = resource.saved_work?.source_path ? resource.saved_work.source_path.split(/[\\/]/u).pop() : resource.added_from?.origin_file?.split(/[\\/]/u).pop();
  const state = currentState(resource);
  const inspectedBy = resource.work?.initiated_by?.channel === 'host'
    ? resource.work.initiated_by.agent || 'Execution Host'
    : resource.work?.initiated_by?.channel === 'desktop' ? 'Atlas Desktop' : null;
  return `<aside class="workspace-focus" data-resource-inspector><span class="workspace-kicker">Selected resource</span><h2>${escapeHtml(resource.name)}</h2><dl><dt>Project</dt><dd>${escapeHtml(model.project.name)}</dd><dt>Type</dt><dd>${escapeHtml(resource.type)}</dd><dt>Stored in</dt><dd>${escapeHtml(location)}</dd>${state ? `<dt>Current state</dt><dd>${escapeHtml(state)}</dd>` : ''}<dt>Representation</dt><dd>${escapeHtml(representation(resource))}</dd>${source ? `<dt>${resource.saved_work ? 'Created from' : 'Added from'}</dt><dd>${escapeHtml(source)}</dd>` : ''}${inspectedBy ? `<dt>Last read by</dt><dd>${escapeHtml(inspectedBy)}</dd>` : ''}${resource.last_worked_at ? `<dt>Recent activity</dt><dd>${escapeHtml(time(resource.last_worked_at))}</dd>` : ''}</dl><div class="workspace-focus-actions"><form method="post" action="${escapeHtml(`${model.base}/resources/open`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><button class="action-button action-button-secondary" type="submit">Open in default app</button></form>${model.activity_return_href ? `<a class="action-button action-button-secondary" href="${escapeHtml(model.activity_return_href)}">Back to Activity</a>` : ''}</div>${relationship(resource)}</aside>`;
}

function explorer(model, csrfToken) {
  const focusedPath = model.focused_resource?.relative_path ?? null;
  const resourceTree = model.tree ?? { folders: [], files: [] };
  const tree = resourceTree.folders.length
    ? resourceTree.folders.map((folder) => treeFolder(model, folder, 0, focusedPath)).join('')
    : '<p class="workspace-empty">No folders with visible regular files are available.</p>';
  const selectedFolderLabel = model.selected_folder_path || 'Project root';
  const rootSelected = model.selected_folder_path === '';
  const fileGroups = folderFileGroups(model, resourceTree);
  const missing = model.missing_sources ?? [];
  return `<main class="workspace-visibility-page workspace-resource-page"><header class="workspace-resource-header"><div><span class="workspace-kicker">Project / ${escapeHtml(model.project.name)}</span><h1>Resources</h1></div><p>Find a folder, choose a file, and keep its known context beside the work.</p><button class="action-button action-button-secondary workspace-file-list-toggle" type="button" data-resource-list-toggle aria-controls="project-resource-file-list" aria-expanded="true">Hide file list</button></header>${model.focus_error ? `<p class="callout warn">${escapeHtml(model.focus_error)}</p>` : ''}<div class="workspace-resource-grid" data-resource-workspace data-project-id="${escapeHtml(model.project.id)}" data-project-base="${escapeHtml(model.base)}" data-selected-folder="${escapeHtml(model.selected_folder_path)}" data-selected-folder-explicit="${model.selected_folder_explicit ? 'true' : 'false'}"><section class="workspace-folder-navigator" data-folder-navigator><div class="workspace-pane-heading"><div><span class="workspace-kicker">Folder navigator</span></div><button class="workspace-text-button" type="button" data-collapse-all-folders>Collapse all</button></div><div class="workspace-folder-scroll"><div class="workspace-tree-root" data-resource-tree data-project-id="${escapeHtml(model.project.id)}"${model.focused_resource ? ` data-focus-path="${escapeHtml(model.focused_resource.relative_path)}"` : ''} data-open-action="${escapeHtml(`${model.base}/resources/open`)}" data-csrf="${escapeHtml(csrfToken ?? '')}"><a class="workspace-tree-root-row${rootSelected ? ' is-selected' : ''}" href="${escapeHtml(`${model.base}/resources?folder=`)}" data-folder-select data-folder-path=""><strong>${escapeHtml(model.project.name)}</strong><small>Project root</small></a>${tree}</div>${model.saved_work_error ? '<p class="callout warn">Created results could not be loaded. Project files remain available.</p>' : ''}${model.truncated ? '<p class="workspace-note">Only the first matching Project files are visible. Browse the folder to see more.</p>' : ''}${missing.length ? `<section class="workspace-missing"><h3>Missing trace</h3>${missing.map((item) => `<p><strong>${escapeHtml(item.name)}</strong><span>Atlas remembers this file, but it is no longer at:</span><small class="mono">${escapeHtml(item.source_path ?? '')}</small></p>`).join('')}</section>` : ''}</div><a class="workspace-pane-footer-link" href="${model.base}/files">Browse folder</a></section><section class="workspace-resource-list" id="project-resource-file-list" data-resource-file-list><div class="workspace-pane-heading"><div><span class="workspace-kicker">Files in <strong data-selected-folder-label>${escapeHtml(selectedFolderLabel)}</strong></span></div></div><div class="workspace-resource-list-scroll">${fileGroups}</div></section>${focusPanel(model, csrfToken)}</div><div class="resource-context-card" popover="manual" data-resource-context-card><strong data-resource-context-title></strong><p data-resource-context-body></p><small>Open a resource in the workspace for known facts.</small></div></main>`;
}

function detail(model, csrfToken) {
  const resource = model.resource;
  const location = resource.relative_path.split('/').slice(0, -1).join('/') || 'Project root';
  const identity = resource.saved_work ? 'Created result' : resource.added_from ? 'Added to Project' : 'Project file';
  const facts = [
    ['What', `${resource.type} · ${identity}`],
    ['Stored in', location],
    ['Last worked', lastWorked(resource)],
  ];
  if (resource.work) {
    if (resource.work.source_status) facts.push(['Current state', resource.work.source_status]);
    if (resource.work.initiated_by?.channel === 'host') {
      facts.push(['Last inspected by', resource.work.initiated_by.agent || 'Execution Host']);
    } else if (resource.work.initiated_by?.channel === 'desktop') {
      facts.push(['Last inspected by', 'Atlas Desktop']);
    }
    if (resource.work.result_summary?.label) facts.push(['Known result', resource.work.result_summary.label]);
  }
  if (resource.added_from) {
    facts.push(['Added from', resource.added_from.origin_file, true]);
  }
  if (resource.saved_work) {
    const parameters = resource.saved_work.parameters ?? {};
    facts.push(['Created from', resource.saved_work.source_path, true]);
    facts.push(['Source status', resource.saved_work.source_status]);
  }
  const created = resource.created_work?.length ? `<section class="surface"><h2>Used by</h2><p class="muted">Atlas recorded this file as an input to these saved results.</p><ul class="path-list">${resource.created_work.map((item) => `<li><a class="text-link" href="${escapeHtml(detailHref(model, item))}">${escapeHtml(item.name)}</a></li>`).join('')}</ul></section>` : '';
  const dataAction = ['CSV', 'XLSX'].includes(resource.type) ? `<a class="action-button" href="${model.base}/data-work?path=${encodeURIComponent(resource.relative_path)}">Work with data</a>` : '';
  const undo = resource.saved_work?.undo_available ? `<form method="post" action="/data-work/undo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(resource.saved_work.work_id)}"><input type="hidden" name="project_id" value="${escapeHtml(model.project.id)}"><button class="action-button action-button-secondary">Undo</button></form>` : '';
  const technical = `<details class="surface technical-details"><summary>Technical file details</summary>${renderFacts([['Exact path', resource.relative_path, true], ['Size', size(resource.bytes)], ['Modified on disk', time(resource.modified_at)], ...(resource.work ? [['Read purpose', resource.work.sheet ? `Sheet: ${resource.work.sheet}` : resource.work.purpose], ['Last read', time(resource.work.inspected_at)]] : []), ...(resource.saved_work ? [['Filters', (resource.saved_work.parameters?.filters ?? []).map((item) => `${item.column} ${item.operator}${item.value == null ? '' : ` ${item.value}`}`).join(' · ') || 'None'], ['Sort', resource.saved_work.parameters?.sort ? `${resource.saved_work.parameters.sort.column} ${resource.saved_work.parameters.sort.direction}` : 'None']] : [])])}</details>`;
  return `<div class="page-intro"><div><span class="eyebrow">PROJECT FILE</span><h1>${escapeHtml(resource.name)}</h1><p class="lede">Where it is, what Atlas knows, and what you can do next.</p></div><div class="inline-actions"><form method="post" action="${model.base}/files/open"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><button class="action-button action-button-secondary" type="submit">Open in default app</button></form>${dataAction}${undo}<a class="action-button action-button-secondary" href="${model.base}/resources?path=${encodeURIComponent(resource.relative_path)}">Back to Folder View</a><a class="action-button action-button-secondary" href="${model.base}/files?dir=${encodeURIComponent(resource.relative_path.split('/').slice(0, -1).join('/'))}">Browse folder</a></div></div><section class="surface">${renderFacts(facts)}</section>${created}${technical}`;
}

export function renderProjectResourcesView(model, options = {}) {
  const body = model.mode === 'detail' ? detail(model, options.csrfToken) : explorer(model, options.csrfToken);
  const main = model.mode === 'detail' ? `<main class="page">${body}</main>` : body;
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(model.project.name)} Resources · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="atlas-workspace-body"><div class="app-shell atlas-workspace-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Resources', { interactive: true, workspaceHref: '/projects', resourcesHref: `${model.base}/resources`, settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Resources', project: model.project, resource: model.mode === 'detail' ? model.resource?.relative_path : model.selected_path })}${main}</div></div></body></html>`;
}
