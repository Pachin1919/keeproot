import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../src/ledger.js';

test('round recovery migration preserves v30 Boards and a pre-migration backup', (t) => {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('test/.tmp/round-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initial = new Ledger(root);
  initial.db.exec("INSERT INTO projects(id,name,status,created_at) VALUES('P','P','active','2026-09-22')");
  const board = initial.boards.create({ projectId: 'P', title: 'Keep me', at: '2026-09-22' });
  initial.db.exec('DROP TABLE IF EXISTS recovery_rounds; DELETE FROM schema_migrations WHERE version>30; PRAGMA user_version=30');
  initial.db.close();
  const migrated = new Ledger(root);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 31);
    assert.equal(migrated.boards.byId(board.board_id).title, 'Keep me');
    assert.deepEqual(migrated.db.prepare('SELECT * FROM recovery_rounds').all(), []);
    const backup = new DatabaseSync(path.join(root, 'backups/ledger-pre-migration-v30-to-v31.sqlite'), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 30);
      assert.equal(backup.prepare('SELECT title FROM project_boards WHERE id=?').get(board.board_id).title, 'Keep me');
    } finally { backup.close(); }
  } finally { migrated.db.close(); }
});
