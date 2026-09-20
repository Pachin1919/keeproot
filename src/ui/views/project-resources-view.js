import { escapeHtml, renderFacts, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { projectResourceHref } from '../../resource-links.js';

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
  return projectResourceHref(model.base, resource.relative_path, resource.resource_id);
}

function temporaryResourceViewQuery(model, mode) {
  const view = model.resource_view;
  const config = view?.temporary_config ?? { scope: { path: model.selected_folder_path ?? '', extensions: [] }, filters: [], sort: [] };
  const scopePath = config.scope?.path ?? model.selected_folder_path ?? '';
  const nameFilter = config.filters?.find((item) => item.field === 'name' && item.operator === 'contains')?.value ?? '';
  const propertyFilter = config.filters?.find((item) => String(item.field).startsWith('property:'));
  const sort = config.sort?.[0] ?? { field: 'relative_path', direction: 'asc' };
  const query = new URLSearchParams({ mode, scope_path: scopePath });
  if (mode === 'files') query.set('folder', scopePath);
  if (config.scope?.extensions?.length) query.set('extensions', config.scope.extensions.join(', '));
  if (nameFilter) query.set('name_contains', nameFilter);
  if (propertyFilter) {
    query.set('property_filter_id', String(propertyFilter.field).slice('property:'.length));
    query.set('property_filter_operator', propertyFilter.operator ?? 'equals');
    query.set('property_filter_value', propertyFilter.value ?? '');
  }
  if (sort.field) query.set('sort_field', sort.field);
  if (sort.direction) query.set('sort_direction', sort.direction);
  if (config.group_by) query.set('group_by', config.group_by);
  if (config.visible_fields?.length) query.set('visible_fields', config.visible_fields.join(', '));
  return query;
}

function resourceViewModeHref(model, mode) {
  const query = model.resource_view?.active_view?.view_id
    ? new URLSearchParams({ mode, view: model.resource_view.active_view.view_id })
    : temporaryResourceViewQuery(model, mode);
  return `${model.base}/resources?${query}`;
}

function resourceViewControls(model, csrfToken) {
  const view = model.resource_view ?? {
    mode: 'files',
    saved_views: [],
    temporary_config: { scope: { path: model.selected_folder_path ?? '', extensions: [] }, filters: [], sort: [] },
  };
  const mode = ['files', 'table', 'cards'].includes(view.mode) ? view.mode : 'files';
  const saved = view.saved_views ?? [];
  const scopePath = view.active_view?.scope_path ?? model.selected_folder_path ?? '';
  const config = view.temporary_config ?? view.active_view?.config ?? { scope: { path: scopePath, extensions: [] }, filters: [], sort: [] };
  const nameFilter = config.filters?.find((item) => item.field === 'name' && item.operator === 'contains')?.value ?? '';
  const propertyFilter = config.filters?.find((item) => String(item.field).startsWith('property:')) ?? null;
  const propertyFilterId = propertyFilter?.field?.slice('property:'.length) ?? '';
  const sort = config.sort?.[0] ?? { field: 'relative_path', direction: 'asc' };
  const visibleFields = config.visible_fields ?? [];
  const groupOptions = (view.property_definitions ?? []).map((definition) => `<option value="property:${escapeHtml(definition.property_id)}"${config.group_by === `property:${definition.property_id}` ? ' selected' : ''}>${escapeHtml(definition.name)}</option>`).join('');
  const propertyFilterOptions = (view.property_definitions ?? []).map((definition) => `<option value="${escapeHtml(definition.property_id)}"${propertyFilterId === definition.property_id ? ' selected' : ''}>${escapeHtml(definition.name)}</option>`).join('');
  const propertyFilterControl = propertyFilterOptions ? `<label>Property filter <select name="property_filter_id"><option value="">No property filter</option>${propertyFilterOptions}</select></label><label>Match <select name="property_filter_operator"><option value="equals"${propertyFilter?.operator === 'equals' ? ' selected' : ''}>Equals</option><option value="contains"${propertyFilter?.operator === 'contains' ? ' selected' : ''}>Contains text</option><option value="includes"${propertyFilter?.operator === 'includes' ? ' selected' : ''}>Includes option</option><option value="is_empty"${propertyFilter?.operator === 'is_empty' ? ' selected' : ''}>Is empty</option></select></label><label>Property value <input name="property_filter_value" value="${escapeHtml(propertyFilter?.value ?? '')}"></label>` : '';
  const modes = ['files', 'table', 'cards'].map((entry) => `<a class="resource-view-mode${entry === mode ? ' is-active' : ''}" href="${escapeHtml(resourceViewModeHref(model, entry))}" data-resource-view-mode="${escapeHtml(entry)}"${entry === mode ? ' aria-current="page"' : ''}>${escapeHtml(entry[0].toUpperCase() + entry.slice(1))}</a>`).join('');
  const savedViews = saved.length ? `<nav class="resource-view-saved" aria-label="Saved Views"><span>Saved views</span>${saved.map((item) => `<a href="${escapeHtml(`${model.base}/resources?view=${encodeURIComponent(item.view_id)}`)}"${item.view_id === view.active_view?.view_id ? ' aria-current="page"' : ''}>${escapeHtml(item.name)}</a>`).join('')}</nav>` : '';
  const pin = view.active_view ? `<form method="post" action="${escapeHtml(`${model.base}/home/pins`)}" class="resource-view-pin"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="action" value="${view.active_view.pinned ? 'unpin' : 'pin'}"><input type="hidden" name="kind" value="view"><input type="hidden" name="id" value="${escapeHtml(view.active_view.view_id)}"><input type="hidden" name="return_to" value="${escapeHtml(`${model.base}/resources?view=${encodeURIComponent(view.active_view.view_id)}`)}"><button class="text-link" type="submit">${view.active_view.pinned ? 'Unpin from Home' : 'Pin to Home'}</button></form>` : '';
  const filesHref = resourceViewModeHref(model, 'files');
  const preview = `<form method="get" action="${escapeHtml(`${model.base}/resources`)}" class="resource-view-config"><input type="hidden" name="mode" value="${escapeHtml(mode)}">${view.active_view ? `<input type="hidden" name="view" value="${escapeHtml(view.active_view.view_id)}">` : ''}<div class="resource-view-scope"><strong>Current scope</strong><span data-resource-view-scope-label>${escapeHtml(config.scope?.path || 'Project root')}</span><a class="text-link" href="${escapeHtml(filesHref)}" data-resource-view-files-link>Choose a folder in Files</a></div><p class="resource-view-scope-help">Use a project-relative folder path here, or choose a folder from Files.</p><label>Folder path <input name="scope_path" value="${escapeHtml(config.scope?.path ?? scopePath)}" placeholder="Project root" data-resource-view-scope-input></label><label>Extensions <input name="extensions" value="${escapeHtml((config.scope?.extensions ?? []).join(', '))}" placeholder="pdf, md"></label><label>Name contains <input name="name_contains" value="${escapeHtml(nameFilter)}"></label>${propertyFilterControl}<label>Sort <select name="sort_field"><option value="relative_path"${sort.field === 'relative_path' ? ' selected' : ''}>Path</option><option value="name"${sort.field === 'name' ? ' selected' : ''}>Name</option><option value="modified_at"${sort.field === 'modified_at' ? ' selected' : ''}>Modified</option><option value="bytes"${sort.field === 'bytes' ? ' selected' : ''}>Size</option></select></label><label>Direction <select name="sort_direction"><option value="asc"${sort.direction !== 'desc' ? ' selected' : ''}>Ascending</option><option value="desc"${sort.direction === 'desc' ? ' selected' : ''}>Descending</option></select></label><label>Group <select name="group_by"><option value="">No grouping</option><option value="type"${config.group_by === 'type' ? ' selected' : ''}>File type</option>${groupOptions}</select></label><label>Visible fields <input name="visible_fields" value="${escapeHtml(visibleFields.join(', '))}" placeholder="Property names"></label><button class="action-button action-button-secondary" type="submit">Preview</button></form>`;
  const save = view.save_action ? `<form method="post" action="${escapeHtml(view.save_action)}" class="resource-view-save"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="view_id" value="${escapeHtml(view.active_view?.view_id ?? '')}"><input type="hidden" name="base_revision" value="${escapeHtml(view.active_view?.revision ?? '')}"><label>Name <input name="name" value="${escapeHtml(view.active_view?.name ?? '')}" required maxlength="120"></label><input type="hidden" name="mode" value="${escapeHtml(mode)}"><input type="hidden" name="scope_path" value="${escapeHtml(config.scope?.path ?? scopePath)}"><input type="hidden" name="extensions" value="${escapeHtml((config.scope?.extensions ?? []).join(','))}"><input type="hidden" name="name_contains" value="${escapeHtml(nameFilter)}"><input type="hidden" name="property_filter_id" value="${escapeHtml(propertyFilterId)}"><input type="hidden" name="property_filter_operator" value="${escapeHtml(propertyFilter?.operator ?? 'equals')}"><input type="hidden" name="property_filter_value" value="${escapeHtml(propertyFilter?.value ?? '')}"><input type="hidden" name="sort_field" value="${escapeHtml(sort.field)}"><input type="hidden" name="sort_direction" value="${escapeHtml(sort.direction)}"><input type="hidden" name="group_by" value="${escapeHtml(config.group_by ?? '')}"><input type="hidden" name="visible_fields" value="${escapeHtml(visibleFields.join(','))}"><button class="action-button action-button-secondary" type="submit">${view.active_view ? 'Update view' : 'Save view'}</button></form>` : '';
  return `<div class="resource-view-controls"><nav class="resource-view-modes" aria-label="Resource display">${modes}</nav>${savedViews}${pin}${save}<details class="resource-view-settings"><summary>View settings · ${escapeHtml(config.scope?.path || 'Project root')}</summary>${preview}</details></div>`;
}

