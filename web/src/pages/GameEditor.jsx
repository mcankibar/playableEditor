import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UserMenu } from "../auth.jsx";
import { api } from "../api.js";
import { gameHash, navigate } from "../App.jsx";
import { ReleaseDrop } from "./GameList.jsx";
import { FieldPanel } from "../components/FieldPanel.jsx";
import { Preview } from "../components/Preview.jsx";
import { ExportDialog } from "../components/ExportDialog.jsx";
import { VariantList } from "../components/VariantList.jsx";
import { collectLanguages, sanitizeOverrides } from "../../../shared/playable/kit/resolve.js";
import { formatDate } from "../format.js";

const SAVE_DELAY = 500;

export function GameEditor({ gameId, variantId }) {
  const [data, setData] = useState(null); // { game, releases, variants }
  const [releaseId, setReleaseId] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [uploads, setUploads] = useState({}); // asset id → data URI (uploaded files only)
  const [loadedVariant, setLoadedVariant] = useState(null); // id whose values + uploads are in state
  const [saveState, setSaveState] = useState("saved");
  const [extraLangs, setExtraLangs] = useState([]);
  const [previewLang, setPreviewLang] = useState("");
  // What was picked in the preview ({ componentId, related, assets }) and the component to outline.
  const [selection, setSelection] = useState(null);
  const [outline, setOutline] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      api.game(gameId).then((d) => {
        setData(d);
        setReleaseId((current) => (d.releases.some((r) => r.id === current) ? current : (d.releases[0]?.id ?? null)));
        return d;
      }),
    [gameId]
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  useEffect(() => {
    if (!releaseId) return;
    setManifest(null);
    api.manifest(releaseId).then(setManifest, (e) => setError(e.message));
  }, [releaseId]);

  const variant = data && (data.variants.find((v) => v.id === variantId) ?? data.variants[0]);

  // ── editing + autosave ─────────────────────────────────────────────────
  const timer = useRef(null);
  const latest = useRef({ id: null, overrides: {} });

  const save = useCallback(async (id, next) => {
    clearTimeout(timer.current);
    timer.current = null;
    setSaveState("saving");
    try {
      const saved = await api.updateVariant(id, { overrides: next });
      setData((d) => d && { ...d, variants: d.variants.map((v) => (v.id === saved.id ? saved : v)) });
      setSaveState((s) => (timer.current ? s : "saved"));
    } catch (e) {
      setSaveState("error");
      setError(`Save failed: ${e.message}`);
    }
  }, []);

  const flush = useCallback(() => {
    if (timer.current) save(latest.current.id, latest.current.overrides);
  }, [save]);

  useEffect(() => {
    if (!variant) return;
    setOverrides(variant.overrides);
    latest.current = { id: variant.id, overrides: variant.overrides };
    setSaveState("saved");
    setUploads({});
    setLoadedVariant(null);
    let current = true;
    api.variantUploads(variant.id).then(
      (u) => {
        if (!current) return;
        setUploads((cur) => ({ ...u, ...cur }));
        setLoadedVariant(variant.id);
      },
      (e) => setError(e.message)
    );
    return () => {
      current = false;
      flush();
    };
    // Only a variant switch resets the editor; server echoes of our own saves must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant?.id]);

  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [flush]);

  function changeOverrides(next) {
    setOverrides(next);
    latest.current = { id: variant.id, overrides: next };
    setSaveState("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(variant.id, next), SAVE_DELAY);
  }

  // ── derived ────────────────────────────────────────────────────────────
  const fields = useMemo(() => manifest?.fields.map((f) => ({ aliases: [], ...f })) ?? [], [manifest]);
  const check = useMemo(() => sanitizeOverrides(fields, overrides), [fields, overrides]);
  const languages = useMemo(() => {
    const langs = collectLanguages(fields, overrides);
    extraLangs.forEach((l) => langs.includes(l) || langs.push(l));
    return langs;
  }, [fields, overrides, extraLangs]);
  const languageField = fields.find((f) => f.type === "language");

  const previewOverrides = useMemo(() => {
    const out = { ...check.values };
    if (previewLang && languageField) out[languageField.path] = previewLang;
    return out;
  }, [check.values, previewLang, languageField]);
  const previewAssets = useMemo(() => {
    const out = {};
    Object.values(previewOverrides).forEach((v) => {
      if (typeof v === "string" && uploads[v]) out[v] = uploads[v];
    });
    return out;
  }, [previewOverrides, uploads]);

  if (error && !data) return <FullPageError message={error} />;
  if (!data) return <div className="page center muted">Loading…</div>;
  const release = data.releases.find((r) => r.id === releaseId);

  return (
    <div className="page editor">
      <header className="topbar">
        <a className="brand" href="#/">
          Playable Studio
        </a>
        <span className="crumb">/</span>
        <strong className="game-title">{data.game.title}</strong>
        <select
          className="release-select"
          value={releaseId ?? ""}
          onChange={(e) => setReleaseId(Number(e.target.value))}
          title="Release used for preview and export"
        >
          {data.releases.map((r, i) => (
            <option key={r.id} value={r.id}>
              r{r.number}
              {i === 0 ? " (latest)" : ""} · {formatDate(r.createdAt)}
              {r.notes ? ` · ${r.notes}` : ""}
            </option>
          ))}
        </select>
        <ReleaseDrop
          compact
          onUploaded={({ release: r, created }) => {
            load().then(() => setReleaseId(r.id));
            if (!created) setError(`This build is already uploaded (r${r.number}).`);
          }}
          onError={setError}
        />
        <span className="spacer" />
        <SaveBadge state={saveState} />
        <button className="primary" disabled={!manifest} onClick={() => setExporting(true)}>
          Export…
        </button>
        <UserMenu />
      </header>

      {error && (
        <div className="banner error" role="alert">
          {error}
          <button className="link" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}

      <div className="editor-body">
        <VariantList
          gameId={gameId}
          variants={data.variants}
          selectedId={variant.id}
          overrides={overrides}
          uploads={uploads}
          onSelect={(id) => navigate(gameHash(gameId, id))}
          onChanged={async (selectId) => {
            await load();
            if (selectId) navigate(gameHash(gameId, selectId));
          }}
          onError={setError}
          beforeChange={flush}
        />

        {manifest && loadedVariant === variant.id ? (
          <Preview
            key={`${variant.id}:${releaseId}`}
            releaseId={releaseId}
            overrides={previewOverrides}
            assets={previewAssets}
            languages={languageField ? ["", "auto", ...languages] : null}
            previewLang={previewLang}
            onPreviewLang={setPreviewLang}
            release={release}
            highlight={outline ?? selection?.componentId ?? null}
            onSelectComponent={setSelection}
          />
        ) : (
          <section className="preview" />
        )}

        {manifest ? (
          <FieldPanel
            fields={fields}
            overrides={overrides}
            check={check}
            releaseId={releaseId}
            uploads={uploads}
            languages={languages}
            onAddLanguage={(lang) => setExtraLangs((l) => [...l, lang])}
            onChange={changeOverrides}
            onUploaded={(id, dataUri) => setUploads((u) => ({ ...u, [id]: dataUri }))}
            onError={setError}
            selection={selection}
            onClearFocus={() => setSelection(null)}
            onHoverComponent={setOutline}
          />
        ) : (
          <aside className="fields center muted">Loading fields…</aside>
        )}
      </div>

      {exporting && (
        <ExportDialog
          variant={{ ...variant, overrides }}
          releases={data.releases}
          releaseId={releaseId}
          languages={languages}
          defaultLang={languageField ? (check.values[languageField.path] ?? languageField.default) : "auto"}
          beforeExport={() => (timer.current ? save(variant.id, latest.current.overrides) : null)}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}

function SaveBadge({ state }) {
  const text = { saved: "Saved", dirty: "Unsaved changes", saving: "Saving…", error: "Save failed" }[state];
  return <span className={`save-badge ${state}`}>{text}</span>;
}

function FullPageError({ message }) {
  return (
    <div className="page center">
      <p className="error">{message}</p>
      <a href="#/">← Games</a>
    </div>
  );
}
