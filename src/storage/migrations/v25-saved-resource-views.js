export const SAVED_RESOURCE_VIEWS_SCHEMA_VERSION = 25;

export function applySavedResourceViewsMigration(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_resource_views (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('files','table','cards')),
      config_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      last_evaluated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_resource_views_project
      ON saved_resource_views(project_id, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS resource_property_definitions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('text','single','multi')),
      options_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_resource_property_definitions_project
      ON resource_property_definitions(project_id, created_at, id);

    CREATE TABLE IF NOT EXISTS resource_property_values (
      property_id TEXT NOT NULL REFERENCES resource_property_definitions(id),
      resource_id TEXT NOT NULL REFERENCES resources(id),
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(property_id, resource_id)
    );
    CREATE INDEX IF NOT EXISTS idx_resource_property_values_resource
      ON resource_property_values(resource_id, property_id);

    CREATE TABLE IF NOT EXISTS resource_property_batches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      status TEXT NOT NULL CHECK(status IN ('applied','undone')),
      created_at TEXT NOT NULL,
      undone_at TEXT
    );
    CREATE TABLE IF NOT EXISTS resource_property_batch_items (
      batch_id TEXT NOT NULL REFERENCES resource_property_batches(id),
      ordinal INTEGER NOT NULL,
      property_id TEXT NOT NULL REFERENCES resource_property_definitions(id),
      resource_id TEXT NOT NULL REFERENCES resources(id),
      operation TEXT NOT NULL,
      before_value_json TEXT,
      before_revision INTEGER NOT NULL,
      after_value_json TEXT NOT NULL,
      after_revision INTEGER NOT NULL,
      PRIMARY KEY(batch_id, ordinal),
      UNIQUE(batch_id, property_id, resource_id)
    );
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'saved_resource_views', ?)
  `).run(SAVED_RESOURCE_VIEWS_SCHEMA_VERSION, appliedAt);
}
