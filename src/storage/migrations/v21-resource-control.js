export const RESOURCE_CONTROL_SCHEMA_VERSION = 21;

export function applyResourceControlMigration(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      display_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resource_locations (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id), project_id TEXT REFERENCES projects(id),
      path TEXT NOT NULL, display_name TEXT NOT NULL, content_hash TEXT, bytes INTEGER, modified_at TEXT,
      status TEXT NOT NULL, evidence_json TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_locations_active_path ON resource_locations(path COLLATE NOCASE) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS resource_save_links (
      save_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id), artifact_id TEXT UNIQUE REFERENCES artifacts(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resource_relationships (
      id TEXT PRIMARY KEY, source_resource_id TEXT NOT NULL REFERENCES resources(id), target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
      type TEXT NOT NULL, submitter_json TEXT NOT NULL, evidence_json TEXT NOT NULL, effective_at TEXT NOT NULL, status TEXT NOT NULL,
      UNIQUE(source_resource_id, target_kind, target_id, type, status)
    );
    CREATE TABLE IF NOT EXISTS resource_actions (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id), action_type TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?, 'resource_control', ?)`).run(RESOURCE_CONTROL_SCHEMA_VERSION, appliedAt);
}
