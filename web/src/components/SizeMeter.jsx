import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { formatBytes } from "../format.js";

const DELAY = 900;

/** Package size per network while editing; the badge shows the tightest limit. */
export function SizeMeter({ releaseId, overrides }) {
  const [sizes, setSizes] = useState(null);
  const [open, setOpen] = useState(false);
  const [networks, setNetworks] = useState({});
  const key = JSON.stringify(overrides);
  const seq = useRef(0);

  useEffect(() => {
    api.networks().then(
      (list) => setNetworks(Object.fromEntries(list.map((n) => [n.id, n.label]))),
      () => {}
    );
  }, []);

  useEffect(() => {
    if (!releaseId) return;
    const n = ++seq.current;
    const timer = setTimeout(() => {
      api.estimate(releaseId, JSON.parse(key)).then(
        (out) => n === seq.current && setSizes(out),
        () => {}
      );
    }, DELAY);
    return () => clearTimeout(timer);
  }, [releaseId, key]);

  if (!sizes) return null;
  if (sizes.error)
    return (
      <span className="size-meter bad" title={sizes.error}>
        Size: error
      </span>
    );
  const rows = Object.entries(sizes).map(([id, s]) => ({ id, ...s, ratio: s.bytes / s.maxBytes }));
  const worst = rows.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  const over = rows.filter((r) => r.ratio > 1);
  const level = over.length ? "bad" : worst.ratio > 0.9 ? "warn" : "ok";

  return (
    <span className="size-meter-wrap" onMouseLeave={() => setOpen(false)}>
      <button
        className={`size-meter ${level}`}
        onClick={() => setOpen(!open)}
        title="Estimated package size per network"
      >
        {over.length
          ? `Too big for ${over.length} ${over.length === 1 ? "network" : "networks"}`
          : `${networks[worst.id] ?? worst.id} ${formatBytes(worst.bytes)} / ${formatBytes(worst.maxBytes)}`}
      </button>
      {open && (
        <div className="size-pop">
          {rows.map((r) => (
            <div key={r.id} className={`size-row${r.ratio > 1 ? " bad" : r.ratio > 0.9 ? " warn" : ""}`}>
              <span>{networks[r.id] ?? r.id}</span>
              <span className="bar">
                <span style={{ width: `${Math.min(100, r.ratio * 100)}%` }} />
              </span>
              <span className="mono">
                {r.approx ? "≈" : ""}
                {formatBytes(r.bytes)} / {formatBytes(r.maxBytes)}
              </span>
            </div>
          ))}
          <p className="muted small">Switched-off parts are left out. ZIP sizes are estimates.</p>
        </div>
      )}
    </span>
  );
}
