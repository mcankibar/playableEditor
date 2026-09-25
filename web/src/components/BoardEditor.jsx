import { useEffect, useMemo, useRef, useState } from "react";
import { assetUrl } from "../api.js";
import {
  cloneGrid,
  columnCount,
  findMatches,
  parseBoard,
  randomFill,
  resizeGrid,
  separators,
  serializeBoard,
  setCell
} from "./boardLogic.js";
import "./board.css";

const MODE_KEY = "pl-board-mode";
function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === "text" ? "text" : "visual";
  } catch {
    return "visual";
  }
}

const MIN_SIZE = 3;
const MAX_SIZE = 12;
const THUMB = 64;

// ── palette images ───────────────────────────────────────
// Shared across editors: key → Promise<url | null>. Keys contain the resolved file URLs, so a variant with a
// different skin (overridden atlas) gets its own entries and the board follows it.
const imageCache = new Map();
const jsonCache = new Map();

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't load ${url}`));
    img.src = url;
  });
}

function loadJson(url) {
  if (!jsonCache.has(url)) {
    const p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    });
    p.catch(() => jsonCache.delete(url));
    jsonCache.set(url, p);
  }
  return jsonCache.get(url);
}

/** TexturePacker "hash" ({ frames: { name: {…} } }) or "array" ({ frames: [{ filename, … }] }) format. */
function findFrame(data, name) {
  const frames = data?.frames;
  if (!frames) return null;
  const base = (n) => String(n).replace(/\.[^./]+$/, "");
  if (Array.isArray(frames))
    return frames.find((f) => f.filename === name) ?? frames.find((f) => base(f.filename) === base(name));
  if (frames[name]) return frames[name];
  const key = Object.keys(frames).find((k) => base(k) === base(name));
  return key ? frames[key] : null;
}

/** Crops one atlas frame onto a THUMB×THUMB canvas (aspect kept, rotated frames turned back -90°). */
async function cropFrame(pngUrl, jsonUrl, frameName) {
  const [img, data] = await Promise.all([loadImage(pngUrl), loadJson(jsonUrl)]);
  const entry = findFrame(data, frameName);
  if (!entry?.frame) throw new Error(`No frame ${frameName}`);
  const { x, y, w, h } = entry.frame;
  const scale = THUMB / Math.max(w, h);
  const dw = w * scale;
  const dh = h * scale;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = THUMB;
  const ctx = canvas.getContext("2d");
  ctx.translate((THUMB - dw) / 2, (THUMB - dh) / 2);
  if (entry.rotated) {
    // Stored turned 90° clockwise: the sheet region is h×w.
    ctx.translate(0, dh);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(img, x, y, h, w, 0, 0, dh, dw);
  } else ctx.drawImage(img, x, y, w, h, 0, 0, dw, dh);
  return canvas.toDataURL();
}

function getImage(source) {
  if (!imageCache.has(source.key)) {
    const p = source.frame
      ? cropFrame(source.png, source.json, source.frame)
      : loadImage(source.png).then(() => source.png);
    imageCache.set(
      source.key,
      p.catch(() => null)
    );
  }
  return imageCache.get(source.key);
}

/** token → image URL (data URL for atlas frames); undefined while loading, null when it can't be shown. */
function useTokenImages(palette, fields, overrides, releaseId, uploads) {
  const sources = useMemo(() => {
    const byPath = new Map(fields.map((f) => [f.path, f]));
    const urlOf = (path) => {
      const f = byPath.get(path);
      if (!f) return null;
      const id = overrides?.[path] ?? f.default;
      if (typeof id !== "string" || !id) return null;
      return uploads?.[id] || assetUrl(releaseId, id);
    };
    const out = {};
    for (const entry of palette) {
      const ref = entry.image;
      if (!ref) continue;
      if (ref.atlas) {
        const png = urlOf(`${ref.atlas}.0`);
        const json = urlOf(`${ref.atlas}.1`);
        if (png && json && ref.frame)
          out[entry.token] = { key: `${png}\n${json}\n${ref.frame}`, png, json, frame: ref.frame };
      } else if (ref.image) {
        const png = urlOf(ref.image);
        if (png) out[entry.token] = { key: png, png };
      }
    }
    return out;
  }, [palette, fields, overrides, releaseId, uploads]);

  const [loaded, setLoaded] = useState({});
  useEffect(() => {
    let alive = true;
    for (const source of Object.values(sources)) {
      if (source.key in loaded) continue;
      getImage(source).then(
        (url) => alive && setLoaded((m) => (m[source.key] === url ? m : { ...m, [source.key]: url }))
      );
    }
    return () => {
      alive = false;
    };
  }, [sources]);

  return (token) => {
    const source = sources[token];
    return source ? loaded[source.key] : null;
  };
}

// ── editor ───────────────────────────────────────────────

