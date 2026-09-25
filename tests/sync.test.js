import test from "node:test";
import assert from "node:assert/strict";
import { createVariantSync } from "../web/src/pages/variantSync.js";
const initial = () => ({ id: 1, revision: 1, overrides: { color: "red", scale: 1 } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));

test(
  "flush completes after autosave, accepts remote edits and saves typing during a request",
  { timeout: 2000 },
  async () => {
    const gate = deferred();
    let calls = 0;
    const sync = createVariantSync({
      variant: initial(),
      delay: 100000,
      patch: async (id, body) => {
        calls++;
        if (calls === 1) await gate.promise;
        return { id, revision: body.baseRevision + 1, overrides: { ...initial().overrides, ...body.set } };
      }
    });
    sync.change({ color: "blue", scale: 1 });
    const flush = sync.flush();
    await tick();
    sync.change({ color: "blue", scale: 2 });
    gate.resolve();
    await flush;
    assert.equal(calls, 2);
    assert.equal(sync.revision, 3);
    assert.equal(sync.hasPending(), false);
    sync.applyRemote({ id: 1, revision: 4, overrides: { color: "green", scale: 2 } });
    assert.equal(sync.getSnapshot().overrides.color, "green");
    await sync.flush();
    sync.dispose();
  }
);

test("polling detects same-field conflicts but merges independent changes", async () => {
  const sent = [];
  const sync = createVariantSync({
    variant: initial(),
    delay: 100000,
    patch: async (id, body) => {
      sent.push(body);
      return { id, revision: body.baseRevision + 1, overrides: { color: body.set.color ?? "green", scale: 2 } };
    }
  });
  sync.change({ color: "blue", scale: 1 });
  sync.applyRemote({ id: 1, revision: 2, overrides: { color: "green", scale: 2 } });
  assert.equal(sync.getSnapshot().state, "conflict");
  await assert.rejects(sync.flush(), /conflicting/);
  assert.equal(sent.length, 0);
  sync.resolve("mine");
  await sync.flush();
  assert.equal(sent[0].baseRevision, 2);
  assert.equal(sent[0].force, undefined);
  assert.deepEqual(sync.getSnapshot().overrides, { color: "blue", scale: 2 });
  sync.dispose();
});

test("failed save prevents dependent actions and can be retried", async () => {
  let fail = true;
  const sync = createVariantSync({
    variant: initial(),
    delay: 100000,
    patch: async (id, b) => {
      if (fail) throw new Error("offline");
      return { id, revision: 2, overrides: { ...initial().overrides, ...b.set } };
    }
  });
  sync.change({ color: "blue", scale: 1 });
  await assert.rejects(sync.flush(), /offline/);
  fail = false;
  await sync.flush();
  assert.equal(sync.hasPending(), false);
  sync.dispose();
});

test("taking remote conflict values preserves unrelated local edits", async () => {
  const sync = createVariantSync({
    variant: initial(),
    delay: 100000,
    patch: async (id, b) => ({ id, revision: 3, overrides: { color: "green", ...b.set } })
  });
  sync.change({ color: "blue", scale: 3 });
  sync.applyRemote({ id: 1, revision: 2, overrides: { color: "green", scale: 1 } });
  sync.resolve("theirs");
  await sync.flush();
  assert.deepEqual(sync.getSnapshot().overrides, { color: "green", scale: 3 });
  sync.dispose();
});

test("a save response cannot silently overwrite concurrent typing on a remotely changed field", async () => {
  const gate = deferred();
  const sync = createVariantSync({ variant: initial(), delay: 100000, patch: () => gate.promise });
  sync.change({ color: "blue", scale: 1 });
  const flush = sync.flush();
  await tick();
  sync.change({ color: "blue", scale: 2 });
  gate.resolve({ id: 1, revision: 3, overrides: { color: "blue", scale: 3 } });
  await assert.rejects(flush, /conflicting/);
  assert.equal(sync.getSnapshot().conflict.conflicts[0].path, "scale");
  sync.dispose();
});

test("remote convergence clears an existing conflict", async () => {
  const sync = createVariantSync({
    variant: initial(),
    delay: 100000,
    patch: async () => {
      throw new Error("No save needed");
    }
  });
  sync.change({ color: "blue", scale: 1 });
  sync.applyRemote({ id: 1, revision: 2, overrides: { color: "green", scale: 1 } });
  assert.equal(sync.getSnapshot().state, "conflict");
  sync.applyRemote({ id: 1, revision: 3, overrides: { color: "blue", scale: 1 } });
  assert.equal(sync.getSnapshot().conflict, null);
  await sync.flush();
  sync.dispose();
});
