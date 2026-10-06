import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';
import { renderMarkdown } from '../../markdown-reader.js';

export function renderResourceReaderView(model, options = {}) {
  const h = value => escapeHtml(value ?? '');
  const t = key => translateUi(options.locale, `reader.${key}`, options.languageCatalog);
  const project = model.project; const reader = model.reader ?? {};
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const localHref = (href, fallback = `${base}/resources`) => {
    if (typeof href !== 'string' || !href.startsWith(`${base}/resources`) || /[\x00-\x20\\]/u.test(href)) return fallback;
    try { const url = new URL(href, 'http://atlas.local'); return url.origin === 'http://atlas.local' && (url.pathname === `${base}/resources` || url.pathname.startsWith(`${base}/resources/`)) ? href : fallback; } catch { return fallback; }
  };
  const returnHref = localHref(model.returnHref);
  const detailsHref = localHref(model.detailsHref);
  const readHref = id => `${base}/resources/read?${new URLSearchParams({ resource_id: id, return_to: returnHref })}`;
  let imageUrl = null;
  let pdfUrl = null;
  try {
    const url = new URL(reader.image_url, 'http://atlas.local');
    if (url.origin === 'http://atlas.local' && url.pathname === `${base}/resources/read-image`
      && url.searchParams.get('resource_id') === reader.resource_id
      && url.searchParams.get('expected_sha256') === reader.sha256) imageUrl = url.pathname + url.search;
  } catch {}
  try {
    const url = new URL(reader.pdf_url, 'http://atlas.local');
    if (typeof reader.pdf_url === 'string' && reader.pdf_url.startsWith('/') && !/[\s\\]/u.test(reader.pdf_url)
      && url.origin === 'http://atlas.local' && url.pathname === `${base}/resources/read-pdf`
      && url.searchParams.get('resource_id') === reader.resource_id && /^[a-f0-9]{64}$/u.test(reader.sha256 ?? '')
      && url.searchParams.get('expected_sha256') === reader.sha256 && !url.hash) pdfUrl = url.pathname + url.search;
  } catch {}
  let body;
  if (model.notice) body = `<div class="reader-empty" role="alert"><h2>${h(t('unavailable'))}</h2><p>${h(model.notice)}</p><a href="${h(detailsHref)}">${h(t('details'))}</a></div>`;
  else if (reader.kind === 'markdown' && typeof reader.text === 'string') body = `<article class="reader-paper reader-markdown">${renderMarkdown(reader.text, model.links ?? [])}</article>`;
  else if (reader.kind === 'text' && typeof reader.text === 'string') body = `<article class="reader-paper"><pre class="reader-text">${h(reader.text)}</pre></article>`;
  else if (reader.kind === 'table' && reader.table) {
    const table = reader.table;
    const pageHref = (offset, sheet = table.sheet) => `${base}/resources/read?${new URLSearchParams({resource_id: reader.resource_id, expected_sha256: reader.sha256, offset: String(offset), return_to: returnHref, ...(sheet !== null ? {sheet} : {})})}`;
    const sheets = table.sheets.map(sheet => `<a class="reader-button" href="${h(pageHref(0, sheet))}"${sheet === table.sheet ? ' aria-current="page"' : ''}>${h(sheet)}</a>`).join('');
    const previous = table.offset > 0 ? `<a class="reader-button" href="${h(pageHref(table.offset - 50))}">${h(t('table_previous'))}</a>` : '';
    const next = table.offset + 50 < table.total_rows ? `<a class="reader-button" href="${h(pageHref(table.offset + 50))}">${h(t('table_next'))}</a>` : '';
    body = `<article class="reader-paper reader-table"><nav class="reader-table-controls" aria-label="${h(t('table_sheets'))}">${sheets}</nav><p class="reader-format-note">${h(t('table_format'))}</p><div class="reader-table-controls">${previous}<span>${table.total_rows ? table.offset + 1 : 0}–${Math.min(table.offset + 50, table.total_rows)} / ${table.total_rows}${table.truncated ? '+' : ''}</span>${next}</div>${table.truncated ? `<p role="status">${h(t('table_truncated'))}</p>` : ''}${table.warnings.length ? `<details class="reader-format-note"><summary>${h(t('table_warnings'))}</summary><ul>${table.warnings.map(warning => `<li>${h(t(`table_${warning}`))}</li>`).join('')}</ul></details>` : ''}<div class="reader-table-scroll" tabindex="0"><table><thead><tr><th scope="col">#</th>${table.columns.map(column => `<th scope="col">${h(column)}</th>`).join('')}</tr></thead><tbody>${table.rows.map(row => `<tr><th scope="row">${row.number}</th>${table.columns.map((_,index) => `<td>${h(row.cells[index] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${!table.rows.length ? `<p>${h(t('table_empty'))}</p>` : ''}</article>`;
  }
  else if (reader.kind === 'docx' && Array.isArray(reader.document?.blocks)) {
    const document = reader.document;
    const blocks = document.blocks.map(block => block.kind === 'table'
      ? `<div class="reader-table-scroll" tabindex="0"><table><tbody>${block.rows.map(row => `<tr>${row.map(cell => `<td>${h(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<${block.heading ? `h${block.heading}` : 'p'}>${h(block.text)}</${block.heading ? `h${block.heading}` : 'p'}>`).join('');
    body = `<article class="reader-paper reader-docx"><p class="reader-format-note">${h(t('docx_format'))}</p>${document.truncated ? `<p role="status" class="reader-format-note">${h(t('docx_truncated'))}</p>` : ''}${document.warnings?.length ? `<details class="reader-format-note"><summary>${h(t('docx_partial'))}</summary><ul>${document.warnings.map(warning => `<li>${h(t(`docx_${warning}`))}</li>`).join('')}</ul></details>` : ''}${blocks || `<p>${h(t('docx_empty'))}</p>`}</article>`;
  }
  else if (reader.kind === 'image' && imageUrl) body = `<div class="reader-image"><img src="${h(imageUrl)}" alt="${h(reader.name)}"></div>`;
  else if (reader.kind === 'pdf' && pdfUrl) {
    const messages = Object.fromEntries(['pdf_loading', 'pdf_rendering', 'pdf_error', 'pdf_changed', 'pdf_password', 'pdf_invalid', 'pdf_limit', 'pdf_page_limit', 'pdf_page_status'].map(key => [key, t(key)]));
    body = `<section class="reader-pdf" data-pdf-reader data-pdf-url="${h(pdfUrl)}" data-pdf-messages="${h(JSON.stringify(messages))}" aria-label="${h(t('pdf_document'))}"><div class="reader-pdf-toolbar"><button type="button" class="reader-button" data-pdf-prev disabled>${h(t('pdf_previous'))}</button><label for="reader-pdf-page">${h(t('pdf_page'))}</label><input id="reader-pdf-page" type="number" min="1" max="500" value="1" inputmode="numeric" data-pdf-page disabled><span data-pdf-total>/ —</span><button type="button" class="reader-button" data-pdf-next disabled>${h(t('pdf_next'))}</button><label for="reader-pdf-zoom">${h(t('pdf_zoom'))}</label><select id="reader-pdf-zoom" data-pdf-zoom disabled><option value="fit">${h(t('pdf_fit'))}</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></div><p class="reader-pdf-status" data-pdf-status role="status" aria-live="polite">${h(t('pdf_loading'))}</p><div class="reader-pdf-pages" data-pdf-stage aria-busy="true"><canvas data-pdf-canvas hidden aria-label="${h(t('pdf_canvas'))}"></canvas></div><noscript><p>${h(t('pdf_javascript'))}</p></noscript></section>`;
  }
  else body = `<div class="reader-empty"><h2>${h(t('unsupported'))}</h2><p>${h(t('unsupported_help'))}</p><a href="${h(detailsHref)}">${h(t('details'))}</a></div>`;
  const button = (control, key, target, expanded) => `<button class="reader-button" type="button" data-reader-${control} aria-controls="${target}" aria-expanded="${expanded}"${control === 'focus-toggle' ? ' aria-pressed="false"' : ''}>${h(t(key))}</button>`;
  const files = (model.resources ?? []).map(item => `<li><a href="${h(readHref(item.resource_id))}"${item.resource_id === reader.resource_id ? ' aria-current="page"' : ''}><strong>${h(item.name)}</strong><small>${h(item.relative_path)}</small></a></li>`).join('');
  const edit = !model.notice && reader.relative_path ? `<form method="post" action="${h(`${base}/resources/open`)}"><input type="hidden" name="csrf" value="${h(options.csrfToken)}"><input type="hidden" name="path" value="${h(reader.relative_path)}"><button class="reader-button" type="submit">${h(t('external_edit'))}</button></form>` : '';
  const technical = `<details class="reader-technical"><summary>${h(t('technical'))}</summary><dl><dt>${h(t('path'))}</dt><dd>${h(reader.relative_path)}</dd><dt>${h(t('resource_id'))}</dt><dd>${h(reader.resource_id)}</dd><dt>SHA-256</dt><dd>${h(reader.sha256)}</dd><dt>${h(t('bytes'))}</dt><dd>${h(reader.bytes)}</dd></dl></details>`;
  const relationshipRows = (model.relationships?.edges ?? []).map(edge => {
    const node = model.relationships.nodes?.find(item => item.resource_id === edge.adjacent_resource_id);
    const href = readHref(edge.adjacent_resource_id);
    const note = typeof edge.evidence?.note === 'string' ? edge.evidence.note : typeof edge.evidence?.reason === 'string' ? edge.evidence.reason : '';
    return `<li><a href="${h(href)}">${h(node?.name ?? edge.adjacent_resource_id)}</a><small>${h(t(edge.direction === 'incoming' ? 'incoming' : 'outgoing'))} · ${h(edge.type === 'linked_to' ? t('linked_to') : edge.type)}</small>${note ? `<p>${h(note.slice(0, 120))}${note.length > 120 ? '…' : ''}</p>` : ''}<details><summary>${h(t('evidence'))}</summary><pre>${h(JSON.stringify(edge.evidence ?? {}, null, 2))}</pre></details></li>`;
  }).join('');
  const relationships = `<section class="reader-relationships"><h3>${h(t('stored_relationships'))}</h3><p>${h(t('not_verified'))}</p>${model.relationshipNotice ? `<p role="status">${h(model.relationshipNotice)}</p>` : relationshipRows ? `<ul>${relationshipRows}</ul>` : `<p>${h(t('no_relationships'))}</p>`}${model.relationships?.truncated ? `<p>${h(t('truncated'))}</p>` : ''}</section>`;
  const pdfScript = !model.notice && reader.kind === 'pdf' && pdfUrl ? '<script type="module" src="/ui/pdf-reader.js"></script>' : '';
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(reader.name ?? t('title'))} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}${pdfScript}</head><body class="atlas-reader-body"><div class="app-shell reader-shell">${renderNav('Resources', { interactive: true, workspaceHref: '/projects', resourcesHref: returnHref, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace reader-workspace">${renderTopbar({ section: t('title'), project, locale: options.locale, languageCatalog: options.languageCatalog })}<main class="resource-reader" data-resource-reader><header class="reader-toolbar"><a class="reader-button" href="${h(returnHref)}">${h(t('return'))}</a><h1 title="${h(reader.relative_path)}">${h(reader.name ?? t('title'))}</h1><div class="reader-toolbar-actions">${button('files-toggle', 'files', 'reader-files', true)}${button('focus-toggle', 'focus', 'reader-content', false)}${button('source-toggle', 'source', 'reader-source', false)}${edit}</div></header><div class="reader-layout"><nav class="reader-files" id="reader-files" aria-label="${h(t('files'))}"><h2>${h(t('files'))}</h2><ul>${files}</ul></nav><section class="reader-content" id="reader-content" tabindex="-1" aria-label="${h(t('content'))}">${body}</section><aside class="reader-source" id="reader-source" hidden><h2>${h(t('source'))}</h2><p>${h(t('source_help'))}</p><a class="text-link" href="${h(detailsHref)}">${h(t('details'))}</a>${relationships}${technical}</aside></div></main></div></div></body></html>`;
}
