import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UserMenu } from "../auth.jsx";
import { api, assetDataUri } from "../api.js";
import { gameHash, navigate } from "../App.jsx";
import { ReleaseDrop } from "./GameList.jsx";
import { useVariantSync } from "./useVariantSync.js";
import { FieldPanel } from "../components/FieldPanel.jsx";
import { CompareDialog } from "../components/CompareDialog.jsx";
import { RecipesDialog } from "../components/RecipesDialog.jsx";
import { Preview } from "../components/Preview.jsx";
import { ExportDialog } from "../components/ExportDialog.jsx";
import { VariantList } from "../components/VariantList.jsx";
import { ConflictDialog } from "../components/ConflictDialog.jsx";
import { HistoryPanel } from "../components/HistoryPanel.jsx";
import { ExportsPanel } from "../components/ExportsPanel.jsx";
import { ReleasesDialog } from "../components/ReleasesDialog.jsx";
import { SizeMeter } from "../components/SizeMeter.jsx";
import { Playtest } from "../components/Playtest.jsx";
import { collectLanguages, sanitizeOverrides } from "../../../shared/playable/kit/resolve.js";
import { formatDate } from "../format.js";

const PANE_KEY = "pl-panes";
const clamp = (n, min, max) => Math.min(max, Math.max(min, Math.round(n)));

function readPanes() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANE_KEY));
    return { left: clamp(saved?.left ?? 220, 180, 560), right: clamp(saved?.right ?? 380, 280, 760) };
  } catch {
    return { left: 220, right: 380 };
  }
}

// Other people's edits show up within this time.
const POLL_MS = 8000;

