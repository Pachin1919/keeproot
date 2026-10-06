import { escapeHtml, renderFacts, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';
import { WORK_COPY_KEYS } from '../work-messages.js';
import { projectResourceHref } from '../../resource-links.js';
import { RESOURCE_MESSAGES } from '../resource-messages.js';

const RESOURCE_MESSAGE_KEYS = [
  'resources.choose_resource_help', 'resources.choose_resource', 'resources.folder_load_failed',
  'resources.loading_folder', 'resources.selected_resource', 'resources.back_to_file_list',
  'resources.hide_file_list', 'resources.project_root', 'resources.selected_files',
  'resources.selection_update_failed', 'resources.show_file_list',
  'resources.show_resource_details', 'resources.updating_selection',
];

function resourceClientMessages(locale, languageCatalog) {
  return Object.fromEntries(RESOURCE_MESSAGE_KEYS.map((key) => [key, translateUi(locale, key, languageCatalog)]));
}

function createResourceRenderer(options = {}) {
  const t = (key, values = {}) => translateUi(options.locale, key, options.languageCatalog).replace(/\{(\w+)\}/gu, (match, name) => String(values[name] ?? match));
  const h = (key, values) => escapeHtml(t(key, values));
  const fact = (value) => WORK_COPY_KEYS[value] ? t(WORK_COPY_KEYS[value]) : value;

function size(bytes) {
  if (!Number.isFinite(bytes)) return t('work.not_available');
  if (bytes < 1024) return `${bytes} bytes`;
  return `${(bytes / 1024).toFixed(bytes < 1024 * 1024 ? 1 : 2)} ${bytes < 1024 * 1024 ? 'KB' : 'MB'}`;
}

function time(value) {
  if (!value) return t('work.not_available');
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? t('work.not_available') : date.toLocaleString(normalizeUiLocale(options.locale));
}

function detailHref(model, resource) {
  return `${model.base}/resources/detail?path=${encodeURIComponent(resource.relative_path)}`;
}

function resourceHref(model, resource) {
  return projectResourceHref(model.base, resource.relative_path, resource.resource_id);
}

function readerHref(model, resource) {
  if (!resource.resource_id || resource.open_available === false || !/\.(?:md|markdown|txt|pdf|docx|csv|tsv|xlsx|png|jpe?g|webp|gif)$/iu.test(resource.relative_path ?? '')) return null;
  const mode = model.resource_view?.mode ?? 'files';
  const returnHref = model.reader_return_href ?? resourceViewModeHref(model, mode);
  const returnUrl = new URL(returnHref, 'http://atlas.local');
  if (!model.reader_return_href && mode === 'files') returnUrl.searchParams.set('folder', model.selected_folder_path ?? '');
  returnUrl.searchParams.set('resource_id', resource.resource_id);
  return `${model.base}/resources/read?${new URLSearchParams({ resource_id: resource.resource_id, return_to: returnUrl.pathname + returnUrl.search })}`;
}

function readerLink(model, resource, className = 'text-link', csrfToken = null) {
  const href = readerHref(model, resource);
  if (href) return `<a class="${className}" href="${escapeHtml(href)}">${h('reader.read')}</a>`;
  if (!csrfToken || resource.resource_id || resource.open_available === false || !/\.(?:md|markdown|txt|pdf|docx|csv|tsv|xlsx|png|jpe?g|webp|gif)$/iu.test(resource.relative_path ?? '')) return '';
  const returnHref = model.reader_return_href ?? `${model.base}/resources?${new URLSearchParams({folder: model.selected_folder_path ?? '', path: resource.relative_path})}`;
  return `<form method="post" action="${escapeHtml(`${model.base}/resources/read-file`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><input type="hidden" name="return_to" value="${escapeHtml(returnHref)}"><button class="${className}" type="submit">${h('reader.read')}</button></form>`;
}

function readerRowAttributes(model, resource) {
  const href = readerHref(model, resource);
  return href ? ` data-reader-href="${escapeHtml(href)}"` : '';
}

function temporaryResourceViewQuery(model, mode) {
  const view = model.resource_view;
  const config = view?.temporary_config ?? { scope: { path: model.selected_folder_path ?? '', extensions: [] }, filters: [], sort: [] };
  const scopePath = config.scope?.path ?? model.selected_folder_path ?? '';
  const registeredLocal = config.membership === 'registered_local';
  const nameFilter = config.filters?.find((item) => item.field === 'name' && item.operator === 'contains')?.value ?? '';
  const propertyFilter = config.filters?.find((item) => String(item.field).startsWith('property:') && item.operator === 'equals');
  const dateFilter = config.filters?.find((item) => String(item.field).startsWith('property:') && item.operator === 'date_between');
  const relationshipFilter = config.filters?.find((item) => item.field === 'relationship:used_by' && item.operator === 'equals');
  const linkedResourceFilter = config.filters?.find((item) => item.field === 'relationship:linked_to' && item.operator === 'equals');
  const sort = config.sort?.[0] ?? { field: 'relative_path', direction: 'asc' };
  const query = new URLSearchParams({ mode, scope_path: scopePath });
  if (registeredLocal) query.set('membership', 'registered_local');
  if (mode === 'files') query.set('folder', scopePath);
  if (config.scope?.extensions?.length) query.set('extensions', config.scope.extensions.join(', '));
  if (nameFilter && !registeredLocal) query.set('name_contains', nameFilter);
  if (propertyFilter) {
    query.set('property_filter_id', String(propertyFilter.field).slice('property:'.length));
    query.set('property_filter_operator', 'equals');
    query.set('property_filter_value', propertyFilter.value ?? '');
  }
  if (registeredLocal && dateFilter) {
    query.set('date_property_id', String(dateFilter.field).slice('property:'.length));
    query.set('date_from', dateFilter.value?.from ?? '');
    query.set('date_to', dateFilter.value?.to ?? '');
  }
  if (registeredLocal && relationshipFilter) query.set('used_by_project_id', relationshipFilter.value);
  if (registeredLocal && linkedResourceFilter) query.set('linked_to_resource_id', linkedResourceFilter.value);
  if (registeredLocal && config.fulltext?.terms?.length) query.set('fulltext_terms', config.fulltext.terms.join(' '));
  if (!registeredLocal) {
    if (sort.field) query.set('sort_field', sort.field);
    if (sort.direction) query.set('sort_direction', sort.direction);
    if (config.group_by) query.set('group_by', config.group_by);
    if (config.visible_fields?.length) query.set('visible_fields', config.visible_fields.join(', '));
  }
  return query;
}

function resourceViewModeHref(model, mode) {
  const query = model.resource_view?.active_view?.view_id
    ? new URLSearchParams({ mode, view: model.resource_view.active_view.view_id })
    : temporaryResourceViewQuery(model, mode);
  return `${model.base}/resources?${query}`;
}

function resourceViewControls(model, csrfToken, locale, languageCatalog) {
  const view = model.resource_view ?? {
    mode: 'files',
    saved_views: [],
    temporary_config: { scope: { path: model.selected_folder_path ?? '', extensions: [] }, filters: [], sort: [] },
  };
  const mode = ['files', 'table', 'cards'].includes(view.mode) ? view.mode : 'files';
  const saved = view.saved_views ?? [];
  const scopePath = view.active_view?.scope_path ?? model.selected_folder_path ?? '';
  const config = view.temporary_config ?? view.active_view?.config ?? { scope: { path: scopePath, extensions: [] }, filters: [], sort: [] };
  const registeredLocal = config.membership === 'registered_local';
  const nameFilter = config.filters?.find((item) => item.field === 'name' && item.operator === 'contains')?.value ?? '';
  const propertyFilter = config.filters?.find((item) => String(item.field).startsWith('property:') && item.operator === 'equals') ?? null;
  const dateFilter = config.filters?.find((item) => String(item.field).startsWith('property:') && item.operator === 'date_between') ?? null;
  const relationshipFilter = config.filters?.find((item) => item.field === 'relationship:used_by' && item.operator === 'equals') ?? null;
  const linkedResourceFilter = config.filters?.find((item) => item.field === 'relationship:linked_to' && item.operator === 'equals') ?? null;
  const propertyFilterId = propertyFilter?.field?.slice('property:'.length) ?? '';
  const datePropertyId = dateFilter?.field?.slice('property:'.length) ?? '';
  const relatedProjectId = relationshipFilter?.value ?? '';
  const linkedResourceId = linkedResourceFilter?.value ?? '';
  const sort = config.sort?.[0] ?? { field: 'relative_path', direction: 'asc' };
  const visibleFields = config.visible_fields ?? [];
  const groupOptions = (view.property_definitions ?? []).map((definition) => `<option value="property:${escapeHtml(definition.property_id)}"${config.group_by === `property:${definition.property_id}` ? ' selected' : ''}>${escapeHtml(definition.name)}</option>`).join('');
  const propertyFilterOptions = (view.property_definitions ?? []).map((definition) => `<option value="${escapeHtml(definition.property_id)}"${propertyFilterId === definition.property_id ? ' selected' : ''}>${escapeHtml(definition.name)}</option>`).join('');
  const textPropertyOptions = (view.property_definitions ?? []).filter((definition) => definition.kind === 'text').map((definition) => `<option value="${escapeHtml(definition.property_id)}"${datePropertyId === definition.property_id ? ' selected' : ''}>${escapeHtml(definition.name)}</option>`).join('');
  const relationshipProjectOptions = (view.relationship_projects ?? []).map((project) => `<option value="${escapeHtml(project.id)}"${relatedProjectId === project.id ? ' selected' : ''}>${escapeHtml(project.name)} · ${escapeHtml(project.id)}</option>`).join('');
  const linkedResourceOptions = (view.linked_resources ?? []).filter((resource) => resource.resource_id !== model.focused_resource?.resource_id).map((resource) => `<option value="${escapeHtml(resource.resource_id)}"${linkedResourceId === resource.resource_id ? ' selected' : ''}>${escapeHtml(resource.name)} · ${escapeHtml(resource.resource_id)}</option>`).join('');
  const propertyFilterControl = propertyFilterOptions ? `<label>${h('resources.property_filter')} <select name="property_filter_id"><option value="">${h('resources.no_property_filter')}</option>${propertyFilterOptions}</select></label><label>${h('resources.match')} <select name="property_filter_operator"><option value="equals"${propertyFilter?.operator === 'equals' ? ' selected' : ''}>${h('resources.equals')}</option>${registeredLocal ? '' : `<option value="contains"${propertyFilter?.operator === 'contains' ? ' selected' : ''}>${h('resources.contains_text')}</option><option value="includes"${propertyFilter?.operator === 'includes' ? ' selected' : ''}>${h('resources.includes_option')}</option><option value="is_empty"${propertyFilter?.operator === 'is_empty' ? ' selected' : ''}>${h('resources.is_empty')}</option>`}</select></label><label>${h('resources.property_value')} <input name="property_filter_value" value="${escapeHtml(propertyFilter?.value ?? '')}"></label>` : '';
  const registrationControls = `<label>${h('resources.membership')} <select name="membership"><option value=""${registeredLocal ? '' : ' selected'}>${h('resources.dynamic_membership')}</option><option value="registered_local"${registeredLocal ? ' selected' : ''}>${h('resources.registered_local_membership')}</option></select></label>${registeredLocal ? `<p class="resource-view-scope-help">${h('resources.registered_local_help')}</p><label>${h('resources.fulltext_terms')} <input name="fulltext_terms" value="${escapeHtml(config.fulltext?.terms?.join(' ') ?? '')}"></label><p class="resource-view-scope-help">${h('resources.fulltext_any_help')}</p>${textPropertyOptions ? `<label>${h('resources.event_date_property')} <select name="date_property_id"><option value="">${h('resources.no_property_filter')}</option>${textPropertyOptions}</select></label><label>${h('resources.date_from')} <input type="date" name="date_from" value="${escapeHtml(dateFilter?.value?.from ?? '')}"></label><label>${h('resources.date_to')} <input type="date" name="date_to" value="${escapeHtml(dateFilter?.value?.to ?? '')}"></label>` : ''}${relationshipProjectOptions ? `<label>${h('resources.used_by_project')} <select name="used_by_project_id"><option value="">${h('resources.no_relationship_filter')}</option>${relationshipProjectOptions}</select></label>` : ''}${linkedResourceOptions ? `<label>${h('resources.linked_to_resource')} <select name="linked_to_resource_id"><option value="">${h('resources.no_linked_to_filter')}</option>${linkedResourceOptions}</select></label>` : ''}` : ''}`;
  const modes = ['files', 'table', 'cards'].map((entry) => `<a class="resource-view-mode${entry === mode ? ' is-active' : ''}" href="${escapeHtml(resourceViewModeHref(model, entry))}" data-resource-view-mode="${escapeHtml(entry)}"${entry === mode ? ' aria-current="page"' : ''}>${escapeHtml(t(`resources.${entry}`))}</a>`).join('');
  const savedViews = saved.length ? `<nav class="resource-view-saved" aria-label="${h('resources.saved_views_aria')}"><span>${h('resources.saved_views')}</span>${saved.map((item) => `<a href="${escapeHtml(`${model.base}/resources?view=${encodeURIComponent(item.view_id)}`)}"${item.view_id === view.active_view?.view_id ? ' aria-current="page"' : ''}>${escapeHtml(item.name)}</a>`).join('')}</nav>` : '';
  const pin = view.active_view ? `<form method="post" action="${escapeHtml(`${model.base}/home/pins`)}" class="resource-view-pin"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="action" value="${view.active_view.pinned ? 'unpin' : 'pin'}"><input type="hidden" name="kind" value="view"><input type="hidden" name="id" value="${escapeHtml(view.active_view.view_id)}"><input type="hidden" name="return_to" value="${escapeHtml(`${model.base}/resources?view=${encodeURIComponent(view.active_view.view_id)}`)}"><button class="text-link" type="submit">${escapeHtml(t(view.active_view.pinned ? 'resources.unpin_from_home' : 'resources.pin_to_home'))}</button></form>` : '';
  const filesHref = resourceViewModeHref(model, 'files');
  const registrationHidden = registeredLocal ? `<input type="hidden" name="membership" value="registered_local"><input type="hidden" name="fulltext_terms" value="${escapeHtml(config.fulltext?.terms?.join(' ') ?? '')}"><input type="hidden" name="property_filter_id" value="${escapeHtml(propertyFilterId)}"><input type="hidden" name="property_filter_operator" value="equals"><input type="hidden" name="property_filter_value" value="${escapeHtml(propertyFilter?.value ?? '')}"><input type="hidden" name="date_property_id" value="${escapeHtml(datePropertyId)}"><input type="hidden" name="date_from" value="${escapeHtml(dateFilter?.value?.from ?? '')}"><input type="hidden" name="date_to" value="${escapeHtml(dateFilter?.value?.to ?? '')}"><input type="hidden" name="used_by_project_id" value="${escapeHtml(relatedProjectId)}"><input type="hidden" name="linked_to_resource_id" value="${escapeHtml(linkedResourceId)}">` : '';
  const preview = `<form method="get" action="${escapeHtml(`${model.base}/resources`)}" class="resource-view-config"><input type="hidden" name="mode" value="${escapeHtml(mode)}">${view.active_view ? `<input type="hidden" name="view" value="${escapeHtml(view.active_view.view_id)}">` : ''}<div class="resource-view-scope"><strong>${escapeHtml(t('resources.current_scope'))}</strong><span data-resource-view-scope-label>${escapeHtml(config.scope?.path || t('resources.project_root'))}</span><a class="text-link" href="${escapeHtml(filesHref)}" data-resource-view-files-link>${escapeHtml(t('resources.choose_folder'))}</a></div><p class="resource-view-scope-help">${escapeHtml(t('resources.scope_help'))}</p><label>${escapeHtml(t('resources.folder_path'))} <input name="scope_path" value="${escapeHtml(config.scope?.path ?? scopePath)}" placeholder="${escapeHtml(t('resources.project_root'))}" data-resource-view-scope-input></label><label>${escapeHtml(t('resources.extensions'))} <input name="extensions" value="${escapeHtml((config.scope?.extensions ?? []).join(', '))}" placeholder="pdf, md"></label>${registrationControls}${registeredLocal ? '' : `<label>${escapeHtml(t('resources.name_contains'))} <input name="name_contains" value="${escapeHtml(nameFilter)}"></label>`}${propertyFilterControl}${registeredLocal ? '' : `<label>${escapeHtml(t('resources.sort'))} <select name="sort_field"><option value="relative_path"${sort.field === 'relative_path' ? ' selected' : ''}>${h('work.path')}</option><option value="name"${sort.field === 'name' ? ' selected' : ''}>${h('resources.name')}</option><option value="modified_at"${sort.field === 'modified_at' ? ' selected' : ''}>${h('resources.modified')}</option><option value="bytes"${sort.field === 'bytes' ? ' selected' : ''}>${h('work.size')}</option></select></label><label>${escapeHtml(t('resources.direction'))} <select name="sort_direction"><option value="asc"${sort.direction !== 'desc' ? ' selected' : ''}>${h('work.ascending')}</option><option value="desc"${sort.direction === 'desc' ? ' selected' : ''}>${h('work.descending')}</option></select></label><label>${escapeHtml(t('resources.group'))} <select name="group_by"><option value="">${h('resources.no_grouping')}</option><option value="type"${config.group_by === 'type' ? ' selected' : ''}>${h('resources.file_type')}</option>${groupOptions}</select></label><label>${escapeHtml(t('resources.visible_fields'))} <input name="visible_fields" value="${escapeHtml(visibleFields.join(', '))}" placeholder="${h('resources.property_names')}"></label>`}<button class="action-button action-button-secondary" type="submit">${escapeHtml(t('resources.preview'))}</button></form>`;
  const save = view.save_action ? `<form method="post" action="${escapeHtml(view.save_action)}" class="resource-view-save"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="view_id" value="${escapeHtml(view.active_view?.view_id ?? '')}"><input type="hidden" name="base_revision" value="${escapeHtml(view.active_view?.revision ?? '')}"><label>${h('resources.name')} <input name="name" value="${escapeHtml(view.active_view?.name ?? '')}" required maxlength="120"></label><input type="hidden" name="mode" value="${escapeHtml(mode)}"><input type="hidden" name="scope_path" value="${escapeHtml(config.scope?.path ?? scopePath)}"><input type="hidden" name="extensions" value="${escapeHtml((config.scope?.extensions ?? []).join(','))}">${registeredLocal ? registrationHidden : `<input type="hidden" name="name_contains" value="${escapeHtml(nameFilter)}"><input type="hidden" name="property_filter_id" value="${escapeHtml(propertyFilterId)}"><input type="hidden" name="property_filter_operator" value="${escapeHtml(propertyFilter?.operator ?? 'equals')}"><input type="hidden" name="property_filter_value" value="${escapeHtml(propertyFilter?.value ?? '')}"><input type="hidden" name="sort_field" value="${escapeHtml(sort.field)}"><input type="hidden" name="sort_direction" value="${escapeHtml(sort.direction)}"><input type="hidden" name="group_by" value="${escapeHtml(config.group_by ?? '')}"><input type="hidden" name="visible_fields" value="${escapeHtml(visibleFields.join(','))}">`}<button class="action-button action-button-secondary" type="submit">${view.active_view ? t('resources.update_view') : t('resources.save_view')}</button></form>` : '';
  return `<div class="resource-view-controls"><nav class="resource-view-modes" aria-label="${h('resources.resource_display')}">${modes}</nav>${savedViews}${pin}<details class="resource-view-settings"><summary>${escapeHtml(t('resources.view_settings'))} · ${escapeHtml(config.scope?.path || t('resources.project_root'))}</summary>${preview}${save ? `<div class="resource-view-settings-save">${save}</div>` : ''}</details></div>`;
}

function resourceViewReceipt(evaluation, locale, languageCatalog) {
  if (!evaluation) return `<p class="resource-view-receipt status-neutral">${escapeHtml(t('resources.no_evaluation'))}</p>`;
  const counts = escapeHtml(t('resources.returned', { count: evaluation.returned_count ?? 0 }));
  const scopeLabel = (item) => typeof item === 'string' ? item : `${item?.path ?? 'unknown'}${item?.error ? ` (${item.error})` : ''}`;
  const unchecked = evaluation.unchecked_scopes ?? [];
  const failed = evaluation.failed_scopes ?? [];
  const issueCounts = [
    ...(unchecked.length ? [t('resources.unchecked_count',{count:unchecked.length})] : []),
    ...(failed.length ? [t('resources.failed_count',{count:failed.length})] : []),
  ];
  const fulltextIndex = evaluation.fulltext_index ?? null;
  const indexUpdated = fulltextIndex?.completed_at
    ? new Date(fulltextIndex.completed_at).toLocaleString(normalizeUiLocale(locale))
    : '';
  const copy = fulltextIndex?.status === 'index_unavailable'
    ? `${counts}. ${escapeHtml(t('resources.fulltext_index_unavailable'))}`
    : evaluation.completeness === 'registered_local'
    ? `${counts}. ${escapeHtml(t('resources.registered_local_receipt', { total: evaluation.known_total ?? 0 }))}${fulltextIndex ? ` · ${escapeHtml(t('resources.fulltext_index_updated', { updated: indexUpdated }))}` : ''}`
    : evaluation.completeness === 'complete'
    ? `${counts}. ${escapeHtml(t('resources.evaluation_complete'))}`
    : evaluation.completeness === 'partial'
      ? `${counts}. ${escapeHtml(t('resources.evaluation_partial',{issues:issueCounts.join('; ')}))}`
      : `${counts}. ${escapeHtml(t('resources.evaluation_unknown'))}`;
  const issueDetails = issueCounts.length
    ? `<details class="resource-view-issues" data-resource-view-issues><summary>${h('resources.evaluation_details')}</summary>${unchecked.length ? `<p><strong>${h('resources.unchecked_sample')}</strong> ${unchecked.slice(0, 3).map((item) => escapeHtml(scopeLabel(item))).join(' · ')}</p>` : ''}${failed.length ? `<p><strong>${h('resources.failed_sample')}</strong> ${failed.slice(0, 3).map((item) => escapeHtml(scopeLabel(item))).join(' · ')}</p>` : ''}</details>`
    : '';
  const showMore = ['partial', 'registered_local'].includes(evaluation.completeness) && evaluation.more_href
    ? ` <a class="text-link" href="${escapeHtml(evaluation.more_href)}">${escapeHtml(t('resources.show_more'))}</a>`
    : '';
  return `<div class="resource-view-receipt status-${escapeHtml(evaluation.completeness ?? 'neutral')}"><p>${escapeHtml(copy)}${showMore}</p>${issueDetails}</div>`;
}

function resourceViewProperty(member, definition) {
  const resource = member.resource ?? member;
  const values = member.display_properties ?? member.properties ?? member.property_values ?? resource.properties ?? resource.property_values ?? {};
  const stored = values[definition.property_id ?? definition.id ?? definition.name];
  const value = stored && typeof stored === 'object' && !Array.isArray(stored) && Object.hasOwn(stored, 'value') ? stored.value : stored;
  return Array.isArray(value) ? value.join(' · ') : value ?? '—';
}

function externalChangeStatus(resource, member = null) {
  return (member?.external_change ?? resource?.external_change ?? resource?.resource_fact?.external_change)?.status ?? null;
}

function externalChangeCopy(status) {
  return {
    changed: t('resources.changed_outside'),
    unchanged: t('resources.external_unchanged'),
    not_checked: t('resources.external_not_checked'),
    missing: t('resources.file_missing'),
  }[status] ?? null;
}

function externalChange(resource, member = null) {
  const status = externalChangeStatus(resource, member);
  const copy = externalChangeCopy(status);
  if (!copy) return '';
  return `<p class="resource-external-change resource-external-change-${escapeHtml(status)}"><strong>${h('resources.file_status')}:</strong> ${escapeHtml(copy)}</p>`;
}

function candidateValue(value) {
  if (Array.isArray(value)) return value.join(' · ');
  if (value == null) return t('resources.no_value');
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : t('resources.value_unavailable');
}

function candidateInputValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function resourcePropertyCandidates(view, csrfToken, returnTo, locale, languageCatalog) {
  const candidates = view.property_candidates ?? [];
  const action = view.property_candidate_decision_action;
  if (!candidates.length || !action) return '';
  const decisionFields = (candidate, decision) => `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><input type="hidden" name="candidate_id" value="${escapeHtml(candidate.candidate_id)}"><input type="hidden" name="expected_revision" value="${escapeHtml(candidate.revision)}"><input type="hidden" name="expected_source_version" value="${escapeHtml(candidate.source_version)}"><input type="hidden" name="action" value="${decision}">`;
  const items = candidates.map((candidate) => {
    const status = candidate.status ?? 'pending';
    const host = [candidate.host?.tool, candidate.host?.model].filter(Boolean).join(' · ') || t('resources.host_not_recorded');
    const evidence = typeof candidate.evidence === 'string' && candidate.evidence.trim()
      ? `<p class="resource-property-candidate-evidence"><strong>${escapeHtml(t('resources.evidence'))}</strong> ${escapeHtml(candidate.evidence)}</p>`
      : '';
    const canAccept = status === 'pending' && candidate.can_accept !== false;
    const accept = canAccept ? `<form method="post" action="${escapeHtml(action)}" class="resource-property-candidate-action">${decisionFields(candidate, 'accept')}<button class="action-button" type="submit">${escapeHtml(t('resources.accept'))}</button></form>` : '';
    const edit = (status === 'pending' || status === 'needs_review')
      ? `<form method="post" action="${escapeHtml(action)}" class="resource-property-candidate-edit">${decisionFields(candidate, 'edit_accept')}<label>${escapeHtml(t('resources.edit_proposed_value'))} <input name="value" value="${escapeHtml(candidateInputValue(candidate.value))}" required></label><button class="action-button action-button-secondary" type="submit">${escapeHtml(t('resources.edit_and_accept'))}</button></form>`
      : '';
    const reject = (status === 'pending' || status === 'needs_review')
      ? `<form method="post" action="${escapeHtml(action)}" class="resource-property-candidate-action">${decisionFields(candidate, 'reject')}<button class="text-link" type="submit">${escapeHtml(t('resources.reject'))}</button></form>`
      : '';
    const statusText = status === 'pending' ? t('resources.status_pending') : status === 'needs_review' ? t('resources.status_needs_review') : status.replaceAll('_', ' ');
    const promptVersion = candidate.prompt_version == null ? t('resources.prompt_version_not_recorded') : t('resources.prompt_version_value', { version: candidate.prompt_version });
    return `<li class="resource-property-candidate status-${escapeHtml(status)}"><div class="resource-property-candidate-summary"><h3>${escapeHtml(candidate.resource_name ?? candidate.resource_id ?? t('resources.resource'))}</h3><p><strong>${escapeHtml(candidate.property_name ?? t('resources.user_properties'))}</strong> · ${escapeHtml(candidate.property_kind ?? '')}</p><p class="resource-property-candidate-value">${escapeHtml(candidateValue(candidate.value))}</p><p>${escapeHtml(t('resources.suggested_by'))} ${escapeHtml(host)} · ${escapeHtml(time(candidate.generated_at))}</p><p><strong>${escapeHtml(t('resources.prompt_version'))}:</strong> ${escapeHtml(promptVersion)}</p><p class="resource-property-candidate-status"><strong>${escapeHtml(t('resources.candidate_status'))}:</strong> ${escapeHtml(statusText)}</p>${evidence}</div><div class="resource-property-candidate-actions">${accept}${edit}${reject}</div></li>`;
  }).join('');
  return `<section class="surface resource-property-candidates" aria-labelledby="suggested-properties-heading"><div><span class="eyebrow">${escapeHtml(t('resources.review'))}</span><h2 id="suggested-properties-heading">${escapeHtml(t('resources.suggested_properties'))}</h2><p class="muted">${escapeHtml(t('resources.suggestions_help'))}</p></div><ul class="resource-property-candidate-list">${items}</ul></section>`;
}

function resourcePropertyCandidateHistory(view) {
  const candidates = (view.property_candidate_history ?? []).slice(0, 10);
  if (!candidates.length) return '';
  const decision = { accept: t('resources.accepted'), edit_accept: t('resources.edited_accepted'), reject: t('resources.rejected') };
  const application = { not_applied: t('resources.not_applied'), current: t('resources.status_current'), superseded: t('resources.later_changed'), undone: t('resources.undone'), unknown: t('resources.application_unknown') };
  const source = { current: t('resources.source_current'), changed: t('work.source_changed'), missing: t('work.source_missing'), unknown: t('resources.source_inspection_unknown') };
  const items = candidates.map((candidate) => {
    const action = candidate.decision?.action;
    const resource = candidate.desktop_href
      ? `<a class="text-link" href="${escapeHtml(candidate.desktop_href)}">${escapeHtml(candidate.resource_name ?? candidate.resource_id ?? t('resources.resource'))}</a>`
      : escapeHtml(candidate.resource_name ?? candidate.resource_id ?? t('resources.resource'));
    const actual = candidate.current_value == null ? t('resources.no_current_value') : candidateValue(candidate.current_value.value);
    const applied = candidate.applied_value == null ? t('resources.no_accepted_value') : candidateValue(candidate.applied_value.value);
    return `<li class="resource-property-candidate"><div class="resource-property-candidate-summary"><h3>${resource}</h3><p><strong>${escapeHtml(candidate.property_name ?? t('resources.property'))}</strong> · ${h('resources.suggested_value',{value:candidateValue(candidate.value)})}</p><p><strong>${h('resources.decision')}</strong> ${escapeHtml(decision[action] ?? t('resources.decision_missing'))} · ${escapeHtml(application[candidate.application_status] ?? t('resources.application_unknown'))}</p><p><strong>${h('resources.actual_value')}</strong> ${escapeHtml(actual)}</p><p><strong>${h('resources.accepted_value')}</strong> ${escapeHtml(applied)}</p><p><strong>${h('resources.source_label')}</strong> ${escapeHtml(source[candidate.source_status] ?? t('resources.source_inspection_unknown'))}</p></div></li>`;
  }).join('');
  return `<details class="surface resource-property-candidates" aria-label="${h('resources.history')}"><summary>${h('resources.history_count',{count:candidates.length})}</summary><ul class="resource-property-candidate-list">${items}</ul></details>`;
}

function rowPropertyCandidateSections(view, csrfToken) {
  const batches = view.row_property_candidate_batches ?? [];
  if (!batches.length || !view.row_property_candidate_decision_action) return '';
  const batchesHtml = batches.map((batch) => {
    const candidates = batch.candidates.map((candidate) => {
      const status = candidate.status === 'needs_review' ? t('row_candidates.needs_review') : candidate.status;
      const csv = candidate.locator?.format === 'csv';
      const locator = csv
        ? `${t('row_candidates.csv_record')} · ${candidate.locator.column}=${candidate.locator.value} · ${candidate.current_record_number ?? '—'}`
        : candidate.locator?.kind === 'key'
          ? `${candidate.sheet} · ${candidate.locator.column}=${candidate.locator.value} · row ${candidate.current_cells?.[0]?.cell?.replace(/[A-Z]/gu, '') ?? '—'}`
          : `${candidate.sheet} · row ${candidate.locator?.row ?? '—'}`;
      const cells = (candidate.evidence?.cells ?? []).join(', ');
      const common = `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="candidate_id" value="${escapeHtml(candidate.candidate_id)}"><input type="hidden" name="expected_revision" value="${escapeHtml(candidate.revision)}"><input type="hidden" name="expected_row_version" value="${escapeHtml(candidate.current_row_sha256 ?? '')}">`;
      const canReview = ['pending', 'needs_review'].includes(candidate.status);
      const currentCellReferences = (candidate.current_cells ?? []).map((cell) => csv ? cell.column : cell.cell).filter(Boolean).join(',');
      const actions = canReview ? `<form method="post" action="${escapeHtml(view.row_property_candidate_decision_action)}">${common}<input type="hidden" name="action" value="accept"><button class="action-button" type="submit" ${candidate.can_accept ? '' : 'disabled'}>${h('resources.accept')}</button></form><form method="post" action="${escapeHtml(view.row_property_candidate_decision_action)}">${common}<input type="hidden" name="action" value="edit_accept"><label>${h('resources.edit_proposed_value')} <input name="value" value="${escapeHtml(candidateInputValue(candidate.value))}" required></label><label>${h('row_candidates.evidence')} <input name="evidence" value="${escapeHtml(candidate.evidence?.summary ?? '')}" required></label><label>Current row cells <input name="evidence_cells" value="${escapeHtml(currentCellReferences)}" required></label><button class="action-button action-button-secondary" type="submit">${h('resources.edit_and_accept')}</button></form><form method="post" action="${escapeHtml(view.row_property_candidate_decision_action)}">${common}<input type="hidden" name="action" value="reject"><button class="text-link" type="submit">${h('resources.reject')}</button></form>` : '';
      return `<li class="resource-property-candidate status-${escapeHtml(candidate.status)}" data-row-candidate-id="${escapeHtml(candidate.candidate_id)}"><h3>${escapeHtml(candidate.resource_name ?? candidate.resource_id)} · ${escapeHtml(locator)}</h3><p>${escapeHtml(candidate.property_name)}: ${escapeHtml(candidateValue(candidate.value))}</p><p>${escapeHtml(t('row_candidates.evidence'))}: ${escapeHtml(candidate.evidence?.summary ?? '')} · ${escapeHtml(cells)}</p><p>${escapeHtml(status)}</p>${candidate.accepted_row_value ? `<p>${escapeHtml(t('row_candidates.accepted_value'))}: ${escapeHtml(candidateValue(candidate.accepted_row_value.value))}</p>` : ''}<div class="resource-property-candidate-actions">${actions}</div></li>`;
    }).join('');
    return `<div class="row-property-candidate-batch" data-row-candidate-batch="${escapeHtml(batch.batch_id)}"><h3>${escapeHtml(batch.property_id)} · ${escapeHtml(batch.prompt_version)} · ${escapeHtml(batch.phase)}</h3><ul class="resource-property-candidate-list">${candidates}</ul></div>`;
  }).join('');
  return `<section class="surface row-property-candidates"><h2>${escapeHtml(t('row_candidates.title'))}</h2><p>${escapeHtml(t('row_candidates.help'))}</p>${batchesHtml}</section>`;
}

function resourceViewMember(model, member, csrfToken) {
  const resource = member.resource ?? member;
  const name = resource.name ?? resource.display_name ?? resource.relative_path ?? resource.resource_id ?? t('resources.resource');
  const type = resource.type ?? resource.extension ?? t('resources.file');
  const href = resourceHref(model, resource);
  const open = resource.relative_path ? `<form method="post" action="${escapeHtml(`${model.base}/resources/open`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><button class="text-link" type="submit">${h('resources.open')}</button></form>` : '';
  return { resource, name, type, href, open: readerLink(model, resource) + open, externalChange: externalChange(resource, member) };
}

function resourceViewContent(model, csrfToken, locale, languageCatalog) {
  const view = model.resource_view;
  const members = view.members ?? [];
  const configuredFields = view.temporary_config?.visible_fields ?? view.active_view?.config?.visible_fields ?? [];
  const definitions = (view.property_definitions ?? []).filter((definition) => !configuredFields.length
    || configuredFields.includes(definition.property_id) || configuredFields.includes(definition.name));
  const mode = view.mode === 'cards' ? 'cards' : 'table';
  const rows = members.map((member) => resourceViewMember(model, member, csrfToken, locale, languageCatalog));
  const groupBy = view.temporary_config?.group_by ?? view.active_view?.config?.group_by ?? null;
  const groupValue = (member) => {
    const resource = member.resource ?? member;
    if (!groupBy) return null;
    if (groupBy === 'type') return resource.type ?? resource.extension ?? t('resources.other');
    if (groupBy === 'extension') return resource.extension || t('resources.no_extension');
    if (groupBy.startsWith('property:')) {
      const stored = (member.properties ?? resource.properties ?? {})[groupBy.slice('property:'.length)];
      const value = stored && typeof stored === 'object' && !Array.isArray(stored) && Object.hasOwn(stored, 'value') ? stored.value : stored;
      return Array.isArray(value) ? value.join(' · ') || t('resources.no_value') : value ?? t('resources.no_value');
    }
    return resource[groupBy] ?? t('resources.other');
  };
  const returnTo = resourceViewModeHref(model, mode);
  const propertyDefinition = view.property_define_action ? `<form method="post" action="${escapeHtml(view.property_define_action)}" class="resource-property-definition"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><label>${h('resources.property_name')} <input name="name" required maxlength="80"></label><label>${h('resources.kind')} <select name="kind"><option value="text">${h('work.text')}</option><option value="single">${h('resources.single_select')}</option><option value="multi">${h('resources.multi_select')}</option></select></label><label>${h('resources.options')} <input name="options" placeholder="${h('resources.select_placeholder')}"></label><button class="action-button action-button-secondary" type="submit">${h('resources.add_property')}</button></form>` : '';
  const expectedVersions = Object.fromEntries(members.map((member) => {
    const resource = member.resource ?? member;
    const values = member.properties ?? member.property_values ?? resource.properties ?? {};
    return [resource.resource_id, Object.fromEntries(Object.entries(values).map(([propertyId, stored]) => [propertyId, stored?.revision ?? 0]))];
  }));
  const propertyEdit = view.property_apply_action && definitions.length && members.length ? `<form id="resource-property-batch" method="post" action="${escapeHtml(view.property_apply_action)}" class="resource-property-batch"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><input type="hidden" name="expected_versions" value="${escapeHtml(JSON.stringify(expectedVersions))}"><label>${h('resources.property')} <select name="property_id" required>${definitions.map((definition) => `<option value="${escapeHtml(definition.property_id)}">${escapeHtml(definition.name)}</option>`).join('')}</select></label><label>${h('resources.change')} <select name="operation"><option value="replace">${h('resources.replace')}</option><option value="add">${h('resources.add')}</option><option value="remove">${h('work.remove')}</option></select></label><label>${h('work.value')} <input name="value" placeholder="${h('resources.multi_value_hint')}"></label><button class="action-button" type="submit">${h('resources.apply_selected')}</button></form>` : '';
  const undo = view.property_undo?.batch_id && view.property_undo_action ? `<form method="post" action="${escapeHtml(view.property_undo_action)}" class="resource-property-undo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="batch_id" value="${escapeHtml(view.property_undo.batch_id)}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button class="text-link" type="submit">${h('resources.undo_property_change')}</button></form>` : '';
  const propertyCandidates = resourcePropertyCandidates(view, csrfToken, returnTo, locale, languageCatalog);
  const propertyCandidateHistory = resourcePropertyCandidateHistory(view);
  const rowCandidates = rowPropertyCandidateSections(view, csrfToken);
  const clearFiltersHref = `${model.base}/resources?mode=${encodeURIComponent(mode)}`;
  const showAllHref = `${model.base}/resources?mode=${encodeURIComponent(mode)}&scope_path=.`;
  const empty = `<p class="resource-view-empty">${h('resources.no_resources_returned')}</p><div class="resource-view-empty-actions" data-resource-view-empty-actions><a class="text-link" data-resource-view-clear-filters data-resource-property-empty-action href="${escapeHtml(clearFiltersHref)}" tabindex="0">${h('resources.clear_filters')}</a><a class="text-link" data-resource-view-show-all href="${escapeHtml(showAllHref)}" tabindex="0">${h('resources.show_all_resources')}</a></div>`;
  let previousGroup = Symbol('first');
  const tableRows = rows.map(({ resource, name, type, href, open }, index) => {
    const currentGroup = groupValue(members[index]);
    const heading = groupBy && currentGroup !== previousGroup
      ? `<tr class="resource-view-group"><th colspan="${5 + definitions.length}">${escapeHtml(currentGroup)}</th></tr>` : '';
    previousGroup = currentGroup;
    return `${heading}<tr data-resource-property-focus="${escapeHtml(resource.resource_id)}"${readerRowAttributes(model, resource)}><td>${workSelectionControl(model, resource)}</td><td><input form="resource-property-batch" type="checkbox" name="resource_id" value="${escapeHtml(resource.resource_id)}" aria-label="${h('resources.select_property_label',{name})}"></td><td><a class="text-link" data-reader-selection href="${escapeHtml(href)}">${escapeHtml(name)}</a><small>${escapeHtml(resource.relative_path ?? '')}</small></td><td>${escapeHtml(type)}</td>${definitions.map((definition) => `<td>${escapeHtml(resourceViewProperty(members[index], definition))}</td>`).join('')}<td>${rows[index].externalChange}</td><td>${open}</td></tr>`;
  }).join('');
  const cardGroups = [];
  rows.forEach((row, index) => {
    const key = String(groupValue(members[index]) ?? '');
    let group = cardGroups.at(-1);
    if (!group || group.key !== key) { group = { key, rows: [] }; cardGroups.push(group); }
    group.rows.push({ ...row, propertyFacts: definitions.map((definition) => [definition.name, resourceViewProperty(members[index], definition)]).filter(([, value]) => value !== '—') });
  });
  const cards = cardGroups.map((group) => `${groupBy ? `<h3 class="resource-view-group-title">${escapeHtml(group.key)}</h3>` : ''}<div class="resource-view-cards">${group.rows.map(({ resource, name, type, href, open, propertyFacts, externalChange: change }) => `<article class="resource-view-card" data-resource-property-focus="${escapeHtml(resource.resource_id)}"${readerRowAttributes(model, resource)}>${workSelectionControl(model, resource)}<label class="resource-view-select"><input form="resource-property-batch" type="checkbox" name="resource_id" value="${escapeHtml(resource.resource_id)}"> ${h('resources.select_properties')}</label>${resource.thumbnail_href ? `<img src="${escapeHtml(resource.thumbnail_href)}" alt="">` : `<span class="resource-view-filetype" aria-label="${escapeHtml(type)} file">${escapeHtml(type)}</span>`}<div><a class="resource-view-member-link" data-reader-selection href="${escapeHtml(href)}"><strong>${escapeHtml(name)}</strong></a><small>${escapeHtml(resource.relative_path ?? type)}</small></div>${propertyFacts.length ? `<dl class="resource-card-properties">${propertyFacts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>` : ''}${change}<div class="inline-actions">${open}</div></article>`).join('')}</div>`).join('');
  const content = mode === 'cards'
    ? rows.length ? cards : empty
    : rows.length ? `<div class="resource-view-table-wrap"><table class="resource-view-table"><thead><tr><th>${h('resources.work')}</th><th>${h('resources.user_properties')}</th><th>${h('resources.resource')}</th><th>${h('resources.type')}</th>${definitions.map((definition) => `<th>${escapeHtml(definition.name ?? definition.property_id ?? t('resources.property'))}</th>`).join('')}<th>${h('resources.file_status')}</th><th>${h('resources.open')}</th></tr></thead><tbody>${tableRows}</tbody></table></div>` : empty;
  return `<main class="page resource-view-page" data-work-selection-context data-project-base="${escapeHtml(model.base)}" data-csrf="${escapeHtml(csrfToken ?? '')}" data-selected-folder="${escapeHtml(model.selected_folder_path ?? '')}" data-focus-path="${escapeHtml(model.focused_resource?.relative_path ?? '')}" data-active-view-id="${escapeHtml(view.active_view?.view_id ?? '')}"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('resources.project_resources'))}</span><h1>${escapeHtml(t(mode === 'cards' ? 'resources.resource_cards' : 'resources.resource_table'))}</h1><p class="lede">${view.active_view ? escapeHtml(view.active_view.name) : escapeHtml(t('resources.current_dynamic_scope'))}</p></div></div>${workSelectionBar(model)}${resourceViewControls(model, csrfToken, locale, languageCatalog)}${resourceViewReceipt(view.evaluation, locale, languageCatalog)}${propertyCandidates}${propertyCandidateHistory}${rowCandidates}<details class="surface resource-property-tools"><summary>${escapeHtml(t('resources.user_properties_edit'))}</summary>${propertyDefinition}${propertyEdit}${undo}</details><section class="surface resource-view-results">${content}</section></main>`;
}

function resourcePinControl(model, resource, csrfToken) {
  if (!resource?.relative_path) return '';
  const id = resource.resource_id ?? `path:${resource.relative_path}`;
  const action = resource.pinned ? 'unpin' : 'pin';
  const returnTo = resourceHref(model, resource);
  return `<form method="post" action="${escapeHtml(`${model.base}/home/pins`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="action" value="${escapeHtml(action)}"><input type="hidden" name="kind" value="resource"><input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button class="action-button action-button-secondary" type="submit">${escapeHtml(resource.pinned ? t('resources.unpin_from_home') : t('resources.pin_to_home'))}</button></form>`;
}

function lastWorked(resource) {
  return resource.last_worked_at ? time(resource.last_worked_at) : t('resources.not_worked');
}

function workSelectionControl(model, resource) {
  if (model.table_work_enabled === false) return '';
  const workType = String(resource?.type ?? resource?.extension ?? '').replace(/^\./u, '').toUpperCase();
  if (!resource?.resource_id || !resource.relative_path || !['CSV', 'XLSX'].includes(workType)) return '';
  const selected = (model.work_selection?.resource_ids ?? []).includes(resource.resource_id);
  return `<label class="workspace-work-source" title="${escapeHtml(selected ? t('resources.remove_selection') : t('resources.add_selection'))}"><input type="checkbox" data-work-source data-resource-id="${escapeHtml(resource.resource_id)}" data-resource-path="${escapeHtml(resource.relative_path)}" ${selected ? 'checked' : ''}><span class="sr-only">${h('resources.selection_label', {action: selected ? t('work.remove') : t('resources.add'), name:resource.name, direction:selected ? 'from' : 'to'})}</span></label>`;
}

function workSelectionBar(model) {
  if (model.table_work_enabled === false) return `<div class="workspace-work-selection module-paused"><span>${h('modules.table_paused_help')}</span><a class="text-link" href="/modules">${h('modules.open')}</a></div>`;
  const count = model.work_selection?.count ?? 0;
  const workHref = model.work_selection?.review_href ?? '';
  return `<div class="workspace-work-selection${count ? '' : ' is-empty'}"><strong data-work-source-count>${count ? h('resources.selected_files', {count}) : h('resources.no_files_selected')}</strong><a class="action-button${count ? '' : ' is-disabled'}" data-work-open href="${escapeHtml(workHref || '#')}" aria-disabled="${count ? 'false' : 'true'}">${h('resources.review_work_target')}</a><span class="muted" data-work-source-notice></span></div>`;
}

function fileRow(model, resource, focused) {
  const stateLabels = { changed: t('resources.changed_since'), missing: t('resources.file_missing'), unchanged: t('resources.unchanged_since'), running: t('resources.working'), waiting: t('resources.waiting'), failed: resource.activity?.error_message || t('resources.work_stopped') };
  const externalStatus = externalChangeStatus(resource);
  const displayState = externalStatus ?? resource.state;
  const stateLabel = externalChangeCopy(externalStatus) ?? stateLabels[displayState] ?? displayState;
  const stateShort = { changed: t('resources.status_changed'), unchanged: t('resources.status_current'), missing: t('work.missing'), not_checked: t('work.not_checked') }[displayState] ?? stateLabel;
  const state = displayState ? `<span class="workspace-tree-state workspace-tree-state-${escapeHtml(displayState)}" title="${escapeHtml(stateLabel)}"><span class="workspace-tree-state-dot" aria-hidden="true"></span><span class="workspace-tree-state-label">${escapeHtml(stateShort)}</span></span>` : '';
  const category = resource.saved_work ? t('resources.created_result') : resource.added_from ? t('resources.added_project') : t('resources.project_file');
  const relationshipText = resource.saved_work?.source_path ? t('resources.created_file', {name:resource.saved_work.source_path.split(/[\\/]/u).pop()}) : resource.added_from?.origin_file ? t('resources.added_file', {name:resource.added_from.origin_file.split(/[\\/]/u).pop()}) : t('resources.no_relationship');
  const stateText = stateLabel ?? t('resources.no_change_state');
  const selector = workSelectionControl(model, resource) || `<span class="workspace-work-source workspace-work-source-disabled" title="${h('resources.work_supports_tables')}"></span>`;
  const lastUsed = resource.last_worked_at
    ? `<time class="workspace-resource-last-used" datetime="${escapeHtml(resource.last_worked_at)}">${escapeHtml(lastWorked(resource))}</time>`
    : `<span class="workspace-resource-last-used">${escapeHtml(lastWorked(resource))}</span>`;
  return `<div class="workspace-resource-file-row" data-resource-row data-resource-name="${escapeHtml(resource.name)}">${selector}<a class="workspace-resource-file${focused ? ' is-focused' : ''}" href="${escapeHtml(resourceHref(model, resource))}" data-resource-path="${escapeHtml(resource.relative_path)}" data-resource-name="${escapeHtml(resource.name)}"${focused ? ' data-focused-resource tabindex="-1"' : ''} data-open-resource${readerRowAttributes(model, resource)} data-reader-selection data-resource-context data-context-title="${escapeHtml(resource.name)}" data-context-body="${escapeHtml(`${category} · ${stateText} · ${relationshipText}`)}"><span class="workspace-resource-file-name"><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(category)}</small></span><span class="workspace-resource-file-type">${escapeHtml(resource.type)}</span>${lastUsed}${state}</a></div>`;
}

function folderContainsPath(folder, focusedPath) {
  if (!focusedPath) return false;
  return folder.files.some((resource) => resource.relative_path === focusedPath)
    || folder.folders.some((child) => folderContainsPath(child, focusedPath));
}

function treeFolder(model, folder, depth, focusedPath) {
  const children = folder.folders.map((child) => treeFolder(model, child, depth + 1, focusedPath)).join('');
  if (!folder.folders.length) {
    return `<div class="workspace-tree-folder"><a class="workspace-tree-folder-row workspace-tree-folder-leaf" href="${escapeHtml(`${model.base}/resources?folder=${encodeURIComponent(folder.relative_path)}`)}" style="--tree-depth:${depth}" data-folder-select data-folder-path="${escapeHtml(folder.relative_path)}" title="${h('resources.select_this_folder')}"><span>${escapeHtml(folder.name)}</span></a></div>`;
  }
  const open = folderContainsPath(folder, focusedPath);
  return `<div class="workspace-tree-folder" data-project-folder data-folder-path="${escapeHtml(folder.relative_path ?? '')}" data-folder-open="${open ? 'true' : 'false'}"><button class="workspace-tree-folder-toggle" type="button" style="--tree-depth:${depth}" data-folder-toggle aria-expanded="${open ? 'true' : 'false'}" aria-label="${escapeHtml(open ? t('resources.collapse') : t('resources.expand'))} ${escapeHtml(folder.name)}"></button><a class="workspace-tree-folder-row" href="${escapeHtml(`${model.base}/resources?folder=${encodeURIComponent(folder.relative_path)}`)}" style="--tree-depth:${depth}" data-folder-select data-folder-path="${escapeHtml(folder.relative_path)}" title="${h('resources.select_this_folder')}"><span>${escapeHtml(folder.name)}</span></a><div class="workspace-tree-folder-children"${open ? '' : ' hidden'}>${children}</div></div>`;
}

function compactFolderNavigator(model, tree) {
  const folders = [{ relative_path: '', label: t('resources.project_root') }];
  const collect = (children) => children.forEach((folder) => {
    folders.push({ relative_path: folder.relative_path, label: folder.relative_path.split('/').join(' / ') });
    collect(folder.folders ?? []);
  });
  collect(tree.folders ?? []);
  return `<nav class="workspace-compact-folder-nav" aria-label="${h('resources.project_folders')}"><span>${h('resources.folders')}</span>${folders.map((folder) => `<a href="${escapeHtml(`${model.base}/resources?folder=${encodeURIComponent(folder.relative_path)}`)}"${folder.relative_path === model.selected_folder_path ? ' aria-current="page"' : ''}>${escapeHtml(folder.label)}</a>`).join('')}</nav>`;
}

function folderFileGroup(model, node, folderPath = '') {
  const selected = folderPath === model.selected_folder_path;
  const complete = model.truncated !== true || (selected && model.selected_folder_loaded === true);
  const files = node.files.length
    ? node.files.map((resource) => fileRow(model, resource, resource.relative_path === model.focused_resource?.relative_path)).join('')
    : complete
      ? `<p class="workspace-empty">${h('resources.no_regular_files')}</p>`
      : `<p class="workspace-empty">${h('resources.select_folder_load')}</p>`;
  return `<section class="workspace-folder-files" data-folder-files="${escapeHtml(folderPath)}" data-folder-loaded="${complete ? 'true' : 'false'}"${selected ? '' : ' hidden'}><div class="workspace-resource-columns"><span>${h('resources.work')}</span><button class="workspace-column-sort" type="button" data-resource-name-sort data-sort-direction="asc" aria-label="${h('resources.sort_name_desc_label')}">${h('resources.sort_name_asc')}</button><span class="workspace-resource-file-type">${h('resources.type')}</span><span class="workspace-resource-last-used">${h('resources.last_used')}</span><span>${h('resources.state')}</span></div>${files}</section>`;
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

function renderProjectResourceFolderGroup(model) {
  const folderPath = model.selected_folder_path ?? '';
  const node = treeNodeAtPath(model.tree ?? { folders: [], files: [] }, folderPath);
  return node ? folderFileGroup(model, node, folderPath) : '';
}

function relationship(model, resource, csrfToken) {
  const input = resource.saved_work?.source_path ?? resource.added_from?.origin_file ?? null;
  const downstream = resource.created_work?.[0] ?? null;
  const nodes = [input ? { name: input.split(/[\\/]/u).pop(), label: resource.saved_work ? t('resources.created_from') : t('resources.added_from') } : null, { name: resource.name, label: t('resources.selected_resource') }, downstream ? { name: downstream.name, label: t('resources.created_work') } : null].filter(Boolean);
  const projectRelationships = (resource.resource_fact?.relationships ?? resource.relationships ?? [])
    .filter((item) => item.status === 'active' && item.target_kind === 'project' && ['stored_in', 'used_by'].includes(item.type));
  const lineage = nodes.length > 1 ? `<div class="workspace-relationship-route">${nodes.map((node, index) => `${index ? '<span class="workspace-route-arrow" aria-hidden="true">→</span>' : ''}<div><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(node.label)}</small></div>`).join('')}</div>` : '';
  const projects = projectRelationships.length ? `<div class="workspace-relationship-route">${projectRelationships.map((item, index) => {
    const projectName = item.target_name ?? (item.target_id === model.project.id ? model.project.name : item.target_id);
    return `${index ? '<span class="workspace-route-arrow" aria-hidden="true">·</span>' : ''}<div><small>${escapeHtml(item.type === 'stored_in' ? t('resources.stored_in') : t('resources.used_by'))}</small><strong>${escapeHtml(projectName)}</strong></div>`;
  }).join('')}</div>` : '';
  const linkedItems = resource.linked_relationships ?? resource.resource_fact?.linked_relationships ?? [];
  const linkedRows = linkedItems.map((item) => {
    const outgoing = item.direction === 'outgoing';
    const otherName = outgoing ? item.target_name : item.source_name;
    const otherId = outgoing ? item.target_id : item.source_resource_id;
    const otherHref = outgoing ? item.target_href : item.source_href;
    const remove = item.status === 'active' && model.resource_view?.link_action ? `<form method="post" action="${escapeHtml(model.resource_view.link_action)}/preview" class="resource-link-remove"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="operation" value="remove"><input type="hidden" name="source_resource_id" value="${escapeHtml(item.source_resource_id)}"><input type="hidden" name="target_resource_id" value="${escapeHtml(item.target_id)}"><input type="hidden" name="relationship_id" value="${escapeHtml(item.id)}"><input type="hidden" name="reason" value="User requested removal in Resources."><button class="text-link" type="submit">${h('resources.resource_link_remove')}</button></form>` : '';
    return `<li data-resource-link-id="${escapeHtml(item.id)}" data-resource-link-direction="${outgoing ? 'outgoing' : 'incoming'}"><span>${h(outgoing ? 'resources.resource_link_outgoing' : 'resources.resource_link_incoming')}</span> <a class="text-link" href="${escapeHtml(otherHref ?? '#')}">${escapeHtml(otherName ?? otherId)}</a><small class="mono">${escapeHtml(otherId)} · ${escapeHtml(item.id)}</small><small>${escapeHtml(item.status === 'active' ? t('resources.resource_link_active') : t('resources.resource_link_removed'))}</small>${item.needs_review ? `<small>${h('resources.resource_link_needs_review')}</small>` : ''}<small>${h('resources.resource_link_file_status')}</small>${remove}</li>`;
  }).join('');
  const linkTargets = (model.resource_view?.linked_resources ?? []).filter((item) => item.resource_id !== resource.resource_id);
  const addLink = resource.resource_id && resource.open_available !== false && linkTargets.length && model.resource_view?.link_action ? `<form method="post" action="${escapeHtml(model.resource_view.link_action)}/preview" class="resource-link-add"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="operation" value="add"><input type="hidden" name="source_resource_id" value="${escapeHtml(resource.resource_id)}"><label>${h('resources.resource_link_target')} <select name="target_resource_id" required>${linkTargets.map((item) => `<option value="${escapeHtml(item.resource_id)}">${escapeHtml(item.name)} · ${escapeHtml(item.resource_id)}</option>`).join('')}</select></label><label>${h('resources.resource_link_reason')} <input name="reason" required maxlength="300"></label><button class="action-button action-button-secondary" type="submit">${h('resources.resource_link_add')}</button></form>` : '';
  const focus = resource.relationship_focus;
  const focusNodeMap = new Map((focus?.nodes ?? []).map((node) => [node.resource_id, node]));
  const focusHref = `${model.base}/resources?resource_id=${encodeURIComponent(resource.resource_id)}&relation_depth=1&relation_status=active`;
  const focusControls = focus ? `<form class="resource-relationship-focus-controls" method="get" action="${escapeHtml(`${model.base}/resources`)}"><input type="hidden" name="resource_id" value="${escapeHtml(resource.resource_id)}"><label>${h('relationship_focus.depth')} <select name="relation_depth"><option value="1"${focus.depth === 1 ? ' selected' : ''}>1</option><option value="2"${focus.depth === 2 ? ' selected' : ''}>2</option></select></label><label>${h('relationship_focus.status')} <select name="relation_status">${[['active','relationship_focus.active'],['removed','relationship_focus.removed'],['all','relationship_focus.all']].map(([value,key]) => `<option value="${value}"${focus.status === value ? ' selected' : ''}>${h(key)}</option>`).join('')}</select></label><button class="action-button action-button-secondary" type="submit">${h('relationship_focus.open')}</button></form>` : '';
  const focusEdges = (focus?.edges ?? []).map((edge) => {
    const source = focusNodeMap.get(edge.source_resource_id);
    const target = focusNodeMap.get(edge.target_id);
    const endpointLink = (node) => node?.relative_path ? `<a class="text-link" href="${escapeHtml(resourceHref(model,{resource_id:node.resource_id,relative_path:node.relative_path}))}">${escapeHtml(node.name)}</a><small class="mono">${escapeHtml(node.resource_id)}</small>` : `<span>${escapeHtml(node?.resource_id ?? '')}</span>`;
    return `<li data-relationship-focus-edge="${escapeHtml(edge.id)}"><span>${h(`relationship_focus.${edge.direction}`)} · ${h('relationship_focus.hop_value',{hop:edge.hop})}</span><div>${endpointLink(source)} <span aria-hidden="true">→</span> ${endpointLink(target)}</div><small class="mono">${escapeHtml(edge.id)} · ${escapeHtml(edge.status)}</small><p><strong>${h('relationship_focus.evidence')}</strong> ${escapeHtml(JSON.stringify(edge.evidence ?? {}))}</p>${edge.needs_review ? `<p class="callout warn">${h('relationship_focus.needs_review')}</p>` : ''}<p class="muted">${h('relationship_focus.file_not_checked')}</p></li>`;
  }).join('');
  const focusPanel = resource.resource_id ? `<details class="workspace-resource-links resource-relationship-focus"${resource.relationship_focus_expanded ? ' open' : ''}><summary>${h('relationship_focus.title')}</summary><p class="muted">${h('relationship_focus.help')}</p>${focusControls}${!focus ? `<p><a class="text-link" href="${escapeHtml(focusHref)}">${h('relationship_focus.open')}</a></p>` : ''}${resourceFocusGraph(resource,t,h)}${focus ? `<p class="muted">${h('relationship_focus.node_count',{count:focus.nodes.length})}${focus.truncated ? ` · ${h('relationship_focus.truncated')}` : ''}</p>${focusEdges ? `<details class="resource-focus-records"><summary>${h('workspace.graph_links')}</summary><ul class="path-list">${focusEdges}</ul></details>` : `<p class="muted">${h('relationship_focus.empty')}</p>`}` : ''}</details>` : '';
  const linked = resource.resource_id ? `<section class="workspace-resource-links"><h3>${h('resources.resource_links')}</h3>${linkedRows ? `<ul class="path-list">${linkedRows}</ul>` : `<p class="muted">${h('resources.no_extra_relationships')}</p>`}${addLink ? `<details class="resource-link-create-disclosure"><summary>${h('resources.resource_link_add')}</summary>${addLink}</details>` : ''}</section>` : '';
  return `<section class="workspace-relationship"><h3>${h('resources.known_relationships')}</h3>${lineage}${projects}${!lineage && !projects ? `<p class="muted">${h('resources.no_extra_relationships')}</p>` : ''}</section>${focusPanel}${linked}`;
}

function resourceFocusGraph(resource, t, h) {
  const graph = resource.resource_focus_graph;
  if (!graph) return '';
  const arrowId = `focus-arrow-${resource.resource_id}`;
  const column = (node) => node.kind === 'resource' ? Math.min(node.hop ?? 0, 2) : node.kind === 'work' ? 3 : 4;
  const columns = [...new Set(graph.nodes.map(column))].sort((left, right) => left - right);
  const xFor = (node) => 40 + columns.indexOf(column(node)) * 250;
  const width = Math.max(250, columns.length * 250);
  const grouped = new Map();
  for (const node of graph.nodes) grouped.set(column(node), [...(grouped.get(column(node)) ?? []), node]);
  const rowFor = new Map();
  for (const group of grouped.values()) group.forEach((node, index) => rowFor.set(node.id, index));
  const yFor = (node) => 36 + (rowFor.get(node.id) ?? 0) * 82;
  const height = Math.max(180, ...[...grouped.values()].map((items) => 70 + items.length * 82));
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const svgEdges = graph.edges.map((edge) => {
    const source = nodeMap.get(edge.source); const target = nodeMap.get(edge.target);
    if (!source || !target) return '';
    const sx = xFor(source) + 210; const sy = yFor(source) + 32; const tx = xFor(target); const ty = yFor(target) + 32; const mid = (sx + tx) / 2;
    return `<path data-focus-graph-edge="${escapeHtml(edge.id)}" data-edge-kind="${escapeHtml(edge.kind)}" d="M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}" marker-end="url(#${escapeHtml(arrowId)})" fill="none" stroke="${edge.kind === 'linked_to' ? '#647d62' : '#bd8731'}" stroke-width="2"${edge.status === 'removed' ? ' stroke-dasharray="5 4"' : ''}><title>${escapeHtml(edge.kind === 'linked_to' ? edge.relationship_id : edge.derived_kind)}</title></path>`;
  }).join('');
  const nodeKindKey = (node) => node.kind === 'resource' ? 'relationship_focus.resource_node' : node.kind === 'work' ? 'relationship_focus.work_node' : 'relationship_focus.result_node';
  const nodeFreshness = (node) => typeof node.freshness === 'string' ? node.freshness : node.freshness?.label ?? node.freshness?.status ?? null;
  const svgNodes = graph.nodes.map((node) => {
    const x = xFor(node); const y = yFor(node); const key = nodeKindKey(node);
    const related = node.kind === 'work' ? (resource.related_work ?? []).find((item) => item.session_id === node.session_id) : null;
    const label = String(related?.intent || node.label || node.id);
    const status = nodeFreshness(node);
    const shortened = [...label].slice(0, 27).join('') + ([...label].length > 27 ? '…' : '');
    const visibleStatus = status && WORK_COPY_KEYS[status] ? t(WORK_COPY_KEYS[status]) : status;
    const content = `<rect class="resource-focus-node${node.id === `resource:${resource.resource_id}` ? ' is-current' : ''}" x="${x}" y="${y}" width="210" height="64" rx="8"/><text class="resource-focus-kind" x="${x + 10}" y="${y + 17}" font-size="11">${h(key)}</text><text class="resource-focus-name" x="${x + 10}" y="${y + 35}" font-size="13">${escapeHtml(shortened)}</text>${visibleStatus ? `<text class="resource-focus-state" x="${x + 10}" y="${y + 53}" font-size="11">${escapeHtml(visibleStatus)}</text>` : ''}`;
    const description = `${t(key)}: ${label}${status ? ` · ${status}` : ''}`;
    return node.href ? `<a href="${escapeHtml(node.href)}" tabindex="0" aria-label="${escapeHtml(description)}"><title>${escapeHtml(description)}</title>${content}</a>` : `<g role="img" aria-label="${escapeHtml(description)}"><title>${escapeHtml(description)}</title>${content}</g>`;
  }).join('');
  const textNodes = graph.nodes.map((node) => `<li data-focus-graph-node="${escapeHtml(node.id)}"><a class="text-link" href="${escapeHtml(node.href)}">${escapeHtml(`${t(nodeKindKey(node))} · ${node.label}`)}</a>${nodeFreshness(node) ? ` · ${escapeHtml(nodeFreshness(node))}` : ''} <small class="mono">${escapeHtml(node.id)}</small></li>`).join('');
  const textEdges = graph.edges.map((edge) => {
    const line = edge.kind === 'linked_to'
      ? `${t(`relationship_focus.${edge.direction}`)} · ${edge.status} · ${edge.relationship_id} · ${JSON.stringify(edge.evidence ?? {})}${edge.needs_review ? ` · ${t('relationship_focus.needs_review')}` : ''}`
      : `${t(edge.derived_kind === 'source_to_work' ? 'relationship_focus.source_to_work' : 'relationship_focus.work_to_result')} · ${edge.work_session_id ?? ''} · ${edge.save_id ?? ''}${edge.impact?.label ? ` · ${edge.impact.label}` : ''}`;
    return `<li data-focus-graph-edge="${escapeHtml(edge.id)}" data-edge-kind="${escapeHtml(edge.kind)}">${escapeHtml(line)}</li>`;
  }).join('');
  return `<section class="resource-focus-graph" data-resource-focus-graph><h4>${h('relationship_focus.graph_title')}</h4><p class="muted">${h('workspace.graph_scroll')}</p><div class="resource-focus-legend"><span>${h('workspace.graph_stored')}</span><span>${h('workspace.graph_processing')}</span></div><div class="resource-focus-canvas"><svg role="img" aria-label="${h('relationship_focus.graph_title')}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="width:${width}px;max-width:none"><defs><marker id="${escapeHtml(arrowId)}" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M 0 0 L 6 3 L 0 6 Z" fill="context-stroke"/></marker></defs>${svgEdges}${svgNodes}</svg></div><p class="muted">${h('relationship_focus.file_not_checked')}${graph.truncated ? ` · ${h('relationship_focus.truncated')}` : ''}</p><details class="resource-focus-records"><summary>${h('workspace.graph_records')}</summary><h5>${h('relationship_focus.graph_nodes')}</h5><ul class="path-list">${textNodes}</ul><h5>${h('relationship_focus.graph_edges')}</h5>${textEdges ? `<ul class="path-list">${textEdges}</ul>` : `<p class="muted">${h('relationship_focus.empty')}</p>`}</details></section>`;
}

function representation(resource) {
  if (!resource.representation) return t('resources.no_representation');
  return [resource.representation.label, ...(resource.representation.facts ?? [])].filter(Boolean).join(' · ');
}

function currentState(resource) {
  const labels = { changed: t('resources.changed_since'), missing: t('resources.file_missing'), running: t('resources.in_progress'), waiting: t('resources.waiting_decision'), failed: resource.activity?.error_message || t('resources.work_stopped'), unchanged: t('resources.unchanged_since') };
  return resource.state ? labels[resource.state] ?? resource.state : null;
}

function recoveryActionControls(model, resource, csrfToken) {
  const actions = resource.actions;
  if (!actions) return '';
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="resource_id" value="${escapeHtml(resource.resource_id)}">`;
  const archive = actions.archive_record ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/archive`)}">${hidden}<button class="action-button" type="submit">${h('resources.archive')}</button></form>` : '';
  const restore = actions.restore_record ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/restore`)}">${hidden}<button class="action-button" type="submit">${h('resources.restore')}</button></form>` : '';
  const relink = actions.relink ? `<div class="workspace-resource-relink"><form method="post" action="${escapeHtml(`${model.base}/resources/actions/relink`)}" data-resource-relink-form>${hidden}<input type="hidden" name="selection_id" value=""><button class="action-button action-button-secondary" type="button" data-resource-relink-picker data-requires-desktop-picker>${h('resources.relink_choose')}</button><span class="muted" data-resource-relink-name data-selected-label="${h('resources.file_selected')}">${h('resources.no_file')}</span><button class="action-button" type="submit" disabled data-resource-relink-confirm>${h('resources.relink')}</button><p class="muted" data-resource-relink-notice data-register-failed="${h('resources.relink_register_failed')}"></p></form><form method="post" action="${escapeHtml(`${model.base}/resources/actions/relink`)}" data-resource-relink-text-form>${hidden}<label>${h('resources.relink_relative_path')}<input name="relative_path" type="text" maxlength="1024" autocomplete="off" required></label><button class="action-button" type="submit">${h('resources.relink_by_path')}</button></form></div>` : '';
  const missing = `${archive}${restore}${relink}`;
  const redo = resource.redo_save ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/redo-save`)}">${hidden}<input type="hidden" name="work_id" value="${escapeHtml(resource.redo_save.save_id)}"><button class="action-button" type="submit">${h('work.redo')}</button></form>` : '';
  const currentVersion = resource.external_change?.current?.sha256 ?? resource.resource_fact?.external_change?.current?.sha256 ?? null;
  const acceptCurrent = externalChangeStatus(resource) === 'changed' && currentVersion
    ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/accept-current`)}">${hidden}<input type="hidden" name="expected_current_version" value="${escapeHtml(currentVersion)}"><button class="action-button" type="submit">${h('resources.accept_current')}</button><p class="muted">${h('resources.baseline_help')}</p></form>` : '';
  const relationships = actions.relationships.map((relationship) => `<div class="workspace-resource-action-row"><span>${escapeHtml(relationship.type === 'used_by' ? t('resources.used_project') : t('resources.stored_project'))}</span>${relationship.can_forget ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/forget`)}">${hidden}<input type="hidden" name="relationship_id" value="${escapeHtml(relationship.id)}"><button class="action-button action-button-secondary" type="submit">${h('resources.forget_relationship')}</button></form>` : ''}${relationship.can_remove_reference ? `<form method="post" action="${escapeHtml(`${model.base}/resources/actions/remove-reference`)}">${hidden}<input type="hidden" name="relationship_id" value="${escapeHtml(relationship.id)}"><button class="action-button action-button-secondary" type="submit">${h('resources.remove_reference')}</button></form>` : ''}</div>`).join('');
  if (!missing && !relationships && !redo && !acceptCurrent) return '';
  return `<section class="workspace-resource-actions"><h3>${h('resources.record_actions')}</h3>${acceptCurrent}${missing}${redo}${relationships}<p class="muted">${h('resources.archive_help')}</p></section>`;
}

