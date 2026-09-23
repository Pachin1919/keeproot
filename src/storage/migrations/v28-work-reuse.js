export const WORK_REUSE_SCHEMA_VERSION = 28;

export function applyWorkReuseMigration(db, appliedAt) {
  const columns = db.prepare('PRAGMA table_info(work_sessions)').all();
  if (!columns.some((item) => item.name === 'reused_from_session_id')) {
    db.exec('ALTER TABLE work_sessions ADD COLUMN reused_from_session_id TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_sessions_reused_from
      ON work_sessions(reused_from_session_id);
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'work_reuse_origin', ?)
  `).run(WORK_REUSE_SCHEMA_VERSION, appliedAt);
}
