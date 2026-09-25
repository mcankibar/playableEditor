import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { normalizeValue } from "../../../shared/playable/kit/resolve.js";

export function RecipesDialog({ gameId, variant, release, manifest, onClose, onCreated }) {
  const [name, setName] = useState("Experiment");
  const [axes, setAxes] = useState([]);
  const [saved, setSaved] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef(null);
  const context = { baseVariantId: variant.id, baseRevision: variant.revision, releaseId: release.id };
  useEffect(() => {
    let active = true;
    api.recipes(gameId).then(
      (v) => active && setSaved(v),
      (e) => active && setError(e.message)
    );
    return () => {
      active = false;
    };
  }, [gameId]);
  function changed() {
    setPreview(null);
    request.current = null;
    setNotice("");
  }
  function load(recipe) {
    changed();
    setName(recipe.name);
    setAxes(recipe.axes.map((a) => ({ path: a.path, text: JSON.stringify(a.values) })));
  }
  const recipe = () => ({ name, axes: axes.map((a) => ({ path: a.path, values: JSON.parse(a.text) })) });
  async function act(fn) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function generate() {
    const definition = recipe();
    // getRandomValues also works on HTTP LAN deployments, unlike randomUUID.
    request.current ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
    const result = await api.recipeAction(gameId, "generate", {
      ...context,
      recipe: definition,
      requestId: request.current
    });
    await onCreated(result.variantIds);
    onClose();
  }
  return (
    <div className="modal-backdrop">
      <div className="modal wide recipes-dialog" role="dialog" aria-modal="true" aria-label="Variation recipes">
        <div className="experiment-toolbar">
          <h2>Variation recipes</h2>
          <span className="spacer" />
          <button disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
        <p>
          Base: <strong>{variant.name}</strong> · revision {variant.revision} · r{release.number}. Each combination
          creates a new draft pinned to this release.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <fieldset disabled={busy}>
          <label>
            Saved recipe{" "}
            <select
              defaultValue=""
              onChange={(e) => {
                const r = saved.find((r) => r.id === Number(e.target.value));
                if (r) load(r);
              }}
            >
              <option value="">Choose…</option>
              {saved.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.createdBy}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name{" "}
            <input
              maxLength={60}
              value={name}
              onChange={(e) => {
                changed();
                setName(e.target.value);
              }}
            />
          </label>
          <p className="muted">
            Add fields and their alternatives. Every combination becomes a draft (maximum 100). Asset fields accept IDs
            from this release or the asset library.
          </p>
          {axes.map((axis, i) => (
            <div className="recipe-axis" key={i}>
              <select
                aria-label={`Field ${i + 1}`}
                value={axis.path}
                onChange={(e) => {
                  changed();
                  const field = manifest.fields.find((f) => f.path === e.target.value);
                  setAxes(
                    axes.map((a, j) =>
                      j === i
                        ? { path: field.path, text: JSON.stringify([variant.overrides[field.path] ?? field.default]) }
                        : a
                    )
                  );
                }}
              >
                {manifest.fields.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.group ? f.group + " / " : ""}
                    {f.label || f.path} · {f.type}
                  </option>
                ))}
              </select>
              <ValueAlternatives
                field={manifest.fields.find((f) => f.path === axis.path)}
                text={axis.text}
                index={i + 1}
                assets={manifest.assets}
                onChange={(text) => {
                  changed();
                  setAxes(axes.map((a, j) => (j === i ? { ...a, text } : a)));
                }}
              />
              <button
                aria-label={`Remove field ${i + 1}`}
                onClick={() => {
                  changed();
                  setAxes(axes.filter((_, j) => j !== i));
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="experiment-toolbar">
            <button
              disabled={axes.length >= 6 || axes.length >= manifest.fields.length}
              onClick={() => {
                changed();
                const f = manifest.fields.find((f) => !axes.some((a) => a.path === f.path));
                setAxes([...axes, { path: f.path, text: JSON.stringify([variant.overrides[f.path] ?? f.default]) }]);
              }}
            >
              + Field
            </button>
            <button
              disabled={!axes.length}
              onClick={() =>
                act(async () => setPreview(await api.recipeAction(gameId, "preview", { ...context, recipe: recipe() })))
              }
            >
              Preview combinations
            </button>
            <button
              disabled={!axes.length}
              onClick={() =>
                act(async () => {
                  await api.recipeAction(gameId, "", { ...context, recipe: recipe() });
                  setSaved(await api.recipes(gameId));
                  setNotice("Recipe saved for the team.");
                })
              }
            >
              Save recipe
            </button>
          </div>
        </fieldset>
        {busy && <p role="status">Working…</p>}
        {preview && (
          <>
            <h3>{preview.length} drafts ready</h3>
            <div className="recipe-results">
              {preview.map((v) => (
                <div key={v.name}>
                  <strong>{v.name}</strong>
                  <code>{JSON.stringify(v.changes)}</code>
                </div>
              ))}
            </div>
            <button className="primary" disabled={busy} onClick={() => act(generate)}>
              Create {preview.length} drafts
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ValueAlternatives({ field, text, index, assets, onChange }) {
  let values;
  try {
    values = JSON.parse(text);
  } catch {
    values = null;
  }
  if (!field || !Array.isArray(values) || field.localized)
    return (
      <textarea
        aria-label={`Values ${index}`}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder='["First", "Second"]'
      />
    );
  const set = (i, value) => onChange(JSON.stringify(values.map((v, j) => (i === j ? value : v))));
  return (
    <div className="recipe-values">
      {values.map((value, i) => (
        <div className="experiment-toolbar" key={i}>
          {field.type === "boolean" ? (
            <select
              aria-label={`Alternative ${index}.${i + 1}`}
              value={String(value)}
              onChange={(e) => set(i, e.target.value === "true")}
            >
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          ) : field.type === "select" ? (
            <select aria-label={`Alternative ${index}.${i + 1}`} value={value} onChange={(e) => set(i, e.target.value)}>
              {field.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              aria-label={`Alternative ${index}.${i + 1}`}
              type={field.type === "number" ? "number" : field.type === "color" ? "color" : "text"}
              min={field.min}
              max={field.max}
              step={field.step ?? "any"}
              value={field.type === "color" ? (normalizeValue(field, value).value ?? "#000000") : (value ?? "")}
              list={`recipe-assets-${index}`}
              onChange={(e) =>
                set(
                  i,
                  field.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value
                )
              }
            />
          )}
          <button
            aria-label={`Remove alternative ${index}.${i + 1}`}
            disabled={values.length < 2}
            onClick={() => onChange(JSON.stringify(values.filter((_, j) => j !== i)))}
          >
            ×
          </button>
        </div>
      ))}
      <datalist id={`recipe-assets-${index}`}>
        {Object.entries(assets ?? {})
          .filter(([, a]) => a.type === field.type)
          .map(([id]) => (
            <option key={id} value={id} />
          ))}
      </datalist>
      <button disabled={values.length >= 20} onClick={() => onChange(JSON.stringify([...values, field.default]))}>
        + Alternative
      </button>
      <details>
        <summary>JSON values</summary>
        <textarea aria-label={`Values ${index}`} value={text} onChange={(e) => onChange(e.target.value)} />
      </details>
    </div>
  );
}
