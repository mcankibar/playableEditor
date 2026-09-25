// Keeps the edited variant in sync with the server.
//
// base  — the variant as last seen on the server (overrides + revision)
// local — what the editor shows (base + the user's unsaved changes)
// A save sends only the keys that differ from base, with base's revision. The server merges changes
// to different fields; a field someone else changed meanwhile comes back as a conflict, which the
// user resolves (keep mine / take theirs). Remote changes (polling) are merged into local the same way.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

const SAVE_DELAY = 500;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** { set, unset } turning `from` into `to`. */
export function diff(from, to) {
  const set = {};
  for (const [k, v] of Object.entries(to)) if (!same(from[k], v)) set[k] = v;
  const unset = Object.keys(from).filter((k) => !(k in to));
  return { set, unset, empty: !Object.keys(set).length && !unset.length };
}

export function apply(overrides, { set, unset }) {
  const out = { ...overrides, ...set };
  for (const k of unset) delete out[k];
  return out;
}

/**
 * @param variant   the selected variant from the server (switching variants resets the editor)
 * @param releaseId the release being edited with (saved as the variant's base release)
 * @param onSaved   (variant) after every successful save
 */
export function useVariantSync({ variant, releaseId, onSaved, onError }) {
  const [overrides, setOverrides] = useState(variant?.overrides ?? {});
  const [state, setState] = useState("saved"); // saved | dirty | saving | error | conflict
  const [conflict, setConflict] = useState(null); // { conflicts: [{ path, theirs, yours }], server }
  const base = useRef({ overrides: variant?.overrides ?? {}, revision: variant?.revision ?? 0 });
  const local = useRef(variant?.overrides ?? {});
  const id = useRef(variant?.id ?? null);
  const timer = useRef(null);
  const inflight = useRef(null);
  const release = useRef(releaseId);
  const baseRelease = useRef(variant?.baseReleaseId ?? null);
  const callbacks = useRef({ onSaved, onError });
  callbacks.current = { onSaved, onError };
  release.current = releaseId;

  const setLocal = (next) => {
    local.current = next;
    setOverrides(next);
  };

  const accept = useCallback((saved, sent) => {
    // Keep what the user typed while the request was on its way.
    const extra = diff(sent, local.current);
    base.current = { overrides: saved.overrides, revision: saved.revision };
    baseRelease.current = saved.baseReleaseId;
    const next = apply(saved.overrides, extra);
    if (!same(next, local.current)) setLocal(next);
    setState(extra.empty ? "saved" : "dirty");
    callbacks.current.onSaved?.(saved);
    return extra.empty;
  }, []);

  const send = useCallback(
    async (force = false) => {
      clearTimeout(timer.current);
      timer.current = null;
      const variantId = id.current;
      const sent = local.current;
      const change = diff(base.current.overrides, sent);
      const body = { baseRevision: base.current.revision, set: change.set, unset: change.unset, force };
      if (release.current && release.current !== baseRelease.current) body.baseReleaseId = release.current;
      if (change.empty && !body.baseReleaseId) {
        setState("saved");
        return;
      }
      setState("saving");
      try {
        const saved = await api.patchVariant(variantId, body);
        if (id.current !== variantId) return;
        if (!accept(saved, sent)) timer.current = setTimeout(() => save(), SAVE_DELAY);
      } catch (e) {
        if (id.current !== variantId) return;
        if (e.status === 409 && e.data?.conflicts) {
          setConflict({ conflicts: e.data.conflicts, server: e.data.variant });
          setState("conflict");
        } else {
          setState("error");
          callbacks.current.onError?.(`Save failed: ${e.message}`);
        }
      }
    },
    [accept]
  );

  // One request at a time; a save during a save runs after it.
  const save = useCallback(
    (force) => {
      const run = (inflight.current ?? Promise.resolve()).then(() => send(force));
      inflight.current = run.finally(() => {
        if (inflight.current === run) inflight.current = null;
      });
      return inflight.current;
    },
    [send]
  );

  /** Saves now and waits; resolves true when everything on screen is saved. */
  const flush = useCallback(async () => {
    if (timer.current) save();
    while (inflight.current) await inflight.current;
    return diff(base.current.overrides, local.current).empty;
  }, [save]);

  const change = useCallback(
    (next) => {
      setLocal(next);
      setState((s) => (s === "conflict" ? s : "dirty"));
      clearTimeout(timer.current);
      if (!conflict) timer.current = setTimeout(() => save(), SAVE_DELAY);
    },
    [save, conflict]
  );

  /** "mine": overwrite the other person's values · "theirs": take them and keep my other changes. */
  const resolve = useCallback(
    (choice) => {
      if (!conflict) return;
      const { server, conflicts } = conflict;
      setConflict(null);
      if (choice === "theirs") {
        const pending = diff(base.current.overrides, local.current);
        for (const { path } of conflicts) {
          delete pending.set[path];
          pending.unset = pending.unset.filter((p) => p !== path);
        }
        base.current = { overrides: server.overrides, revision: server.revision };
        setLocal(apply(server.overrides, pending));
        callbacks.current.onSaved?.(server);
        save();
      } else {
        save(true);
      }
    },
    [conflict, save]
  );

  /** A newer version from the server (another editor): merge it under the unsaved changes. */
  const applyRemote = useCallback((server) => {
    if (!server || server.id !== id.current || server.revision <= base.current.revision) return;
    if (inflight.current) return; // the save's answer brings it
    const pending = diff(base.current.overrides, local.current);
    base.current = { overrides: server.overrides, revision: server.revision };
    baseRelease.current = server.baseReleaseId;
    setLocal(apply(server.overrides, pending));
  }, []);

  // Switching variants: save the old one, start from the new one.
  useEffect(() => {
    if (!variant) return;
    id.current = variant.id;
    base.current = { overrides: variant.overrides, revision: variant.revision };
    baseRelease.current = variant.baseReleaseId;
    setLocal(variant.overrides);
    setState("saved");
    setConflict(null);
    return () => {
      if (timer.current) send();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant?.id]);

  useEffect(() => {
    const onUnload = () => timer.current && send();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [send]);

  return {
    overrides,
    state,
    conflict,
    change,
    flush,
    resolve,
    applyRemote,
    get revision() {
      return base.current.revision;
    }
  };
}
