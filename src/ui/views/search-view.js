import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

function results(model, t) {
  if (!model.query) return `<section class="surface empty-state"><strong>${escapeHtml(t('empty'))}</strong><p>${escapeHtml(t('empty_detail'))}</p></section>`;
  if (!model.items.length) return `<section class="surface empty-state"><strong>${escapeHtml(t('no_matches'))}</strong><p>${escapeHtml(t('no_matches_detail').replaceAll('{query}', model.query))}</p></section>`;
  return `<section class="surface"><div class="search-results">${model.items.map((item) => {
    const href = item.href ?? (item.kind === 'project'
      ? `/projects/${encodeURIComponent(item.project_id)}/resources`
      : `/projects/${encodeURIComponent(item.project_id)}/resources?path=${encodeURIComponent(item.relative_path)}`);
    const kind = item.kind === 'project' ? t('project')
      : item.kind === 'relationship' ? t('relationship')
        : item.kind === 'activity' ? t('activity') : item.extension || t('file');
    const detail = item.detail ?? (item.kind === 'project' ? item.project_name : `${item.project_name} / ${item.relative_path}`);
    return `<a class="search-result" href="${escapeHtml(href)}"><span class="search-result-kind">${escapeHtml(kind)}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(detail)}</small></span><span aria-hidden="true">→</span></a>`;
  }).join('')}</div>${model.truncated ? `<p class="callout warn">${escapeHtml(t('truncated'))}</p>` : ''}</section>`;
}

export function renderSearchView(model, options = {}) {
  const t = (key) => translateUi(options.locale, `search.${key}`, options.languageCatalog);
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(t('title'))} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('', { interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('title'), locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('eyebrow'))}</span><h1>${escapeHtml(t('title'))}</h1><p class="lede">${escapeHtml(t('lede'))}</p></div></div><form class="surface search-page-form" method="get" action="/search"><label for="search-page-query">${escapeHtml(t('label'))}</label><div><input id="search-page-query" name="q" type="search" value="${escapeHtml(model.query)}" autofocus><button class="action-button" type="submit">${escapeHtml(t('title'))}</button></div></form>${model.unavailable?.length ? `<p class="callout warn">${escapeHtml(t(model.unavailable.length === 1 ? 'unavailable_one' : 'unavailable').replaceAll('{count}', String(model.unavailable.length)))}</p>` : ''}${results(model, t)}</main></div></div></body></html>`;
}
