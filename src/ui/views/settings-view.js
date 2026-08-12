import {
  escapeHtml, renderNav, renderStatus, renderUiClientScript,
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
  <div class="workspace"><header class="topbar"><div><span class="label">Atlas Desktop</span><strong>Settings</strong></div>${renderStatus(model.runtime?.ledger?.integrity ?? 'unavailable')}</header>
  <main class="page settings-page"><div class="page-intro"><div><span class="eyebrow">DISPLAY / LOCAL</span><h1>Settings</h1><p class="lede">Adjust how Atlas looks and reads. File governance rules are not changed here.</p></div></div>
  ${options.saved ? '<p class="settings-notice">Display settings saved and applied.</p>' : ''}
  <form method="post" action="/settings" class="settings-layout">
    <input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}">
    <div class="settings-main">
      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">Appearance</span><h2>Theme and color</h2></div><p>Curated palettes preserve readable contrast; arbitrary color values are not accepted.</p></div>
        <fieldset><legend>Background palette</legend><div class="setting-choice-grid">
          ${radio('theme', 'slate', 'Dark slate', 'Balanced blue-gray surfaces.', preferences.theme, 'swatch-slate')}
          ${radio('theme', 'graphite', 'Graphite', 'Darker, sharper neutral contrast.', preferences.theme, 'swatch-graphite')}
          ${radio('theme', 'warm_charcoal', 'Warm charcoal', 'A softer brown-charcoal base.', preferences.theme, 'swatch-warm')}
        </div></fieldset>
        <fieldset><legend>Accent</legend><div class="setting-choice-grid">
          ${radio('accent', 'green', 'Atlas green', 'Calm and familiar.', preferences.accent, 'swatch-green')}
          ${radio('accent', 'blue', 'Steel blue', 'Cooler technical emphasis.', preferences.accent, 'swatch-blue')}
          ${radio('accent', 'amber', 'Muted amber', 'Warmer active emphasis.', preferences.accent, 'swatch-amber')}
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
          ${radio('density', 'compact', 'Compact', 'Fit more Tasks on screen.', preferences.density)}
        </div></fieldset>
      </section>

      <section class="surface settings-section"><div class="settings-heading"><div><span class="label">Layout</span><h2>Navigation and technical detail</h2></div><p>These values become the default after Atlas restarts. Dragging a separator still overrides them for the current session.</p></div>
        <div class="setting-field-grid"><label class="setting-field"><span>Project navigation width</span><input type="number" name="project_rail_width" min="220" max="420" step="10" value="${preferences.project_rail_width}"><small>220–420 px</small></label>
        <label class="setting-field"><span>Task navigation width</span><input type="number" name="app_rail_width" min="180" max="360" step="10" value="${preferences.app_rail_width}"><small>180–360 px</small></label></div>
        <label class="setting-toggle"><input type="checkbox" name="show_technical_ids" value="yes"${preferences.show_technical_ids ? ' checked' : ''}><span><strong>Show non-essential Project and Task IDs</strong><small>Diff hashes and recovery identifiers remain visible when needed for a decision.</small></span></label>
      </section>
    </div>

    <aside class="settings-side"><section class="surface settings-preview"><span class="label">Preview</span><h2>Readable working state</h2><p>This paragraph uses the selected text scale and secondary-text contrast.</p><div class="preview-statuses">${renderStatus('ready')}${renderStatus('awaiting_review')}${renderStatus('blocked')}</div><div class="preview-row"><strong>Example Task</strong><small>Source checked · one decision waiting</small></div></section>
      <section class="surface settings-boundary"><h2>What Settings does not change</h2><ul><li>Project routing and naming rules</li><li>Approval or recovery policy</li><li>Runtime installation</li><li>Ledger facts and history</li></ul></section>
      <div class="settings-actions"><button class="action-button" type="submit" name="action" value="save">Save settings</button><button class="action-button action-button-secondary" type="submit" name="action" value="reset">Restore defaults</button></div>
    </aside>
  </form></main></div></div></body></html>`;
}
