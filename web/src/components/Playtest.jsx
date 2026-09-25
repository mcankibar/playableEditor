import { useEffect, useRef, useState } from "react";
import { releasePlayUrl } from "../api.js";
import { OUTCOMES, aggregate, checkStatus, difficultySummary } from "./playtestStats.js";
import "./playtest.css";

// Same prefix as Preview.jsx / the runtime's readPreviewState (template playable/kit/runtime.js).
const PREVIEW_PREFIX = "pl-preview:";
const FRAME = { width: 360, height: 640, scale: 0.4 };
const LOAD_TIMEOUT = 60000;
const READY_TIMEOUT = 15000;
const RESULT_GRACE = 15000;
const LOG_LINES = 60;
const UNSUPPORTED = "This game doesn't support playtesting yet.";

const DIFFICULTY_BOT = { maxSteps: 300, timeoutMs: 120000 };
const CHECK_BOT = { strategy: "greedy", speed: 8, maxSteps: 6, timeoutMs: 30000 };

const texts = (list) => (Array.isArray(list) ? list.map(String) : []);
const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * One bot run per page load: the frame gets the variant's preview values in window.name, loads the
 * release, waits for pl:bot-ready, sends pl:bot and resolves with the pl:bot-result
 * ({ outcome: "unsupported" } when the game never says it can be playtested, "aborted" on stop).
 */
function playOnce({ frame, releaseId, variant, bot, stopper, onStep }) {
  return new Promise((resolve) => {
    const origin = window.location.origin;
    const started = performance.now();
    const pageErrors = [];
    let phase = "loading";
    let timer = null;

    const wait = (ms, fn) => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
    const done = (result) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.removeEventListener("load", onLoad);
      stopper.current = null;
      resolve({ ...result, wallMs: Math.round(performance.now() - started) });
    };
    const failed = (message) =>
      done({ outcome: "error", steps: 0, errors: pageErrors.length ? pageErrors : [message] });

    function onLoad() {
      // Errors while the game starts (before the runtime's own bot error capture matters).
      try {
        const win = frame.contentWindow;
        win.addEventListener("error", (e) => pageErrors.push(String(e.error?.message || e.message)));
        win.addEventListener("unhandledrejection", (e) => pageErrors.push(String(e.reason?.message || e.reason)));
      } catch {}
      if (phase === "loading")
        wait(READY_TIMEOUT, () =>
          pageErrors.length ? failed() : done({ outcome: "unsupported", steps: 0, errors: [] })
        );
    }

    function onMessage(event) {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      const data = event.data || {};
      if (data.type === "pl:bot-ready" && phase === "loading") {
        phase = "playing";
        wait(bot.timeoutMs + RESULT_GRACE, () => failed("The game stopped answering"));
        frame.contentWindow.postMessage({ type: "pl:bot", seed: 1, ...bot }, origin);
      } else if (data.type === "pl:bot-step" && phase === "playing") {
        onStep({ step: num(data.step), movesLeft: num(data.movesLeft), goalsLeft: num(data.goalsLeft) });
      } else if (data.type === "pl:bot-result" && phase === "playing") {
        done({
          outcome: OUTCOMES.includes(data.outcome) ? data.outcome : "error",
          steps: num(data.steps) ?? 0,
          movesLeft: num(data.movesLeft),
          goalsLeft: num(data.goalsLeft),
          errors: texts(data.errors),
          ms: num(data.ms)
        });
      }
    }

    stopper.current = () => done({ outcome: "aborted", steps: 0, errors: [] });
    window.addEventListener("message", onMessage);
    frame.addEventListener("load", onLoad);
    wait(LOAD_TIMEOUT, () => failed("The game didn't load"));
    const win = frame.contentWindow;
    win.name = PREVIEW_PREFIX + JSON.stringify({ overrides: variant.overrides || {}, assets: variant.uploads || {} });
    win.location.replace(releasePlayUrl(releaseId));
  });
}

/**
 * Bot playtest of a release with the given variants (template playable/kit/runtime.js "Bot playtest").
 * Difficulty: N seeded runs of one variant → win rate and difficulty label.
 * Release check: one short run per variant → does it load and play without errors.
 */
