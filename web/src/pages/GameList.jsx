import { useCallback, useEffect, useState } from "react";
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
      </header>
      <main className="list-main">
        <ReleaseDrop
          onUploaded={({ game, created, release }) => {
            if (created) navigate(gameHash(game.id));
            else setError(`Bu build zaten yüklü (r${release.number}).`);
            load();
          }}
          onError={setError}
        />
        {error && <p className="error">{error}</p>}
        {games === null ? (
          <p className="muted">Yükleniyor…</p>
        ) : games.length === 0 ? (
          <p className="muted">Henüz oyun yok. İlk release'i yukarıdan yükleyin.</p>
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
                      {formatDate(g.latestRelease.createdAt)} · {g.latestRelease.fieldCount} alan ·{" "}
                      {formatBytes(g.latestRelease.size)}
                    </span>
                  )}
                  <span className="meta">{g.variantCount} varyant</span>
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
      const notes = compact ? "" : (window.prompt("Release notu (isteğe bağlı):", "") ?? "");
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
        "Yükleniyor…"
      ) : compact ? (
        "Yeni release yükle"
      ) : (
        <>
          <strong>Release yükle</strong>
          <span>
            Oyunun <code>dist/index.html</code> dosyasını buraya bırakın ya da oyun klasöründe{" "}
            <code>npm run release</code> çalıştırın.
          </span>
        </>
      )}
    </label>
  );
}
