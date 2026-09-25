import { useEffect, useState } from "react";
import { api } from "../api.js";
import { fieldName, formatDate, formatValue } from "../format.js";

const KIND = { create: "Created", copy: "Copied", import: "Imported", edit: "Edited", restore: "Restored" };

/** The variant's history: one entry per edit session; any entry can be brought back. */
export function HistoryPanel({ variant, fields, onRestore, onError, onClose }) {
  const [revisions, setRevisions] = useState(null);
  const [open, setOpen] = useState(null); // { revision, overrides }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.revisions(variant.id).then(setRevisions, (e) => onError(e.message));
    // Reload when the variant gets a new revision.
  }, [variant.id, variant.revision, onError]);

  const show = async (r) => {
    if (open?.revision === r.revision) return setOpen(null);
    try {
      setOpen(await api.revision(variant.id, r.revision));
    } catch (e) {
      onError(e.message);
    }
  };

  const restore = async (r) => {
    if (
      !window.confirm(
        `Bring back "${r.name}" as it was at ${formatDate(r.updatedAt)}? The current state stays in the history.`
      )
    )
      return;
    setBusy(true);
    try {
      await onRestore(r.revision);
      setOpen(null);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="fields drawer">
      <div className="drawer-head">
        <strong>History · {variant.name}</strong>
        <button className="link" onClick={onClose}>
          ✕
        </button>
      </div>
      {!revisions ? (
        <p className="muted pad">Loading…</p>
      ) : (
        <ol className="history">
          {revisions.map((r, i) => (
            <li key={r.id} className={open?.revision === r.revision ? "open" : ""}>
              <button className="history-item" onClick={() => show(r)}>
                <span>
                  <strong>{KIND[r.kind] ?? r.kind}</strong>
                  {r.user ? ` by ${r.user}` : ""}
                  {i === 0 && <span className="badge">current</span>}
                </span>
                <span className="muted small">
                  {formatDate(r.updatedAt)} · {r.changed.length} {r.changed.length === 1 ? "change" : "changes"}
                </span>
              </button>
              {open?.revision === r.revision && (
                <div className="history-detail">
                  {r.changed.length > 0 && (
                    <ul className="small">
                      {r.changed.map((p) => (
                        <li key={p}>
                          {fieldName(fields, p)}
                          {!p.startsWith("$") && (
                            <span className="mono muted"> → {formatValue(open.overrides[p])}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {i > 0 && (
                    <button className="small" disabled={busy} onClick={() => restore(r)}>
                      Restore this version
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
