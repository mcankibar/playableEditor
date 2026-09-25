import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { releasePlayUrl } from "../api.js";

const DEVICES = [
  { id: "portrait", label: "Dikey", width: 390, height: 844 },
  { id: "landscape", label: "Yatay", width: 844, height: 390 },
  { id: "tablet", label: "Tablet", width: 820, height: 1180 }
];

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
export function Preview({ releaseId, overrides, assets, languages, previewLang, onPreviewLang, release }) {
  const [device, setDevice] = useState(
    () => DEVICES.find((d) => d.id === localStorage.getItem("pl-device")) ?? DEVICES[0]
  );
  const [run, setRun] = useState(0);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(1);
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

  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin) return;
      if (event.data?.type !== "pl:ready") return;
      setReady(true);
      // After a restart the game already runs with the values it was sent.
      if (sent.current !== latest.current.signature) send();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const win = frame.current?.contentWindow;
    if (!win || !releaseId) return;
    const { overrides: o, assets: a } = latest.current.payload;
    win.name = PREVIEW_PREFIX + JSON.stringify({ overrides: o, assets: a });
    sent.current = latest.current.signature;
    win.location.replace(releasePlayUrl(releaseId));
  }, [run, releaseId]);

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
  }, [device]);

  function restart() {
    sent.current = null;
    setReady(false);
    setRun((n) => n + 1);
  }

  return (
    <section className="preview">
      <div className="preview-bar">
        <div className="segmented">
          {DEVICES.map((d) => (
            <button
              key={d.id}
              className={d.id === device.id ? "active" : ""}
              onClick={() => {
                setDevice(d);
                localStorage.setItem("pl-device", d.id);
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
        {languages && (
          <label className="inline" title="Sadece önizleme için; varyanta kaydedilmez">
            Dil
            <select value={previewLang} onChange={(e) => onPreviewLang(e.target.value)}>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l === "" ? "varyanttaki" : l}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="spacer" />
        <span className="muted small">{ready ? `${device.width}×${device.height}` : "başlatılıyor…"}</span>
        <button onClick={restart} title="Oyunu mevcut değerlerle baştan başlat">
          ↻ Baştan başlat
        </button>
      </div>
      <div className="stage" ref={stage}>
        {releaseId && (
          <div
            className="device"
            style={{ width: device.width * scale, height: device.height * scale }}
            title={release ? `r${release.number}` : ""}
          >
            <iframe
              key={run}
              ref={frame}
              title="Önizleme"
              allow="autoplay; fullscreen"
              style={{ width: device.width, height: device.height, transform: `scale(${scale})` }}
            />
          </div>
        )}
      </div>
    </section>
  );
}
