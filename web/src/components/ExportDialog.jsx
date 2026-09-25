import { useEffect, useState } from "react";
import { api } from "../api.js";
import { download, formatBytes } from "../format.js";

const STORE_URL_NOTE = {
  always: "",
  maybe: "store link may come from the campaign",
  never: "store link comes from the campaign"
};

function remembered(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * One variant: exported right away. Several: a background job with progress, one ZIP at the end.
 * releaseId null (several variants) = each variant's pinned release, otherwise the latest.
 */
export function ExportDialog({
  gameId,
  variants,
  currentVariantId,
  releases,
  releaseId,
  languages,
  defaultLang,
  beforeExport,
  onClose,
  onExported
}) {
  const [networks, setNetworks] = useState(null);
  const [picked, setPicked] = useState(() => new Set(remembered("pl-export-networks", ["default"])));
  const [langs, setLangs] = useState(() => new Set([defaultLang]));
  const [release, setRelease] = useState(releaseId ?? "own");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const bulk = variants.length > 1;
  const title = bulk ? `${variants.length} variants` : variants[0].name;

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
    setJob(null);
    try {
      // Export exactly what is on screen: everything saved, and the revision the server must have.
      const revision = variants.some((v) => v.id === currentVariantId) ? await beforeExport() : undefined;
      localStorage.setItem("pl-export-networks", JSON.stringify([...picked]));
      const body = { networks: [...picked], langs: [...langs], ...(release !== "own" && { releaseId: release }) };
      if (!bulk) {
        const v = variants[0];
        const out = await api.exportVariant(v.id, {
          ...body,
          revision: v.id === currentVariantId ? revision : v.revision
        });
        download(out.fileName, out.blob);
        setResult(out);
        onExported?.();
        return;
      }
      let j = await api.startExportJob(gameId, { ...body, variantIds: variants.map((v) => v.id) });
      setJob(j);
      while (j.state === "queued" || j.state === "running") {
        await new Promise((r) => setTimeout(r, 700));
        j = await api.job(j.id);
        setJob(j);
      }
      if (j.state === "failed") throw new Error(j.error);
      const file = await api.downloadJob(j.id);
      download(file.fileName, file.blob);
      setResult({
        ...file,
        warnings: [...new Set(j.results.flatMap((r) => (r.error ? [`${r.name}: ${r.error}`] : r.warnings)))]
      });
      onExported?.();
    } catch (e) {
      setError(e.status === 409 ? `${e.message}` : e.message);
    } finally {
      setBusy(false);
    }
  }

  const count = picked.size * langs.size * variants.length;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Export">
        <header>
          <strong>Export · {title}</strong>
          <button className="link" onClick={onClose}>
            ✕
          </button>
        </header>

        <label className="inline">
          Release
          <select
            value={release}
            onChange={(e) => setRelease(e.target.value === "own" ? "own" : Number(e.target.value))}
          >
            {bulk && <option value="own">Each variant's release (pinned, else latest)</option>}
            {releases.map((r, i) => (
              <option key={r.id} value={r.id}>
                r{r.number}
                {i === 0 ? " (latest)" : ""}
                {r.notes ? ` · ${r.notes}` : ""}
              </option>
            ))}
          </select>
        </label>

        <h4>Networks</h4>
        {!networks ? (
          <p className="muted">Loading…</p>
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
            All
          </button>
          <button className="link" onClick={() => setPicked(new Set())}>
            None
          </button>
        </div>

        <h4>Languages</h4>
        <div className="check-grid langs">
          {["auto", ...languages].map((l) => (
            <label key={l} className="check">
              <input type="checkbox" checked={langs.has(l)} onChange={() => toggle(langs, setLangs, l)} />
              <span>{l === "auto" ? "auto (device language)" : l}</span>
            </label>
          ))}
        </div>

        {bulk && <p className="muted small">{variants.map((v) => v.name).join(", ")}</p>}
        {job && busy && (
          <div className="job">
            <span>{job.state === "queued" ? "Waiting…" : `Packaging ${job.done} / ${job.total}`}</span>
            <progress max={job.total} value={job.done} />
          </div>
        )}
        {error && <pre className="error pre">{error}</pre>}
        {result && (
          <div className="banner ok">
            Downloaded: <span className="mono">{result.fileName}</span> ({formatBytes(result.blob.size)})
            {result.warnings.map((w) => (
              <div key={w} className="warn-line">
                ! {w}
              </div>
            ))}
          </div>
        )}

        <footer>
          <span className="muted small">
            {count} {count === 1 ? "file" : "files"}
          </span>
          <button className="primary" disabled={!count || busy} onClick={run}>
            {busy ? "Preparing…" : bulk ? "Export all" : "Export"}
          </button>
        </footer>
      </div>
    </div>
  );
}