export function Playtest({ releaseId, release, variants, onClose, onResult }) {
  const [mode, setMode] = useState(variants.length > 1 ? "check" : "difficulty");
  const [variantId, setVariantId] = useState(variants[0]?.id);
  const [count, setCount] = useState(10);
  const [strategy, setStrategy] = useState("greedy");
  const [speed, setSpeed] = useState(8);
  const [watch, setWatch] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [log, setLog] = useState([]);
  const [results, setResults] = useState(null);
  const [checks, setChecks] = useState(null);
  const [notice, setNotice] = useState("");

  const frame = useRef(null);
  const stopper = useRef(null);
  const stopped = useRef(false);
  const callbacks = useRef({});
  callbacks.current = { onClose, onResult };

  const addLog = (line) => setLog((l) => [...l.slice(-(LOG_LINES - 1)), line]);
  const blank = () => {
    try {
      frame.current?.contentWindow?.location.replace("about:blank");
    } catch {}
  };
  const stop = () => {
    stopped.current = true;
    stopper.current?.();
  };
  const close = () => {
    stop();
    callbacks.current.onClose();
  };

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stop();
    };
  }, []);

  const variant = variants.find((v) => v.id === variantId) || variants[0];
  const releaseName = release ? `r${release.number}` : "this release";

  async function runDifficulty() {
    const bot = { ...DIFFICULTY_BOT, strategy, speed };
    const done = [];
    setResults([]);
    setNotice("");
    addLog(`${variant.name}: ${count} runs · ${strategy} · ${speed}×`);
    for (let i = 1; i <= count && !stopped.current; i++) {
      setProgress({ run: i, total: count, step: 0, movesLeft: null, goalsLeft: null });
      const r = await playOnce({
        frame: frame.current,
        releaseId,
        variant,
        bot: { ...bot, seed: i },
        stopper,
        onStep: (s) => setProgress((p) => ({ ...p, ...s }))
      });
      if (r.outcome === "aborted") break;
      if (r.outcome === "unsupported") {
        setNotice(UNSUPPORTED);
        addLog("No pl:bot-ready from the game");
        return;
      }
      done.push(r);
      setResults([...done]);
      const moves = r.movesLeft == null ? "" : ` · ${r.movesLeft} moves left`;
      addLog(`Run ${i}: ${r.outcome} in ${r.steps} steps${moves}${r.errors[0] ? ` · ${r.errors[0]}` : ""}`);
    }
    if (stopped.current) {
      addLog("Stopped");
      return;
    }
    const summary = difficultySummary(aggregate(done), { releaseId, revision: variant.revision, strategy, speed });
    callbacks.current.onResult?.(variant.id, summary);
  }

  async function runCheck() {
    const found = {};
    setChecks({});
    for (let i = 0; i < variants.length && !stopped.current; i++) {
      const v = variants[i];
      setProgress({ run: i + 1, total: variants.length, step: 0, name: v.name });
      found[v.id] = { status: "running" };
      setChecks({ ...found });
      const r = await playOnce({
        frame: frame.current,
        releaseId,
        variant: v,
        bot: CHECK_BOT,
        stopper,
        onStep: (s) => setProgress((p) => ({ ...p, ...s }))
      });
      if (r.outcome === "aborted") {
        delete found[v.id];
        break;
      }
      if (r.outcome === "unsupported") {
        // Same release for every variant: no need to wait for the others.
        setNotice(UNSUPPORTED);
        for (const rest of variants.slice(i)) {
          found[rest.id] = { check: "unsupported" };
          callbacks.current.onResult?.(rest.id, { releaseId, revision: rest.revision, check: "unsupported" });
        }
        break;
      }
      const status = checkStatus(r);
      found[v.id] = { ...status, ms: r.wallMs, outcome: r.outcome };
      setChecks({ ...found });
      addLog(`${v.name}: ${status.check}${status.error ? ` · ${status.error}` : ""}`);
      callbacks.current.onResult?.(v.id, { releaseId, revision: v.revision, ...status });
    }
    setChecks({ ...found });
    if (stopped.current) addLog("Stopped");
  }

  async function start() {
    if (!frame.current || running) return;
    stopped.current = false;
    setRunning(true);
    setLog([]);
    try {
      await (mode === "difficulty" ? runDifficulty() : runCheck());
    } catch (e) {
      setNotice(e.message);
    } finally {
      setRunning(false);
      setProgress(null);
      if (stopped.current) blank();
    }
  }

  const stats = results?.length ? aggregate(results) : null;
  const checked = checks ? variants.filter((v) => checks[v.id] && checks[v.id].status !== "running") : [];
  const okCount = checked.filter((v) => checks[v.id].check === "ok").length;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal playtest" role="dialog" aria-label="Playtest">
        <header>
          <strong>
            Playtest · {releaseName}
            {mode === "difficulty" && variant ? ` · ${variant.name}` : ""}
          </strong>
          <button className="link" onClick={close}>
            ✕
          </button>
        </header>

        <div className="pt-tabs" role="tablist">
          {[
            ["difficulty", "Difficulty"],
            ["check", "Release check"]
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={mode === id}
              className={mode === id ? "active" : ""}
              disabled={running}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="pt-body">
          <div className="pt-main">
            {mode === "difficulty" ? (
              <div className="pt-options">
                {variants.length > 1 && (
                  <label className="inline">
                    Variant
                    <select value={variant?.id} disabled={running} onChange={(e) => setVariantId(pick(variants, e))}>
                      {variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="inline">
                  Games
                  <select value={count} disabled={running} onChange={(e) => setCount(Number(e.target.value))}>
                    {[5, 10, 20].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label
                  className="inline"
                  title="Greedy picks the best-scoring move; random plays like a careless player"
                >
                  Bot
                  <select value={strategy} disabled={running} onChange={(e) => setStrategy(e.target.value)}>
                    <option value="greedy">Greedy</option>
                    <option value="random">Random</option>
                  </select>
                </label>
                <label className="inline">
                  Speed
                  <select value={speed} disabled={running} onChange={(e) => setSpeed(Number(e.target.value))}>
                    {[4, 8, 12].map((n) => (
                      <option key={n} value={n}>
                        {n}×
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <p className="muted small pt-hint">
                Each variant plays a few moves to check that it loads and runs without errors on {releaseName}.
              </p>
            )}

            {progress && (
              <div className="pt-progress">
                <div className="pt-bar">
                  <span style={{ width: `${((progress.run - 1) / progress.total) * 100}%` }} />
                </div>
                <span className="small">
                  {mode === "difficulty" ? "Run" : "Variant"} {progress.run}/{progress.total}
                  {progress.name ? ` · ${progress.name}` : ""} · step {progress.step ?? 0}
                  {progress.movesLeft != null ? ` · ${progress.movesLeft} moves left` : ""}
                  {progress.goalsLeft != null ? ` · ${progress.goalsLeft} goals left` : ""}
                </span>
              </div>
            )}

            {notice && <div className="banner error pt-notice">{notice}</div>}

            {mode === "difficulty" && stats && <DifficultyStats stats={stats} partial={running} />}

            {mode === "check" && checks && (
              <>
                <table className="pt-table">
                  <thead>
                    <tr>
                      <th>Variant</th>
                      <th>Status</th>
                      <th className="num">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map((v) => (
                      <CheckRow key={v.id} variant={v} check={checks[v.id]} />
                    ))}
                  </tbody>
                </table>
                {!running && checked.length > 0 && (
                  <p className="pt-summary">
                    <strong>
                      {okCount} of {variants.length}
                    </strong>{" "}
                    variants OK on {releaseName}
                  </p>
                )}
              </>
            )}

            {log.length > 0 && (
              <pre className="pt-log" aria-live="polite">
                {log.join("\n")}
              </pre>
            )}
          </div>

          <div className={`pt-watch${watch ? "" : " hidden"}`} aria-hidden={!watch}>
            <div className="pt-screen" style={{ width: FRAME.width * FRAME.scale, height: FRAME.height * FRAME.scale }}>
              <iframe
                ref={frame}
                title="Playtest"
                tabIndex={-1}
                allow="autoplay"
                style={{ width: FRAME.width, height: FRAME.height, transform: `scale(${FRAME.scale})` }}
              />
            </div>
          </div>
        </div>

        <footer>
          <label className="check">
            <input type="checkbox" checked={watch} onChange={(e) => setWatch(e.target.checked)} />
            <span>Watch</span>
          </label>
          {running ? (
            <button className="primary" onClick={stop}>
              ■ Stop
            </button>
          ) : (
            <button className="primary" disabled={!releaseId || !variants.length} onClick={start}>
              {mode === "difficulty" ? `▶ Play ${count} games` : `▶ Check ${variants.length} variants`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// <select> values are strings; keep the variant id's own type.
const pick = (variants, e) => variants.find((v) => String(v.id) === e.target.value)?.id;

function DifficultyStats({ stats, partial }) {
  return (
    <div className="pt-stats">
      <div className="pt-headline">
        <span className="pt-rate">{stats.winRate}%</span>
        <span>
          win rate{partial ? " so far" : ""} ·{" "}
          <strong className={`pt-label ${stats.label.toLowerCase().replace(" ", "-")}`}>{stats.label}</strong>
        </span>
      </div>
      <dl className="pt-facts">
        <dt>Games</dt>
        <dd>
          {stats.wins} won of {stats.runs}
        </dd>
        <dt>Moves left on wins</dt>
        <dd>{stats.avgMovesLeft ?? "–"}</dd>
        <dt>Average steps</dt>
        <dd>{stats.avgSteps ?? "–"}</dd>
      </dl>
      <div className="pt-outcomes">
        {OUTCOMES.map((o) => (
          <span key={o} className={`pt-chip ${o}${stats.outcomes[o] ? "" : " zero"}`}>
            {o} {stats.outcomes[o]}
          </span>
        ))}
      </div>
      {stats.errors.length > 0 && (
        <>
          <h4>Errors</h4>
          <ul className="pt-errors">
            {stats.errors.map((e) => (
              <li key={e.message}>
                <span className="mono">{e.message}</span> <span className="muted small">×{e.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CheckRow({ variant, check }) {
  let status;
  if (!check) status = <span className="muted">–</span>;
  else if (check.status === "running") status = <span className="muted">Checking…</span>;
  else if (check.check === "ok") status = <span className="pt-ok">✓ OK</span>;
  else if (check.check === "unsupported") status = <span className="muted">Not supported</span>;
  else
    status = (
      <span className="error">
        ✗ Error <span className="mono small">({check.error})</span>
      </span>
    );
  return (
    <tr>
      <td>{variant.name}</td>
      <td>{status}</td>
      <td className="num muted">{check?.ms != null ? seconds(check.ms) : ""}</td>
    </tr>
  );
}
