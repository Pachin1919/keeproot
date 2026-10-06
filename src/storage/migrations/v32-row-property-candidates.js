export const ROW_PROPERTY_CANDIDATES_SCHEMA_VERSION = 32;

export function applyRowPropertyCandidatesMigration(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS row_property_candidate_batches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      property_id TEXT NOT NULL REFERENCES resource_property_definitions(id),
      prompt_version TEXT NOT NULL,
      request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('preview','batch')),
      preview_batch_id TEXT REFERENCES row_property_candidate_batches(id),
      host_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id,request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_row_candidate_batches_project ON row_property_candidate_batches(project_id,created_at DESC,id);
    CREATE TABLE IF NOT EXISTS row_property_candidates (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES row_property_candidate_batches(id),
      resource_id TEXT NOT NULL REFERENCES resources(id),
      sheet_name TEXT NOT NULL,
      locator_json TEXT NOT NULL,
      row_sha256 TEXT NOT NULL,
      value_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','needs_review','accepted','rejected')),
      revision INTEGER NOT NULL DEFAULT 1,
      decision_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_row_candidates_batch ON row_property_candidates(batch_id,status,created_at,id);
    CREATE TABLE IF NOT EXISTS accepted_row_property_values (
      project_id TEXT NOT NULL REFERENCES projects(id),
      property_id TEXT NOT NULL REFERENCES resource_property_definitions(id),
      resource_id TEXT NOT NULL REFERENCES resources(id),
      sheet_name TEXT NOT NULL,
      locator_json TEXT NOT NULL,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source_candidate_id TEXT NOT NULL REFERENCES row_property_candidates(id),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id,property_id,resource_id,sheet_name,locator_json)
    );
  `);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
    .run(ROW_PROPERTY_CANDIDATES_SCHEMA_VERSION, 'row_property_candidates', appliedAt);
}
