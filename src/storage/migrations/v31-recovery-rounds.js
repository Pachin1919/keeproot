export const RECOVERY_ROUNDS_SCHEMA_VERSION = 31;

export function applyRecoveryRoundsMigration(db, appliedAt) {
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_rounds (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    revision INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recovery_rounds_project ON recovery_rounds(project_id,updated_at);`);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
    .run(RECOVERY_ROUNDS_SCHEMA_VERSION, 'recovery_rounds', appliedAt);
}
