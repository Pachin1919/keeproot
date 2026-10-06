import { escapeHtml, renderFacts, renderNav, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

function fileName(filePath) {
  return String(filePath ?? '').split(/[\\/]/u).pop() || 'File';
}

function pickerButton(side, leftSelectionId = null, enabled = false, t) {
  return `<button class="action-button" type="button" data-compare-picker="${escapeHtml(side)}"${leftSelectionId ? ` data-left-selection="${escapeHtml(leftSelectionId)}"` : ''}${enabled ? '' : ' disabled'}>${escapeHtml(t(side === 'left' ? 'choose_first' : 'choose_second'))}</button>`;
}

function selectionSummary(label, selected, t) {
  if (!selected) return `<div class="empty-state"><strong>${escapeHtml(label)}</strong><p>${escapeHtml(t('choose_local'))}</p></div>`;
  return `<div class="surface-flat"><span class="label">${escapeHtml(label)}</span><strong>${escapeHtml(selected.name ?? fileName(selected.path))}</strong><small class="mono">${escapeHtml(selected.path)}</small></div>`;
}

function ratio(value, t) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : t('unavailable');
}

function detailResult(comparison, t) {
  const details = comparison.details;
  if (!details) return '';
  const h = (value) => escapeHtml(value ?? '');
  const cell = (value) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const times = details.time_sources ?? {};
  const dateText = (value) => !value || !value.start ? t('unavailable') : `${value.start} → ${value.end} (${value.status}; ${value.valid_count ?? value.timestamped_records ?? 0}/${value.record_count ?? 0})`;
  const summary = details.summary ?? {};
  return `<section class="surface" data-comparison-details><h2>${h(t('details'))}</h2><p>${h(t(details.status === 'uncertain' ? 'uncertain' : details.status === 'unsupported' ? 'unsupported' : 'detail_ready'))}</p>
    ${renderFacts(['added', 'removed', 'changed', 'unchanged', 'repeated', 'left_blocks', 'right_blocks', 'left_records', 'right_records', 'left_empty_key_records', 'right_empty_key_records', 'left_duplicate_keys', 'right_duplicate_keys'].filter(key => key in summary).map(key => [t(key), summary[key] ?? t('unavailable')]))}
    ${details.selected_sheets ? renderFacts([[t('left_sheet'), `${details.selected_sheets.left.name} (${details.selected_sheets.left.visibility})`], [t('right_sheet'), `${details.selected_sheets.right.name} (${details.selected_sheets.right.visibility})`]]) : ''}
    ${(details.reasons ?? []).length ? `<p>${h(details.reasons.join('; '))}</p>` : ''}
    <p>${h(t('identity_note'))}</p><p>${h(t('byte_equal'))}: ${h(details.byte_equal ? t('yes') : t('no'))}</p>
    ${details.truncated ? `<p class="callout warn">${h(t('truncated'))}</p>` : ''}
    <div class="project-home-grid">${(details.entries ?? []).map(entry => `<section class="surface-flat"><h3>${h(t(entry.type))}</h3>${entry.key ? `<p>${h(t('key'))}: ${h(JSON.stringify(entry.key))}</p>` : ''}${entry.message_id ? `<p>${h(entry.message_id)}</p>` : ''}${entry.record_number ? `<p>${h(entry.side)} · ${h(entry.record_number)}</p>` : ''}${entry.count != null ? `<p>${h(t('count'))}: ${h(entry.count)}</p>` : ''}${entry.left_count != null ? `<p>${h(t('left'))}: ${h(entry.left_count)} · ${h(t('right'))}: ${h(entry.right_count)}</p>` : ''}
      <div class="page-grid"><div><span class="label">${h(t('left'))}</span><pre style="white-space:pre-wrap">${h(cell(entry.before))}</pre></div><div><span class="label">${h(t('right'))}</span><pre style="white-space:pre-wrap">${h(cell(entry.after))}</pre></div></div>${entry.truncated ? `<p>${h(t('truncated'))}</p>` : ''}</section>`).join('')}</div>
    </section><section class="surface"><h2>${h(t('time_sources'))}</h2>${renderFacts([
      [t('file_modified_left'), times.file_modified?.left ?? comparison.sources?.left?.modified_at],
      [t('file_modified_right'), times.file_modified?.right ?? comparison.sources?.right?.modified_at],
      [t('event_dates_left'), dateText(times.event_dates?.left)], [t('event_dates_right'), dateText(times.event_dates?.right)],
      [t('business_period'), times.business_period?.column ?? t('unavailable')],
      [t('period_values_left'), (times.business_period?.left_values ?? []).join(', ') || t('unavailable')],
      [t('period_values_right'), (times.business_period?.right_values ?? []).join(', ') || t('unavailable')],
    ])}<p>${h(t('time_note'))}</p>${times.business_period?.samples_truncated ? `<p>${h(t('truncated'))}</p>` : ''}</section>`;
}

