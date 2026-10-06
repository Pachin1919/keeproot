import { escapeHtml, renderNav, renderStatus, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';
import { WORK_COPY_KEYS } from '../work-messages.js';

export function renderBoardView(model, options = {}) {
  const t = (key, values = {}) => translateUi(options.locale, key, options.languageCatalog).replace(/\{(\w+)\}/gu, (match, name) => String(values[name] ?? match));
  const h = (key, values) => escapeHtml(t(key, values));
  const fact = (value) => WORK_COPY_KEYS[value] ? t(WORK_COPY_KEYS[value]) : value;
  const policy = (value) => ({ pinned_version: t('work.pin_recorded'), follow_latest: t('work.follow_latest'), mixed: t('work.mixed_policy') })[value] ?? value;

const csrf = (token) => `<input type="hidden" name="csrf" value="${escapeHtml(token ?? '')}">`;
const revision = (board) => `<input type="hidden" name="base_revision" value="${escapeHtml(board.revision)}">`;

function shell(model, options, body, title = t('work.board')) {
  const base = model.base ?? `/projects/${encodeURIComponent(model.project.id)}`;
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { interactive: true, workspaceHref: '/projects', resourcesHref: `${base}/resources`, projectSection: 'results', importHref: '/files', settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('work.board'), project: model.project, ...options })}${body}</div></div></body></html>`;
}

function listView(model, options) {
  const body = `<main class="page"><div class="page-intro"><div><span class="eyebrow">${h('work.board_caps')}</span><h1>${h('work.project_boards')}</h1><p class="lede">${h('work.board_lede')}</p></div><a class="action-button action-button-secondary" href="${escapeHtml(model.base)}">${h('work.back_home')}</a></div>${model.notice ? `<p class="callout warn">${escapeHtml(model.notice)}</p>` : ''}<section class="surface"><h2>${h('work.boards')}</h2>${model.boards.length ? `<div class="project-home-list">${model.boards.map((board) => `<a class="project-home-list-target" href="${escapeHtml(board.desktop_href)}"><span><strong>${escapeHtml(board.title)}</strong><small>${h('work.board_count', { count: board.blocks.length, revision: board.revision })}</small></span></a>`).join('')}</div>` : `<p>${h('work.no_board')}</p>`}</section><section class="surface"><h2>${h('work.new_board')}</h2><form method="post" action="${escapeHtml(`${model.base}/boards/create`)}">${csrf(options.csrfToken)}<label>${h('work.title')} <input name="title" required maxlength="120"></label><button class="action-button" type="submit">${h('work.create_board')}</button></form></section></main>`;
  return shell(model, options, body, t('work.boards'));
}

function policyForm(model, block, options) {
  if (!block.version_policy) return '';
  const next = block.version_policy === 'pinned_version' ? 'follow_latest' : 'pinned_version';
  return `<form method="post" action="${escapeHtml(`${model.base}/boards/${model.board.board_id}/blocks/update`)}">${csrf(options.csrfToken)}${revision(model.board)}<input type="hidden" name="block_id" value="${escapeHtml(block.block_id)}"><input type="hidden" name="action" value="policy"><input type="hidden" name="version_policy" value="${escapeHtml(next)}"><button class="text-link" type="submit">${next === 'pinned_version' ? h('work.pin_recorded') : h('work.follow_latest')}</button></form>`;
}

function removeForm(model, block, options) {
  return `<form method="post" action="${escapeHtml(`${model.base}/boards/${model.board.board_id}/blocks/update`)}">${csrf(options.csrfToken)}${revision(model.board)}<input type="hidden" name="block_id" value="${escapeHtml(block.block_id)}"><input type="hidden" name="action" value="remove"><button class="text-link" type="submit">${h('work.remove')}</button></form>`;
}

function blockUpdateForm(model, block, options, action, label, disabled = false) {
  return `<form method="post" action="${escapeHtml(`${model.base}/boards/${model.board.board_id}/blocks/update`)}">${csrf(options.csrfToken)}${revision(model.board)}<input type="hidden" name="block_id" value="${escapeHtml(block.block_id)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button class="text-link" type="submit"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button></form>`;
}

