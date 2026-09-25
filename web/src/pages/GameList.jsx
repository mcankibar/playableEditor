import { useCallback, useEffect, useState } from "react";
import { UserMenu } from "../auth.jsx";
import { api } from "../api.js";
import { gameHash, navigate } from "../App.jsx";
import { formatBytes, formatDate } from "../format.js";

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
              </li>
            ))}
          </ul>
        )}
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
