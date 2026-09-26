import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { STATUSES, download, formatDate } from "../format.js";

function VariantThumb({ id, at }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id, at]);
  if (!at || failed) return null;
  return (
    <img
      className="variant-thumb"
      src={`/api/variants/${id}/thumbnail?v=${encodeURIComponent(at)}`}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label ?? id;

function Icon({ name }) {
  const props = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true
  };
  if (name === "copy")
    return (
      <svg {...props}>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
      </svg>
    );
  if (name === "edit")
    return (
      <svg {...props}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      </svg>
    );
  if (name === "trash")
    return (
      <svg {...props}>
        <path d="M4 7h16" />
        <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      </svg>
    );
  if (name === "download")
    return (
      <svg {...props}>
        <path d="M12 4v11" />
        <path d="m7 11 5 5 5-5" />
        <path d="M5 20h14" />
      </svg>
    );
  return (
    <svg {...props}>
      <path d="M12 16V5" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 20h14" />
    </svg>
  );
}

/**
 * The game's variants: search, status and tag filters, and a selection for bulk actions (export,
 * playtest, status, tags). Clicking a name opens the variant; the checkbox selects it.
 */
export function VariantList({
  gameId,
  variants,
  releases,
  selectedId,
  overrides,
  uploads,
  latestReleaseId,
  onSelect,
  onChanged,
  onError,
  beforeChange,
  onExport,
  onPlaytest,
  onCompare
}) {
  const [trash, setTrash] = useState(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(""); // "" = all
  const [tag, setTag] = useState("");
  const [checked, setChecked] = useState(() => new Set());
  const [form, setForm] = useState(null); // { mode: "new" | "copy" | "edit", variant? }

  const allTags = useMemo(() => [...new Set(variants.flatMap((v) => v.tags))].sort(), [variants]);
  const releaseNumber = (id) => releases.find((r) => r.id === id)?.number;
  const needsCheck = (v) =>
    !v.pinnedReleaseId && v.baseReleaseId && latestReleaseId && v.baseReleaseId < latestReleaseId;

  const shown = variants.filter((v) => {
    if (status && v.status !== status) return false;
    if (tag && !v.tags.includes(tag)) return false;
    const q = query.trim().toLowerCase();
    return (
      !q ||
      v.name.toLowerCase().includes(q) ||
      v.tags.some((t) => t.toLowerCase().includes(q)) ||
      (v.updatedBy ?? "").toLowerCase().includes(q)
    );
  });

  // Drop checks of variants that are gone.
  useEffect(() => {
    setChecked((c) => new Set([...c].filter((id) => variants.some((v) => v.id === id))));
  }, [variants]);

  const act =
    (fn) =>
    async (...args) => {
      try {
        await beforeChange();
        await fn(...args);
      } catch (e) {
        onError(e.message);
      }
    };

  const remove = act(async (v) => {
    if (!window.confirm(`Move "${v.name}" to Trash? Its history will be preserved.`)) return;
    await api.deleteVariant(v.id);
    onChanged(v.id === selectedId ? variants.find((x) => x.id !== v.id)?.id : undefined);
  });

  const importFile = async (file) => {
    try {
      const json = JSON.parse(await file.text());
      onChanged((await api.importVariant(gameId, json)).id);
    } catch (e) {
      onError(`Import failed: ${e.message}`);
    }
  };

  // Same format as the template's dev panel: usable with `npm run export -- --variant=file.json`.
  const exportJson = act(async (v) => {
    const values = v.id === selectedId ? overrides : v.overrides;
    const files = v.id === selectedId ? uploads : await api.variantUploads(v.id);
    const used = {};
    Object.values(values).forEach((value) => {
      if (typeof value === "string" && files[value]) used[value] = files[value];
    });
    download(
      `${v.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`,
      new Blob([JSON.stringify({ name: v.name, tags: v.tags, overrides: values, uploads: used }, null, 2)], {
        type: "application/json"
      })
    );
  });

  const bulk = [...checked];
  const bulkPatch = act(async (patchOf) => {
    for (const v of variants.filter((x) => checked.has(x.id)))
      await api.patchVariant(v.id, { ...patchOf(v), baseRevision: v.revision });
    onChanged();
  });

  const toggle = (id) =>
    setChecked((c) => {
      const next = new Set(c);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <nav className="variants">
      <div className="variants-head">
        <span>Variants</span>
        <span className="muted small">{variants.length}</span>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn"
          title="Trash"
          aria-label="Trash"
          onClick={() => api.trash(gameId).then(setTrash, (e) => onError(e.message))}
        >
          <Icon name="trash" />
        </button>
        <label className="icon-btn" title="Import a variant.json" aria-label="Import">
          <Icon name="import" />
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files[0];
              e.target.value = "";
              if (file) importFile(file);
            }}
          />
        </label>
        <button className="small" onClick={() => setForm({ mode: "new" })}>
          + New
        </button>
      </div>
      <div className="variant-filters">
        <input
          type="search"
          placeholder="Search name, tag, person…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="chips">
          <button className={`chip${status === "" ? " on" : ""}`} onClick={() => setStatus("")}>
            All
          </button>
          {STATUSES.map((s) => (
            <button
              key={s.id}
              className={`chip status-${s.id}${status === s.id ? " on" : ""}`}
              onClick={() => setStatus(status === s.id ? "" : s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {allTags.length > 0 && (
          <div className="chips">
            {allTags.map((t) => (
              <button
                key={t}
                className={`chip tag${tag === t ? " on" : ""}`}
                onClick={() => setTag(tag === t ? "" : t)}
              >
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>

      {bulk.length > 0 && (
        <div className="bulk-bar">
          <span>
            <strong>{bulk.length}</strong> selected
          </span>
          <button className="small primary" onClick={act(async () => onExport(bulk))}>
            Export…
          </button>
          <button
            className="small"
            disabled={bulk.length < 2 || bulk.length > 4}
            onClick={() => onCompare(bulk)}
            title="Select 2–4 variants to compare on the selected release"
          >
            Compare
          </button>
          <button
            className="small"
            onClick={() => onPlaytest(bulk)}
            title="Load and play each one briefly on the release"
          >
            Check
          </button>
          <select
            className="small"
            value=""
            onChange={(e) => e.target.value && bulkPatch(() => ({ status: e.target.value }))}
            title="Set status"
          >
            <option value="">Status…</option>
            {STATUSES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            className="small"
            onClick={() => {
              const t = window.prompt("Add tag to the selected variants:", "")?.trim();
              if (t) bulkPatch((v) => ({ tags: [...new Set([...v.tags, t])] }));
            }}
          >
            + Tag
          </button>
          <button className="link small" onClick={() => setChecked(new Set())}>
            Clear
          </button>
        </div>
      )}

      <ul>
        {shown.map((v) => {
          const count = Object.keys(v.id === selectedId ? overrides : v.overrides).length;
          const pt =
            v.playtest?.revision === v.revision &&
            v.playtest?.releaseId === (v.pinnedReleaseId ?? v.baseReleaseId ?? latestReleaseId)
              ? v.playtest
              : null;
          return (
            <li key={v.id} className={v.id === selectedId ? "active" : ""}>
              <input
                type="checkbox"
                checked={checked.has(v.id)}
                onChange={() => toggle(v.id)}
                aria-label={`Select ${v.name}`}
              />
              <button
                className={`variant${v.id === selectedId ? " active" : ""}`}
                onClick={act(async () => v.id !== selectedId && onSelect(v.id))}
              >
                <VariantThumb id={v.id} at={v.thumbAt} />
                <span className="variant-main">
                <span className="variant-title">
                  <span className="variant-name">{v.name}</span>
                  <span className={`status status-${v.status}`}>{statusLabel(v.status)}</span>
                </span>
                  {v.tags.length > 0 && <span className="tags">{v.tags.map((t) => `#${t}`).join(" ")}</span>}
                  <span className="muted small">
                    {count ? `${count} ${count === 1 ? "change" : "changes"}` : "Default"} ·{" "}
                    {v.updatedBy ? `${v.updatedBy}, ` : ""}
                    {formatDate(v.updatedAt)}
                  </span>
                  <span className="variant-flags small">
                    {v.pinnedReleaseId && <span title="Pinned release">📌 r{releaseNumber(v.pinnedReleaseId)}</span>}
                    {needsCheck(v) && (
                      <span className="warn" title={`Last checked on r${releaseNumber(v.baseReleaseId)}`}>
                        New release — check
                      </span>
                    )}
                    {pt?.winRate !== undefined && (
                      <span
                        title={`${pt.runs} bot games on r${releaseNumber(pt.releaseId) ?? "?"}, rev ${pt.revision}`}
                      >
                        🤖 {pt.label} · {pt.winRate}% wins
                      </span>
                    )}
                    {pt?.check === "error" && (
                      <span className="bad" title={pt.error}>
                        ✗ Error in check
                      </span>
                    )}
                  </span>
                </span>
              </button>
              <span className="variant-icons">
                <button
                  type="button"
                  className="icon-btn"
                  title="Duplicate"
                  aria-label={`Duplicate ${v.name}`}
                  onClick={() => setForm({ mode: "copy", variant: v })}
                >
                  <Icon name="copy" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Edit details"
                  aria-label={`Edit ${v.name}`}
                  onClick={() => setForm({ mode: "edit", variant: v })}
                >
                  <Icon name="edit" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Download JSON"
                  aria-label={`Download ${v.name}`}
                  onClick={() => exportJson(v)}
                >
                  <Icon name="download" />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title="Delete"
                  aria-label={`Delete ${v.name}`}
                  disabled={variants.length < 2}
                  onClick={() => remove(v)}
                >
                  <Icon name="trash" />
                </button>
              </span>
            </li>
          );
        })}
        {shown.length === 0 && <li className="muted pad">No variant matches.</li>}
      </ul>

      {trash && (
        <div className="pad">
          <strong>Trash</strong>
          <button className="link" onClick={() => setTrash(null)}>
            Close
          </button>
          {trash.length === 0 && <p className="muted">Trash is empty.</p>}
          {trash.map((v) => (
            <div key={v.id}>
              {v.name}{" "}
              <button
                className="small"
                onClick={act(async () => {
                  await api.restoreDeleted(gameId, v.id);
                  setTrash(await api.trash(gameId));
                  await onChanged(v.id);
                })}
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
      {form && (
        <VariantForm
          form={form}
          allTags={allTags}
          onClose={() => setForm(null)}
          onSubmit={act(async ({ name, tags, status: st }) => {
            if (form.mode === "edit") {
              await api.patchVariant(form.variant.id, { baseRevision: form.variant.revision, name, tags, status: st });
              onChanged();
            } else {
              const body = { name, tags, status: st, ...(form.mode === "copy" && { copyFrom: form.variant.id }) };
              onChanged((await api.createVariant(gameId, body)).id);
            }
            setForm(null);
          })}
        />
      )}
    </nav>
  );
}

function VariantForm({ form, allTags, onSubmit, onClose }) {
  const v = form.variant;
  const [name, setName] = useState(form.mode === "copy" ? `${v.name} copy` : (v?.name ?? ""));
  const [tags, setTags] = useState(v?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [status, setStatus] = useState(form.mode === "edit" ? v.status : "draft");
  const title = { new: "New variant", copy: `Duplicate “${v?.name}”`, edit: "Variant details" }[form.mode];

  const addTag = (t) => {
    const clean = t.trim().replace(/^#/, "");
    if (clean && !tags.includes(clean)) setTags([...tags, clean]);
    setTagInput("");
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (tagInput.trim()) addTag(tagInput);
          if (name.trim())
            onSubmit({ name: name.trim(), tags: tagInput.trim() ? [...tags, tagInput.trim()] : tags, status });
        }}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <header>
          <strong>{title}</strong>
          <button type="button" className="link" onClick={onClose}>
            ✕
          </button>
        </header>
        <label className="stack">
          Name
          <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="stack">
          Tags <span className="muted small">(campaign, network, theme…)</span>
          <span className="tag-input">
            {tags.map((t) => (
              <span key={t} className="chip tag on">
                #{t}
                <button type="button" className="link" onClick={() => setTags(tags.filter((x) => x !== t))}>
                  ×
                </button>
              </span>
            ))}
            <input
              list="variant-tags"
              value={tagInput}
              placeholder="Add tag, Enter"
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTag(tagInput);
                }
              }}
            />
            <datalist id="variant-tags">
              {allTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </span>
        </label>
        <label className="stack">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={!name.trim()}>
            {form.mode === "edit" ? "Save" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}