function relatedWork(resource, csrfToken, locale, languageCatalog) {
  const items = resource.related_work ?? [];
  if (!items.length) return '';
  const workStatus = (value) => ({ Fresh: t('resources.work_status_fresh'), 'Not checked': t('resources.work_status_not_checked'), 'Source changed': t('resources.work_status_source_changed'), 'Source missing': t('resources.work_status_source_missing') }[value] ?? value);
  const resultStatus = (value) => ({ 'Result missing': t('resources.result_missing'), 'Result changed': t('resources.result_changed'), 'Save undone': t('resources.save_undone'), 'Result not checked': t('resources.result_not_checked'), 'Sources need review': t('resources.sources_need_review'), 'Needs review': t('resources.needs_review') }[value] ?? value);
  const isResultWarning = (value) => ['Result missing', 'Result changed', 'Save undone', 'Result not checked', 'Sources need review', 'Needs review'].includes(value);
  const isWorkWarning = (value) => ['Not checked', 'Source changed', 'Source missing'].includes(value);
  const rows = items.map((item) => {
    const open = item.href ? `<a class="text-link" href="${escapeHtml(item.href)}">${escapeHtml(t('resources.open'))}</a>` : '';
    const reuse = item.reuse_action ? `<form method="post" action="${escapeHtml(item.reuse_action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="base_revision" value="${escapeHtml(item.revision ?? '')}"><button class="text-link" type="submit">${escapeHtml(t('resources.reuse'))}</button></form>` : '';
    const workFreshness = item.freshness_label ?? 'Not checked';
    const resultFreshness = item.result_freshness ?? null;
    const primaryStatus = isResultWarning(resultFreshness) ? resultStatus(resultFreshness) : workStatus(workFreshness);
    const workWarning = isResultWarning(resultFreshness) && isWorkWarning(workFreshness) && workFreshness !== resultFreshness
      ? `<p class="callout warn">${escapeHtml(t('resources.work_notice', { status: workStatus(workFreshness) }))}</p>` : '';
    return `<li><strong>${escapeHtml(item.intent || t('resources.existing_work'))}</strong><small>${escapeHtml(t('resources.work_status'))}: ${escapeHtml(primaryStatus)}</small>${workWarning}${item.notice ? `<p class="callout warn">${escapeHtml(item.notice)}</p>` : ''}${open || reuse ? `<div class="inline-actions">${open}${reuse}</div>` : ''}<details><summary>${escapeHtml(t('resources.work_details'))}</summary><dl><dt>${escapeHtml(t('resources.recipe'))}</dt><dd>${escapeHtml(item.recipe_label ?? t('resources.not_recorded'))}</dd><dt>${escapeHtml(t('resources.result'))}</dt><dd>${escapeHtml(item.result_label ?? t('resources.not_recorded'))}</dd><dt>${escapeHtml(t('resources.revision'))}</dt><dd>${escapeHtml(item.revision ?? t('resources.not_recorded'))}</dd><dt>${escapeHtml(t('resources.updated'))}</dt><dd>${escapeHtml(item.updated_at ? time(item.updated_at) : t('resources.not_recorded'))}</dd><dt>${escapeHtml(t('resources.work_id'))}</dt><dd class="mono">${escapeHtml(item.session_id ?? t('resources.not_recorded'))}</dd></dl></details></li>`;
  }).join('');
  return `<section class="workspace-resource-actions"><h3>${escapeHtml(t('resources.related_work'))}</h3><ul class="path-list workspace-related-work-list">${rows}</ul><p class="muted">${escapeHtml(t('resources.reuse_help'))}</p></section>`;
}

