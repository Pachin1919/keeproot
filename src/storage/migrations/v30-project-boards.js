export const PROJECT_BOARDS_SCHEMA_VERSION = 30;

export function applyProjectBoardsMigration(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_boards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      blocks_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_boards_project
      ON project_boards(project_id, updated_at DESC, id);
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'project_boards', ?)
  `).run(PROJECT_BOARDS_SCHEMA_VERSION, appliedAt);
}
