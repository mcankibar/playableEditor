import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, assetUrl } from "../api.js";
import { formatBytes } from "../format.js";
import { ASSET_TYPES } from "../../../shared/playable/kit/fields.js";
import { normalizeValue, toLocalized } from "../../../shared/playable/kit/resolve.js";
import { detectMime, validateAsset } from "../../../shared/playable/kit/assets.js";
import { BoardEditor } from "./BoardEditor.jsx";
import { AssetLibrary } from "./AssetLibrary.jsx";

// What the richer controls (board editor, asset library) need besides their own field.
const EditorContext = createContext({ gameId: null, fields: [], overrides: {} });

// Mirrors needsRestart in the template's playable/kit/runtime.js (for the ↻ hint only).
const restartsGame = (f) =>
  f.restart === true ||
  f.type === "language" ||
  /(^|\.)isEnabled$/.test(f.path) ||
  !!f.loader ||
  (ASSET_TYPES.includes(f.type) && f.type !== "image");

const ACCEPT = {
  image: ".png,.jpg,.jpeg,.webp,.gif",
  sound: ".mp3,.aac,.ogg,.wav,.m4a",
  model: ".glb,.zip",
  font: ".woff,.woff2,.ttf,.otf",
  data: ".json,.txt,.zip"
};

const toHex = (v) => (typeof v === "number" ? "#" + v.toString(16).padStart(6, "0") : String(v));
const same = (field, a, b) =>
  JSON.stringify(normalizeValue(field, a).value) === JSON.stringify(normalizeValue(field, b).value);

// Why a related component is listed next to the selected one (reasons come from the game runtime).
const REASONS = {
  parent: { label: "Part of", hint: "The selected part sits inside this one" },
  contains: { label: "Inside", hint: "This sits inside the selected part" },
  uses: { label: "Uses", hint: "The selected part uses this (for example its images or effects)" },
  below: { label: "Behind", hint: "Also under the point you clicked" }
};

// Files of an atlas() / spine() asset are numbered slots ("assets.gems.0"); name them by role.
const PARTS = {
  atlas: ["image (PNG)", "frame data (JSON)"],
  spine: ["texture (PNG)", "skeleton (JSON)", "atlas (text)"]
};
const fieldLabel = (f) => {
  const m = f.loader && /\.([^.]+)\.(\d+)$/.exec(f.path);
  const part = m && PARTS[f.loader]?.[Number(m[2])];
  return part ? `${m[1]} ${f.loader} — ${part}` : f.label;
};

/** "components.<id>.…" → id: the game component a field belongs to (what the preview can outline). */
export const componentOf = (path) => /^components\.([^.]+)\./.exec(path)?.[1] ?? null;

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Couldn't read the file"));
    reader.readAsDataURL(file);
  });
}

