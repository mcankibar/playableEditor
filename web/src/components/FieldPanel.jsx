import { useEffect, useMemo, useState } from "react";
import { api, assetUrl } from "../api.js";
import { formatBytes } from "../format.js";
import { ASSET_TYPES } from "../../../shared/playable/kit/fields.js";
import { normalizeValue, toLocalized } from "../../../shared/playable/kit/resolve.js";
import { detectMime, validateAsset } from "../../../shared/playable/kit/assets.js";

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

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Dosya okunamadı"));
    reader.readAsDataURL(file);
  });
}

export function FieldPanel({
  fields,
  overrides,
  check,
  releaseId,
  uploads,
  languages,
  onAddLanguage,
  onChange,
  onUploaded,
  onError
}) {
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [open, setOpen] = useState(() => new Set());

  const valueOf = (f) => (f.path in overrides ? overrides[f.path] : f.default);

  function set(field, value) {
    const result = normalizeValue(field, value);
    if (result.error) return onError(`${field.label}: ${result.error}`);
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
      const asset = await api.uploadAsset(file.name, base64);
      onUploaded(asset.id, `data:${asset.mime};base64,${base64}`);
      set(field, asset.id);
    } catch (e) {
      onError(`${field.label}: ${e.message}`);
    }
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map();
    for (const f of fields) {
      if (changedOnly && !(f.path in overrides)) continue;
      if (q && !`${f.label} ${f.path} ${f.group}`.toLowerCase().includes(q)) continue;
      if (!map.has(f.group)) map.set(f.group, []);
      map.get(f.group).push(f);
    }
    return [...map];
  }, [fields, overrides, query, changedOnly]);

  const byPath = useMemo(() => new Map(fields.map((f) => [f.path, f])), [fields]);
  const disabled = (f) => {
    const flag = f.enabledBy && byPath.get(f.enabledBy);
    return !!flag && valueOf(flag) === false;
  };
  const changedCount = Object.keys(overrides).filter((p) => byPath.has(p)).length;
  const expandAll = !!query.trim() || changedOnly;

  const toggle = (name) =>
    setOpen((s) => {
      const next = new Set(s);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  return (
    <aside className="fields">
      <div className="fields-head">
        <input
          type="search"
          placeholder={`${fields.length} alanda ara…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="fields-tools">
          <label className="inline">
            <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
            Sadece değişenler ({changedCount})
          </label>
          <button
            className="small"
            onClick={() => {
              const lang = (window.prompt("Dil kodu (ör. tr, de, pt-br):") || "").trim().toLowerCase();
              if (!lang) return;
              if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(lang)) return onError(`Geçersiz dil kodu: ${lang}`);
              if (!languages.includes(lang)) onAddLanguage(lang);
            }}
          >
            + Dil
          </button>
        </div>
      </div>

      {(check.orphans.length > 0 || check.errors.length > 0) && (
        <div className="banner warn">
          {check.orphans.length > 0 && (
            <div>
              Bu release'te olmayan {check.orphans.length} alan (export'ta yok sayılır):
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
                Varyanttan temizle
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

      <div className="fields-body">
        {groups.length === 0 && <p className="muted center">Eşleşen alan yok.</p>}
        {groups.map(([name, list]) => {
          const changed = list.filter((f) => f.path in overrides).length;
          const isOpen = expandAll || open.has(name);
          return (
            <section key={name} className={`group${isOpen ? " open" : ""}`}>
              <button className="group-head" onClick={() => toggle(name)}>
                <span className="chev">{isOpen ? "▾" : "▸"}</span>
                {name}
                {changed > 0 && <span className="dot">{changed}</span>}
                <span className="muted small">{list.length}</span>
              </button>
              {isOpen &&
                list.map((f) => (
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
                ))}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function FieldRow({ field, value, changed, dimmed, languages, releaseId, uploads, onSet, onReset, onUpload }) {
  const isAsset = ASSET_TYPES.includes(field.type);
  return (
    <div className={`field${changed ? " changed" : ""}${dimmed ? " dimmed" : ""}`} title={field.path}>
      <div className="field-label">
        <span>
          {field.label}
          {isAsset && <span className="muted"> · {field.type}</span>}
          {restartsGame(field) && (
            <span className="restart" title="Değişince oyun baştan başlar">
              {" "}
              ↻
            </span>
          )}
        </span>
        {changed && (
          <button className="link" onClick={onReset} title="Varsayılana dön">
            ↺ varsayılan
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
          <span>{value ? "Açık" : "Kapalı"}</span>
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
      return <AssetControl field={field} value={value} releaseId={releaseId} uploads={uploads} onUpload={onUpload} />;
  }
}

function AssetControl({ field, value, releaseId, uploads, onUpload }) {
  const [busy, setBusy] = useState(false);
  const src = uploads[value] || assetUrl(releaseId, value);
  const name = value.startsWith("u/") ? "yüklenen dosya" : value.split("/").pop();
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
        {busy ? "…" : "Değiştir"}
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
