export const WORK_SOURCE_RECONCILIATION_SCHEMA_VERSION = 29;

export function applyWorkSourceReconciliationMigration(db, appliedAt) {
  const columns = db.prepare('PRAGMA table_info(work_session_sources)').all();
  if (!columns.some((item) => item.name === 'version_policy')) {
    db.exec("ALTER TABLE work_session_sources ADD COLUMN version_policy TEXT NOT NULL DEFAULT 'follow_latest'");
  }
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'work_source_reconciliation', ?)
  `).run(WORK_SOURCE_RECONCILIATION_SCHEMA_VERSION, appliedAt);
}
