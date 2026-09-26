// SQLite holds metadata only; release HTML and uploaded files live on disk (see ./store.js).
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL,
  definition TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_runs (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  provenance TEXT NOT NULL, variant_ids TEXT NOT NULL
);
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
CREATE TABLE IF NOT EXISTS variant_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id  INTEGER NOT NULL,
  revision    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  overrides   TEXT NOT NULL,
  changed     TEXT NOT NULL DEFAULT '[]',
  kind        TEXT NOT NULL DEFAULT 'edit',
  user        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS variant_revisions_variant ON variant_revisions (variant_id, revision);
CREATE TABLE IF NOT EXISTS exports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id         TEXT NOT NULL,
  variant_id      INTEGER,
  variant_name    TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  release_id      INTEGER NOT NULL,
  release_number  INTEGER NOT NULL,
  networks        TEXT NOT NULL,
  langs           TEXT NOT NULL,
  overrides       TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  size            INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  warnings        TEXT NOT NULL DEFAULT '[]',
  job_id          TEXT,
  user            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exports_game ON exports (game_id, id);
CREATE TABLE IF NOT EXISTS game_assets (
  game_id     TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (game_id, asset_id)
);
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
`;

// Columns added after the first version; openDb() adds the missing ones to an existing database.
const MIGRATIONS = [
  ["variants", "revision", "INTEGER NOT NULL DEFAULT 1"],
  // path → revision that last changed it; "$name", "$tags", "$status", "$pin" for the variant's own props
  ["variants", "field_revs", "TEXT NOT NULL DEFAULT '{}'"],
  ["variants", "tags", "TEXT NOT NULL DEFAULT '[]'"],
  ["variants", "status", "TEXT NOT NULL DEFAULT 'draft'"],
  ["variants", "created_by", "TEXT"],
  ["variants", "updated_by", "TEXT"],
  // The release the variant was last edited or checked with, and an optional pin.
  ["variants", "base_release_id", "INTEGER"],
  ["variants", "pinned_release_id", "INTEGER"],
  ["variants", "playtest", "TEXT"],
  ["variants", "approval", "TEXT"],
  ["variants", "deleted_at", "TEXT"],
  ["variants", "recipe_origin", "TEXT"],
  ["variants", "thumb_at", "TEXT"]
];

export const VARIANT_STATUSES = ["draft", "review", "approved", "live"];

// A user's autosaves within this window are one history entry.
const HISTORY_MERGE_MS = 10 * 60 * 1000;
const HISTORY_KEEP = 200;

const now = () => new Date().toISOString();

const userRow = (row) => row && { id: row.id, username: row.username, createdAt: row.created_at };

const variantRow = (row) =>
  row && {
    id: row.id,
    gameId: row.game_id,
    name: row.name,
    deletedAt: row.deleted_at ?? null,
    recipeOrigin: row.recipe_origin ? JSON.parse(row.recipe_origin) : null,
    overrides: JSON.parse(row.overrides),
    revision: row.revision,
    fieldRevs: JSON.parse(row.field_revs),
    tags: JSON.parse(row.tags),
    status: row.status,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    baseReleaseId: row.base_release_id,
    pinnedReleaseId: row.pinned_release_id,
    approval: row.approval ? JSON.parse(row.approval) : null,
    playtest: row.playtest ? JSON.parse(row.playtest) : null,
    thumbAt: row.thumb_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

const revisionRow = (row) =>
  row && {
    id: row.id,
    variantId: row.variant_id,
    revision: row.revision,
    name: row.name,
    changed: JSON.parse(row.changed),
    kind: row.kind,
    user: row.user,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

const exportRow = (row) =>
  row && {
    id: row.id,
    gameId: row.game_id,
    variantId: row.variant_id,
    variantName: row.variant_name,
    revision: row.revision,
    releaseId: row.release_id,
    releaseNumber: row.release_number,
    networks: JSON.parse(row.networks),
    langs: JSON.parse(row.langs),
    fileName: row.file_name,
    size: row.size,
    sha256: row.sha256,
    warnings: JSON.parse(row.warnings),
    jobId: row.job_id,
    user: row.user,
    createdAt: row.created_at
  };

/** Asset ids ("u/…") an overrides object points at. */
export const uploadIds = (overrides) =>
  Object.values(overrides).filter((v) => typeof v === "string" && v.startsWith("u/"));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Conflict: someone else changed this key after the revision the editor started from. */
export class ConflictError extends Error {
  constructor(conflicts, variant) {
    super(`Changed by someone else meanwhile: ${conflicts.map((c) => c.path).join(", ")}`);
    this.statusCode = 409;
    this.conflicts = conflicts;
    this.variant = variant;
  }
}

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
  for (const [table, column, def] of MIGRATIONS) {
    const has = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }

  // Legacy variants must have an explicit base and cannot retain an unverifiable approval.
  db.exec(
    "UPDATE variants SET base_release_id = (SELECT MAX(id) FROM releases WHERE game_id = variants.game_id) WHERE base_release_id IS NULL"
  );
  db.exec("UPDATE variants SET status = 'draft' WHERE status IN ('approved', 'live') AND approval IS NULL");

  let txDepth = 0;
  const tx = (fn) => {
    db.exec("SAVEPOINT studio_tx_" + ++txDepth);
    try {
      const out = fn();
      db.exec("RELEASE studio_tx_" + txDepth--);
      return out;
    } catch (e) {
      db.exec("ROLLBACK TO studio_tx_" + txDepth);
      db.exec("RELEASE studio_tx_" + txDepth--);
      throw e;
    }
  };

  return {
    close: () => db.close(),
    listRecipes(gameId) {
      return db
        .prepare("SELECT * FROM recipes WHERE game_id = ? ORDER BY id DESC")
        .all(gameId)
        .map((r) => ({ id: r.id, ...JSON.parse(r.definition), createdBy: r.created_by, createdAt: r.created_at }));
    },
    saveRecipe(gameId, definition, user) {
      return tx(() => {
        const result = db
          .prepare("INSERT INTO recipes (game_id, definition, created_by, created_at) VALUES (?, ?, ?, ?)")
          .run(gameId, JSON.stringify(definition), user, now());
        this._linkUploads(
          gameId,
          Object.fromEntries(definition.axes.flatMap((a) => a.values.map((v, i) => [a.path + ":" + i, v])))
        );
        return { id: Number(result.lastInsertRowid), ...definition };
      });
    },
    recipeRun(id) {
      const r = db.prepare("SELECT * FROM recipe_runs WHERE id = ?").get(id);
      return (
        r && {
          gameId: r.game_id,
          fingerprint: r.fingerprint,
          provenance: JSON.parse(r.provenance),
          variantIds: JSON.parse(r.variant_ids)
        }
      );
    },
    generateRecipe(gameId, id, fingerprint, provenance, candidates, user) {
      return tx(() => {
        const variants = candidates.map((c) =>
          this.createVariant(gameId, c.name, c.overrides, {
            user,
            kind: "recipe",
            tags: ["recipe", `run:${id.slice(0, 8)}`],
            baseReleaseId: provenance.releaseId,
            pinnedReleaseId: provenance.releaseId
          })
        );
        for (const v of variants)
          db.prepare("UPDATE variants SET recipe_origin = ? WHERE id = ?").run(
            JSON.stringify({ runId: id, ...provenance }),
            v.id
          );
        db.prepare("INSERT INTO recipe_runs VALUES (?, ?, ?, ?, ?)").run(
          id,
          gameId,
          fingerprint,
          JSON.stringify(provenance),
          JSON.stringify(variants.map((v) => v.id))
        );
        return { variantIds: variants.map((v) => v.id), provenance };
      });
    },

    listGames() {
      return db
        .prepare(
          `SELECT g.id, g.title, g.created_at,
             (SELECT COUNT(*) FROM variants v WHERE v.game_id = g.id AND v.deleted_at IS NULL) AS variant_count,
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
      let pendingDefault = null;
      return tx(() => {
        const existing = db.prepare("SELECT * FROM games WHERE id = ?").get(game.id);
        if (!existing) {
          db.prepare("INSERT INTO games (id, title, created_at) VALUES (?, ?, ?)").run(game.id, game.title, now());
          // Every game starts with a variant that holds the release defaults.
          const { lastInsertRowid } = db
            .prepare(
              "INSERT INTO variants (game_id, name, overrides, created_at, updated_at) VALUES (?, 'Default', '{}', ?, ?)"
            )
            .run(game.id, now(), now());
          pendingDefault = Number(lastInsertRowid);
          this._history(this.getVariant(pendingDefault), [], "create", null);
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
        // The game's first variant starts on its first release.
        if (pendingDefault)
          db.prepare("UPDATE variants SET base_release_id = ? WHERE id = ?").run(release.id, pendingDefault);
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

    listVariants(gameId, includeDeleted = false) {
      return db
        .prepare(
          `SELECT * FROM variants WHERE game_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY id`
        )
        .all(gameId)
        .map(variantRow);
    },

    getVariant(id) {
      return variantRow(db.prepare("SELECT * FROM variants WHERE id = ? AND deleted_at IS NULL").get(id));
    },

    createVariant(
      gameId,
      name,
      overrides = {},
      { user = null, tags = [], status = "draft", kind = "create", baseReleaseId = null, pinnedReleaseId = null } = {}
    ) {
      return tx(() => {
        const at = now();
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO variants (game_id, name, overrides, tags, status, created_by, updated_by, base_release_id,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT MAX(id) FROM releases WHERE game_id = ?), ?, ?)`
          )
          .run(
            gameId,
            name,
            JSON.stringify(overrides),
            JSON.stringify(tags),
            ["draft", "review"].includes(status) ? status : "draft",
            user,
            user,
            gameId,
            at,
            at
          );
        const id = Number(lastInsertRowid);
        if (baseReleaseId)
          db.prepare("UPDATE variants SET base_release_id = ?, pinned_release_id = ? WHERE id = ?").run(
            baseReleaseId,
            pinnedReleaseId,
            id
          );
        this._history(this.getVariant(id), Object.keys(overrides), kind, user);
        this._linkUploads(gameId, overrides);
        return this.getVariant(id);
      });
    },

    /**
     * Applies a change made from `baseRevision`. Only the given keys are written, so two people
     * editing different fields of one variant never overwrite each other; a key someone else
     * changed after baseRevision is a conflict (ConflictError, 409) unless force is set.
     * @param patch { set: {path: value}, unset: [path], name, tags, status, pinnedReleaseId, baseReleaseId }
     */
    patchVariant(id, patch, { baseRevision = null, force = false, user = null, kind = "edit" } = {}) {
      return tx(() => {
        const current = this.getVariant(id);
        if (!current) return null;
        const overrides = { ...current.overrides };
        const fieldRevs = { ...current.fieldRevs };
        const changes = new Map(); // key → [theirs (current), yours]
        for (const [path, value] of Object.entries(patch.set ?? {})) {
          if (!same(overrides[path], value)) changes.set(path, [overrides[path], value]);
        }
        for (const path of patch.unset ?? []) if (path in overrides) changes.set(path, [overrides[path], undefined]);
        const meta = { $name: "name", $tags: "tags", $status: "status", $pin: "pinnedReleaseId" };
        for (const [key, prop] of Object.entries(meta)) {
          if (patch[prop] !== undefined && !same(current[prop], patch[prop]))
            changes.set(key, [current[prop], patch[prop]]);
        }
        if (patch.baseReleaseId !== undefined && patch.baseReleaseId !== current.baseReleaseId)
          changes.set("$base", [current.baseReleaseId, patch.baseReleaseId]);
        const contentChanged = [...changes.keys()].some((k) => k !== "$status");
        let approval = current.approval;
        if (contentChanged && ["approved", "live"].includes(current.status)) {
          patch = { ...patch, status: "draft" };
          changes.set("$status", [current.status, "draft"]);
          approval = null;
        }
        if (["approved", "live"].includes(patch.status)) {
          const releaseId =
            patch.pinnedReleaseId ?? patch.baseReleaseId ?? current.pinnedReleaseId ?? current.baseReleaseId;
          if (!releaseId) throw new Error("Choose a release before approving this variant");
          patch = { ...patch, pinnedReleaseId: releaseId };
          if (current.pinnedReleaseId !== releaseId) changes.set("$pin", [current.pinnedReleaseId, releaseId]);
          approval = { revision: current.revision + (changes.size ? 1 : 0), releaseId, user, at: now() };
        } else if (patch.status !== undefined && !["approved", "live"].includes(patch.status)) approval = null;
        const baseRelease = patch.baseReleaseId !== undefined && patch.baseReleaseId !== current.baseReleaseId;
        if (!changes.size && !baseRelease) return current;

        if (!force && baseRevision !== null) {
          const conflicts = [...changes.keys()]
            .filter((key) => (fieldRevs[key] ?? 0) > baseRevision)
            .map((key) => ({ path: key, theirs: changes.get(key)[0], yours: changes.get(key)[1] }));
          if (conflicts.length) throw new ConflictError(conflicts, current);
        }

        const revision = changes.size ? current.revision + 1 : current.revision;
        for (const [key, [, value]] of changes) {
          fieldRevs[key] = revision;
          if (key.startsWith("$")) continue;
          if (value === undefined) delete overrides[key];
          else overrides[key] = value;
        }
        const next = {
          name: patch.name ?? current.name,
          tags: patch.tags ?? current.tags,
          status: patch.status ?? current.status,
          pinnedReleaseId: patch.pinnedReleaseId !== undefined ? patch.pinnedReleaseId : current.pinnedReleaseId,
          baseReleaseId: patch.baseReleaseId !== undefined ? patch.baseReleaseId : current.baseReleaseId
        };
        db.prepare(
          `UPDATE variants SET name = ?, overrides = ?, revision = ?, field_revs = ?, tags = ?, status = ?,
             pinned_release_id = ?, base_release_id = ?, updated_by = ?, updated_at = ? WHERE id = ?`
        ).run(
          next.name,
          JSON.stringify(overrides),
          revision,
          JSON.stringify(fieldRevs),
          JSON.stringify(next.tags),
          next.status,
          next.pinnedReleaseId ?? null,
          next.baseReleaseId ?? null,
          changes.size ? user : current.updatedBy,
          changes.size ? now() : current.updatedAt,
          id
        );
        if (contentChanged) db.prepare("UPDATE variants SET playtest = NULL WHERE id = ?").run(id);
        db.prepare("UPDATE variants SET approval = ? WHERE id = ?").run(approval ? JSON.stringify(approval) : null, id);
        const saved = this.getVariant(id);
        if (changes.size) {
          this._history(saved, [...changes.keys()], kind, user);
          this._linkUploads(saved.gameId, overrides);
        }
        return saved;
      });
    },

    /** Replaces all overrides (and optionally the name) — the old PUT and restores use it. */
    replaceVariant(id, { name, overrides }, opts = {}) {
      const current = this.getVariant(id);
      if (!current) return null;
      const patch = { name };
      if (overrides) {
        patch.set = overrides;
        patch.unset = Object.keys(current.overrides).filter((p) => !(p in overrides));
      }
      return this.patchVariant(id, patch, opts);
    },

    setPlaytest(id, result) {
      db.prepare("UPDATE variants SET playtest = ? WHERE id = ?").run(result ? JSON.stringify(result) : null, id);
      return this.getVariant(id);
    },

    /** Picture on the variant card. Does not change the revision — it is not an edit. */
    setThumbnail(id) {
      const at = now();
      const changed = db.prepare("UPDATE variants SET thumb_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, id);
      return changed.changes > 0 ? at : null;
    },

    deleteVariant(id) {
      return (
        db.prepare("UPDATE variants SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now(), id).changes > 0
      );
    },
    restoreDeletedVariant(id, gameId) {
      db.prepare("UPDATE variants SET deleted_at = NULL WHERE id = ? AND game_id = ?").run(id, gameId);
      return this.getVariant(id);
    },

    /** One history entry per edit session: a user's autosaves within HISTORY_MERGE_MS are merged. */
    _history(variant, changed, kind, user) {
      const last = db
        .prepare("SELECT * FROM variant_revisions WHERE variant_id = ? ORDER BY revision DESC LIMIT 1")
        .get(variant.id);
      const at = now();
      if (
        last &&
        kind === "edit" &&
        last.kind === "edit" &&
        (last.user ?? null) === (user ?? null) &&
        Date.now() - Date.parse(last.updated_at) < HISTORY_MERGE_MS
      ) {
        const merged = [...new Set([...JSON.parse(last.changed), ...changed])];
        db.prepare(
          "UPDATE variant_revisions SET revision = ?, name = ?, overrides = ?, changed = ?, updated_at = ? WHERE id = ?"
        ).run(variant.revision, variant.name, JSON.stringify(variant.overrides), JSON.stringify(merged), at, last.id);
      } else {
        db.prepare(
          `INSERT INTO variant_revisions (variant_id, revision, name, overrides, changed, kind, user, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          variant.id,
          variant.revision,
          variant.name,
          JSON.stringify(variant.overrides),
          JSON.stringify(changed),
          kind,
          user,
          at,
          at
        );
      }
      db.prepare(
        `DELETE FROM variant_revisions WHERE variant_id = ? AND id NOT IN
           (SELECT id FROM variant_revisions WHERE variant_id = ? ORDER BY revision DESC LIMIT ?)`
      ).run(variant.id, variant.id, HISTORY_KEEP);
    },

    listRevisions(variantId) {
      return db
        .prepare("SELECT * FROM variant_revisions WHERE variant_id = ? ORDER BY revision DESC")
        .all(variantId)
        .map(revisionRow);
    },

    /** The saved state of a history entry: { revision, name, overrides }. */
    getRevision(variantId, revision) {
      const row = db
        .prepare("SELECT * FROM variant_revisions WHERE variant_id = ? AND revision = ?")
        .get(variantId, revision);
      return row && { ...revisionRow(row), overrides: JSON.parse(row.overrides) };
    },

    // ── exports ────────────────────────────────────────────────────────────
    addExport(e) {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO exports (game_id, variant_id, variant_name, revision, release_id, release_number, networks, langs,
             overrides, file_name, size, sha256, warnings, job_id, user, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          e.gameId,
          e.variantId,
          e.variantName,
          e.revision,
          e.releaseId,
          e.releaseNumber,
          JSON.stringify(e.networks),
          JSON.stringify(e.langs),
          JSON.stringify(e.overrides),
          e.fileName,
          e.size,
          e.sha256,
          JSON.stringify(e.warnings ?? []),
          e.jobId ?? null,
          e.user ?? null,
          e.createdAt
        );
      return this.getExport(Number(lastInsertRowid));
    },

    listExports(gameId, limit = 200) {
      return db
        .prepare("SELECT * FROM exports WHERE game_id = ? ORDER BY id DESC LIMIT ?")
        .all(gameId, limit)
        .map(exportRow);
    },

    getExport(id) {
      return exportRow(db.prepare("SELECT * FROM exports WHERE id = ?").get(id));
    },

    /** The export with the variant values it was made from, to make the same file again. */
    getExportSource(id) {
      const row = db.prepare("SELECT * FROM exports WHERE id = ?").get(id);
      return row && { ...exportRow(row), overrides: JSON.parse(row.overrides) };
    },

    // ── game asset library ───────────────────────────────────────────────
    linkAsset(gameId, assetId, name = "") {
      db.prepare("INSERT OR IGNORE INTO game_assets (game_id, asset_id, name, created_at) VALUES (?, ?, ?, ?)").run(
        gameId,
        assetId,
        name,
        now()
      );
    },

    _linkUploads(gameId, overrides) {
      for (const id of uploadIds(overrides)) if (this.getAsset(id)) this.linkAsset(gameId, id);
    },

    unlinkAsset: (gameId, assetId) =>
      db.prepare("DELETE FROM game_assets WHERE game_id = ? AND asset_id = ?").run(gameId, assetId).changes > 0,

    listGameAssets(gameId) {
      const used = new Map();
      for (const v of this.listVariants(gameId))
        for (const id of new Set(uploadIds(v.overrides))) used.set(id, [...(used.get(id) ?? []), v.name]);
      return db
        .prepare(
          `SELECT a.*, ga.name AS label, ga.created_at AS linked_at FROM game_assets ga
           JOIN assets a ON a.id = ga.asset_id WHERE ga.game_id = ? ORDER BY ga.created_at DESC`
        )
        .all(gameId)
        .map((r) => ({
          id: r.id,
          mime: r.mime,
          size: r.size,
          name: r.label || r.name,
          createdAt: r.linked_at,
          usedBy: used.get(r.id) ?? []
        }));
    },

    // ── deleting & storage ─────────────────────────────────────────────────
    hasReleaseExports: (id) => !!db.prepare("SELECT 1 FROM exports WHERE release_id = ? LIMIT 1").get(id),

    deleteRelease: (id) => db.prepare("DELETE FROM releases WHERE id = ?").run(id).changes > 0,

    /** Removes the game with its variants, history, releases, exports and library; returns the release ids. */
    deleteGame(gameId) {
      return tx(() => {
        const releaseIds = db
          .prepare("SELECT id FROM releases WHERE game_id = ?")
          .all(gameId)
          .map((r) => r.id);
        db.prepare("DELETE FROM variant_revisions WHERE variant_id IN (SELECT id FROM variants WHERE game_id = ?)").run(
          gameId
        );
        for (const table of ["variants", "releases", "exports", "game_assets", "recipes", "recipe_runs"])
          db.prepare(`DELETE FROM ${table} WHERE game_id = ?`).run(gameId);
        db.prepare("DELETE FROM games WHERE id = ?").run(gameId);
        return releaseIds;
      });
    },

    /**
     * Uploaded files nothing points at any more (no variant, history entry, export or game library)
     * and older than `graceMs` are removed from the database.
     * @returns {{ removed: asset rows, keep: Set<sha256> still needed }}
     */
    collectUnusedAssets(graceMs = 24 * 3600 * 1000) {
      return tx(() => {
        const used = new Set();
        const addFrom = (sql) =>
          db
            .prepare(sql)
            .all()
            .forEach((r) => uploadIds(JSON.parse(r.overrides)).forEach((id) => used.add(id)));
        addFrom("SELECT overrides FROM variants");
        addFrom("SELECT overrides FROM variant_revisions");
        addFrom("SELECT overrides FROM exports");
        db.prepare("SELECT asset_id FROM game_assets")
          .all()
          .forEach((r) => used.add(r.asset_id));
        const cutoff = new Date(Date.now() - graceMs).toISOString();
        const removed = db
          .prepare("SELECT * FROM assets WHERE created_at < ?")
          .all(cutoff)
          .filter((a) => !used.has(a.id));
        for (const a of removed) db.prepare("DELETE FROM assets WHERE id = ?").run(a.id);
        const keep = new Set(
          db
            .prepare("SELECT sha256 FROM assets")
            .all()
            .map((r) => r.sha256)
        );
        return { removed, keep };
      });
    },

    releaseIds: () =>
      new Set(
        db
          .prepare("SELECT id FROM releases")
          .all()
          .map((r) => r.id)
      ),

    /** A consistent copy of the database (safe while the Studio runs). */
    backupTo(file) {
      db.prepare("VACUUM INTO ?").run(file);
    },

    addAsset({ id, sha256, mime, size, name }) {
      db.prepare(
        "INSERT OR IGNORE INTO assets (id, sha256, mime, size, name, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, sha256, mime, size, name, now());
      return this.getAsset(id);
    },

    // ── users & sessions ───────────────────────────────────────────────────
    countUsers: () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    listUsers: () => db.prepare("SELECT * FROM users ORDER BY username").all().map(userRow),
    getUser: (id) => userRow(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),

    /** The user with its password hash, for login only. */
    findLogin(username) {
      const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
      return row && { user: userRow(row), passwordHash: row.password_hash };
    },

    createUser(username, passwordHash) {
      const { lastInsertRowid } = db
        .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
        .run(username, passwordHash, now());
      return this.getUser(Number(lastInsertRowid));
    },

    /** Also signs the user out everywhere. */
    setPassword(userId, passwordHash) {
      return tx(() => {
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        return db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId).changes > 0;
      });
    },

    deleteUser: (id) => db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0,

    createSession(tokenHash, userId, expiresAt) {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
        tokenHash,
        userId,
        expiresAt,
        now()
      );
    },

    sessionUser(tokenHash) {
      const row = db
        .prepare(
          "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?"
        )
        .get(tokenHash, now());
      return userRow(row);
    },

    deleteSession: (tokenHash) => db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash),

    addApiToken(tokenHash, userId, label) {
      db.prepare("INSERT INTO api_tokens (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
        tokenHash,
        userId,
        label,
        now()
      );
    },

    apiTokenUser(tokenHash) {
      const row = db
        .prepare("SELECT users.* FROM api_tokens JOIN users ON users.id = api_tokens.user_id WHERE token_hash = ?")
        .get(tokenHash);
      if (row) db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?").run(now(), tokenHash);
      return userRow(row);
    },

    listApiTokens: (userId) =>
      db
        .prepare("SELECT label, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at")
        .all(userId)
        .map((r) => ({ label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at })),

    deleteApiTokens: (userId) => db.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(userId).changes,

    getAsset(id) {
      const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
      return row && { id: row.id, sha256: row.sha256, mime: row.mime, size: row.size, name: row.name };
    }
  };
}