function resourceViewReceipt(evaluation) {
  if (!evaluation) return '<p class="resource-view-receipt status-neutral">This view has not been evaluated yet.</p>';
  const counts = `${escapeHtml(evaluation.returned_count ?? 0)} returned`;
  const scopeLabel = (item) => typeof item === 'string' ? item : `${item?.path ?? 'unknown'}${item?.error ? ` (${item.error})` : ''}`;
  const unchecked = evaluation.unchecked_scopes ?? [];
  const failed = evaluation.failed_scopes ?? [];
  const issueCounts = [
    ...(unchecked.length ? [`Unchecked ${unchecked.length}`] : []),
    ...(failed.length ? [`Failed ${failed.length}`] : []),
  ];
  const copy = evaluation.completeness === 'complete'
    ? `${counts}. This evaluation is complete.`
    : evaluation.completeness === 'partial'
      ? `${counts}. This evaluation is partial${issueCounts.length ? `: ${issueCounts.join('; ')}.` : '.'}`
      : `${counts}. Atlas does not have a complete evaluation for this scope.`;
  const issueDetails = issueCounts.length
    ? `<details class="resource-view-issues" data-resource-view-issues><summary>Evaluation details</summary>${unchecked.length ? `<p><strong>Unchecked sample</strong> ${unchecked.slice(0, 3).map((item) => escapeHtml(scopeLabel(item))).join(' · ')}</p>` : ''}${failed.length ? `<p><strong>Failed sample</strong> ${failed.slice(0, 3).map((item) => escapeHtml(scopeLabel(item))).join(' · ')}</p>` : ''}</details>`
    : '';
  const showMore = evaluation.completeness === 'partial' && evaluation.more_href
    ? ` <a class="text-link" href="${escapeHtml(evaluation.more_href)}">Show more</a>`
    : '';
  return `<div class="resource-view-receipt status-${escapeHtml(evaluation.completeness ?? 'neutral')}"><p>${copy}${showMore}</p>${issueDetails}</div>`;
}

function resourceViewProperty(member, definition) {
  const resource = member.resource ?? member;
  const values = member.properties ?? member.property_values ?? resource.properties ?? resource.property_values ?? {};
  const stored = values[definition.property_id ?? definition.id ?? definition.name];
  const value = stored && typeof stored === 'object' && !Array.isArray(stored) && Object.hasOwn(stored, 'value') ? stored.value : stored;
  return Array.isArray(value) ? value.join(' · ') : value ?? '—';
}

function externalChangeStatus(resource, member = null) {
  return (member?.external_change ?? resource?.external_change ?? resource?.resource_fact?.external_change)?.status ?? null;
}

function externalChangeCopy(status) {
  return {
    changed: 'Changed outside Atlas',
    unchanged: 'No external change found',
    not_checked: 'External change not checked',
    missing: 'Recorded file is missing',
  }[status] ?? null;
}

function externalChange(resource, member = null) {
  const status = externalChangeStatus(resource, member);
  const copy = externalChangeCopy(status);
  if (!copy) return '';
  return `<p class="resource-external-change resource-external-change-${escapeHtml(status)}"><strong>File status:</strong> ${copy}</p>`;
}

function candidateValue(value) {
  if (Array.isArray(value)) return value.join(' · ');
  if (value == null) return 'No value';
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'Value unavailable';
}

function candidateInputValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function resourcePropertyCandidates(view, csrfToken, returnTo) {
  const candidates = view.property_candidates ?? [];
  const action = view.property_candidate_decision_action;
  if (!candidates.length || !action) return '';
  const decisionFields = (candidate, decision) => `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><input type="hidden" name="candidate_id" value="${escapeHtml(candidate.candidate_id)}"><input type="hidden" name="expected_revision" value="${escapeHtml(candidate.revision)}"><input type="hidden" name="expected_source_version" value="${escapeHtml(candidate.source_version)}"><input type="hidden" name="action" value="${decision}">`;
  const items = candidates.map((candidate) => {
    const status = candidate.status ?? 'pending';
    const host = [candidate.host?.tool, candidate.host?.model].filter(Boolean).join(' · ') || 'Host not recorded';
    const evidence = typeof candidate.evidence === 'string' && candidate.evidence.trim()
      ? `<p class="resource-property-candidate-evidence"><strong>Evidence</strong> ${escapeHtml(candidate.evidence)}</p>`
      : '';
    const canAccept = status === 'pending' && candidate.can_accept !== false;
    const accept = canAccept ? `<form method="post" action="${escapeHtml(action)}" class="resource-property-candidate-action">${decisionFields(candidate, 'accept')}<button class="action-button" type="submit">Accept</button></form>` : '';
    const edit = (status === 'pending' || status === 'needs_review')
      ? `<form method="post" action="${escapeHtml(action)}" class="resource-property-candidate-edit">${decisionFields(candidate, 'edit_accept')}<label>Edit proposed value <input name="value" value="${escapeHtml(candidateInputValue(candidate.value))}" required></label><button class="action-button action-button-secondary" type="submit">Edit and accept</button></form>`
      : '';
    const reject = (status === 'pending' || status === 'needs_review')
      ? `<form method="post" action="${escapeHtml(action)}" class="resource-property-candidate-action">${decisionFields(candidate, 'reject')}<button class="text-link" type="submit">Reject</button></form>`
      : '';
    return `<li class="resource-property-candidate status-${escapeHtml(status)}"><div class="resource-property-candidate-summary"><h3>${escapeHtml(candidate.resource_name ?? candidate.resource_id ?? 'Resource')}</h3><p><strong>${escapeHtml(candidate.property_name ?? 'Property')}</strong> · ${escapeHtml(candidate.property_kind ?? 'Value')}</p><p class="resource-property-candidate-value">${escapeHtml(candidateValue(candidate.value))}</p><p>Suggested by ${escapeHtml(host)} · ${escapeHtml(time(candidate.generated_at))}</p><p class="resource-property-candidate-status"><strong>Status:</strong> ${escapeHtml(status.replaceAll('_', ' '))}</p>${evidence}</div><div class="resource-property-candidate-actions">${accept}${edit}${reject}</div></li>`;
  }).join('');
  return `<section class="surface resource-property-candidates" aria-labelledby="suggested-properties-heading"><div><span class="eyebrow">REVIEW</span><h2 id="suggested-properties-heading">Suggested properties</h2><p class="muted">Suggestions do not change user properties until you accept one.</p></div><ul class="resource-property-candidate-list">${items}</ul></section>`;
}

function resourcePropertyCandidateHistory(view) {
  const candidates = (view.property_candidate_history ?? []).slice(0, 10);
  if (!candidates.length) return '';
  const decision = { accept: 'Accepted', edit_accept: 'Edited and accepted', reject: 'Rejected' };
  const application = { not_applied: 'Not applied', current: 'Current', superseded: 'Later changed', undone: 'Undone', unknown: 'Application state unavailable' };
  const source = { current: 'Source current', changed: 'Source changed', missing: 'Source missing', unknown: 'Source inspection unavailable' };
  const items = candidates.map((candidate) => {
    const action = candidate.decision?.action;
    const resource = candidate.desktop_href
      ? `<a class="text-link" href="${escapeHtml(candidate.desktop_href)}">${escapeHtml(candidate.resource_name ?? candidate.resource_id ?? 'Resource')}</a>`
      : escapeHtml(candidate.resource_name ?? candidate.resource_id ?? 'Resource');
    const actual = candidate.current_value == null ? 'No current formal value' : candidateValue(candidate.current_value.value);
    const applied = candidate.applied_value == null ? 'No accepted value recorded' : candidateValue(candidate.applied_value.value);
    return `<li class="resource-property-candidate"><div class="resource-property-candidate-summary"><h3>${resource}</h3><p><strong>${escapeHtml(candidate.property_name ?? 'Property')}</strong> · Suggested: ${escapeHtml(candidateValue(candidate.value))}</p><p><strong>Decision:</strong> ${escapeHtml(decision[action] ?? 'Decision not recorded')} · ${escapeHtml(application[candidate.application_status] ?? 'Application state unavailable')}</p><p><strong>Actual current value:</strong> ${escapeHtml(actual)}</p><p><strong>Accepted value:</strong> ${escapeHtml(applied)}</p><p><strong>Source:</strong> ${escapeHtml(source[candidate.source_status] ?? 'Source inspection unavailable')}</p></div></li>`;
  }).join('');
  return `<details class="surface resource-property-candidates" aria-label="Recent property decision history"><summary>Recent decision history (${escapeHtml(candidates.length)})</summary><ul class="resource-property-candidate-list">${items}</ul></details>`;
}

function resourceViewMember(model, member, csrfToken) {
  const resource = member.resource ?? member;
  const name = resource.name ?? resource.display_name ?? resource.relative_path ?? resource.resource_id ?? 'Resource';
  const type = resource.type ?? resource.extension ?? 'File';
  const href = resourceHref(model, resource);
  const open = resource.relative_path ? `<form method="post" action="${escapeHtml(`${model.base}/resources/open`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><button class="text-link" type="submit">Open</button></form>` : '';
  return { resource, name, type, href, open, externalChange: externalChange(resource, member) };
}

