import { useState } from "react";
import { Preview } from "./Preview.jsx";
import { normalizeValue, sanitizeOverrides } from "../../../shared/playable/kit/resolve.js";

export function CompareDialog({ variants, manifest, release, onClose }) {
  const [landscape, setLandscape] = useState(false);
  const [size, setSize] = useState("390x844");
  const [run, setRun] = useState(0);
  const [width, height] = size.split("x").map(Number);
  const view = { id: "custom", custom: { width, height }, landscape };
  const checked = variants.map((v) => sanitizeOverrides(manifest.fields, v.overrides));
  const value = (i, field) =>
    checked[i].values[field.path] ?? normalizeValue(field, field.default).value ?? field.default;
  const differences = manifest.fields.filter(
    (f) => new Set(variants.map((_, i) => JSON.stringify(value(i, f)))).size > 1
  );
  return (
    <div className="modal-backdrop">
      <div className="modal compare-dialog" role="dialog" aria-modal="true" aria-label="Visual comparison">
        <div className="experiment-toolbar">
          <h2>Visual comparison · r{release.number}</h2>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <p className="muted">
          Saved revisions, all on r{release.number}. Play each preview independently. Restart all reloads them together;
          random gameplay and loading times may differ.
        </p>
        <div className="experiment-toolbar">
          <select aria-label="Comparison viewport" value={size} onChange={(e) => setSize(e.target.value)}>
            <option value="390x844">Phone · 390 × 844</option>
            <option value="360x780">Phone · 360 × 780</option>
            <option value="768x1024">Tablet · 768 × 1024</option>
          </select>
          <button onClick={() => setLandscape((v) => !v)}>{landscape ? "Landscape" : "Portrait"}</button>
          <button onClick={() => setRun((n) => n + 1)}>Restart all</button>
        </div>
        <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${variants.length}, minmax(240px, 1fr))` }}>
          {variants.map((v, i) => (
            <section key={v.id}>
              <h3>
                {v.name} <small>· revision {v.revision}</small>
              </h3>
              {(checked[i].errors.length > 0 || checked[i].orphans.length > 0) && (
                <p className="error">
                  Incompatible overrides: {[...checked[i].errors, ...checked[i].orphans].join(", ")}
                </p>
              )}
              <Preview
                releaseId={release.id}
                release={release}
                overrides={checked[i].values}
                assets={v.uploads}
                comparisonView={view}
                restartKey={run}
              />
            </section>
          ))}
        </div>
        <h3>Changed fields ({differences.length})</h3>
        {differences.length ? (
          <div className="experiment-table">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  {variants.map((v) => (
                    <th key={v.id}>{v.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {differences.map((f) => (
                  <tr key={f.path}>
                    <th title={f.path}>{f.label || f.path}</th>
                    {variants.map((v, i) => (
                      <td key={v.id}>{JSON.stringify(value(i, f))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">All effective field values are identical.</p>
        )}
      </div>
    </div>
  );
}
