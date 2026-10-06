export const RESOURCE_LINK_CANDIDATES_SCHEMA_VERSION = 34;

export function applyResourceLinkCandidatesMigration(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_link_candidates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      source_resource_id TEXT NOT NULL REFERENCES resources(id),
      target_resource_id TEXT NOT NULL REFERENCES resources(id),
      type TEXT NOT NULL CHECK(type='linked_to'),
      request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      binding_digest TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
      revision INTEGER NOT NULL DEFAULT 1,
      decision_json TEXT,
      policy_json TEXT NOT NULL,
      receipt_json TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      UNIQUE(project_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_resource_link_candidates_project_status
      ON resource_link_candidates(project_id, status, created_at DESC, id);
  `);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
    .run(RESOURCE_LINK_CANDIDATES_SCHEMA_VERSION, 'resource_link_candidates', appliedAt);
}