function blockPreview(block, h) {
  const analysis = block.dashboard_projection ?? block.analysis_projection;
  if (analysis?.kind === 'table_work_group_sum' && analysis.complete === true) {
    const max = Math.max(1, ...analysis.groups.map((item) => Math.abs(item.sum)));
    const rows = analysis.groups.map((item) => {
      const width = Math.round(Math.abs(item.sum) / max * 100);
      const sign = item.sum < 0 ? 'negative' : item.sum > 0 ? 'positive' : 'zero';
      const left = item.sum < 0 ? `<span style="display:block;justify-self:end;width:${width}%;height:.8rem;background:#b95743"></span>` : '';
      const right = item.sum > 0 ? `<span style="display:block;width:${width}%;height:.8rem;background:#647d62"></span>` : '';
      return `<tr><th scope="row">${escapeHtml(item.value || h('work.analysis_empty_category'))}</th><td>${escapeHtml(item.sum)} ${escapeHtml(analysis.unit)}</td><td><span role="img" data-sign="${sign}" aria-label="${escapeHtml(item.value)}: ${escapeHtml(item.sum)} ${escapeHtml(analysis.unit)}" style="display:inline-grid;grid-template-columns:1fr 1px 1fr;align-items:center;width:180px;height:.8rem">${left}<span style="height:.8rem;background:#4d4943"></span>${right}</span></td></tr>`;
    }).join('');
    return `<section class="board-analysis-projection"><p><strong>${h('work.analysis_by', { formula: analysis.formula, measure: analysis.measure, dimension: analysis.dimension })}</strong> · ${h('work.analysis_unit_policy', { unit: analysis.unit, policy: analysis.null_policy })}</p><p><strong>${h('work.analysis_total', { total: analysis.grand_total, unit: analysis.unit, count: analysis.group_count })}</strong></p><div class="data-work-table-wrap"><table class="data-work-table"><thead><tr><th>${h('work.analysis_category')}</th><th>${h('work.analysis_value')}</th><th>${h('work.analysis_relative_bar')}</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted">${h('work.analysis_source', { save: analysis.save_id, result: analysis.resource_id ?? 'not recorded', sources: (analysis.source_resource_ids ?? []).join(', ') || 'not recorded', hash: analysis.result_sha256, revision: analysis.board_snapshot_revision })}</p></section>`;
  }
  if (analysis?.kind === 'table_work_pivot_sum' && analysis.complete === true) {
    const rows = analysis.matrix.map((item) => `<tr><th scope="row">${item.row === '__TOTAL__' ? h('work.analysis_total_column') : escapeHtml(item.row || h('work.analysis_empty_category'))}</th>${item.values.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}<td>${escapeHtml(item.total)}</td><td>${item.share_percent == null ? '—' : `${escapeHtml(item.share_percent)}%`}</td><td>${escapeHtml(item.rank ?? '—')}</td></tr>`).join('');
    return `<section class="board-analysis-projection"><p><strong>${h('work.dashboard_pivot', { row: analysis.row_dimension, column: analysis.column_dimension, measure: analysis.measure })}</strong> · ${h('work.analysis_unit_policy', { unit: analysis.unit, policy: analysis.null_policy })}</p><p><strong>${h('work.dashboard_grand_total', { total: analysis.grand_total, unit: analysis.unit })}</strong></p><div class="data-work-table-wrap"><table class="data-work-table"><thead><tr><th>${escapeHtml(analysis.row_dimension)}</th>${analysis.column_order.map((value) => `<th>${escapeHtml(value)}</th>`).join('')}<th>${h('work.analysis_total_column')}</th><th>${h('work.dashboard_share')}</th><th>${h('work.dashboard_rank')}</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted">${h('work.analysis_source', { save: analysis.save_id, result: analysis.resource_id ?? 'not recorded', sources: (analysis.source_resource_ids ?? []).join(', ') || 'not recorded', hash: analysis.result_sha256, revision: analysis.board_snapshot_revision })}</p></section>`;
  }
  if (analysis?.kind === 'table_work_trend_sum' && analysis.complete === true) {
    const values = analysis.monthly_totals.map((item) => item.sum);
    const min = Math.min(0, ...values); const max = Math.max(0, ...values); const span = Math.max(1, max - min);
    const x = (index) => 20 + index * (760 / Math.max(1, values.length - 1));
    const y = (value) => 170 - ((value - min) / span) * 130;
    const points = analysis.monthly_totals.map((item, index) => `${x(index)},${y(item.sum)}`).join(' ');
    const rows = analysis.monthly_totals.map((item) => `<tr><th scope="row">${escapeHtml(item.month)}</th><td>${escapeHtml(item.sum)} ${escapeHtml(analysis.unit)}</td></tr>`).join('');
    return `<section class="board-analysis-projection"><p><strong>${h('work.dashboard_trend', { field: analysis.date_field, start: analysis.start_month, end: analysis.end_month, measure: analysis.measure })}</strong> · ${h('work.analysis_unit_policy', { unit: analysis.unit, policy: analysis.null_policy })}</p><p>${h('work.dashboard_period_total', { label: h('work.dashboard_previous'), start: analysis.previous_period.start_month, end: analysis.previous_period.end_month, total: analysis.previous_period.total, unit: analysis.unit })} · ${h('work.dashboard_period_total', { label: h('work.dashboard_current'), start: analysis.current_period.start_month, end: analysis.current_period.end_month, total: analysis.current_period.total, unit: analysis.unit })}</p><p>${h('work.dashboard_change', { delta: analysis.delta, unit: analysis.unit, growth: analysis.growth_percent == null ? '—' : `${analysis.growth_percent}%` })}</p><svg class="board-trend-chart" role="img" aria-label="${escapeHtml(h('work.dashboard_trend_chart'))}" viewBox="0 0 800 190" width="100%" height="190"><line x1="20" y1="${y(0)}" x2="780" y2="${y(0)}" stroke="#9b958a"/><polyline points="${points}" fill="none" stroke="#647d62" stroke-width="3"/>${analysis.monthly_totals.map((item, index) => `<text x="${x(index)}" y="${y(item.sum) - 8}" text-anchor="middle">${escapeHtml(item.sum)}</text>`).join('')}</svg><div class="data-work-table-wrap"><table class="data-work-table"><thead><tr><th>${h('work.dashboard_month')}</th><th>${h('work.analysis_value')}</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted">${h('work.analysis_source', { save: analysis.save_id, result: analysis.resource_id ?? 'not recorded', sources: (analysis.source_resource_ids ?? []).join(', ') || 'not recorded', hash: analysis.result_sha256, revision: analysis.board_snapshot_revision })}</p></section>`;
  }
  const preview = block.preview;
  if (!preview) return '';
  if (preview.kind === 'image' && preview.content) return `<figure class="board-block-image-preview"><a href="${escapeHtml(preview.content)}"><img src="${escapeHtml(preview.content)}" alt="${escapeHtml(block.name ?? t('work.board_image'))}"></a><figcaption>${h('work.image_preview')} · <a class="text-link" href="${escapeHtml(preview.content)}">${h('work.open_full_image')}</a></figcaption></figure>`;
  if (preview.kind === 'text' && preview.content) return `<pre class="save-result-preview" style="white-space:pre-wrap;max-height:18rem;overflow:auto">${escapeHtml(preview.content)}${preview.bounded ? '…' : ''}</pre>`;
  if (preview.kind === 'table' && preview.content) {
    const table = preview.content;
    const columns = table.columns ?? [];
    const rows = (table.rows ?? []).slice(0, 5);
    return `<div class="data-work-table-wrap"><table class="data-work-table"><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="muted">${escapeHtml(table.sheet ?? t('work.table'))} · ${h('work.rows_count', { count: table.row_count ?? rows.length })}${table.bounded ? h('work.bounded_suffix') : ''}</p>`;
  }
  return '';
}

