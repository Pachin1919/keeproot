import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UI_PREFERENCE_DEFAULTS = Object.freeze({
  theme: 'slate',
  accent: 'green',
  contrast: 'high',
  text_size: 'comfortable',
  density: 'comfortable',
  project_rail_width: 282,
  app_rail_width: 228,
  context_card_delay: 'normal',
  reduce_motion: false,
  show_technical_ids: false,
});

const ALLOWED = Object.freeze({
  theme: new Set(['slate', 'graphite', 'warm_charcoal']),
  accent: new Set(['green', 'vermilion', 'amber']),
  contrast: new Set(['standard', 'high']),
  text_size: new Set(['compact', 'comfortable', 'large']),
  density: new Set(['compact', 'comfortable']),
  context_card_delay: new Set(['fast', 'normal', 'deliberate']),
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeUiPreferences(input = {}) {
  const defaults = UI_PREFERENCE_DEFAULTS;
  const accent = input.accent === 'blue' ? 'vermilion' : input.accent;
  return {
    theme: ALLOWED.theme.has(input.theme) ? input.theme : defaults.theme,
    accent: ALLOWED.accent.has(accent) ? accent : defaults.accent,
    contrast: ALLOWED.contrast.has(input.contrast) ? input.contrast : defaults.contrast,
    text_size: ALLOWED.text_size.has(input.text_size) ? input.text_size : defaults.text_size,
    density: ALLOWED.density.has(input.density) ? input.density : defaults.density,
    project_rail_width: boundedInteger(input.project_rail_width, defaults.project_rail_width, 220, 420),
    app_rail_width: boundedInteger(input.app_rail_width, defaults.app_rail_width, 68, 360),
    context_card_delay: ALLOWED.context_card_delay.has(input.context_card_delay) ? input.context_card_delay : defaults.context_card_delay,
    reduce_motion: input.reduce_motion === true || input.reduce_motion === 'yes',
    show_technical_ids: input.show_technical_ids === true || input.show_technical_ids === 'yes',
  };
}

export function uiPreferencesPath(stateDir) {
  return path.join(path.resolve(stateDir), 'ui', 'preferences.json');
}

export function readUiPreferences(stateDir) {
  const filePath = uiPreferencesPath(stateDir);
  if (!fs.existsSync(filePath)) return { ...UI_PREFERENCE_DEFAULTS };
  try {
    return normalizeUiPreferences(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return { ...UI_PREFERENCE_DEFAULTS };
  }
}

export function writeUiPreferences(stateDir, input) {
  const filePath = uiPreferencesPath(stateDir);
  const directory = path.dirname(filePath);
  const preferences = normalizeUiPreferences(input);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.preferences-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify({ schema: 'atlas-ui-preferences.v1', ...preferences }, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  fs.renameSync(temporary, filePath);
  return preferences;
}

export function resetUiPreferences(stateDir) {
  return writeUiPreferences(stateDir, UI_PREFERENCE_DEFAULTS);
}

export function preferenceHtmlAttributes(preferences) {
  const value = normalizeUiPreferences(preferences);
  const contextDelay = { fast: 250, normal: 650, deliberate: 1200 }[value.context_card_delay];
  return [
    `data-theme="${value.theme}"`,
    `data-accent="${value.accent}"`,
    `data-contrast="${value.contrast}"`,
    `data-text-size="${value.text_size}"`,
    `data-density="${value.density}"`,
    `data-context-delay="${contextDelay}"`,
    `data-reduce-motion="${value.reduce_motion ? 'true' : 'false'}"`,
    `data-technical-ids="${value.show_technical_ids ? 'shown' : 'hidden'}"`,
  ].join(' ');
}

export function preferenceRailStyle(preferences) {
  const value = normalizeUiPreferences(preferences);
  return `--project-rail-width:${value.project_rail_width}px;--app-rail-width:${value.app_rail_width}px`;
}
