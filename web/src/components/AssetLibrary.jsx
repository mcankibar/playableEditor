import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "../format.js";
import "./assetLibrary.css";

// Which uploaded files fit a field type (by the MIME type the server detected).
const COMPATIBLE = {
  image: (m) => m.startsWith("image/"),
  sound: (m) => m.startsWith("audio/"),
  model: (m) => m === "model/gltf-binary" || m === "application/zip",
  font: (m) => m.startsWith("font/") || /font|woff|ttf|otf/.test(m),
  data: (m) => m === "application/json" || m === "text/plain" || m === "application/zip"
};

const fileUrl = (id) => `/api/assets/${id}`;
const extension = (asset) => /\.([^./]+)$/.exec(asset.name || asset.id)?.[1]?.toUpperCase() ?? "FILE";

async function call(method, url) {
  const res = await fetch(url, { method });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = (await res.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

/** Uploaded files of a game that fit `field`; picking one calls onPick(asset) and closes. */
export function AssetLibrary({ gameId, field, onPick, onClose }) {
  const [assets, setAssets] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(null);

  const load = useCallback(
    () =>
      call("GET", `/api/games/${encodeURIComponent(gameId)}/assets`).then(
        (list) => setAssets(list),
        (e) => setError(e.message)
      ),
    [gameId]
  );
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function remove(asset) {
    if (!window.confirm(`Remove ${asset.name || asset.id} from the library?`)) return;
    setRemoving(asset.id);
    setError("");
    try {
      await call("DELETE", `/api/games/${encodeURIComponent(gameId)}/assets/${asset.id}`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setRemoving(null);
    }
  }

  function pick(asset) {
    onPick(asset);
    onClose();
  }

  const fits = COMPATIBLE[field?.type] ?? (() => true);
  const compatible = (assets ?? []).filter((a) => fits(a.mime || ""));
  const q = query.trim().toLowerCase();
  const shown = compatible.filter((a) => !q || (a.name || a.id).toLowerCase().includes(q));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal asset-library" role="dialog" aria-label="File library">
        <header>
          <strong>
            File library
            {field?.label && <span className="muted"> · {field.label}</span>}
          </strong>
          <button className="link" onClick={onClose}>
            ✕
          </button>
        </header>

        <input
          type="search"
          className="asset-library-search"
          placeholder="Search by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        {error && <pre className="error pre">{error}</pre>}

        {!assets ? (
          !error && <p className="muted">Loading…</p>
        ) : !compatible.length ? (
          <p className="muted asset-library-empty">
            No files uploaded for this game yet. Files you upload in any variant appear here.
          </p>
        ) : !shown.length ? (
          <p className="muted asset-library-empty">No matching files.</p>
        ) : (
          <ul className="asset-grid">
            {shown.map((a) => {
              const used = a.usedBy ?? [];
              return (
                <li
                  key={a.id}
                  className="asset-card"
                  role="button"
                  tabIndex={0}
                  title={a.name || a.id}
                  onClick={() => pick(a)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick(a))}
                >
                  {(a.mime || "").startsWith("image/") ? (
                    <img className="asset-card-thumb" src={fileUrl(a.id)} alt="" loading="lazy" />
                  ) : (
                    <span className="asset-card-thumb icon">{extension(a)}</span>
                  )}
                  <span className="asset-card-name">{a.name || a.id}</span>
                  <span className="muted small">{formatBytes(a.size ?? 0)}</span>
                  <span className="muted small" title={used.join(", ")}>
                    {used.length ? `used by ${used.length} ${used.length === 1 ? "variant" : "variants"}` : "unused"}
                  </span>
                  <button
                    className="link small danger asset-card-remove"
                    disabled={used.length > 0 || removing === a.id}
                    title={used.length ? "Still used by a variant" : "Delete this file"}
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(a);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {removing === a.id ? "Removing…" : "Remove from library"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <footer>
          <span className="muted small">
            {assets ? `${shown.length} of ${compatible.length} ${compatible.length === 1 ? "file" : "files"}` : ""}
          </span>
          <button onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}
