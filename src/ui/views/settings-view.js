import {
  escapeHtml, renderFacts, renderNav, renderStatus, renderTopbar, renderUiClientScript,
} from '../components.js';
import { preferenceHtmlAttributes, preferenceRailStyle } from '../preferences.js';
import { uiStyles } from '../styles.js';

function radio(name, value, label, description, selected, swatch = null) {
  return `<label class="setting-choice"><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${value === selected ? ' checked' : ''}><span>${swatch ? `<i class="setting-swatch ${escapeHtml(swatch)}"></i>` : ''}<strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span></label>`;
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

export function renderSettingsView(model, options = {}) {
  const preferences = model.preferences;
  const attributes = preferenceHtmlAttributes(preferences);
  const railStyle = preferenceRailStyle(preferences);
  return `<!doctype html><html lang="en" ${attributes}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas Settings</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head>
  <body><div class="app-shell" style="${escapeHtml(railStyle)}">${renderNav('Settings', { interactive: true, workspaceHref: options.workspaceHref ?? '/', settingsHref: '/settings' })}
  <div class="workspace">${renderTopbar({ section: 'Settings' })}
  <dialog class="atlas-overlay settings-overlay" data-atlas-overlay data-overlay-autostart data-overlay-dirty-protect data-overlay-dirty="${options.error ? 'true' : 'false'}" data-overlay-return-href="${escapeHtml(options.returnHref ?? '/projects')}" aria-labelledby="atlas-settings-title">
  <main class="page settings-page overlay-card settings-overlay-card"><div class="page-intro"><div><span class="eyebrow">DISPLAY / LOCAL</span><h1 id="atlas-settings-title">Settings</h1><p class="lede">Adjust how Atlas looks and reads. File governance rules are not changed here.</p></div><button class="overlay-close" type="button" data-overlay-close data-overlay-initial-focus aria-label="Close Settings">×</button></div>
  ${options.saved ? '<p class="settings-notice">Display settings saved and applied.</p>' : ''}
  ${options.error ? `<p class="callout danger" role="alert">${escapeHtml(options.error)}</p>` : ''}
  <form method="post" action="/settings" class="settings-layout">
    <input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}">
    <input type="hidden" name="return_to" value="${escapeHtml(options.returnHref ?? '/projects')}">
    <input type="hidden" name="selected_theme" value="${escapeHtml(preferences.theme)}" data-settings-selected-theme>
    <input type="hidden" name="selected_accent" value="${escapeHtml(preferences.accent)}" data-settings-selected-accent>
    <div class="settings-main">
      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">Appearance</span><h2>Theme and color</h2></div><p>Curated palettes preserve readable contrast; arbitrary color values are not accepted.</p></div>
        <fieldset><legend>Background palette</legend><div class="setting-choice-grid">
          ${radio('theme', 'slate', 'Archive Signal', 'Charcoal, vermilion, ochre and paper.', preferences.theme, 'swatch-slate')}
          ${radio('theme', 'graphite', 'Post-Internet Plum', 'Plum, mint, coral and warm white.', preferences.theme, 'swatch-graphite')}
          ${radio('theme', 'warm_charcoal', 'Gallery Grid', 'Stone, black-green, ochre and sage.', preferences.theme, 'swatch-warm')}
        </div></fieldset>
        <fieldset><legend>Accent</legend><div class="setting-choice-grid">
          ${radio('accent', 'green', 'Sage', 'Calm local status.', preferences.accent, 'swatch-green')}
          ${radio('accent', 'vermilion', 'Vermilion', 'Stronger editorial emphasis.', preferences.accent, 'swatch-vermilion')}
          ${radio('accent', 'amber', 'Ochre', 'Warm active emphasis.', preferences.accent, 'swatch-amber')}
        </div></fieldset>
        <label class="setting-field"><span>Text contrast</span><select name="contrast">${option('high', 'High — clearer secondary text', preferences.contrast)}${option('standard', 'Standard — quieter secondary text', preferences.contrast)}</select></label>
      </section>

      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">Reading</span><h2>Text and density</h2></div><p>Text size changes typography. Density changes row height and spacing independently.</p></div>
        <fieldset><legend>Text size</legend><div class="setting-choice-grid">
          ${radio('text_size', 'compact', 'Compact', '14px base; dense metadata work.', preferences.text_size)}
          ${radio('text_size', 'comfortable', 'Comfortable', '16px base; recommended.', preferences.text_size)}
          ${radio('text_size', 'large', 'Large', '17px base; easier long reading.', preferences.text_size)}
        </div></fieldset>
        <fieldset><legend>Information density</legend><div class="setting-choice-grid two">
          ${radio('density', 'comfortable', 'Comfortable', 'More spacing between working rows.', preferences.density)}
          ${radio('density', 'compact', 'Compact', 'Fit more resources on screen.', preferences.density)}
        </div></fieldset>
      </section>

      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">Layout</span><h2>Navigation and technical detail</h2></div><p>These values become the default after Atlas restarts. Dragging a separator still overrides them for the current session.</p></div>
        <div class="setting-field-grid"><label class="setting-field"><span>Project navigation width</span><input type="number" name="project_rail_width" min="220" max="420" step="1" value="${preferences.project_rail_width}"><small>220–420 px</small></label>
        <label class="setting-field"><span>Atlas navigation width</span><input type="number" name="app_rail_width" min="68" max="360" step="1" value="${preferences.app_rail_width}"><small>68–360 px · compact icon rail below 96 px</small></label></div>
        <label class="setting-field"><span>Resource context delay</span><select name="context_card_delay">${option('fast', 'Fast — 0.25 seconds', preferences.context_card_delay)}${option('normal', 'Normal — 0.65 seconds', preferences.context_card_delay)}${option('deliberate', 'Deliberate — 1.2 seconds', preferences.context_card_delay)}</select><small>How long a file stays hovered or focused before Atlas shows its context card.</small></label>
        <label class="setting-toggle"><input type="checkbox" name="reduce_motion" value="yes"${preferences.reduce_motion ? ' checked' : ''}><span><strong>Limit animation</strong><small>Reduce nonessential movement and transitions. Progress and state changes remain visible.</small></span></label>
        <label class="setting-toggle"><input type="checkbox" name="show_technical_ids" value="yes"${preferences.show_technical_ids ? ' checked' : ''}><span><strong>Diagnostic mode</strong><small>Off by default. Turn it on only when troubleshooting to reveal IDs, Hashes, RuleVersion and Ledger details.</small></span></label>
      </section>
    </div>

    <aside class="settings-side"><section class="surface settings-preview"><span class="label">Preview</span><h2>Workspace color</h2><p>Theme changes the whole workspace. Accent changes the primary action and selected state.</p><div class="preview-statuses">${renderStatus('ready')}${renderStatus('awaiting_review')}${renderStatus('blocked')}</div><div class="preview-row"><strong>Campaign report.csv</strong><small>Source checked · one decision waiting</small></div><div class="preview-actions"><button class="action-button action-button-continue" type="button">Continue</button><button class="action-button" type="button">Primary action</button><button class="action-button action-button-remove" type="button">Remove</button></div></section>
      <section class="surface settings-boundary"><h2>What Settings does not change</h2><ul><li>Project routing and naming rules</li><li>Approval or recovery policy</li><li>Runtime installation</li><li>Ledger facts and history</li></ul></section>
      <details class="surface technical-details technical-id"><summary>Runtime diagnostics</summary>${renderFacts([['Atlas version', model.runtime?.atlas_version ?? 'Not available'], ['Node version', model.runtime?.node_version ?? 'Not available'], ['Runtime source', model.runtime?.runtime_root ?? 'Not available', true], ['State location', model.runtime?.state_dir ?? 'Not available', true], ['Content component', model.runtime?.python?.status ?? 'Not available'], ['Ledger integrity', model.runtime?.ledger?.integrity ?? 'Not available']])}<p class="muted">Ledger is Atlas's internal write and recovery record. Hashes identify exact file content. They are diagnostic facts, not tasks the user must manage.</p></details>
      <div class="settings-actions"><button class="action-button" type="submit" name="action" value="save">Save settings</button><button class="action-button action-button-secondary" type="submit" name="action" value="reset">Restore defaults</button></div>
    </aside>
  </form></main></dialog></div></div></body></html>`;
}