function resourceViewContent(model, csrfToken) {
  const view = model.resource_view;
  const members = view.members ?? [];
  const configuredFields = view.temporary_config?.visible_fields ?? view.active_view?.config?.visible_fields ?? [];
  const definitions = (view.property_definitions ?? []).filter((definition) => !configuredFields.length
    || configuredFields.includes(definition.property_id) || configuredFields.includes(definition.name));
  const mode = view.mode === 'cards' ? 'cards' : 'table';
  const rows = members.map((member) => resourceViewMember(model, member, csrfToken));
  const groupBy = view.temporary_config?.group_by ?? view.active_view?.config?.group_by ?? null;
  const groupValue = (member) => {
    const resource = member.resource ?? member;
    if (!groupBy) return null;
    if (groupBy === 'type') return resource.type ?? resource.extension ?? 'Other';
    if (groupBy === 'extension') return resource.extension || 'No extension';
    if (groupBy.startsWith('property:')) {
      const stored = (member.properties ?? resource.properties ?? {})[groupBy.slice('property:'.length)];
      const value = stored && typeof stored === 'object' && !Array.isArray(stored) && Object.hasOwn(stored, 'value') ? stored.value : stored;
      return Array.isArray(value) ? value.join(' · ') || 'No value' : value ?? 'No value';
    }
    return resource[groupBy] ?? 'Other';
  };
  const returnTo = resourceViewModeHref(model, mode);
  const propertyDefinition = view.property_define_action ? `<form method="post" action="${escapeHtml(view.property_define_action)}" class="resource-property-definition"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><label>Property name <input name="name" required maxlength="80"></label><label>Kind <select name="kind"><option value="text">Text</option><option value="single">Single select</option><option value="multi">Multi select</option></select></label><label>Options <input name="options" placeholder="For select: option one, option two"></label><button class="action-button action-button-secondary" type="submit">Add property</button></form>` : '';
  const expectedVersions = Object.fromEntries(members.map((member) => {
    const resource = member.resource ?? member;
    const values = member.properties ?? member.property_values ?? resource.properties ?? {};
    return [resource.resource_id, Object.fromEntries(Object.entries(values).map(([propertyId, stored]) => [propertyId, stored?.revision ?? 0]))];
  }));
  const propertyEdit = view.property_apply_action && definitions.length && members.length ? `<form id="resource-property-batch" method="post" action="${escapeHtml(view.property_apply_action)}" class="resource-property-batch"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><input type="hidden" name="expected_versions" value="${escapeHtml(JSON.stringify(expectedVersions))}"><label>Property <select name="property_id" required>${definitions.map((definition) => `<option value="${escapeHtml(definition.property_id)}">${escapeHtml(definition.name)}</option>`).join('')}</select></label><label>Change <select name="operation"><option value="replace">Replace</option><option value="add">Add</option><option value="remove">Remove</option></select></label><label>Value <input name="value" placeholder="Separate multiple values with commas"></label><button class="action-button" type="submit">Apply to selected</button></form>` : '';
  const undo = view.property_undo?.batch_id && view.property_undo_action ? `<form method="post" action="${escapeHtml(view.property_undo_action)}" class="resource-property-undo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="batch_id" value="${escapeHtml(view.property_undo.batch_id)}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button class="text-link" type="submit">Undo last property change</button></form>` : '';
  const propertyCandidates = resourcePropertyCandidates(view, csrfToken, returnTo);
  const propertyCandidateHistory = resourcePropertyCandidateHistory(view);
  const clearFiltersHref = `${model.base}/resources?mode=${encodeURIComponent(mode)}`;
  const showAllHref = `${model.base}/resources?mode=${encodeURIComponent(mode)}&scope_path=.`;
  const empty = `<p class="resource-view-empty">No Resources were returned for this evaluation.</p><div class="resource-view-empty-actions" data-resource-view-empty-actions><a class="text-link" data-resource-view-clear-filters data-resource-property-empty-action href="${escapeHtml(clearFiltersHref)}" tabindex="0">Clear current filters</a><a class="text-link" data-resource-view-show-all href="${escapeHtml(showAllHref)}" tabindex="0">Show all Resources</a></div>`;
  let previousGroup = Symbol('first');
  const tableRows = rows.map(({ resource, name, type, href, open }, index) => {
    const currentGroup = groupValue(members[index]);
    const heading = groupBy && currentGroup !== previousGroup
      ? `<tr class="resource-view-group"><th colspan="${5 + definitions.length}">${escapeHtml(currentGroup)}</th></tr>` : '';
    previousGroup = currentGroup;
    return `${heading}<tr data-resource-property-focus="${escapeHtml(resource.resource_id)}"><td>${workSelectionControl(model, resource)}</td><td><input form="resource-property-batch" type="checkbox" name="resource_id" value="${escapeHtml(resource.resource_id)}" aria-label="Select ${escapeHtml(name)} for user properties"></td><td><a class="text-link" href="${escapeHtml(href)}">${escapeHtml(name)}</a><small>${escapeHtml(resource.relative_path ?? '')}</small></td><td>${escapeHtml(type)}</td>${definitions.map((definition) => `<td>${escapeHtml(resourceViewProperty(members[index], definition))}</td>`).join('')}<td>${rows[index].externalChange}</td><td>${open}</td></tr>`;
  }).join('');
  const cardGroups = [];
  rows.forEach((row, index) => {
    const key = String(groupValue(members[index]) ?? '');
    let group = cardGroups.at(-1);
    if (!group || group.key !== key) { group = { key, rows: [] }; cardGroups.push(group); }
    group.rows.push({ ...row, propertyFacts: definitions.map((definition) => [definition.name, resourceViewProperty(members[index], definition)]).filter(([, value]) => value !== '—') });
  });
  const cards = cardGroups.map((group) => `${groupBy ? `<h3 class="resource-view-group-title">${escapeHtml(group.key)}</h3>` : ''}<div class="resource-view-cards">${group.rows.map(({ resource, name, type, href, open, propertyFacts, externalChange: change }) => `<article class="resource-view-card" data-resource-property-focus="${escapeHtml(resource.resource_id)}">${workSelectionControl(model, resource)}<label class="resource-view-select"><input form="resource-property-batch" type="checkbox" name="resource_id" value="${escapeHtml(resource.resource_id)}"> Select for user properties</label>${resource.thumbnail_href ? `<img src="${escapeHtml(resource.thumbnail_href)}" alt="">` : `<span class="resource-view-filetype" aria-label="${escapeHtml(type)} file">${escapeHtml(type)}</span>`}<div><a class="resource-view-member-link" href="${escapeHtml(href)}"><strong>${escapeHtml(name)}</strong></a><small>${escapeHtml(resource.relative_path ?? type)}</small></div>${propertyFacts.length ? `<dl class="resource-card-properties">${propertyFacts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>` : ''}${change}<div class="inline-actions">${open}</div></article>`).join('')}</div>`).join('');
  const content = mode === 'cards'
    ? rows.length ? cards : empty
    : rows.length ? `<div class="resource-view-table-wrap"><table class="resource-view-table"><thead><tr><th>Work</th><th>User properties</th><th>Resource</th><th>Type</th>${definitions.map((definition) => `<th>${escapeHtml(definition.name ?? definition.property_id ?? 'Property')}</th>`).join('')}<th>File status</th><th>Open</th></tr></thead><tbody>${tableRows}</tbody></table></div>` : empty;
  return `<main class="page resource-view-page" data-work-selection-context data-project-base="${escapeHtml(model.base)}" data-csrf="${escapeHtml(csrfToken ?? '')}" data-selected-folder="${escapeHtml(model.selected_folder_path ?? '')}" data-focus-path="${escapeHtml(model.focused_resource?.relative_path ?? '')}" data-active-view-id="${escapeHtml(view.active_view?.view_id ?? '')}"><div class="page-intro"><div><span class="eyebrow">PROJECT RESOURCES</span><h1>${mode === 'cards' ? 'Resource cards' : 'Resource table'}</h1><p class="lede">${view.active_view ? escapeHtml(view.active_view.name) : 'Current dynamic Project scope'}</p></div></div>${workSelectionBar(model)}${resourceViewControls(model, csrfToken)}${resourceViewReceipt(view.evaluation)}${propertyCandidates}${propertyCandidateHistory}<details class="surface resource-property-tools"><summary>User properties · add or edit</summary>${propertyDefinition}${propertyEdit}${undo}</details><section class="surface resource-view-results">${content}</section></main>`;
}

