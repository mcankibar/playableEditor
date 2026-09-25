// A small pool of export workers (./exportWorker.js) and the list of bulk export jobs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { Worker } from "node:worker_threads";

export function createWorkerPool(size = Math.max(1, Math.min(2, os.availableParallelism() - 1))) {
  const idle = [];
  const all = new Set();
  const queue = [];
  const pending = new Map();
  let seq = 0;
  let closed = false;
  let pendingBytes = 0;
  const payloadBytes = (v) =>
    typeof v === "string"
      ? v.length * 2
      : v && typeof v === "object"
        ? Object.values(v).reduce((n, x) => n + payloadBytes(x), 0)
        : 8;

  function spawn() {
    const worker = new Worker(new URL("./exportWorker.js", import.meta.url));
    worker.on("message", ({ id, progress, result, error }) => {
      const task = pending.get(id);
      if (!task) return;
      if (progress) return task.onProgress?.(progress);
      pending.delete(id);
      pendingBytes -= task.bytes;
      error ? task.reject(Object.assign(new Error(error), { statusCode: 400 })) : task.resolve(result);
      worker.busy = null;
      next(worker);
    });
    const fail = (e) => {
      if (!all.delete(worker)) return;
      const index = idle.indexOf(worker);
      if (index >= 0) idle.splice(index, 1);
      const task = pending.get(worker.busy);
      if (task) {
        pending.delete(worker.busy);
        pendingBytes -= task.bytes;
        task.reject(e);
      }
      if (!closed) drain();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Export worker stopped (${code})`)));
    worker.unref();
    all.add(worker);
    return worker;
  }

  function next(worker) {
    const task = queue.shift();
    if (!task) return idle.push(worker);
    worker.busy = task.id;
    worker.postMessage({ id: task.id, type: task.type, ...task.payload });
  }

  function drain() {
    while (queue.length && (idle.length || all.size < size)) next(idle.pop() ?? spawn());
  }

  return {
    /** Runs a worker task; onProgress gets { done, total } for bulk exports. */
    run(type, payload, onProgress) {
      if (closed) return Promise.reject(new Error("Export service is stopping"));
      if (pending.size >= 16)
        return Promise.reject(Object.assign(new Error("Export queue is full; try again shortly"), { statusCode: 503 }));
      const bytes = payloadBytes(payload);
      if (pendingBytes + bytes > 128 * 1024 * 1024)
        return Promise.reject(
          Object.assign(new Error("Export input memory budget exceeded; export a smaller batch"), { statusCode: 503 })
        );
      return new Promise((resolve, reject) => {
        pendingBytes += bytes;
        const id = ++seq;
        const task = { id, type, payload, resolve, reject, onProgress, bytes };
        pending.set(id, task);
        queue.push(task);
        drain();
      });
    },
    close: async () => {
      closed = true;
      for (const task of pending.values()) task.reject(new Error("Server stopped during export; retry the job"));
      pending.clear();
      pendingBytes = 0;
      queue.length = 0;
      await Promise.all([...all].map((w) => w.terminate()));
    }
  };
}

/** Durable job state. Interrupted work is explicitly failed after restart, never reported as running forever. */
export function createJobs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const jobs = new Map();
  function wrap(value) {
    const file = path.join(dir, `${value.id}.json`);
    const persist = () => {
      fs.writeFileSync(file + ".part", JSON.stringify(value));
      fs.renameSync(file + ".part", file);
    };
    const job = new Proxy(value, {
      set(target, key, v) {
        target[key] = v;
        persist();
        return true;
      }
    });
    persist();
    jobs.set(value.id, job);
    return job;
  }
  for (const file of fs.readdirSync(dir).filter((f) => /^[a-f0-9]+\.json$/.test(f))) {
    const value = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (["queued", "running"].includes(value.state)) {
      value.state = "failed";
      value.error = "Server restarted before completion. Retry this export.";
    }
    wrap(value);
  }
  return {
    create(fields) {
      if ([...jobs.values()].filter((j) => ["queued", "running"].includes(j.state)).length >= 4)
        throw Object.assign(new Error("Four export jobs are already active; wait for one to finish"), {
          statusCode: 503
        });
      return wrap({
        id: crypto.randomBytes(8).toString("hex"),
        state: "queued",
        done: 0,
        total: 0,
        createdAt: new Date().toISOString(),
        ...fields
      });
    },
    get: (id) => jobs.get(id),
    list: (gameId) => [...jobs.values()].filter((j) => j.gameId === gameId).reverse()
  };
}

/** What the API shows of a job (not the file path). */
export const jobView = ({ zipFile, ...job }) => job;
