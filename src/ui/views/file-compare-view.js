import { escapeHtml, renderFacts, renderNav, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function fileName(filePath) {
  return String(filePath ?? '').split(/[\\/]/u).pop() || 'File';
}

function pickerButton(side, leftSelectionId = null, enabled = false) {
  return `<button class="action-button" type="button" data-compare-picker="${escapeHtml(side)}"${leftSelectionId ? ` data-left-selection="${escapeHtml(leftSelectionId)}"` : ''}${enabled ? '' : ' disabled'}>${side === 'left' ? 'Choose first file' : 'Choose second file'}</button>`;
}

function selectionSummary(label, selected) {
  if (!selected) return `<div class="empty-state"><strong>${escapeHtml(label)}</strong><p>Choose a local file in Atlas Desktop.</p></div>`;
  return `<div class="surface-flat"><span class="label">${escapeHtml(label)}</span><strong>${escapeHtml(selected.name ?? fileName(selected.path))}</strong><small class="mono">${escapeHtml(selected.path)}</small></div>`;
}

function ratio(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'Not available';
}

function comparisonResult(model, csrfToken, options) {
  const comparison = model.comparison;
  const sources = comparison.sources ?? {};
  const evidence = comparison.evidence ?? {};
  const relation = comparison.relation ?? {};
  const limitations = [
    'Atlas compares supported local text formats only; it does not infer meaning or decide what to keep.',
    'PDF, DOCX, PPTX and XLSX comparison are not supported by the current local comparison processor.',
  ];
  if (comparison.attention?.maximum_returned_message_ids_per_side) {
    limitations.push(`Message ID lists are limited to ${comparison.attention.maximum_returned_message_ids_per_side} items per side.`);
  }
  return `<div class="page-intro"><div><span class="eyebrow">LOCAL COMPARISON</span><h1>Comparison ready</h1><p class="lede">Atlas compared these two files locally.</p></div></div>
    <section class="surface"><h2>Files</h2>${renderFacts([
      ['Left', sources.left?.name ?? fileName(sources.left?.path)],
      ['Right', sources.right?.name ?? fileName(sources.right?.path)],
      ['Exactly identical', relation.type === 'identical' ? 'Yes' : 'No'],
      ['Relationship', relation.type ?? 'Not available'],
      ['Based on', relation.basis ?? 'Not available'],
      ['Previous local result used', comparison.cache_hit ? 'Yes' : 'No'],
    ])}</section>
    <section class="surface"><h2>Local evidence</h2>${renderFacts([
      ['Left lines', evidence.left_line_count],
      ['Right lines', evidence.right_line_count],
      ['Shared lines', evidence.common_line_count],
      ['Left overlap', ratio(evidence.left_overlap_ratio)],
      ['Right overlap', ratio(evidence.right_overlap_ratio)],
      ['Shared message IDs', evidence.shared_message_id_count],
    ])}</section>
    <section class="surface"><h2>Limits</h2><ul>${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>
    <section class="surface"><div class="inline-actions">
      <form method="post" action="${escapeHtml(options.openEndpoint)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="comparison_id" value="${escapeHtml(model.comparison_id)}"><input type="hidden" name="side" value="left"><button class="action-button action-button-secondary" type="submit">Open left file</button></form>
      <form method="post" action="${escapeHtml(options.openEndpoint)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="comparison_id" value="${escapeHtml(model.comparison_id)}"><input type="hidden" name="side" value="right"><button class="action-button action-button-secondary" type="submit">Open right file</button></form>
      <a class="action-button action-button-secondary" href="${escapeHtml(options.compareHref)}">Compare other files</a><a class="action-button action-button-secondary" href="${escapeHtml(options.backHref)}">Back to Project</a>
    </div></section>`;
}

function projectChoice(model, csrfToken, options) {
  const choices = model.choices ?? [];
  const left = model.left ?? choices[0]?.relative_path ?? '';
  const right = model.right ?? choices[1]?.relative_path ?? '';
  const optionList = (selected) => choices.map((item) => `<option value="${escapeHtml(item.relative_path)}" ${item.relative_path === selected ? 'selected' : ''}>${escapeHtml(item.relative_path)}</option>`).join('');
  return `<div class="page-intro"><div><span class="eyebrow">PROJECT COMPARISON</span><h1>Compare Project files</h1><p class="lede">Choose two supported text files from this Project.</p></div></div>
    ${model.notice ? `<section class="surface"><p class="callout warn">${escapeHtml(model.notice)}</p></section>` : ''}
    <section class="surface">${choices.length < 2 ? '<p>Atlas found fewer than two files supported by the current local comparison processor.</p>' : `<form method="post" action="${escapeHtml(model.compare_action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><label>First file <select name="left" style="max-width:100%">${optionList(left)}</select></label><label>Second file <select name="right" style="max-width:100%">${optionList(right)}</select></label><div class="inline-actions"><button class="action-button" type="submit">Compare</button><a class="action-button action-button-secondary" href="${escapeHtml(options.backHref)}">Back</a></div></form>`}</section>`;
}

function body(model, csrfToken, options) {
  if (model.mode === 'result') return comparisonResult(model, csrfToken, options);
  if (model.mode === 'project-choose') return projectChoice(model, csrfToken, options);
  if (model.mode === 'unsupported') {
    return `<div class="page-intro"><div><span class="eyebrow">LOCAL COMPARISON</span><h1>Unsupported</h1><p class="lede">Atlas could not compare these files with the current local processor.</p></div></div><section class="surface"><p>${escapeHtml(model.message)}</p><div class="inline-actions"><a class="action-button" href="${escapeHtml(options.compareHref)}">Choose other files</a><a class="action-button action-button-secondary" href="${escapeHtml(options.backHref)}">Back</a></div></section>`;
  }
  const left = model.left ?? null;
  const right = model.right ?? null;
  return `<div class="page-intro"><div><span class="eyebrow">LOCAL COMPARISON</span><h1>Compare Files</h1><p class="lede">Choose two supported local text files. Atlas keeps the comparison in this session only.</p></div></div>
    <section class="surface"><div class="page-grid"><div>${selectionSummary('First file', left)}</div><div>${selectionSummary('Second file', right)}</div></div>
      <div class="inline-actions">${!left ? pickerButton('left', null, model.desktop_picker_enabled) : (!right ? pickerButton('right', left.selection_id, model.desktop_picker_enabled) : `<form method="post" action="/compare/run"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="left_selection_id" value="${escapeHtml(left.selection_id)}"><input type="hidden" name="right_selection_id" value="${escapeHtml(right.selection_id)}"><button class="action-button" type="submit">Compare files</button></form>`)}<a class="action-button action-button-secondary" href="/files">Back</a></div>
      ${model.desktop_picker_enabled ? '' : '<p class="muted">Compare Files is available only in Atlas Desktop, not browser mode.</p>'}
    </section>`;
}

export function renderFileCompareView(model, options = {}) {
  const routes = { openEndpoint: options.openEndpoint ?? '/compare/open-original', compareHref: options.compareHref ?? '/compare', backHref: options.backHref ?? '/files' };
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Compare Files · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav(options.navCurrent ?? 'Files', { interactive: true, workspaceHref: options.workspaceHref, settingsHref: options.settingsHref })}<div class="workspace"><header class="topbar"><div><span class="label">Atlas Desktop</span><strong>Compare Files</strong></div><span class="status status-safe">On this device</span></header><main class="page">${body(model, options.csrfToken, routes)}</main></div></div></body></html>`;
}
