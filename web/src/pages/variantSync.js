// Framework-independent synchronization state machine, shared by the hook and regression tests.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function diff(from, to) {
  const set = Object.fromEntries(Object.entries(to).filter(([k, v]) => !same(from[k], v)));
  const unset = Object.keys(from).filter((k) => !Object.hasOwn(to, k));
  return { set, unset, empty: !Object.keys(set).length && !unset.length };
}
export function apply(from, { set, unset }) {
  const next = { ...from, ...set };
  for (const key of unset) delete next[key];
  return next;
}
export function createVariantSync({ variant, patch, onSaved, onError, delay = 500 }) {
  let base = variant ?? { overrides: {}, revision: 0 };
  let local = base.overrides;
  let timer = null;
  let inflight = null;
  let conflict = null;
  let failure = null;
  let disposed = false;
  let snapshot = { overrides: local, state: "saved", conflict: null, revision: base.revision };
  const listeners = new Set();
  const emit = (state) => {
    snapshot = { overrides: local, state, conflict, revision: base.revision };
    listeners.forEach((fn) => fn());
  };
  const stopTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const dirty = () => !diff(base.overrides, local).empty;
  const schedule = () => {
    stopTimer();
    if (!conflict && !disposed)
      timer = setTimeout(() => {
        timer = null;
        save();
      }, delay);
  };
  const save = () => {
    stopTimer();
    if (inflight) return inflight;
    if (conflict || !dirty()) return Promise.resolve();
    const sent = local;
    const change = diff(base.overrides, sent);
    const revision = base.revision;
    failure = null;
    emit("saving");
    const task = Promise.resolve()
      .then(() => patch(base.id, { baseRevision: revision, set: change.set, unset: change.unset }))
      .then(
        (saved) => {
          const extra = diff(sent, local);
          const clashes = [...Object.keys(extra.set), ...extra.unset].filter(
            (key) => !same(sent[key], saved.overrides[key]) && !same(local[key], saved.overrides[key])
          );
          if (clashes.length) {
            conflict = {
              server: saved,
              conflicts: clashes.map((path) => ({ path, theirs: saved.overrides[path], yours: local[path] }))
            };
            onSaved?.(saved);
            emit("conflict");
            return;
          }
          base = saved;
          local = apply(saved.overrides, extra);
          onSaved?.(saved);
          emit(dirty() ? "dirty" : "saved");
          if (dirty()) schedule();
        },
        (error) => {
          failure = error;
          if (error.status === 409 && error.data?.conflicts) {
            conflict = { conflicts: error.data.conflicts, server: error.data.variant };
            emit("conflict");
          } else {
            emit("error");
            onError?.(`Save failed: ${error.message}`);
          }
        }
      )
      .finally(() => {
        if (inflight === task) inflight = null;
      });
    inflight = task;
    return task;
  };
  return {
    subscribe(fn) {
      disposed = false;
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => snapshot,
    get revision() {
      return base.revision;
    },
    get variant() {
      return base;
    },
    change(next) {
      local = next;
      failure = null;
      emit(conflict ? "conflict" : "dirty");
      schedule();
    },
    async flush() {
      stopTimer();
      do {
        if (conflict) throw new Error("Resolve the conflicting changes before continuing.");
        await (inflight ?? save());
        stopTimer();
        if (failure) throw failure;
      } while (dirty());
      return true;
    },
    applyRemote(server) {
      if (!server || server.id !== base.id || server.revision <= base.revision || inflight) return;
      const pending = diff(base.overrides, local);
      const keys = [...Object.keys(pending.set), ...pending.unset];
      const clashes = keys.filter(
        (key) => !same(base.overrides[key], server.overrides[key]) && !same(local[key], server.overrides[key])
      );
      if (clashes.length) {
        stopTimer();
        conflict = {
          server,
          conflicts: clashes.map((path) => ({ path, theirs: server.overrides[path], yours: local[path] }))
        };
        emit("conflict");
        return;
      }
      base = server;
      local = apply(server.overrides, pending);
      conflict = null;
      failure = null;
      emit(dirty() ? "dirty" : "saved");
      if (dirty()) schedule();
    },
    resolve(choice) {
      if (!conflict) return;
      const { server, conflicts } = conflict;
      const pending = diff(base.overrides, local);
      if (choice === "theirs")
        for (const { path } of conflicts) {
          delete pending.set[path];
          pending.unset = pending.unset.filter((p) => p !== path);
        }
      base = server;
      local = apply(server.overrides, pending);
      conflict = null;
      failure = null;
      onSaved?.(server);
      emit(dirty() ? "dirty" : "saved");
      schedule(); // Still use the observed revision: a subsequent remote edit must conflict again.
    },
    dispose() {
      disposed = true;
      stopTimer();
      listeners.clear();
      if (dirty() && !conflict) save();
    },
    hasPending: () => dirty() || !!inflight || !!conflict
  };
}
