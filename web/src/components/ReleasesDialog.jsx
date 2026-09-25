import { useEffect } from "react";
import { api } from "../api.js";
import { ReleaseDrop } from "../pages/GameList.jsx";
import { formatBytes, formatDate } from "../format.js";

/** Upload, pin (for the open variant) and delete releases. */
export function ReleasesDialog({ gameId, releases, variant, variants, onChanged, onPin, onError, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remove = async (r) => {
    if (!window.confirm(`Delete release r${r.number}? Its past exports can't be downloaded again.`)) return;
    try {
      await api.deleteRelease(r.id);
      await onChanged();
    } catch (e) {
      onError(e.message);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-label="Releases">
        <header>
          <strong>Releases</strong>
          <button className="link" onClick={onClose}>
            ✕
          </button>
        </header>
        <ReleaseDrop
          compact
          onUploaded={async ({ release, created }) => {
            await onChanged(release.id);
            if (!created) onError(`This build is already uploaded (r${release.number}).`);
          }}
          onError={onError}
        />
        <p className="muted small">
          Variants follow the latest release. Pin one to keep “{variant.name}” on a release while you test a new one.
        </p>
        <table className="table">
          <tbody>
            {releases.map((r, i) => {
              const pinnedBy = variants.filter((v) => v.pinnedReleaseId === r.id);
              return (
                <tr key={r.id}>
                  <td>
                    <strong>r{r.number}</strong>
                    {i === 0 && <span className="badge">latest</span>}
                  </td>
                  <td className="muted small">
                    {formatDate(r.createdAt)} · {formatBytes(r.size)}
                    {r.notes ? ` · ${r.notes}` : ""}
                    {pinnedBy.length > 0 && <div>Pinned by {pinnedBy.map((v) => v.name).join(", ")}</div>}
                  </td>
                  <td className="actions">
                    {variant.pinnedReleaseId === r.id ? (
                      <button className="small" onClick={() => onPin(null).catch((e) => onError(e.message))}>
                        Unpin
                      </button>
                    ) : (
                      <button className="small" onClick={() => onPin(r.id).catch((e) => onError(e.message))}>
                        Pin “{variant.name}”
                      </button>
                    )}
                    <button
                      className="small danger"
                      disabled={releases.length < 2 || pinnedBy.length > 0}
                      onClick={() => remove(r)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
