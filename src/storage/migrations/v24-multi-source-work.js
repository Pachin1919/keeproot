export const MULTI_SOURCE_WORK_SCHEMA_VERSION = 24;

export function applyMultiSourceWorkMigration(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      return_state_json TEXT NOT NULL DEFAULT '{}',
      mapping_json TEXT NOT NULL DEFAULT '[]',
      recipe_json TEXT NOT NULL DEFAULT '{"schema":"atlas.table-recipe.v1","steps":[]}',
      preview_json TEXT,
      preview_revision INTEGER,
      latest_save_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_sessions_project_updated
      ON work_sessions(project_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS work_session_sources (
      session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      resource_id TEXT NOT NULL REFERENCES resources(id),
      sheet TEXT,
      fingerprint_json TEXT,
      profile_json TEXT,
      profile_processor_version TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, source_key),
      UNIQUE(session_id, resource_id, sheet)
    );
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'multi_source_table_work', ?)
  `).run(MULTI_SOURCE_WORK_SCHEMA_VERSION, appliedAt);
}
