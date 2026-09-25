import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { releasePlayUrl } from "../api.js";

// CSS viewport sizes (portrait) — what the playable sees as window.innerWidth/innerHeight.
// cutout: what covers the screen on the real device (Dynamic Island / punch-hole camera).
const DEVICES = [
  {
    group: "iPhone",
    id: "iphone-16-pro-max",
    label: "iPhone 16 Pro Max",
    width: 440,
    height: 956,
    radius: 55,
    cutout: "island"
  },
  {
    group: "iPhone",
    id: "iphone-16-pro",
    label: "iPhone 16 Pro",
    width: 402,
    height: 874,
    radius: 55,
    cutout: "island"
  },
  {
    group: "iPhone",
    id: "iphone-16-plus",
    label: "iPhone 16 Plus",
    width: 430,
    height: 932,
    radius: 53,
    cutout: "island"
  },
  { group: "iPhone", id: "iphone-16", label: "iPhone 16 / 15", width: 393, height: 852, radius: 53, cutout: "island" },
  {
    group: "iPhone",
    id: "iphone-13-mini",
    label: "iPhone 13 mini",
    width: 375,
    height: 812,
    radius: 44,
    cutout: "notch"
  },
  { group: "iPhone", id: "iphone-se", label: "iPhone SE", width: 375, height: 667, radius: 0 },
  {
    group: "Android",
    id: "galaxy-s24-ultra",
    label: "Galaxy S24 Ultra",
    width: 384,
    height: 824,
    radius: 18,
    cutout: "hole"
  },
  { group: "Android", id: "galaxy-s24", label: "Galaxy S24", width: 360, height: 780, radius: 36, cutout: "hole" },
  { group: "Android", id: "galaxy-a54", label: "Galaxy A54", width: 412, height: 915, radius: 30, cutout: "hole" },
  { group: "Android", id: "pixel-9", label: "Pixel 9", width: 412, height: 923, radius: 44, cutout: "hole" },
  { group: "Tablet", id: "ipad-mini", label: "iPad mini", width: 744, height: 1133, radius: 22 },
  { group: "Tablet", id: "ipad-air", label: "iPad Air 11″", width: 820, height: 1180, radius: 18 },
  { group: "Tablet", id: "ipad-pro-13", label: "iPad Pro 13″", width: 1032, height: 1376, radius: 18 },
  { group: "Other", id: "custom", label: "Custom size…", width: 390, height: 844, radius: 0 }
];
const GROUPS = [...new Set(DEVICES.map((d) => d.group))];

function stored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const clampSize = (n) => Math.min(2000, Math.max(200, Math.round(Number(n) || 0)));

const SEND_DELAY = 120;
// The runtime keeps preview values in window.name under this prefix (template playable/kit/runtime.js).
const PREVIEW_PREFIX = "pl-preview:";

/**
 * The release runs in an iframe (same origin, preview mode). Values reach it with the runtime's
 * preview protocol: { type: "pl:preview", overrides, assets } → applied live when the game
 * supports it, otherwise the game restarts itself with the values (kept in window.name).
 * The frame starts blank and gets the values in window.name before the release loads, so the game
 * starts with them (and never with a stale name the browser restored from an earlier frame).
 */
/**
 * Select mode: the game outlines the component under the pointer and reports clicks
 * (pl:inspect / pl:hover / pl:select, template playable/kit/runtime.js). `highlight` outlines a
 * component from outside (the field panel's hovered group).
 */