function blockActions(model, block, options, index, total) {
  return `<details class="board-block-actions"><summary>${h('work.block_actions')}</summary><div class="inline-actions">${blockUpdateForm(model, block, options, 'move-up', t('work.move_up'), index === 0)}${blockUpdateForm(model, block, options, 'move-down', t('work.move_down'), index === total - 1)}${policyForm(model, block, options)}${removeForm(model, block, options)}</div></details>`;
}

function categoryDrilldown(model, block, options, h) {
  const projection = block.dashboard_projection;
  if (!model.table_work_enabled || block.status !== 'fresh' || !block.table_work_session_id
    || projection?.kind !== 'table_work_group_sum' || projection.complete !== true || !Array.isArray(projection.groups)) return '';
  const forms = projection.groups.map((group) => `<form method="post" action="${escapeHtml(`${model.base}/boards/${encodeURIComponent(model.board.board_id)}/drill`)}" class="board-category-drilldown"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken ?? '')}"><input type="hidden" name="base_revision" value="${escapeHtml(model.board.revision)}"><input type="hidden" name="block_id" value="${escapeHtml(block.block_id)}"><input type="hidden" name="category" value="${escapeHtml(group.value)}"><button class="text-link" type="submit">${h('work.drilldown_category')}</button></form>`).join('');
  return `<div class="board-category-drilldowns"><p class="muted">${h('work.drilldown_help')}</p>${forms}</div>`;
}

