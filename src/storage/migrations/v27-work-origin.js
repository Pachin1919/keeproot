export const WORK_ORIGIN_SCHEMA_VERSION = 27;

export function applyWorkOriginMigration(db, appliedAt) {
  const columns = db.prepare('PRAGMA table_info(work_sessions)').all();
  if (!columns.some((item) => item.name === 'intent')) db.exec('ALTER TABLE work_sessions ADD COLUMN intent TEXT');
  if (!columns.some((item) => item.name === 'caller_json')) db.exec('ALTER TABLE work_sessions ADD COLUMN caller_json TEXT');
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES (?, 'work_origin', ?)")
    .run(WORK_ORIGIN_SCHEMA_VERSION, appliedAt);
}