function resourcePinControl(model, resource, csrfToken) {
  if (!resource?.relative_path) return '';
  const id = resource.resource_id ?? `path:${resource.relative_path}`;
  const action = resource.pinned ? 'unpin' : 'pin';
  const returnTo = resourceHref(model, resource);
  return `<form method="post" action="${escapeHtml(`${model.base}/home/pins`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="action" value="${escapeHtml(action)}"><input type="hidden" name="kind" value="resource"><input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button class="action-button action-button-secondary" type="submit">${resource.pinned ? 'Unpin from Home' : 'Pin to Home'}</button></form>`;
}

function lastWorked(resource) {
  return resource.last_worked_at ? time(resource.last_worked_at) : 'Not yet worked in Atlas';
}

function workSelectionControl(model, resource) {
  const workType = String(resource?.type ?? resource?.extension ?? '').replace(/^\./u, '').toUpperCase();
  if (!resource?.resource_id || !resource.relative_path || !['CSV', 'XLSX'].includes(workType)) return '';
  const selected = (model.work_selection?.resource_ids ?? []).includes(resource.resource_id);
  return `<label class="workspace-work-source" title="${selected ? 'Remove from temporary Work selection' : 'Add to temporary Work selection'}"><input type="checkbox" data-work-source data-resource-id="${escapeHtml(resource.resource_id)}" data-resource-path="${escapeHtml(resource.relative_path)}" ${selected ? 'checked' : ''}><span class="sr-only">${selected ? 'Remove' : 'Add'} ${escapeHtml(resource.name)} ${selected ? 'from' : 'to'} temporary Work selection</span></label>`;
}

function workSelectionBar(model) {
  const count = model.work_selection?.count ?? 0;
  const workHref = model.work_selection?.review_href ?? '';
  return `<div class="workspace-work-selection"><strong data-work-source-count>Selected ${escapeHtml(count)} files</strong><a class="action-button${count ? '' : ' is-disabled'}" data-work-open href="${escapeHtml(workHref || '#')}" aria-disabled="${count ? 'false' : 'true'}">Review Work target</a><span class="muted" data-work-source-notice></span></div>`;
}

function fileRow(model, resource, focused) {
  const stateLabels = { changed: 'Changed since Atlas last used it', missing: 'Recorded file is missing', unchanged: 'Unchanged since Atlas last used it', running: 'Atlas or a Host is working with this resource', waiting: 'This resource is waiting for a decision', failed: resource.activity?.error_message || 'Work with this resource stopped' };
  const externalStatus = externalChangeStatus(resource);
  const displayState = externalStatus ?? resource.state;
  const stateLabel = externalChangeCopy(externalStatus) ?? stateLabels[displayState] ?? displayState;
  const state = displayState ? `<span class="workspace-tree-state workspace-tree-state-${escapeHtml(displayState)}" title="${escapeHtml(stateLabel)}"><span class="workspace-tree-state-dot" aria-hidden="true"></span><span class="workspace-tree-state-label">${escapeHtml(stateLabel)}</span></span>` : '';
  const category = resource.saved_work ? 'Created result' : resource.added_from ? 'Added to Project' : 'Project file';
  const relationshipText = resource.saved_work?.source_path ? `Created from ${resource.saved_work.source_path.split(/[\\/]/u).pop()}` : resource.added_from?.origin_file ? `Added from ${resource.added_from.origin_file.split(/[\\/]/u).pop()}` : 'No recorded relationship';
  const stateText = stateLabel ?? 'No change state recorded';
  const selector = workSelectionControl(model, resource) || '<span class="workspace-work-source workspace-work-source-disabled" title="Work supports CSV and XLSX"></span>';
  return `<div class="workspace-resource-file-row" data-resource-row data-resource-name="${escapeHtml(resource.name)}">${selector}<a class="workspace-resource-file${focused ? ' is-focused' : ''}" href="${escapeHtml(resourceHref(model, resource))}" data-resource-path="${escapeHtml(resource.relative_path)}" data-resource-name="${escapeHtml(resource.name)}"${focused ? ' data-focused-resource tabindex="-1"' : ''} data-open-resource data-resource-context data-context-title="${escapeHtml(resource.name)}" data-context-body="${escapeHtml(`${category} · ${stateText} · ${relationshipText}`)}"><span class="workspace-resource-file-name"><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(category)}</small></span><span class="workspace-resource-file-type">${escapeHtml(resource.type)}</span><time datetime="${escapeHtml(resource.modified_at)}">${escapeHtml(lastWorked(resource))}</time>${state}</a></div>`;
}

function folderContainsPath(folder, focusedPath) {
  if (!focusedPath) return false;
  return folder.files.some((resource) => resource.relative_path === focusedPath)
    || folder.folders.some((child) => folderContainsPath(child, focusedPath));
}

function treeFolder(model, folder, depth, focusedPath) {
  const children = folder.folders.map((child) => treeFolder(model, child, depth + 1, focusedPath)).join('');
  if (!folder.folders.length) {
    return `<div class="workspace-tree-folder"><a class="workspace-tree-folder-row workspace-tree-folder-leaf" href="${escapeHtml(`${model.base}/resources?folder=${encodeURIComponent(folder.relative_path)}`)}" style="--tree-depth:${depth}" data-folder-select data-folder-path="${escapeHtml(folder.relative_path)}" title="Select this folder"><span>${escapeHtml(folder.name)}</span></a></div>`;
  }
  const open = folderContainsPath(folder, focusedPath);
  return `<div class="workspace-tree-folder" data-project-folder data-folder-path="${escapeHtml(folder.relative_path ?? '')}" data-folder-open="${open ? 'true' : 'false'}"><button class="workspace-tree-folder-toggle" type="button" style="--tree-depth:${depth}" data-folder-toggle aria-expanded="${open ? 'true' : 'false'}" aria-label="${open ? 'Collapse' : 'Expand'} ${escapeHtml(folder.name)}"></button><a class="workspace-tree-folder-row" href="${escapeHtml(`${model.base}/resources?folder=${encodeURIComponent(folder.relative_path)}`)}" style="--tree-depth:${depth}" data-folder-select data-folder-path="${escapeHtml(folder.relative_path)}" title="Select this folder"><span>${escapeHtml(folder.name)}</span></a><div class="workspace-tree-folder-children"${open ? '' : ' hidden'}>${children}</div></div>`;
}

function folderFileGroup(model, node, folderPath = '') {
  const selected = folderPath === model.selected_folder_path;
  const complete = model.truncated !== true || (selected && model.selected_folder_loaded === true);
  const files = node.files.length
    ? node.files.map((resource) => fileRow(model, resource, resource.relative_path === model.focused_resource?.relative_path)).join('')
    : complete
      ? '<p class="workspace-empty">No regular files are in this folder.</p>'
      : '<p class="workspace-empty">Select this folder to load its files.</p>';
  return `<section class="workspace-folder-files" data-folder-files="${escapeHtml(folderPath)}" data-folder-loaded="${complete ? 'true' : 'false'}"${selected ? '' : ' hidden'}><div class="workspace-resource-columns"><span>Work</span><button class="workspace-column-sort" type="button" data-resource-name-sort data-sort-direction="asc" aria-label="Sort files by name descending">Name ↑</button><span>Type</span><span>Last used</span><span>State</span></div>${files}</section>`;
}