function blockCard(model, block, options, index, total, h) {
  if (block.type === 'text') return `<article class="surface board-text-block"><span class="eyebrow">${h('work.text_caps')}</span><p class="board-text-content">${escapeHtml(block.text ?? '')}</p><details class="board-text-editor"><summary>${h('work.edit_text')}</summary><form method="post" action="${escapeHtml(`${model.base}/boards/${model.board.board_id}/blocks/update`)}">${csrf(options.csrfToken)}${revision(model.board)}<input type="hidden" name="block_id" value="${escapeHtml(block.block_id)}"><input type="hidden" name="action" value="edit-text"><label>${h('work.text')}<textarea name="text" maxlength="7000" required>${escapeHtml(block.text ?? '')}</textarea></label><button class="action-button action-button-secondary" type="submit">${h('work.save_text')}</button></form></details>${blockActions(model, block, options, index, total)}</article>`;
  const typeLabel = block.type === 'material_reference' ? t('work.material_reference_caps') : t('work.result_preview_caps');
  const openHref = block.resource_href ?? block.result_href;
  return `<article class="surface"><div class="project-home-section-heading"><div><span class="eyebrow">${escapeHtml(typeLabel)}</span><h2>${escapeHtml(block.name ?? block.resource_id ?? block.save_id)}</h2></div>${renderStatus(block.status, fact(block.status_label), options)}</div>${blockPreview(block, h)}${categoryDrilldown(model, block, options, h)}${block.reason ? `<p>${escapeHtml(fact(block.reason))}</p>` : ''}<div class="inline-actions">${openHref ? `<a class="text-link" href="${escapeHtml(openHref)}">${block.type === 'material_reference' ? h('work.open_resource') : h('work.open_work_result')}</a>` : ''}</div>${blockActions(model, block, options, index, total)}<details><summary>${h('work.reference_details')}</summary><dl class="fact-list"><div><dt>${h('work.policy')}</dt><dd>${escapeHtml(policy(block.version_policy))}</dd></div><div><dt>${h('work.updated')}</dt><dd>${escapeHtml(block.updated_at ?? t('work.unknown'))}</dd></div><div><dt>${h('work.source')}</dt><dd class="mono">${escapeHtml(block.path ?? block.recorded_path ?? t('work.unavailable'))}</dd></div></dl></details></article>`;
}