function impactLanes(resource) {
  const lanes = resource.impact_lanes ?? [];
  if (!lanes.length) return '';
  const laneRows = lanes.map((lane) => {
    const source = lane.source ?? {};
    const work = lane.work ?? {};
    const impact = lane.impact ?? {};
    const results = lane.results?.length ? lane.results : [null];
    const workHref = lane.actions?.open_work ?? work.href;
    const routes = results.map((result) => {
      const resultHref = result?.href ?? lane.actions?.open_result;
      const workFreshness = typeof work.freshness === 'string' ? work.freshness : work.freshness?.label ?? work.freshness?.status;
      const resultFreshness = typeof result?.freshness === 'string' ? result.freshness : result?.freshness?.label ?? result?.freshness?.status;
      const sourceNode = `<div><small>${h('work.source')}${source.change_state ? ` · ${escapeHtml(source.change_state)}` : ''}${source.version_policy ? ` · ${escapeHtml(source.version_policy)}` : ''}</small><strong>${escapeHtml(source.name ?? source.path ?? source.resource_id ?? t('work.not_recorded'))}</strong>${source.path ? `<small>${escapeHtml(source.path)}</small>` : ''}</div>`;
      const workNode = `<div><small>${h('resources.work')}${work.recipe_version != null ? ` · ${h('work.recipe')} ${escapeHtml(work.recipe_version)}` : ''}${work.revision != null ? ` · ${h('work.revision')} ${escapeHtml(work.revision)}` : ''}${workFreshness ? ` · ${escapeHtml(workFreshness)}` : ''}</small><strong>${escapeHtml(work.session_id ?? t('work.not_recorded'))}</strong></div>`;
      const resultNode = result
        ? `<div><small>${h('work.result')}${result.output_state ? ` · ${escapeHtml(result.output_state)}` : ''}${resultFreshness ? ` · ${escapeHtml(resultFreshness)}` : ''}</small><strong>${escapeHtml(result.name ?? result.path ?? result.resource_id ?? result.save_id ?? t('work.not_recorded'))}</strong>${result.path ? `<small>${escapeHtml(result.path)}</small>` : ''}</div>`
        : `<div><small>${h('work.result')}</small><strong>${h('resources.no_saved_result')}</strong></div>`;
      const actions = `${workHref ? `<a class="text-link" href="${escapeHtml(workHref)}">${h('resources.open_work')}</a>` : ''}${result && resultHref ? `<a class="text-link" href="${escapeHtml(resultHref)}">${h('resources.open_result')}</a>` : ''}`;
      return `<div class="workspace-relationship-route">${sourceNode}<span class="workspace-route-arrow" aria-hidden="true">→</span>${workNode}<span class="workspace-route-arrow" aria-hidden="true">→</span>${resultNode}</div>${actions ? `<div class="inline-actions">${actions}</div>` : ''}`;
    }).join('');
    const impactCopy = [impact.label ?? impact.status, impact.reason].filter(Boolean).map((value) => escapeHtml(value)).join(' · ');
    return `<li>${impactCopy ? `<p><strong>${h('resources.impact')}</strong> ${impactCopy}</p>` : ''}${routes}</li>`;
  }).join('');
  return `<details class="workspace-resource-actions workspace-impact-details"><summary>${h('resources.relationship_impact')}</summary><ul class="path-list">${laneRows}</ul></details>`;
}

