import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function results(model) {
  if (!model.query) return '<section class="surface empty-state"><strong>Search registered Projects</strong><p>Use a Project name, file name, extension, or path fragment.</p></section>';
  if (!model.items.length) return `<section class="surface empty-state"><strong>No local matches</strong><p>No registered Project or Resource matched “${escapeHtml(model.query)}”.</p></section>`;
  return `<section class="surface"><div class="search-results">${model.items.map((item) => {
    const href = item.href ?? (item.kind === 'project'
      ? `/projects/${encodeURIComponent(item.project_id)}/resources`
      : `/projects/${encodeURIComponent(item.project_id)}/resources?path=${encodeURIComponent(item.relative_path)}`);
    const kind = item.kind === 'project' ? 'Project'
      : item.kind === 'relationship' ? 'Known relationship'
        : item.kind === 'activity' ? 'Activity' : item.extension || 'File';
    const detail = item.detail ?? (item.kind === 'project' ? item.project_name : `${item.project_name} / ${item.relative_path}`);
    return `<a class="search-result" href="${escapeHtml(href)}"><span class="search-result-kind">${escapeHtml(kind)}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(detail)}</small></span><span aria-hidden="true">→</span></a>`;
  }).join('')}</div>${model.truncated ? '<p class="callout warn">Results are limited. Use a more specific name or path.</p>' : ''}</section>`;
}

export function renderSearchView(model, options = {}) {
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Search · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('', { interactive: true, workspaceHref: '/projects', settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Search' })}<main class="page"><div class="page-intro"><div><span class="eyebrow">LOCAL SEARCH</span><h1>Search</h1><p class="lede">Find registered Projects and Resources without reading file contents.</p></div></div><form class="surface search-page-form" method="get" action="/search"><label for="search-page-query">Project name, file name, extension, or path</label><div><input id="search-page-query" name="q" type="search" value="${escapeHtml(model.query)}" autofocus><button class="action-button" type="submit">Search</button></div></form>${model.unavailable?.length ? `<p class="callout warn">${escapeHtml(model.unavailable.length)} Project folder${model.unavailable.length === 1 ? ' was' : 's were'} unavailable and could not be searched.</p>` : ''}${results(model)}</main></div></div></body></html>`;
}
