export const LEGACY_CONTEXT_SELECTION_REMOVAL_SCHEMA_VERSION = 23;

const LEGACY_CONTEXT_SELECTION_TABLES = [
  'source_set_items',
  'source_sets',
  'context_candidate_items',
  'context_candidate_sets',
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table));
}

export function removeLegacyContextSelectionStorage(db) {
  const existing = LEGACY_CONTEXT_SELECTION_TABLES.filter((table) => tableExists(db, table));
  if (existing.length === 0) return { removed: false, tables: [] };

  db.exec('PRAGMA secure_delete = ON;');
  for (const table of existing) db.exec(`DROP TABLE ${quoteIdentifier(table)};`);
  return { removed: true, tables: existing };
}

export function applyLegacyContextSelectionRemovalMigration(db, appliedAt) {
  const result = removeLegacyContextSelectionStorage(db);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'retire_legacy_context_selection_storage', ?)
  `).run(LEGACY_CONTEXT_SELECTION_REMOVAL_SCHEMA_VERSION, appliedAt);
  return result;
}
