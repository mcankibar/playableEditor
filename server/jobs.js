// A small pool of export workers (./exportWorker.js) and the list of bulk export jobs.
import crypto from "node:crypto";
import os from "node:os";
import { Worker } from "node:worker_threads";

export function createWorkerPool(size = Math.max(1, Math.min(2, os.availableParallelism() - 1))) {
  const idle = [];
  const all = new Set();
  const queue = [];
  const pending = new Map();
  let seq = 0;

  function spawn() {
    const worker = new Worker(new URL("./exportWorker.js", import.meta.url));
    worker.on("message", ({ id, progress, result, error }) => {
      const task = pending.get(id);
      if (!task) return;
      if (progress) return task.onProgress?.(progress);
      pending.delete(id);
      error ? task.reject(Object.assign(new Error(error), { statusCode: 400 })) : task.resolve(result);
      worker.busy = null;
      next(worker);
    });
    worker.on("error", (e) => {
      all.delete(worker);
      const task = worker.busy && pending.get(worker.busy);
      if (task) {
        pending.delete(worker.busy);
        task.reject(e);
      }
      drain();
    });
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
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const task = { id, type, payload, resolve, reject, onProgress };
        pending.set(id, task);
        queue.push(task);
        drain();
      });
    },
    close: () => Promise.all([...all].map((w) => w.terminate()))
  };
}

/** Bulk export jobs, kept in memory (the finished file lives in data/tmp for a day). */
export function createJobs() {
  const jobs = new Map();
  return {
    create(fields) {
      const job = {
        id: crypto.randomBytes(8).toString("hex"),
        state: "queued",
        done: 0,
        total: 0,
        createdAt: new Date().toISOString(),
        ...fields
      };
      jobs.set(job.id, job);
      for (const [id, j] of jobs) if (Date.now() - Date.parse(j.createdAt) > 24 * 3600 * 1000) jobs.delete(id);
      return job;
    },
    get: (id) => jobs.get(id),
    list: (gameId) => [...jobs.values()].filter((j) => j.gameId === gameId).reverse()
  };
}

/** What the API shows of a job (not the file path). */
export const jobView = ({ zipFile, ...job }) => job;
