import {
  escapeHtml, renderFacts, renderNav, renderStatus, renderTopbar, renderUiClientScript,
} from '../components.js';
import { preferenceHtmlAttributes, preferenceRailStyle } from '../preferences.js';
import { translateUi } from '../i18n.js';
import { uiStyles } from '../styles.js';

function radio(name, value, label, description, selected, swatch = null) {
  return `<label class="setting-choice"><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${value === selected ? ' checked' : ''}><span>${swatch ? `<i class="setting-swatch ${escapeHtml(swatch)}"></i>` : ''}<strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span></label>`;
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

export function renderSettingsView(model, options = {}) {
  const preferences = model.preferences;
  const locale = preferences.locale;
  const languageCatalog = options.languageCatalog ?? { packs: [], errors: [] };
  const t = (key) => translateUi(locale, key, languageCatalog);
  const packs = Array.isArray(languageCatalog.packs) ? languageCatalog.packs : [];
  const locales = [...new Set(['en', 'zh-CN', locale, ...packs.map((pack) => pack.locale)])];
  const languageOptions = locales.map((value) => {
    const pack = packs.find((item) => item.locale === value && item.namespace === 'atlas');
    const label = pack ? `${pack.name} (${value})` : value === 'zh-CN' ? t('settings.locale_zh_cn') : value === 'en' ? t('settings.locale_en') : value;
    return option(value, label, locale);
  }).join('');
  const packErrors = [options.languagePackError, ...(languageCatalog.errors ?? []).map((error) => error?.message)].filter((value) => typeof value === 'string' && value);
  const preview = options.languagePackPreview?.pack ?? options.languagePackPreview ?? null;
  const attributes = preferenceHtmlAttributes(preferences);
  const railStyle = preferenceRailStyle(preferences);
  return `<!doctype html><html lang="${escapeHtml(locale)}" ${attributes}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas ${escapeHtml(t('settings.title'))}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head>
  <body><div class="app-shell" style="${escapeHtml(railStyle)}">${renderNav('Settings', { interactive: true, workspaceHref: options.workspaceHref ?? '/', settingsHref: '/settings', locale, languageCatalog })}
  <div class="workspace">${renderTopbar({ section: t('settings.title'), locale, languageCatalog })}
  <dialog class="atlas-overlay settings-overlay" data-atlas-overlay data-overlay-autostart data-overlay-dirty-protect data-overlay-dirty="${options.error ? 'true' : 'false'}" data-overlay-return-href="${escapeHtml(options.returnHref ?? '/projects')}" aria-labelledby="atlas-settings-title">
  <main class="page settings-page overlay-card settings-overlay-card"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(t('settings.display_local'))}</span><h1 id="atlas-settings-title">${escapeHtml(t('settings.title'))}</h1><p class="lede">${escapeHtml(t('settings.lede'))}</p></div><button class="overlay-close" type="button" data-overlay-close data-overlay-initial-focus aria-label="${escapeHtml(t('settings.close'))}">×</button></div>
  ${options.saved ? `<p class="settings-notice">${escapeHtml(t('settings.saved'))}</p>` : ''}
  ${options.error ? `<p class="callout danger" role="alert">${escapeHtml(options.error)}</p>` : ''}
  <form method="post" action="/settings" class="settings-layout">
    <input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}">
    <input type="hidden" name="return_to" value="${escapeHtml(options.returnHref ?? '/projects')}">
    <input type="hidden" name="selected_theme" value="${escapeHtml(preferences.theme)}" data-settings-selected-theme>
    <input type="hidden" name="selected_accent" value="${escapeHtml(preferences.accent)}" data-settings-selected-accent>
    <div class="settings-main">
      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">${escapeHtml(t('settings.language_label'))}</span><h2>${escapeHtml(t('settings.language_heading'))}</h2></div><p>${escapeHtml(t('settings.language_description'))}</p></div>
        <label class="setting-field"><span>${escapeHtml(t('settings.language_select'))}</span><select name="locale">${languageOptions}</select></label>
      </section>
      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">${escapeHtml(t('settings.language_packs'))}</span><h2>${escapeHtml(t('settings.installed_language_packs'))}</h2></div><p>${escapeHtml(t('settings.language_packs_description'))}</p></div>
        ${packs.length ? `<ul class="settings-language-pack-list">${packs.map((pack) => `<li><strong>${escapeHtml(pack.name)}</strong><small>${escapeHtml(`${pack.locale} · ${pack.namespace} · ${pack.id}`)}</small></li>`).join('')}</ul>` : `<p class="muted">${escapeHtml(t('settings.no_language_packs'))}</p>`}
        ${packErrors.length ? `<div class="callout warn" role="alert">${packErrors.map((message) => `<p>${escapeHtml(message)}</p>`).join('')}</div>` : ''}
        ${preview?.id ? `<p class="settings-notice">${escapeHtml(`${preview.name} · ${preview.locale} · ${preview.namespace}`)}</p>` : ''}
        <label class="setting-field"><span>${escapeHtml(t('settings.language_pack_json'))}</span><textarea name="language_pack" rows="8" spellcheck="false">${escapeHtml(options.languagePackText ?? '')}</textarea></label>
        <div class="inline-actions"><button class="action-button action-button-secondary" type="submit" name="action" value="preview_language_pack">${escapeHtml(t('settings.preview_language_pack'))}</button><button class="action-button" type="submit" name="action" value="install_language_pack">${escapeHtml(t('settings.install_language_pack'))}</button></div>
      </section>
      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">${escapeHtml(t('settings.appearance'))}</span><h2>${escapeHtml(t('settings.theme_color'))}</h2></div><p>${escapeHtml(t('settings.palette_help'))}</p></div>
        <fieldset><legend>${escapeHtml(t('settings.background'))}</legend><div class="setting-choice-grid">
          ${radio('theme', 'slate', t('settings.theme_slate'), t('settings.theme_slate_detail'), preferences.theme, 'swatch-slate')}
          ${radio('theme', 'graphite', t('settings.theme_graphite'), t('settings.theme_graphite_detail'), preferences.theme, 'swatch-graphite')}
          ${radio('theme', 'warm_charcoal', t('settings.theme_warm'), t('settings.theme_warm_detail'), preferences.theme, 'swatch-warm')}
        </div></fieldset>
        <fieldset><legend>${escapeHtml(t('settings.accent'))}</legend><div class="setting-choice-grid">
          ${radio('accent', 'green', t('settings.accent_green'), t('settings.accent_green_detail'), preferences.accent, 'swatch-green')}
          ${radio('accent', 'vermilion', t('settings.accent_vermilion'), t('settings.accent_vermilion_detail'), preferences.accent, 'swatch-vermilion')}
          ${radio('accent', 'amber', t('settings.accent_amber'), t('settings.accent_amber_detail'), preferences.accent, 'swatch-amber')}
        </div></fieldset>
        <label class="setting-field"><span>${escapeHtml(t('settings.contrast'))}</span><select name="contrast">${option('high', t('settings.contrast_high'), preferences.contrast)}${option('standard', t('settings.contrast_standard'), preferences.contrast)}</select></label>
      </section>

      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">${escapeHtml(t('settings.reading'))}</span><h2>${escapeHtml(t('settings.text_density'))}</h2></div><p>${escapeHtml(t('settings.text_density_help'))}</p></div>
        <fieldset><legend>${escapeHtml(t('settings.text_size'))}</legend><div class="setting-choice-grid">
          ${radio('text_size', 'compact', t('settings.size_compact'), t('settings.size_compact_detail'), preferences.text_size)}
          ${radio('text_size', 'comfortable', t('settings.size_comfortable'), t('settings.size_comfortable_detail'), preferences.text_size)}
          ${radio('text_size', 'large', t('settings.size_large'), t('settings.size_large_detail'), preferences.text_size)}
        </div></fieldset>
        <fieldset><legend>${escapeHtml(t('settings.density'))}</legend><div class="setting-choice-grid two">
          ${radio('density', 'comfortable', t('settings.size_comfortable'), t('settings.density_comfortable'), preferences.density)}
          ${radio('density', 'compact', t('settings.size_compact'), t('settings.density_compact'), preferences.density)}
        </div></fieldset>
      </section>

      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">${escapeHtml(t('settings.layout'))}</span><h2>${escapeHtml(t('settings.navigation_detail'))}</h2></div><p>${escapeHtml(t('settings.layout_help'))}</p></div>
        <div class="setting-field-grid"><label class="setting-field"><span>${escapeHtml(t('settings.project_width'))}</span><input type="number" name="project_rail_width" min="220" max="420" step="1" value="${preferences.project_rail_width}"><small>220–420 px</small></label>
        <label class="setting-field"><span>${escapeHtml(t('settings.atlas_width'))}</span><input type="number" name="app_rail_width" min="68" max="360" step="1" value="${preferences.app_rail_width}"><small>${escapeHtml(t('settings.compact_rail'))}</small></label></div>
        <label class="setting-field"><span>${escapeHtml(t('settings.context_delay'))}</span><select name="context_card_delay">${option('fast', t('settings.delay_fast'), preferences.context_card_delay)}${option('normal', t('settings.delay_normal'), preferences.context_card_delay)}${option('deliberate', t('settings.delay_deliberate'), preferences.context_card_delay)}</select><small>${escapeHtml(t('settings.delay_help'))}</small></label>
        <label class="setting-toggle"><input type="checkbox" name="reduce_motion" value="yes"${preferences.reduce_motion ? ' checked' : ''}><span><strong>${escapeHtml(t('settings.limit_animation'))}</strong><small>${escapeHtml(t('settings.limit_animation_detail'))}</small></span></label>
        <label class="setting-toggle"><input type="checkbox" name="show_technical_ids" value="yes"${preferences.show_technical_ids ? ' checked' : ''}><span><strong>${escapeHtml(t('settings.diagnostics_mode'))}</strong><small>${escapeHtml(t('settings.diagnostics_mode_detail'))}</small></span></label>
      </section>
    </div>

    <aside class="settings-side"><section class="surface settings-preview"><span class="label">${escapeHtml(t('settings.preview'))}</span><h2>${escapeHtml(t('settings.workspace_color'))}</h2><p>${escapeHtml(t('settings.preview_help'))}</p><div class="preview-statuses">${renderStatus('ready', t('settings.preview_ready'))}${renderStatus('awaiting_review', t('settings.preview_waiting'))}${renderStatus('blocked', t('settings.preview_blocked'))}</div><div class="preview-row"><strong>${escapeHtml(t('settings.preview_file'))}</strong><small>${escapeHtml(t('settings.preview_source'))}</small></div><div class="preview-actions"><button class="action-button action-button-continue" type="button">${escapeHtml(t('settings.continue'))}</button><button class="action-button" type="button">${escapeHtml(t('settings.primary_action'))}</button><button class="action-button action-button-remove" type="button">${escapeHtml(t('settings.remove'))}</button></div></section>
      <section class="surface settings-boundary"><h2>${escapeHtml(t('settings.boundary'))}</h2><ul><li>${escapeHtml(t('settings.boundary_routing'))}</li><li>${escapeHtml(t('settings.boundary_approval'))}</li><li>${escapeHtml(t('settings.boundary_install'))}</li><li>${escapeHtml(t('settings.boundary_history'))}</li></ul></section>
      <details class="surface technical-details technical-id"><summary>${escapeHtml(t('settings.runtime_diagnostics'))}</summary>${renderFacts([[t('settings.atlas_version'), model.runtime?.atlas_version ?? t('settings.unavailable')], [t('settings.node_version'), model.runtime?.node_version ?? t('settings.unavailable')], [t('settings.runtime_source'), model.runtime?.runtime_root ?? t('settings.unavailable'), true], [t('settings.state_location'), model.runtime?.state_dir ?? t('settings.unavailable'), true], [t('settings.content_component'), model.runtime?.python?.status ?? t('settings.unavailable')], [t('settings.ledger_integrity'), model.runtime?.ledger?.integrity ?? t('settings.unavailable')]])}<p class="muted">${escapeHtml(t('settings.diagnostics_help'))}</p></details>
      <div class="settings-actions"><button class="action-button" type="submit" name="action" value="save">${escapeHtml(t('settings.save'))}</button><button class="action-button action-button-secondary" type="submit" name="action" value="reset">${escapeHtml(t('settings.reset'))}</button></div>
    </aside>
  </form></main></dialog></div></div></body></html>`;
}
