import crypto from 'node:crypto';
import { escapeHtml, renderNav, renderStatus, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

function escapedHref(href) {
  return href ? ` href="${escapeHtml(href)}"` : '';
}

function renderLinkedItem(item, className, content) {
  return item.href
    ? `<a class="${className}"${escapedHref(item.href)}>${content}</a>`
    : `<article class="${className}">${content}</article>`;
}

function renderTimestamp(value, locale = 'en') {
  if (!value) return '';
  const parsed = new Date(value);
  const label = Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(normalizeUiLocale(locale), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(parsed);
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(label)}</time>`;
}

function renderPinControl(item, model, csrfToken, label = null, explicitAction = null, locale = 'en', languageCatalog = null) {
  const action = explicitAction ?? (item.pinned ? 'unpin' : 'pin');
  const actionLabel = label ?? translateUi(locale, action === 'pin' ? 'home.pin' : 'home.unpin', languageCatalog);
  return `<form method="post" action="${escapeHtml(`${model.base}/home/pins`)}" class="project-home-pin-form"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="kind" value="${escapeHtml(item.kind ?? '')}"><input type="hidden" name="id" value="${escapeHtml(item.id ?? '')}"><button class="text-link" type="submit">${escapeHtml(actionLabel)}</button></form>`;
}

function localizedHomeFact(value, locale, languageCatalog) {
  const key = {
    'Choose Sources': 'home.choose_sources',
    'Resolve a Source issue': 'home.resolve_source_issue',
    'Prepare Sources': 'home.prepare_sources',
    'Confirm field alignment': 'home.confirm_field_alignment',
    'Review Recipe and preview': 'home.review_recipe_preview',
    'Review preview and save': 'home.review_preview_save',
    'Saved result ready': 'home.saved_result_ready',
    'Not checked yet': 'home.not_checked_yet',
  }[value];
  return key ? translateUi(locale, key, languageCatalog) : value;
}

function renderHomeStatus(status, locale, languageCatalog) {
  const key = {
    verified: 'home.verified', failed: 'home.failed', changed: 'home.changed',
    missing: 'home.missing', missing_source: 'home.missing', waiting: 'home.waiting',
  }[status];
  return renderStatus(status, key ? translateUi(locale, key, languageCatalog) : null);
}

function localizedHomeScope(value, locale, languageCatalog) {
  const key = { 'Tracked Project Resources': 'home.tracked_project_resources', 'Known Project facts': 'home.known_project_facts' }[value];
  return key ? translateUi(locale, key, languageCatalog) : value;
}

function localizedAttentionDetail(item, locale, languageCatalog) {
  if (normalizeUiLocale(locale) === 'en') return item.detail;
  const key = {
    failed: 'home.failed_detail', changed: 'home.changed_detail',
    missing: 'home.missing_detail', missing_source: 'home.missing_detail', waiting: 'home.waiting_detail',
  }[item.status];
  return key ? translateUi(locale, key, languageCatalog) : item.detail;
}

function localizedRecentDetail(value, locale, languageCatalog) {
  return ['Output matches the verified saved result', 'Output matches the verified saved result.'].includes(value) ? translateUi(locale, 'home.result_matches_verified', languageCatalog) : value;
}

function renderWorkSummary(item, locale, languageCatalog) {
  const t = (key) => translateUi(locale, key, languageCatalog);
  const facts = [
    [t('home.recipe'), item.recipe_label],
    [t('home.result'), item.result_label],
    [t('home.freshness'), item.freshness_label],
  ].filter(([, value]) => value);
  return facts.length ? `<small>${facts.map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`).join(' · ')}</small>` : '';
}

function renderWorkActions(item, csrfToken, { showOpen = true, locale = 'en', languageCatalog = null } = {}) {
  if (!item.recipe_label && !item.result_label && !item.freshness_label && !item.reuse_action) return '';
  const open = showOpen && item.href ? `<a class="text-link" href="${escapeHtml(item.href)}">${escapeHtml(translateUi(locale, 'home.open', languageCatalog))}</a>` : '';
  const reuse = item.reuse_action
    ? `<form method="post" action="${escapeHtml(item.reuse_action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><input type="hidden" name="base_revision" value="${escapeHtml(item.revision ?? '')}"><button class="text-link" type="submit">${escapeHtml(translateUi(locale, 'home.reuse', languageCatalog))}</button></form>` : '';
  return open || reuse ? `<div class="inline-actions">${open}${reuse}</div>` : '';
}

function renderContinue(model, csrfToken, locale, languageCatalog) {
  if (!model.continue_item && !(model.other_work ?? []).length) return '';
  const item = model.continue_item;
  const t = (key) => translateUi(locale, key, languageCatalog);
  const continueAction = item?.href ? `<a class="action-button" href="${escapeHtml(item.href)}">${escapeHtml(t('home.continue_action'))}</a>` : '';
  const notRecorded = escapeHtml(t('home.not_recorded'));
  const previousWork = escapeHtml(t('home.previous_work'));
  const previousWorkEyebrow = escapeHtml(t('home.previous_work_eyebrow'));
  const fact = item?.position ?? item?.freshness_label ?? item?.detail ?? null;
  const localizedFact = localizedHomeFact(fact, locale, languageCatalog);
  const target = item ? `<div class="project-home-current-work"><div><strong class="project-home-continue-title">${escapeHtml(item.title ?? '')}</strong>${fact ? `<p class="project-home-continue-fact">${escapeHtml(t('home.status'))}: ${escapeHtml(localizedFact)}</p>` : ''}${item.notice ? `<p class="callout warn project-home-continue-notice">${escapeHtml(item.notice)}</p>` : ''}</div><div class="project-home-current-actions">${continueAction}${renderWorkActions(item, csrfToken, { showOpen: false, locale, languageCatalog })}</div><details class="project-home-work-details"><summary>${escapeHtml(t('home.details'))}</summary><dl><dt>${escapeHtml(t('home.revision'))}</dt><dd>${escapeHtml(item.revision ?? notRecorded)}</dd><dt>${escapeHtml(t('home.recipe'))}</dt><dd>${escapeHtml(item.recipe_label ?? notRecorded)}</dd><dt>${escapeHtml(t('home.updated'))}</dt><dd>${renderTimestamp(item.updated_at, locale) || notRecorded}</dd></dl></details></div>` : '';
  const otherWork = (model.other_work ?? []).length
    ? `<div class="project-home-secondary-list">${item ? `<span class="eyebrow">${previousWorkEyebrow}</span>` : ''}${model.other_work.map((work) => `<div>${renderLinkedItem(work, 'project-home-secondary-target', `<span><strong>${escapeHtml(work.title ?? '')}</strong>${work.detail ? `<small>${escapeHtml(work.detail)}</small>` : ''}${renderWorkSummary(work, locale, languageCatalog)}</span>${renderTimestamp(work.updated_at, locale)}`)}${renderWorkActions(work, csrfToken, { locale, languageCatalog })}</div>`).join('')}</div>`
    : '';
  if (!item) return `<section class="surface project-home-section project-home-continue" aria-labelledby="project-home-previous-work-title"><div class="project-home-section-heading"><div><span class="eyebrow">${previousWorkEyebrow}</span><h2 id="project-home-previous-work-title">${previousWork}</h2></div></div>${otherWork}</section>`;
  return `<section class="surface project-home-section project-home-continue" aria-labelledby="project-home-continue-title"><div class="project-home-section-heading"><div><h2 id="project-home-continue-title">${escapeHtml(t('home.continue_title'))}</h2></div></div>${target}${otherWork}</section>`;
}

function renderPinned(model, csrfToken, locale, languageCatalog) {
  const pinned = model.pinned ?? [];
  if (!pinned.length) return '';
  const t = (key) => translateUi(locale, key, languageCatalog);
  return `<section class="surface project-home-section" aria-labelledby="project-home-pinned-title"><div class="project-home-section-heading"><div><span class="eyebrow">${escapeHtml(t('home.pinned'))}</span><h2 id="project-home-pinned-title">${escapeHtml(t('home.keep_close'))}</h2></div></div><div class="project-home-list">${pinned.map((item) => `<div class="project-home-list-row">${renderLinkedItem(item, 'project-home-list-target', `<span class="project-home-item-copy"><strong>${escapeHtml(item.title ?? '')}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}</span><span class="project-home-meta">${item.status ? renderHomeStatus(item.status, locale, languageCatalog) : ''}${renderTimestamp(item.updated_at, locale)}</span>`)}${renderPinControl(item, model, csrfToken, null, 'unpin', locale, languageCatalog)}</div>`).join('')}</div></section>`;
}

function renderChanges(model, csrfToken, locale, languageCatalog) {
  const changes = model.changes ?? {};
  const t = (key) => translateUi(locale, key, languageCatalog);
  const stateCopy = {
    attention: [t('home.changes_attention_title'), t('home.changes_attention_detail')],
    not_checked: [t('home.not_checked_yet'), t('home.changes_not_checked_detail')],
    clear: [t('home.changes_clear_title'), t('home.changes_clear_detail')],
    failed: [t('home.changes_failed_title'), t('home.changes_failed_detail')],
  };
  const [title, detail] = stateCopy[changes.state] ?? [t('home.changes_attention_title'), t('home.changes_default_detail')];
  const items = changes.items ?? [];
  const canCheck = ['not_checked', 'failed', 'clear', 'attention'].includes(changes.state);
  const checkForm = canCheck ? `<form method="post" action="${escapeHtml(`${model.base}/home/check`)}" class="project-home-check-form"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><button class="action-button action-button-secondary" type="submit">${escapeHtml(t('home.check_tracked_resources'))}</button></form>` : '';
  const missing = model.missing_records ?? {};
  const missingControls = missing.count || missing.archived_count
    ? `<div class="inline-actions">${missing.count ? `<a class="action-button action-button-secondary" href="${escapeHtml(`${model.base}/resources?missing=1`)}">${escapeHtml(t('home.review_missing'))}</a><form method="post" action="${escapeHtml(`${model.base}/home/archive-missing`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><button class="action-button" type="submit">${escapeHtml(t('home.archive_unavailable'))}</button></form>` : ''}${missing.archived_count ? `<form method="post" action="${escapeHtml(`${model.base}/home/restore-missing`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken ?? '')}"><button class="action-button action-button-secondary" type="submit">${escapeHtml(t('home.restore_archived'))}</button></form>` : ''}</div><p class="muted">${escapeHtml(t('home.archive_explainer'))}</p>`
    : '';
  return `<section class="surface project-home-section" aria-labelledby="project-home-changes-title"><div class="project-home-section-heading"><div><span class="eyebrow">${escapeHtml(t('home.changes'))}</span><h2 id="project-home-changes-title">${escapeHtml(title)}</h2><p>${escapeHtml(detail)}${changes.scope_label ? ` ${escapeHtml(localizedHomeScope(changes.scope_label, locale, languageCatalog))}` : ''}</p></div>${changes.checked_at ? `<span class="project-home-checked">${escapeHtml(t('home.checked'))} ${renderTimestamp(changes.checked_at, locale)}</span>` : ''}</div>${items.length ? `<div class="project-home-list">${items.map((item) => renderLinkedItem(item, 'project-home-list-target', `<span class="project-home-item-copy"><strong>${escapeHtml(item.title ?? '')}</strong>${item.detail ? `<small>${escapeHtml(localizedAttentionDetail(item, locale, languageCatalog))}</small>` : ''}</span>${item.status ? renderHomeStatus(item.status, locale, languageCatalog) : ''}`)).join('')}</div>` : ''}${missingControls}${checkForm}</section>`;
}

function renderRecentResults(model, csrfToken, locale, languageCatalog) {
  const results = model.recent_results ?? [];
  const resourcesHref = `${model.base}/resources`;
  const t = (key) => translateUi(locale, key, languageCatalog);
  return `<section class="surface project-home-section" aria-labelledby="project-home-results-title"><div class="project-home-section-heading"><div><span class="eyebrow">${escapeHtml(t('home.recent_results'))}</span><h2 id="project-home-results-title">${escapeHtml(t('home.recent_results_title'))}</h2></div></div>${results.length ? `<div class="project-home-list">${results.map((item) => `<div class="project-home-list-row">${renderLinkedItem(item, 'project-home-list-target', `<span class="project-home-item-copy"><strong>${escapeHtml(item.title ?? '')}</strong>${item.detail ? `<small>${escapeHtml(localizedRecentDetail(item.detail, locale, languageCatalog))}</small>` : ''}</span><span class="project-home-meta">${item.status ? renderHomeStatus(item.status, locale, languageCatalog) : ''}${renderTimestamp(item.updated_at, locale)}</span>`)}${renderPinControl({ ...item, kind: 'result' }, model, csrfToken, null, null, locale, languageCatalog)}</div>`).join('')}</div>` : `<p class="project-home-empty-copy">${escapeHtml(t('home.no_verified'))} <a class="text-link" href="${escapeHtml(resourcesHref)}">${escapeHtml(t('home.resources'))}</a></p>`}</section>`;
}

function renderProjectRename(model, csrfToken, locale, languageCatalog) {
  const t = (key) => translateUi(locale, key, languageCatalog);
  const preview = model.rename_preview;
  const error = model.rename_error
    ? `<p class="callout warn" role="alert">${escapeHtml(model.rename_error)}</p>`
    : '';
  if (!preview) {
    return `<section class="surface project-home-section" aria-labelledby="project-rename-title"><div class="project-home-section-heading"><div><h2 id="project-rename-title">${escapeHtml(t('home.rename_title'))}</h2><p>${escapeHtml(t('home.rename_intro'))}</p></div></div>${error}<form method="post" action="${escapeHtml(`${model.base}/rename/preview`)}" class="project-rename-form project-home-input-form"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><label>${escapeHtml(t('home.rename_new_name'))}<input name="new_name" required maxlength="160" value="${escapeHtml(model.project?.name ?? '')}"></label><button class="action-button" type="submit">${escapeHtml(t('home.rename_preview'))}</button></form></section>`;
  }
  return `<section class="surface project-home-section project-rename-preview" aria-labelledby="project-rename-title"><h2 id="project-rename-title">${escapeHtml(t('home.rename_preview_title'))}</h2>${error}<dl><dt>${escapeHtml(t('home.rename_project_id'))}</dt><dd>${escapeHtml(preview.project_id)}</dd><dt>${escapeHtml(t('home.rename_old_name'))}</dt><dd>${escapeHtml(preview.old_name)}</dd><dt>${escapeHtml(t('home.rename_new_name'))}</dt><dd>${escapeHtml(preview.new_name)}</dd><dt>${escapeHtml(t('home.rename_path'))}</dt><dd>${escapeHtml(preview.current_path)}</dd></dl><p>${escapeHtml(t('home.rename_no_move'))}</p><form method="post" action="${escapeHtml(`${model.base}/rename/confirm`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="expected_name" value="${escapeHtml(preview.old_name)}"><input type="hidden" name="expected_updated_at" value="${escapeHtml(preview.expected_updated_at)}"><input type="hidden" name="new_name" value="${escapeHtml(preview.new_name)}"><input type="hidden" name="preview_revision" value="${escapeHtml(preview.preview_revision)}"><div class="inline-actions"><button class="action-button" type="submit">${escapeHtml(t('home.rename_confirm'))}</button><a class="action-button action-button-secondary" href="${escapeHtml(model.base)}">${escapeHtml(t('home.rename_cancel'))}</a></div></form></section>`;
}

function renderHandoffs(model, csrfToken, locale, languageCatalog) {
  const t = (key) => translateUi(locale, key, languageCatalog);
  const works = model.handoff_work_sessions ?? [];
  const rows = (model.handoffs ?? []).map((item) => `<li><a class="text-link" href="${escapeHtml(`${model.base}/handoffs/${encodeURIComponent(item.handoff_id)}`)}">${escapeHtml(item.goal || item.handoff_id)}</a> · ${escapeHtml(t(`handoff.${['current', 'stale'].includes(item.status) ? item.status : 'blocked'}`))}</li>`).join('');
  const saveOptions = model.handoff_save_options ?? [];
  const saves = `<fieldset class="handoff-save-options"><legend>${escapeHtml(t('workspace.handoff_choose_saves'))}</legend><p class="muted">${escapeHtml(t('workspace.handoff_saves_help'))}</p>${saveOptions.length ? saveOptions.map(item => `<label><input type="checkbox" name="save_ids" value="${escapeHtml(item.save_id)}"><span>${escapeHtml(item.name)}${item.created_at ? ` · ${escapeHtml(new Date(item.created_at).toLocaleDateString(locale))}` : ''}</span></label>`).join('') : `<p class="muted">${escapeHtml(t('workspace.handoff_no_saves'))}</p>`}</fieldset>`;
  return `<section class="surface project-home-section" aria-labelledby="handoff-title"><div class="project-home-section-heading"><div><span class="eyebrow">${escapeHtml(t('handoff.title'))}</span><h2 id="handoff-title">${escapeHtml(t('handoff.create_title'))}</h2><p>${escapeHtml(t('handoff.intro'))}</p></div></div><form class="project-home-handoff-form" method="post" action="${escapeHtml(`${model.base}/handoffs`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="request_key" value="${escapeHtml(`ui-${crypto.randomUUID()}`)}"><label>${escapeHtml(t('handoff.goal'))}<input name="goal" required maxlength="1000"></label><label>${escapeHtml(t('handoff.work'))}<select name="work_id" required>${works.map((item) => `<option value="${escapeHtml(item.session_id)}">${escapeHtml(item.intent || item.session_id)} · r${escapeHtml(item.revision)} · ${escapeHtml(item.session_id.slice(-8))}</option>`).join('')}</select></label>${saves}<label>${escapeHtml(t('handoff.corrections'))}<textarea name="corrections" maxlength="4000" placeholder="${escapeHtml(t('handoff.correction_help'))}"></textarea></label><label>${escapeHtml(t('handoff.unfinished'))}<textarea name="unfinished" maxlength="4000"></textarea></label><button class="action-button" type="submit"${works.length ? '' : ' disabled'}>${escapeHtml(t('handoff.create'))}</button></form>${rows ? `<h3>${escapeHtml(t('handoff.recent'))}</h3><ul>${rows}</ul>` : `<p class="muted">${escapeHtml(t('handoff.none'))}</p>`}</section>`;
}

function renderEmptyProject(model, locale, languageCatalog) {
  const resourcesHref = `${model.base}/resources`;
  const t = (key) => escapeHtml(translateUi(locale, key, languageCatalog));
  return `<section class="surface project-home-start" aria-labelledby="project-home-start-title"><span class="eyebrow">${t('home.start_here')}</span><h2 id="project-home-start-title">${t('home.bring_project')}</h2><p>${t('home.empty_help')}</p><div class="inline-actions"><a class="action-button" href="${escapeHtml(resourcesHref)}">${t('home.files_resources')}</a><a class="action-button action-button-secondary" href="/files">${t('home.import')}</a></div></section>`;
}

function renderProjectDisclosure(id, title, help, content, open = false) {
  return `<details class="project-disclosure" id="${id}"${open ? ' open' : ''}><summary><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(help)}</small></span><span class="project-disclosure-chevron" aria-hidden="true">›</span></summary><div class="project-disclosure-content">${content}</div></details>`;
}

export function renderProjectHomeView(model, options = {}) {
  const csrfToken = options.csrfToken ?? '';
  const base = model.base ?? '';
  const project = model.project ?? {};
  const t = (key) => translateUi(options.locale, key, options.languageCatalog);
  const body = model.empty_project ? renderEmptyProject(model, options.locale, options.languageCatalog) : `${renderContinue(model, csrfToken, options.locale, options.languageCatalog)}${renderPinned(model, csrfToken, options.locale, options.languageCatalog)}`;
  let captureForm = `<section class="surface project-home-section" aria-labelledby="capture-source-title"><div class="project-home-section-heading"><div><span class="eyebrow">${escapeHtml(t('capture.eyebrow'))}</span><h2 id="capture-source-title">${escapeHtml(t('capture.title'))}</h2><p>${escapeHtml(t('capture.intro'))}</p></div></div><form class="project-home-input-form" method="post" action="${escapeHtml(`${base}/capture-source/prepare`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><label>${escapeHtml(t('capture.url'))}<input type="url" name="url" required maxlength="2048" placeholder="https://example.com/article"></label><label>${escapeHtml(t('capture.folder'))}<input type="text" name="folder" required value="01_来源"></label><label>${escapeHtml(t('capture.name'))}<input type="text" name="name" required maxlength="120"></label><p class="muted">${escapeHtml(t('capture.note'))}</p><button class="action-button" type="submit">${escapeHtml(t('capture.prepare'))}</button></form></section>`;
  let exportForm = `<section class="surface project-home-section" aria-labelledby="capture-export-title"><div class="project-home-section-heading"><div><span class="eyebrow">${escapeHtml(t('capture.export_eyebrow'))}</span><h2 id="capture-export-title">${escapeHtml(t('capture.export_title'))}</h2><p>${escapeHtml(t('capture.export_intro'))}</p></div></div><form class="project-home-input-form" method="post" action="${escapeHtml(`${base}/capture-source/export/inspect`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><label>${escapeHtml(t('capture.export_path'))}<input type="text" name="input_path" required></label><p class="muted">${escapeHtml(t('capture.export_privacy'))}</p><button class="action-button" type="submit">${escapeHtml(t('capture.export_inspect'))}</button></form></section>`;
  if (model.capture_module_enabled === false) {
    captureForm = `<section class="surface project-home-section" aria-labelledby="capture-source-title"><h2 id="capture-source-title">${escapeHtml(t('capture.title'))}</h2><p class="callout warn">${escapeHtml(t('capture.module_disabled'))}</p><a class="text-link" href="/modules">${escapeHtml(t('modules.title'))}</a></section>`;
    exportForm = '';
  }

  const w = (key) => t('workspace.' + key);
  const addMaterial = renderProjectDisclosure('project-add-material', w('add_material'), w('add_help'), captureForm + exportForm);
  const handoff = renderProjectDisclosure('project-handoff', w('continue_host'), w('handoff_help'), renderHandoffs(model, csrfToken, options.locale, options.languageCatalog));
  const management = renderProjectDisclosure('project-management', w('manage'), w('manage_help'), renderProjectRename(model, csrfToken, options.locale, options.languageCatalog) + '<div class="project-management-links"><a class="text-link" href="' + escapeHtml(base + '/move/new') + '">' + escapeHtml(t('project_move.title')) + '</a><a class="text-link" href="' + escapeHtml(base + '/membership') + '">' + escapeHtml(t('membership.title')) + '</a></div>', Boolean(model.rename_preview || model.rename_error));
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(project.name ?? 'Project')} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="product-workspace-body"><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { interactive: true, workspaceHref: '/projects', resourcesHref: base + '/resources', projectSection: 'overview', importHref: '/files', settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('home.eyebrow'), project, locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page project-home product-project-home"><div class="page-intro product-project-intro"><div><span class="eyebrow">${escapeHtml(t('home.eyebrow'))}</span><h1>${escapeHtml(project.name ?? 'Project')}</h1><p class="lede">${escapeHtml(w('project_lede'))}</p></div><div class="inline-actions"><a class="action-button" href="${escapeHtml(base + '/resources')}">${escapeHtml(w('browse'))}</a><button class="action-button action-button-secondary" type="button" data-project-disclosure="project-add-material">${escapeHtml(w('add_material'))}</button></div></div>${model.state_error ? '<section class="surface project-home-state-warning" role="alert"><p class="callout warn">' + escapeHtml(model.state_error) + '</p><a class="text-link" href="' + escapeHtml(base + '/resources') + '">' + escapeHtml(t('home.open_resources')) + '</a></section>' : ''}<div class="project-overview-grid"><div class="project-overview-main" aria-label="${escapeHtml(w('work'))}">${body}</div><aside class="project-overview-results" aria-label="${escapeHtml(w('saved_work'))}">${renderRecentResults(model, csrfToken, options.locale, options.languageCatalog)}</aside></div>${model.empty_project ? '' : renderChanges(model, csrfToken, options.locale, options.languageCatalog)}<div class="project-action-stack">${addMaterial}${handoff}${management}</div><p class="project-local-note">${escapeHtml(w('local_note'))}</p></main></div></div></body></html>`;
}