export function FieldPanel({
  gameId,
  fields,
  overrides,
  check,
  releaseId,
  uploads,
  languages,
  onAddLanguage,
  onChange,
  onUploaded,
  onError,
  selection = null,
  onClearFocus,
  onHoverComponent
}) {
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [open, setOpen] = useState(() => new Set());

  const valueOf = (f) => (f.path in overrides ? overrides[f.path] : f.default);

  function set(field, value) {
    const result = normalizeValue(field, value);
    if (result.error) return onError(`${fieldLabel(field)}: ${result.error}`);
    const next = { ...overrides };
    if (same(field, result.value, field.default)) delete next[field.path];
    else next[field.path] = result.value;
    onChange(next);
  }

  async function upload(field, file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = detectMime(bytes);
      const base64 = await readBase64(file);
      // Same check the exporter runs; the id only matters for zipped models (".zip").
      validateAsset(/\.zip$/i.test(file.name) ? "check.zip" : "check.bin", { mime, base64 }, field);
      const asset = await api.uploadAsset(file.name, base64, gameId);
      onUploaded(asset.id, `data:${asset.mime};base64,${base64}`);
      set(field, asset.id);
    } catch (e) {
      onError(`${fieldLabel(field)}: ${e.message}`);
    }
  }

  const q = query.trim().toLowerCase();
  const matches = (f) =>
    (!changedOnly || f.path in overrides) && (!q || `${fieldLabel(f)} ${f.path} ${f.group}`.toLowerCase().includes(q));

  /** [[groupName, fields]] of the given fields, in field order. */
  const groupList = (list) => {
    const map = new Map();
    for (const f of list) {
      if (!matches(f)) continue;
      if (!map.has(f.group)) map.set(f.group, []);
      map.get(f.group).push(f);
    }
    return [...map];
  };

  const byComponent = useMemo(() => {
    const map = new Map();
    for (const f of fields) {
      const id = componentOf(f.path);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(f);
    }
    return map;
  }, [fields]);

  const byPath = useMemo(() => new Map(fields.map((f) => [f.path, f])), [fields]);
  const disabled = (f) => {
    const flag = f.enabledBy && byPath.get(f.enabledBy);
    return !!flag && valueOf(flag) === false;
  };
  const changedCount = Object.keys(overrides).filter((p) => byPath.has(p)).length;
  const searching = !!q || changedOnly;

  // Selection mode: what was clicked (its image fields), the selected part, then related parts.
  const focus = selection?.componentId ?? null;
  const focusLabel = focus && byComponent.get(focus)?.[0]?.group;
  const clickedAssets = (selection?.assets ?? []).filter((a) => byPath.has(a.path) && matches(byPath.get(a.path)));
  const frames = [...new Set(clickedAssets.map((a) => a.frame).filter(Boolean))];
  const selectedGroups = focus ? groupList(byComponent.get(focus) ?? []) : [];
  const relatedGroups = focus
    ? (selection.related ?? []).flatMap(({ componentId, reason }) =>
        groupList(byComponent.get(componentId) ?? []).map(([name, list]) => [name, list, reason])
      )
    : [];
  const allGroups = focus ? [] : groupList(fields);
  const nothing = focus ? !clickedAssets.length && !selectedGroups.length && !relatedGroups.length : !allGroups.length;

  // A new selection starts at the top of its fields.
  const body = useRef(null);
  useEffect(() => {
    if (focus && body.current) body.current.scrollTop = 0;
  }, [selection]);

  function renderRow(f) {
    return (
      <FieldRow
        key={f.path}
        field={f}
        value={valueOf(f)}
        changed={f.path in overrides}
        dimmed={disabled(f)}
        languages={languages}
        releaseId={releaseId}
        uploads={uploads}
        onSet={(v) => set(f, v)}
        onReset={() => set(f, f.default)}
        onUpload={(file) => upload(f, file)}
      />
    );
  }

  function renderGroup(name, list, { forceOpen = false, reason = null } = {}) {
    const changed = list.filter((f) => f.path in overrides).length;
    const isOpen = forceOpen || searching || open.has(name);
    const why = reason && REASONS[reason];
    return (
      <section key={name} className={`group${isOpen ? " open" : ""}`}>
        <button
          className="group-head"
          onClick={() => toggle(name)}
          onMouseEnter={() => onHoverComponent?.(componentOf(list[0].path))}
        >
          <span className="chev">{isOpen ? "▾" : "▸"}</span>
          {why && (
            <span className="reason" title={why.hint}>
              {why.label}
            </span>
          )}
          {name}
          {changed > 0 && <span className="dot">{changed}</span>}
          <span className="muted small">{list.length}</span>
        </button>
        {isOpen && list.map(renderRow)}
      </section>
    );
  }

  const toggle = (name) =>
    setOpen((s) => {
      const next = new Set(s);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  return (
    <EditorContext.Provider value={{ gameId, fields, overrides }}>
      <aside className="fields">
        <div className="fields-head">
          <input
            type="search"
            placeholder={`Search ${fields.length} ${fields.length === 1 ? "field" : "fields"}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="fields-tools">
            <label className="inline">
              <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
              Changed only ({changedCount})
            </label>
            <button
              className="small"
              onClick={() => {
                const lang = (window.prompt("Language code (e.g. tr, de, pt-br):") || "").trim().toLowerCase();
                if (!lang) return;
                if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(lang)) return onError(`Invalid language code: ${lang}`);
                if (!languages.includes(lang)) onAddLanguage(lang);
              }}
            >
              + Language
            </button>
          </div>
        </div>

        {(check.orphans.length > 0 || check.errors.length > 0) && (
          <div className="banner warn">
            {check.orphans.length > 0 && (
              <div>
                {check.orphans.length} {check.orphans.length === 1 ? "field" : "fields"} not in this release (ignored on
                export):
                <ul>
                  {check.orphans.map((p) => (
                    <li key={p} className="mono">
                      {p}
                    </li>
                  ))}
                </ul>
                <button
                  className="small"
                  onClick={() => {
                    const next = { ...overrides };
                    check.orphans.forEach((p) => delete next[p]);
                    onChange(next);
                  }}
                >
                  Remove from variant
                </button>
              </div>
            )}
            {check.errors.map((e) => (
              <div key={e} className="mono">
                {e}
              </div>
            ))}
          </div>
        )}

        {focus && (
          <div className="focus-bar">
            <span>
              <span className="muted small">Selected</span>
              <strong>{focusLabel || focus}</strong>
            </span>
            <button className="small" onClick={onClearFocus}>
              Show all
            </button>
          </div>
        )}

        <div className="fields-body" ref={body} onMouseLeave={() => onHoverComponent?.(null)}>
          {nothing && <p className="muted center">No matching fields.</p>}

          {clickedAssets.length > 0 && (
            <section className="group open clicked">
              <div className="section-title">
                What you clicked
                {frames.length > 0 && (
                  <span className="muted small" title="The image is one frame of an atlas: edit the atlas files below">
                    {" "}
                    · frame {frames.join(", ")}
                  </span>
                )}
              </div>
              {clickedAssets.map(({ path }) => renderRow(byPath.get(path)))}
            </section>
          )}

          {(focus ? selectedGroups : allGroups).map(([name, list]) => renderGroup(name, list, { forceOpen: !!focus }))}

          {relatedGroups.length > 0 && (
            <>
              <div className="section-title related-title">Related</div>
              {relatedGroups.map(([name, list, reason]) => renderGroup(name, list, { reason }))}
            </>
          )}
        </div>
      </aside>
    </EditorContext.Provider>
  );
}

function FieldRow({ field, value, changed, dimmed, languages, releaseId, uploads, onSet, onReset, onUpload }) {
  const isAsset = ASSET_TYPES.includes(field.type);
  return (
    <div className={`field${changed ? " changed" : ""}${dimmed ? " dimmed" : ""}`} title={field.path}>
      <div className="field-label">
        <span>
          {fieldLabel(field)}
          {isAsset && !field.loader && <span className="muted"> · {field.type}</span>}
          {restartsGame(field) && (
            <span className="restart" title="Changing this restarts the game">
              {" "}
              ↻
            </span>
          )}
        </span>
        {changed && (
          <button className="link" onClick={onReset} title="Reset to default">
            ↺ Default
          </button>
        )}
      </div>
      {field.hint && <div className="hint">{field.hint}</div>}
      <Control
        field={field}
        value={value}
        languages={languages}
        releaseId={releaseId}
        uploads={uploads}
        onSet={onSet}
        onUpload={onUpload}
      />
    </div>
  );
}

function Control({ field, value, languages, releaseId, uploads, onSet, onUpload }) {
  switch (field.type) {
    case "number":
      return <NumberControl field={field} value={value} onSet={onSet} />;
    case "boolean":
      return (
        <label className="switch">
          <input type="checkbox" checked={!!value} onChange={(e) => onSet(e.target.checked)} />
          <span>{value ? "On" : "Off"}</span>
        </label>
      );
    case "color":
      return (
        <div className="ctl">
          <input type="color" value={toHex(value)} onChange={(e) => onSet(e.target.value)} />
          <TextInput value={toHex(value)} onCommit={onSet} className="mono" />
        </div>
      );
    case "select":
    case "language": {
      const options = field.type === "language" ? ["auto", ...languages] : field.options;
      return (
        <select value={value} onChange={(e) => onSet(e.target.value)}>
          {options.map((o) => (
            <option key={String(o)} value={o}>
              {String(o)}
            </option>
          ))}
        </select>
      );
    }
    case "text": {
      if (field.editor?.type === "board")
        return <BoardControl field={field} value={value} releaseId={releaseId} uploads={uploads} onSet={onSet} />;
      if (!field.localized) return <TextInput value={value} onCommit={onSet} />;
      const map = toLocalized(value);
      return (
        <div className="loc">
          {languages.map((lang) => (
            <div className="ctl" key={lang}>
              <span className="lang">{lang}</span>
              <TextInput
                value={map[lang] ?? ""}
                placeholder={lang === "en" ? "" : map.en}
                onCommit={(text) => {
                  const next = { ...map, [lang]: text };
                  if (lang !== "en" && !text) delete next[lang];
                  onSet(next);
                }}
              />
            </div>
          ))}
        </div>
      );
    }
    default:
      return (
        <AssetControl
          field={field}
          value={value}
          releaseId={releaseId}
          uploads={uploads}
          onUpload={onUpload}
          onSet={onSet}
        />
      );
  }
}

function BoardControl({ field, value, releaseId, uploads, onSet }) {
  const { fields, overrides } = useContext(EditorContext);
  return (
    <BoardEditor
      field={field}
      value={value}
      onChange={onSet}
      fields={fields}
      overrides={overrides}
      releaseId={releaseId}
      uploads={uploads}
    />
  );
}

function AssetControl({ field, value, releaseId, uploads, onUpload, onSet }) {
  const { gameId } = useContext(EditorContext);
  const [busy, setBusy] = useState(false);
  const [library, setLibrary] = useState(false);
  const src = uploads[value] || assetUrl(releaseId, value);
  const name = value.startsWith("u/") ? "uploaded file" : value.split("/").pop();
  const size = uploads[value]
    ? formatBytes(Math.floor(((uploads[value].length - uploads[value].indexOf(",") - 1) * 3) / 4))
    : null;
  return (
    <div className="ctl asset">
      {field.type === "image" ? (
        <img className="thumb" src={src} alt="" />
      ) : (
        <span className="thumb icon">{field.type}</span>
      )}
      <span className="asset-name" title={value}>
        {name}
        {size && <span className="muted small"> · {size}</span>}
      </span>
      <label className={`button small${busy ? " disabled" : ""}`}>
        {busy ? "…" : "Replace"}
        <input
          type="file"
          hidden
          accept={ACCEPT[field.type]}
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files[0];
            e.target.value = "";
            if (!file) return;
            setBusy(true);
            await onUpload(file);
            setBusy(false);
          }}
        />
      </label>
      {gameId && (
        <button className="small" onClick={() => setLibrary(true)} title="Use a file already uploaded for this game">
          Library
        </button>
      )}
      {library && (
        <AssetLibrary
          gameId={gameId}
          field={field}
          onPick={(asset) => onSet(asset.id)}
          onClose={() => setLibrary(false)}
        />
      )}
    </div>
  );
}

function NumberControl({ field, value, onSet }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const hasRange = typeof field.min === "number" && typeof field.max === "number";
  const step = field.step ?? "any";
  return (
    <div className="ctl">
      {hasRange && (
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={step}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onSet(Number(e.target.value));
          }}
        />
      )}
      <input
        type="number"
        className={hasRange ? "num small-num" : "num"}
        step={step}
        min={field.min}
        max={field.max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== "" && Number(draft) !== value && onSet(Number(draft))}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </div>
  );
}

function TextInput({ value, onCommit, ...rest }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="text"
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}
