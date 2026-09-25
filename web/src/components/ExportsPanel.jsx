import { useEffect, useState } from "react";
import { api } from "../api.js";
import { download, formatBytes, formatDate } from "../format.js";

/** Past exports of the game (who, what, with which release) and running bulk exports. */
export function ExportsPanel({ gameId, onError, onClose }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.exports(gameId).then(
        (d) => {
          if (!alive) return;
          setList(d);
          // Keep refreshing while a bulk export runs.
          if (d.jobs.some((j) => j.state === "queued" || j.state === "running")) timer = setTimeout(load, 1000);
        },
        (e) => onError(e.message)
      );
    let timer = null;
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [gameId, onError]);

  const again = async (e) => {
    setBusy(e.id);
    try {
      const out = await api.downloadExport(e.id);
      download(out.fileName, out.blob);
      if (!out.identical)
        onError("The file was made again but differs from the original (the exporter changed since).");
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="fields drawer">
      <div className="drawer-head">
        <strong>Exports</strong>
        <button className="link" onClick={onClose}>
          ✕
        </button>
      </div>
      {!list ? (
        <p className="muted pad">Loading…</p>
      ) : (
        <>
          {list.jobs.map((j) => (
            <div key={j.id} className="job">
              <div>
                <strong>Bulk export</strong> · {j.total} variants · {j.networks.join(", ")}
              </div>
              {j.state === "done" ? (
                <button
                  className="small"
                  onClick={() =>
                    api.downloadJob(j.id).then(
                      (f) => download(f.fileName, f.blob),
                      (e) => onError(e.message)
                    )
                  }
                >
                  Download ({formatBytes(j.size)})
                </button>
              ) : j.state === "failed" ? (
                <span className="error small">{j.error}</span>
              ) : (
                <progress max={j.total} value={j.done} />
              )}
            </div>
          ))}
          {list.exports.length === 0 ? (
            <p className="muted pad">Nothing exported yet.</p>
          ) : (
            <ul className="exports">
              {list.exports.map((e) => (
                <li key={e.id}>
                  <div>
                    <strong>{e.variantName}</strong>
                    <span className="muted small">
                      {" "}
                      rev {e.revision} · r{e.releaseNumber}
                    </span>
                  </div>
                  <div className="muted small">
                    {e.networks.join(", ")} · {e.langs.join(", ")} · {formatBytes(e.size)}
                  </div>
                  <div className="muted small">
                    {formatDate(e.createdAt)}
                    {e.user ? ` · ${e.user}` : ""}
                    {e.warnings.length > 0 && <span title={e.warnings.join("\n")}> · ⚠ {e.warnings.length}</span>}
                  </div>
                  <button className="small" disabled={busy === e.id} onClick={() => again(e)} title={e.fileName}>
                    {busy === e.id ? "Preparing…" : "Download again"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