function boardReferences(model, resource, csrfToken) {
  if (!resource.resource_id) return '';
  const references = resource.board_references ?? [];
  const linked = references.length ? `<ul class="path-list">${references.map((item) => `<li>${item.href ? `<a class="text-link" href="${escapeHtml(item.href)}">${escapeHtml(item.title ?? item.board_id)}</a>` : `<strong>${escapeHtml(item.title ?? item.board_id)}</strong>`}<small>${h('work.revision')} ${escapeHtml(item.revision ?? t('work.not_recorded'))}</small></li>`).join('')}</ul>` : `<p class="muted">${h('resources.no_board_references')}</p>`;
  const boards = model.boards ?? [];
  const add = boards.length ? `<details><summary>${h('resources.add_resource_board')}</summary><div class="project-home-list">${boards.map((board) => `<form method="post" action="${escapeHtml(`${model.base}/boards/${encodeURIComponent(board.board_id)}/blocks/add`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="base_revision" value="${escapeHtml(board.revision)}"><input type="hidden" name="block_type" value="material_reference"><input type="hidden" name="resource_id" value="${escapeHtml(resource.resource_id)}"><label>${h('work.version')} <select name="version_policy"><option value="follow_latest">${h('work.follow_latest')}</option><option value="pinned_version">${h('work.pin_recorded')}</option></select></label><button class="text-link" type="submit">${h('work.add_to_board',{title:board.title})}</button></form>`).join('')}</div></details>` : '';
  return `<section class="workspace-resource-actions"><h3>${h('resources.referenced_boards')}</h3>${linked}${add}</section>`;
}

