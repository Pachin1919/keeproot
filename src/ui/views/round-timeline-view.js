import { escapeHtml, renderNav, renderStatus, renderTopbar, renderUiClientScript } from '../components.js';
import { translateUi, normalizeUiLocale } from '../i18n.js';
import { uiStyles } from '../styles.js';

function text(value) {
  return escapeHtml(value ?? '');
}

function timestamp(value, locale) {
  if (!value) return '';
  const parsed = new Date(value);
  const label = Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(normalizeUiLocale(locale), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(parsed);
  return `<time datetime="${text(value)}">${text(label)}</time>`;
}

function form(actionUrl, csrfToken, action, values, label, disabled = false) {
  const fields = Object.entries({ action, ...values }).map(([name, value]) => `<input type="hidden" name="${text(name)}" value="${text(value)}">`).join('');
  return `<form method="post" action="${text(actionUrl)}"><input type="hidden" name="csrf" value="${text(csrfToken)}">${fields}<button class="action-button${action.startsWith('preview') ? ' action-button-secondary' : ''}" type="submit"${disabled ? ' disabled' : ''}>${text(label)}</button></form>`;
}

function previewValues(show, preview, extra = {}) {
  return {
    node_id: extra.node_id ?? preview?.node_id ?? show.head_node_id ?? '',
    restore_id: extra.restore_id ?? preview?.restore_id ?? '',
    base_revision: preview?.base_revision ?? show.revision ?? '',
    expected_digest: preview?.expected_digest ?? show.current_digest ?? '',
    preview_token: preview?.preview_token ?? '',
  };
}

function fileChangeLabel(value, t) {
  const key = {
    'remove (insured)': 'timeline.change_remove_insured',
    'restore file': 'timeline.change_restore_file',
    'replace content': 'timeline.change_replace_content',
  }[value];
  return key ? t(key) : value;
}

function nodeKindLabel(value, t) {
  const key = {
    before: 'timeline.node_before',
    checkpoint: 'timeline.node_checkpoint',
    insurance: 'timeline.node_insurance',
    scope_extension: 'timeline.node_scope_extension',
  }[value];
  return key ? t(key) : value;
}

function renderRoundList(rounds, base, t, locale) {
  if (!rounds.length) return `<section class="surface round-timeline-empty"><h2>${text(t('timeline.no_rounds_title'))}</h2><p>${text(t('timeline.no_rounds_description'))}</p></section>`;
  return `<section class="round-timeline-list" aria-label="${text(t('timeline.list_label'))}">${rounds.map((round) => {
    const href = `${base}/rounds/${encodeURIComponent(round.round_id)}`;
    return `<a class="surface round-timeline-row" href="${text(href)}"><span><strong>${text(round.label || round.round_id)}</strong><small>${text(t('timeline.revision'))}: ${text(round.revision ?? '')}</small></span><span class="round-timeline-row-meta">${round.pending_restore ? renderStatus('warning') : ''}${timestamp(round.updated_at, locale)}</span></a>`;
  }).join('')}</section>`;
}

function renderProtection(openWorks, folders, preview, actionUrl, csrfToken, t) {
  const works = openWorks ?? [];
  const places = folders ?? [];
  const selector = works.map((work) => `<option value="${text(work.session_id)}">${text(work.intent || work.session_id)} · ${text(work.session_id)} · ${text(t('timeline.revision'))} ${text(work.revision)}</option>`).join('');
  const folderSelector = places.map((folder) => `<option value="${text(folder.relative_path)}">${text(folder.relative_path)}</option>`).join('');
  const entry = `<section class="surface round-protect-entry"><h2>${text(t('timeline.protect_title'))}</h2><p>${text(t('timeline.protect_description'))}</p>${works.length
    ? `<form method="post" action="${text(actionUrl)}"><input type="hidden" name="csrf" value="${text(csrfToken)}"><input type="hidden" name="action" value="preview_protect"><label>${text(t('timeline.protect_work'))}<select name="work_id" required>${selector}</select></label><label>${text(t('timeline.protect_label'))}<input name="label" maxlength="500" required></label><fieldset><legend>${text(t('timeline.save_slot_title'))}</legend><label>${text(t('timeline.save_slot_folder'))}<select name="folder"><option value="">${text(t('timeline.slot_optional'))}</option>${folderSelector}</select></label><label>${text(t('timeline.save_slot_name'))}<input name="file_name"></label><label>${text(t('timeline.save_slot_format'))}<select name="format"><option value="">${text(t('timeline.slot_optional'))}</option><option value="csv">CSV</option><option value="xlsx">XLSX</option></select></label></fieldset><button class="action-button action-button-secondary" type="submit">${text(t('timeline.preview_protection'))}</button></form>`
    : `<p class="muted">${text(t('timeline.no_open_work'))}</p>`}</section>`;
  if (!preview) return entry;
   return `${entry}<section class="surface round-protect-preview"><h2>${text(t('timeline.protect_preview_title'))}</h2><dl><dt>${text(t('timeline.protect_work'))}</dt><dd><code>${text(preview.work_id)}</code></dd><dt>${text(t('timeline.revision'))}</dt><dd>${text(preview.work_revision)}</dd><dt>${text(t('timeline.protect_resources'))}</dt><dd>${(preview.resources ?? []).map((item) => `<div><code>${text(item.resource_id)}</code> · <code>${text(item.path)}</code></div>`).join('')}</dd></dl><h3>${text(t('timeline.protect_files'))}</h3><ul>${(preview.files ?? []).filter((file) => file.path !== preview.save_target).map((file) => `<li><code>${text(file.path)}</code> · ${text(file.bytes)} bytes · SHA-256 <code>${text(file.sha256 ?? '')}</code></li>`).join('')}</ul>${preview.save_target ? `<p><strong>${text(t('timeline.save_slot_absent'))}</strong> <code>${text(preview.save_target)}</code></p>` : ''}<p class="muted">${text(t(preview.save_target ? 'timeline.protect_scope_note' : 'timeline.protect_scope_note_no_slot'))}</p><form method="post" action="${text(actionUrl)}"><input type="hidden" name="csrf" value="${text(csrfToken)}"><input type="hidden" name="action" value="protect"><input type="hidden" name="protection_token" value="${text(preview.protection_token)}"><button class="action-button" type="submit">${text(t('timeline.confirm_protection'))}</button></form></section>`;
}

function renderPreview(show, preview, actionUrl, csrfToken, t) {
  if (!preview) return '';
  const isReturn = preview.action === 'return';
  const firstNodeId = show.nodes?.[0]?.node_id;
  const targetNode = show.nodes?.find((node) => node.node_id === preview.node_id);
  const isRoundBefore = preview.node_id === firstNodeId;
  const action = isReturn ? 'return' : 'restore';
  const title = isReturn ? t('timeline.return_preview_title') : isRoundBefore ? t('timeline.restore_preview_title') : t('timeline.restore_node_preview_title');
  const actionLabel = isReturn ? t('timeline.return_confirm') : isRoundBefore ? t('timeline.restore_confirm') : t('timeline.restore_node_confirm');
  const targetName = targetNode?.label || targetNode?.node_id || preview.node_id;
  return `<section class="surface round-timeline-preview"><div><span class="eyebrow">${text(t('timeline.preview_eyebrow'))}</span><h2>${text(title)}</h2>${!isReturn && !isRoundBefore ? `<p class="muted">${text(t('timeline.preview_node_name'))}: ${text(targetName)}</p>` : ''}<p>${text(t('timeline.preview_description'))}</p></div><section class="round-timeline-preview-state" aria-label="${text(t('timeline.preview_state_title'))}"><strong>${text(t('timeline.preview_state_title'))}</strong><p>${text(t('timeline.preview_state_counts', { works: preview.work_count ?? 0, boards: preview.board_count ?? 0, resources: preview.resource_count ?? 0 }))}</p></section><div class="round-timeline-preview-files">${(preview.files ?? []).map((file) => `<div><code>${text(file.path)}</code><small>${text(fileChangeLabel(file.change ?? '', t))}</small></div>`).join('') || `<p class="muted">${text(t('timeline.no_file_changes'))}</p>`}</div>${form(actionUrl, csrfToken, action, previewValues(show, preview), actionLabel)}</section>`;
}

function renderNode(node, show, actionUrl, csrfToken, t, disabled, locale) {
  const files = node.files ?? [];
  const label = node.kind === 'insurance' ? nodeKindLabel(node.kind, t) : node.label || nodeKindLabel(node.kind, t) || node.node_id;
  return `<details class="surface round-timeline-node"><summary class="round-timeline-node-heading"><span><strong>${text(label)}</strong><small>${text(nodeKindLabel(node.kind ?? '', t))}${node.created_at ? ` · ${timestamp(node.created_at, locale)}` : ''}</small></span>${node.node_id === show.head_node_id ? `<span class="status-pill">${text(t('timeline.current_node'))}</span>` : ''}</summary><div class="round-timeline-node-content"><dl><dt>${text(t('timeline.node_id'))}</dt><dd><code>${text(node.node_id ?? '')}</code></dd><dt>${text(t('timeline.parent_node'))}</dt><dd><code>${text(node.parent_node_id ?? '')}</code></dd></dl>${files.length ? `<ul>${files.map((file) => `<li><code>${text(file.path)}</code>${file.change ? ` <small>${text(fileChangeLabel(file.change, t))}</small>` : ''}</li>`).join('')}</ul>` : `<p class="muted">${text(t('timeline.no_file_changes'))}</p>`}${form(actionUrl, csrfToken, 'preview_restore', previewValues(show, null, { node_id: node.node_id }), t('timeline.preview_node_restore'), disabled)}</div></details>`;
}

function renderTimelineError(model, locale, t) {
  const safeNotice = model.error ?? model.error_message;
  if (!safeNotice) return '';
  if (normalizeUiLocale(locale) !== 'zh-CN') return `<section class="surface" role="alert"><p class="callout warn">${text(safeNotice)}</p></section>`;
  const message = String(model.error_message ?? safeNotice).replace(/^Action stopped\.\s*/u, '');
  const key = message === 'Round revision changed. Read the current round again.'
    ? 'timeline.error_revision_changed'
    : message === 'Files or Board changed since readback.'
      ? 'timeline.error_state_changed'
      : message === 'Review this recovery again before confirming.'
        ? 'timeline.error_preview_required'
        : 'timeline.error_unknown';
  return `<section class="surface" role="alert"><p class="callout warn">${text(t(key))}</p><details><summary>${text(t('timeline.error_details'))}</summary><p>${text(safeNotice)}</p></details></section>`;
}

function renderScopeExtensions(entries, t, locale) {
  if (!entries.length) return '';
  return `<h3>${text(t('timeline.scope_extensions'))}</h3><ul>${entries.map((entry) => `<li><code>${text((entry.paths ?? []).join(', '))}</code>${entry.created_at ? ` <small>${timestamp(entry.created_at, locale)}</small>` : ''}</li>`).join('')}</ul>`;
}

function renderShow(show, model, options, t, locale) {
  const csrfToken = options.csrfToken ?? '';
  const actionUrl = `${model.base}/rounds/${encodeURIComponent(show.round_id)}`;
  const pending = Boolean(show.pending_restore);
  const restores = show.restores ?? [];
  const latestRestore = restores.at(-1);
  const preview = model.preview;
  const primaryNodeId = show.nodes?.[0]?.node_id ?? show.head_node_id ?? '';
  const changeCount = (show.changed_files ?? []).length;
  const scopeFiles = (show.paths ?? []).length;
  const scopeExtensions = show.scope_extensions ?? [];
  const controls = pending
    ? form(actionUrl, csrfToken, 'resume', previewValues(show, preview, { restore_id: show.pending_restore }), t('timeline.resume'), false)
    : `<div class="inline-actions">${form(actionUrl, csrfToken, 'preview_restore', previewValues(show, null, { node_id: primaryNodeId }), t('timeline.preview_restore'), false)}${latestRestore ? form(actionUrl, csrfToken, 'preview_return', previewValues(show, null, { restore_id: latestRestore.restore_id }), t('timeline.preview_return'), false) : ''}</div>`;
  return `<div class="round-timeline-show"><p class="round-timeline-back-links"><a class="text-link" href="${text(model.base)}">${text(t('timeline.back_project'))}</a><a class="text-link" href="${text(`${model.base}/rounds`)}">${text(t('timeline.back_rounds'))}</a></p><section class="surface round-timeline-summary"><div><span class="eyebrow">${text(t('timeline.round_eyebrow'))}</span><h1>${text(show.label || show.round_id)}</h1><p class="lede">${text(t('timeline.actual_changes', { count: changeCount }))}</p><p class="muted">${text(t('timeline.scope_file_count', { count: scopeFiles }))}</p></div>${pending ? `<p class="callout warn" role="alert">${text(t('timeline.pending_notice'))}</p>` : ''}${controls}</section>${model.module_round ? `<section class="surface"><p class="muted">${text(t('timeline.module_scope_note'))}</p></section>` : ''}${model.continue_save_href ? `<section class="surface"><a class="action-button" href="${text(model.continue_save_href)}">${text(t(model.continue_save_kind === 'module' ? 'timeline.continue_module_save' : 'timeline.continue_save'))}</a><p class="muted">${text(t(model.continue_save_kind === 'module' ? 'timeline.module_save_return_hint' : 'timeline.save_return_hint'))}</p></section>` : ''}${model.notice ? `<section class="surface"><p class="callout warn">${text(model.notice)}</p></section>` : ''}${renderTimelineError(model, locale, t)}${renderPreview(show, preview, actionUrl, csrfToken, t)}<section class="round-timeline-nodes"><h2>${text(t('timeline.nodes_title'))}</h2>${(show.nodes ?? []).map((node) => renderNode(node, show, actionUrl, csrfToken, t, pending, locale)).join('') || `<p class="surface muted">${text(t('timeline.no_nodes'))}</p>`}</section><details class="surface round-timeline-technical"><summary>${text(t('timeline.round_details'))}</summary><dl><dt>${text(t('timeline.round_id'))}</dt><dd><code>${text(show.round_id)}</code></dd><dt>${text(t('timeline.revision'))}</dt><dd>${text(show.revision ?? '')}</dd><dt>${text(t('timeline.current_digest'))}</dt><dd><code>${text(show.current_digest ?? '')}</code></dd></dl>${show.scope_notice ? `<p>${text(show.scope_notice)}</p>` : ''}${scopeExtensions.length ? `<p class="muted">${text(t('timeline.scope_expansion_note'))}</p>` : ''}${renderScopeExtensions(scopeExtensions, t, locale)}<h3>${text(t('timeline.current_files'))}</h3><ul>${(show.current_files ?? []).map((file) => `<li><code>${text(file.path ?? file)}</code>${file.change ? ` <small>${text(file.change)}</small>` : ''}</li>`).join('') || `<li>${text(t('timeline.no_file_changes'))}</li>`}</ul></details></div>`;
}

export function renderRoundTimelineView(model, options = {}) {
  const locale = options.locale;
  const t = (key, variables = {}) => {
    const value = translateUi(locale, key, options.languageCatalog);
    return Object.entries(variables).reduce((result, [name, variable]) => result.replace(`{${name}}`, String(variable)), value);
  };
  const project = model.project ?? {};
  const base = model.base ?? `/projects/${encodeURIComponent(project.id ?? '')}`;
  const content = model.round ? renderShow(model.round, { ...model, base }, options, t, locale) : `<div class="round-timeline-index"><div class="page-intro"><div><span class="eyebrow">${text(t('timeline.eyebrow'))}</span><h1>${text(t('timeline.title'))}</h1><p class="lede">${text(t('timeline.index_description'))}</p></div></div>${model.notice ? `<section class="surface"><p class="callout warn">${text(model.notice)}</p></section>` : ''}${renderTimelineError(model, locale, t)}${model.continue_save_href ? `<section class="surface"><p class="callout warn">${text(t(model.module_round ? 'timeline.module_save_not_completed' : 'timeline.save_not_completed'))}</p><a class="action-button" href="${text(model.continue_save_href)}">${text(t(model.continue_save_kind === 'module' ? 'timeline.continue_module_save' : 'timeline.continue_save'))}</a><a class="text-link" href="${text(`${base}/rounds`)}">${text(t('timeline.back_rounds'))}</a></section>` : ''}${renderProtection(model.openWorks, model.folders, model.protectPreview, `${base}/rounds`, options.csrfToken ?? '', t)}${renderRoundList(model.rounds ?? [], base, t, locale)}</div>`;
  return `<!doctype html><html lang="${normalizeUiLocale(locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(t('timeline.title'))} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="product-workspace-body"><div class="app-shell" style="${text(options.railStyle ?? '')}">${renderNav('Projects', { interactive: true, workspaceHref: '/projects', resourcesHref: `${base}/resources`, projectSection: 'recovery', settingsHref: options.settingsHref, locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('timeline.title'), project, locale, languageCatalog: options.languageCatalog })}<main class="page round-timeline-page">${content}</main></div></div></body></html>`;
}