function folderFileGroups(model, node, folderPath = '') {
  return `${folderFileGroup(model, node, folderPath)}${node.folders.map((folder) => folderFileGroups(model, folder, folder.relative_path)).join('')}`;
}

function treeNodeAtPath(tree, folderPath) {
  if (!folderPath) return tree;
  const segments = folderPath.split('/').filter(Boolean);
  let node = tree;
  for (const segment of segments) {
    node = node.folders.find((folder) => folder.name === segment);
    if (!node) return null;
  }
  return node;
}

export function renderProjectResourceFolderGroup(model) {
  const folderPath = model.selected_folder_path ?? '';
  const node = treeNodeAtPath(model.tree ?? { folders: [], files: [] }, folderPath);
  return node ? folderFileGroup(model, node, folderPath) : '';
}

function relationship(model, resource) {
  const input = resource.saved_work?.source_path ?? resource.added_from?.origin_file ?? null;
  const downstream = resource.created_work?.[0] ?? null;
  const nodes = [input ? { name: input.split(/[\\/]/u).pop(), label: resource.saved_work ? 'Created from' : 'Added from' } : null, { name: resource.name, label: 'Selected resource' }, downstream ? { name: downstream.name, label: 'Created work' } : null].filter(Boolean);
  const projectRelationships = (resource.resource_fact?.relationships ?? resource.relationships ?? [])
    .filter((item) => item.status === 'active' && item.target_kind === 'project' && ['stored_in', 'used_by'].includes(item.type));
  const lineage = nodes.length > 1 ? `<div class="workspace-relationship-route">${nodes.map((node, index) => `${index ? '<span class="workspace-route-arrow" aria-hidden="true">→</span>' : ''}<div><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(node.label)}</small></div>`).join('')}</div>` : '';
  const projects = projectRelationships.length ? `<div class="workspace-relationship-route">${projectRelationships.map((item, index) => {
    const projectName = item.target_name ?? (item.target_id === model.project.id ? model.project.name : item.target_id);
    return `${index ? '<span class="workspace-route-arrow" aria-hidden="true">·</span>' : ''}<div><small>${escapeHtml(item.type === 'stored_in' ? 'Stored in' : 'Used by')}</small><strong>${escapeHtml(projectName)}</strong></div>`;
  }).join('')}</div>` : '';
  return `<section class="workspace-relationship"><h3>Known relationships</h3>${lineage}${projects}${!lineage && !projects ? '<p class="muted">Atlas has not recorded a relationship for this file.</p>' : ''}</section>`;
}

function representation(resource) {
  if (!resource.representation) return 'No local representation has been prepared.';
  return [resource.representation.label, ...(resource.representation.facts ?? [])].filter(Boolean).join(' · ');
}

function currentState(resource) {
  const labels = { changed: 'Changed since Atlas last used it', missing: 'Recorded file is missing', running: 'In progress', waiting: 'Waiting for a decision', failed: resource.activity?.error_message || 'Work with this resource stopped', unchanged: 'Unchanged since Atlas last used it' };
  return resource.state ? labels[resource.state] ?? resource.state : null;
}

function recoveryActionControls(model, resource, csrfToken) {
  const actions = resource.actions;
  if (!actions) return '';
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="resource_id" value="${escapeHtml(resource.resource_id)}">`;
  const archive = actions.archive_record ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/archive`)}">${hidden}<button class="action-button" type="submit">Archive record</button></form>` : '';
  const restore = actions.restore_record ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/restore`)}">${hidden}<button class="action-button" type="submit">Restore record</button></form>` : '';
  const relink = actions.relink ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/relink`)}" data-resource-relink-form>${hidden}<input type="hidden" name="selection_id" value=""><button class="action-button action-button-secondary" type="button" data-resource-relink-picker data-requires-desktop-picker>Choose file to relink</button><span class="muted" data-resource-relink-name>No file selected</span><button class="action-button" type="submit" disabled data-resource-relink-confirm>Relink</button><p class="muted" data-resource-relink-notice></p></form>` : '';
  const missing = `${archive}${restore}${relink}`;
  const redo = resource.redo_save ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/redo-save`)}">${hidden}<input type="hidden" name="work_id" value="${escapeHtml(resource.redo_save.save_id)}"><button class="action-button" type="submit">Redo</button></form>` : '';
  const currentVersion = resource.external_change?.current?.sha256 ?? resource.resource_fact?.external_change?.current?.sha256 ?? null;
  const acceptCurrent = externalChangeStatus(resource) === 'changed' && currentVersion
    ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/accept-current`)}">${hidden}<input type="hidden" name="expected_current_version" value="${escapeHtml(currentVersion)}"><button class="action-button" type="submit">Accept current file version</button><p class="muted">Use the current disk version as the new comparison baseline.</p></form>` : '';
  const relationships = actions.relationships.map((relationship) => `<div class="workspace-resource-action-row"><span>${escapeHtml(relationship.type === 'used_by' ? 'Used by this Project' : 'Stored in this Project')}</span>${relationship.can_forget ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/forget`)}">${hidden}<input type="hidden" name="relationship_id" value="${escapeHtml(relationship.id)}"><button class="action-button action-button-secondary" type="submit">Forget relationship</button></form>` : ''}${relationship.can_remove_reference ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/remove-reference`)}">${hidden}<input type="hidden" name="relationship_id" value="${escapeHtml(relationship.id)}"><button class="action-button action-button-secondary" type="submit">Remove reference</button></form>` : ''}</div>`).join('');
  if (!missing && !relationships && !redo && !acceptCurrent) return '';
  return `<section class="workspace-resource-actions"><h3>Record actions</h3>${acceptCurrent}${missing}${redo}${relationships}<p class="muted">Archive only hides this unavailable record from everyday Project views. These actions do not delete files.</p></section>`;
}

