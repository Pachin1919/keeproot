// Display identity only. CLI, protocol, schema, Skill and stored IDs retain Atlas names.
export const UI_DISPLAY_NAME = 'Keeproot';
// Two joined pages rest on a common root. Authored for the local product chrome.
export const UI_BRAND_MARK = '<svg class="product-mark" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Keeproot"><path d="M5 21V6h9l4 4v11M14 6v4h4"/><path d="M12 21V12h9l4 4v5M21 12v4h4"/><path d="M3 24h24M9 21v3m12-3v3"/></svg>';

// Call only for owned default UI copy, before inserting user values or language packs.
export function brandDefaultUiCopy(value) {
  return value.replace(/\bAtlas\b/gu, UI_DISPLAY_NAME);
}