function detailView(model, options) {
  const board = model.board;
  const materialOptions = model.resources.map((item) => `<option value="${escapeHtml(item.resource_id)}">${escapeHtml(item.resource?.display_name ?? item.resource_id)}</option>`).join('');
  const resultOptions = model.results.map((item) => `<option value="${escapeHtml(item.save_id ?? item.work_id)}">${escapeHtml(item.name ?? item.save_id ?? item.work_id)}</option>`).join('');
  const folderOptions = model.folders.map((item) => `<option value="${escapeHtml(item.relative_path)}">${escapeHtml(item.relative_path)}</option>`).join('');
  const addBlocks = `<section class="surface board-add-blocks"><div><span class="eyebrow">${h('work.build')}</span><h2>${h('work.add_block')}</h2></div><div class="board-block-form-list"><form class="board-block-form board-text-block-form" method="post" action="${escapeHtml(`${model.base}/boards/${board.board_id}/blocks/add`)}">${csrf(options.csrfToken)}${revision(board)}<input type="hidden" name="block_type" value="text"><h3>${h('work.text_block')}</h3><label>${h('work.text')} <textarea name="text" maxlength="7000" required></textarea></label><button class="action-button" type="submit">${h('work.add_text')}</button></form><form class="board-block-form board-reference-block-form" method="post" action="${escapeHtml(`${model.base}/boards/${board.board_id}/blocks/add`)}">${csrf(options.csrfToken)}${revision(board)}<input type="hidden" name="block_type" value="material_reference"><h3>${h('work.material_reference')}</h3><div class="board-form-fields"><label>${h('work.material')} <select name="resource_id" required>${materialOptions}</select></label><label>${h('work.version')} <select name="version_policy"><option value="follow_latest">${h('work.follow_latest')}</option><option value="pinned_version">${h('work.pin_recorded')}</option></select></label></div><button class="action-button" type="submit"${materialOptions ? '' : ' disabled'}>${h('work.add_material')}</button></form><form class="board-block-form board-reference-block-form" method="post" action="${escapeHtml(`${model.base}/boards/${board.board_id}/blocks/add`)}">${csrf(options.csrfToken)}${revision(board)}<input type="hidden" name="block_type" value="result_preview"><h3>${h('work.result_preview')}</h3><div class="board-form-fields"><label>${h('work.saved_result_caps')} <select name="save_id" required>${resultOptions}</select></label><label>${h('work.version')} <select name="version_policy"><option value="pinned_version">${h('work.pin_verified')}</option><option value="follow_latest">${h('work.follow_latest')}</option></select></label></div><button class="action-button" type="submit"${resultOptions ? '' : ' disabled'}>${h('work.add_result')}</button></form></div></section>`;
  const portableDelivery = `<section id="portable-delivery" class="surface board-portable-delivery"><h2>${h('work.portable_delivery')}</h2><p>${h('work.delivery_help')}</p><form class="board-delivery-form" method="post" action="${escapeHtml(`${model.base}/boards/${board.board_id}/export`)}">${csrf(options.csrfToken)}${revision(board)}<label>${h('work.existing_folder')} <select name="folder" required>${folderOptions}</select></label><label>${h('work.delivery_format')} <select name="format"><option value="html">HTML</option><option value="md">Markdown</option></select></label><label>${h('work.file_name')} <input name="file_name" value="${escapeHtml(board.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'board-delivery')}.html" required></label><button class="action-button" type="submit"${folderOptions ? '' : ' disabled'}>${h('work.review_delivery')}</button></form></section>`;
  const freshnessLabel = board.freshness.status === 'needs_review' ? t('work.needs_review') : board.freshness.status === 'missing' ? t('work.missing_references') : t('work.fresh');
  const settings = `<details class="surface board-settings"><summary>${h('work.board_status')} · ${escapeHtml(freshnessLabel)} · ${h('work.revision')} ${escapeHtml(board.revision)}</summary><form method="post" action="${escapeHtml(`${model.base}/boards/${board.board_id}/title`)}">${csrf(options.csrfToken)}${revision(board)}<label>${h('work.title')} <input name="title" value="${escapeHtml(board.title)}" required maxlength="120"></label><button class="action-button action-button-secondary" type="submit">${h('work.save_title')}</button></form></details>`;
  const body = `<main class="page"><div class="page-intro"><div><span class="eyebrow">${h('work.board_caps')} / ${h('work.revision')} ${escapeHtml(board.revision)}</span><h1>${escapeHtml(board.title)}</h1><p class="lede">${h('work.board_detail_help')}</p></div><div class="inline-actions"><a class="action-button" href="#portable-delivery">${h('work.prepare_delivery')}</a><a class="action-button action-button-secondary" href="${escapeHtml(`${model.base}/boards`)}">${h('work.all_boards')}</a><a class="action-button action-button-secondary" href="${escapeHtml(model.base)}">${h('work.project_home')}</a></div></div>${model.notice ? `<p class="callout warn">${escapeHtml(model.notice)}</p>` : ''}${settings}<section><div class="section-heading"><div><span class="eyebrow">${h('work.blocks')}</span><h2>${h('work.delivery_content')}</h2></div></div>${board.blocks.length ? board.blocks.map((block, index) => blockCard(model, block, options, index, board.blocks.length, h)).join('') : `<p class="surface">${h('work.no_blocks')}</p>`}</section>${portableDelivery}${addBlocks}</main>`;
  return shell(model, options, body, board.title);
}


  return model.mode === 'detail' ? detailView(model, options) : listView(model, options);
}