function comparisonResult(model, csrfToken, options) {
  const { t } = options;
  const comparison = model.comparison;
  const sources = comparison.sources ?? {};
  const evidence = comparison.evidence ?? {};
  const relation = comparison.relation ?? {};
  const limitations = [
    t('limit_text'),
    t('limit_formats'),
  ];
  if (comparison.attention?.maximum_returned_message_ids_per_side) {
    limitations.push(t('limit_ids', { count: comparison.attention.maximum_returned_message_ids_per_side }));
  }
  return `<div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('eyebrow'))}</span><h1>${escapeHtml(t('ready'))}</h1><p class="lede">${escapeHtml(t('ready_lede'))}</p></div></div>
    <section class="surface"><h2>${escapeHtml(t('files'))}</h2>${renderFacts([
      [t('left'), sources.left?.name ?? fileName(sources.left?.path)],
      [t('right'), sources.right?.name ?? fileName(sources.right?.path)],
      [t('identical'), sources.left?.sha256 === sources.right?.sha256 ? t('yes') : t('no')],
      [t('relationship'), relation.type ?? t('unavailable')],
      [t('based_on'), relation.basis ?? t('unavailable')],
      [t('previous'), comparison.cache_hit ? t('yes') : t('no')],
    ])}</section>
    ${comparison.details?.selected_sheets ? '' : `<section class="surface"><h2>${escapeHtml(t('evidence'))}</h2>${renderFacts([
      [t('left_lines'), evidence.left_line_count],
      [t('right_lines'), evidence.right_line_count],
      [t('shared_lines'), evidence.common_line_count],
      [t('left_overlap'), ratio(evidence.left_overlap_ratio, t)],
      [t('right_overlap'), ratio(evidence.right_overlap_ratio, t)],
      [t('shared_ids'), evidence.shared_message_id_count],
    ])}</section>`}
    ${detailResult(comparison, t)}
    <section class="surface"><h2>${escapeHtml(t('limits'))}</h2><ul>${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>
    <section class="surface"><div class="inline-actions">
      <form method="post" action="${escapeHtml(options.openEndpoint)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="comparison_id" value="${escapeHtml(model.comparison_id)}"><input type="hidden" name="side" value="left"><button class="action-button action-button-secondary" type="submit">${escapeHtml(t('open_left'))}</button></form>
      <form method="post" action="${escapeHtml(options.openEndpoint)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="comparison_id" value="${escapeHtml(model.comparison_id)}"><input type="hidden" name="side" value="right"><button class="action-button action-button-secondary" type="submit">${escapeHtml(t('open_right'))}</button></form>
      <a class="action-button action-button-secondary" href="${escapeHtml(options.compareHref)}">${escapeHtml(t('other'))}</a><a class="action-button action-button-secondary" href="${escapeHtml(options.backHref)}">${escapeHtml(t('back_project'))}</a>
    </div></section>`;
}

