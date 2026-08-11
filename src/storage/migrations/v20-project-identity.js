export const PROJECT_IDENTITY_SCHEMA_VERSION = 20;

export function applyProjectIdentityMigration(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_identity_signatures (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      signature_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      stable_signals_json TEXT NOT NULL,
      status TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      reason TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_identity_one_active
      ON project_identity_signatures(project_id)
      WHERE status = 'active';
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'project_identity_signatures', ?)
  `).run(PROJECT_IDENTITY_SCHEMA_VERSION, appliedAt);
}
