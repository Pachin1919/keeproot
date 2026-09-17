export const PROJECT_CONTEXT_SCHEMA_VERSION = 19;

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

export function applyProjectContextMigration(db, appliedAt) {
  ensureColumn(db, 'portfolio_roots', 'governance_status', "TEXT NOT NULL DEFAULT 'observed'");
  ensureColumn(db, 'portfolio_roots', 'root_type', 'TEXT');
  ensureColumn(db, 'portfolio_roots', 'content_policy', "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(db, 'portfolio_roots', 'adopted_at', 'TEXT');
  ensureColumn(db, 'derived_inputs', 'source_root_id', 'TEXT');
  ensureColumn(db, 'derived_inputs', 'source_project_id', 'TEXT');
  ensureColumn(db, 'derived_inputs', 'source_root_path', 'TEXT');
  ensureColumn(db, 'derived_inputs', 'source_relative_path', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_locations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      root_id TEXT NOT NULL REFERENCES portfolio_roots(id),
      relative_path TEXT NOT NULL,
      status TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      reason TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_locations_one_active_project
      ON project_locations(project_id)
      WHERE status = 'active';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_locations_one_active_path
      ON project_locations(root_id, relative_path COLLATE NOCASE)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS project_context_links (
      id TEXT PRIMARY KEY,
      target_project_id TEXT NOT NULL REFERENCES projects(id),
      source_project_id TEXT NOT NULL REFERENCES projects(id),
      purpose TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      filters_hash TEXT NOT NULL,
      rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
      status TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      supersedes_link_id TEXT REFERENCES project_context_links(id),
      reason TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_context_links_one_active
      ON project_context_links(target_project_id, source_project_id, purpose)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_project_context_links_target_status
      ON project_context_links(target_project_id, status, valid_from);

    CREATE TABLE IF NOT EXISTS catalog_generations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      root_id TEXT NOT NULL REFERENCES portfolio_roots(id),
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      actor TEXT NOT NULL,
      agent TEXT,
      model TEXT,
      tool TEXT NOT NULL,
      client_run_id TEXT,
      fingerprint TEXT,
      summary_json TEXT
    );

    CREATE TABLE IF NOT EXISTS catalog_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      root_id TEXT NOT NULL REFERENCES portfolio_roots(id),
      relative_path TEXT NOT NULL,
      project_relative_path TEXT NOT NULL,
      extension TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      modified_ms REAL NOT NULL,
      modified_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parser_name TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      title TEXT,
      headings_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      indexed_bytes INTEGER NOT NULL,
      truncated INTEGER NOT NULL,
      status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_seen_generation_id TEXT NOT NULL REFERENCES catalog_generations(id),
      changed_at TEXT NOT NULL,
      UNIQUE(root_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_entries_project_status
      ON catalog_entries(project_id, status, modified_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
      entry_id UNINDEXED,
      title,
      headings,
      tags,
      body,
      tokenize=trigram
    );

    CREATE TABLE IF NOT EXISTS context_candidate_sets (
      id TEXT PRIMARY KEY,
      target_project_id TEXT NOT NULL REFERENCES projects(id),
      purpose TEXT NOT NULL,
      terms_json TEXT NOT NULL,
      context_link_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS context_candidate_items (
      candidate_set_id TEXT NOT NULL REFERENCES context_candidate_sets(id),
      ordinal INTEGER NOT NULL,
      catalog_entry_id TEXT NOT NULL REFERENCES catalog_entries(id),
      context_link_id TEXT NOT NULL REFERENCES project_context_links(id),
      source_project_id TEXT NOT NULL REFERENCES projects(id),
      source_root_id TEXT NOT NULL REFERENCES portfolio_roots(id),
      content_hash TEXT NOT NULL,
      score REAL,
      snippet TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY(candidate_set_id, catalog_entry_id)
    );

    CREATE TABLE IF NOT EXISTS source_sets (
      id TEXT PRIMARY KEY,
      candidate_set_id TEXT NOT NULL REFERENCES context_candidate_sets(id),
      target_project_id TEXT NOT NULL REFERENCES projects(id),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_set_items (
      source_set_id TEXT NOT NULL REFERENCES source_sets(id),
      ordinal INTEGER NOT NULL,
      catalog_entry_id TEXT NOT NULL REFERENCES catalog_entries(id),
      source_project_id TEXT NOT NULL REFERENCES projects(id),
      source_root_id TEXT NOT NULL REFERENCES portfolio_roots(id),
      source_root_path TEXT NOT NULL,
      source_relative_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY(source_set_id, catalog_entry_id)
    );
  `);

  ensureColumn(
    db,
    'context_candidate_items',
    'snapshot_json',
    "TEXT NOT NULL DEFAULT '{}'",
  );
  ensureColumn(
    db,
    'source_set_items',
    'snapshot_json',
    "TEXT NOT NULL DEFAULT '{}'",
  );

  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'workspace_roots_project_locations_and_context_links', ?)
  `).run(PROJECT_CONTEXT_SCHEMA_VERSION, appliedAt);
}