function projectChoice(model, csrfToken, options) {
  const { t } = options;
  const choices = model.choices ?? [];
  const left = model.left ?? choices[0]?.relative_path ?? '';
  const right = model.right ?? choices[1]?.relative_path ?? '';
  const optionList = (selected) => choices.map((item) => `<option value="${escapeHtml(item.relative_path)}" ${item.relative_path === selected ? 'selected' : ''}>${escapeHtml(item.relative_path)}</option>`).join('');
  return `<div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('project_eyebrow'))}</span><h1>${escapeHtml(t('project_heading'))}</h1><p class="lede">${escapeHtml(t('project_lede'))}</p></div></div>
    ${model.notice ? `<section class="surface"><p class="callout warn">${escapeHtml(model.notice)}</p></section>` : ''}
    <section class="surface">${choices.length < 2 ? `<p>${escapeHtml(t('too_few'))}</p>` : `<form method="post" action="${escapeHtml(model.compare_action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><label>${escapeHtml(t('first'))} <select name="left" style="max-width:100%">${optionList(left)}</select></label><label>${escapeHtml(t('second'))} <select name="right" style="max-width:100%">${optionList(right)}</select></label><p>${escapeHtml(t('sheet_help'))}</p><label>${escapeHtml(t('left_sheet'))}<input name="left_sheet" maxlength="31" value="${escapeHtml(model.left_sheet ?? '')}"></label><label>${escapeHtml(t('right_sheet'))}<input name="right_sheet" maxlength="31" value="${escapeHtml(model.right_sheet ?? '')}"></label><p>${escapeHtml(t('table_fields'))}</p><label>${escapeHtml(t('key_column'))}<input name="key_column" maxlength="1200" value="${escapeHtml(model.key_column ?? '')}"></label><label>${escapeHtml(t('period_column'))}<input name="period_column" maxlength="1200" value="${escapeHtml(model.period_column ?? '')}"></label><label>${escapeHtml(t('event_date_column'))}<input name="event_date_column" maxlength="1200" value="${escapeHtml(model.event_date_column ?? '')}"></label><div class="inline-actions"><button class="action-button" type="submit">${escapeHtml(t('compare'))}</button><a class="action-button action-button-secondary" href="${escapeHtml(options.backHref)}">${escapeHtml(t('back'))}</a></div></form>`}</section>`;
}

function body(model, csrfToken, options) {
  const { t } = options;
  if (model.mode === 'result') return comparisonResult(model, csrfToken, options);
  if (model.mode === 'project-choose') return projectChoice(model, csrfToken, options);
  if (model.mode === 'unsupported') {
    return `<div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('eyebrow'))}</span><h1>${escapeHtml(t('unsupported'))}</h1><p class="lede">${escapeHtml(t('unsupported_lede'))}</p></div></div><section class="surface"><p>${escapeHtml(model.message)}</p><div class="inline-actions"><a class="action-button" href="${escapeHtml(options.compareHref)}">${escapeHtml(t('choose_other'))}</a><a class="action-button action-button-secondary" href="${escapeHtml(options.backHref)}">${escapeHtml(t('back'))}</a></div></section>`;
  }
  const left = model.left ?? null;
  const right = model.right ?? null;
  return `<div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('eyebrow'))}</span><h1>${escapeHtml(t('title'))}</h1><p class="lede">${escapeHtml(t('lede'))}</p></div></div>
    <section class="surface"><div class="page-grid"><div>${selectionSummary(t('first'), left, t)}</div><div>${selectionSummary(t('second'), right, t)}</div></div>
      <div class="inline-actions">${!left ? pickerButton('left', null, model.desktop_picker_enabled, t) : (!right ? pickerButton('right', left.selection_id, model.desktop_picker_enabled, t) : `<form method="post" action="/compare/run"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="left_selection_id" value="${escapeHtml(left.selection_id)}"><input type="hidden" name="right_selection_id" value="${escapeHtml(right.selection_id)}"><button class="action-button" type="submit">${escapeHtml(t('run'))}</button></form>`)}<a class="action-button action-button-secondary" href="/files">${escapeHtml(t('back'))}</a></div>
      ${model.desktop_picker_enabled ? '' : `<p class="muted">${escapeHtml(t('desktop_only'))}</p>`}
    </section>`;
}

export function renderFileCompareView(model, options = {}) {
  const t = (key, values = {}) => {
    let value = translateUi(options.locale, `compare.${key}`, options.languageCatalog);
    for (const [name, replacement] of Object.entries(values)) value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  };
  const routes = { openEndpoint: options.openEndpoint ?? '/compare/open-original', compareHref: options.compareHref ?? '/compare', backHref: options.backHref ?? '/files', t };
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(t('title'))} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav(options.navCurrent ?? 'Files', { interactive: true, workspaceHref: options.workspaceHref, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace"><header class="topbar"><div><span class="label">Atlas Desktop</span><strong>${escapeHtml(t('title'))}</strong></div><span class="status status-safe">${escapeHtml(translateUi(options.locale, 'nav.on_device', options.languageCatalog))}</span></header><main class="page">${body(model, options.csrfToken, routes)}</main></div></div></body></html>`;
}
