// Display identity only. CLI, protocol, schema, Skill and stored IDs retain Atlas names.
export const UI_DISPLAY_NAME = 'Keeproot';
// A K monogram: a retained spine and two branching folds. Authored for product chrome.
export const UI_BRAND_MARK = '<svg class="product-mark" viewBox="0 0 30 30" fill="currentColor" role="img" aria-label="Keeproot"><path d="M6 5h5v20H6zM12.5 14.6 21.4 5H27L17.4 15 27 25h-5.6l-8.9-9.6z"/><path d="M4 5h2v5H4zM4 20h2v5H4z" opacity=".5"/></svg>';

// Call only for owned default UI copy, before inserting user values or language packs.
export function brandDefaultUiCopy(value) {
  return value.replace(/\bAtlas\b/gu, UI_DISPLAY_NAME);
}