function focusPanel(model, csrfToken, locale, languageCatalog) {
  const resource = model.focused_resource;
  if (!resource) return `<aside class="workspace-focus" data-resource-inspector><span class="workspace-kicker">${h('resources.selected_resource')}</span><h2>${h('resources.choose_resource')}</h2><p>${h('resources.choose_resource_help')}</p></aside>`;
  const location = resource.relative_path?.split('/').slice(0, -1).join('/') || resource.last_known_path || t('work.not_available');
  const source = resource.saved_work?.sources?.length ? resource.saved_work.sources.map((item) => item.path?.split(/[\\/]/u).pop()).filter(Boolean).join(' · ') : resource.saved_work?.source_path ? resource.saved_work.source_path.split(/[\\/]/u).pop() : resource.added_from?.origin_file?.split(/[\\/]/u).pop();
  const state = currentState(resource);
  const inspectedBy = resource.work?.initiated_by?.channel === 'host'
    ? resource.work.initiated_by.agent || t('resources.execution_host')
    : resource.work?.initiated_by?.channel === 'desktop' ? 'Atlas Desktop' : null;
  const open = resource.open_available === false ? '' : `<form method="post" action="${escapeHtml(`${model.base}/resources/open`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><button class="action-button action-button-secondary" type="submit">${h('resources.open_default')}</button></form>`;
  const dataAction = model.table_work_enabled !== false && resource.open_available !== false && resource.relative_path && ['CSV', 'XLSX'].includes(resource.type)
    ? `<a class="action-button" href="${escapeHtml(`${model.base}/data-work?path=${encodeURIComponent(resource.relative_path)}`)}">${h('resources.work_data')}</a>` : '';
  const documentUpdateAction = resource.resource_id && resource.open_available !== false && /\.(?:md|txt)$/iu.test(resource.relative_path ?? '')
    ? `<a class="action-button action-button-secondary" href="${escapeHtml(`${model.base}/document-updates/new?resource_id=${encodeURIComponent(resource.resource_id)}`)}">${h('document_update.open')}</a>` : '';
  const contentLocationAction = resource.resource_id && resource.open_available !== false && /\.(?:md|pdf|docx|xlsx|png)$/iu.test(resource.relative_path ?? '')
    ? `<a class="action-button action-button-secondary" href="${escapeHtml(`${model.base}/content-location?resource_id=${encodeURIComponent(resource.resource_id)}`)}">${h('content_location.open')}</a>` : '';
  const readAction = readerLink(model, resource, 'action-button', csrfToken);
  const pinControl = resourcePinControl(model, resource, csrfToken);
  const secondaryActions = open || pinControl || model.activity_return_href
    ? `<details class="workspace-focus-secondary-actions"><summary>${h('resources.more_actions')}</summary><div class="workspace-focus-actions">${open}${pinControl}${model.activity_return_href ? `<a class="action-button action-button-secondary" href="${escapeHtml(model.activity_return_href)}">${h('resources.back_activity')}</a>` : ''}</div></details>`
    : '';
  const usedBy = (resource.created_work ?? []).map((item) => item.name).filter(Boolean);
  const representationValue = resource.representation ? representation(resource) : null;
  const externalStatus = externalChangeStatus(resource);
  const focusState = { changed: t('resources.status_changed'), unchanged: t('resources.status_current'), missing: t('work.missing'), not_checked: t('work.not_checked') }[externalStatus ?? resource.state] ?? state ?? t('resources.available_project');
  return `<aside class="workspace-focus" data-resource-inspector><span class="workspace-kicker">${h('resources.selected_resource')}</span><h2>${escapeHtml(resource.name)}</h2><p class="workspace-focus-state" title="${escapeHtml(state ?? t('resources.available_project'))}">${escapeHtml(focusState)}</p>${readAction || dataAction || documentUpdateAction || contentLocationAction ? `<div class="workspace-focus-primary-action">${readAction}${dataAction}${documentUpdateAction}<a class="action-button action-button-secondary" href="${escapeHtml(`${model.base}/document-update-batches/new`)}">${h('document_batch.select')}</a>${contentLocationAction}</div>` : ''}${relatedWork(resource, csrfToken, locale, languageCatalog)}${boardReferences(model, resource, csrfToken)}${secondaryActions}<details class="workspace-focus-details"><summary>${h('resources.project_file_details')}</summary><dl><dt>${h('resources.type')}</dt><dd>${escapeHtml(resource.type)}</dd><dt>${h('resources.project')}</dt><dd>${escapeHtml(model.project.name)}</dd><dt>${escapeHtml(fact(resource.relationship_label) ?? t('resources.stored_in'))}</dt><dd>${escapeHtml(location)}</dd><dt>${h('resources.current_state')}</dt><dd>${escapeHtml(state ?? t('resources.available_project'))}</dd><dt>${h('resources.last_used')}</dt><dd>${escapeHtml(lastWorked(resource))}</dd>${source ? `<dt>${escapeHtml(resource.saved_work ? t('resources.created_from') : t('resources.added_from'))}</dt><dd>${escapeHtml(source)}</dd>` : ''}${resource.saved_work?.recipe?.version ? `<dt>${h('work.recipe')}</dt><dd>${h('work.version')} ${escapeHtml(resource.saved_work.recipe.version)}</dd>` : ''}${usedBy.length ? `<dt>${h('resources.used_by')}</dt><dd>${usedBy.map((name) => escapeHtml(name)).join(' · ')}</dd>` : ''}${representationValue ? `<dt>${escapeHtml(t('resources.representation'))}</dt><dd>${escapeHtml(representationValue)}</dd>` : ''}${inspectedBy ? `<dt>${h('resources.last_read_by')}</dt><dd>${escapeHtml(inspectedBy)}</dd>` : ''}</dl></details>${impactLanes(resource)}${recoveryActionControls(model, resource, csrfToken)}${relationship(model, resource, csrfToken)}<details class="workspace-technical-details"><summary>${h('work.technical_details')}</summary><dl><dt>${h('work.resource_id')}</dt><dd class="mono">${escapeHtml(resource.resource_id ?? t('work.not_recorded'))}</dd><dt>${h('resources.exact_path')}</dt><dd class="mono">${escapeHtml(resource.relative_path ?? resource.last_known_path ?? t('work.not_available'))}</dd>${resource.last_known_hash ? `<dt>${h('resources.last_hash')}</dt><dd class="mono">${escapeHtml(resource.last_known_hash)}</dd>` : ''}${resource.last_worked_at ? `<dt>${h('resources.recent_activity')}</dt><dd>${escapeHtml(time(resource.last_worked_at))}</dd>` : ''}</dl></details></aside>`;
}

