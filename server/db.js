// SQLite holds metadata only; release HTML and uploaded files live on disk (see ./store.js).
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS releases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       TEXT NOT NULL REFERENCES games(id),
  number        INTEGER NOT NULL,
  release_hash  TEXT,
  game_version  TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  size          INTEGER NOT NULL,
  field_count   INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (game_id, number),
  UNIQUE (game_id, release_hash)
);
CREATE TABLE IF NOT EXISTS variants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     TEXT NOT NULL REFERENCES games(id),
  name        TEXT NOT NULL,
  overrides   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

const variantRow = (row) =>
  row && {
    id: row.id,
    gameId: row.game_id,
    name: row.name,
    overrides: JSON.parse(row.overrides),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

const releaseRow = (row) =>
  row && {
    id: row.id,
    gameId: row.game_id,
    number: row.number,
    releaseHash: row.release_hash,
    gameVersion: row.game_version,
    notes: row.notes,
    size: row.size,
    fieldCount: row.field_count,
    createdAt: row.created_at
  };

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const tx = (fn) => {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  return {
    close: () => db.close(),

    listGames() {
      return db
        .prepare(
          `SELECT g.id, g.title, g.created_at,
             (SELECT COUNT(*) FROM variants v WHERE v.game_id = g.id) AS variant_count,
             (SELECT MAX(id) FROM releases r WHERE r.game_id = g.id) AS latest_release_id
           FROM games g ORDER BY g.title COLLATE NOCASE`
        )
        .all()
        .map((row) => ({
          id: row.id,
          title: row.title,
          createdAt: row.created_at,
          variantCount: row.variant_count,
          latestRelease: releaseRow(db.prepare("SELECT * FROM releases WHERE id = ?").get(row.latest_release_id))
        }));
    },

    getGame(id) {
      const row = db.prepare("SELECT * FROM games WHERE id = ?").get(id);
      return row && { id: row.id, title: row.title, createdAt: row.created_at };
    },

    /** Adds a release unless the same build (release hash) was already uploaded. */
    addRelease({ game, releaseHash, gameVersion, notes, size, fieldCount }, writeHtml) {
      return tx(() => {
        const existing = db.prepare("SELECT * FROM games WHERE id = ?").get(game.id);
        if (!existing) {
          db.prepare("INSERT INTO games (id, title, created_at) VALUES (?, ?, ?)").run(game.id, game.title, now());
          // Every game starts with a variant that holds the release defaults.
          db.prepare(
            "INSERT INTO variants (game_id, name, overrides, created_at, updated_at) VALUES (?, 'Default', '{}', ?, ?)"
          ).run(game.id, now(), now());
        } else if (existing.title !== game.title) {
          db.prepare("UPDATE games SET title = ? WHERE id = ?").run(game.title, game.id);
        }
        if (releaseHash) {
          const dup = db
            .prepare("SELECT * FROM releases WHERE game_id = ? AND release_hash = ?")
            .get(game.id, releaseHash);
          if (dup) return { release: releaseRow(dup), created: false };
        }
        const { n } = db
          .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM releases WHERE game_id = ?")
          .get(game.id);
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO releases (game_id, number, release_hash, game_version, notes, size, field_count, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(game.id, n, releaseHash ?? null, gameVersion ?? null, notes, size, fieldCount, now());
        const release = releaseRow(db.prepare("SELECT * FROM releases WHERE id = ?").get(lastInsertRowid));
        writeHtml(release.id);
        return { release, created: true };
      });
    },

    listReleases(gameId) {
      return db.prepare("SELECT * FROM releases WHERE game_id = ? ORDER BY number DESC").all(gameId).map(releaseRow);
    },

    getRelease(id) {
      return releaseRow(db.prepare("SELECT * FROM releases WHERE id = ?").get(id));
    },

    listVariants(gameId) {
      return db.prepare("SELECT * FROM variants WHERE game_id = ? ORDER BY id").all(gameId).map(variantRow);
    },

    getVariant(id) {
      return variantRow(db.prepare("SELECT * FROM variants WHERE id = ?").get(id));
    },

    createVariant(gameId, name, overrides = {}) {
      const { lastInsertRowid } = db
        .prepare("INSERT INTO variants (game_id, name, overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(gameId, name, JSON.stringify(overrides), now(), now());
      return this.getVariant(Number(lastInsertRowid));
    },

    updateVariant(id, { name, overrides }) {
      const current = this.getVariant(id);
      if (!current) return null;
      db.prepare("UPDATE variants SET name = ?, overrides = ?, updated_at = ? WHERE id = ?").run(
        name ?? current.name,
        JSON.stringify(overrides ?? current.overrides),
        now(),
        id
      );
      return this.getVariant(id);
    },

    deleteVariant(id) {
      return db.prepare("DELETE FROM variants WHERE id = ?").run(id).changes > 0;
    },

    addAsset({ id, sha256, mime, size, name }) {
      db.prepare(
        "INSERT OR IGNORE INTO assets (id, sha256, mime, size, name, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, sha256, mime, size, name, now());
      return this.getAsset(id);
    },

    getAsset(id) {
      const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
      return row && { id: row.id, sha256: row.sha256, mime: row.mime, size: row.size, name: row.name };
    }
  };
}
