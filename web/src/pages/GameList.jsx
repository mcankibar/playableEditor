import { useCallback, useEffect, useState } from "react";
import { UserMenu } from "../auth.jsx";
import { api } from "../api.js";
import { gameHash, navigate } from "../App.jsx";
import { formatBytes, formatDate } from "../format.js";

/** Backups and clean-up of files nothing uses any more. */
function StoragePanel({ onError }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    api.maintenance().then(setInfo, (e) => onError(e.message));
  }, [onError]);

  const run = (what, fn) => async () => {
    setBusy(what);
    setNote("");
    try {
      await fn();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy("");
    }
  };

  const [last] = info?.backups ?? [];
  return (
    <section className="storage">
      <h3>Storage</h3>
      {!info ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="small">
            {info.backupDir ? (
              <>
                Daily backup to <span className="mono">{info.backupDir}</span> —{" "}
                {last ? `last ${formatDate(last.createdAt)}, ${info.backups.length} kept` : "none yet"}.
              </>
            ) : (
              "Backups are off (set STUDIO_BACKUP_DIR)."
            )}
          </p>
          <div className="row-actions">
            {info.backupDir && (
              <button
                className="small"
                disabled={!!busy}
                onClick={run("backup", async () => {
                  const out = await api.backupNow();
                  setInfo((i) => ({ ...i, backups: out.backups }));
                  setNote("Backup written.");
                })}
              >
                {busy === "backup" ? "Backing up…" : "Back up now"}
              </button>
            )}
            <button
              className="small"
              disabled={!!busy}
              title="Removes uploaded files that no variant, history entry, export or game library uses (older than a day)"
              onClick={run("gc", async () => {
                const out = await api.collectGarbage();
                setNote(
                  `Removed ${out.assets} unused ${out.assets === 1 ? "file" : "files"} (${formatBytes(out.bytes)}).`
                );
              })}
            >
              {busy === "gc" ? "Cleaning…" : "Clean up unused files"}
            </button>
            {note && <span className="muted small">{note}</span>}
          </div>
        </>
      )}
    </section>
  );
}

export function GameList() {
  const [games, setGames] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => api.games().then(setGames, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="page">
      <header className="topbar">
        <span className="brand">Playable Studio</span>
        <span className="spacer" />
        <UserMenu />
      </header>
      <main className="list-main">
        <ReleaseDrop
          onUploaded={({ game, created, release }) => {
            if (created) navigate(gameHash(game.id));
            else setError(`This build is already uploaded (r${release.number}).`);
            load();
          }}
          onError={setError}
        />
        {error && <p className="error">{error}</p>}
        {games === null ? (
          <p className="muted">Loading…</p>
        ) : games.length === 0 ? (
          <p className="muted">No games yet. Upload the first release above.</p>
        ) : (
          <ul className="game-grid">
            {games.map((g) => (
              <li key={g.id}>
                <a className="game-card" href={gameHash(g.id)}>
                  <strong>{g.title}</strong>
                  <span className="muted mono">{g.id}</span>
                  {g.latestRelease && (
                    <span className="meta">
                      <span className="badge">r{g.latestRelease.number}</span>
                      {formatDate(g.latestRelease.createdAt)} · {g.latestRelease.fieldCount}{" "}
                      {g.latestRelease.fieldCount === 1 ? "field" : "fields"} · {formatBytes(g.latestRelease.size)}
                    </span>
                  )}
                  <span className="meta">
                    {g.variantCount} {g.variantCount === 1 ? "variant" : "variants"}
                  </span>
                </a>
                <button
                  className="link small danger game-delete"
                  onClick={async () => {
                    const typed = window.prompt(
                      `Delete "${g.title}" with all its releases, variants, history and export records?\nType the game id to confirm: ${g.id}`
                    );
                    if (typed !== g.id) return;
                    try {
                      await api.deleteGame(g.id);
                      load();
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                >
                  Delete game
                </button>
              </li>
            ))}
          </ul>
        )}
        <StoragePanel onError={setError} />
      </main>
    </div>
  );
}

export function ReleaseDrop({ onUploaded, onError, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  async function upload(file) {
    if (!file) return;
    setBusy(true);
    try {
      const notes = compact ? "" : (window.prompt("Release notes (optional):", "") ?? "");
      onUploaded(await api.uploadRelease(await file.text(), notes));
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label
      className={`drop${over ? " over" : ""}${compact ? " compact" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        upload(e.dataTransfer.files[0]);
      }}
    >
      <input type="file" accept=".html,text/html" hidden onChange={(e) => upload(e.target.files[0])} />
      {busy ? (
        "Loading…"
      ) : compact ? (
        "Upload new release"
      ) : (
        <>
          <strong>Upload release</strong>
          <span>
            Drop the game's <code>dist/index.html</code> here, or run <code>npm run release</code> in the game folder.
          </span>
        </>
      )}
    </label>
  );
}