export function GameEditor({ gameId, variantId }) {
  const [data, setData] = useState(null); // { game, releases, variants }
  const [releaseId, setReleaseId] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [uploads, setUploads] = useState({}); // asset id → data URI (uploaded files only)
  const [loadedVariant, setLoadedVariant] = useState(null); // id whose uploads are in state
  const [extraLangs, setExtraLangs] = useState([]);
  const [previewLang, setPreviewLang] = useState("");
  // What was picked in the preview ({ componentId, related, assets }) and the component to outline.
  const [selection, setSelection] = useState(null);
  const [outline, setOutline] = useState(null);
  const [dialog, setDialog] = useState(null); // { type: "export" | "releases" | "playtest", ... }
  const [drawer, setDrawer] = useState(null); // "history" | "exports"
  const [panes, setPanes] = useState(readPanes);
  const [error, setError] = useState("");
  const thumbSent = useRef("");

  const load = useCallback(
    () =>
      api.game(gameId).then((d) => {
        setData(d);
        return d;
      }),
    [gameId]
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  const variant = data && (data.variants.find((v) => v.id === variantId) ?? data.variants[0]);
  const latest = data?.releases[0];

  // Keep variants on their saved release; promotion to a newer build is explicit.
  useEffect(() => {
    if (!data || !variant) return;
    setReleaseId(variant.pinnedReleaseId ?? variant.baseReleaseId ?? latest?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant?.id, variant?.pinnedReleaseId, variant?.baseReleaseId, latest?.id]);

  useEffect(() => {
    if (!releaseId) return;
    setManifest(null);
    let alive = true;
    api.manifest(releaseId).then(
      (m) => alive && setManifest(m),
      (e) => alive && setError(e.message)
    );
    return () => {
      alive = false;
    };
  }, [releaseId]);

  const replaceVariant = useCallback(
    (saved) => setData((d) => d && { ...d, variants: d.variants.map((v) => (v.id === saved.id ? saved : v)) }),
    []
  );
  const sync = useVariantSync({ variant, releaseId, onSaved: replaceVariant, onError: setError });
  const overrides = sync.overrides;

  useEffect(() => {
    try {
      localStorage.setItem(PANE_KEY, JSON.stringify(panes));
    } catch {}
  }, [panes]);

  useEffect(() => {
    thumbSent.current = "";
  }, [variant?.id]);

  const onThumbnail = useCallback(
    (dataUrl) => {
      if (!variant || dataUrl === thumbSent.current) return;
      thumbSent.current = dataUrl;
      const id = variant.id;
      api.saveThumbnail(id, dataUrl).then(
        ({ thumbAt }) =>
          setData((d) => d && { ...d, variants: d.variants.map((v) => (v.id === id ? { ...v, thumbAt } : v)) }),
        (e) => {
          thumbSent.current = "";
          setError(e.message);
        }
      );
    },
    [variant]
  );

  useEffect(() => {
    if (!variant) return;
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
    };
  }, [variant?.id]);

  // Uploaded files the values point at but the editor doesn't have yet — picked from the library,
  // set by someone else, or brought back from the history — are fetched for the preview.
  const fetching = useRef(new Set());
  useEffect(() => {
    if (!variant || loadedVariant !== variant.id) return;
    const missing = new Set(
      Object.values(overrides).filter(
        (v) => typeof v === "string" && v.startsWith("u/") && !uploads[v] && !fetching.current.has(v)
      )
    );
    for (const id of missing) {
      fetching.current.add(id);
      assetDataUri(id)
        .then(
          (uri) => setUploads((u) => ({ ...u, [id]: uri })),
          (e) => setError(`Couldn't load an uploaded file: ${e.message}`)
        )
        .finally(() => fetching.current.delete(id));
    }
  }, [overrides, uploads, loadedVariant, variant?.id]);

  // Poll: new variants, renames and other people's edits of this variant.
  const syncRef = useRef(sync);
  syncRef.current = sync;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      api.game(gameId).then(
        (d) => {
          const s = syncRef.current;
          const server = d.variants.find((v) => v.id === variant?.id);
          // The edited variant is replaced only by a newer revision than the editor's.
          setData((cur) => ({
            ...d,
            variants: d.variants.map((v) =>
              v.id === server?.id && server.revision <= s.revision ? (cur?.variants.find((c) => c.id === v.id) ?? v) : v
            )
          }));
          s.applyRemote(server);
        },
        () => {}
      );
    };
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [gameId, variant?.id]);

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
  const usedUploads = useCallback(
    (values) => {
      const out = {};
      Object.values(values).forEach((v) => {
        if (typeof v === "string" && uploads[v]) out[v] = uploads[v];
      });
      return out;
    },
    [uploads]
  );
  const previewAssets = useMemo(() => usedUploads(previewOverrides), [previewOverrides, usedUploads]);

  if (error && !data) return <FullPageError message={error} />;
  if (!data) return <div className="page center muted">Loading…</div>;
  const release = data.releases.find((r) => r.id === releaseId);
  const beforeExport = async () => {
    if (!(await sync.flush())) throw new Error("Some changes aren't saved yet — resolve the save problem first.");
    return sync.revision;
  };
  // Other variants' uploaded files are fetched first; the open one uses what is on screen.
  const openPlaytest = async (list, testReleaseId = releaseId) => {
    try {
      await sync.flush();
      const variants = await Promise.all(
        list.map((v) => api.playtestSnapshot(v.id, testReleaseId, v.id === variant.id ? sync.revision : v.revision))
      );
      setDialog({ type: "playtest", variants, releaseId: testReleaseId });
    } catch (e) {
      setError(e.message);
    }
  };

  async function openCompare(ids) {
    try {
      await sync.flush();
      const snapshots = await Promise.all(
        ids.map((id) => {
          const v = data.variants.find((v) => v.id === id);
          return api.playtestSnapshot(id, releaseId, id === variant.id ? sync.revision : v.revision);
        })
      );
      setDialog({ type: "compare", variants: snapshots, release, manifest });
    } catch (e) {
      setError(e.message);
    }
  }
  async function openRecipes() {
    try {
      await sync.flush();
      const snapshot = await api.playtestSnapshot(variant.id, releaseId, sync.revision);
      setDialog({ type: "recipes", variant: snapshot, release, manifest });
    } catch (e) {
      setError(e.message);
    }
  }

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
              {i === 0 ? " (latest)" : ""}
              {r.id === variant.pinnedReleaseId ? " · pinned" : ""} · {formatDate(r.createdAt)}
              {r.notes ? ` · ${r.notes}` : ""}
            </option>
          ))}
        </select>
        <button
          className="small"
          onClick={() => setDialog({ type: "releases" })}
          title="Upload, pin or delete releases"
        >
          Releases
        </button>
        <span className="spacer" />
        <SizeMeter releaseId={releaseId} overrides={check.values} />
        <SaveBadge state={sync.state} variant={variant} />
        <button
          className={`small${drawer === "history" ? " active" : ""}`}
          onClick={() => setDrawer(drawer === "history" ? null : "history")}
        >
          History
        </button>
        <button
          className={`small${drawer === "exports" ? " active" : ""}`}
          onClick={() => setDrawer(drawer === "exports" ? null : "exports")}
        >
          Exports
        </button>
        <button
          className="small"
          disabled={!release}
          onClick={() => openPlaytest([variant])}
          title="Let a bot play this variant"
        >
          Playtest
        </button>
        <button
          className="primary"
          disabled={!manifest}
          onClick={() => setDialog({ type: "export", variantIds: [variant.id] })}
        >
          Export…
        </button>
        <button disabled={!manifest} onClick={openRecipes}>
          Recipes
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
      {variant.recipeOrigin && (
        <div className="banner info">
          Recipe: {variant.recipeOrigin.recipe.name} · source variant #{variant.recipeOrigin.baseVariantId}, revision{" "}
          {variant.recipeOrigin.baseRevision} · created by {variant.recipeOrigin.user}
        </div>
      )}
      <ReleaseBanner
        variant={variant}
        latest={latest}
        releases={data.releases}
        fields={fields}
        releaseId={releaseId}
        orphans={check.orphans}
        onPlaytest={() => openPlaytest([variant], latest.id)}
        onChecked={() =>
          api
            .patchVariant(variant.id, { baseRevision: variant.revision, baseReleaseId: latest.id })
            .then(replaceVariant, (e) => setError(e.message))
        }
      />

      <div className="editor-body" style={{ gridTemplateColumns: `${panes.left}px minmax(0, 1fr) ${panes.right}px` }}>
        <div className="pane-slot">
          <VariantList
            gameId={gameId}
            variants={data.variants}
            releases={data.releases}
            selectedId={variant.id}
            overrides={overrides}
            uploads={uploads}
            latestReleaseId={latest?.id}
            onCompare={openCompare}
            onSelect={(id) => navigate(gameHash(gameId, id))}
            onChanged={async (selectId) => {
              await load();
              if (selectId) navigate(gameHash(gameId, selectId));
            }}
            onError={setError}
            beforeChange={() => sync.flush()}
            onExport={(ids) => setDialog({ type: "export", variantIds: ids })}
            onPlaytest={(ids) => openPlaytest(data.variants.filter((v) => ids.includes(v.id)))}
          />
          <PaneResizer
            edge="right"
            label="Resize variants"
            onStart={() => panes}
            onDrag={(start, dx, total) =>
              setPanes({
                ...start,
                left: clamp(start.left + dx, 180, Math.min(560, total - start.right - 260))
              })
            }
          />
        </div>

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
            onThumbnail={onThumbnail}
          />
        ) : (
          <section className="preview" />
        )}

        <div className="pane-slot">
          <PaneResizer
            edge="left"
            label="Resize fields"
            onStart={() => panes}
            onDrag={(start, dx, total) =>
              setPanes({
                ...start,
                right: clamp(start.right - dx, 280, Math.min(760, total - start.left - 260))
              })
            }
          />
          {drawer === "history" ? (
            <HistoryPanel
              variant={variant}
              fields={fields}
              onRestore={async (revision) => {
                await sync.flush();
                const saved = await api.restore(variant.id, revision, sync.revision);
                replaceVariant(saved);
                sync.applyRemote(saved);
              }}
              onError={setError}
              onClose={() => setDrawer(null)}
            />
          ) : drawer === "exports" ? (
            <ExportsPanel gameId={gameId} onError={setError} onClose={() => setDrawer(null)} />
          ) : manifest ? (
            <FieldPanel
              gameId={gameId}
              fields={fields}
              overrides={overrides}
              check={check}
              releaseId={releaseId}
              uploads={uploads}
              languages={languages}
              onAddLanguage={(lang) => setExtraLangs((l) => [...l, lang])}
              onChange={sync.change}
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
      </div>

      {dialog?.type === "compare" && (
        <CompareDialog
          variants={dialog.variants}
          release={dialog.release}
          manifest={dialog.manifest}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "recipes" && (
        <RecipesDialog
          gameId={gameId}
          variant={dialog.variant}
          release={dialog.release}
          manifest={dialog.manifest}
          onClose={() => setDialog(null)}
          onCreated={async () => {
            await load();
          }}
        />
      )}
      {sync.conflict && <ConflictDialog conflict={sync.conflict} fields={fields} onResolve={sync.resolve} />}

      {dialog?.type === "export" && (
        <ExportDialog
          gameId={gameId}
          variants={data.variants
            .filter((v) => dialog.variantIds.includes(v.id))
            .map((v) => (v.id === variant.id ? { ...v, overrides } : v))}
          currentVariantId={variant.id}
          releases={data.releases}
          releaseId={dialog.variantIds.length === 1 ? releaseId : null}
          languages={languages}
          defaultLang={languageField ? (check.values[languageField.path] ?? languageField.default) : "auto"}
          beforeExport={beforeExport}
          onClose={() => setDialog(null)}
          onExported={() => drawer === "exports" && setDrawer("exports")}
        />
      )}
      {dialog?.type === "releases" && (
        <ReleasesDialog
          gameId={gameId}
          releases={data.releases}
          variant={variant}
          variants={data.variants}
          onChanged={async (pick) => {
            const d = await load();
            if (pick) setReleaseId(pick);
            return d;
          }}
          onPin={async (id) => replaceVariant(await api.patchVariant(variant.id, { pinnedReleaseId: id }))}
          onError={setError}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "playtest" && release && (
        <Playtest
          releaseId={dialog.releaseId}
          release={data.releases.find((r) => r.id === dialog.releaseId)}
          variants={dialog.variants.map((v) => ({
            id: v.id,
            name: v.name,
            revision: v.revision,
            snapshotHash: v.snapshotHash,
            overrides: v.overrides,
            uploads: v.uploads
          }))}
          onClose={() => setDialog(null)}
          onResult={async (id, result) => {
            try {
              replaceVariant(await api.savePlaytest(id, result));
            } catch (e) {
              setError(e.message);
            }
          }}
        />
      )}
    </div>
  );
}

/** A release newer than the one this variant was last edited or checked with. */
function ReleaseBanner({ variant, latest, releases, releaseId, orphans, onPlaytest, onChecked }) {
  if (!latest || variant.pinnedReleaseId) return null;
  const base = releases.find((r) => r.id === variant.baseReleaseId);
  if (!base || base.id >= latest.id) return null;
  return (
    <div className="banner info">
      <strong>r{latest.number} is new</strong> since this variant was last edited or checked (r{base.number}).
      {releaseId === latest.id && orphans.length > 0 && (
        <span title={orphans.join("\n")}>
          {" "}
          {orphans.length} changed {orphans.length === 1 ? "field doesn't" : "fields don't"} exist any more.
        </span>
      )}{" "}
      Check it on r{latest.number}, then mark it as checked.
      <span className="spacer" />
      <button className="small" onClick={onPlaytest}>
        Playtest
      </button>
      <button
        className="small"
        disabled={releaseId !== latest.id}
        onClick={onChecked}
        title="Preview the latest release before marking it checked"
      >
        Mark as checked
      </button>
    </div>
  );
}

function PaneResizer({ edge, label, onStart, onDrag }) {
  function down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.classList.add("dragging");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {}
    const start = onStart();
    const startX = e.clientX;
    const total = handle.closest(".editor-body").clientWidth;
    const move = (ev) => onDrag(start, ev.clientX - startX, total);
    const up = () => {
      handle.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  return (
    <div
      className={`pane-resizer ${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={down}
    />
  );
}

function SaveBadge({ state, variant }) {
  const text = {
    saved: "Saved",
    dirty: "Unsaved changes",
    saving: "Saving…",
    error: "Save failed",
    conflict: "Conflict"
  }[state];
  const by = variant.updatedBy ? ` by ${variant.updatedBy}` : "";
  return (
    <span
      className={`save-badge ${state}`}
      title={`Revision ${variant.revision} · last change${by} ${formatDate(variant.updatedAt)}`}
    >
      {text}
    </span>
  );
}

function FullPageError({ message }) {
  return (
    <div className="page center">
      <p className="error">{message}</p>
      <a href="#/">← Games</a>
    </div>
  );
}
