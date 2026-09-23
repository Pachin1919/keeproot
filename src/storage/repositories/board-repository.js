import crypto from 'node:crypto';

const parse = (value, fallback) => value == null ? fallback : JSON.parse(value);

function board(row) {
  return row && {
    board_id: row.id,
    project_id: row.project_id,
    title: row.title,
    blocks: parse(row.blocks_json, []),
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function conflict(current) {
  const error = new Error('Board changed after it was opened.');
  error.code = 'ATLAS_STATE_CONFLICT';
  error.details = current ? { board_id: current.board_id, current_revision: current.revision } : {};
  return error;
}

export class BoardRepository {
  constructor({ db, transaction }) {
    this.db = db;
    this.transaction = transaction;
  }

  create({ projectId, title, at }) {
    const id = `BRD-${crypto.randomUUID()}`;
    this.db.prepare(`INSERT INTO project_boards(id,project_id,title,blocks_json,revision,created_at,updated_at)
      VALUES(?,?,?,'[]',1,?,?)`).run(id, projectId, title, at, at);
    return this.byId(id);
  }

  byId(boardId) {
    return board(this.db.prepare('SELECT * FROM project_boards WHERE id=?').get(boardId));
  }

  list(projectId) {
    return this.db.prepare('SELECT * FROM project_boards WHERE project_id=? ORDER BY updated_at DESC,id')
      .all(projectId).map(board);
  }

  save({ projectId, boardId, title, blocks, baseRevision, at }) {
    return this.transaction(() => {
      const pending = this.db.prepare(`SELECT r.id FROM recovery_rounds r, json_each(r.state_json,'$.board_ids') b
        WHERE r.project_id=? AND json_extract(r.state_json,'$.pending_restore') IS NOT NULL AND b.value=? LIMIT 1`)
        .get(projectId, boardId);
      if (pending) {
        const error = new Error('Board recovery is incomplete. Resume recovery before editing.');
        error.code = 'ATLAS_RECOVERY_INCOMPLETE';
        error.details = { round_id: pending.id, board_id: boardId };
        throw error;
      }
      const current = this.byId(boardId);
      if (!current || current.project_id !== projectId) throw new Error('Board is unavailable in this Project.');
      if (!Number.isInteger(Number(baseRevision)) || Number(baseRevision) !== current.revision) throw conflict(current);
      const changed = this.db.prepare(`UPDATE project_boards
        SET title=?,blocks_json=?,revision=revision+1,updated_at=?
        WHERE id=? AND project_id=? AND revision=?`)
        .run(title, JSON.stringify(blocks), at, boardId, projectId, current.revision);
      if (changed.changes !== 1) throw conflict(this.byId(boardId));
      return this.byId(boardId);
    });
  }
}