function explorer(model, csrfToken, locale, languageCatalog) {
  const focusedPath = model.focused_resource?.relative_path ?? null;
  const resourceTree = model.tree ?? { folders: [], files: [] };
  let tree = resourceTree.folders.length
    ? resourceTree.folders.map((folder) => treeFolder(model, folder, 0, focusedPath)).join('')
    : `<p class="workspace-empty">${h('resources.no_folders')}</p>`;
  const selectedFolderLabel = model.selected_folder_path ? `${model.project.name} / ${model.selected_folder_path.split('/').join(' / ')}` : model.project.name;
  const rootSelected = model.selected_folder_path === '';
  const fileGroups = folderFileGroups(model, resourceTree);
  const missing = model.missing_sources ?? [];
  if (model.saved_work_error) tree += `<p class="callout warn">${h('resources.saved_results_unavailable')}</p>`;
  if (model.truncated) tree += `<p class="workspace-note">${h('resources.initial_list_bounded')}</p>`;
  if (missing.length) tree += `<section class="workspace-missing"><h3>${h('resources.missing_trace')}</h3>${missing.map((item) => `<p><strong>${escapeHtml(item.name)}</strong><span>${h('resources.missing_at')}</span><small class="mono">${escapeHtml(item.source_path ?? '')}</small></p>`).join('')}</section>`;
  const savedViewState = model.resource_view?.active_view
    ? `${resourceViewReceipt(model.resource_view.evaluation)}${model.saved_view_empty ? `<p class="callout">${h('resources.saved_view_empty')}</p>` : ''}`
    : '';
  return `<main class="workspace-visibility-page workspace-resource-page"><header class="workspace-resource-header"><div class="workspace-resource-heading"><div><span class="workspace-kicker">${escapeHtml(t('resources.project'))} / ${escapeHtml(model.project.name)}</span><h1>${escapeHtml(t('resources.title'))}</h1></div><a class="text-link" href="${escapeHtml(model.base)}">${escapeHtml(t('resources.project_home'))}</a></div><p class="sr-only">${escapeHtml(t('resources.folder_prompt'))}</p>${workSelectionBar(model)}<button class="action-button action-button-secondary workspace-file-list-toggle" type="button" data-resource-list-toggle aria-controls="project-resource-file-list" aria-expanded="true">${escapeHtml(t('resources.hide_file_list'))}</button>${resourceViewControls(model, csrfToken, locale, languageCatalog)}</header>${compactFolderNavigator(model, resourceTree)}${savedViewState}${model.focus_error ? `<p class="callout warn">${escapeHtml(model.focus_error)}</p>` : ''}<div class="workspace-resource-grid" data-resource-workspace data-project-id="${escapeHtml(model.project.id)}" data-project-name="${escapeHtml(model.project.name)}" data-project-base="${escapeHtml(model.base)}" data-selected-folder="${escapeHtml(model.selected_folder_path)}" data-selected-folder-explicit="${model.selected_folder_explicit ? 'true' : 'false'}" data-focus-path="${escapeHtml(model.focused_resource?.relative_path ?? '')}" data-active-view-id="${escapeHtml(model.resource_view?.active_view?.view_id ?? '')}" data-csrf="${escapeHtml(csrfToken ?? '')}"><section class="workspace-folder-navigator" data-folder-navigator><div class="workspace-pane-heading"><div><span class="workspace-kicker">${escapeHtml(t('resources.folder_navigator'))}</span></div><button class="workspace-text-button" type="button" data-collapse-all-folders>${escapeHtml(t('resources.collapse_all'))}</button></div><div class="workspace-folder-scroll"><div class="workspace-tree-root" data-resource-tree data-project-id="${escapeHtml(model.project.id)}"${model.focused_resource ? ` data-focus-path="${escapeHtml(model.focused_resource.relative_path)}"` : ''} data-open-action="${escapeHtml(`${model.base}/resources/open`)}" data-csrf="${escapeHtml(csrfToken ?? '')}"><a class="workspace-tree-root-row${rootSelected ? ' is-selected' : ''}" href="${escapeHtml(`${model.base}/resources?folder=`)}" data-folder-select data-folder-path=""><strong>${escapeHtml(model.project.name)}</strong><small>${escapeHtml(t('resources.project_root'))}</small></a>${tree}</div></div></section><div class="workspace-pane-resizer" role="separator" aria-label="${h('resources.resize_folders')}" aria-orientation="vertical" aria-valuemin="170" aria-valuemax="520" aria-valuenow="270" tabindex="0" data-resource-pane-resizer="folder"></div><section class="workspace-resource-list" id="project-resource-file-list" data-resource-file-list><div class="workspace-pane-heading"><div><span class="workspace-kicker">${escapeHtml(t('resources.files_in'))} <strong data-selected-folder-label>${escapeHtml(selectedFolderLabel)}</strong></span></div></div><div class="workspace-resource-list-scroll">${fileGroups}</div></section><div class="workspace-pane-resizer" role="separator" aria-label="${h('resources.resize_files')}" aria-orientation="vertical" aria-valuemin="280" aria-valuemax="760" aria-valuenow="500" tabindex="0" data-resource-pane-resizer="list"></div>${focusPanel(model, csrfToken, locale, languageCatalog)}</div></main>`;
}

