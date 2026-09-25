import { useEffect, useState } from "react";
import { api } from "../api.js";
import { download } from "./VariantList.jsx";
import { formatBytes } from "../format.js";

const STORE_URL_NOTE = {
  always: "",
  maybe: "store linki kampanyadan gelebilir",
  never: "store linki kampanyadan gelir"
};

function remembered(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function ExportDialog({ variant, releases, releaseId, languages, defaultLang, beforeExport, onClose }) {
  const [networks, setNetworks] = useState(null);
  const [picked, setPicked] = useState(() => new Set(remembered("pl-export-networks", ["default"])));
  const [langs, setLangs] = useState(() => new Set([defaultLang]));
  const [release, setRelease] = useState(releaseId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.networks().then(setNetworks, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (set, setter, value) => {
    const next = new Set(set);
    next.has(value) ? next.delete(value) : next.add(value);
    setter(next);
  };

  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      await beforeExport();
      localStorage.setItem("pl-export-networks", JSON.stringify([...picked]));
      const out = await api.exportVariant(variant.id, { releaseId: release, networks: [...picked], langs: [...langs] });
      download(out.fileName, out.blob);
      setResult(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const count = picked.size * langs.size;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Export">
        <header>
          <strong>Export · {variant.name}</strong>
          <button className="link" onClick={onClose}>
            ✕
          </button>
        </header>

        <label className="inline">
          Release
          <select value={release} onChange={(e) => setRelease(Number(e.target.value))}>
            {releases.map((r, i) => (
              <option key={r.id} value={r.id}>
                r{r.number}
                {i === 0 ? " (en güncel)" : ""}
                {r.notes ? ` · ${r.notes}` : ""}
              </option>
            ))}
          </select>
        </label>

        <h4>Ağlar</h4>
        {!networks ? (
          <p className="muted">Yükleniyor…</p>
        ) : (
          <div className="check-grid">
            {networks.map((n) => (
              <label key={n.id} className="check">
                <input type="checkbox" checked={picked.has(n.id)} onChange={() => toggle(picked, setPicked, n.id)} />
                <span>
                  {n.label}
                  <span className="muted small">
                    {" "}
                    {n.container === "zip" ? "zip" : "html"} · {n.maxMb} MB
                    {STORE_URL_NOTE[n.storeUrl] ? ` · ${STORE_URL_NOTE[n.storeUrl]}` : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="row-actions">
          <button className="link" onClick={() => setPicked(new Set(networks?.map((n) => n.id)))}>
            hepsi
          </button>
          <button className="link" onClick={() => setPicked(new Set())}>
            hiçbiri
          </button>
        </div>

        <h4>Diller</h4>
        <div className="check-grid langs">
          {["auto", ...languages].map((l) => (
            <label key={l} className="check">
              <input type="checkbox" checked={langs.has(l)} onChange={() => toggle(langs, setLangs, l)} />
              <span>{l === "auto" ? "auto (cihaz dili)" : l}</span>
            </label>
          ))}
        </div>

        {error && <pre className="error pre">{error}</pre>}
        {result && (
          <div className="banner ok">
            İndirildi: <span className="mono">{result.fileName}</span> ({formatBytes(result.blob.size)})
            {result.warnings.map((w) => (
              <div key={w} className="warn-line">
                ! {w}
              </div>
            ))}
          </div>
        )}

        <footer>
          <span className="muted small">{count} dosya</span>
          <button className="primary" disabled={!count || busy} onClick={run}>
            {busy ? "Hazırlanıyor…" : "Export"}
          </button>
        </footer>
      </div>
    </div>
  );
}
