export const HANDOFFS_SCHEMA_VERSION = 33;

export function applyHandoffsMigration(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      work_id TEXT NOT NULL REFERENCES work_sessions(id),
      schema_version INTEGER NOT NULL,
      digest TEXT NOT NULL,
      request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      package_json TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_project_created ON handoffs(project_id, created_at DESC, id);
  `);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
    .run(HANDOFFS_SCHEMA_VERSION, 'versioned_host_handoffs', appliedAt);
}