function detail(model, csrfToken) {
  const resource = model.resource;
  const location = resource.relative_path.split('/').slice(0, -1).join('/') || t('resources.project_root');
  const identity = resource.saved_work ? t('resources.created_result') : resource.added_from ? t('resources.added_project') : t('resources.project_file');
  const facts = [
    [t('resources.what'), `${resource.type} · ${identity}`],
    [t('resources.stored_in'), location],
    [t('resources.last_worked'), lastWorked(resource)],
  ];
  const externalStatus = externalChangeStatus(resource);
  if (externalChangeCopy(externalStatus)) facts.push([t('resources.file_status'), externalChangeCopy(externalStatus)]);
  if (resource.work) {
    if (resource.work.source_status) facts.push([t('resources.current_state'), resource.work.source_status]);
    if (resource.work.initiated_by?.channel === 'host') {
      facts.push([t('resources.last_inspected'), resource.work.initiated_by.agent || t('resources.execution_host')]);
    } else if (resource.work.initiated_by?.channel === 'desktop') {
      facts.push([t('resources.last_inspected'), 'Atlas Desktop']);
    }
    if (resource.work.result_summary?.label) facts.push([t('resources.known_result'), resource.work.result_summary.label]);
  }
  if (resource.added_from) {
    facts.push([t('resources.added_from'), resource.added_from.origin_file, true]);
  }
  if (resource.saved_work) {
    const parameters = resource.saved_work.parameters ?? {};
    const sources = resource.saved_work.sources?.length ? resource.saved_work.sources.map((item) => item.path).join(' · ') : resource.saved_work.source_path;
    facts.push([t('resources.created_from'), sources, true]);
    if (resource.saved_work.recipe?.version) facts.push([t('work.recipe'), t('work.version_value',{version:resource.saved_work.recipe.version})]);
    facts.push([t('resources.source_status'), resource.saved_work.source_status]);
  }
  const created = resource.created_work?.length ? `<section class="surface"><h2>${h('resources.used_by')}</h2><p class="muted">${h('resources.recorded_inputs')}</p><ul class="path-list">${resource.created_work.map((item) => `<li><a class="text-link" href="${escapeHtml(detailHref(model, item))}">${escapeHtml(item.name)}</a></li>`).join('')}</ul></section>` : '';
  const dataAction = model.table_work_enabled !== false && ['CSV', 'XLSX'].includes(resource.type) ? `<a class="action-button" href="${model.base}/data-work?path=${encodeURIComponent(resource.relative_path)}">${h('resources.work_data')}</a>` : '';
  const undo = resource.saved_work?.undo_available ? `<form method="post" action="/data-work/undo"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="work_id" value="${escapeHtml(resource.saved_work.work_id)}"><input type="hidden" name="project_id" value="${escapeHtml(model.project.id)}"><button class="action-button action-button-secondary">${h('work.undo')}</button></form>` : '';
  const technical = `<details class="surface technical-details"><summary>${h('resources.technical_file')}</summary>${renderFacts([[t('resources.exact_path'), resource.relative_path, true], [t('work.size'), size(resource.bytes)], [t('resources.modified_disk'), time(resource.modified_at)], ...(resource.work ? [[t('resources.read_purpose'), resource.work.sheet ? t('work.sheet_value',{sheet:resource.work.sheet}) : resource.work.purpose], [t('resources.last_read'), time(resource.work.inspected_at)]] : []), ...(resource.saved_work ? [[t('work.filters'), (resource.saved_work.parameters?.filters ?? []).map((item) => `${item.column} ${item.operator}${item.value == null ? '' : ` ${item.value}`}`).join(' · ') || t('work.none')], [t('resources.sort'), resource.saved_work.parameters?.sort ? `${resource.saved_work.parameters.sort.column} ${resource.saved_work.parameters.sort.direction}` : t('work.none')]] : [])])}</details>`;
  return `<div class="page-intro"><div><span class="eyebrow">${h('resources.project_file_caps')}</span><h1>${escapeHtml(resource.name)}</h1><p class="lede">${h('resources.file_lede')}</p></div><div class="inline-actions">${readerLink(model, resource, 'action-button', csrfToken)}<form method="post" action="${model.base}/files/open"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="path" value="${escapeHtml(resource.relative_path)}"><button class="action-button action-button-secondary" type="submit">${h('resources.open_default')}</button></form>${resourcePinControl(model, resource, csrfToken)}${dataAction}${undo}<a class="action-button action-button-secondary" href="${escapeHtml(model.reader_return_href ?? `${model.base}/resources?path=${encodeURIComponent(resource.relative_path)}`)}">${h('resources.back_folder')}</a><a class="action-button action-button-secondary" href="${model.base}/files?dir=${encodeURIComponent(resource.relative_path.split('/').slice(0, -1).join('/'))}">${h('resources.browse_folder')}</a></div></div><section class="surface">${renderFacts(facts)}</section>${created}${technical}`;
}

function resourceLedgerLists(model) {
  const external = model.external_references ?? [];
  const focusedId = model.focused_resource?.resource_id;
  const missing = (model.missing_resources ?? []).filter((item) => item.resource_id !== focusedId);
  const archived = (model.archived_missing_resources ?? []).filter((item) => item.resource_id !== focusedId);
  const visibleMissing = missing.slice(0, 12);
  const visibleArchived = archived.slice(0, 12);
  const missingList = missing.length ? `<section class="workspace-missing"><h3>${h('resources.missing_resources')}</h3><p>${escapeHtml(t('resources.missing_count',{count:missing.length}))}</p>${visibleMissing.map((item) => `<p><a href="${escapeHtml(resourceHref(model, item))}">${escapeHtml(item.resource?.display_name ?? item.resource_id)}</a></p>`).join('')}${missing.length > visibleMissing.length ? `<p class="muted">${h('resources.first_missing',{count:visibleMissing.length})}</p>` : ''}</section>` : '';
  const archivedList = archived.length ? `<details class="workspace-missing"><summary>${h('resources.archived_count',{count:archived.length})}</summary>${visibleArchived.map((item) => `<p><a href="${escapeHtml(resourceHref(model, item))}">${escapeHtml(item.resource?.display_name ?? item.resource_id)}</a></p>`).join('')}${archived.length > visibleArchived.length ? `<p class="muted">${h('resources.first_archived',{count:visibleArchived.length})}</p>` : ''}</details>` : '';
  return `${external.length ? `<section class="workspace-missing"><h3>${h('resources.external_references')}</h3>${external.map((item) => `<p><a href="${escapeHtml(resourceHref(model, item))}">${escapeHtml(item.resource?.display_name ?? item.resource_id)}</a><small>${h('resources.used_by')} · ${escapeHtml(item.resource_id)}</small></p>`).join('')}</section>` : ''}${missingList}${archivedList}`;
}

