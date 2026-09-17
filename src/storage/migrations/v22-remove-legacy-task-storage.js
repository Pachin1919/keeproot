export const LEGACY_TASK_REMOVAL_SCHEMA_VERSION = 22;

const TASK_TABLES = [
  'task_fulfillment_claims',
  'task_inputs',
  'task_contracts',
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table));
}

function deleteByTaskRun(db, table, column = 'run_id') {
  if (!tableExists(db, table)) return;
  db.exec(`
    DELETE FROM ${quoteIdentifier(table)}
    WHERE ${quoteIdentifier(column)} IN (SELECT run_id FROM atlas_legacy_task_runs);
  `);
}

function assertNoForeignKeyReferences(db, targetTable, targetColumn, tempIdsTable, tempIdsColumn) {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `).all().map((row) => row.name);
  const remaining = [];
  for (const table of tables) {
    for (const foreignKey of db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all()) {
      if (foreignKey.table !== targetTable || foreignKey.to !== targetColumn) continue;
      const count = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM ${quoteIdentifier(table)}
        WHERE ${quoteIdentifier(foreignKey.from)} IN (
          SELECT ${quoteIdentifier(tempIdsColumn)} FROM ${quoteIdentifier(tempIdsTable)}
        )
      `).get().count);
      if (count > 0) remaining.push(`${table}.${foreignKey.from}=${count}`);
    }
  }
  if (remaining.length > 0) {
    throw new Error(`Legacy Task removal found retained ${targetTable} references: ${remaining.join(', ')}`);
  }
}

export function removeLegacyTaskStorage(db) {
  if (!tableExists(db, 'task_contracts')) {
    return { removed: false, task_count: 0 };
  }

  db.exec('PRAGMA secure_delete = ON;');
  db.exec(`
    DROP TABLE IF EXISTS temp.atlas_legacy_task_runs;
    DROP TABLE IF EXISTS temp.atlas_legacy_task_predictions;
    DROP TABLE IF EXISTS temp.atlas_legacy_task_artifacts;
    DROP TABLE IF EXISTS temp.atlas_legacy_task_materials;

    CREATE TEMP TABLE atlas_legacy_task_runs AS
    SELECT run_id, underlying_run_id
    FROM task_contracts;

    CREATE TEMP TABLE atlas_legacy_task_predictions AS
    SELECT id
    FROM predictions
    WHERE run_id IN (SELECT run_id FROM atlas_legacy_task_runs);

    CREATE TEMP TABLE atlas_legacy_task_artifacts AS
    SELECT id
    FROM artifacts
    WHERE origin_run_id IN (SELECT run_id FROM atlas_legacy_task_runs);

    CREATE TEMP TABLE atlas_legacy_task_materials AS
    SELECT id
    FROM materials
    WHERE artifact_id IN (SELECT id FROM atlas_legacy_task_artifacts);
  `);

  const taskCount = Number(db.prepare('SELECT COUNT(*) AS count FROM atlas_legacy_task_runs').get().count);

  if (tableExists(db, 'derived_inputs')) {
    db.exec(`
      UPDATE artifacts
      SET origin_run_id = COALESCE(
        (
          SELECT underlying_run_id
          FROM atlas_legacy_task_runs
          WHERE run_id = artifacts.origin_run_id
            AND underlying_run_id IS NOT NULL
            AND underlying_run_id NOT IN (SELECT run_id FROM atlas_legacy_task_runs)
        ),
        (
          SELECT MIN(run_id)
          FROM derived_inputs
          WHERE artifact_id = artifacts.id
            AND run_id NOT IN (SELECT run_id FROM atlas_legacy_task_runs)
        )
      )
      WHERE id IN (SELECT id FROM atlas_legacy_task_artifacts)
        AND COALESCE(
          (
            SELECT underlying_run_id
            FROM atlas_legacy_task_runs
            WHERE run_id = artifacts.origin_run_id
              AND underlying_run_id IS NOT NULL
              AND underlying_run_id NOT IN (SELECT run_id FROM atlas_legacy_task_runs)
          ),
          (
            SELECT MIN(run_id)
            FROM derived_inputs
            WHERE artifact_id = artifacts.id
              AND run_id NOT IN (SELECT run_id FROM atlas_legacy_task_runs)
          )
        ) IS NOT NULL;
    `);
  } else {
    db.exec(`
      UPDATE artifacts
      SET origin_run_id = (
        SELECT underlying_run_id
        FROM atlas_legacy_task_runs
        WHERE run_id = artifacts.origin_run_id
          AND underlying_run_id IS NOT NULL
          AND underlying_run_id NOT IN (SELECT run_id FROM atlas_legacy_task_runs)
      )
      WHERE id IN (SELECT id FROM atlas_legacy_task_artifacts)
        AND EXISTS (
          SELECT 1
          FROM atlas_legacy_task_runs
          WHERE run_id = artifacts.origin_run_id
            AND underlying_run_id IS NOT NULL
            AND underlying_run_id NOT IN (SELECT run_id FROM atlas_legacy_task_runs)
        );
    `);
  }

  if (tableExists(db, 'labels')) {
    db.exec(`
      DELETE FROM labels
      WHERE run_id IN (SELECT run_id FROM atlas_legacy_task_runs)
         OR subject_prediction_id IN (SELECT id FROM atlas_legacy_task_predictions);
    `);
  }
  deleteByTaskRun(db, 'observations');
  deleteByTaskRun(db, 'operation_events');
  deleteByTaskRun(db, 'policy_decisions');
  deleteByTaskRun(db, 'run_scopes');
  deleteByTaskRun(db, 'run_file_states');
  deleteByTaskRun(db, 'rollback_progress');

  assertNoForeignKeyReferences(
    db,
    'predictions',
    'id',
    'atlas_legacy_task_predictions',
    'id',
  );
  db.exec('DELETE FROM predictions WHERE id IN (SELECT id FROM atlas_legacy_task_predictions);');

  for (const table of TASK_TABLES) {
    if (tableExists(db, table)) db.exec(`DROP TABLE ${quoteIdentifier(table)};`);
  }

  db.exec(`
    DELETE FROM materials
    WHERE id IN (SELECT id FROM atlas_legacy_task_materials)
      AND artifact_id IN (
        SELECT id FROM artifacts
        WHERE origin_run_id IN (SELECT run_id FROM atlas_legacy_task_runs)
      );

    DELETE FROM artifacts
    WHERE id IN (SELECT id FROM atlas_legacy_task_artifacts)
      AND origin_run_id IN (SELECT run_id FROM atlas_legacy_task_runs);
  `);

  assertNoForeignKeyReferences(db, 'runs', 'id', 'atlas_legacy_task_runs', 'run_id');
  db.exec('DELETE FROM runs WHERE id IN (SELECT run_id FROM atlas_legacy_task_runs);');
  db.exec(`
    DROP TABLE temp.atlas_legacy_task_materials;
    DROP TABLE temp.atlas_legacy_task_artifacts;
    DROP TABLE temp.atlas_legacy_task_predictions;
    DROP TABLE temp.atlas_legacy_task_runs;
  `);

  return { removed: taskCount > 0, task_count: taskCount };
}

export function applyLegacyTaskRemovalMigration(db, appliedAt) {
  const result = removeLegacyTaskStorage(db);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, 'remove_legacy_task_storage', ?)
  `).run(LEGACY_TASK_REMOVAL_SCHEMA_VERSION, appliedAt);
  return result;
}