export function BoardEditor({ field, value, onChange, fields = [], overrides = {}, releaseId, uploads = {} }) {
  const editor = field.editor ?? {};
  const palette = useMemo(() => (Array.isArray(editor.palette) ? editor.palette : []), [editor.palette]);
  const byToken = useMemo(() => new Map(palette.map((p) => [p.token, p])), [palette]);
  const matchTokens = useMemo(() => palette.filter((p) => p.match).map((p) => p.token), [palette]);
  const matchSet = useMemo(() => new Set(matchTokens), [matchTokens]);
  const isMatch = (t) => matchSet.has(t);
  const fillToken = matchTokens[0] ?? palette[0]?.token ?? "";
  const imageOf = useTokenImages(palette, fields, overrides, releaseId, uploads);

  const levels = useMemo(() => parseBoard(value, editor), [value, editor.levels, editor.rows, editor.cells]);
  const [levelIndex, setLevelIndex] = useState(0);
  const li = Math.min(levelIndex, levels.length - 1);

  const [tool, setTool] = useState(fillToken);
  const [excluded, setExcluded] = useState(() => new Set());
  const [mode, setMode] = useState(readMode); // "visual" | "text", remembered per browser
  const chooseMode = (m) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
  };

  // While dragging, edits go to a draft; the value changes once, on pointer up.
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null);
  const painting = useRef(false);
  const grid = draft ?? levels[li];
  const rows = grid.length;
  const cols = columnCount(grid);
  const matches = useMemo(() => findMatches(grid, (t) => matchSet.has(t)), [grid, matchSet]);

  function commitLevels(next) {
    const text = serializeBoard(next, editor);
    if (text !== value) onChange(text);
  }
  function commitGrid(next) {
    const copy = [...levels];
    copy[li] = next;
    commitLevels(copy);
  }

  const cellAt = (el) => {
    const cell = el?.closest?.("[data-r]");
    return cell ? [Number(cell.dataset.r), Number(cell.dataset.c)] : null;
  };
  function paint(r, c) {
    const base = draftRef.current ?? levels[li];
    const next = setCell(base, r, c, tool, fillToken);
    if (next === base) return;
    draftRef.current = next;
    setDraft(next);
  }
  function onPointerDown(e) {
    const at = cellAt(e.target);
    if (!at) return;
    if (e.button === 2 || e.altKey) {
      // Eyedropper.
      e.preventDefault();
      const token = grid[at[0]]?.[at[1]];
      if (token !== undefined) setTool(token);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    painting.current = true;
    draftRef.current = null;
    paint(...at);
  }
  function onPointerMove(e) {
    if (!painting.current) return;
    // Pointer capture sends every move to the grid: find the cell under the pointer ourselves.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const at = e.currentTarget.contains(el) && cellAt(el);
    if (at) paint(...at);
  }
  function onPointerUp() {
    if (!painting.current) return;
    painting.current = false;
    const next = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (next) commitGrid(next);
  }

  function resize(nextRows, nextCols) {
    commitGrid(resizeGrid(levels[li], nextRows, nextCols, fillToken));
  }

  function addLevel() {
    const copy = [...levels];
    copy.splice(li + 1, 0, cloneGrid(levels[li]));
    commitLevels(copy);
    setLevelIndex(li + 1);
  }
  function removeLevel() {
    if (levels.length < 2 || !window.confirm(`Remove level ${li + 1}?`)) return;
    commitLevels(levels.filter((_, i) => i !== li));
    setLevelIndex(Math.max(0, li - 1));
  }

  const allowed = matchTokens.filter((t) => !excluded.has(t));
  const toggleAllowed = (t) =>
    setExcluded((s) => {
      const next = new Set(s);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });

  const groups = useMemo(() => {
    const map = new Map();
    for (const p of palette) {
      const g = p.group || "Tiles";
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(p);
    }
    return [...map];
  }, [palette]);

  const modeSwitch = (
    <div className="board-mode" role="tablist" aria-label="Board editing">
      {[
        ["visual", "Visual"],
        ["text", "Text"]
      ].map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={mode === id}
          className={`small${mode === id ? " active" : ""}`}
          onClick={() => chooseMode(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (mode === "text") {
    const starting = levels.reduce((n, g) => n + findMatches(g, isMatch).size, 0);
    return (
      <div className="board-editor">
        {modeSwitch}
        <RawText value={value} editor={editor} onCommit={onChange} />
        <p className="muted small">
          {levels
            .map((g, i) => `${levels.length > 1 ? `Level ${i + 1}: ` : ""}${columnCount(g)}×${g.length}`)
            .join(" · ")}
          {matchTokens.length > 0 && (starting ? ` · ${starting} cells in starting matches` : " · no starting matches")}
        </p>
        {palette.length > 0 && (
          <p className="muted small board-legend">{palette.map((p) => `${p.token} ${p.label}`).join(" · ")}</p>
        )}
      </div>
    );
  }

  return (
    <div className="board-editor">
      {modeSwitch}
      <div className="board-levels">
        {levels.length > 1 &&
          levels.map((_, i) => (
            <button key={i} className={`small${i === li ? " active" : ""}`} onClick={() => setLevelIndex(i)}>
              Level {i + 1}
            </button>
          ))}
        <button className="small" onClick={addLevel} title="Add a copy of this level after it">
          + Add level
        </button>
        {levels.length > 1 && (
          <button className="small danger" onClick={removeLevel} title={`Remove level ${li + 1}`}>
            Remove
          </button>
        )}
      </div>

      <div className="board-size">
        <label className="inline">
          Columns
          <SizeInput value={cols} onCommit={(n) => resize(rows, n)} />
        </label>
        <label className="inline">
          Rows
          <SizeInput value={rows} onCommit={(n) => resize(n, cols)} />
        </label>
      </div>

      <div
        className="board-grid"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {grid.flatMap((row, r) =>
          Array.from({ length: cols }, (_, c) => (
            <Cell
              key={`${r},${c}`}
              r={r}
              c={c}
              token={row[c]}
              entry={byToken.get(row[c])}
              image={row[c] === undefined ? null : imageOf(row[c])}
              matched={matches.cells.has(`${r},${c}`)}
            />
          ))
        )}
      </div>
      <div className="board-status small">
        {matches.count > 0 ? (
          <span className="error">
            {matches.count} starting {matches.count === 1 ? "match" : "matches"}
          </span>
        ) : (
          <span className="muted">No starting matches</span>
        )}
        <span className="muted">Right-click or Alt+click picks a tile</span>
      </div>

      {groups.length > 0 && (
        <div className="board-palette">
          {groups.map(([name, entries]) => (
            <div key={name} className="board-palette-group">
              <div className="board-palette-title">{name}</div>
              <div className="board-tools">
                {entries.map((p) => (
                  <button
                    key={p.token}
                    className={`board-tool${p.token === tool ? " active" : ""}`}
                    title={`${p.label ?? p.token} (${p.token})`}
                    onClick={() => setTool(p.token)}
                  >
                    <Swatch entry={p} token={p.token} image={imageOf(p.token)} />
                    <span className="board-tool-label">{p.label ?? p.token}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {tool !== undefined && !byToken.has(tool) && (
        <div className="small muted">
          Painting with <span className="mono">{tool || "(empty)"}</span>
        </div>
      )}

      {matchTokens.length > 0 && (
        <div className="board-random">
          <button
            className="small"
            disabled={!allowed.length}
            onClick={() => commitGrid(randomFill(levels[li], isMatch, allowed))}
            title="Refill the coloured tiles of this level without starting matches or 2×2 squares"
          >
            Random fill
          </button>
          <div className="board-random-colors">
            {matchTokens.map((t) => (
              <label key={t} className="inline small" title={byToken.get(t)?.label ?? t}>
                <input type="checkbox" checked={!excluded.has(t)} onChange={() => toggleAllowed(t)} />
                <Swatch entry={byToken.get(t)} token={t} image={imageOf(t)} mini />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({ r, c, token, entry, image, matched }) {
  const cls = ["board-cell"];
  if (matched) cls.push("matched");
  if (token === undefined) cls.push("missing");
  else if (!entry) cls.push("unknown");
  return (
    <div
      className={cls.join(" ")}
      data-r={r}
      data-c={c}
      title={token === undefined ? "" : `${entry?.label ?? "Unknown"} (${token || "empty"})`}
    >
      {token !== undefined && <Swatch entry={entry} token={token} image={image} />}
    </div>
  );
}

/** Tile picture: the palette image, else its colour with the token, else just the token text. */
function Swatch({ entry, token, image, mini = false }) {
  const cls = `board-swatch${mini ? " mini" : ""}`;
  if (image) return <img className={cls} src={image} alt="" draggable={false} />;
  return (
    <span className={`${cls} text`} style={entry?.color ? { background: entry.color } : undefined}>
      {mini ? "" : token.length > 4 ? token.slice(0, 4) + "…" : token}
    </span>
  );
}

function SizeInput({ value, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const valid = (s) => /^\d+$/.test(s) && Number(s) >= MIN_SIZE && Number(s) <= MAX_SIZE;
  return (
    <input
      type="number"
      className="board-size-input"
      min={MIN_SIZE}
      max={MAX_SIZE}
      value={draft}
      onChange={(e) => {
        // Apply straight away when it's in range (spinner clicks); partial typing waits for a valid number.
        setDraft(e.target.value);
        if (valid(e.target.value) && Number(e.target.value) !== value) onCommit(Number(e.target.value));
      }}
      onBlur={() => setDraft(String(value))}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

/**
 * The level string with one board row per line (and a blank line between levels) for reading and
 * typing; line breaks and spaces are dropped again when it is saved.
 */
function RawText({ value, editor, onCommit }) {
  const { rows, levels } = separators(editor);
  const pretty = (v) =>
    (v ?? "")
      .split(levels)
      .map((l) => l.split(rows).join(`${rows}\n`))
      .join(`${levels}\n\n`);
  const compact = (v) => v.replace(/\s+/g, "");
  const [draft, setDraft] = useState(() => pretty(value));
  useEffect(() => setDraft(pretty(value)), [value]);
  return (
    <textarea
      className="board-text mono"
      rows={Math.min(24, draft.split("\n").length + 1)}
      spellCheck={false}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => compact(draft) !== value && onCommit(compact(draft))}
    />
  );
}
