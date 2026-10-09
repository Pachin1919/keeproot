import { UI_DISPLAY_NAME } from '../brand.js';
import { escapeHtml, renderNav, renderTopbar } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

export function renderSaveDirectoryView(model, options = {}) {
  const locale = normalizeUiLocale(options.locale);
  const t = (key) => translateUi(locale, key, options.languageCatalog);
  const project = model.project ?? {};
  const base = model.base ?? '';
  const prepared = model.status === 'prepared';
  const executed = model.status === 'executed';
  const fields = [
    [t('save_directory.project'), project.name ?? project.id ?? ''],
    [t('save_directory.root'), model.root ?? ''],
    [t('save_directory.directory'), model.directory_path ?? ''],
    [t('save_directory.save_target'), model.save_target ?? ''],
    [t('save_directory.status'), model.status ?? ''],
  ];
  const form = prepared
    ? `<form method="post" action="${escapeHtml(base)}"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken ?? '')}"><input type="hidden" name="expected_plan_hash" value="${escapeHtml(model.plan_hash ?? '')}"><button class="action-button" type="submit">${escapeHtml(t('save_directory.confirm'))}</button></form>`
    : '';
  const completion = executed
    ? `<p class="callout safe">${escapeHtml(t('save_directory.created'))}</p><p>${escapeHtml(t('save_directory.next_action'))}</p>`
    : '';
  const body = `<main class="page save-directory-page"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('save_directory.eyebrow'))}</span><h1>${escapeHtml(t('save_directory.title'))}</h1><p class="lede">${escapeHtml(t('save_directory.explainer'))}</p></div><a class="action-button action-button-secondary" href="/projects/${encodeURIComponent(project.id ?? '')}">${escapeHtml(t('save_directory.back_project'))}</a></div>${model.notice ? `<section class="surface" role="alert"><p class="callout warn">${escapeHtml(model.notice)}</p></section>` : ''}<section class="surface"><dl>${fields.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')}</dl><p class="muted">${escapeHtml(t('save_directory.not_saved'))}</p>${completion}<div class="inline-actions">${form}</div></section></main>`;
  return `<!doctype html><html lang="${locale}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(t('save_directory.title'))} · ${UI_DISPLAY_NAME}</title><style>${uiStyles()}</style></head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Projects', { ...options, project: project, interactive: true, workspaceHref: '/projects', resourcesHref: `/projects/${encodeURIComponent(project.id ?? '')}/resources`, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('save_directory.title'), project, locale: options.locale, languageCatalog: options.languageCatalog })}${body}</div></div></body></html>`;
}
