export const RESOURCE_PROPERTY_CANDIDATES_SCHEMA_VERSION = 26;

export function applyResourcePropertyCandidatesMigration(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_property_candidate_batches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      view_id TEXT REFERENCES saved_resource_views(id),
      scope_json TEXT NOT NULL,
      property_id TEXT NOT NULL REFERENCES resource_property_definitions(id),
      host_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_resource_property_candidate_batches_project
      ON resource_property_candidate_batches(project_id, created_at DESC, id);

    CREATE TABLE IF NOT EXISTS resource_property_candidates (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES resource_property_candidate_batches(id),
      resource_id TEXT NOT NULL REFERENCES resources(id),
      value_json TEXT NOT NULL,
      source_version TEXT NOT NULL,
      property_revision INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
      revision INTEGER NOT NULL DEFAULT 1,
      decision_json TEXT,
      property_batch_id TEXT REFERENCES resource_property_batches(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      UNIQUE(batch_id, resource_id)
    );
    CREATE INDEX IF NOT EXISTS idx_resource_property_candidates_batch
      ON resource_property_candidates(batch_id, status, created_at, id);
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'resource_property_candidates', ?)
  `).run(RESOURCE_PROPERTY_CANDIDATES_SCHEMA_VERSION, appliedAt);
}