function focusPanel(model, csrfToken) {
  const resource = model.focused_resource;
  if (!resource) return '<aside class="workspace-focus" data-resource-inspector><span class="workspace-kicker">Selected resource</span><h2>Choose a resource</h2><p>Select a file from the current folder to see its known local facts and open it with its default app.</p></aside>';
  const location = resource.relative_path?.split('/').slice(0, -1).join('/') || resource.last_known_path || 'Not available';
  const source = resource.saved_work?.sources?.length ? resource.saved_work.sources.map((item) => item.path?.split(/[\\/]/u).pop()).filter(Boolean).join(' · ') : resource.saved_work?.source_path ? resource.saved_work.source_path.split(/[\\/]/u).pop() : resource.added_from?.origin_file?.split(/[\\/]/u).pop();
  const state = currentState(resource);
  const inspectedBy = resource.work?.initiated_by?.channel === 'host'
    ? resource.work.initiated_by.agent || 'Execution Host'
    : resource.work?.initiated_by?.channel === 'desktop' ? 'Atlas Desktop' : null;
  const open = resource.open_available === false ? '' : `<form method="post" action="${escapeHtml(`${model.base}/resources/open`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><button class="action-button action-button-secondary" type="submit">Open in default app</button></form>`;
  const dataAction = resource.open_available !== false && resource.relative_path && ['CSV', 'XLSX'].includes(resource.type)
    ? `<a class="action-button" href="${escapeHtml(`${model.base}/data-work?path=${encodeURIComponent(resource.relative_path)}`)}">Work with data</a>` : '';
  const pinControl = resourcePinControl(model, resource, csrfToken);
  const primaryActions = dataAction || open || pinControl || model.activity_return_href
    ? `<div class="workspace-focus-actions">${dataAction}${open}${pinControl}${model.activity_return_href ? `<a class="action-button action-button-secondary" href="${escapeHtml(model.activity_return_href)}">Back to Activity</a>` : ''}</div>`
    : '';
  const usedBy = (resource.created_work ?? []).map((item) => item.name).filter(Boolean);
  const representationValue = resource.representation ? representation(resource) : null;
  return `<aside class="workspace-focus" data-resource-inspector><span class="workspace-kicker">Selected resource</span><h2>${escapeHtml(resource.name)}</h2>${primaryActions}<dl><dt>Type</dt><dd>${escapeHtml(resource.type)}</dd><dt>Project</dt><dd>${escapeHtml(model.project.name)}</dd><dt>${escapeHtml(resource.relationship_label ?? 'Stored in')}</dt><dd>${escapeHtml(location)}</dd><dt>Current state</dt><dd>${escapeHtml(state ?? 'Available in Project')}</dd><dt>Last used</dt><dd>${escapeHtml(lastWorked(resource))}</dd>${source ? `<dt>${resource.saved_work ? 'Created from' : 'Added from'}</dt><dd>${escapeHtml(source)}</dd>` : ''}${resource.saved_work?.recipe?.version ? `<dt>Recipe</dt><dd>Version ${escapeHtml(resource.saved_work.recipe.version)}</dd>` : ''}${usedBy.length ? `<dt>Used by</dt><dd>${usedBy.map((name) => escapeHtml(name)).join(' · ')}</dd>` : ''}${representationValue ? `<dt>Representation</dt><dd>${escapeHtml(representationValue)}</dd>` : ''}${inspectedBy ? `<dt>Last read by</dt><dd>${escapeHtml(inspectedBy)}</dd>` : ''}</dl>${recoveryActionControls(model, resource, csrfToken)}${relationship(model, resource)}<details class="workspace-technical-details"><summary>Technical details</summary><dl><dt>Resource ID</dt><dd class="mono">${escapeHtml(resource.resource_id ?? 'Not recorded')}</dd><dt>Exact path</dt><dd class="mono">${escapeHtml(resource.relative_path ?? resource.last_known_path ?? 'Not available')}</dd>${resource.last_known_hash ? `<dt>Last known hash</dt><dd class="mono">${escapeHtml(resource.last_known_hash)}</dd>` : ''}${resource.last_worked_at ? `<dt>Recent activity</dt><dd>${escapeHtml(time(resource.last_worked_at))}</dd>` : ''}</dl></details></aside>`;
}