export function Preview({
  releaseId,
  overrides,
  assets,
  languages,
  previewLang,
  onPreviewLang,
  release,
  highlight = null,
  onSelectComponent,
  comparisonView = null,
  restartKey = 0
}) {
  const [view, setView] = useState(() => {
    const saved = stored("pl-device", {});
    return {
      id: DEVICES.some((d) => d.id === saved.id) ? saved.id : DEVICES[0].id,
      landscape: !!saved.landscape,
      custom: { width: clampSize(saved.custom?.width ?? 390), height: clampSize(saved.custom?.height ?? 844) }
    };
  });
  const changeView = (patch) =>
    setView((v) => {
      const next = { ...v, ...patch };
      store("pl-device", next);
      return next;
    });
  const activeView = comparisonView ?? view;
  const model = DEVICES.find((d) => d.id === activeView.id);
  const base = model.id === "custom" ? { ...model, ...activeView.custom } : model;
  const device = activeView.landscape ? { ...base, width: base.height, height: base.width } : base;
  const [run, setRun] = useState(0);
  const [ready, setReady] = useState(false);
  const [inspectable, setInspectable] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [scale, setScale] = useState(1);
  const modes = useRef({});
  modes.current = { inspecting, highlight, onSelectComponent };
  const stage = useRef(null);
  const frame = useRef(null);
  const sent = useRef(null);
  const latest = useRef(null);

  const payload = { type: "pl:preview", overrides, assets };
  const signature = JSON.stringify(overrides) + "|" + Object.keys(assets).sort().join(",");
  latest.current = { payload, signature };

  const send = () => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    win.postMessage(latest.current.payload, window.location.origin);
    sent.current = latest.current.signature;
  };

  const tell = (message) => frame.current?.contentWindow?.postMessage(message, window.location.origin);

  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin) return;
      const { type, componentId } = event.data || {};
      if (type === "pl:ready") {
        setReady(true);
        // After a restart the game already runs with the values it was sent.
        if (sent.current !== latest.current.signature) send();
      } else if (type === "pl:inspectable") {
        // Also after the game restarted itself: bring its select mode / outline back.
        setInspectable(true);
        if (modes.current.inspecting) tell({ type: "pl:inspect", enabled: true });
        if (modes.current.highlight) tell({ type: "pl:highlight", componentId: modes.current.highlight });
      } else if (type === "pl:hover") {
        setHovered(typeof componentId === "string" ? componentId : null);
      } else if (type === "pl:select" && typeof componentId === "string") {
        const { related, assets } = event.data;
        const list = (value) => (Array.isArray(value) ? value : []);
        modes.current.onSelectComponent?.({
          componentId,
          related: list(related).filter((r) => typeof r?.componentId === "string" && typeof r.reason === "string"),
          assets: list(assets)
            .filter((a) => typeof a?.path === "string")
            .map((a) => ({ path: a.path, frame: typeof a.frame === "string" ? a.frame : null }))
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (inspectable) tell({ type: "pl:inspect", enabled: inspecting });
    if (!inspecting) setHovered(null);
  }, [inspecting, inspectable]);

  useEffect(() => {
    if (inspectable) tell({ type: "pl:highlight", componentId: highlight });
  }, [highlight, inspectable]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && setInspecting(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const win = frame.current?.contentWindow;
    if (!win || !releaseId) return;
    setReady(false);
    setInspectable(false);
    const { overrides: o, assets: a } = latest.current.payload;
    win.name = PREVIEW_PREFIX + JSON.stringify({ overrides: o, assets: a });
    sent.current = latest.current.signature;
    win.location.replace(releasePlayUrl(releaseId));
  }, [run, releaseId, restartKey]);

  useEffect(() => {
    if (!ready || sent.current === signature) return;
    const t = setTimeout(send, SEND_DELAY);
    return () => clearTimeout(t);
  }, [signature, ready]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const pad = 32;
      setScale(Math.min(1, (el.clientWidth - pad) / device.width, (el.clientHeight - pad) / device.height));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [device.width, device.height]);

  function restart() {
    sent.current = null;
    setReady(false);
    setRun((n) => n + 1);
  }

  return (
    <section className="preview">
      {!comparisonView && (
        <div className="preview-bar">
          <select value={view.id} onChange={(e) => changeView({ id: e.target.value })} title="Device">
            {GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {DEVICES.filter((d) => d.group === g).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                    {d.id === "custom" ? "" : ` · ${d.width}×${d.height}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {view.id === "custom" && (
            <span className="custom-size">
              <SizeInput
                label="Width"
                value={view.custom.width}
                onChange={(width) => changeView({ custom: { ...activeView.custom, width } })}
              />
              ×
              <SizeInput
                label="Height"
                value={view.custom.height}
                onChange={(height) => changeView({ custom: { ...activeView.custom, height } })}
              />
            </span>
          )}
          <button
            onClick={() => changeView({ landscape: !view.landscape })}
            title={view.landscape ? "Rotate to portrait" : "Rotate to landscape"}
            aria-label="Rotate"
          >
            {view.landscape ? "▭ Landscape" : "▯ Portrait"}
          </button>
          {languages && (
            <label className="inline" title="Preview only; not saved to the variant">
              Language
              <select value={previewLang} onChange={(e) => onPreviewLang(e.target.value)}>
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {l === "" ? "Variant's language" : l}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="spacer" />
          <button
            className={`select-toggle${inspecting ? " active" : ""}`}
            disabled={!inspectable}
            aria-pressed={inspecting}
            onClick={() => setInspecting((v) => !v)}
            title={
              inspectable
                ? "Click a part of the game to edit it (Esc to stop)"
                : "This release can't be selected in — rebuild it with the latest template"
            }
          >
            ⌖ Select
          </button>
          <span className="muted small">{ready ? `${device.width}×${device.height}` : "Starting…"}</span>
          <button onClick={restart} title="Restart the game with the current values">
            ↻ Restart
          </button>
        </div>
      )}
      {inspecting && (
        <div className="select-hint">
          {hovered ? "Click to edit this part" : "Point at a part of the game — click it to edit its settings"}
          <button className="link" onClick={() => setInspecting(false)}>
            Done
          </button>
        </div>
      )}
      <div className="stage" ref={stage}>
        {releaseId && (
          <div
            className={`device${device.radius ? "" : " square"}`}
            style={{
              width: device.width * scale,
              height: device.height * scale,
              borderRadius: device.radius * scale
            }}
            title={release ? `r${release.number}` : ""}
          >
            <iframe
              key={run}
              ref={frame}
              title="Preview"
              allow="autoplay; fullscreen"
              style={{ width: device.width, height: device.height, transform: `scale(${scale})` }}
            />
            {device.cutout && (
              <span
                className={`cutout ${device.cutout} ${view.landscape ? "landscape" : "portrait"}`}
                style={{ "--s": scale }}
                aria-hidden
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Applied on blur / Enter, so typing "4" on the way to "440" does not resize the game. */
function SizeInput({ label, value, onChange }) {
  return (
    <input
      type="number"
      min={200}
      max={2000}
      aria-label={label}
      defaultValue={value}
      onBlur={(e) => {
        const n = clampSize(e.target.value);
        e.target.value = n;
        if (n !== value) onChange(n);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
    />
  );
}