function renderProjectResourcesView(model, options = {}) {
  const explorerBody = explorer(model, options.csrfToken, options.locale, options.languageCatalog);
  const resourceViewMode = model.resource_view?.mode;
  const resourceViewBody = ['table', 'cards'].includes(resourceViewMode) ? resourceViewContent(model, options.csrfToken, options.locale, options.languageCatalog) : null;
  const body = model.mode === 'detail' ? detail(model, options.csrfToken) : resourceViewBody ?? explorerBody.replace('</main>', `${resourceLedgerLists(model)}</main>`);
  const suggestionList = (model.link_suggestions ?? []).length ? `<section class="workspace-missing" data-resource-link-suggestions><h2>${h('resources.link_suggestions')}</h2><p>${h('resources.link_suggestions_help')}</p>${model.link_suggestions.map((item) => `<p><a href="${escapeHtml(`${model.base}/resources/link-suggestions/${encodeURIComponent(item.id)}`)}">${escapeHtml(item.proposal?.evidence?.reason ?? item.id)}</a><small> · ${h(`resources.link_suggestion_${item.status}`)}${item.validity === 'stale' ? ` · ${h('resources.link_suggestion_stale')}` : ''}</small></p>`).join('')}</section>` : '';
  const main = model.mode === 'detail' ? `<main class="page">${body}</main>${suggestionList}` : body.replace('</main>', `${suggestionList}</main>`);
  const clientMessages = escapeHtml(JSON.stringify(resourceClientMessages(options.locale, options.languageCatalog)));
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(model.project.name)} ${h('resources.title')} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="atlas-workspace-body" data-resource-messages="${clientMessages}"><div class="app-shell atlas-workspace-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Resources', { interactive: true, workspaceHref: '/projects', resourcesHref: `${model.base}/resources`, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: translateUi(options.locale, 'resources.title', options.languageCatalog), project: model.project, resource: model.mode === 'detail' ? model.resource?.relative_path : model.selected_path, locale: options.locale, languageCatalog: options.languageCatalog })}${main}</div></div></body></html>`;
}

function renderLinkSuggestionPage({ project, base, suggestion, csrfToken, decisionAction, requestKey }, options = {}) {
  const t=(key)=>translateUi(options.locale,key,options.languageCatalog); const h=(key)=>escapeHtml(t(key));
  const statusKey=`resources.link_suggestion_${suggestion.status}`;
  const from=suggestion.proposal?.source_resource_id??''; const to=suggestion.proposal?.target?.id??''; const reason=suggestion.proposal?.evidence?.reason??'';
  const bindingField=`<input type="hidden" name="csrf" value="${escapeHtml(csrfToken??'')}"><input type="hidden" name="expected_revision" value="${escapeHtml(suggestion.revision)}"><input type="hidden" name="binding_digest" value="${escapeHtml(suggestion.binding_digest)}"><input type="hidden" name="request_key" value="${escapeHtml(requestKey)}">`;
  const canDecide=suggestion.status==='pending';
  const form=canDecide?`<form method="post" action="${escapeHtml(decisionAction)}">${bindingField}<button class="action-button" name="decision" value="accept" type="submit">${h('resources.link_suggestion_accept')}</button><button class="action-button action-button-secondary" name="decision" value="reject" type="submit">${h('resources.link_suggestion_reject')}</button></form>`:'';
  const freshness=suggestion.validity==='stale'?h('resources.link_suggestion_stale'):h('resources.link_suggestion_current');
  const body=`<main class="page"><div class="page-intro"><div><span class="eyebrow">${h('resources.link_suggestions')}</span><h1>${escapeHtml(suggestion.id)}</h1><p class="lede">${h(statusKey)}</p></div></div><section class="surface"><dl><dt>${h('resources.link_suggestion_from')}</dt><dd class="mono">${escapeHtml(from)}</dd><dt>${h('resources.link_suggestion_to')}</dt><dd class="mono">${escapeHtml(to)}</dd><dt>${h('resources.link_suggestion_reason')}</dt><dd>${escapeHtml(reason)}</dd><dt>${h('resources.link_suggestion_current')}</dt><dd>${freshness}</dd></dl>${canDecide&&suggestion.validity==='stale'?`<p role="status">${h('resources.link_suggestion_stale')}</p>`:''}${form}<p>${h('resources.link_suggestion_decision')}</p><a href="${escapeHtml(`${base}/resources`)}">${h('resources.title')}</a></section></main>`;
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes??''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h('resources.link_suggestions')} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="atlas-workspace-body"><div class="app-shell atlas-workspace-shell" style="${escapeHtml(options.railStyle??'')}">${renderNav('Resources',{interactive:true,workspaceHref:'/projects',resourcesHref:`${base}/resources`,settingsHref:options.settingsHref,locale:options.locale,languageCatalog:options.languageCatalog})}<div class="workspace">${renderTopbar({section:t('resources.title'),project,locale:options.locale,languageCatalog:options.languageCatalog})}${body}</div></div></body></html>`;
}

function renderResourceLinkPreviewPage({ project, base, preview, operation, candidate, csrfToken, requestKey, submitAction, returnHref }) {
  const sourceLabel = `${preview.source.display_name} · ${preview.source.resource_id}`;
  const targetLabel = `${preview.target.display_name} · ${preview.target.resource_id}`;
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="operation" value="${escapeHtml(operation)}"><input type="hidden" name="source_resource_id" value="${escapeHtml(candidate.source_resource_id)}"><input type="hidden" name="target_resource_id" value="${escapeHtml(candidate.target.id)}"><input type="hidden" name="reason" value="${escapeHtml(candidate.evidence.reason)}">${operation === 'remove' ? `<input type="hidden" name="relationship_id" value="${escapeHtml(candidate.relationship_id)}">` : ''}<input type="hidden" name="preview_token" value="${escapeHtml(preview.preview_token)}"><input type="hidden" name="request_key" value="${escapeHtml(requestKey)}">`;
  const body = `<main class="page"><div class="page-intro"><div><span class="eyebrow">${h('resources.resource_links')}</span><h1>${h('resources.resource_link_preview_title')}</h1><p class="lede">${h(operation === 'remove' ? 'resources.resource_link_preview_remove' : 'resources.resource_link_preview_add')}</p></div></div><section class="surface"><dl><dt>${h('resources.resource_link_outgoing')}</dt><dd>${escapeHtml(sourceLabel)}</dd><dt>${h('resources.resource_link_target')}</dt><dd>${escapeHtml(targetLabel)}</dd><dt>${h('resources.resource_link_effect')}</dt><dd>${escapeHtml(preview.effect)}</dd><dt>${h('resources.resource_link_reason')}</dt><dd>${escapeHtml(candidate.evidence.reason)}</dd><dt>${h('resources.file_status')}</dt><dd data-file-verification="${escapeHtml(preview.file_verification)}">${escapeHtml(t('resources.resource_link_file_status'))}</dd><dt>${h('work.resource_id')}</dt><dd class="mono">${escapeHtml(preview.relationship?.id ?? '—')}</dd></dl><p class="muted">${h('resources.registered_local_help')}</p><form method="post" action="${escapeHtml(submitAction)}" class="inline-actions">${hidden}<button class="action-button" type="submit">${h(operation === 'remove' ? 'resources.resource_link_preview_remove' : 'resources.resource_link_preview_add')}</button><a class="action-button action-button-secondary" href="${escapeHtml(returnHref)}">${h('resources.resource_link_cancel')}</a></form></section></main>`;
  const messages = escapeHtml(JSON.stringify(resourceClientMessages(options.locale, options.languageCatalog)));
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h('resources.resource_link_preview_title')} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="atlas-workspace-body" data-resource-messages="${messages}"><div class="app-shell atlas-workspace-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Resources', { interactive: true, workspaceHref: '/projects', resourcesHref: `${base}/resources`, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: translateUi(options.locale, 'resources.title', options.languageCatalog), project, locale: options.locale, languageCatalog: options.languageCatalog })}${body}</div></div></body></html>`;
}

function renderProjectRelinkPreviewPage({ project, base, preview, csrfToken, selectionId, relativePath, requestKey, submitAction, returnHref }) {
  const inputIdentity = selectionId ? `<input type="hidden" name="selection_id" value="${escapeHtml(selectionId)}">` : `<input type="hidden" name="relative_path" value="${escapeHtml(relativePath)}">`;
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="resource_id" value="${escapeHtml(preview.resource_id)}">${inputIdentity}<input type="hidden" name="preview_digest" value="${escapeHtml(preview.preview_digest)}"><input type="hidden" name="request_key" value="${escapeHtml(requestKey)}">`;
  const body = `<main class="page"><div class="page-intro"><div><span class="eyebrow">${h('resources.file_missing')}</span><h1>${h('resources.relink_preview_title')}</h1><p class="lede">${h('resources.relink_preview_help')}</p></div></div><section class="surface"><dl><dt>${h('work.resource_id')}</dt><dd class="mono">${escapeHtml(preview.resource_id)}</dd><dt>${h('resources.relink_old_path')}</dt><dd class="mono">${escapeHtml(preview.old_location.path)}</dd><dt>${h('resources.relink_old_hash')}</dt><dd class="mono">${escapeHtml(preview.old_sha256)}</dd><dt>${h('resources.relink_candidate_path')}</dt><dd class="mono">${escapeHtml(preview.candidate_relative_path)}</dd><dt>${h('resources.relink_candidate_hash')}</dt><dd class="mono">${escapeHtml(preview.candidate_sha256)}</dd></dl><p class="muted">${h('resources.relink_no_file_write')}</p><form method="post" action="${escapeHtml(submitAction)}" class="inline-actions">${hidden}<button class="action-button" type="submit">${h('resources.relink_confirm')}</button><a class="action-button action-button-secondary" href="${escapeHtml(returnHref)}">${h('resources.resource_link_cancel')}</a></form></section></main>`;
  const messages = escapeHtml(JSON.stringify(resourceClientMessages(options.locale, options.languageCatalog)));
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h('resources.relink_preview_title')} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="atlas-workspace-body" data-resource-messages="${messages}"><div class="app-shell atlas-workspace-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Resources', { interactive: true, workspaceHref: '/projects', resourcesHref: `${base}/resources`, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: translateUi(options.locale, 'resources.title', options.languageCatalog), project, locale: options.locale, languageCatalog: options.languageCatalog })}${body}</div></div></body></html>`;
}

  function renderProjectRelinkConflictPage({ project, base, conflict, returnHref }) {
    const candidateHref = conflict.candidate_resource_id
      ? `${base}/resources?resource_id=${encodeURIComponent(conflict.candidate_resource_id)}` : null;
    const body = `<main class="page"><div class="page-intro"><div><span class="eyebrow">${h('resources.file_missing')}</span><h1>${h('resources.relink_conflict_title')}</h1><p class="lede">${h('resources.relink_conflict_help')}</p></div></div><section class="surface"><dl><dt>${h('resources.relink_conflict_missing')}</dt><dd class="mono">${escapeHtml(conflict.missing_resource_id)}</dd><dt>${h('resources.relink_old_path')}</dt><dd class="mono">${escapeHtml(conflict.old_location.path)}</dd><dt>${h('resources.relink_candidate_path')}</dt><dd class="mono">${escapeHtml(conflict.candidate_relative_path)}</dd><dt>${h('work.resource_id')}</dt><dd>${candidateHref ? `<a href="${escapeHtml(candidateHref)}" class="mono">${escapeHtml(conflict.candidate_resource_id)}</a>` : h('resources.relink_conflict_registered_hidden')}</dd></dl><p class="muted">${h('resources.relink_conflict_no_transfer')}</p><div class="inline-actions">${candidateHref ? `<a class="action-button" href="${escapeHtml(candidateHref)}">${h('resources.relink_conflict_open_candidate')}</a>` : ''}<a class="action-button action-button-secondary" href="${escapeHtml(returnHref)}">${h('resources.relink_conflict_return_missing')}</a></div></section></main>`;
    const messages = escapeHtml(JSON.stringify(resourceClientMessages(options.locale, options.languageCatalog)));
    return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h('resources.relink_conflict_title')} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="atlas-workspace-body" data-resource-messages="${messages}"><div class="app-shell atlas-workspace-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Resources', { interactive: true, workspaceHref: '/projects', resourcesHref: `${base}/resources`, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: translateUi(options.locale, 'resources.title', options.languageCatalog), project, locale: options.locale, languageCatalog: options.languageCatalog })}${body}</div></div></body></html>`;
  }

  return { renderProjectResourceFolderGroup, renderProjectResourcesView, renderLinkSuggestionPage, renderResourceLinkPreviewPage, renderProjectRelinkPreviewPage, renderProjectRelinkConflictPage };
}
export function renderProjectResourcesView(model, options = {}) { return createResourceRenderer(options).renderProjectResourcesView(model, options); }
export function renderLinkSuggestionPage(model, options = {}) { return createResourceRenderer(options).renderLinkSuggestionPage(model, options); }
export function renderProjectResourceFolderGroup(model, options = {}) { return createResourceRenderer(options).renderProjectResourceFolderGroup(model); }
export function renderResourceLinkPreviewPage(model, options = {}) { return createResourceRenderer(options).renderResourceLinkPreviewPage(model); }
export function renderProjectRelinkPreviewPage(model, options = {}) { return createResourceRenderer(options).renderProjectRelinkPreviewPage(model); }
export function renderProjectRelinkConflictPage(model, options = {}) { return createResourceRenderer(options).renderProjectRelinkConflictPage(model); }