function explorer(model, csrfToken) {
  const focusedPath = model.focused_resource?.relative_path ?? null;
  const resourceTree = model.tree ?? { folders: [], files: [] };
  const tree = resourceTree.folders.length
    ? resourceTree.folders.map((folder) => treeFolder(model, folder, 0, focusedPath)).join('')
    : '<p class="workspace-empty">No folders with visible regular files are available.</p>';
  const selectedFolderLabel = model.selected_folder_path ? `${model.project.name} / ${model.selected_folder_path.split('/').join(' / ')}` : model.project.name;
  const rootSelected = model.selected_folder_path === '';
  const fileGroups = folderFileGroups(model, resourceTree);
  const missing = model.missing_sources ?? [];
  const savedViewState = model.resource_view?.active_view
    ? `${resourceViewReceipt(model.resource_view.evaluation)}${model.saved_view_empty ? '<p class="callout">This Saved View is valid, but its current filter has no matching Resources.</p>' : ''}`
    : '';
  return `<main class="workspace-visibility-page workspace-resource-page"><header class="workspace-resource-header"><div><span class="workspace-kicker">Project / ${escapeHtml(model.project.name)}</span><h1>Resources</h1></div><p>Find a folder, choose files, and keep their known context beside the work.</p>${workSelectionBar(model)}<button class="action-button action-button-secondary workspace-file-list-toggle" type="button" data-resource-list-toggle aria-controls="project-resource-file-list" aria-expanded="true">Hide file list</button>${resourceViewControls(model, csrfToken)}</header>${savedViewState}${model.focus_error ? `<p class="callout warn">${escapeHtml(model.focus_error)}</p>` : ''}<div class="workspace-resource-grid" data-resource-workspace data-project-id="${escapeHtml(model.project.id)}" data-project-name="${escapeHtml(model.project.name)}" data-project-base="${escapeHtml(model.base)}" data-selected-folder="${escapeHtml(model.selected_folder_path)}" data-selected-folder-explicit="${model.selected_folder_explicit ? 'true' : 'false'}" data-focus-path="${escapeHtml(model.focused_resource?.relative_path ?? '')}" data-active-view-id="${escapeHtml(model.resource_view?.active_view?.view_id ?? '')}" data-csrf="${escapeHtml(csrfToken ?? '')}"><section class="workspace-folder-navigator" data-folder-navigator><div class="workspace-pane-heading"><div><span class="workspace-kicker">Folder navigator</span></div><button class="workspace-text-button" type="button" data-collapse-all-folders>Collapse all</button></div><div class="workspace-folder-scroll"><div class="workspace-tree-root" data-resource-tree data-project-id="${escapeHtml(model.project.id)}"${model.focused_resource ? ` data-focus-path="${escapeHtml(model.focused_resource.relative_path)}"` : ''} data-open-action="${escapeHtml(`${model.base}/resources/open`)}" data-csrf="${escapeHtml(csrfToken ?? '')}"><a class="workspace-tree-root-row${rootSelected ? ' is-selected' : ''}" href="${escapeHtml(`${model.base}/resources?folder=`)}" data-folder-select data-folder-path=""><strong>${escapeHtml(model.project.name)}</strong><small>Project root</small></a>${tree}</div>${model.saved_work_error ? '<p class="callout warn">Created results could not be loaded. Project files remain available.</p>' : ''}${model.truncated ? '<p class="workspace-note">The initial file list is bounded. Select a folder to load its direct files.</p>' : ''}${missing.length ? `<section class="workspace-missing"><h3>Missing trace</h3>${missing.map((item) => `<p><strong>${escapeHtml(item.name)}</strong><span>Atlas remembers this file, but it is no longer at:</span><small class="mono">${escapeHtml(item.source_path ?? '')}</small></p>`).join('')}</section>` : ''}</div><a class="workspace-pane-footer-link" href="${model.base}/files">Detailed folder view</a></section><div class="workspace-pane-resizer" role="separator" aria-label="Resize folder navigator" aria-orientation="vertical" aria-valuemin="170" aria-valuemax="520" aria-valuenow="270" tabindex="0" data-resource-pane-resizer="folder"></div><section class="workspace-resource-list" id="project-resource-file-list" data-resource-file-list><div class="workspace-pane-heading"><div><span class="workspace-kicker">Files in <strong data-selected-folder-label>${escapeHtml(selectedFolderLabel)}</strong></span></div></div><div class="workspace-resource-list-scroll">${fileGroups}</div></section><div class="workspace-pane-resizer" role="separator" aria-label="Resize file list" aria-orientation="vertical" aria-valuemin="280" aria-valuemax="760" aria-valuenow="500" tabindex="0" data-resource-pane-resizer="list"></div>${focusPanel(model, csrfToken)}</div><div class="resource-context-card" popover="manual" data-resource-context-card><strong data-resource-context-title></strong><p data-resource-context-body></p><small>Open a resource in the workspace for known facts.</small></div></main>`;
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
  const externalStatus = externalChangeStatus(resource);
  if (externalChangeCopy(externalStatus)) facts.push(['File status', externalChangeCopy(externalStatus)]);
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
    const sources = resource.saved_work.sources?.length ? resource.saved_work.sources.map((item) => item.path).join(' · ') : resource.saved_work.source_path;
    facts.push(['Created from', sources, true]);
    if (resource.saved_work.recipe?.version) facts.push(['Recipe', `Version ${resource.saved_work.recipe.version}`]);
    facts.push(['Source status', resource.saved_work.source_status]);
  }
  const created = resource.created_work?.length ? `<section class="surface"><h2>Used by</h2><p class="muted">Atlas recorded this file as an input to these saved results.</p><ul class="path-list">${resource.created_work.map((item) => `<li><a class="text-link" href="${escapeHtml(detailHref(model, item))}">${escapeHtml(item.name)}</a></li>`).join('')}</ul></section>` : '';
  const dataAction = ['CSV', 'XLSX'].includes(resource.type) ? `<a class="action-button" href="${model.base}/data-work?path=${encodeURIComponent(resource.relative_path)}">Work with data</a>` : '';
  const undo = resource.saved_work?.undo_available ? `<form method="post" action="/data-work/undo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(resource.saved_work.work_id)}"><input type="hidden" name="project_id" value="${escapeHtml(model.project.id)}"><button class="action-button action-button-secondary">Undo</button></form>` : '';
  const technical = `<details class="surface technical-details"><summary>Technical file details</summary>${renderFacts([['Exact path', resource.relative_path, true], ['Size', size(resource.bytes)], ['Modified on disk', time(resource.modified_at)], ...(resource.work ? [['Read purpose', resource.work.sheet ? `Sheet: ${resource.work.sheet}` : resource.work.purpose], ['Last read', time(resource.work.inspected_at)]] : []), ...(resource.saved_work ? [['Filters', (resource.saved_work.parameters?.filters ?? []).map((item) => `${item.column} ${item.operator}${item.value == null ? '' : ` ${item.value}`}`).join(' · ') || 'None'], ['Sort', resource.saved_work.parameters?.sort ? `${resource.saved_work.parameters.sort.column} ${resource.saved_work.parameters.sort.direction}` : 'None']] : [])])}</details>`;
  return `<div class="page-intro"><div><span class="eyebrow">PROJECT FILE</span><h1>${escapeHtml(resource.name)}</h1><p class="lede">Where it is, what Atlas knows, and what you can do next.</p></div><div class="inline-actions"><form method="post" action="${model.base}/files/open"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><button class="action-button action-button-secondary" type="submit">Open in default app</button></form>${resourcePinControl(model, resource, csrfToken)}${dataAction}${undo}<a class="action-button action-button-secondary" href="${model.base}/resources?path=${encodeURIComponent(resource.relative_path)}">Back to Folder View</a><a class="action-button action-button-secondary" href="${model.base}/files?dir=${encodeURIComponent(resource.relative_path.split('/').slice(0, -1).join('/'))}">Browse folder</a></div></div><section class="surface">${renderFacts(facts)}</section>${created}${technical}`;
}

function resourceLedgerLists(model) {
  const external = model.external_references ?? [];
  const focusedId = model.focused_resource?.resource_id;
  const missing = (model.missing_resources ?? []).filter((item) => item.resource_id !== focusedId);
  const archived = (model.archived_missing_resources ?? []).filter((item) => item.resource_id !== focusedId);
  const visibleMissing = missing.slice(0, 12);
  const visibleArchived = archived.slice(0, 12);
  const missingList = missing.length ? `<section class="workspace-missing"><h3>Missing resources</h3><p>${escapeHtml(`${missing.length} unavailable record${missing.length === 1 ? '' : 's'}. Open one to relink or archive it.`)}</p>${visibleMissing.map((item) => `<p><a href="${escapeHtml(resourceHref(model, item))}">${escapeHtml(item.resource?.display_name ?? item.resource_id)}</a></p>`).join('')}${missing.length > visibleMissing.length ? `<p class="muted">Showing the first ${visibleMissing.length}. Archive obsolete records from Project Home to clear the reminder.</p>` : ''}</section>` : '';
  const archivedList = archived.length ? `<details class="workspace-missing"><summary>Archived missing records (${escapeHtml(archived.length)})</summary>${visibleArchived.map((item) => `<p><a href="${escapeHtml(resourceHref(model, item))}">${escapeHtml(item.resource?.display_name ?? item.resource_id)}</a></p>`).join('')}${archived.length > visibleArchived.length ? `<p class="muted">Showing the first ${visibleArchived.length} archived records.</p>` : ''}</details>` : '';
  return `${external.length ? `<section class="workspace-missing"><h3>External references</h3>${external.map((item) => `<p><a href="${escapeHtml(resourceHref(model, item))}">${escapeHtml(item.resource?.display_name ?? item.resource_id)}</a><small>Used by · ${escapeHtml(item.resource_id)}</small></p>`).join('')}</section>` : ''}${missingList}${archivedList}`;
}

export function renderProjectResourcesView(model, options = {}) {
  const explorerBody = explorer(model, options.csrfToken);
  const resourceViewMode = model.resource_view?.mode;
  const resourceViewBody = ['table', 'cards'].includes(resourceViewMode) ? resourceViewContent(model, options.csrfToken) : null;
  const body = model.mode === 'detail' ? detail(model, options.csrfToken) : resourceViewBody ?? explorerBody.replace('</main>', `${resourceLedgerLists(model)}</main>`);
  const main = model.mode === 'detail' ? `<main class="page">${body}</main>` : body;
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(model.project.name)} Resources · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="atlas-workspace-body"><div class="app-shell atlas-workspace-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Resources', { interactive: true, workspaceHref: '/projects', resourcesHref: `${model.base}/resources`, settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Resources', project: model.project, resource: model.mode === 'detail' ? model.resource?.relative_path : model.selected_path })}${main}</div></div></body></html>`;
}
